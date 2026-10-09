import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { PLACEHOLDER_SKILL } from './skillQuality.ts'
import type { Evaluation, Postcondition, Transition, Workflow, WorkflowNode } from './engine.ts'
import { badRequest, checkedId, defaultProjectsDir, findProject, inside, isInside, listProjects, notFound, now, projectDir, updateProjects, withLock, workflowPath, writeJson, writeText, type Project } from './store.ts'
import { dumpWorkflow, parseWorkflow, validateWorkflow } from './workflow.ts'

const MAX_FILE_BYTES = 25_000_000
const SKIP_LISTING = new Set(['dist', 'node_modules', '.git', '.visage'])

export { listProjects }

const text = (value: unknown, field: string) => {
  if (value !== undefined && value !== null && typeof value !== 'string') throw badRequest(`${field} must be text`)
  return (value ?? '') as string
}

export function createProject(input: { id: string; name: string; parent_path?: string | null }): Project {
  const id = checkedId(input?.id)
  const name = text(input.name, 'name').trim()
  const parentPath = text(input.parent_path, 'parent_path')
  if (!name) throw badRequest('Project name cannot be empty')
  if (findProject(id)) throw badRequest('Project identifier already exists')
  let path: string
  if (parentPath) {
    input = { ...input, parent_path: parentPath }
    const parent = resolve(input.parent_path!.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))
    if (!existsSync(parent) || !statSync(parent).isDirectory()) throw badRequest('Choose an existing parent folder')
    path = join(parent, id)
  } else {
    path = join(defaultProjectsDir(), id)
  }
  if (existsSync(path)) throw badRequest('A project folder with this name already exists in the selected location')
  // Nested projects would be deleted together with their parent project.
  const nested = listProjects().find(other => isInside(resolve(other.root_path), resolve(path)) || isInside(resolve(path), resolve(other.root_path)))
  if (nested) throw badRequest(`Choose a folder outside the project "${nested.name}"`)
  mkdirSync(path, { recursive: true })
  const project: Project = { id, name, created_at: now(), root_path: path }
  writeJson(join(path, 'project.json'), project)
  const blank: Workflow = { version: 1, workflow: { id, name, version: '0.1.0' }, start: '', nodes: {} }
  writeText(join(path, 'workflow.yaml'), dumpWorkflow(blank))
  return updateProjects(projects => {
    if (projects.some(other => other.id === id)) {
      rmSync(path, { recursive: true, force: true })
      throw badRequest('Project identifier already exists')
    }
    return { projects: [...projects, project], result: project }
  })
}

export function renameProject(id: string, name: string): Project {
  const project = findProject(id)
  if (!project) throw notFound(`Project not found: ${id}`)
  if (!text(name, 'name').trim()) throw badRequest('Project name cannot be empty')
  project.name = name.trim()
  updateProjects(projects => ({ projects: projects.map(item => item.id === id ? { ...item, name: project.name } : item), result: null }))
  const metadataPath = join(project.root_path, 'project.json')
  if (existsSync(metadataPath)) writeJson(metadataPath, { ...JSON.parse(readFileSync(metadataPath, 'utf8')), name: project.name })
  return project
}

export function deleteProject(id: string): { id: string; status: string } {
  const project = findProject(id)
  if (!project) throw notFound(`Project not found: ${id}`)
  const nested = listProjects().find(other => other.id !== id && isInside(resolve(project.root_path), resolve(other.root_path)))
  if (nested) throw badRequest(`The project folder contains the project "${nested.name}"; delete that one first`)
  updateProjects(projects => ({ projects: projects.filter(item => item.id !== id), result: null }))
  rmSync(project.root_path, { recursive: true, force: true })
  return { id, status: 'deleted' }
}

// --- Workflow ----------------------------------------------------------------

export function getWorkflow(id: string) {
  const source = readFileSync(workflowPath(id), 'utf8')
  return { source, ...validateWorkflow(source, projectDir(id)) }
}

export function putWorkflow(id: string, source: string) {
  if (typeof source !== 'string') throw badRequest('source must be text')
  return withLock(workflowPath(id), () => writeWorkflow(id, source))
}

function writeWorkflow(id: string, source: string) {
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

/** Read, change and save the workflow under a lock, so concurrent editors do not lose changes. */
function edit<T extends object>(id: string, change: (workflow: Workflow) => T): T & ReturnType<typeof writeWorkflow> {
  return withLock(workflowPath(id), () => {
    const workflow = load(id)
    const extra = change(workflow)
    return { ...extra, ...writeWorkflow(id, dumpWorkflow(workflow)) }
  })
}

function nodeOf(workflow: Workflow, nodeId: string): WorkflowNode {
  if (!Object.hasOwn(workflow.nodes, nodeId)) throw notFound(`Node not found: ${nodeId}`)
  return workflow.nodes[nodeId]
}

export function configureWorkflow(id: string, settings: { name?: string; description?: string; version?: string; max_steps?: number; shared_references?: string[] }) {
  return edit(id, workflow => {
    workflow.workflow ??= {}
    for (const key of ['name', 'description', 'version'] as const) if (settings[key] !== undefined) workflow.workflow[key] = settings[key]
    if (settings.max_steps !== undefined) workflow.max_steps = settings.max_steps
    if (settings.shared_references !== undefined) {
      if (settings.shared_references.length) workflow.shared_references = settings.shared_references
      else delete workflow.shared_references
    }
    return {}
  })
}

export type NodeInput = {
  label?: string
  description?: string
  skill_markdown?: string
  skill_path?: string
  terminal?: boolean
  /** Set the step evaluation; null removes it. */
  evaluation?: Evaluation | null
  max_attempts?: number
  on_fail?: string
  /** Final nodes only; null removes it. */
  postcondition?: Postcondition | null
  position?: { x: number; y: number }
}

/** Create or update a node; only provided fields change. evaluation: null and on_fail: "" clear those fields. */
export function upsertNode(id: string, nodeId: string, input: NodeInput) {
  checkedId(nodeId)
  let markdown: { path: string; content: string } | undefined
  const result = edit(id, workflow => {
    // Own-property checks: node IDs such as "constructor" must not reach Object.prototype.
    const created = !Object.hasOwn(workflow.nodes, nodeId)
    const count = Object.keys(workflow.nodes).length
    if (created) workflow.nodes[nodeId] = { type: 'skill', label: input.label ?? nodeId, next: [] }
    const node: WorkflowNode = workflow.nodes[nodeId]
    if (created && !input.terminal) {
      node.skill = { path: input.skill_path ?? `skills/${nodeId}/SKILL.md` }
      node.position = input.position ?? { x: 160 + 260 * count, y: 180 }
    }
    for (const key of ['label', 'description', 'position', 'max_attempts'] as const) if (input[key] !== undefined) node[key] = input[key] as never
    if (input.on_fail !== undefined) {
      if (input.on_fail) node.on_fail = input.on_fail
      else delete node.on_fail
    }
    if (input.evaluation !== undefined) {
      if (input.evaluation) node.evaluation = input.evaluation
      else delete node.evaluation
      // The typed evaluation replaces the old free-form schema and checks.
      delete node.output_schema
      delete node.checks
    }
    if (input.postcondition !== undefined) {
      if (input.postcondition) node.postcondition = input.postcondition
      else delete node.postcondition
    }
    if (input.skill_path !== undefined) node.skill = { path: input.skill_path }
    if (input.terminal === true) {
      node.terminal = true
      delete node.next
      delete node.evaluation
    } else if (input.terminal === false) {
      delete node.terminal
      delete node.postcondition
      node.next ??= []
      node.skill ??= { path: `skills/${nodeId}/SKILL.md` }
    }
    if (input.skill_markdown !== undefined) {
      const path = node.skill?.path
      if (!path) throw badRequest('Final nodes have no Skill; set terminal=false first')
      if (!path.endsWith('SKILL.md')) throw badRequest(`Node ${nodeId} needs a SKILL.md path`)
      inside(projectDir(id), path)
      markdown = { path, content: input.skill_markdown }
    }
    // The first step becomes the start; a final state never does.
    if (!workflow.start && !node.terminal) workflow.start = nodeId
    return { node_id: nodeId, created }
  })
  // Written after the workflow validated, so a rejected change leaves no stray file.
  if (markdown) writeFile(id, markdown.path, markdown.content)
  return markdown ? { ...result, ...validateWorkflow(readFileSync(workflowPath(id), 'utf8'), projectDir(id)) } : result
}

export function removeNode(id: string, nodeId: string) {
  return edit(id, workflow => {
    nodeOf(workflow, nodeId)
    delete workflow.nodes[nodeId]
    for (const node of Object.values(workflow.nodes)) {
      if (node.next) node.next = node.next.filter(transition => transition.goto !== nodeId)
      if (node.on_fail === nodeId) delete node.on_fail
    }
    if (workflow.start === nodeId) workflow.start = Object.keys(workflow.nodes)[0] ?? ''
    return {}
  })
}

export function setTransitions(id: string, nodeId: string, transitions: Transition[]) {
  return edit(id, workflow => {
    const node = nodeOf(workflow, nodeId)
    if (node.terminal) throw badRequest('Final nodes cannot have transitions')
    // Keep connection points the user pinned in the editor for arcs that still go to the same node.
    const previous = [...(node.next ?? [])]
    for (const { goto, when } of transitions) {
      if (typeof when === 'string' && !when.trim()) throw badRequest(`Arc to ${goto}: when cannot be empty; leave it out for the otherwise arc`)
    }
    node.next = transitions.map(({ goto, when, label }) => {
      const match = previous.findIndex(transition => transition.goto === goto)
      const pins = match >= 0 ? previous.splice(match, 1)[0] : undefined
      return {
        goto, ...(when ? { when } : {}), ...(label ? { label } : {}),
        ...(pins?.source_handle ? { source_handle: pins.source_handle } : {}),
        ...(pins?.target_handle ? { target_handle: pins.target_handle } : {}),
      }
  })
  return {}
  })
}

export function setStart(id: string, nodeId: string) {
  return edit(id, workflow => {
    nodeOf(workflow, nodeId)
    workflow.start = nodeId
    return {}
  })
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
    writeText(target, PLACEHOLDER_SKILL)
  }
  if (!statSync(target).isFile() || statSync(target).size > 2_000_000) throw badRequest('Invalid project file')
  return readFileSync(target, 'utf8')
}

/** Delete a project file such as an imported reference. Workflow, metadata and used Skills are protected. */
export function deleteFile(id: string, path: string) {
  const root = projectDir(id)
  const target = inside(root, path)
  const relativePath = relative(root, target).split(sep).join('/')
  if (relativePath === 'workflow.yaml' || relativePath === 'project.json') throw badRequest(`${relativePath} cannot be deleted`)
  if (Object.values(load(id).nodes).some(node => node?.skill?.path === relativePath)) throw badRequest(`${relativePath} is used by a step; change the step's Skill first`)
  if (!existsSync(target)) throw notFound(`File not found: ${relativePath}`)
  if (!statSync(target).isFile()) throw badRequest('Only files can be deleted')
  unlinkSync(target)
  return { path: relativePath, status: 'deleted' }
}

export function writeFile(id: string, path: string, content: string, encoding: 'utf-8' | 'base64' = 'utf-8') {
  const root = projectDir(id)
  const target = inside(root, path)
  // These files are only changed through validated operations.
  if (target === join(resolve(root), 'workflow.yaml')) throw badRequest('workflow.yaml is changed with the workflow tools (put_workflow, upsert_node, set_transitions...), which validate it')
  if (target === join(resolve(root), 'project.json')) throw badRequest('project.json is managed by Visage')
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
