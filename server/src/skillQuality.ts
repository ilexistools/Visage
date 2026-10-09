/**
 * Heuristic checks that a step's Skill is a real procedure and not a one-line prompt.
 *
 * They only produce warnings: validation names what is missing so the author (often an agent
 * building the workflow through MCP) can complete the Skill before exporting it.
 */
import type { WorkflowNode } from './engine.ts'

/** The text a Skill gets when it is opened before anyone wrote it. */
export const PLACEHOLDER_SKILL = '# Step\n\nAdd instructions for this step.\n'

export const MIN_SKILL_WORDS = 150

const stripFrontmatter = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '')
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Words that name a quality or completion section, in the languages Skills are usually written in. */
const CRITERIA = /criteri|crit[ée]rio|quality|qualidade|calidad|definition of done|\bdone\b|pronto|checklist|accept|aceit|verif|standard|padr[ãa]o|requirement|requisito/i
/** A heading or a bold label line. */
const LABELS = /^\s*(?:#{1,6}\s+(.+)|\*\*([^*]+)\*\*)/gm

/** What a Skill lacks, as short phrases; empty when it looks complete. */
export function skillGaps(markdown: string, node: WorkflowNode): string[] {
  const text = stripFrontmatter(markdown)
  if (text.trim() === PLACEHOLDER_SKILL.trim()) return ['it is still the placeholder text']
  const gaps: string[] = []
  const words = text.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length
  if (words < MIN_SKILL_WORDS) gaps.push(`only ${words} words (aim for ${MIN_SKILL_WORDS} or more)`)
  if (!/^\s*\d+[.)]\s+\S/m.test(text)) gaps.push('no numbered procedure')
  const labels = [...text.matchAll(LABELS)].map(match => match[1] ?? match[2])
  if (!labels.some(label => CRITERIA.test(label))) gaps.push('no section with quality criteria or a definition of done')
  if (!/```json|\{\s*"[^"\n]+"\s*:/.test(text)) gaps.push('no example of the JSON it returns')

  const evaluation = node.evaluation
  if (evaluation) {
    const lower = text.toLowerCase()
    if (!/\bresult\b/.test(lower)) gaps.push('never names the "result" it must return')
    if (evaluation.type === 'predicate' && !(/\btrue\b/.test(lower) && /\bfalse\b/.test(lower))) gaps.push('does not say when the result is true and when it is false')
    if (evaluation.type === 'choice') {
      const missing = (evaluation.options ?? []).filter(option => !new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(option.toLowerCase())}($|[^\\p{L}\\p{N}_])`, 'u').test(lower))
      if (missing.length) gaps.push(`never says when the result is ${missing.map(option => `"${option}"`).join(', ')}`)
    }
    // Anchors such as 0.8, 1.0 or "0 to 1" outside the JSON example.
    const prose = text.replace(/```json[\s\S]*?```/g, '')
    if (evaluation.type === 'score' && !/(^|[^\d])0?\.\d+|\b1\.0\b|\b0\s*(?:to|-|–|a|até)\s*1\b/.test(prose)) gaps.push('does not explain what scores from 0 to 1 mean')
  }
  return gaps
}
