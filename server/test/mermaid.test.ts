import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflowToMermaid } from '../src/mermaid.ts'

test('workflows become Mermaid state diagrams with safe IDs and escaped text', () => {
  const diagram = workflowToMermaid({
    start: 'review-draft',
    nodes: {
      'review-draft': {
        type: 'skill', label: 'Review "final"; v2: ok', on_fail: '1st',
        evaluation: { type: 'choice', question: 'Ready: yes?', options: ['approved', 'changes'] },
        next: [{ goto: 'done', when: 'output.result == "approved"' }, { goto: '1st', when: 'output.result == "changes"' }, { goto: 'done', label: 'Escalate' }],
      },
      '1st': { type: 'skill', evaluation: { type: 'score' }, next: [{ goto: 'done', when: 'output.result >= 0.8' }, { goto: 'review-draft' }] },
      done: { type: 'skill', label: 'Done', terminal: true },
    },
  })
  assert.equal(diagram, [
    'stateDiagram-v2',
    '  direction LR',
    '  state "Review #quot;final#quot;#59; v2#58; ok" as review_draft',
    '  state "1st" as s_1st',
    '  state "Done" as done',
    '  [*] --> review_draft',
    '  review_draft --> done : approved',
    '  review_draft --> s_1st : changes',
    '  review_draft --> done : Escalate',
    '  review_draft --> s_1st : invalid result',
    '  note right of review_draft : Ready#58; yes?',
    '  s_1st --> done : ≥ 0.8',
    '  s_1st --> review_draft : otherwise',
    '  done --> [*]',
    '',
  ].join('\n'))
})

test('IDs that collide after cleaning stay distinct', () => {
  const diagram = workflowToMermaid({ start: 'a-b', nodes: { 'a-b': { type: 'skill', next: [{ goto: 'a_b' }] }, a_b: { type: 'skill', terminal: true } } })
  assert.match(diagram, /state "a-b" as a_b\n/)
  assert.match(diagram, /state "a_b" as a_b_\n/)
  assert.match(diagram, /a_b --> a_b_\n/)
})
