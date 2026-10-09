/**
 * State machine core shared by the Visage server and exported plugins.
 *
 * It must not import anything: the exported runner bundles it as-is.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }
/**
 * Every step is evaluated the same way: it returns `{"result": ..., "reason": "..."}` where
 * result is true/false (predicate), one of the options (choice) or a number from 0 to 1 (score).
 * Files and any other keys a step produces are free; only `result` drives the next step.
 */
export type EvaluationType = 'predicate' | 'choice' | 'score'
export type Evaluation = { type: EvaluationType; question?: string; options?: string[] }
/** source_handle / target_handle pin the arc to editor connection points; they do not affect execution. */
export type Transition = { goto: string; when?: string; label?: string; source_handle?: string; target_handle?: string }
export type WorkflowNode = {
  type?: string
  label?: string
  description?: string
  terminal?: boolean
  skill?: { path?: string }
  next?: Transition[]
  evaluation?: Evaluation
  max_attempts?: number
  on_fail?: string
  /** Final nodes only: a shell command the exported runner runs on arrival; the run completes only when it exits 0. */
  postcondition?: Postcondition
  [key: string]: unknown
}
export type Postcondition = { command: string; message?: string; timeout_seconds?: number }
export type Workflow = {
  version?: number
  workflow?: { id?: string; name?: string; version?: string; description?: string; author?: string }
  start: string
  max_steps?: number
  /** Project files every step receives, e.g. a contract naming the files and interfaces steps share. */
  shared_references?: string[]
  nodes: Record<string, WorkflowNode>
  [key: string]: unknown
}
export type RunState = {
  data: { input: Json; outputs: Record<string, JsonObject>; feedback: Record<string, string[]>; last_output: JsonObject | null }
  attempts: Record<string, number>
  retries: Record<string, number>
  steps: number
  [key: string]: unknown
}
export type Decision = {
  status: 'next' | 'retry' | 'failed'
  node: string
  next_node?: string
  errors: string[]
  evaluation?: 'passed' | 'failed'
  error?: string
}

export const DEFAULT_MAX_STEPS = 50
const PATH = String.raw`(?:output|state)(?:\.[A-Za-z0-9_][A-Za-z0-9_-]*)*`
// Word operators need surrounding spaces so `output.within 'x'` is not read as `output.with in 'x'`.
const EXPRESSION = new RegExp(String.raw`^\s*(${PATH})(?:\s*(==|!=|>=|<=|>|<)\s*|\s+(not in|in)\s+)(.+?)\s*$`)
const LITERALS: Record<string, Json> = { true: true, false: false, null: null, True: true, False: false, None: null }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNumber = (value: unknown): value is number => typeof value === 'number'

export function resolve(data: unknown, path: string): unknown {
  let value = data
  for (const part of path.split('.')) {
    if (isObject(value) && Object.hasOwn(value, part)) value = value[part]
    else if (part === 'length' && (Array.isArray(value) || typeof value === 'string')) value = value.length
    else if (part === 'length' && isObject(value)) value = Object.keys(value).length
    else if (Array.isArray(value) && /^\d+$/.test(part) && Number(part) < value.length) value = value[Number(part)]
    else return null
  }
  return value === undefined ? null : value
}

function literal(raw: string): Json {
  if (raw in LITERALS) return LITERALS[raw]
  try { return JSON.parse(raw) } catch { /* try single quotes */ }
  try { return JSON.parse(raw.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, body: string) => JSON.stringify(body.replace(/\\'/g, "'")))) } catch { /* unsupported */ }
  throw new Error(`Unsupported transition value: ${raw}`)
}

export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => equal(item, b[index]))
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]))
  }
  return false
}

/** Evaluate a restricted `path operator literal` expression; never executes code. */
export function matches(expression: string, context: unknown): boolean {
  const match = EXPRESSION.exec(expression)
  if (!match) throw new Error(`Unsupported transition expression: ${expression}`)
  const [, left, symbol, word, rawRight] = match
  const operator = symbol ?? word
  const right = literal(rawRight)
  const value = resolve(context, left)
  if (operator === '==') return equal(value, right)
  if (operator === '!=') return !equal(value, right)
  if (operator === 'in' || operator === 'not in') {
    let found: boolean
    if (Array.isArray(right)) found = right.some(item => equal(item, value))
    else if (typeof right === 'string') found = typeof value === 'string' && right.includes(value)
    else throw new Error(`Right side of '${operator}' must be a list or string`)
    return operator === 'in' ? found : !found
  }
  const comparable = (isNumber(value) && isNumber(right)) || (typeof value === 'string' && typeof right === 'string')
  if (!comparable) return false
  const [l, r] = [value as number | string, right as number | string]
  return { '>': l > r, '<': l < r, '>=': l >= r, '<=': l <= r }[operator as '>' | '<' | '>=' | '<=']
}

export function nextNode(node: WorkflowNode, context: unknown): string | null {
  for (const transition of node.next ?? []) {
    if (transition.when === undefined || matches(transition.when, context)) return transition.goto
  }
  return null
}

// --- Output contracts ------------------------------------------------------

const TYPES: Record<string, (value: unknown) => boolean> = {
  object: isObject,
  array: Array.isArray,
  string: value => typeof value === 'string',
  number: isNumber,
  integer: value => Number.isInteger(value),
  boolean: value => typeof value === 'boolean',
  null: value => value === null,
}

/** Validate the commonly used subset of JSON Schema and return readable errors. */
export function validateSchema(value: unknown, schema: Record<string, any>, path = 'output'): string[] {
  const errors: string[] = []
  if (schema.type !== undefined) {
    const options: string[] = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!options.some(option => TYPES[option]?.(value))) return [`${path} must be of type ${options.join(' or ')}`]
  }
  if ('enum' in schema && !schema.enum.some((item: unknown) => equal(item, value))) errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`)
  if ('const' in schema && !equal(value, schema.const)) errors.push(`${path} must equal ${JSON.stringify(schema.const)}`)
  if (isObject(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`)
    const properties = schema.properties ?? {}
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) errors.push(...validateSchema(item, properties[key], `${path}.${key}`))
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`)
    }
  }
  if (Array.isArray(value)) {
    if ('minItems' in schema && value.length < schema.minItems) errors.push(`${path} must have at least ${schema.minItems} items`)
    if ('maxItems' in schema && value.length > schema.maxItems) errors.push(`${path} must have at most ${schema.maxItems} items`)
    if (isObject(schema.items)) value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, `${path}[${index}]`)))
  }
  if (typeof value === 'string') {
    if ('minLength' in schema && value.length < schema.minLength) errors.push(`${path} must have at least ${schema.minLength} characters`)
    if ('maxLength' in schema && value.length > schema.maxLength) errors.push(`${path} must have at most ${schema.maxLength} characters`)
    if ('pattern' in schema && !new RegExp(schema.pattern).test(value)) errors.push(`${path} must match ${schema.pattern}`)
  }
  if (isNumber(value)) {
    if ('minimum' in schema && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`)
    if ('maximum' in schema && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`)
  }
  return errors
}

export const EVALUATION_TYPES: EvaluationType[] = ['predicate', 'choice', 'score']

/** Describe what is wrong with an evaluation definition, or return null when it is valid. */
export function evaluationProblem(evaluation: unknown): string | null {
  if (!isObject(evaluation)) return 'evaluation must be an object with a type'
  const unknown = Object.keys(evaluation).filter(key => !['type', 'question', 'options'].includes(key))
  if (unknown.length) return `evaluation has unknown keys: ${unknown.join(', ')}`
  if (!EVALUATION_TYPES.includes(evaluation.type as EvaluationType)) return `evaluation type must be one of ${EVALUATION_TYPES.join(', ')}`
  if (evaluation.question !== undefined && typeof evaluation.question !== 'string') return 'evaluation question must be text'
  if (evaluation.type === 'choice') {
    const options = evaluation.options ?? []
    if (!Array.isArray(options)) return 'choice options must be a list'
    if (options.some(option => typeof option !== 'string' || !option.trim())) return 'choice options must be non-empty text'
    if (new Set(options).size !== options.length) return 'choice options must be unique'
  } else if (evaluation.options !== undefined) {
    return `options are only used by choice evaluations, not ${evaluation.type}`
  }
  return null
}

/** What an otherwise valid evaluation still needs before the workflow can be exported. */
export function evaluationReadiness(evaluation: Evaluation): string | null {
  return evaluation.type === 'choice' && (evaluation.options ?? []).length < 2 ? 'a choice evaluation needs at least two options' : null
}

/** JSON Schema of the output object for an evaluation. */
export function resultSchema(evaluation: Evaluation): Record<string, any> {
  const result = evaluation.type === 'predicate' ? { type: 'boolean' }
    : evaluation.type === 'choice' ? { type: 'string', enum: evaluation.options ?? [] }
    : { type: 'number', minimum: 0, maximum: 1 }
  return { type: 'object', required: ['result'], properties: { result, reason: { type: 'string' } } }
}

/** The output contract given to the agent for a step, or null when the step has no evaluation. */
export function contractFor(node: WorkflowNode) {
  const evaluation = node.evaluation
  if (!evaluation) return null
  const example: JsonObject = { result: evaluation.type === 'predicate' ? true : evaluation.type === 'choice' ? (evaluation.options?.[0] ?? '') : 0.8, reason: 'One or two sentences explaining the result.' }
  const result = evaluation.type === 'predicate' ? 'true or false'
    : evaluation.type === 'choice' ? `exactly one of ${JSON.stringify(evaluation.options ?? [])}`
    : 'a number from 0 to 1'
  return { type: evaluation.type, ...(evaluation.question ? { question: evaluation.question } : {}), ...(evaluation.options ? { options: evaluation.options } : {}), result, example }
}

/** Results of an evaluation that no transition handles, described for warnings. */
export function uncoveredResults(node: WorkflowNode): string[] {
  const evaluation = node.evaluation
  if (!evaluation || node.terminal || !node.next?.length) return []
  const reaches = (result: Json) => {
    try { return nextNode(node, { output: { result }, state: {} }) !== null } catch { return true }
  }
  if (evaluation.type === 'predicate') return [true, false].filter(value => !reaches(value)).map(String)
  if (evaluation.type === 'choice') return (evaluation.options ?? []).filter(option => !reaches(option))
  const missing = Array.from({ length: 101 }, (_, index) => index / 100).filter(value => !reaches(value))
  if (!missing.length) return []
  return [`scores such as ${missing[Math.floor(missing.length / 2)]}`]
}

/** Return the evaluation errors for a step output; an empty list means it passed. */
export function evaluate(node: WorkflowNode, output: JsonObject): string[] {
  return node.evaluation ? validateSchema(output, resultSchema(node.evaluation)) : []
}

/** Parse step output as JSON, accepting fenced or embedded objects. */
export function parseOutput(text: string): JsonObject {
  const trimmed = text.trim()
  const candidates = [trimmed]
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(match => match[1]).reverse()
  candidates.push(...fenced)
  if (trimmed.includes('{') && trimmed.includes('}')) candidates.push(trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1))
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      return isObject(value) ? value as JsonObject : { value }
    } catch { /* next candidate */ }
  }
  return { text: trimmed }
}

// --- Transitions -----------------------------------------------------------

export function newStateData(input: Json = {}): RunState['data'] {
  return { input: input ?? {}, outputs: {}, feedback: {}, last_output: null }
}

export function contextFor(state: RunState, output: JsonObject = {}): { output: JsonObject; state: Record<string, unknown> } {
  return { output, state: { ...state.data, attempts: state.attempts } }
}

/**
 * Evaluate a node output and choose the next state.
 * Mutates `state` (outputs, feedback, attempts, retries, steps).
 */
export function decide(workflow: Workflow, state: RunState, nodeId: string, output: JsonObject): Decision {
  const decision = decideOnce(workflow, state, nodeId, output)
  const limit = workflow.max_steps ?? DEFAULT_MAX_STEPS
  const target = workflow.nodes[decision.next_node ?? nodeId] ?? {}
  if (decision.status !== 'failed' && state.steps >= limit && !target.terminal) {
    // Name the steps that used the budget, so a runaway loop is easy to spot.
    const used = Object.entries(state.attempts).map(([id, count]) => `${id} ${count}`).join(', ')
    return { status: 'failed', node: nodeId, errors: decision.errors, error: `Workflow exceeded max_steps (${limit}): ${used}` }
  }
  return decision
}

function decideOnce(workflow: Workflow, state: RunState, nodeId: string, output: JsonObject): Decision {
  const node = workflow.nodes[nodeId]
  const { data } = state
  state.retries ??= {}
  state.attempts ??= {}
  // Every submission counts, valid or not; `retries` only counts consecutive invalid ones.
  state.attempts[nodeId] = (state.attempts[nodeId] ?? 0) + 1
  state.steps = (state.steps ?? 0) + 1
  data.outputs[nodeId] = output
  data.last_output = output
  const context = contextFor(state, output)
  const errors = evaluate(node, output)
  if (errors.length) {
    state.retries[nodeId] = (state.retries[nodeId] ?? 0) + 1
    data.feedback[nodeId] = errors
    if (state.retries[nodeId] < (node.max_attempts ?? 1)) return { status: 'retry', node: nodeId, errors }
    state.retries[nodeId] = 0
    if (node.on_fail) return { status: 'next', node: nodeId, next_node: node.on_fail, errors, evaluation: 'failed' }
    return { status: 'failed', node: nodeId, errors, error: `Output of ${nodeId} failed evaluation: ${errors.join('; ')}` }
  }
  state.retries[nodeId] = 0
  delete data.feedback[nodeId]
  const target = nextNode(node, context)
  if (target === null) return { status: 'failed', node: nodeId, errors: [], error: `No transition matched for node ${nodeId}` }
  return { status: 'next', node: nodeId, next_node: target, errors: [], evaluation: 'passed' }
}
