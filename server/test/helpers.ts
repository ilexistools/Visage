import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import yaml from 'js-yaml'
import { createHttpServer } from '../src/http.ts'
import { projectDir } from '../src/store.ts'

/** Point the catalog at a fresh temporary data directory. */
export function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'visage-test-'))
  process.env.VISAGE_DATA_DIR = dir
  return dir
}

export async function startServer(uiDir: string | null = null) {
  const server = createHttpServer({ uiDir, editorUrl: async () => base })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    const type = response.headers.get('content-type') ?? ''
    const data = type.includes('json') ? await response.json() : type.includes('zip') ? new Uint8Array(await response.arrayBuffer()) : await response.text()
    return { status: response.status, data, headers: response.headers }
  }
  return { base, call, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

export const SCHEMA = {
  type: 'object', required: ['score', 'items'],
  properties: { score: { type: 'number', minimum: 0, maximum: 1 }, items: { type: 'array', minItems: 1 } },
}

/** Write Skills for every non-final node and save the workflow through the API. */
export async function install(call: Awaited<ReturnType<typeof startServer>>['call'], projectId: string, nodes: Record<string, any>, start = 'draft') {
  await call('POST', '/api/projects', { id: projectId, name: projectId[0].toUpperCase() + projectId.slice(1) })
  for (const [id, node] of Object.entries(nodes)) {
    node.type ??= 'skill'
    if (node.terminal) continue
    const folder = join(projectDir(projectId), 'skills', id)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${id}\n---\n# ${id}\n\nDo the ${id} step.\n`)
    writeFileSync(join(folder, 'reference.md'), 'reference')
    node.skill ??= { path: `skills/${id}/SKILL.md` }
  }
  const workflow = { version: 1, workflow: { id: projectId, name: projectId, version: '1.2.0' }, start, nodes }
  const response = await call('PUT', `/api/projects/${projectId}/workflow`, { source: yaml.dump(workflow) })
  if (response.status !== 200) throw new Error(JSON.stringify(response.data))
}
