import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { unzipSync } from 'fflate'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createMcpServer } from '../src/mcp.ts'
import { projectDir } from '../src/store.ts'
import { freshDataDir, install, startServer } from './helpers.ts'

let server: Awaited<ReturnType<typeof startServer>>
before(async () => { freshDataDir(); server = await startServer() })
after(() => server.close())

test('the exported plugin runs the state machine standalone with node', async () => {
  await install(server.call, 'attest', {
    draft: { label: 'Draft', description: 'Write a draft', next: [{ goto: 'review' }] },
    review: {
      label: 'Review', evaluation: { type: 'choice', question: 'Is the draft ready?', options: ['approved', 'changes'] }, max_attempts: 2,
      next: [{ goto: 'done', when: 'output.result == "approved"' }, { goto: 'draft', when: 'output.result == "changes"' }],
    },
    done: { terminal: true, description: 'Approved draft' },
  })
  const exported = await server.call('POST', '/api/projects/attest/export')
  assert.equal(exported.status, 200, JSON.stringify(exported.data))
  const root = join(projectDir('attest'), 'dist', 'attest')
  assert.equal(exported.data.path, root)
  assert.equal(JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')).version, '1.2.0')
  assert.equal(JSON.parse(readFileSync(join(root, '.codex-plugin/plugin.json'), 'utf8')).skills, './skills/')
  const skill = join(root, 'skills/attest')
  const orchestrator = readFileSync(join(skill, 'SKILL.md'), 'utf8')
  assert.ok(orchestrator.startsWith('---\nname: attest\n'))
  assert.ok(orchestrator.indexOf('`draft`') < orchestrator.indexOf('`review`'))
  assert.ok(readFileSync(join(skill, 'nodes/draft/STEP.md'), 'utf8').startsWith('# draft'))
  assert.ok(existsSync(join(skill, 'nodes/draft/reference.md')))
  assert.ok(!readdirSync(join(skill, 'nodes/draft')).includes('SKILL.md'))
  assert.ok('attest/skills/attest/scripts/flow.mjs' in unzipSync(readFileSync(exported.data.zip)))

  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  assert.match(readme, /## Flow\n\n```mermaid\nflowchart LR\n/)
  assert.match(readme, /n_review -->\|"approved"\| n_done\n/)
  const diagram = await server.call('GET', '/api/projects/attest/diagram.mmd')
  assert.equal(diagram.status, 200)
  assert.match(String(diagram.headers.get('content-disposition')), /attest\.mmd/)
  assert.ok(String(diagram.data).startsWith('flowchart LR'))
  const download = await server.call('GET', '/api/projects/attest/export.zip')
  assert.match(download.headers.get('content-disposition') ?? '', /attest-1\.2\.0\.zip/)
  assert.ok('attest/.claude-plugin/plugin.json' in unzipSync(download.data))

  const stateDir = mkdtempSync(join(tmpdir(), 'visage-runs-'))
  const flow = (...args: string[]) => JSON.parse(execFileSync('node', [join(skill, 'scripts/flow.mjs'), ...args, '--state-dir', stateDir], { encoding: 'utf8' }))
  let step = flow('start', '--input', '{"text": "raw"}')
  assert.equal(step.node, 'draft')
  assert.deepEqual(step.input, { text: 'raw' })
  assert.equal(step.output_contract, undefined, 'a step without evaluation has no contract')
  step = flow('submit', '--output', '{"draft_file": "draft.md"}')
  assert.deepEqual([step.decision, step.node], ['next', 'review'])
  assert.equal(step.previous_outputs.draft.draft_file, 'draft.md')
  assert.deepEqual([step.output_contract.type, step.output_contract.question, step.output_contract.options], ['choice', 'Is the draft ready?', ['approved', 'changes']])
  const retry = flow('submit', '--output', '{"result": "maybe"}')
  assert.deepEqual([retry.decision, retry.node], ['retry', 'review'])
  assert.deepEqual(retry.feedback, ['output.result must be one of ["approved","changes"]'])
  assert.equal(flow('submit', '--output', '{"result": "changes", "reason": "too short"}').node, 'draft')
  flow('submit', '--output', '```json\n{"draft_file": "draft-v2.md"}\n```')
  const final = flow('submit', '--output', '{"result": "approved", "reason": "complete"}')
  assert.equal(final.status, 'completed')
  assert.equal(final.final_state, 'Approved draft')
  assert.deepEqual(flow('status').attempts, { draft: 2, review: 3 })
  assert.match(orchestrator, /choice: approved \/ changes, up to 2 attempts/)
})

async function connected() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const mcp = createMcpServer({ editorUrl: async () => server.base })
  await mcp.connect(serverSide)
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientSide)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] }
  const text = result.content[0].text
  if (result.isError) throw new Error(text)
  try { return JSON.parse(text) } catch { return text }
}

test('MCP tools build, validate and export a workflow', async () => {
  const client = await connected()
  await call(client, 'create_project', { project_id: 'via-mcp', name: 'Via MCP' })
  await call(client, 'configure_workflow', { project_id: 'via-mcp', description: 'Built over MCP' })
  const node = await call(client, 'upsert_node', {
    project_id: 'via-mcp', node_id: 'write', label: 'Write', skill_markdown: '# Write\n',
    evaluation: { type: 'predicate', question: 'Is it written?' }, max_attempts: 2,
  })
  assert.equal(node.created, true)
  assert.ok(node.warnings.includes('Workflow needs a terminal node'))
  await call(client, 'upsert_node', { project_id: 'via-mcp', node_id: 'done', terminal: true })
  await call(client, 'set_transitions', { project_id: 'via-mcp', node_id: 'write', transitions: [{ goto: 'done', when: 'output.result == true' }] })
  assert.ok((await call(client, 'validate_project', { project_id: 'via-mcp' })).warnings.includes('Node write: no arc for result false'))
  await call(client, 'set_transitions', { project_id: 'via-mcp', node_id: 'write', transitions: [{ goto: 'done' }] })
  await assert.rejects(call(client, 'upsert_node', { project_id: 'via-mcp', node_id: 'write', evaluation: { type: 'choice', options: ['one', 'one'] } }), /unique/)
  const pinned = (await call(client, 'get_workflow', { project_id: 'via-mcp' })).source.replace('- goto: done', '- goto: done\n        source_handle: bottom-2')
  await call(client, 'put_workflow', { project_id: 'via-mcp', source: pinned })
  await call(client, 'set_transitions', { project_id: 'via-mcp', node_id: 'write', transitions: [{ goto: 'done', label: 'ok' }] })
  assert.deepEqual((await call(client, 'get_workflow', { project_id: 'via-mcp' })).workflow.nodes.write.next, [{ goto: 'done', label: 'ok', source_handle: 'bottom-2' }])
  await assert.rejects(call(client, 'put_workflow', { project_id: 'via-mcp', source: pinned.replace('bottom-2', 'middle') }), /Invalid source_handle/)
  assert.equal((await call(client, 'validate_project', { project_id: 'via-mcp' })).ready, true)
  const exported = await call(client, 'export_plugin', { project_id: 'via-mcp' })
  assert.equal(exported.plugin, 'via-mcp')
  const skill = readFileSync(join(exported.path, 'skills/via-mcp/SKILL.md'), 'utf8')
  assert.deepEqual(JSON.parse(readFileSync(join(exported.path, 'skills/via-mcp/workflow.json'), 'utf8')).nodes.write.next, [{ goto: 'done', label: 'ok' }])
  assert.match(skill, /description: "Built over MCP"/)
  assert.deepEqual(JSON.parse(readFileSync(join(exported.path, 'skills/via-mcp/workflow.json'), 'utf8')).nodes.write.evaluation, { type: 'predicate', question: 'Is it written?' })
  await call(client, 'upsert_node', { project_id: 'via-mcp', node_id: 'write', evaluation: null })
  assert.equal((await call(client, 'get_workflow', { project_id: 'via-mcp' })).workflow.nodes.write.evaluation, undefined)
  await call(client, 'remove_node', { project_id: 'via-mcp', node_id: 'done' })
  assert.deepEqual((await call(client, 'get_workflow', { project_id: 'via-mcp' })).workflow.nodes.write.next, [])
  assert.equal(await call(client, 'read_file', { project_id: 'via-mcp', path: 'skills/write/SKILL.md' }), '# Write\n')
  assert.match(await call(client, 'export_diagram', { project_id: 'via-mcp' }), /^flowchart LR\n/)
  assert.equal((await call(client, 'open_editor', { project_id: 'via-mcp' })).url, `${server.base}/?project=via-mcp`)
  await assert.rejects(call(client, 'delete_project', { project_id: 'via-mcp' }), /confirm=true/)
  await assert.rejects(call(client, 'set_start', { project_id: 'via-mcp', node_id: 'nope' }), /Node not found/)
  await client.close()
})

test('MCP is also served over Streamable HTTP at /mcp', async () => {
  const client = new Client({ name: 'http-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`)))
  const { tools } = await client.listTools()
  assert.ok(tools.some(tool => tool.name === 'export_plugin'))
  assert.ok(Array.isArray(await call(client, 'list_projects')))
  await client.close()
})

test('the bundled server starts over stdio and serves the editor', async () => {
  const bundle = join(import.meta.dirname, '..', 'build', 'visage.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const client = new Client({ name: 'bundle-test', version: '1.0.0' })
  const port = String(43000 + Math.floor(Math.random() * 1000))
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bundle, '--stdio', '--port', port], env: { ...process.env, VISAGE_DATA_DIR: process.env.VISAGE_DATA_DIR! } as Record<string, string>, stderr: 'pipe' }))
  assert.ok((await client.listTools()).tools.length >= 16)
  const { url } = await call(client, 'open_editor')
  assert.equal(url, `http://127.0.0.1:${port}`)
  assert.equal((await (await fetch(`${url}/api/health`)).json()).app, 'visage')
  await client.close()
})

test('export and runner reject unsafe names and keep Skills clean', async () => {
  await install(server.call, 'safe', {
    draft: { label: 'A | B', evaluation: { type: 'choice', options: ['x | y', 'z'] }, next: [{ goto: 'done', when: 'output.result == "x | y"' }, { goto: 'done' }] },
    done: { terminal: true },
  })
  const workflowFile = join(projectDir('safe'), 'workflow.yaml')
  writeFileSync(workflowFile, readFileSync(workflowFile, 'utf8').replace('version: 1.2.0', "version: 1/../../escaped"))
  writeFileSync(join(projectDir('safe'), 'skills/draft/SKILL.md'), '---\r\nname: draft\r\n---\r\n# Draft\r\n')
  const out = mkdtempSync(join(tmpdir(), 'visage-out-'))
  const exported = await server.call('POST', '/api/projects/safe/export', { output_dir: join(out, 'x') })
  assert.equal(exported.status, 200, JSON.stringify(exported.data))
  assert.ok(exported.data.zip.startsWith(join(out, 'x') + '/'), exported.data.zip)
  const skill = join(exported.data.path, 'skills/safe')
  assert.equal(readFileSync(join(skill, 'nodes/draft/STEP.md'), 'utf8'), '# Draft\r\n')
  assert.ok(readFileSync(join(skill, 'SKILL.md'), 'utf8').includes('choice: x \\| y / z'))
  const flowFile = join(skill, 'scripts/flow.mjs')
  const stateDir = mkdtempSync(join(tmpdir(), 'visage-runs-'))
  const run = (...args: string[]) => {
    try { return JSON.parse(execFileSync('node', [flowFile, ...args, '--state-dir', stateDir], { encoding: 'utf8' })) } catch (error: any) { return JSON.parse(error.stdout) }
  }
  assert.match(run('start', '--run', '../escape').error, /Invalid run ID/)
  assert.match(run('start', '--run', 'LATEST').error, /Invalid run ID/)
  const step = run('start', '--run', 'ok-1')
  assert.ok(existsSync(join(step.output_file, '..')), 'the folder for output_file exists before the first submit')
  assert.match(step.submit, /--run "ok-1"/)
})

test('MCP guards found by the documentation audit', async () => {
  const client = await connected()
  await call(client, 'create_project', { project_id: 'guards', name: 'Guards' })
  await call(client, 'upsert_node', { project_id: 'guards', node_id: 'end', terminal: true })
  assert.equal((await call(client, 'get_workflow', { project_id: 'guards' })).workflow.start, '', 'a final state never becomes the start')
  await call(client, 'upsert_node', { project_id: 'guards', node_id: 'work', skill_markdown: '# Work\n' })
  assert.equal((await call(client, 'get_workflow', { project_id: 'guards' })).workflow.start, 'work')
  await assert.rejects(call(client, 'set_transitions', { project_id: 'guards', node_id: 'work', transitions: [{ goto: 'end', when: ' ' }] }), /when cannot be empty/)
  await assert.rejects(call(client, 'write_file', { project_id: 'guards', path: 'workflow.yaml', content: 'nodes: {}' }), /workflow tools/)
  await assert.rejects(call(client, 'write_file', { project_id: 'guards', path: 'project.json', content: '{}' }), /managed by Visage/)
  await call(client, 'set_transitions', { project_id: 'guards', node_id: 'work', transitions: [{ goto: 'end' }] })
  await call(client, 'set_start', { project_id: 'guards', node_id: 'end' })
  assert.match((await call(client, 'validate_project', { project_id: 'guards' })).errors[0], /is a final state/)
  await call(client, 'set_start', { project_id: 'guards', node_id: 'work' })
  const home = mkdtempSync(join(tmpdir(), 'visage-home-'))
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const exported = await call(client, 'export_plugin', { project_id: 'guards', output_dir: '~/plugins' })
    assert.equal(exported.path, join(home, 'plugins', 'guards'), '~ is expanded')
  } finally { process.env.HOME = previousHome }
  await client.close()
})

test('test_workflow runs the saved scenarios or inline YAML', async () => {
  const client = await connected()
  await call(client, 'create_project', { project_id: 'scenarios', name: 'Scenarios' })
  await call(client, 'upsert_node', { project_id: 'scenarios', node_id: 'check', skill_markdown: '# Check\n', evaluation: { type: 'predicate', question: 'OK?' } })
  await call(client, 'upsert_node', { project_id: 'scenarios', node_id: 'ok', terminal: true })
  await call(client, 'upsert_node', { project_id: 'scenarios', node_id: 'ko', terminal: true })
  await call(client, 'set_transitions', { project_id: 'scenarios', node_id: 'check', transitions: [{ goto: 'ok', when: 'output.result == true' }, { goto: 'ko', when: 'output.result == false' }] })
  await call(client, 'write_file', { project_id: 'scenarios', path: 'scenarios.yaml', content: 'scenarios:\n  - name: passes\n    results: {check: [true]}\n    expect: {final: ok}\n' })
  const saved = await call(client, 'test_workflow', { project_id: 'scenarios' })
  assert.deepEqual([saved.total, saved.passed], [1, 1])
  const inline = await call(client, 'test_workflow', { project_id: 'scenarios', scenarios: 'scenarios:\n  - name: fails\n    results: {check: [false]}\n    expect: {final: ok}\n' })
  assert.equal(inline.failed, 1)
  assert.deepEqual(inline.results[0].mismatches, ['expected to end in ok, ended in ko'])
  const viaApi = await server.call('POST', '/api/projects/scenarios/test', {})
  assert.equal(viaApi.data.passed, 1)
  await client.close()
})
