import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROBE_SCENARIOS, probeWorkflow, runConformance } from '../src/conformance.ts'
import { parseScenarios, simulate } from '../src/scenarios.ts'

const agent = join(import.meta.dirname, 'fixtures', 'fake-agent.mjs')
const run = (mode: string) => runConformance({ harness: 'custom', command: `node ${agent} {skill} {input_file} ${mode}`, out: mkdtempSync(join(tmpdir(), 'visage-conf-')), timeoutSeconds: 60 })

test('the probe scenarios agree with the probe workflow', () => {
  // The expected paths are checked against the simulator, so the kit cannot expect an impossible path.
  const workflow = probeWorkflow()
  for (const scenario of PROBE_SCENARIOS) {
    const results: Record<string, unknown[]> = {
      classify: [(scenario.input as any).route],
      check: [(scenario.input as any).first_check, true],
      strict: ['not-a-boolean', true],
      grade: [(scenario.input as any).score],
    }
    const [parsed] = parseScenarios(JSON.stringify({ scenarios: [{ name: scenario.name, input: scenario.input, results, expect: { path: scenario.path, status: 'completed' } }] }), workflow)
    const result = simulate(workflow, parsed)
    assert.equal(result.passed, true, `${scenario.name}: ${result.mismatches.join('; ')}`)
  }
})

test('an agent that follows the protocol passes every scenario', async () => {
  const summary = await run('honest')
  assert.equal(summary.total, PROBE_SCENARIOS.length)
  for (const report of summary.reports) assert.equal(report.passed, true, `${report.scenario}: ${JSON.stringify(report.checks.filter(check => !check.passed))}`)
  const retry = summary.reports.find(report => report.scenario === 'retry')!
  assert.deepEqual(retry.path, ['intake', 'classify', 'strict', 'strict', 'done_beta'])
})

test('an agent that answers without the runner fails', async () => {
  const summary = await run('no-runner')
  assert.equal(summary.passed, 0)
  assert.match(summary.reports[0].checks[0].detail ?? '', /never called flow\.mjs start/)
})

test('an agent that does not read a step is caught by its canary', async () => {
  const summary = await runConformance({ harness: 'custom', command: `node ${agent} {skill} {input_file} wrong-canary`, scenarios: ['score-high'], out: mkdtempSync(join(tmpdir(), 'visage-conf-')), timeoutSeconds: 60 })
  const canary = summary.reports[0].checks.find(check => check.name === 'read every step (canaries)')!
  assert.equal(canary.passed, false)
  assert.match(canary.detail ?? '', /classify sent "made-up"/)
})
