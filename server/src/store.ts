import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

export type Project = { id: string; name: string; created_at: string; root_path: string }

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export const badRequest = (message: string) => new HttpError(400, message)
export const notFound = (message: string) => new HttpError(404, message)

/** Data directory for the project catalog; read on every call so tests and processes can change it. */
export const dataDir = () => resolve(process.env.VISAGE_DATA_DIR || join(homedir(), '.visage'))
export const now = () => new Date().toISOString()

export function checkedId(value: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw badRequest('Invalid identifier')
  return value
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** Write atomically so concurrent server processes never read a partial file. */
export function writeText(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, content)
  renameSync(temp, path)
}

export const writeJson = (path: string, value: unknown) => writeText(path, JSON.stringify(value, null, 2) + '\n')

const registryPath = () => join(dataDir(), 'projects.json')

export function listProjects(): Project[] {
  const projects = readJson<{ projects: Project[] }>(registryPath(), { projects: [] }).projects
  return [...projects].sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export function saveProjects(projects: Project[]): void {
  writeJson(registryPath(), { projects })
}

const LOCK_STALE_MS = 15_000
const LOCK_TIMEOUT_MS = 10_000
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Run a read-modify-write under a lock file, so concurrent Visage processes (one per
 * harness session) do not overwrite each other's changes. Stale locks are taken over.
 */
export function withLock<T>(target: string, run: () => T): T {
  const lock = `${target}.lock`
  mkdirSync(dirname(lock), { recursive: true })
  const started = Date.now()
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'))
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmSync(lock, { force: true }); continue }
      } catch { continue }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new HttpError(503, 'Another Visage process is busy with this file; try again')
      sleep(15)
    }
  }
  try {
    return run()
  } finally {
    rmSync(lock, { force: true })
  }
}

/** Change the project catalog atomically across processes. */
export const updateProjects = <T>(change: (projects: Project[]) => { projects: Project[]; result: T }): T =>
  withLock(registryPath(), () => {
    const { projects, result } = change(readJson<{ projects: Project[] }>(registryPath(), { projects: [] }).projects)
    saveProjects(projects)
    return result
  })

export function findProject(id: string): Project | undefined {
  checkedId(id)
  return listProjects().find(project => project.id === id)
}

export function projectDir(id: string): string {
  const project = findProject(id)
  if (!project) throw notFound(`Project not found: ${id}`)
  return project.root_path
}

export const workflowPath = (id: string) => join(projectDir(id), 'workflow.yaml')
export const defaultProjectsDir = () => join(dataDir(), 'projects')

const within = (root: string, target: string) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)

/**
 * Resolve a path inside a base folder, rejecting traversal, including through symbolic
 * links: the deepest existing part of the path must really be inside the folder.
 */
export function inside(base: string, relative: string): string {
  const root = resolve(base)
  const target = resolve(root, relative)
  if (!within(root, target)) throw badRequest('Path escapes the project folder')
  if (existsSync(root)) {
    let existing = target
    while (!existsSync(existing) && existing !== root) existing = dirname(existing)
    if (!within(realpathSync(root), realpathSync(existing))) throw badRequest('Path escapes the project folder')
  }
  return target
}

export const isInside = within
