import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, matches, newStateData, parseOutput, validateSchema, type RunState, type Workflow } from '../src/engine.ts'
import { SCHEMA } from './helpers.ts'

const state = (): RunState => ({ data: newStateData({}), attempts: {}, retries: {}, steps: 0 })

test('expressions are restricted and support membership, length and hyphenated paths', () => {
  const context = { output: { status: 'ok', items: [1, 2] }, state: { outputs: { 'find-provisions': { count: 3 } }, attempts: { repair: 2 } } }
  assert.ok(matches('output.status == "ok"', context))
  assert.ok(matches("output.status in ['ok', 'done']", context))
  assert.ok(matches('output.status not in ["failed"]', context))
  assert.ok(matches('output.items.length >= 2', context))
  assert.ok(matches('state.outputs.find-provisions.count == 3', context))
  assert.ok(matches('state.attempts.repair < 3', context))
  assert.ok(matches('output.missing == null', context))
  assert.ok(!matches('output.missing > 1', context))
  assert.ok(!matches('output.status > 1', context))
  assert.throws(() => matches('__import__("os").system("true")', {}))
  assert.throws(() => matches('output.x == process.exit()', {}))
})

test('schema validation reports readable errors', () => {
  const errors = validateSchema({ score: 2, items: [], extra: 1 }, { ...SCHEMA, additionalProperties: false })
  assert.ok(errors.includes('output.score must be <= 1'))
  assert.ok(errors.includes('output.items must have at least 1 items'))
  assert.ok(errors.includes('output.extra is not allowed'))
  assert.deepEqual(validateSchema({ score: 0.5, items: ['x'] }, SCHEMA), [])
  assert.deepEqual(validateSchema('x', { type: 'integer' }), ['output must be of type integer'])
})

test('parseOutput accepts fenced and embedded JSON', () => {
  assert.deepEqual(parseOutput('Done.\n```json\n{"ok": true}\n```'), { ok: true })
  assert.deepEqual(parseOutput('Result: {"a": 1} end'), { a: 1 })
  assert.deepEqual(parseOutput('[1]'), { value: [1] })
  assert.deepEqual(parseOutput('plain text'), { text: 'plain text' })
})

test('decide retries with feedback, routes on_fail and enforces max_steps', () => {
  const workflow: Workflow = {
    start: 'draft', max_steps: 4,
    nodes: {
      draft: { type: 'skill', checks: [{ when: 'output.score >= 0.8', message: 'Score too low' }], max_attempts: 2, on_fail: 'fix', next: [{ goto: 'done' }] },
      fix: { type: 'skill', next: [{ goto: 'draft' }] },
      done: { type: 'skill', terminal: true },
    },
  }
  const run = state()
  assert.equal(decide(workflow, run, 'draft', { score: 0.1 }).status, 'retry')
  assert.deepEqual(run.data.feedback.draft, ['Score too low'])
  const routed = decide(workflow, run, 'draft', { score: 0.2 })
  assert.deepEqual([routed.status, routed.next_node, routed.evaluation], ['next', 'fix', 'failed'])
  assert.equal(decide(workflow, run, 'fix', { fixed: true }).next_node, 'draft')
  const passed = decide(workflow, run, 'draft', { score: 0.9 })
  assert.deepEqual([passed.status, passed.next_node], ['next', 'done'])
  assert.equal(run.data.feedback.draft, undefined)
  const looping: Workflow = { start: 'a', max_steps: 2, nodes: { a: { type: 'skill', next: [{ goto: 'a' }] }, end: { type: 'skill', terminal: true } } }
  const loop = state()
  assert.equal(decide(looping, loop, 'a', {}).status, 'next')
  assert.match(decide(looping, loop, 'a', {}).error ?? '', /max_steps/)
})
