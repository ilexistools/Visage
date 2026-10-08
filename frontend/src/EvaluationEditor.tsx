import { useEffect, useRef, useState } from 'react'
import { CircleCheck, Gauge, ListChecks, Minus, Plus, X } from 'lucide-react'
import {
  conditionToWhen, DEFAULT_OPTIONS, dropOption, EVALUATION_KINDS, exampleOutput, orderArcs, parseCondition, renameOption, resetResultConditions,
  SCORE_OPERATORS, uncovered, type ArcCondition, type Evaluation, type EvaluationType, type ScoreOperator, type Transition,
} from './evaluation'

type NodeLike = {
  label?: string
  evaluation?: Evaluation
  next?: Transition[]
  max_attempts?: number
  on_fail?: string
  output_schema?: unknown
  checks?: unknown
}
type Patch = Partial<NodeLike>

const ICONS = { none: Minus, predicate: CircleCheck, choice: ListChecks, score: Gauge }

let counter = 0
const nextKey = () => `o${++counter}`

/** Editable list of choice options; arcs follow renamed options. */
function ChoiceOptions({ evaluation, next, onChange }: { evaluation: Evaluation; next: Transition[]; onChange: (patch: Patch) => void }) {
  const toRows = (options: string[]) => options.map(text => ({ key: nextKey(), text, saved: text }))
  const [rows, setRows] = useState(() => toRows(evaluation.options ?? []))
  const lastCommitted = useRef(JSON.stringify(evaluation.options ?? []))
  useEffect(() => {
    const current = JSON.stringify(evaluation.options ?? [])
    if (current !== lastCommitted.current) { lastCommitted.current = current; setRows(toRows(evaluation.options ?? [])) }
  }, [evaluation.options])

  const valid = (list: typeof rows) => list.map(row => row.text.trim()).filter(Boolean)
  const duplicates = (list: typeof rows) => valid(list).filter((text, index, all) => all.indexOf(text) !== index)
  const commit = (list: typeof rows) => {
    setRows(list)
    const options = valid(list)
    if (options.length < 2 || duplicates(list).length) return
    let arcs = next
    const kept = new Set(options)
    for (const row of list) if (row.saved && row.text.trim() && row.saved !== row.text.trim() && !kept.has(row.saved)) arcs = renameOption(arcs, row.saved, row.text.trim())
    for (const previous of evaluation.options ?? []) if (!kept.has(previous) && !list.some(row => row.saved === previous)) arcs = dropOption(arcs, previous)
    if (arcs !== next) arcs = orderArcs(arcs, { ...evaluation, options })
    lastCommitted.current = JSON.stringify(options)
    onChange({ evaluation: { ...evaluation, options }, next: arcs })
    setRows(list.map(row => ({ ...row, saved: row.text.trim() || row.saved })))
  }
  const dupes = new Set(duplicates(rows))
  return <div className="eval-block">
    {rows.map(row => <div className="eval-card-row" key={row.key}>
      <input aria-label="Option" placeholder="option" value={row.text} className={dupes.has(row.text.trim()) ? 'invalid' : ''} onChange={event => commit(rows.map(item => item.key === row.key ? { ...item, text: event.target.value } : item))} />
      <button type="button" className="icon-plain" aria-label={`Remove option ${row.text}`} title="Remove option" disabled={!!row.text.trim() && valid(rows).length <= 2} onClick={() => commit(rows.filter(item => item.key !== row.key))}><X size={13} /></button>
    </div>)}
    {valid(rows).length < 2 && <p className="helper field-error">A choice needs at least two options.</p>}
    {!!dupes.size && <p className="helper field-error">Each option must be different.</p>}
    <div className="eval-actions"><button type="button" className="button eval-add" onClick={() => setRows([...rows, { key: nextKey(), text: '', saved: '' }])}><Plus size={13} />Add option</button></div>
  </div>
}

export function EvaluationEditor({ node, nodeId, nodes, onChange }: { node: NodeLike; nodeId: string; nodes: Record<string, { label?: string }>; onChange: (patch: Patch) => void }) {
  const evaluation = node.evaluation
  const kind = EVALUATION_KINDS.find(item => item.value === evaluation?.type)
  const legacy = node.output_schema !== undefined || node.checks !== undefined
  const next = node.next ?? []

  const chooseType = (type: EvaluationType | 'none') => {
    if (type === (evaluation?.type ?? 'none')) return
    const arcs = resetResultConditions(next)
    if (type === 'none') return onChange({ evaluation: undefined, next: arcs })
    const question = evaluation?.question
    onChange({ evaluation: { type, ...(question ? { question } : {}), ...(type === 'choice' ? { options: DEFAULT_OPTIONS } : {}) }, next: arcs, output_schema: undefined, checks: undefined })
  }

  return <fieldset className="field evaluation-field"><legend>Evaluation</legend>
    <p className="helper eval-intro">What this step decides for the workflow. Files and other outputs are free; the next step is chosen from the result.</p>
    <div className="eval-types" role="radiogroup" aria-label="Evaluation type">
      {([{ value: 'none', label: 'None', summary: 'Always continue' }, ...EVALUATION_KINDS] as const).map(item => {
        const Icon = ICONS[item.value]
        const checked = (evaluation?.type ?? 'none') === item.value
        return <button type="button" role="radio" aria-checked={checked} key={item.value} className={checked ? 'active' : ''} onClick={() => chooseType(item.value)}>
          <Icon size={15} /><strong>{item.label}</strong><span>{item.summary}</span>
        </button>
      })}
    </div>
    {legacy && <div className="eval-legacy"><p className="helper">This step still has an old output schema or checks, which are no longer used.</p><button type="button" className="link-button" onClick={() => onChange({ output_schema: undefined, checks: undefined })}>Remove them</button></div>}
    {evaluation && kind && <>
      <label className="eval-mini"><span>Question the step answers</span>
        <textarea rows={2} placeholder={kind.question} value={evaluation.question ?? ''} onChange={event => onChange({ evaluation: { ...evaluation, question: event.target.value || undefined } })} />
      </label>
      {evaluation.type === 'choice' && <><h3 className="eval-heading">Options</h3><ChoiceOptions evaluation={evaluation} next={next} onChange={onChange} /></>}
      <div className="eval-mini"><span>The step returns</span><code className="eval-example">{exampleOutput(evaluation)}</code></div>
      <h3 className="eval-heading">If the result is invalid</h3>
      <div className="eval-pair eval-failure">
        <label>Try up to<span className="eval-inline"><input type="number" min={1} max={20} value={node.max_attempts || 1} onChange={event => onChange({ max_attempts: Math.min(20, Math.max(1, Number(event.target.value) || 1)) })} />times</span></label>
        <label>Then<select value={node.on_fail || ''} onChange={event => onChange({ on_fail: event.target.value || undefined })}><option value="">Stop the run</option>{Object.entries(nodes).filter(([id]) => id !== nodeId).map(([id, other]) => <option key={id} value={id}>Go to {other.label || id}</option>)}</select></label>
      </div>
      <p className="helper">A retry tells the agent what was wrong with its result.</p>
    </>}
  </fieldset>
}

/** Outgoing arcs of a step, each routed on the step result. */
export function ArcConditions({ node, nodes, onChange }: { node: NodeLike; nodes: Record<string, { label?: string }>; onChange: (next: Transition[]) => void }) {
  const evaluation = node.evaluation
  const next = node.next ?? []
  // The arc whose custom condition is being typed keeps its text input until it loses focus.
  const [editingCustom, setEditingCustom] = useState<number | null>(null)
  if (!next.length) return <p className="helper">This step has no outgoing arcs. Drag from a connection point to another step.</p>
  const update = (index: number, patch: Partial<Transition>, reorder = false) => {
    const updated = next.map((transition, position) => {
      if (position !== index) return transition
      const merged = { ...transition, ...patch }
      if (merged.when === undefined) delete merged.when
      return merged
    })
    onChange(reorder ? orderArcs(updated, evaluation) : updated)
  }
  const setCondition = (index: number, condition: ArcCondition) => update(index, { when: conditionToWhen(condition) }, true)
  const missing = uncovered(next, evaluation)

  const conditionControl = (transition: Transition, index: number) => {
    const condition = parseCondition(transition.when, evaluation)
    if (condition.kind === 'custom' || editingCustom === index) {
      return <div className="eval-card-row">
        <input className="code-input" aria-label="Custom condition" value={transition.when ?? ''} onFocus={() => setEditingCustom(index)} onBlur={() => { setEditingCustom(null); onChange(orderArcs(next, evaluation)) }} onChange={event => update(index, { when: event.target.value || undefined })} />
        <button type="button" className="link-button" onClick={() => setCondition(index, { kind: 'otherwise' })}>Reset</button>
      </div>
    }
    if (!evaluation) return <p className="helper arc-always">Always — add an evaluation to choose between arcs.</p>
    if (evaluation.type === 'score') {
      const operator = condition.kind === 'score' ? condition.operator : 'otherwise'
      return <div className="eval-pair">
        <select aria-label="When" value={operator} onChange={event => setCondition(index, event.target.value === 'otherwise' ? { kind: 'otherwise' } : { kind: 'score', operator: event.target.value as ScoreOperator, threshold: condition.kind === 'score' ? condition.threshold : 0.8 })}>
          <option value="otherwise">Otherwise</option>
          {SCORE_OPERATORS.map(item => <option key={item.value} value={item.value}>Score {item.label}</option>)}
        </select>
        {condition.kind === 'score' && <input type="number" aria-label="Threshold" min={0} max={1} step={0.05} value={condition.threshold}
          onChange={event => update(index, { when: conditionToWhen({ ...condition, threshold: Math.min(1, Math.max(0, Number(event.target.value) || 0)) }) })}
          onBlur={() => onChange(orderArcs(next, evaluation))} />}
      </div>
    }
    const values: { value: string; label: string }[] = evaluation.type === 'predicate'
      ? [{ value: 'true', label: 'If yes (true)' }, { value: 'false', label: 'If no (false)' }]
      : (evaluation.options ?? []).map(option => ({ value: JSON.stringify(option), label: `If ${option}` }))
    const current = condition.kind === 'is' ? JSON.stringify(condition.value) : 'otherwise'
    return <select aria-label="When" value={current} onChange={event => setCondition(index, event.target.value === 'otherwise' ? { kind: 'otherwise' } : { kind: 'is', value: JSON.parse(event.target.value) })}>
      {values.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      <option value="otherwise">Otherwise</option>
    </select>
  }

  return <div className="eval-block">
    {next.map((transition, index) => <div className="eval-card" key={`${transition.goto}-${index}`}>
      <span className="arc-target">→ {nodes[transition.goto]?.label || transition.goto}</span>
      {conditionControl(transition, index)}
      <input aria-label={`Arc text to ${nodes[transition.goto]?.label || transition.goto}`} placeholder="Label on the canvas (optional)" value={transition.label || ''} onChange={event => update(index, { label: event.target.value || undefined })} />
    </div>)}
    {!!missing.length && <p className="helper field-error">No arc for {missing.join(', ')}. Add an arc or set one to “Otherwise”.</p>}
  </div>
}
