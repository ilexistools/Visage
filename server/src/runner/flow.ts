/**
 * Standalone runner for a Visage workflow exported as a plugin (bundled to flow.mjs).
 *
 * The agent executes each step; this script owns the state machine: it says which
 * step to run, evaluates the submitted output and chooses the next step.
 * Only Node.js is required.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { randomBytes } from 'node:crypto'
import { decide, newStateData, normalizedChecks, parseOutput, type Json, type RunState, type Workflow } from '../engine.ts'

type PortableWorkflow = Workflow & { plugin: string }
type State = RunState & { run_id: string; current_node: string; run_status: 'running' | 'completed' | 'failed'; error?: string; created_at: string; updated_at?: string }

const SCRIPT = fileURLToPath(import.meta.url)
const SKILL_DIR = dirname(dirname(SCRIPT))
const WORKFLOW: PortableWorkflow = JSON.parse(readFileSync(join(SKILL_DIR, 'workflow.json'), 'utf8'))

const now = () => new Date().toISOString()
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n')
function fail(message: string): never {
  emit({ status: 'error', error: message })
  process.exit(1)
}

const stateRoot = (stateDir?: string) => resolve(stateDir || process.env.VISAGE_STATE_DIR || join(process.cwd(), '.visage', 'runs', WORKFLOW.plugin))

function runPath(stateDir: string | undefined, runId?: string): string {
  const root = stateRoot(stateDir)
  if (!runId) {
    if (!existsSync(join(root, 'LATEST'))) fail("No run found. Start one with the 'start' command.")
    runId = readFileSync(join(root, 'LATEST'), 'utf8').trim()
  }
  const path = join(root, runId)
  if (!existsSync(join(path, 'state.json'))) fail(`Run not found: ${runId}`)
  return path
}

const load = (path: string): State => JSON.parse(readFileSync(join(path, 'state.json'), 'utf8'))

function save(path: string, state: State): void {
  state.updated_at = now()
  mkdirSync(path, { recursive: true })
  const temp = join(path, `state.json.${randomBytes(4).toString('hex')}.tmp`)
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n')
  renameSync(temp, join(path, 'state.json'))
  appendFileSync(join(path, 'history.jsonl'), JSON.stringify({ timestamp: state.updated_at, status: state.run_status, node: state.current_node }) + '\n')
}

function summary(path: string, state: State) {
  const final = WORKFLOW.nodes[state.current_node] ?? {}
  return {
    status: state.run_status, run_id: state.run_id, node: state.current_node, outputs: state.data.outputs,
    artifact_dir: join(path, 'artifacts'),
    ...(state.error ? { error: state.error } : {}),
    ...(state.run_status === 'completed' && final.description ? { final_state: final.description } : {}),
  }
}

function instruction(path: string, state: State) {
  const nodeId = state.current_node
  const node = WORKFLOW.nodes[nodeId]
  if (node.terminal || state.run_status !== 'running') return summary(path, state)
  const stepDir = join(SKILL_DIR, 'nodes', nodeId)
  const outputFile = join(path, 'outputs', `${String(state.steps + 1).padStart(3, '0')}-${nodeId}.json`)
  const artifactDir = join(path, 'artifacts')
  mkdirSync(artifactDir, { recursive: true })
  const contract: Record<string, unknown> = {}
  if (node.output_schema) contract.schema = node.output_schema
  if (node.checks?.length) contract.checks = normalizedChecks(node)
  return {
    status: 'awaiting_output',
    run_id: state.run_id,
    node: nodeId,
    label: node.label ?? nodeId,
    description: node.description ?? '',
    attempt: (state.retries[nodeId] ?? 0) + 1,
    max_attempts: node.max_attempts ?? 1,
    step_file: join(stepDir, 'STEP.md'),
    resources_dir: stepDir,
    feedback: state.data.feedback[nodeId] ?? [],
    input: state.data.input,
    previous_outputs: state.data.outputs,
    output_contract: contract,
    artifact_dir: artifactDir,
    output_file: outputFile,
    submit: `node "${SCRIPT}" submit --run ${state.run_id} --state-dir "${dirname(path)}" --output-file "${outputFile}"`,
  }
}

function settle(state: State): void {
  if (WORKFLOW.nodes[state.current_node].terminal) state.run_status = 'completed'
}

const commands: Record<string, (values: Record<string, string | undefined>) => void> = {
  start(values) {
    let input: Json = {}
    if (values['input-file']) input = JSON.parse(readFileSync(values['input-file'], 'utf8'))
    else if (values.input) {
      try { input = JSON.parse(values.input) } catch { input = { text: values.input } }
    }
    const runId = values.run || `run-${randomBytes(5).toString('hex')}`
    const root = stateRoot(values['state-dir'])
    const path = join(root, runId)
    if (existsSync(join(path, 'state.json'))) fail(`Run already exists: ${runId}`)
    const state: State = {
      run_id: runId, workflow: WORKFLOW.workflow, current_node: WORKFLOW.start, run_status: 'running',
      data: newStateData(input), attempts: {}, retries: {}, steps: 0, created_at: now(),
    }
    settle(state)
    save(path, state)
    writeFileSync(join(root, 'LATEST'), runId)
    emit(instruction(path, state))
  },
  next(values) {
    const path = runPath(values['state-dir'], values.run)
    emit(instruction(path, load(path)))
  },
  submit(values) {
    const path = runPath(values['state-dir'], values.run)
    const state = load(path)
    if (state.run_status !== 'running') fail(`Run is ${state.run_status}; nothing to submit.`)
    const text = values['output-file'] ? readFileSync(values['output-file'], 'utf8') : values.output ?? readFileSync(0, 'utf8')
    const output = parseOutput(text)
    const nodeId = state.current_node
    if (values.node && values.node !== nodeId) fail(`Current step is ${nodeId}, not ${values.node}. Run the 'next' command to see the current step.`)
    state.attempts[nodeId] = (state.attempts[nodeId] ?? 0) + 1
    const decision = decide(WORKFLOW, state, nodeId, output)
    mkdirSync(join(path, 'outputs'), { recursive: true })
    writeFileSync(join(path, 'outputs', `${String(state.steps).padStart(3, '0')}-${nodeId}.json`), JSON.stringify(output, null, 2))
    if (decision.status === 'failed') {
      state.run_status = 'failed'
      state.error = decision.error
    } else if (decision.status === 'next') {
      state.current_node = decision.next_node!
      settle(state)
    }
    save(path, state)
    emit({
      decision: decision.status, evaluated_node: nodeId, errors: decision.errors,
      ...(decision.status === 'next' ? { next_node: decision.next_node } : {}),
      ...instruction(path, state),
    })
  },
  status(values) {
    const path = runPath(values['state-dir'], values.run)
    const state = load(path)
    emit({ ...summary(path, state), attempts: state.attempts, steps: state.steps })
  },
  list(values) {
    const root = stateRoot(values['state-dir'])
    const runs = existsSync(root) ? readdirSync(root).filter(name => existsSync(join(root, name, 'state.json'))).sort().map(name => {
      const state = load(join(root, name))
      return { run_id: state.run_id, status: state.run_status, node: state.current_node, updated_at: state.updated_at }
    }) : []
    emit({ runs })
  },
  describe() {
    emit(WORKFLOW)
  },
}

const HELP = `Usage: node flow.mjs <command> [options]

Commands:
  start     Start a run and print the first step   (--input JSON|text, --input-file PATH, --run ID)
  next      Print the current step                 (--run ID)
  submit    Submit the current step output         (--output-file PATH | --output JSON | stdin, --node ID, --run ID)
  status    Show run status and outputs            (--run ID)
  list      List runs
  describe  Print the workflow definition

Global: --state-dir PATH (default ./.visage/runs/${WORKFLOW.plugin}, or VISAGE_STATE_DIR)`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries(['input', 'input-file', 'run', 'node', 'output-file', 'output', 'state-dir'].map(name => [name, { type: 'string' as const }])),
})
const command = commands[positionals[0] ?? '']
if (!command) {
  process.stdout.write(HELP + '\n')
  process.exit(positionals[0] ? 1 : 0)
}
command(values as Record<string, string | undefined>)
