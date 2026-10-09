import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import yaml from 'js-yaml'
import { evaluationProblem, evaluationReadiness, matches, uncoveredResults, type Workflow, type WorkflowNode } from './engine.ts'
import { badRequest, checkedId, inside } from './store.ts'

export function parseWorkflow(source: string): Workflow {
  let workflow: unknown
  try {
    workflow = yaml.load(source)
  } catch (error) {
    throw badRequest(`Invalid YAML: ${(error as Error).message}`)
  }
  const nodes = (workflow as Workflow | null)?.nodes
  if (typeof workflow !== 'object' || workflow === null || typeof nodes !== 'object' || nodes === null || Array.isArray(nodes)) throw badRequest('Workflow must contain a nodes map')
  return workflow as Workflow
}

export const dumpWorkflow = (workflow: Workflow) => yaml.dump(workflow, { noRefs: true, lineWidth: 110 })

const fail = (message: string): never => { throw badRequest(message) }

// output_schema and checks have their own warning.
const NODE_KEYS = new Set(['type', 'label', 'description', 'skill', 'terminal', 'evaluation', 'max_attempts', 'on_fail', 'next', 'position', 'output_schema', 'checks', 'postcondition'])
// Keys of `state.` in transition expressions (see contextFor in engine.ts).
const STATE_KEYS = new Set(['input', 'outputs', 'attempts', 'feedback', 'last_output'])

/**
 * Validate a workflow document.
 *
 * Structural problems always throw. Problems that only prevent export (no start
 * node, no final node, missing Skill files) are returned as warnings so a
 * workflow can be built incrementally, and throw when `strict` is true.
 */
export function validateWorkflow(source: string, projectPath: string, strict = false): { workflow: Workflow; warnings: string[] } {
  const workflow = parseWorkflow(source)
  const nodes = workflow.nodes
  const maxSteps = workflow.max_steps
  if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 10_000)) fail('max_steps must be an integer between 1 and 10000')
  workflow.start ??= ''
  const readiness: string[] = []
  sharedReferences(workflow, projectPath, readiness)
  const ids = Object.keys(nodes)
  if (!ids.length) {
    if (workflow.start) fail('An empty workflow cannot have a start node')
    if (strict) fail('Add a starting node and a final state before exporting this workflow')
    return { workflow, warnings: readiness }
  }
  const warnings: string[] = []
  if (typeof workflow.start !== 'string') fail('start must be a node ID')
  if (!Object.hasOwn(nodes, workflow.start)) readiness.push('Start node must exist')
  else if (nodes[workflow.start]?.terminal && ids.length > 1) readiness.push(`Start node ${workflow.start} is a final state, so the run would end at once; use set_start on the first step`)
  if (!Object.values(nodes).some(node => node?.terminal)) readiness.push('Workflow needs a terminal node')
  for (const [id, node] of Object.entries(nodes)) {
    checkedId(id)
    if (typeof node !== 'object' || node === null || node.type !== 'skill') fail(`Invalid node type: ${id}`)
    if (node.terminal) {
      if (node.next?.length) fail(`Final node ${id} cannot have transitions`)
    } else {
      const skill = node.skill?.path
      if (typeof skill !== 'string' || !skill.endsWith('SKILL.md')) fail(`Node ${id} needs a SKILL.md path`)
      let skillPath = ''
      try { skillPath = inside(projectPath, skill!) } catch { fail(`Skill path escapes the project for ${id}: ${skill}`) }
      if (!existsSync(skillPath) || !statSync(skillPath).isFile()) readiness.push(`Skill not found for ${id}: ${skill}`)
    }
    validateEvaluation(id, node, nodes)
    validatePostcondition(id, node)
    const unfinished = node.evaluation && evaluationReadiness(node.evaluation)
    if (unfinished) readiness.push(`Node ${id}: ${unfinished}`)
    if (node.next !== undefined && !Array.isArray(node.next)) fail(`Transitions of ${id} must be a list`)
    for (const transition of node.next ?? []) {
      if (typeof transition !== 'object' || transition === null || typeof transition.goto !== 'string' || !Object.hasOwn(nodes, transition.goto)) fail(`Invalid transition target from ${id}`)
      if (transition.when !== undefined) {
        expression(id, transition.when)
        const problem = statePathProblem(transition.when, nodes)
        if (problem) warnings.push(`Node ${id}: ${problem}`)
      }
      for (const key of ['source_handle', 'target_handle'] as const) {
        if (transition[key] !== undefined && (typeof transition[key] !== 'string' || !/^(top|bottom|left|right)-\d+$/.test(transition[key]!))) fail(`Invalid ${key} on transition from ${id}: ${transition[key]}`)
      }
    }
    if (!node.terminal && !node.next?.length) warnings.push(`Node ${id} has no transitions`)
    const unknown = Object.keys(node).filter(key => !NODE_KEYS.has(key))
    if (unknown.length) warnings.push(`Node ${id}: unknown keys ${unknown.join(', ')}`)
    for (const legacy of ['output_schema', 'checks'] as const) {
      if (node[legacy] !== undefined) warnings.push(`Node ${id}: ${legacy} is no longer used; choose a predicate, choice or score evaluation`)
    }
    const fallback = (node.next ?? []).findIndex(transition => transition.when === undefined)
    if (fallback >= 0 && fallback < (node.next?.length ?? 0) - 1) warnings.push(`Node ${id}: arcs after the unconditional arc to ${node.next![fallback].goto} are never used`)
    for (const result of uncoveredResults(node)) warnings.push(`Node ${id}: no arc for result ${result}`)
  }
  if (readiness.length && strict) fail(readiness.join('; '))
  if (Object.hasOwn(nodes, workflow.start)) {
    const visited = new Set<string>()
    const pending = [workflow.start]
    while (pending.length) {
      const current = pending.pop()!
      if (visited.has(current)) continue
      visited.add(current)
      pending.push(...(nodes[current].next ?? []).map(transition => transition.goto))
      if (nodes[current].on_fail) pending.push(nodes[current].on_fail!)
    }
    warnings.push(...ids.filter(id => !visited.has(id)).map(id => `Node ${id} is unreachable`))
  }
  return { workflow, warnings: [...readiness, ...warnings] }
}

function expression(nodeId: string, value: unknown): void {
  try {
    if (typeof value !== 'string') throw new Error('Expressions must be strings')
    matches(value, { output: {}, state: {} })
  } catch (error) {
    fail(`Node ${nodeId}: ${(error as Error).message}`)
  }
}

/**
 * A misspelled step in `state.attempts.<step>` or `state.outputs.<step>` resolves to null,
 * so the arc silently never (or always) matches. Name the mistake instead.
 */
function statePathProblem(when: string, nodes: Record<string, WorkflowNode>): string | null {
  const path = /^\s*state((?:\.[A-Za-z0-9_-]+)*)/.exec(when)?.[1]?.split('.').slice(1)
  if (!path) return null
  if (!path.length) return `"${when}" compares the whole state; name a key such as state.input`
  if (!STATE_KEYS.has(path[0])) return `"${when}" uses unknown state key "${path[0]}" (use ${[...STATE_KEYS].join(', ')})`
  if ((path[0] === 'attempts' || path[0] === 'outputs' || path[0] === 'feedback') && path[1] !== undefined && !Object.hasOwn(nodes, path[1])) {
    return `"${when}" refers to unknown step "${path[1]}", so it is always null`
  }
  return null
}

function validatePostcondition(id: string, node: WorkflowNode): void {
  const postcondition = node.postcondition
  if (postcondition === undefined) return
  if (!node.terminal) fail(`Node ${id}: only final nodes can have a postcondition`)
  if (typeof postcondition !== 'object' || postcondition === null || Array.isArray(postcondition)) fail(`Node ${id}: postcondition must be a map with a command`)
  const unknown = Object.keys(postcondition).filter(key => !['command', 'message', 'timeout_seconds'].includes(key))
  if (unknown.length) fail(`Node ${id}: postcondition has unknown keys: ${unknown.join(', ')}`)
  if (typeof postcondition.command !== 'string' || !postcondition.command.trim()) fail(`Node ${id}: postcondition command must be non-empty text`)
  if (postcondition.message !== undefined && typeof postcondition.message !== 'string') fail(`Node ${id}: postcondition message must be text`)
  const timeout = postcondition.timeout_seconds
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600)) fail(`Node ${id}: postcondition timeout_seconds must be an integer between 1 and 3600`)
}

/** Shared references are project files; a missing one only blocks export. */
function sharedReferences(workflow: Workflow, projectPath: string, readiness: string[]): void {
  const shared = workflow.shared_references
  if (shared === undefined) return
  if (!Array.isArray(shared) || shared.some(path => typeof path !== 'string' || !path.trim())) fail('shared_references must be a list of project file paths')
  if (new Set(shared).size !== shared.length) fail('shared_references must not repeat a file')
  for (const path of shared) {
    // Exports keep the relative path under shared/, so it must stay a plain path below the project.
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) fail(`Shared reference must be a relative path inside the project: ${path}`)
    let file = ''
    try { file = inside(projectPath, path) } catch { fail(`Shared reference escapes the project: ${path}`) }
    if (!existsSync(file) || !statSync(file).isFile()) readiness.push(`Shared reference not found: ${path}`)
  }
}

function validateEvaluation(id: string, node: WorkflowNode, nodes: Record<string, WorkflowNode>): void {
  if (node.evaluation !== undefined) {
    if (node.terminal) fail(`Final node ${id} cannot have an evaluation`)
    const problem = evaluationProblem(node.evaluation)
    if (problem) fail(`Node ${id}: ${problem}`)
  }
  const attempts = node.max_attempts ?? 1
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) fail(`Node ${id}: max_attempts must be an integer between 1 and 20`)
  if (node.on_fail != null && (typeof node.on_fail !== 'string' || !Object.hasOwn(nodes, node.on_fail))) fail(`Node ${id}: on_fail must reference an existing node`)
}
