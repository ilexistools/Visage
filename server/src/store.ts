import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

/** Resolve a path inside a base folder, rejecting traversal. */
export function inside(base: string, relative: string): string {
  const root = resolve(base)
  const target = resolve(root, relative)
  if (target !== root && !target.startsWith(root + '/') && !target.startsWith(root + '\\')) throw badRequest('Path escapes the project folder')
  return target
}
