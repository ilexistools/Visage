import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { Check, JsonObject, Transition, Workflow, WorkflowNode } from './engine.ts'
import { badRequest, checkedId, defaultProjectsDir, findProject, inside, listProjects, notFound, now, projectDir, saveProjects, workflowPath, writeJson, writeText, type Project } from './store.ts'
import { dumpWorkflow, parseWorkflow, validateWorkflow } from './workflow.ts'

const MAX_FILE_BYTES = 25_000_000
const SKIP_LISTING = new Set(['dist', 'node_modules', '.git', '.visage'])

export { listProjects }

export function createProject(input: { id: string; name: string; parent_path?: string | null }): Project {
  const id = checkedId(input.id)
  const name = input.name?.trim()
  if (!name) throw badRequest('Project name cannot be empty')
  if (findProject(id)) throw badRequest('Project identifier already exists')
  let path: string
  if (input.parent_path) {
    const parent = resolve(input.parent_path.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))
    if (!existsSync(parent) || !statSync(parent).isDirectory()) throw badRequest('Choose an existing parent folder')
    path = join(parent, id)
  } else {
    path = join(defaultProjectsDir(), id)
  }
  if (existsSync(path)) throw badRequest('A project folder with this name already exists in the selected location')
  mkdirSync(path, { recursive: true })
  const project: Project = { id, name, created_at: now(), root_path: path }
  writeJson(join(path, 'project.json'), project)
  const blank: Workflow = { version: 1, workflow: { id, name, version: '0.1.0' }, start: '', nodes: {} }
  writeText(join(path, 'workflow.yaml'), dumpWorkflow(blank))
  saveProjects([...listProjects(), project])
  return project
}

export function renameProject(id: string, name: string): Project {
  const project = findProject(id)
  if (!project) throw notFound(`Project not found: ${id}`)
  if (!name?.trim()) throw badRequest('Project name cannot be empty')
  project.name = name.trim()
  saveProjects(listProjects().map(item => item.id === id ? project : item))
  const metadataPath = join(project.root_path, 'project.json')
  if (existsSync(metadataPath)) writeJson(metadataPath, { ...JSON.parse(readFileSync(metadataPath, 'utf8')), name: project.name })
  return project
}

export function deleteProject(id: string): { id: string; status: string } {
  const project = findProject(id)
  if (!project) throw notFound(`Project not found: ${id}`)
  rmSync(project.root_path, { recursive: true, force: true })
  saveProjects(listProjects().filter(item => item.id !== id))
  return { id, status: 'deleted' }
}

// --- Workflow ----------------------------------------------------------------

export function getWorkflow(id: string) {
  const source = readFileSync(workflowPath(id), 'utf8')
  return { source, ...validateWorkflow(source, projectDir(id)) }
}

export function putWorkflow(id: string, source: string) {
  const result = validateWorkflow(source, projectDir(id))
  writeText(workflowPath(id), source)
  return result
}

export function validateProject(id: string) {
  const source = readFileSync(workflowPath(id), 'utf8')
  const { warnings } = validateWorkflow(source, projectDir(id))
  try {
    validateWorkflow(source, projectDir(id), true)
    return { ready: true, errors: [] as string[], warnings }
  } catch (error) {
    return { ready: false, errors: [(error as Error).message], warnings }
  }
}

const load = (id: string) => parseWorkflow(readFileSync(workflowPath(id), 'utf8'))
const save = (id: string, workflow: Workflow) => putWorkflow(id, dumpWorkflow(workflow))

function nodeOf(workflow: Workflow, nodeId: string): WorkflowNode {
  if (!Object.hasOwn(workflow.nodes, nodeId)) throw notFound(`Node not found: ${nodeId}`)
  return workflow.nodes[nodeId]
}

export function configureWorkflow(id: string, settings: { name?: string; description?: string; version?: string; max_steps?: number }) {
  const workflow = load(id)
  workflow.workflow ??= {}
  for (const key of ['name', 'description', 'version'] as const) if (settings[key] !== undefined) workflow.workflow[key] = settings[key]
  if (settings.max_steps !== undefined) workflow.max_steps = settings.max_steps
  return save(id, workflow)
}

export type NodeInput = {
  label?: string
  description?: string
  skill_markdown?: string
  skill_path?: string
  terminal?: boolean
  output_schema?: JsonObject
  checks?: Check[]
  max_attempts?: number
  on_fail?: string
  position?: { x: number; y: number }
}

/** Create or update a node; only provided fields change. Empty values clear evaluation fields. */
export function upsertNode(id: string, nodeId: string, input: NodeInput) {
  checkedId(nodeId)
  const workflow = load(id)
  const created = !Object.hasOwn(workflow.nodes, nodeId)
  const count = Object.keys(workflow.nodes).length
  const node: WorkflowNode = workflow.nodes[nodeId] ??= { type: 'skill', label: input.label ?? nodeId, next: [] }
  if (created && !input.terminal) {
    node.skill = { path: input.skill_path ?? `skills/${nodeId}/SKILL.md` }
    node.position = input.position ?? { x: 160 + 260 * count, y: 180 }
  }
  for (const key of ['label', 'description', 'position', 'max_attempts'] as const) if (input[key] !== undefined) node[key] = input[key] as never
  for (const key of ['output_schema', 'checks', 'on_fail'] as const) {
    const value = input[key]
    if (value === undefined) continue
    const empty = value === '' || (Array.isArray(value) && !value.length) || (typeof value === 'object' && value !== null && !Array.isArray(value) && !Object.keys(value).length)
    if (empty) delete node[key]
    else node[key] = value as never
  }
  if (input.skill_path !== undefined) node.skill = { path: input.skill_path }
  if (input.terminal === true) {
    node.terminal = true
    delete node.next
  } else if (input.terminal === false) {
    delete node.terminal
    node.next ??= []
    node.skill ??= { path: `skills/${nodeId}/SKILL.md` }
  }
  if (input.skill_markdown !== undefined) {
    if (!node.skill?.path) throw badRequest('Final nodes have no Skill; set terminal=false first')
    writeFile(id, node.skill.path, input.skill_markdown)
  }
  if (!workflow.start) workflow.start = nodeId
  return { node_id: nodeId, created, ...save(id, workflow) }
}

export function removeNode(id: string, nodeId: string) {
  const workflow = load(id)
  nodeOf(workflow, nodeId)
  delete workflow.nodes[nodeId]
  for (const node of Object.values(workflow.nodes)) {
    if (node.next) node.next = node.next.filter(transition => transition.goto !== nodeId)
    if (node.on_fail === nodeId) delete node.on_fail
  }
  if (workflow.start === nodeId) workflow.start = Object.keys(workflow.nodes)[0] ?? ''
  return save(id, workflow)
}

export function setTransitions(id: string, nodeId: string, transitions: Transition[]) {
  const workflow = load(id)
  const node = nodeOf(workflow, nodeId)
  if (node.terminal) throw badRequest('Final nodes cannot have transitions')
  node.next = transitions.map(({ goto, when, label }) => ({ goto, ...(when ? { when } : {}), ...(label ? { label } : {}) }))
  return save(id, workflow)
}

export function setStart(id: string, nodeId: string) {
  const workflow = load(id)
  nodeOf(workflow, nodeId)
  workflow.start = nodeId
  return save(id, workflow)
}

// --- Files -------------------------------------------------------------------

export function listFiles(id: string): string[] {
  const root = projectDir(id)
  const files: string[] = []
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!SKIP_LISTING.has(entry.name) && !(folder === root && entry.name === 'runs')) walk(join(folder, entry.name)) }
      else if (!(folder === root && entry.name === 'project.json')) files.push(relative(root, join(folder, entry.name)).split(sep).join('/'))
    }
  }
  walk(root)
  return files.sort()
}

/** Read a text file. A missing SKILL.md referenced by the workflow is created from a template. */
export function readFile(id: string, path: string): string {
  const root = projectDir(id)
  const target = inside(root, path)
  if (!existsSync(target)) {
    const referenced = Object.values(load(id).nodes).some(node => node?.skill?.path === path)
    if (!referenced || !path.endsWith('SKILL.md') || !path.startsWith('skills/')) throw notFound(`File not found: ${path}`)
    writeText(target, '# Step\n\nAdd instructions for this step.\n')
  }
  if (!statSync(target).isFile() || statSync(target).size > 2_000_000) throw badRequest('Invalid project file')
  return readFileSync(target, 'utf8')
}

export function writeFile(id: string, path: string, content: string, encoding: 'utf-8' | 'base64' = 'utf-8') {
  const root = projectDir(id)
  const target = inside(root, path)
  if (target === resolve(root)) throw badRequest('Invalid project file path')
  let bytes: Buffer
  if (encoding === 'base64') {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content.replace(/\s/g, ''))) throw badRequest('Invalid file content encoding')
    bytes = Buffer.from(content, 'base64')
  } else {
    bytes = Buffer.from(content, 'utf8')
  }
  if (bytes.length > MAX_FILE_BYTES) throw badRequest('Project files must be smaller than 25 MB')
  writeText(target, bytes)
  return { path: relative(root, target).split(sep).join('/'), size: bytes.length }
}
