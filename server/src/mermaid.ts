/** Render a workflow as a Mermaid state diagram for READMEs, pull requests and docs. */
import type { Evaluation, Workflow } from './engine.ts'

const RESULT = /^\s*output\.result\s*(==|>=|<=|>|<)\s*(.+?)\s*$/
const SYMBOLS: Record<string, string> = { '>=': '≥', '>': '>', '<=': '≤', '<': '<' }

/** Mermaid text cannot hold raw quotes, semicolons, colons in labels or line breaks. */
const ENTITIES: Record<string, string> = { '"': '#quot;', ';': '#59;', ':': '#58;' }
const escape = (text: string) => text.replace(/\r?\n/g, ' ').replace(/[";:]/g, char => ENTITIES[char]).trim()

/** The arc text: its label, or the result it routes on. */
function arcText(when: string | undefined, label: string | undefined, evaluation: Evaluation | undefined): string {
  if (label) return label
  if (!when) return evaluation ? 'otherwise' : ''
  const match = RESULT.exec(when)
  if (!match || !evaluation) return when
  let value: unknown
  try { value = JSON.parse(match[2].replace(/^'(.*)'$/, (_, body: string) => JSON.stringify(body))) } catch { return when }
  if (match[1] === '==' && typeof value === 'boolean') return value ? 'yes' : 'no'
  if (match[1] === '==' && typeof value === 'string') return value
  if (match[1] !== '==' && typeof value === 'number') return `${SYMBOLS[match[1]]} ${value}`
  return when
}

export function workflowToMermaid(workflow: Workflow): string {
  // Mermaid state IDs allow letters, digits and underscores only.
  const ids = new Map<string, string>()
  for (const id of Object.keys(workflow.nodes)) {
    let safe = id.replace(/[^A-Za-z0-9_]/g, '_')
    if (/^\d/.test(safe)) safe = `s_${safe}`
    while ([...ids.values()].includes(safe)) safe += '_'
    ids.set(id, safe)
  }
  const lines = ['stateDiagram-v2', '  direction LR']
  for (const [id, node] of Object.entries(workflow.nodes)) lines.push(`  state "${escape(node.label || id)}" as ${ids.get(id)}`)
  if (Object.hasOwn(workflow.nodes, workflow.start)) lines.push(`  [*] --> ${ids.get(workflow.start)}`)
  for (const [id, node] of Object.entries(workflow.nodes)) {
    if (node.terminal) { lines.push(`  ${ids.get(id)} --> [*]`); continue }
    for (const transition of node.next ?? []) {
      if (!ids.has(transition.goto)) continue
      const text = arcText(transition.when, transition.label, node.evaluation)
      lines.push(`  ${ids.get(id)} --> ${ids.get(transition.goto)}${text ? ` : ${escape(text)}` : ''}`)
    }
    if (node.on_fail && ids.has(node.on_fail)) lines.push(`  ${ids.get(id)} --> ${ids.get(node.on_fail)} : invalid result`)
    if (node.evaluation?.question) lines.push(`  note right of ${ids.get(id)} : ${escape(node.evaluation.question)}`)
  }
  return lines.join('\n') + '\n'
}
