import { existsSync, statSync } from 'node:fs'
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
  const ids = Object.keys(nodes)
  if (!ids.length) {
    if (workflow.start) fail('An empty workflow cannot have a start node')
    if (strict) fail('Add a starting node and a final state before exporting this workflow')
    return { workflow, warnings: [] }
  }
  const readiness: string[] = []
  const warnings: string[] = []
  if (typeof workflow.start !== 'string') fail('start must be a node ID')
  if (!Object.hasOwn(nodes, workflow.start)) readiness.push('Start node must exist')
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
    const unfinished = node.evaluation && evaluationReadiness(node.evaluation)
    if (unfinished) readiness.push(`Node ${id}: ${unfinished}`)
    if (node.next !== undefined && !Array.isArray(node.next)) fail(`Transitions of ${id} must be a list`)
    for (const transition of node.next ?? []) {
      if (typeof transition !== 'object' || transition === null || typeof transition.goto !== 'string' || !Object.hasOwn(nodes, transition.goto)) fail(`Invalid transition target from ${id}`)
      if (transition.when !== undefined) expression(id, transition.when)
      for (const key of ['source_handle', 'target_handle'] as const) {
        if (transition[key] !== undefined && (typeof transition[key] !== 'string' || !/^(top|bottom|left|right)-\d+$/.test(transition[key]!))) fail(`Invalid ${key} on transition from ${id}: ${transition[key]}`)
      }
    }
    if (!node.terminal && !node.next?.length) warnings.push(`Node ${id} has no transitions`)
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
