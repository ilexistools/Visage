import { useEffect, useState } from 'react'
import Editor from '@monaco-editor/react'
import { CircleCheckBig, CircleX, FlaskConical, Play, Save } from 'lucide-react'
import { api, post, put } from './api'

type ScenarioResult = { name: string; passed: boolean; status: string; path: string[]; final?: string; error?: string; mismatches: string[] }
type TestRun = { total: number; passed: number; failed: number; results: ScenarioResult[] }

/**
 * Scenarios script each step's result and check the path the workflow takes. They are simulated
 * by the server with the exported runner's logic, so no agent runs and results are instant.
 */
export function TestsPanel({ projectId, labels, onClose, onHighlight, onSaved }: {
  projectId: string
  labels: Record<string, string>
  onClose: () => void
  onHighlight: (path: string[]) => void
  onSaved: () => void
}) {
  const [source, setSource] = useState('')
  const [saved, setSaved] = useState(true)
  const [busy, setBusy] = useState(false)
  const [run, setRun] = useState<TestRun | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<number | null>(null)

  useEffect(() => {
    api<{ source: string; saved: boolean }>(`/projects/${projectId}/scenarios`)
      .then(result => { setSource(result.source); setSaved(result.saved) })
      .catch(reason => setError(reason.message))
    return () => onHighlight([])
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true)
    try { await put(`/projects/${projectId}/files/scenarios.yaml`, { content: source }); setSaved(true); onSaved() } catch (reason) { setError((reason as Error).message) } finally { setBusy(false) }
  }
  const runTests = async () => {
    setBusy(true); setError(''); setSelected(null); onHighlight([])
    try { setRun(await post<TestRun>(`/projects/${projectId}/test`, { source })) } catch (reason) { setRun(null); setError((reason as Error).message) } finally { setBusy(false) }
  }
  const select = (index: number) => {
    const next = selected === index ? null : index
    setSelected(next)
    onHighlight(next === null ? [] : run?.results[next]?.path ?? [])
  }
  const name = (id: string) => labels[id] || id

  return <section className="skill-editor-drawer tests-drawer" aria-label="Workflow tests">
    <header className="skill-editor-header">
      <div><span className="eyebrow">TESTS · scenarios.yaml</span><h2>Workflow scenarios</h2></div>
      <div className="skill-editor-header-actions">
        <button className="button" onClick={save} disabled={busy || saved}><Save size={14} />Save</button>
        <button className="button primary" onClick={runTests} disabled={busy}><Play size={14} />Run</button>
        <button className="icon-plain" aria-label="Close tests" title="Close" onClick={onClose}>×</button>
      </div>
    </header>
    <p className="tests-intro">Script the result of each step and the path you expect. Runs are simulated with the same rules as the exported plugin, without any agent.</p>
    <div className="tests-editor"><Editor height="100%" language="yaml" theme="vs-light" value={source} onChange={value => { setSource(value || ''); setSaved(false) }} options={{ minimap: { enabled: false }, fontSize: 12.5, scrollBeyondLastLine: false, tabSize: 2, wordWrap: 'on' }} /></div>
    <div className="tests-results" aria-live="polite">
      {error && <p className="tests-error">{error}</p>}
      {!run && !error && <p className="helper"><FlaskConical size={13} /> Run the scenarios to see which pass.</p>}
      {run && <>
        <div className={`tests-summary ${run.failed ? 'failing' : 'passing'}`}>{run.total ? `${run.passed} of ${run.total} scenario${run.total === 1 ? '' : 's'} passed` : 'No scenarios yet'}</div>
        <ul className="tests-list">{run.results.map((result, index) => <li key={`${result.name}-${index}`} className={`${result.passed ? 'passed' : 'failed'} ${selected === index ? 'selected' : ''}`}>
          <button type="button" onClick={() => select(index)} title="Show this path on the canvas">
            {result.passed ? <CircleCheckBig size={15} /> : <CircleX size={15} />}
            <span className="test-name">{result.name}</span>
            <span className="test-status">{result.status}</span>
          </button>
          <div className="test-path">{result.path.map((node, step) => <span key={step}>{name(node)}</span>)}</div>
          {result.error && result.passed && <p className="helper">{result.error}</p>}
          {result.mismatches.map(mismatch => <p key={mismatch} className="test-mismatch">{mismatch}</p>)}
        </li>)}</ul>
      </>}
    </div>
    <footer className="skill-editor-footer"><span className={saved ? 'saved' : 'unsaved'}>{saved ? 'Saved in the project' : 'Unsaved changes. Run uses the text above'}</span></footer>
  </section>
}
