/**
 * Step evaluation: every evaluated step returns {"result": ..., "reason": "..."} where result is
 * true/false (predicate), one option (choice) or a number from 0 to 1 (score). Arcs route on it.
 */

export type EvaluationType = 'predicate' | 'choice' | 'score'
export type Evaluation = { type: EvaluationType; question?: string; options?: string[] }
export type Transition = { goto: string; when?: string; label?: string; [key: string]: unknown }

export const EVALUATION_KINDS: { value: EvaluationType; label: string; summary: string }[] = [
  { value: 'predicate', label: 'Predicate', summary: 'Yes or no' },
  { value: 'choice', label: 'Choice', summary: 'One option from a list' },
  { value: 'score', label: 'Score', summary: 'A rate from 0 to 1' },
]

// --- Arc conditions -------------------------------------------------------------

export type ScoreOperator = '>=' | '>' | '<=' | '<'
export type ArcCondition =
  | { kind: 'otherwise' }
  | { kind: 'is'; value: boolean | string }
  | { kind: 'score'; operator: ScoreOperator; threshold: number }
  | { kind: 'custom'; when: string }

export const SCORE_OPERATORS: { value: ScoreOperator; label: string; symbol: string }[] = [
  { value: '>=', label: 'at least', symbol: '≥' },
  { value: '>', label: 'more than', symbol: '>' },
  { value: '<=', label: 'at most', symbol: '≤' },
  { value: '<', label: 'less than', symbol: '<' },
]

const RESULT = /^\s*output\.result\s*(==|>=|<=|>|<)\s*(.+?)\s*$/

function literal(raw: string): unknown {
  try { return JSON.parse(raw.replace(/^'(.*)'$/, (_, body: string) => JSON.stringify(body))) } catch { return undefined }
}

/** Read an arc's `when` as a condition for the step's evaluation type. */
export function parseCondition(when: string | undefined, evaluation?: Evaluation): ArcCondition {
  if (when === undefined || !when.trim()) return { kind: 'otherwise' }
  const match = RESULT.exec(when)
  if (!match || !evaluation) return { kind: 'custom', when }
  const [, operator, raw] = match
  const value = literal(raw)
  if (evaluation.type === 'predicate' && operator === '==' && typeof value === 'boolean') return { kind: 'is', value }
  if (evaluation.type === 'choice' && operator === '==' && typeof value === 'string' && evaluation.options?.includes(value)) return { kind: 'is', value }
  if (evaluation.type === 'score' && operator !== '==' && typeof value === 'number') return { kind: 'score', operator: operator as ScoreOperator, threshold: value }
  return { kind: 'custom', when }
}

export function conditionToWhen(condition: ArcCondition): string | undefined {
  if (condition.kind === 'otherwise') return undefined
  if (condition.kind === 'custom') return condition.when
  if (condition.kind === 'is') return `output.result == ${JSON.stringify(condition.value)}`
  return `output.result ${condition.operator} ${condition.threshold}`
}

/** Short text for an arc, shown on the canvas when the arc has no label. */
export function conditionSummary(when: string | undefined, evaluation?: Evaluation): string {
  const condition = parseCondition(when, evaluation)
  if (condition.kind === 'otherwise') return evaluation ? 'otherwise' : ''
  if (condition.kind === 'custom') return condition.when
  if (condition.kind === 'is') return typeof condition.value === 'boolean' ? (condition.value ? 'yes' : 'no') : condition.value
  return `${SCORE_OPERATORS.find(item => item.value === condition.operator)!.symbol} ${condition.threshold}`
}

/**
 * Order arcs so routing does what the conditions say: conditional arcs first (scores from the
 * strictest threshold down), the "otherwise" arc last.
 */
export function orderArcs<T extends Transition>(next: T[], evaluation?: Evaluation): T[] {
  const rank = (transition: T) => {
    const condition = parseCondition(transition.when, evaluation)
    if (condition.kind === 'otherwise') return [2, 0]
    if (condition.kind === 'score') return condition.operator.startsWith('>') ? [0, -condition.threshold] : [1, condition.threshold]
    return [0, 0]
  }
  return next.map((transition, index) => ({ transition, index, rank: rank(transition) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.index - b.index)
    .map(item => item.transition)
}

/** Drop result conditions when the evaluation type changes; other conditions are kept. */
export const resetResultConditions = <T extends Transition>(next: T[]): T[] =>
  next.map(transition => {
    if (!transition.when || !RESULT.test(transition.when)) return transition
    const { when: _when, ...rest } = transition
    return rest as T
  })

/** Arcs routed on a removed choice option fall back to "otherwise". */
export const dropOption = <T extends Transition>(next: T[], option: string): T[] =>
  next.map(transition => {
    if (transition.when !== `output.result == ${JSON.stringify(option)}`) return transition
    const { when: _when, ...rest } = transition
    return rest as T
  })

/** Follow a renamed choice option in the arcs that route on it. */
export function renameOption<T extends Transition>(next: T[], from: string, to: string): T[] {
  const old = `output.result == ${JSON.stringify(from)}`
  return next.map(transition => transition.when === old ? { ...transition, when: `output.result == ${JSON.stringify(to)}` } : transition)
}

/** Results that no arc handles: missing yes/no or options, or scores in a gap between thresholds. */
export function uncovered(next: Transition[], evaluation?: Evaluation): string[] {
  if (!evaluation || !next.length) return []
  const conditions = next.map(transition => parseCondition(transition.when, evaluation))
  if (conditions.some(condition => condition.kind === 'otherwise' || condition.kind === 'custom')) return []
  if (evaluation.type === 'predicate') return [true, false].filter(value => !conditions.some(c => c.kind === 'is' && c.value === value)).map(value => value ? 'yes' : 'no')
  if (evaluation.type === 'choice') return (evaluation.options ?? []).filter(option => !conditions.some(c => c.kind === 'is' && c.value === option))
  const passes = (score: number) => conditions.some(c => c.kind === 'score' && ({ '>=': score >= c.threshold, '>': score > c.threshold, '<=': score <= c.threshold, '<': score < c.threshold })[c.operator])
  const missing = Array.from({ length: 101 }, (_, index) => index / 100).filter(score => !passes(score))
  return missing.length ? [`scores such as ${missing[Math.floor(missing.length / 2)]}`] : []
}
