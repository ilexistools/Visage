import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluationProblem, nextNode, uncoveredResults, type WorkflowNode } from '../src/engine.ts'
import {
  conditionSummary, conditionToWhen, dropOption, orderArcs, parseCondition, renameOption, resetResultConditions, uncovered,
  type ArcCondition, type Evaluation, type Transition,
} from '../../frontend/src/evaluation.ts'

const predicate: Evaluation = { type: 'predicate' }
const choice: Evaluation = { type: 'choice', options: ['approved', 'changes', 'rejected'] }
const score: Evaluation = { type: 'score' }

test('arc conditions round-trip and route the way the engine evaluates them', () => {
  const cases: [Evaluation, ArcCondition, string | undefined, unknown, boolean][] = [
    [predicate, { kind: 'is', value: true }, 'output.result == true', true, true],
    [predicate, { kind: 'is', value: false }, 'output.result == false', true, false],
    [choice, { kind: 'is', value: 'changes' }, 'output.result == "changes"', 'changes', true],
    [score, { kind: 'score', operator: '>=', threshold: 0.8 }, 'output.result >= 0.8', 0.8, true],
    [score, { kind: 'score', operator: '<', threshold: 0.5 }, 'output.result < 0.5', 0.6, false],
    [score, { kind: 'otherwise' }, undefined, 0.1, true],
  ]
  for (const [evaluation, condition, when, result, routes] of cases) {
    assert.equal(conditionToWhen(condition), when)
    assert.deepEqual(parseCondition(when, evaluation), condition)
    const node: WorkflowNode = { evaluation, next: [{ goto: 'target', ...(when ? { when } : {}) }] }
    assert.equal(nextNode(node, { output: { result } }) === 'target', routes, String(when))
  }
  assert.deepEqual(parseCondition('output.passed == true', predicate), { kind: 'custom', when: 'output.passed == true' })
  assert.deepEqual(parseCondition('output.result == "gone"', choice), { kind: 'custom', when: 'output.result == "gone"' })
  assert.deepEqual(parseCondition("output.result == 'approved'", choice), { kind: 'is', value: 'approved' })
})

test('arcs are summarised on the canvas and ordered so the otherwise arc comes last', () => {
  assert.equal(conditionSummary('output.result == true', predicate), 'yes')
  assert.equal(conditionSummary('output.result == "approved"', choice), 'approved')
  assert.equal(conditionSummary('output.result >= 0.8', score), '≥ 0.8')
  assert.equal(conditionSummary(undefined, score), 'otherwise')
  assert.equal(conditionSummary(undefined, undefined), '')
  const arcs: Transition[] = [{ goto: 'rewrite' }, { goto: 'revise', when: 'output.result >= 0.5' }, { goto: 'drop', when: 'output.result < 0.2' }, { goto: 'done', when: 'output.result >= 0.8' }]
  assert.deepEqual(orderArcs(arcs, score).map(arc => arc.goto), ['done', 'revise', 'drop', 'rewrite'])
})

test('uncovered results match the engine warnings', () => {
  const scenarios: [Evaluation, Transition[]][] = [
    [predicate, [{ goto: 'a', when: 'output.result == true' }]],
    [predicate, [{ goto: 'a', when: 'output.result == true' }, { goto: 'b' }]],
    [choice, [{ goto: 'a', when: 'output.result == "approved"' }, { goto: 'b', when: 'output.result == "changes"' }]],
    [score, [{ goto: 'a', when: 'output.result >= 0.8' }, { goto: 'b', when: 'output.result < 0.5' }]],
    [score, [{ goto: 'a', when: 'output.result >= 0.8' }, { goto: 'b', when: 'output.result < 0.8' }]],
  ]
  for (const [evaluation, next] of scenarios) {
    const engine = uncoveredResults({ evaluation, next }).map(item => item.replace(/^true$/, 'yes').replace(/^false$/, 'no'))
    assert.deepEqual(uncovered(next, evaluation), engine, JSON.stringify(next))
  }
})

test('changing the type resets result arcs, and renamed options follow their arcs', () => {
  const arcs: Transition[] = [{ goto: 'a', when: 'output.result == true', label: 'ok' }, { goto: 'b', when: 'state.attempts.x > 2' }]
  assert.deepEqual(resetResultConditions(arcs), [{ goto: 'a', label: 'ok' }, { goto: 'b', when: 'state.attempts.x > 2' }])
  assert.deepEqual(renameOption([{ goto: 'a', when: 'output.result == "changes"' }], 'changes', 'revise'), [{ goto: 'a', when: 'output.result == "revise"' }])
  assert.equal(evaluationProblem({ type: 'choice', options: [] }), null, 'a new choice starts without options')
  assert.deepEqual(dropOption([{ goto: 'a', when: 'output.result == "changes"', label: 'x' }, { goto: 'b', when: 'output.result == "ok"' }], 'changes'), [{ goto: 'a', label: 'x' }, { goto: 'b', when: 'output.result == "ok"' }])
})
