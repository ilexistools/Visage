import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { projectDir } from '../src/store.ts'
import { freshDataDir, startServer } from './helpers.ts'

let server: Awaited<ReturnType<typeof startServer>>
let ui: string

before(async () => {
  freshDataDir()
  ui = mkdtempSync(join(tmpdir(), 'visage-ui-'))
  mkdirSync(join(ui, 'assets'))
  writeFileSync(join(ui, 'index.html'), '<html>editor</html>')
  writeFileSync(join(ui, 'assets', 'app.js'), 'console.log(1)')
  server = await startServer(ui)
})
after(() => server.close())

test('a new project starts with an empty canvas and is not ready to export', async () => {
  const created = await server.call('POST', '/api/projects', { id: 'blank', name: 'Blank' })
  assert.equal(created.status, 200)
  const workflow = await server.call('GET', '/api/projects/blank/workflow')
  assert.deepEqual(workflow.data.workflow.nodes, {})
  assert.equal(workflow.data.workflow.start, '')
  assert.deepEqual((await server.call('GET', '/api/projects/blank/files')).data, ['workflow.yaml'])
  const validation = await server.call('GET', '/api/projects/blank/validate')
  assert.equal(validation.data.ready, false)
  const exported = await server.call('POST', '/api/projects/blank/export')
  assert.equal(exported.status, 400)
  assert.match(exported.data.detail, /starting node/)
  assert.equal((await server.call('POST', '/api/projects', { id: 'blank', name: 'Again' })).status, 400)
  assert.equal((await server.call('POST', '/api/projects', { id: '../bad', name: 'Bad' })).status, 400)
})

test('projects live in the chosen folder and can be renamed and deleted', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'visage-parent-'))
  const created = await server.call('POST', '/api/projects', { id: 'folder-project', name: 'Folder', parent_path: parent })
  assert.equal(created.status, 200, JSON.stringify(created.data))
  assert.equal(projectDir('folder-project'), join(parent, 'folder-project'))
  assert.ok(existsSync(join(parent, 'folder-project', 'workflow.yaml')))
  const renamed = await server.call('PUT', '/api/projects/folder-project', { name: 'Renamed' })
  assert.equal(renamed.data.name, 'Renamed')
  assert.equal(JSON.parse(readFileSync(join(parent, 'folder-project', 'project.json'), 'utf8')).name, 'Renamed')
  assert.equal((await server.call('DELETE', '/api/projects/folder-project')).status, 200)
  assert.ok(!existsSync(join(parent, 'folder-project')))
  assert.ok(!(await server.call('GET', '/api/projects')).data.some((project: any) => project.id === 'folder-project'))
})

test('skill markdown and binary resources are saved; traversal is rejected', async () => {
  await server.call('POST', '/api/projects', { id: 'skill-files', name: 'Skill files' })
  const markdown = '# Edited Skill\n\nUse the imported reference.\n'
  assert.equal((await server.call('PUT', '/api/projects/skill-files/files/skills/prepare/SKILL.md', { content: markdown })).status, 200)
  assert.equal(readFileSync(join(projectDir('skill-files'), 'skills/prepare/SKILL.md'), 'utf8'), markdown)
  const binary = Buffer.from('%PDF-1.7\x00reference', 'latin1')
  const uploaded = await server.call('PUT', '/api/projects/skill-files/files/skills/prepare/references/guide.pdf', { content: binary.toString('base64'), encoding: 'base64' })
  assert.equal(uploaded.status, 200)
  assert.deepEqual(readFileSync(join(projectDir('skill-files'), 'skills/prepare/references/guide.pdf')), binary)
  const traversal = await server.call('PUT', '/api/projects/skill-files/files/skills%2F..%2F..%2F..%2Foutside.txt', { content: 'no' })
  assert.equal(traversal.status, 400)
  assert.equal((await server.call('GET', '/api/projects/skill-files/files/skills/prepare/SKILL.md')).data, markdown)
})

test('a missing referenced SKILL.md is created when opened', async () => {
  await server.call('POST', '/api/projects', { id: 'missing-skill', name: 'Missing skill' })
  const root = projectDir('missing-skill')
  mkdirSync(join(root, 'skills/generated'), { recursive: true })
  writeFileSync(join(root, 'skills/generated/SKILL.md'), '# Generated\n')
  const source = yaml.dump({ version: 1, start: 'step', nodes: { step: { type: 'skill', skill: { path: 'skills/generated/SKILL.md' }, next: [{ goto: 'done' }] }, done: { type: 'skill', terminal: true } } })
  assert.equal((await server.call('PUT', '/api/projects/missing-skill/workflow', { source })).status, 200)
  unlinkSync(join(root, 'skills/generated/SKILL.md'))
  const opened = await server.call('GET', '/api/projects/missing-skill/files/skills/generated/SKILL.md')
  assert.equal(opened.status, 200)
  assert.match(opened.data, /Add instructions for this step/)
  assert.equal((await server.call('GET', '/api/projects/missing-skill/files/other.md')).status, 404)
})

test('incomplete workflows save with warnings; structural errors are rejected', async () => {
  await server.call('POST', '/api/projects', { id: 'partial', name: 'Partial' })
  const source = yaml.dump({ version: 1, start: 'a', nodes: { a: { type: 'skill', skill: { path: 'skills/a/SKILL.md' } } } })
  const saved = await server.call('PUT', '/api/projects/partial/workflow', { source })
  assert.equal(saved.status, 200)
  assert.ok(saved.data.warnings.includes('Workflow needs a terminal node'))
  for (const node of [{ on_fail: 'nope' }, { checks: ['bad expression'] }, { max_attempts: 0 }, { output_schema: { type: 'nope' } }]) {
    const bad = yaml.dump({ version: 1, start: 'a', nodes: { a: { type: 'skill', skill: { path: 'skills/a/SKILL.md' }, ...node } } })
    assert.equal((await server.call('PUT', '/api/projects/partial/workflow', { source: bad })).status, 400, JSON.stringify(node))
  }
  assert.equal((await server.call('PUT', '/api/projects/partial/workflow', { source: 'nodes: [' })).status, 400)
})

test('serves the editor, falls back to index.html and rejects non-local hosts', async () => {
  assert.equal((await server.call('GET', '/')).data, '<html>editor</html>')
  assert.equal((await server.call('GET', '/some/route')).data, '<html>editor</html>')
  assert.equal((await server.call('GET', '/assets/app.js')).data, 'console.log(1)')
  assert.equal((await server.call('GET', '/api/health')).data.app, 'visage')
  assert.equal((await server.call('GET', '/api/nope')).status, 404)
  assert.equal((await server.call('GET', '/api/projects', undefined, { Origin: 'https://evil.example' })).status, 403)
  assert.equal((await server.call('GET', '/api/projects', undefined, { Origin: 'http://localhost:5173' })).status, 200)
})
