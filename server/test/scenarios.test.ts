import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Workflow } from '../src/engine.ts'
import { parseScenarios, simulate } from '../src/scenarios.ts'

const blog: Workflow = {
  start: 'plan', max_steps: 12,
  nodes: {
    plan: { type: 'skill', next: [{ goto: 'draft' }] },
    draft: { type: 'skill', next: [{ goto: 'review' }] },
    review: {
      type: 'skill', evaluation: { type: 'choice', options: ['approved', 'changes', 'rejected'] }, max_attempts: 2, on_fail: 'archive',
      next: [{ goto: 'publish', when: 'output.result == "approved"' }, { goto: 'draft', when: 'output.result == "changes"' }, { goto: 'archive', when: 'output.result == "rejected"' }],
    },
    publish: { type: 'skill', terminal: true },
    archive: { type: 'skill', terminal: true },
  },
}

const run = (yaml: string) => parseScenarios(yaml, blog).map(scenario => simulate(blog, scenario))

test('scripted results follow the arcs, revisits included', () => {
  const [result] = run(`
scenarios:
  - name: approved after one revision
    results: {review: [changes, approved]}
    expect: {path: [plan, draft, review, draft, review, publish], status: completed, final: publish}
`)
  assert.equal(result.passed, true, result.mismatches.join('; '))
  assert.deepEqual(result.path, ['plan', 'draft', 'review', 'draft', 'review', 'publish'])
  assert.deepEqual(result.steps.map(step => step.decision), ['next', 'next', 'next', 'next', 'next'])
})

test('invalid results retry, then follow on_fail', () => {
  const [result] = run(`
scenarios:
  - name: two invalid answers
    results: {review: [maybe, {result: 42}]}
    expect: {path: [plan, draft, review, review, archive], final: archive}
`)
  assert.equal(result.passed, true, result.mismatches.join('; '))
  assert.deepEqual(result.steps.slice(2).map(step => step.decision), ['retry', 'next'])
  assert.match(result.steps[2].errors[0], /must be one of/)
})

test('mismatches explain what differs', () => {
  const [wrongPath, missing, loop] = run(`
scenarios:
  - name: wrong expectation
    results: {review: [rejected]}
    expect: {path: [plan, draft, review, publish], final: publish}
  - name: unscripted visit
    results: {review: [changes]}
  - name: endless revisions
    results: {review: [changes, changes, changes, changes, changes]}
    expect: {status: failed, error: max_steps}
`)
  assert.equal(wrongPath.passed, false)
  assert.ok(wrongPath.mismatches.includes('expected to end in publish, ended in archive'))
  assert.ok(wrongPath.mismatches.includes('path differs at step 4: expected publish, got archive'))
  assert.equal(missing.status, 'failed')
  assert.match(missing.error ?? '', /No result scripted for review \(submission 2\)/)
  assert.equal(missing.passed, false, 'an unexpected failure fails the scenario')
  assert.equal(loop.passed, true, loop.mismatches.join('; '))
})

test('scenario files are validated against the workflow', () => {
  assert.throws(() => parseScenarios('scenarios: {}', blog), /scenarios list/)
  assert.throws(() => parseScenarios('scenarios: [{results: {nope: [1]}}]', blog), /unknown step "nope"/)
  assert.throws(() => parseScenarios('scenarios: [{expect: {final: nope}}]', blog), /unknown node "nope"/)
  assert.throws(() => parseScenarios('scenarios: [{expect: {status: done}}]', blog), /completed or failed/)
  assert.deepEqual(parseScenarios('', blog), [])
})
