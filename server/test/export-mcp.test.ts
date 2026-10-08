import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { unzipSync } from 'fflate'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createMcpServer } from '../src/mcp.ts'
import { projectDir } from '../src/store.ts'
import { freshDataDir, install, SCHEMA, startServer } from './helpers.ts'

let server: Awaited<ReturnType<typeof startServer>>
before(async () => { freshDataDir(); server = await startServer() })
after(() => server.close())

test('the exported plugin runs the state machine standalone with node', async () => {
  await install(server.call, 'attest', {
    draft: { label: 'Draft', description: 'Write a draft', output_schema: SCHEMA, max_attempts: 2, next: [{ goto: 'review' }] },
    review: { label: 'Review', next: [{ goto: 'done', when: 'output.verdict == "approved"' }, { goto: 'draft' }] },
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

  const download = await server.call('GET', '/api/projects/attest/export.zip')
  assert.match(download.headers.get('content-disposition') ?? '', /attest-1\.2\.0\.zip/)
  assert.ok('attest/.claude-plugin/plugin.json' in unzipSync(download.data))

  const stateDir = mkdtempSync(join(tmpdir(), 'visage-runs-'))
  const flow = (...args: string[]) => JSON.parse(execFileSync('node', [join(skill, 'scripts/flow.mjs'), ...args, '--state-dir', stateDir], { encoding: 'utf8' }))
  let step = flow('start', '--input', '{"text": "raw"}')
  assert.equal(step.node, 'draft')
  assert.deepEqual(step.input, { text: 'raw' })
  assert.deepEqual(step.output_contract.schema, SCHEMA)
  const retry = flow('submit', '--output', '{"score": 5}')
  assert.equal(retry.decision, 'retry')
  assert.equal(retry.node, 'draft')
  assert.ok(retry.feedback.includes('output.items is required'))
  step = flow('submit', '--output', '{"score": 0.9, "items": ["x"]}')
  assert.deepEqual([step.decision, step.node], ['next', 'review'])
  assert.equal(step.previous_outputs.draft.score, 0.9)
  assert.equal(flow('submit', '--output', '{"verdict": "changes"}').node, 'draft')
  flow('submit', '--output', '```json\n{"score": 0.95, "items": ["y"]}\n```')
  const final = flow('submit', '--output', '{"verdict": "approved"}')
  assert.equal(final.status, 'completed')
  assert.equal(final.final_state, 'Approved draft')
  assert.deepEqual(flow('status').attempts, { draft: 3, review: 2 })
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
    checks: [{ when: 'output.status == "ok"', message: 'Status must be ok' }], max_attempts: 2,
  })
  assert.equal(node.created, true)
  assert.ok(node.warnings.includes('Workflow needs a terminal node'))
  await call(client, 'upsert_node', { project_id: 'via-mcp', node_id: 'done', terminal: true })
  await call(client, 'set_transitions', { project_id: 'via-mcp', node_id: 'write', transitions: [{ goto: 'done' }] })
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
  await call(client, 'upsert_node', { project_id: 'via-mcp', node_id: 'write', checks: [] })
  assert.equal((await call(client, 'get_workflow', { project_id: 'via-mcp' })).workflow.nodes.write.checks, undefined)
  await call(client, 'remove_node', { project_id: 'via-mcp', node_id: 'done' })
  assert.deepEqual((await call(client, 'get_workflow', { project_id: 'via-mcp' })).workflow.nodes.write.next, [])
  assert.equal(await call(client, 'read_file', { project_id: 'via-mcp', path: 'skills/write/SKILL.md' }), '# Write\n')
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
