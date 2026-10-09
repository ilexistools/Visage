/**
 * Workflow scenarios: scripted step results and the path they should produce, simulated with
 * the same `decide` the exported runner uses. No agent is involved, so a run is instant and free.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { decide, newStateData, type Json, type JsonObject, type RunState, type Workflow } from './engine.ts'
import { badRequest, projectDir, workflowPath } from './store.ts'
import { validateWorkflow } from './workflow.ts'

export const SCENARIOS_FILE = 'scenarios.yaml'

export type Scenario = {
  name: string
  input?: Json
  /** Outputs per step, one per submission (retries included). A plain value is shorthand for {"result": value}. */
  results?: Record<string, Json | Json[]>
  expect?: { path?: string[]; status?: 'completed' | 'failed'; final?: string; error?: string }
}

export type ScenarioStep = { node: string; output: JsonObject; decision: string; errors: string[]; next_node?: string }
export type ScenarioResult = {
  name: string
  passed: boolean
  status: 'completed' | 'failed'
  path: string[]
  final?: string
  error?: string
  steps: ScenarioStep[]
  mismatches: string[]
}

export const SCENARIOS_TEMPLATE = `# Scenarios script the result of each step and check the path the workflow takes.
# results: the outputs a step submits, in order (each retry uses the next one); a plain value means {"result": value}.
#   Steps without evaluation default to {}; evaluated steps need a result for every visit.
# expect: path (every step submitted, then the final state), status (completed | failed),
#   final (final state), error (text the failure message contains).
scenarios:
  - name: Happy path
    input: {}
    results: {}
    expect:
      status: completed
`

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export function parseScenarios(source: string, workflow: Workflow): Scenario[] {
  let document: unknown
  try { document = yaml.load(source) } catch (error) { throw badRequest(`Invalid scenarios YAML: ${(error as Error).message}`) }
  if (document == null) return []
  const list = isObject(document) ? document.scenarios : undefined
  if (!Array.isArray(list)) throw badRequest('scenarios.yaml must contain a scenarios list')
  return list.map((raw, index) => {
    if (!isObject(raw)) throw badRequest(`Scenario ${index + 1} must be a map`)
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Scenario ${index + 1}`
    if (raw.results !== undefined && !isObject(raw.results)) throw badRequest(`${name}: results must map step IDs to outputs`)
    for (const node of Object.keys((raw.results as object) ?? {})) {
      if (!Object.hasOwn(workflow.nodes, node)) throw badRequest(`${name}: results name an unknown step "${node}"`)
    }
    const expect = raw.expect
    if (expect !== undefined && !isObject(expect)) throw badRequest(`${name}: expect must be a map`)
    if (isObject(expect)) {
      if (expect.path !== undefined && (!Array.isArray(expect.path) || expect.path.some(step => typeof step !== 'string'))) throw badRequest(`${name}: expect.path must be a list of node IDs`)
      if (expect.status !== undefined && expect.status !== 'completed' && expect.status !== 'failed') throw badRequest(`${name}: expect.status must be completed or failed`)
      for (const node of [...((expect.path as string[]) ?? []), ...(typeof expect.final === 'string' ? [expect.final] : [])]) {
        if (!Object.hasOwn(workflow.nodes, node)) throw badRequest(`${name}: expect names an unknown node "${node}"`)
      }
    }
    return { name, input: raw.input as Json, results: raw.results as Scenario['results'], expect: expect as Scenario['expect'] }
  })
}

const asOutput = (value: Json): JsonObject => isObject(value) ? value as JsonObject : { result: value }

/** Run one scenario through the state machine and compare it with its expectations. */
export function simulate(workflow: Workflow, scenario: Scenario): ScenarioResult {
  const state: RunState = { data: newStateData(scenario.input ?? {}), attempts: {}, retries: {}, steps: 0 }
  const steps: ScenarioStep[] = []
  const path: string[] = []
  let current = workflow.start
  let status: ScenarioResult['status'] = 'completed'
  let error: string | undefined
  const limit = (workflow.max_steps ?? 50) + 1
  while (!workflow.nodes[current]?.terminal) {
    const node = workflow.nodes[current]
    if (!node) { status = 'failed'; error = `Unknown node ${current}`; break }
    const visit = state.attempts[current] ?? 0
    const scripted = scenario.results?.[current]
    const list = scripted === undefined ? [] : Array.isArray(scripted) ? scripted : [scripted]
    if (visit >= list.length && node.evaluation) {
      status = 'failed'
      error = `No result scripted for ${current} (submission ${visit + 1})`
      break
    }
    const output = visit < list.length ? asOutput(list[visit]) : {}
    path.push(current)
    const decision = decide(workflow, state, current, output)
    steps.push({ node: current, output, decision: decision.status, errors: decision.errors, ...(decision.next_node ? { next_node: decision.next_node } : {}) })
    if (decision.status === 'failed') { status = 'failed'; error = decision.error; break }
    if (decision.status === 'next') current = decision.next_node!
    if (steps.length > limit) { status = 'failed'; error = 'Scenario did not finish'; break }
  }
  const final = status === 'completed' ? current : undefined
  if (final) path.push(final)

  const mismatches: string[] = []
  const expect = scenario.expect ?? {}
  if (expect.status && expect.status !== status) mismatches.push(`expected status ${expect.status}, got ${status}${error ? ` (${error})` : ''}`)
  if (!expect.status && status === 'failed') mismatches.push(`the run failed: ${error}`)
  if (expect.final && expect.final !== final) mismatches.push(`expected to end in ${expect.final}, ended in ${final ?? 'no final state'}`)
  if (expect.error && !(error ?? '').includes(expect.error)) mismatches.push(`expected an error containing "${expect.error}", got ${error ? `"${error}"` : 'none'}`)
  if (expect.path) {
    const at = expect.path.findIndex((node, index) => path[index] !== node)
    if (at >= 0 || expect.path.length !== path.length) {
      const index = at >= 0 ? at : Math.min(expect.path.length, path.length)
      mismatches.push(`path differs at step ${index + 1}: expected ${expect.path[index] ?? 'the end'}, got ${path[index] ?? 'the end'}`)
    }
  }
  return { name: scenario.name, passed: !mismatches.length, status, path, ...(final ? { final } : {}), ...(error ? { error } : {}), steps, mismatches }
}

/** The project's scenarios file, or a starter template when there is none yet. */
export function getScenarios(projectId: string) {
  const file = join(projectDir(projectId), SCENARIOS_FILE)
  return existsSync(file) ? { source: readFileSync(file, 'utf8'), saved: true } : { source: SCENARIOS_TEMPLATE, saved: false }
}

/** Run the project's scenarios, or the given YAML source without saving it. */
export function testWorkflow(projectId: string, source?: string) {
  const root = projectDir(projectId)
  const { workflow } = validateWorkflow(readFileSync(workflowPath(projectId), 'utf8'), root)
  if (!Object.hasOwn(workflow.nodes, workflow.start)) throw badRequest('Set a start node before testing the workflow')
  const file = join(root, SCENARIOS_FILE)
  const text = source ?? (existsSync(file) ? readFileSync(file, 'utf8') : '')
  const results = parseScenarios(text, workflow).map(scenario => simulate(workflow, scenario))
  return { total: results.length, passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length, results }
}
