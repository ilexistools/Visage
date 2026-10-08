import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflowToMermaid } from '../src/mermaid.ts'

test('workflows become Mermaid flowcharts with safe IDs and escaped text', () => {
  const diagram = workflowToMermaid({
    start: 'review-draft',
    nodes: {
      'review-draft': {
        type: 'skill', label: 'Review "final" | <v2>', on_fail: 'end',
        evaluation: { type: 'choice', question: 'Ready for the editor, with every section of the brief covered?', options: ['approved', 'changes'] },
        next: [{ goto: 'end', when: 'output.result == "approved"' }, { goto: '1st', when: 'output.result == "changes"' }, { goto: 'end', label: 'Escalate' }],
      },
      '1st': { type: 'skill', evaluation: { type: 'score' }, next: [{ goto: 'end', when: 'output.result >= 0.8' }, { goto: 'review-draft' }] },
      end: { type: 'skill', label: 'Done', terminal: true },
    },
  })
  assert.equal(diagram, [
    'flowchart LR',
    '  n_review_draft{"Review #quot;final#quot; #124; #lt;v2#gt;<br/>Ready for the editor, with every section of the…"}',
    '  n_1st{"1st"}',
    '  n_end(["Done"])',
    '  n_review_draft -->|"approved"| n_end',
    '  n_review_draft -->|"changes"| n_1st',
    '  n_review_draft -->|"Escalate"| n_end',
    '  n_review_draft -.->|"invalid result"| n_end',
    '  n_1st -->|"≥ 0.8"| n_end',
    '  n_1st -->|"otherwise"| n_review_draft',
    '',
  ].join('\n'))
})

test('IDs that collide after cleaning stay distinct, and keywords such as end are safe', () => {
  const diagram = workflowToMermaid({ start: 'a-b', nodes: { 'a-b': { type: 'skill', next: [{ goto: 'a_b' }] }, a_b: { type: 'skill', next: [{ goto: 'end' }] }, end: { type: 'skill', terminal: true } } })
  assert.match(diagram, /n_a_b\["a-b"\]\n/)
  assert.match(diagram, /n_a_b_\["a_b"\]\n/)
  assert.match(diagram, /n_a_b --> n_a_b_\n/)
  assert.match(diagram, /n_a_b_ --> n_end\n/)
  assert.doesNotMatch(diagram, /^\s+end\b/m)
})
