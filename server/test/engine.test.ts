import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contractFor, decide, evaluate, evaluationProblem, evaluationReadiness, matches, newStateData, parseOutput, uncoveredResults, validateSchema, type RunState, type Workflow } from '../src/engine.ts'
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

test('evaluation types define the result each step must return', () => {
  assert.deepEqual(evaluate({ evaluation: { type: 'predicate' } }, { result: true, files: ['a.html'] }), [])
  assert.deepEqual(evaluate({ evaluation: { type: 'predicate' } }, { result: 'yes' }), ['output.result must be of type boolean'])
  assert.deepEqual(evaluate({ evaluation: { type: 'choice', options: ['approved', 'changes'] } }, { result: 'maybe' }), ['output.result must be one of ["approved","changes"]'])
  assert.deepEqual(evaluate({ evaluation: { type: 'score' } }, { result: 1.2 }), ['output.result must be <= 1'])
  assert.deepEqual(evaluate({ evaluation: { type: 'score' } }, { text: 'no json' }), ['output.result is required'])
  assert.deepEqual(evaluate({}, { anything: 1 }), [])
  assert.equal(evaluationProblem({ type: 'choice', options: ['only'] }), null, 'an unfinished choice can be saved')
  assert.equal(evaluationReadiness({ type: 'choice', options: ['only'] }), 'a choice evaluation needs at least two options')
  assert.equal(evaluationProblem({ type: 'choice', options: [''] }), 'choice options must be non-empty text')
  assert.equal(evaluationProblem({ type: 'score', options: ['a', 'b'] }), 'options are only used by choice evaluations, not score')
  assert.equal(evaluationProblem({ type: 'vote' }), 'evaluation type must be one of predicate, choice, score')
  assert.equal(evaluationProblem({ type: 'choice', options: ['a', 'a'] }), 'choice options must be unique')
  assert.equal(evaluationProblem({ type: 'predicate', question: 'Done?' }), null)
  assert.deepEqual(contractFor({ evaluation: { type: 'choice', question: 'Ship it?', options: ['yes', 'no'] } })?.result, 'exactly one of ["yes","no"]')
})

test('uncovered results are reported per evaluation type', () => {
  assert.deepEqual(uncoveredResults({ evaluation: { type: 'predicate' }, next: [{ goto: 'a', when: 'output.result == true' }] }), ['false'])
  assert.deepEqual(uncoveredResults({ evaluation: { type: 'choice', options: ['x', 'y', 'z'] }, next: [{ goto: 'a', when: 'output.result == "x"' }, { goto: 'b', when: 'output.result in ["y"]' }] }), ['z'])
  assert.deepEqual(uncoveredResults({ evaluation: { type: 'score' }, next: [{ goto: 'a', when: 'output.result >= 0.8' }, { goto: 'b', when: 'output.result < 0.5' }] }), ['scores such as 0.65'])
  assert.deepEqual(uncoveredResults({ evaluation: { type: 'score' }, next: [{ goto: 'a', when: 'output.result >= 0.8' }, { goto: 'b' }] }), [])
})

test('decide retries invalid results with feedback, routes on_fail and on the result', () => {
  const workflow: Workflow = {
    start: 'review', max_steps: 6,
    nodes: {
      review: { type: 'skill', evaluation: { type: 'score' }, max_attempts: 2, on_fail: 'fix', next: [{ goto: 'done', when: 'output.result >= 0.8' }, { goto: 'fix' }] },
      fix: { type: 'skill', next: [{ goto: 'review' }] },
      done: { type: 'skill', terminal: true },
    },
  }
  const run = state()
  assert.equal(decide(workflow, run, 'review', { result: 'high' }).status, 'retry')
  assert.deepEqual(run.data.feedback.review, ['output.result must be of type number'])
  const routed = decide(workflow, run, 'review', { score: 0.9 })
  assert.deepEqual([routed.status, routed.next_node, routed.evaluation], ['next', 'fix', 'failed'])
  assert.equal(decide(workflow, run, 'fix', { fixed: true }).next_node, 'review')
  const low = decide(workflow, run, 'review', { result: 0.4, reason: 'missing tests' })
  assert.deepEqual([low.status, low.next_node, low.evaluation], ['next', 'fix', 'passed'])
  decide(workflow, run, 'fix', {})
  const passed = decide(workflow, run, 'review', { result: 0.92 })
  assert.deepEqual([passed.status, passed.next_node], ['next', 'done'])
  assert.equal(run.data.feedback.review, undefined)
  const looping: Workflow = { start: 'a', max_steps: 2, nodes: { a: { type: 'skill', next: [{ goto: 'a' }] }, end: { type: 'skill', terminal: true } } }
  const loop = state()
  assert.equal(decide(looping, loop, 'a', {}).status, 'next')
  assert.match(decide(looping, loop, 'a', {}).error ?? '', /max_steps/)
})

test('decide counts every submission in state.attempts, so a loop can be capped', () => {
  const workflow: Workflow = {
    start: 'fix', max_steps: 10,
    nodes: {
      fix: { type: 'skill', evaluation: { type: 'predicate' }, max_attempts: 2, next: [{ goto: 'done', when: 'state.attempts.fix >= 2' }, { goto: 'fix' }] },
      done: { type: 'skill', terminal: true },
    },
  }
  const run = state()
  assert.equal(decide(workflow, run, 'fix', { result: 'bad' }).status, 'retry')
  assert.equal(run.attempts.fix, 1, 'an invalid submission counts too')
  assert.deepEqual(decide(workflow, run, 'fix', { result: true }).next_node, 'done')
  assert.equal(run.attempts.fix, 2)
})

test('max_attempts counts consecutive invalid results; a valid result resets the count', () => {
  const workflow: Workflow = {
    start: 'design', max_steps: 20,
    nodes: {
      design: { type: 'skill', evaluation: { type: 'choice', options: ['good', 'incomplete'] }, max_attempts: 3, on_fail: 'blocked', next: [{ goto: 'done', when: 'output.result == "good"' }, { goto: 'design' }] },
      done: { type: 'skill', terminal: true },
      blocked: { type: 'skill', terminal: true },
    },
  }
  const run = state()
  for (const result of ['incomplete', 42, 'incomplete', 42, 42]) assert.notEqual(decide(workflow, run, 'design', { result }).next_node, 'blocked')
  assert.equal(decide(workflow, run, 'design', { result: 42 }).next_node, 'blocked', 'the third invalid result in a row goes to on_fail')
  assert.equal(run.attempts.design, 6)
})

test('exceeding max_steps names the steps that used the budget', () => {
  const workflow: Workflow = {
    start: 'analyze', max_steps: 5,
    nodes: { analyze: { type: 'skill', next: [{ goto: 'fix' }] }, fix: { type: 'skill', next: [{ goto: 'analyze' }] }, end: { type: 'skill', terminal: true } },
  }
  const run = state()
  let decision = decide(workflow, run, 'analyze', {})
  while (decision.status === 'next') decision = decide(workflow, run, decision.next_node!, {})
  assert.equal(decision.error, 'Workflow exceeded max_steps (5): analyze 3, fix 2')
})

test('word operators need spaces, so run-together text is rejected', () => {
  assert.throws(() => matches("output.within 'abc'", { output: { with: 'b' } }))
  assert.ok(matches("output.with in 'abc'", { output: { with: 'b' } }))
})
