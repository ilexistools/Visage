import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkflowNode } from '../src/engine.ts'
import { skillGaps, PLACEHOLDER_SKILL } from '../src/skillQuality.ts'
import { upsertNode, validateProject } from '../src/projects.ts'
import { freshDataDir, startServer } from './helpers.ts'

const guide = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'harness', 'references', 'authoring-guide.md'), 'utf8')
const review: WorkflowNode = { type: 'skill', evaluation: { type: 'choice', question: 'Is the draft ready?', options: ['approved', 'changes', 'rejected'] } }
const filler = (words: number) => Array.from({ length: words }, (_, i) => `word${i}`).join(' ')

test('the example Skill in the authoring guide passes, and its shallow counterpart does not', () => {
  const example = /````markdown\n([\s\S]*?)\n````/.exec(guide)?.[1]
  assert.ok(example, 'the guide has a full example Skill')
  assert.deepEqual(skillGaps(example, review), [])
  const shallow = /written as a prompt[^\n]*\n\n```markdown\n([\s\S]*?)```/.exec(guide)?.[1]
  assert.ok(shallow, 'the guide shows the shallow version')
  const gaps = skillGaps(shallow, review)
  assert.ok(gaps.some(gap => gap.startsWith('only ')), gaps.join('; '))
  for (const gap of ['no numbered procedure', 'no section with quality criteria or a definition of done', 'no example of the JSON it returns']) assert.ok(gaps.includes(gap), gap)
})

test('evaluated steps must explain every outcome', () => {
  const base = (body: string) => `# Step\n\n${filler(160)}\n\n1. Do it.\n\n## Quality criteria\n\n- Done.\n\n${body}\n\n{"result": true, "reason": "..."}\n`
  assert.deepEqual(skillGaps(base('Approved when complete; changes when fixable.'), review), ['never says when the result is "rejected"'])
  assert.ok(skillGaps(base('Approve when complete; the user disapproves otherwise.'), review).some(gap => gap.includes('"approved", "changes", "rejected"')), 'option words inside other words do not count')
  const predicate: WorkflowNode = { type: 'skill', evaluation: { type: 'predicate' } }
  assert.deepEqual(skillGaps(base('The result is true when every test passes.'), predicate), ['does not say when the result is true and when it is false'])
  assert.deepEqual(skillGaps(base('The result is true when every test passes, false otherwise.'), predicate), [])
  const score: WorkflowNode = { type: 'skill', evaluation: { type: 'score' } }
  assert.deepEqual(skillGaps(base('Give a result for completeness.'), score), ['does not explain what scores from 0 to 1 mean'])
  assert.deepEqual(skillGaps(base('The result is 1.0 when complete, 0.5 when half is missing.'), score), [])
  assert.ok(skillGaps(`# Step\n\n${filler(160)}\n\n1. Do it.\n\n**Definition of done**\n\n{"files": []}\n`, score).includes('never names the "result" it must return'))
})

test('placeholders are named, frontmatter is ignored and Portuguese sections count', () => {
  assert.deepEqual(skillGaps(PLACEHOLDER_SKILL, {}), ['it is still the placeholder text'])
  assert.deepEqual(skillGaps(`---\nname: x\n---\n${PLACEHOLDER_SKILL}`, {}), ['it is still the placeholder text'])
  const portuguese = `# Revisar\n\n## Objetivo\n\n${filler(160)}\n\n## Procedimento\n\n1. Ler o rascunho.\n2. Comparar com o checklist.\n\n## Critérios de qualidade\n\n- Cada item tem evidência.\n\n## Saída\n\n\`\`\`json\n{"review_file": "review.md"}\n\`\`\`\n`
  assert.deepEqual(skillGaps(portuguese, {}), [])
})

let server: Awaited<ReturnType<typeof startServer>>
before(async () => { freshDataDir(); server = await startServer() })
after(() => server.close())

test('upsert_node and validate_project report a shallow Skill without blocking export', async () => {
  await server.call('POST', '/api/projects', { id: 'shallow', name: 'Shallow' })
  const reply = upsertNode('shallow', 'review', { label: 'Review', skill_markdown: '# Review\n\nReview the draft and return approved or changes.\n', evaluation: { type: 'choice', options: ['approved', 'changes'] } }) as { warnings: string[] }
  const warning = reply.warnings.find(item => item.startsWith('Node review: shallow Skill (skills/review/SKILL.md): only '))
  assert.ok(warning, reply.warnings.join('\n'))
  upsertNode('shallow', 'done', { terminal: true })
  const check = validateProject('shallow')
  assert.ok(check.warnings.some(item => item.startsWith('Node review: shallow Skill')))
  assert.equal(check.ready, true, 'a shallow Skill is a warning, not an export blocker')
})
