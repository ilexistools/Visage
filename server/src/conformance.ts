/**
 * Harness conformance kit: runs a probe workflow through a real agent harness (Claude Code,
 * Codex or any CLI) and checks, from the runner's audit trail, that the agent started the run,
 * followed every transition, read every step and handled retries.
 *
 *   node visage.js conformance --harness claude [--model M] [--runs N] [--scenario a,b] [--timeout S] [--out DIR]
 *   node visage.js conformance --command 'my-agent --cwd {workdir} {prompt}'
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import yaml from 'js-yaml'
import type { Json, Workflow } from './engine.ts'
import { exportPlugin } from './exporter.ts'
import { createProject, putWorkflow, writeFile } from './projects.ts'

export const PROBE = 'visage-probe'

export type ProbeScenario = { name: string; description: string; input: Json; path: string[]; retries?: Record<string, number> }

/** Each scenario forces one behaviour through the run input. */
export const PROBE_SCENARIOS: ProbeScenario[] = [
  { name: 'loop', description: 'A predicate answers no, the run goes through a fix step and back', input: { route: 'alpha', first_check: false }, path: ['intake', 'classify', 'check', 'fix', 'check', 'done_alpha'] },
  { name: 'retry', description: 'An invalid result is rejected and resubmitted with feedback', input: { route: 'beta' }, path: ['intake', 'classify', 'strict', 'strict', 'done_beta'], retries: { strict: 1 } },
  { name: 'score-high', description: 'A score at or above the threshold takes the upper arc', input: { route: 'gamma', score: 0.9 }, path: ['intake', 'classify', 'grade', 'done_high'] },
  { name: 'score-low', description: 'A score below the threshold takes the otherwise arc', input: { route: 'gamma', score: 0.2 }, path: ['intake', 'classify', 'grade', 'done_low'] },
]

const STEPS: Record<string, string> = {
  intake: 'Read the run `input`. Submit {"canary": "<canary>", "route": <the value of input.route>}.',
  classify: 'The result is exactly the value of `input.route` ("alpha", "beta" or "gamma"). Submit {"result": <that value>, "reason": "Taken from input.route", "canary": "<canary>"}.',
  check: 'If `previous_outputs` has an entry named `fix`, the result is `true`. Otherwise the result is the boolean in `input.first_check`. Submit {"result": <true or false>, "reason": "...", "canary": "<canary>"}.',
  fix: 'Pretend to fix the problem found by the check. Submit {"fixed": true, "canary": "<canary>"}.',
  strict: 'This step tests retries. Look at the `attempt` field of the step instruction. On attempt 1, submit exactly {"result": "not-a-boolean", "reason": "deliberately invalid", "canary": "<canary>"}. On attempt 2 or later, submit {"result": true, "reason": "corrected after feedback", "canary": "<canary>"}.',
  grade: 'The result is the number in `input.score`. Submit {"result": <that number>, "reason": "Taken from input.score", "canary": "<canary>"}.',
}

export function probeWorkflow(): Workflow {
  const step = (id: string, extra: Record<string, unknown>) => ({ type: 'skill', label: id, skill: { path: `skills/${id}/SKILL.md` }, ...extra })
  const final = (label: string) => ({ type: 'skill', label, terminal: true, description: `Probe reached ${label}` })
  return {
    version: 1,
    workflow: { id: PROBE, name: 'Visage probe', version: '1.0.0', description: 'Conformance probe for agent harnesses. Use only when asked to run the visage-probe workflow.' },
    start: 'intake', max_steps: 20,
    nodes: {
      intake: step('intake', { next: [{ goto: 'classify' }] }),
      classify: step('classify', {
        evaluation: { type: 'choice', question: 'Which route does input.route name?', options: ['alpha', 'beta', 'gamma'] },
        next: [{ goto: 'check', when: 'output.result == "alpha"' }, { goto: 'strict', when: 'output.result == "beta"' }, { goto: 'grade', when: 'output.result == "gamma"' }],
      }),
      check: step('check', { evaluation: { type: 'predicate', question: 'Did the check pass?' }, next: [{ goto: 'done_alpha', when: 'output.result == true' }, { goto: 'fix', when: 'output.result == false' }] }),
      fix: step('fix', { next: [{ goto: 'check' }] }),
      strict: step('strict', { evaluation: { type: 'predicate', question: 'Is the corrected answer accepted?' }, max_attempts: 2, next: [{ goto: 'done_beta' }] }),
      grade: step('grade', { evaluation: { type: 'score', question: 'What is input.score?' }, next: [{ goto: 'done_high', when: 'output.result >= 0.7' }, { goto: 'done_low' }] }),
      done_alpha: final('done_alpha'), done_beta: final('done_beta'), done_high: final('done_high'), done_low: final('done_low'),
    },
  } as Workflow
}

/** Build the probe plugin with fresh canaries in an isolated catalog. Returns the plugin path and the canaries. */
export function buildProbe(folder: string): { plugin: string; skill: string; canaries: Record<string, string> } {
  mkdirSync(folder, { recursive: true })
  const previous = process.env.VISAGE_DATA_DIR
  process.env.VISAGE_DATA_DIR = join(folder, 'catalog')
  try {
    createProject({ id: PROBE, name: 'Visage probe', parent_path: folder })
    const canaries: Record<string, string> = {}
    for (const [id, text] of Object.entries(STEPS)) {
      canaries[id] = `${id}-${randomBytes(4).toString('hex')}`
      writeFile(PROBE, `skills/${id}/SKILL.md`, `# ${id}\n\n${text.replaceAll('<canary>', canaries[id])}\n\nThe canary proves you read this step: always include it exactly as written.\n`)
    }
    putWorkflow(PROBE, yaml.dump(probeWorkflow()))
    const { path } = exportPlugin(PROBE, join(folder, 'plugin'), false)
    return { plugin: path, skill: join(path, 'skills', PROBE, 'SKILL.md'), canaries }
  } finally {
    if (previous === undefined) delete process.env.VISAGE_DATA_DIR
    else process.env.VISAGE_DATA_DIR = previous
  }
}

// --- Checking a run --------------------------------------------------------------

type HistoryLine = { event?: string; node?: string; decision?: string; status?: string; current_node?: string; attempt?: number }
export type Check = { name: string; passed: boolean; detail?: string }

/** Audit the run the harness left in `root` (the runner's state folder) against the scenario's expectations. */
export function checkRun(root: string, scenario: ProbeScenario, canaries: Record<string, string>): { checks: Check[]; path: string[] } {
  const runs = existsSync(root) ? readdirSync(root).filter(name => existsSync(join(root, name, 'state.json'))) : []
  const checks: Check[] = []
  const add = (name: string, passed: boolean, detail?: string) => { checks.push({ name, passed, ...(detail ? { detail } : {}) }) }
  add('started the runner', runs.length > 0, runs.length ? undefined : 'no run found: the agent never called flow.mjs start')
  if (!runs.length) return { checks, path: [] }
  add('used a single run', runs.length === 1, runs.length > 1 ? `${runs.length} runs were started` : undefined)
  const latest = existsSync(join(root, 'LATEST')) ? readFileSync(join(root, 'LATEST'), 'utf8').trim() : runs[0]
  const run = join(root, latest)
  const state = JSON.parse(readFileSync(join(run, 'state.json'), 'utf8'))
  const history: HistoryLine[] = readFileSync(join(run, 'history.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const submits = history.filter(line => line.event === 'submit')
  const path = [...submits.map(line => line.node!), ...(state.run_status === 'completed' ? [state.current_node] : [])]
  add('completed the run', state.run_status === 'completed', state.run_status === 'completed' ? undefined : `run is ${state.run_status}${state.error ? `: ${state.error}` : ''}`)
  const expected = scenario.path.join(' → ')
  add('followed the expected path', path.join(' → ') === expected, path.join(' → ') === expected ? undefined : `expected ${expected}, got ${path.join(' → ') || 'nothing'}`)
  // Every submitted output must carry the canary of its own step.
  const outputs = existsSync(join(run, 'outputs')) ? readdirSync(join(run, 'outputs')).filter(name => /^\d{3}-.+\.json$/.test(name)).sort() : []
  const wrong: string[] = []
  for (const file of outputs) {
    const node = file.slice(4, -5)
    let canary: unknown
    try { canary = JSON.parse(readFileSync(join(run, 'outputs', file), 'utf8')).canary } catch { canary = undefined }
    if (canaries[node] && canary !== canaries[node]) wrong.push(`${node} sent ${canary === undefined ? 'no canary' : JSON.stringify(canary)}`)
  }
  add('read every step (canaries)', outputs.length > 0 && !wrong.length, wrong.length ? wrong.join('; ') : outputs.length ? undefined : 'no outputs were submitted')
  for (const [node, count] of Object.entries(scenario.retries ?? {})) {
    const retried = submits.filter(line => line.node === node && line.decision === 'retry').length
    add(`retried ${node} after feedback`, retried === count, retried === count ? undefined : `${retried} retries instead of ${count}`)
  }
  return { checks, path }
}

// --- Running harnesses ----------------------------------------------------------

export type Harness = { name: string; command: (context: RunContext) => { command: string; args: string[]; shell?: boolean } }
type RunContext = { prompt: string; plugin: string; skill: string; workdir: string; inputFile: string; model?: string }

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

export function harnessFor(name: string, options: { model?: string; command?: string; bin?: string }): Harness {
  if (options.command) {
    const template = options.command
    return {
      name: 'custom',
      command: context => ({
        command: template.replace(/\{(prompt|plugin|skill|workdir|input_file|model)\}/g, (_, key: string) =>
          quote(({ prompt: context.prompt, plugin: context.plugin, skill: context.skill, workdir: context.workdir, input_file: context.inputFile, model: context.model ?? '' } as Record<string, string>)[key])),
        args: [], shell: true,
      }),
    }
  }
  if (name === 'claude') {
    return {
      name,
      command: context => ({
        command: options.bin ?? 'claude',
        args: ['-p', context.prompt, '--plugin-dir', context.plugin, '--allowedTools', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', '--permission-mode', 'acceptEdits', ...(context.model ? ['--model', context.model] : [])],
      }),
    }
  }
  if (name === 'codex') {
    return {
      name,
      command: context => ({
        command: options.bin ?? 'codex',
        args: ['exec', '--full-auto', '--skip-git-repo-check', '-C', context.workdir, ...(context.model ? ['-m', context.model] : []), context.prompt],
      }),
    }
  }
  throw new Error(`Unknown harness "${name}". Use claude, codex or --command`)
}

/** Claude Code discovers the plugin's Skill by name; other harnesses get its path. */
export function promptFor(harness: string, skill: string, input: Json): string {
  const request = harness === 'claude'
    ? `Use the ${PROBE} skill to run the workflow`
    : `Read the Skill at ${skill} and follow it exactly to run the workflow`
  return `${request} with this input: ${JSON.stringify(input)}. Keep going until the runner reports that the run is completed or failed, then reply with the final status.`
}

function execute(spec: { command: string; args: string[]; shell?: boolean }, workdir: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; ms: number }>(resolvePromise => {
    const started = Date.now()
    const child = spawn(spec.command, spec.args, { cwd: workdir, env, shell: spec.shell ?? false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => { stderr += String(error) })
    child.on('close', code => { clearTimeout(timer); resolvePromise({ code, stdout, stderr, timedOut, ms: Date.now() - started }) })
  })
}

export type RunReport = { scenario: string; attempt: number; passed: boolean; seconds: number; exit_code: number | null; timed_out: boolean; path: string[]; checks: Check[]; workdir: string }

export async function runConformance(options: { harness: string; model?: string; command?: string; bin?: string; runs?: number; scenarios?: string[]; timeoutSeconds?: number; out?: string; log?: (line: string) => void }) {
  const log = options.log ?? (() => {})
  const out = resolve(options.out ?? mkdtempSync(join(tmpdir(), 'visage-conformance-')))
  mkdirSync(out, { recursive: true })
  const harness = harnessFor(options.harness, options)
  const probe = buildProbe(join(out, 'probe'))
  const selected = PROBE_SCENARIOS.filter(scenario => !options.scenarios?.length || options.scenarios.includes(scenario.name))
  if (!selected.length) throw new Error(`No scenario matches; available: ${PROBE_SCENARIOS.map(scenario => scenario.name).join(', ')}`)
  const reports: RunReport[] = []
  for (const scenario of selected) {
    for (let attempt = 1; attempt <= (options.runs ?? 1); attempt++) {
      const workdir = join(out, 'runs', `${scenario.name}-${attempt}`)
      // The runner keeps its runs here whatever folder the agent works in.
      const stateDir = join(workdir, '.visage', 'runs', PROBE)
      mkdirSync(workdir, { recursive: true })
      const inputFile = join(workdir, 'input.json')
      writeFileSync(inputFile, JSON.stringify(scenario.input))
      const prompt = promptFor(harness.name, probe.skill, scenario.input)
      log(`▶ ${scenario.name} #${attempt} (${harness.name})`)
      const result = await execute(harness.command({ prompt, plugin: probe.plugin, skill: probe.skill, workdir, inputFile, model: options.model }), workdir,
        { ...process.env, VISAGE_STATE_DIR: stateDir }, (options.timeoutSeconds ?? 600) * 1000)
      writeFileSync(join(workdir, 'harness.stdout.txt'), result.stdout)
      writeFileSync(join(workdir, 'harness.stderr.txt'), result.stderr)
      const { checks, path } = checkRun(stateDir, scenario, probe.canaries)
      if (result.timedOut) checks.push({ name: 'finished in time', passed: false, detail: `stopped after ${options.timeoutSeconds ?? 600}s` })
      const passed = checks.every(check => check.passed)
      reports.push({ scenario: scenario.name, attempt, passed, seconds: Math.round(result.ms / 1000), exit_code: result.code, timed_out: result.timedOut, path, checks, workdir })
      log(`  ${passed ? '✔ passed' : '✘ failed'} in ${Math.round(result.ms / 1000)}s${passed ? '' : ': ' + checks.filter(check => !check.passed).map(check => `${check.name} (${check.detail})`).join('; ')}`)
    }
  }
  const summary = { harness: harness.name, model: options.model ?? null, total: reports.length, passed: reports.filter(report => report.passed).length, out, reports }
  writeFileSync(join(out, 'report.json'), JSON.stringify(summary, null, 2))
  return summary
}

/** Entry point for `visage.js conformance ...`. */
export async function conformanceCli(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      harness: { type: 'string', default: 'claude' }, model: { type: 'string' }, command: { type: 'string' }, bin: { type: 'string' },
      runs: { type: 'string', default: '1' }, scenario: { type: 'string' }, timeout: { type: 'string', default: '600' }, out: { type: 'string' },
      list: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    },
  })
  if (values.help) {
    process.stdout.write(`Usage: visage conformance [--harness claude|codex] [--command 'cli {prompt}'] [--model M] [--runs N] [--scenario a,b] [--timeout SECONDS] [--out DIR]
Runs the visage-probe workflow through an agent harness and checks that it follows every transition.
--command placeholders: {prompt} {plugin} {skill} {workdir} {input_file} {model}
Scenarios: ${PROBE_SCENARIOS.map(scenario => scenario.name).join(', ')}\n`)
    return 0
  }
  if (values.list) {
    for (const scenario of PROBE_SCENARIOS) process.stdout.write(`${scenario.name.padEnd(11)} ${scenario.description}\n`)
    return 0
  }
  const summary = await runConformance({
    harness: values.harness!, model: values.model, command: values.command, bin: values.bin,
    runs: Math.max(1, Number(values.runs) || 1), scenarios: values.scenario?.split(',').map(name => name.trim()).filter(Boolean),
    timeoutSeconds: Math.max(10, Number(values.timeout) || 600), out: values.out, log: line => process.stdout.write(line + '\n'),
  })
  process.stdout.write(`\n${summary.passed}/${summary.total} runs passed · report: ${join(summary.out, 'report.json')}\n`)
  return summary.passed === summary.total ? 0 : 1
}
