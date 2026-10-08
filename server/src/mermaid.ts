/**
 * Render a workflow as a Mermaid flowchart for READMEs, pull requests and docs.
 * Flowcharts render reliably on GitHub, unlike state diagrams with notes.
 */
import type { Evaluation, Workflow } from './engine.ts'

const RESULT = /^\s*output\.result\s*(==|>=|<=|>|<)\s*(.+?)\s*$/
const SYMBOLS: Record<string, string> = { '>=': '≥', '>': '>', '<=': '≤', '<': '<' }
const MAX_QUESTION = 48

/** Text inside quoted Mermaid labels: no raw quotes, pipes, angle brackets or line breaks. */
const ENTITIES: Record<string, string> = { '"': '#quot;', '|': '#124;', '<': '#lt;', '>': '#gt;' }
const escape = (text: string) => text.replace(/\r?\n/g, ' ').replace(/["|<>]/g, char => ENTITIES[char]).trim()

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
  // Prefixed IDs avoid Mermaid keywords such as `end` and characters such as `-`.
  const ids = new Map<string, string>()
  for (const id of Object.keys(workflow.nodes)) {
    let safe = `n_${id.replace(/[^A-Za-z0-9_]/g, '_')}`
    while ([...ids.values()].includes(safe)) safe += '_'
    ids.set(id, safe)
  }
  const lines = ['flowchart LR']
  // Steps first, starting from the start node, so the layout reads left to right.
  const order = [workflow.start, ...Object.keys(workflow.nodes).filter(id => id !== workflow.start)].filter(id => Object.hasOwn(workflow.nodes, id))
  for (const id of order) {
    const node = workflow.nodes[id]
    const label = escape(node.label || id)
    const question = node.evaluation?.question?.trim()
    const shortQuestion = question && question.length > MAX_QUESTION ? `${question.slice(0, MAX_QUESTION - 1).trimEnd()}…` : question
    if (node.terminal) lines.push(`  ${ids.get(id)}(["${label}"])`)
    else if (node.evaluation) lines.push(`  ${ids.get(id)}{"${label}${shortQuestion ? `<br/>${escape(shortQuestion)}` : ''}"}`)
    else lines.push(`  ${ids.get(id)}["${label}"]`)
  }
  for (const id of order) {
    const node = workflow.nodes[id]
    if (node.terminal) continue
    for (const transition of node.next ?? []) {
      if (!ids.has(transition.goto)) continue
      const text = arcText(transition.when, transition.label, node.evaluation)
      lines.push(`  ${ids.get(id)} -->${text ? `|"${escape(text)}"|` : ''} ${ids.get(transition.goto)}`)
    }
    if (node.on_fail && ids.has(node.on_fail)) lines.push(`  ${ids.get(id)} -.->|"invalid result"| ${ids.get(node.on_fail)}`)
  }
  return lines.join('\n') + '\n'
}
