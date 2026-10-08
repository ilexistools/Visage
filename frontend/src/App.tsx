import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Background, BaseEdge, ConnectionMode, Controls, EdgeLabelRenderer, getBezierPath, getNodesBounds, getViewportForBounds, getSmoothStepPath, getStraightPath, Handle, MarkerType, Position, ReactFlow, useEdgesState, useNodesState, type Connection, type Edge, type EdgeProps, type Node, type ReactFlowInstance } from '@xyflow/react'
import Editor from '@monaco-editor/react'
import { toPng } from 'html-to-image'
import yaml from 'js-yaml'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { BookOpen, Code2, Ellipsis, Eye, Folder, FolderPlus, GripVertical, CornerDownRight, FileCode2, FileText, FlaskConical, Image as ImageIcon, Magnet, TriangleAlert, Package, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Slash, Spline, SquarePlus, Trash2, Unplug, Upload, Workflow } from 'lucide-react'
import { api, del, post, put } from './api'
import { ArcConditions, EvaluationEditor } from './EvaluationEditor'
import { TestsPanel } from './TestsPanel'
import { conditionSummary } from './evaluation'
import { defaultPosition, edgeId, layoutEdgePorts, parsePortId, PORT_SLOTS, portId, routeCenter, type EdgePorts, type PortSide } from './edgeLayout'

type WorkflowDoc = { version: number; workflow: { id: string; name: string; version: string }; start: string; nodes: Record<string, any> }
type Project = { id: string; name: string; root_path?: string }
type ContextTarget = { kind: 'node'; id: string } | { kind: 'edge'; id: string; source: string; target: string } | null
type ContextMenuState = { x: number; y: number; flowPosition: { x: number; y: number }; target: ContextTarget }

const emptyWorkflow: WorkflowDoc = { version: 1, workflow: { id: '', name: '', version: '0.1.0' }, start: '', nodes: {} }
const defaultNodeLabel = (_type?: string) => 'Step'
const encodedProjectPath = (path: string) => path.split('/').map(encodeURIComponent).join('/')
const encodeFileBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

function InlineText({ value, onCommit, tag = 'span', className = '', title, placeholder = '' }: { value: string; onCommit: (value: string) => void; tag?: 'span' | 'strong'; className?: string; title?: string; placeholder?: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const cancelOnBlur = useRef(false)
  useEffect(() => { if (!editing) setDraft(value) }, [editing, value])
  const Tag = tag
  if (!editing) return <Tag className={`inline-text ${!value && placeholder ? 'placeholder' : ''} ${className}`} title={title} onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); setDraft(value); setEditing(true) }}>{value || placeholder || '\u00a0'}</Tag>
  return <input className={`inline-text-input nodrag nopan ${className}`} aria-label="Edit text" autoFocus value={draft} onChange={event => setDraft(event.target.value)} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onBlur={() => { setEditing(false); if (cancelOnBlur.current) { cancelOnBlur.current = false; setDraft(value) } else if (draft !== value) onCommit(draft) }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { cancelOnBlur.current = true; event.currentTarget.blur() } }} />
}

function FlowNode({ data, selected }: any) {
  const used = new Set<string>(data.usedHandles || [])
  return <div className={`flow-node ${data.kind} ${data.isFinal ? 'final' : ''} ${data.status || ''} ${selected ? 'selected' : ''} ${data.inPath ? 'in-path' : ''}`}>
    {data.isInitial && <svg className="initial-state-arrow" viewBox="0 0 24 30" aria-label="Initial state"><path d="M1 1 L22 15 L1 29 Z" fill="none" stroke="#42536a" strokeWidth={1.5} strokeLinejoin="round" /></svg>}
    {(Object.keys(PORT_SLOTS) as PortSide[]).flatMap(side => PORT_SLOTS[side].map((offset, slot) => <FlowPort key={portId(side, slot)} id={portId(side, slot)} side={side} offset={offset} used={used.has(portId(side, slot))} />))}
    <InlineText tag="strong" className="flow-node-title" value={data.label} onCommit={data.onLabelChange} title={data.label ? `${data.label}\n\nDouble-click to edit label` : 'Double-click to edit label'} />
    <InlineText className="flow-node-description" value={data.description || ''} onCommit={data.onDescriptionChange} title={data.description ? `${data.description}\n\nDouble-click to edit description` : 'Double-click to edit description'} />
  </div>
}
const nodeTypes = { vasm: FlowNode }

function FlowEdge(props: EdgeProps) {
  const data = props.data as { onLabelChange?: (value: string) => void; ports?: EdgePorts; lineStyle?: LineStyle; condition?: string; question?: string } | undefined
  const ends = { sourceX: props.sourceX, sourceY: props.sourceY, sourcePosition: props.sourcePosition, targetX: props.targetX, targetY: props.targetY, targetPosition: props.targetPosition }
  const [path, labelX, labelY] = data?.lineStyle === 'straight' ? getStraightPath(ends)
    : data?.lineStyle === 'curved' ? getBezierPath({ ...ends, curvature: 0.3 })
    : getSmoothStepPath({ ...ends, offset: 18, ...(data?.ports ? routeCenter(data.ports, { x: props.sourceX, y: props.sourceY }, { x: props.targetX, y: props.targetY }) : {}) })
  return <>
    <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} interactionWidth={20} />
    <EdgeLabelRenderer><div className={`editable-arc-label nodrag nopan ${!props.label && !data?.condition && !data?.question ? 'empty-label' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>{data?.question && <span className="arc-question" title={data.question}>{data.question}</span>}<InlineText value={String(props.label || '')} onCommit={data?.onLabelChange || (() => {})} title="Double-click to edit arc text" placeholder={data?.condition || '+'} /></div></EdgeLabelRenderer>
  </>
}
const edgeTypes = { editable: FlowEdge }

type LineStyle = 'curved' | 'straight' | 'step'
const LINE_STYLES: { value: LineStyle; label: string; icon: typeof Spline }[] = [
  { value: 'curved', label: 'Curved lines', icon: Spline },
  { value: 'straight', label: 'Straight lines', icon: Slash },
  { value: 'step', label: 'Orthogonal lines', icon: CornerDownRight },
]
const readLineStyle = (): LineStyle => {
  try { const value = localStorage.getItem('vasm-line-style'); return value === 'curved' || value === 'straight' ? value : 'step' } catch { return 'step' }
}

const portPosition = (side: PortSide) => ({ left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom })[side]

/** A connection point; with ConnectionMode.Loose every point can start or end an arc. */
function FlowPort({ id, side, offset, used }: { id: string; side: PortSide; offset: number; used: boolean }) {
  const style = side === 'left' || side === 'right' ? { top: `${offset}%` } : { left: `${offset}%` }
  return <Handle id={id} type="source" position={portPosition(side)} style={style} className={used ? 'port-used' : ''} />
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [workflow, setWorkflow] = useState<WorkflowDoc>(emptyWorkflow)
  const [source, setSource] = useState('')
  const [dirty, setDirty] = useState(false)
  const [yamlDirty, setYamlDirty] = useState(false)
  const workflowSignatureRef = useRef('')
  const lastWorkflowAutosaveRef = useRef('')
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [skillEditorOpen, setSkillEditorOpen] = useState(false)
  const [skillPreview, setSkillPreview] = useState(false)
  const [skillEditorPath, setSkillEditorPath] = useState('')
  const [skillEditorLabel, setSkillEditorLabel] = useState('')
  const [skillMarkdown, setSkillMarkdown] = useState('')
  const [skillDirty, setSkillDirty] = useState(false)
  const [skillBusy, setSkillBusy] = useState(false)
  const skillSignatureRef = useRef('')
  const lastSkillAutosaveRef = useRef('')
  const importSkillInput = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false)
  const [mobileProjectOpen, setMobileProjectOpen] = useState(false)
  const [explorerWidth, setExplorerWidth] = useState(() => Number(localStorage.getItem('vasm-explorer-width')) || 220)
  const [inspectorWidth, setInspectorWidth] = useState(() => Number(localStorage.getItem('vasm-inspector-width')) || 270)
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false)
  const [dialog, setDialog] = useState<{ kind: 'project' | 'rename' | 'delete'; projectId?: string } | null>(null)
  const [dialogName, setDialogName] = useState('')
  const [projectParentPath, setProjectParentPath] = useState('')
  const [folderPickerBusy, setFolderPickerBusy] = useState(false)
  const [projectMenuId, setProjectMenuId] = useState('')
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const workflowSignature = JSON.stringify([projectId, workflow, source, yamlDirty])
  workflowSignatureRef.current = workflowSignature
  const skillSignature = JSON.stringify([projectId, skillEditorPath, skillMarkdown, skillEditorOpen])
  skillSignatureRef.current = skillSignature
  const renderedSkillMarkdown = useMemo(() => DOMPurify.sanitize(marked.parse(skillMarkdown) as string), [skillMarkdown])

  useEffect(() => { localStorage.setItem('vasm-explorer-width', String(explorerWidth)) }, [explorerWidth])
  const [explorerCollapsed, setExplorerCollapsed] = useState(() => { try { return localStorage.getItem('vasm-explorer-collapsed') === '1' } catch { return false } })
  useEffect(() => { try { localStorage.setItem('vasm-explorer-collapsed', explorerCollapsed ? '1' : '0') } catch { /* storage unavailable */ } }, [explorerCollapsed])
  const toggleExplorer = useCallback(() => {
    if (window.matchMedia('(max-width: 600px)').matches) setMobileProjectOpen(open => !open)
    else setExplorerCollapsed(collapsed => !collapsed)
  }, [])
  // Cmd/Ctrl+B shows or hides the Explorer, as in VS Code, except while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'b') return
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], .monaco-editor')) return
      event.preventDefault()
      toggleExplorer()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleExplorer])
  useEffect(() => { localStorage.setItem('vasm-inspector-width', String(inspectorWidth)) }, [inspectorWidth])
  useEffect(() => {
    if (!contextMenu) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setContextMenu(null) }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [contextMenu])
  useEffect(() => {
    if (!projectMenuId) return
    const closeMenu = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest('.project-menu-wrap')) setProjectMenuId('')
    }
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setProjectMenuId('') }
    document.addEventListener('pointerdown', closeMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => { document.removeEventListener('pointerdown', closeMenu); window.removeEventListener('keydown', closeOnEscape) }
  }, [projectMenuId])

  const [lineStyle, setLineStyle] = useState<LineStyle>(readLineStyle)
  useEffect(() => { try { localStorage.setItem('vasm-line-style', lineStyle) } catch { /* storage unavailable */ } }, [lineStyle])
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  useEffect(() => {
    if (!exportMenuOpen) return
    const close = (event: MouseEvent) => { if (!(event.target as HTMLElement).closest('.export-wrap')) setExportMenuOpen(false) }
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setExportMenuOpen(false) }
    document.addEventListener('pointerdown', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('keydown', closeOnEscape) }
  }, [exportMenuOpen])
  const download = (url: string, filename: string) => {
    const link = document.createElement('a'); link.href = url; link.download = filename
    document.body.appendChild(link); link.click(); link.remove()
    if (url.startsWith('blob:')) window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
  /** Capture the whole flow, not just the visible area, as a PNG with a white margin. */
  const exportImage = async () => {
    setExportMenuOpen(false)
    const flow = document.querySelector<HTMLElement>('.react-flow')
    const viewport = flow?.querySelector<HTMLElement>('.react-flow__viewport')
    if (!flowInstance || !flow || !viewport || !nodes.length) { tell('Add steps to the canvas before exporting an image.'); return }
    const bounds = getNodesBounds(flowInstance.getNodes())
    const margin = 60
    const width = Math.min(6000, Math.ceil(bounds.width + margin * 2))
    const height = Math.min(6000, Math.ceil(bounds.height + margin * 2))
    const { x, y, zoom } = getViewportForBounds(bounds, width, height, 0.2, 1, margin / Math.max(width, height))
    // Hide editing chrome (connection points, selection, empty "+" labels) while capturing.
    flow.classList.add('exporting')
    try {
      const url = await toPng(viewport, { backgroundColor: '#ffffff', width, height, pixelRatio: 2, style: { width: `${width}px`, height: `${height}px`, transform: `translate(${x}px, ${y}px) scale(${zoom})` } })
      download(url, `${projectId || 'workflow'}.png`)
    } catch (error) { tell(`Could not export the image: ${(error as Error).message}`) } finally { flow.classList.remove('exporting') }
  }
  const exportDiagram = async () => {
    setExportMenuOpen(false)
    if (!projectId) return
    if ((dirty || yamlDirty) && !(await saveWorkflow())) return
    try {
      const response = await fetch(`/api/projects/${projectId}/diagram.mmd`)
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || response.statusText)
      download(URL.createObjectURL(await response.blob()), `${projectId}.mmd`)
      setNotice('Mermaid diagram downloaded. Paste it in a ```mermaid block in a README or open it in mermaid.live. Exported plugins include it in their README.')
    } catch (error) { tell(`Could not export the diagram: ${(error as Error).message}`) }
  }
  const exportPlugin = async () => {
    setExportMenuOpen(false)
    if (!projectId) return
    if (!Object.keys(workflow.nodes).length) { tell('Add Skill nodes and a final state before exporting.'); return }
    if ((dirty || yamlDirty) && !(await saveWorkflow())) return
    setBusy(true)
    setNotice('Exporting plugin…')
    try {
      const response = await fetch(`/api/projects/${projectId}/export.zip`)
      if (!response.ok) {
        let message = response.statusText
        try { message = (await response.json()).detail || message } catch { /* no JSON body */ }
        if (response.status === 404 && message === 'Not Found') message = 'The backend does not support export yet. Restart it to load the latest version.'
        throw new Error(`Export failed: ${message}`)
      }
      const filename = /filename="?([^";]+)"?/.exec(response.headers.get('content-disposition') || '')?.[1] || `${projectId}.zip`
      download(URL.createObjectURL(await response.blob()), filename)
      setNotice(`Plugin exported to the project's dist/ folder and downloaded as ${filename}.`)
    } catch (e) { tell(e) } finally { setBusy(false) }
  }
  const pendingSaveRef = useRef<null | (() => Promise<boolean>)>(null)
  const [testsOpen, setTestsOpen] = useState(false)
  // Nodes on the path of the scenario selected in the Tests panel.
  const [highlightedPath, setHighlightedPath] = useState<string[]>([])
  const [appVersion, setAppVersion] = useState('')
  useEffect(() => { api<{ version?: string }>('/health').then(health => setAppVersion(health.version ?? '')).catch(() => {}) }, [])
  // Validation warnings are listed on demand instead of popping up after every save.
  const [warnings, setWarnings] = useState<string[]>([])
  const [warningsOpen, setWarningsOpen] = useState(false)
  useEffect(() => {
    if (!warningsOpen) return
    const close = (event: MouseEvent) => { if (!(event.target as HTMLElement).closest('.warnings-wrap')) setWarningsOpen(false) }
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setWarningsOpen(false) }
    document.addEventListener('pointerdown', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('keydown', closeOnEscape) }
  }, [warningsOpen])
  const tell = (value: unknown) => setNotice(value instanceof Error ? value.message : String(value))
  const loadProjects = useCallback(async () => { try { setProjects(await api('/projects')) } catch (e) { tell(e) } }, [])
  useEffect(() => { loadProjects() }, [loadProjects])

  const loadProject = useCallback(async (id: string) => {
    // Save pending edits of the current project before switching.
    if (pendingSaveRef.current && !(await pendingSaveRef.current())) return
    try {
      const [result, projectFiles] = await Promise.all([api(`/projects/${id}/workflow`), api(`/projects/${id}/files`)])
      setWorkflow(result.workflow); setSource(result.source); setFiles(projectFiles); setProjectId(id); setSelectedNode(null); setDirty(false); setYamlDirty(false); setMobileProjectOpen(false); setSkillEditorOpen(false); setSkillDirty(false)
      setWarnings(result.warnings ?? []); setWarningsOpen(false); setNotice('')
    } catch (e) { tell(e) }
  }, [])
  useEffect(() => {
    if (projectId || !projects.length) return
    const requested = new URLSearchParams(window.location.search).get('project')
    loadProject(projects.some(project => project.id === requested) ? requested! : projects[0].id)
  }, [projects, projectId, loadProject])


  useEffect(() => {
    const ports = layoutEdgePorts(workflow.nodes)
    const mappedNodes: Node[] = Object.entries(workflow.nodes || {}).map(([id, node], index) => ({
      id, type: 'vasm', position: node.position || defaultPosition(index),
      data: {
        nodeId: id, kind: 'skill', inPath: highlightedPath.includes(id), label: node.label || defaultNodeLabel(node.type), description: node.description || '', skill: node.skill?.path, terminal: node.terminal, isInitial: workflow.start === id, isFinal: !!node.terminal,
        onLabelChange: (label: string) => { setWorkflow(old => ({ ...old, nodes: { ...old.nodes, [id]: { ...old.nodes[id], label } } })); setDirty(true) },
        onDescriptionChange: (description: string) => { setWorkflow(old => ({ ...old, nodes: { ...old.nodes, [id]: { ...old.nodes[id], description } } })); setDirty(true) },
        usedHandles: Object.entries(workflow.nodes || {}).flatMap(([source, sourceNode]) => (sourceNode.terminal ? [] : sourceNode.next || []).flatMap((next: any, index: number) => {
          const port = ports[edgeId(source, next.goto, index)]
          if (!port) return []
          return [...(source === id ? [port.sourceHandle] : []), ...(next.goto === id ? [port.targetHandle] : [])]
        })),
      },
    }))
    const mappedEdges: Edge[] = Object.entries(workflow.nodes || {}).flatMap(([id, node]) => (node.terminal ? [] : node.next || []).flatMap((next: any, index: number) => !ports[edgeId(id, next.goto, index)] ? [] : [{
      id: edgeId(id, next.goto, index), source: id, target: next.goto, sourceHandle: ports[edgeId(id, next.goto, index)].sourceHandle, targetHandle: ports[edgeId(id, next.goto, index)].targetHandle, label: next.label || '', type: 'editable', data: { ports: ports[edgeId(id, next.goto, index)], lineStyle, condition: conditionSummary(next.when, node.evaluation), question: node.evaluation?.question, onLabelChange: (label: string) => { setWorkflow(old => ({ ...old, nodes: { ...old.nodes, [id]: { ...old.nodes[id], next: (old.nodes[id].next || []).map((transition: any, transitionIndex: number) => transitionIndex === index ? { ...transition, label } : transition) } } })); setDirty(true) } },
      markerEnd: { type: MarkerType.Arrow, color: '#667b99', width: 14, height: 14 },
      style: { stroke: '#667b99', strokeWidth: 2.2 }, labelStyle: { fill: '#64748b', fontSize: 11 },
    }]))
    // Keep React Flow's own state: the selection ring, and the position of a node being dragged.
    setNodes(current => mappedNodes.map(node => {
      const live = current.find(item => item.id === node.id)
      return { ...node, selected: node.id === selectedNode, ...(live?.dragging ? { position: live.position, dragging: true } : {}) }
    }))
    setEdges(mappedEdges)
  }, [workflow, lineStyle, selectedNode, highlightedPath, setNodes, setEdges])

  /** Merge a patch into the latest node state; keys set to undefined are removed. */
  const updateNode = (id: string, patch: Record<string, unknown>) => {
    setWorkflow(old => {
      if (!old.nodes[id]) return old
      const node = { ...old.nodes[id], ...patch }
      Object.keys(patch).forEach(key => { if (patch[key] === undefined) delete node[key] })
      return { ...old, nodes: { ...old.nodes, [id]: node } }
    })
    setDirty(true)
  }
  const onMoveEnd = (_: unknown, node: Node) => updateNode(node.id, { position: { x: Math.round(node.position.x), y: Math.round(node.position.y) } })
  const onConnect = (connection: Connection) => {
    if (!connection.source || !connection.target) return
    const current = workflow.nodes[connection.source]
    if (current.terminal) { tell('Final states cannot have outgoing connections.'); return }
    // Keep the points the user connected so the arc stays where it was drawn.
    const pins = {
      ...(parsePortId(connection.sourceHandle) ? { source_handle: connection.sourceHandle } : {}),
      ...(parsePortId(connection.targetHandle) ? { target_handle: connection.targetHandle } : {}),
    }
    updateNode(connection.source, { next: [...(current.next || []), { goto: connection.target, ...pins }] })
  }
  const openContextMenu = (event: MouseEvent | ReactMouseEvent, target: ContextTarget = null) => {
    event.preventDefault(); event.stopPropagation()
    const flowPosition = flowInstance?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) || { x: 0, y: 0 }
    setContextMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 220)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 280)), flowPosition, target })
  }
  const removeNode = (id: string) => {
    setWorkflow(old => {
    const removed = old.nodes[id]
    if (!removed) return old
    const remaining: Record<string, any> = {}
    Object.entries(old.nodes).forEach(([nodeId, node]: [string, any]) => {
      if (nodeId === id) return
      const updated = node.next ? { ...node, next: node.next.filter((transition: any) => transition.goto !== id) } : { ...node }
      if (updated.on_fail === id) delete updated.on_fail
      remaining[nodeId] = updated
    })
    let start = old.start
    if (start === id) start = removed.next?.[0]?.goto || Object.keys(remaining)[0] || ''
    if (!remaining[start]) start = Object.keys(remaining)[0] || ''
    return { ...old, start, nodes: remaining }
    })
    setDirty(true); setSelectedNode(null); setContextMenu(null)
  }
  /** Remove arcs in one update: arc IDs contain their position, so removing one at a time would shift the others. */
  const removeEdges = (removed: { id: string; source: string; target: string }[]) => {
    setWorkflow(old => {
      const nodes = { ...old.nodes }
      for (const source of new Set(removed.map(edge => edge.source))) {
        const transitions = nodes[source]?.next
        if (!transitions) continue
        const ids = new Set(removed.filter(edge => edge.source === source).map(edge => edge.id))
        nodes[source] = { ...nodes[source], next: transitions.filter((transition: any, position: number) => !ids.has(edgeId(source, transition.goto, position))) }
      }
      return { ...old, nodes }
    })
    setDirty(true)
    setContextMenu(null)
  }
  const removeEdge = (id: string, source: string, target: string) => removeEdges([{ id, source, target }])
  const transitionIndex = (id: string, source: string, target: string) =>
    (workflow.nodes[source]?.next || []).findIndex((transition: any, position: number) => edgeId(source, transition.goto, position) === id && transition.goto === target)
  const unpinEdge = (id: string, source: string, target: string) => {
    const index = transitionIndex(id, source, target)
    if (index < 0) return
    updateNode(source, { next: workflow.nodes[source].next.map((transition: any, position: number) => {
      if (position !== index) return transition
      const { source_handle: _source, target_handle: _target, ...rest } = transition
      return rest
    }) })
    setContextMenu(null)
  }
  const edgeIsPinned = (id: string, source: string, target: string) => {
    const transition = workflow.nodes[source]?.next?.[transitionIndex(id, source, target)]
    return !!(transition?.source_handle || transition?.target_handle)
  }
  const setNodeState = (id: string, state: 'normal' | 'initial' | 'final') => {
    setWorkflow(old => {
      const node = { ...old.nodes[id], terminal: state === 'final' }
      // A final state ends the run: it has no arcs, evaluation or failure route.
      if (state === 'final') { delete node.next; delete node.evaluation; delete node.on_fail; delete node.max_attempts }
      else node.next ??= []
      const nextNodes = { ...old.nodes, [id]: node }
      let start = old.start
      if (state === 'initial') start = id
      else if (start === id) start = Object.keys(nextNodes).find(candidate => candidate !== id) || ''
      return { ...old, start, nodes: nextNodes }
    })
    setDirty(true)
  }

  const slug = (value: string) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const uniqueId = (name: string, existing: string[], fallback: string) => {
    const base = slug(name) || fallback
    let candidate = base
    let index = 2
    while (existing.includes(candidate)) candidate = `${base}-${index++}`
    return candidate
  }
  const createProject = () => { setMobileProjectOpen(false); setDialogName(''); setProjectParentPath(''); setDialog({ kind: 'project' }) }
  const chooseProjectFolder = async () => {
    setFolderPickerBusy(true)
    try {
      const result = await api<{ path: string }>('/folder-picker')
      if (result.path) setProjectParentPath(result.path)
    } catch (error) { tell(error) } finally { setFolderPickerBusy(false) }
  }
  const renameProject = (project: Project) => { setDialogName(project.name); setProjectMenuId(''); setDialog({ kind: 'rename', projectId: project.id }) }
  const confirmDeleteProject = (project: Project) => { setProjectMenuId(''); setDialogName(project.name); setDialog({ kind: 'delete', projectId: project.id }) }
  const submitDialog = async () => {
    if (!dialog) return
    if (dialog.kind === 'delete' && dialog.projectId) {
      const id = dialog.projectId
      try {
        await del(`/projects/${id}`)
        const remaining = await api<Project[]>('/projects')
        setProjects(remaining); setDialog(null)
        if (projectId === id) {
          setProjectId(''); setWorkflow(emptyWorkflow); setSource(''); setDirty(false); setYamlDirty(false); setSelectedNode(null); setFiles([])
        }
      } catch (error) { tell(error) }
      return
    }
    const name = dialogName.trim()
    if (!name) { tell('Enter a name to continue.'); return }
    try {
      if (dialog.kind === 'project') {
        const id = uniqueId(name, projects.map(project => project.id), 'project')
        await post('/projects', { id, name, parent_path: projectParentPath }); setDialog(null); await loadProjects(); await loadProject(id)
      } else if (dialog.projectId) {
        await put(`/projects/${dialog.projectId}`, { name }); setDialog(null); await loadProjects()
      }
    } catch (error) { tell(error) }
  }
  const saveWorkflow = async (): Promise<boolean> => {
    if (!projectId) return false
    const snapshotWorkflow = workflow
    const snapshotSource = source
    const snapshotYamlDirty = yamlDirty
    const snapshotSignature = JSON.stringify([projectId, snapshotWorkflow, snapshotSource, snapshotYamlDirty])
    setBusy(true)
    try {
      const text = snapshotYamlDirty ? snapshotSource : yaml.dump(snapshotWorkflow, { noRefs: true, lineWidth: 110 })
      const result = await put(`/projects/${projectId}/workflow`, { source: text })
      if (workflowSignatureRef.current === snapshotSignature) {
        setWorkflow(result.workflow); setSource(text); setDirty(false); setYamlDirty(false)
        setWarnings(result.warnings ?? [])
      }
      return true
    } catch (e) { tell(e); return false } finally { setBusy(false) }
  }
  pendingSaveRef.current = async () => {
    if ((dirty || yamlDirty) && !(await saveWorkflow())) return false
    if (skillDirty && !(await saveSkillMarkdown())) return false
    return true
  }

  useEffect(() => {
    if (!dirty || !projectId || lastWorkflowAutosaveRef.current === workflowSignature) return
    const signature = workflowSignature
    const timer = window.setTimeout(() => {
      if (busy) return
      lastWorkflowAutosaveRef.current = signature
      void saveWorkflow()
    }, 700)
    return () => window.clearTimeout(timer)
  }, [busy, dirty, projectId, workflow, source, yamlDirty])
  const openSkillEditor = async () => {
    const path = selected?.skill?.path
    if (!path || !projectId) { tell('This Skill has no Markdown file configured.'); return }
    try {
      const response = await fetch(`/api/projects/${projectId}/files/${encodedProjectPath(path)}`)
      if (!response.ok) throw new Error((await response.json()).detail || 'Could not load Skill Markdown')
      setSkillEditorPath(path); setSkillEditorLabel(selected.label || 'Skill'); setSkillMarkdown(await response.text()); setSkillDirty(false); setSkillPreview(false); setSkillEditorOpen(true)
    } catch (error) { tell(error) }
  }
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || yamlDirty || skillDirty) event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, yamlDirty, skillDirty])
  const saveSkillMarkdown = async () => {
    if (!projectId || !skillEditorPath) return false
    const snapshot = skillMarkdown
    const snapshotSignature = JSON.stringify([projectId, skillEditorPath, snapshot, skillEditorOpen])
    setSkillBusy(true)
    try {
      await put(`/projects/${projectId}/files/${encodedProjectPath(skillEditorPath)}`, { content: snapshot, encoding: 'utf-8' })
      if (skillSignatureRef.current === snapshotSignature) setSkillDirty(false)
      setFiles(await api(`/projects/${projectId}/files`))
      return true
    } catch (error) { tell(error); return false } finally { setSkillBusy(false) }
  }
  useEffect(() => {
    if (!skillEditorOpen || !skillDirty || !projectId || !skillEditorPath || lastSkillAutosaveRef.current === skillSignature) return
    const signature = skillSignature
    const timer = window.setTimeout(() => {
      if (skillBusy) return
      lastSkillAutosaveRef.current = signature
      void saveSkillMarkdown()
    }, 700)
    return () => window.clearTimeout(timer)
  }, [skillBusy, skillDirty, skillEditorOpen, skillEditorPath, projectId, skillMarkdown])
  // Files imported for the selected step live next to its SKILL.md.
  const selectedSkillPath: string = (selectedNode && workflow.nodes[selectedNode]?.skill?.path) || ''
  const skillDirectory = selectedSkillPath.includes('/') ? selectedSkillPath.slice(0, selectedSkillPath.lastIndexOf('/') + 1) : ''
  const skillResources = skillDirectory ? files.filter(path => path.startsWith(skillDirectory) && path !== selectedSkillPath).sort() : []
  const [confirmingDelete, setConfirmingDelete] = useState('')
  useEffect(() => setConfirmingDelete(''), [selectedNode])
  const deleteResource = async (path: string) => {
    if (!projectId) return
    setSkillBusy(true)
    try {
      await del(`/projects/${projectId}/files/${encodedProjectPath(path)}`)
      setFiles(await api(`/projects/${projectId}/files`))
      setConfirmingDelete('')
    } catch (error) { tell(error) } finally { setSkillBusy(false) }
  }
  const importSkillFiles = async (incoming: FileList | null) => {
    if (!incoming?.length || !projectId || !selected?.skill?.path) return
    const skillDirectory = selected.skill.path.slice(0, selected.skill.path.lastIndexOf('/') + 1)
    const existing = new Set(files)
    setSkillBusy(true)
    try {
      for (const file of Array.from(incoming)) {
        const filename = file.name.split(/[\\/]/).pop()?.trim()
        if (!filename || filename.toLowerCase() === 'skill.md') throw new Error('Imported resources cannot replace the Skill.md file.')
        const dot = filename.lastIndexOf('.')
        const stem = dot > 0 ? filename.slice(0, dot) : filename
        const extension = dot > 0 ? filename.slice(dot) : ''
        let candidate = filename
        let suffix = 2
        while (existing.has(`${skillDirectory}${candidate}`)) candidate = `${stem}-${suffix++}${extension}`
        const path = `${skillDirectory}${candidate}`
        await put(`/projects/${projectId}/files/${encodedProjectPath(path)}`, { content: encodeFileBase64(await file.arrayBuffer()), encoding: 'base64' })
        existing.add(path)
      }
      setFiles(await api(`/projects/${projectId}/files`))
      setNotice(`${incoming.length} file${incoming.length === 1 ? '' : 's'} imported for this Skill`)
    } catch (error) { tell(error) } finally { setSkillBusy(false); if (importSkillInput.current) importSkillInput.current.value = '' }
  }
  const closeSkillEditor = async () => {
    if (skillDirty && !(await saveSkillMarkdown())) return
    setSkillEditorOpen(false)
  }
  const addNode = async (_type: 'skill', position: { x: number; y: number } | null = null) => {
    setContextMenu(null)
    if (!projectId) { tell('Create a project before adding a node.'); return }
    if (busy) return
    const existingLabels = new Set(Object.values(workflow.nodes).map((node: any) => node.label || defaultNodeLabel()))
    let label = 'Step'
    let suffix = 2
    while (existingLabels.has(label)) label = `Step ${suffix++}`
    const id = uniqueId(label, Object.keys(workflow.nodes), 'step')
    const path = `skills/${id}/SKILL.md`
    const node = { type: 'skill', label, position: position || { x: 160 + Object.keys(workflow.nodes).length * 40, y: 180 }, skill: { path }, next: [] }
    setBusy(true)
    try {
      await put(`/projects/${projectId}/files/${encodedProjectPath(path)}`, { content: `# ${label}\n\nDescribe the instructions this Skill should follow.`, encoding: 'utf-8' })
      setWorkflow(old => ({ ...old, start: old.start || id, nodes: { ...old.nodes, [id]: node } }))
      setSelectedNode(id); setMobileInspectorOpen(true); setDirty(true); setFiles(await api(`/projects/${projectId}/files`))
    } catch (error) { tell(error) } finally { setBusy(false) }
  }
  const beginResize = (side: 'left' | 'right', event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const panel = side === 'left' ? 'explorer' : 'inspector'
    const initialWidth = panel === 'explorer' ? explorerWidth : inspectorWidth
    let currentWidth = initialWidth
    const startX = event.clientX
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const move = (pointer: PointerEvent) => {
      const delta = (pointer.clientX - startX) * (side === 'left' ? 1 : -1)
      // currentWidth keeps the unclamped width so dragging far enough collapses the panel.
      currentWidth = initialWidth + delta
      const width = Math.max(160, Math.min(440, currentWidth))
      if (panel === 'explorer') setExplorerWidth(width)
      else setInspectorWidth(width)
    }
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      if (panel === 'explorer') {
        setExplorerWidth(currentWidth < 90 ? initialWidth : Math.max(160, Math.min(440, currentWidth)))
        setExplorerCollapsed(currentWidth < 90)
      } else {
        if (currentWidth < 90) setInspectorWidth(initialWidth)
        setInspectorCollapsed(currentWidth < 90)
      }
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  const selected = selectedNode ? workflow.nodes[selectedNode] : null

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><button className="icon-plain explorer-toggle" aria-label={explorerCollapsed ? 'Show Explorer' : 'Hide Explorer'} aria-pressed={!explorerCollapsed} title={`${explorerCollapsed ? 'Show' : 'Hide'} Explorer (${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'}B)`} onClick={toggleExplorer}>{explorerCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button><div className="brand-mark"><Workflow size={21} /></div><strong>Visage</strong>{appVersion && <span className="app-version" title={`Visage ${appVersion}`}>v{appVersion}</span>}</div>
      <div className="top-actions">{!!warnings.length && <div className="warnings-wrap"><button className="button subtle warnings-button" aria-label={`${warnings.length} workflow warning(s)`} title="Workflow warnings" aria-expanded={warningsOpen} onClick={() => setWarningsOpen(open => !open)}><TriangleAlert size={14} />{warnings.length}</button>{warningsOpen && <div className="warnings-panel" role="dialog" aria-label="Workflow warnings"><span className="eyebrow">WARNINGS</span><ul>{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul><p className="helper">Warnings do not block saving. Fix them before exporting the plugin.</p></div>}</div>}<button className="button subtle icon-button" data-tooltip="Tests" aria-label="Tests" aria-pressed={testsOpen} onClick={async () => { if (!testsOpen && (dirty || yamlDirty) && !(await saveWorkflow())) return; setTestsOpen(open => !open) }} disabled={!projectId}><FlaskConical size={15} /></button><div className="export-wrap"><button className="button subtle icon-button" data-tooltip="Export" aria-label="Export" aria-haspopup="menu" aria-expanded={exportMenuOpen} onClick={() => setExportMenuOpen(open => !open)} disabled={!projectId || busy}><Package size={15} /></button>{exportMenuOpen && <div className="project-menu export-menu" role="menu">
        <button role="menuitem" onClick={exportPlugin}><Package size={14} /><span><strong>Plugin</strong><small>Claude Code and Codex (.zip)</small></span></button>
        <button role="menuitem" onClick={exportImage}><ImageIcon size={14} /><span><strong>Image</strong><small>The flow as shown (.png)</small></span></button>
        <button role="menuitem" onClick={exportDiagram}><FileCode2 size={14} /><span><strong>Diagram</strong><small>Mermaid, for READMEs and docs (.mmd)</small></span></button>
      </div>}</div></div>
    </header>

    <div className="workspace" style={{ '--left-panel-width': `${explorerCollapsed ? 0 : explorerWidth}px`, '--left-resize-width': explorerCollapsed ? '0px' : '7px', '--right-panel-width': `${selected && !inspectorCollapsed ? inspectorWidth : 0}px` } as React.CSSProperties}>
      <aside className={`sidebar dock-left ${mobileProjectOpen ? 'open' : ''} ${explorerCollapsed ? 'collapsed' : ''}`} aria-hidden={explorerCollapsed && !mobileProjectOpen}>
        <div className="sidebar-title">EXPLORER <div className="sidebar-title-actions"><button className="icon-plain" title="New project" onClick={createProject}><Plus size={16} /></button></div></div>
        <div className="sidebar-section"><div className="section-heading"><Folder size={15} /> PROJECTS</div>{projects.map(project => <div className={`project-item-row ${project.id === projectId ? 'active' : ''}`} key={project.id}><button className="tree-item project-select" title={project.root_path || project.name} onClick={() => loadProject(project.id)}><span className="tree-dot" />{project.name}</button><div className="project-menu-wrap"><button className="project-more" aria-label={`Options for ${project.name}`} title="Project options" aria-haspopup="menu" aria-expanded={projectMenuId === project.id} onClick={event => { event.stopPropagation(); setProjectMenuId(value => value === project.id ? '' : project.id) }}><Ellipsis size={17} /></button>{projectMenuId === project.id && <div className="project-menu" role="menu"><button role="menuitem" onClick={() => renameProject(project)}><Pencil size={14} />Rename project</button><button role="menuitem" className="danger" onClick={() => confirmDeleteProject(project)}><Trash2 size={14} />Delete project</button></div>}</div></div>)}{!projects.length && <div className="empty-small">Create a project to begin.</div>}</div>
      </aside>
      {mobileProjectOpen && <div className="mobile-sidebar-backdrop" onClick={() => setMobileProjectOpen(false)} />}

      {!explorerCollapsed && <div className="resize-handle left" role="separator" aria-orientation="vertical" aria-label="Resize Explorer" aria-valuemin={160} aria-valuemax={440} aria-valuenow={explorerWidth} tabIndex={0} onPointerDown={event => beginResize('left', event)} onKeyDown={event => { if (event.key === 'ArrowRight') setExplorerWidth(value => Math.min(440, value + 12)); if (event.key === 'ArrowLeft') setExplorerWidth(value => Math.max(160, value - 12)) }}><GripVertical size={13} /></div>}

      <main className="main-area">
        <div className="canvas-wrap">
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={setFlowInstance} onPaneClick={() => { setContextMenu(null); setSelectedNode(null) }} onPaneContextMenu={event => openContextMenu(event)} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodesDelete={deleted => deleted.forEach(node => removeNode(node.id))} onEdgesDelete={removeEdges} onNodeClick={(_, node) => { setSelectedNode(node.id); setContextMenu(null) }} onNodeContextMenu={(event, node) => { setSelectedNode(node.id); openContextMenu(event, { kind: 'node', id: node.id }) }} onEdgeClick={() => setContextMenu(null)} onEdgeContextMenu={(event, edge) => openContextMenu(event, { kind: 'edge', id: edge.id, source: edge.source, target: edge.target })} onNodeDragStop={onMoveEnd} onConnect={onConnect} connectionMode={ConnectionMode.Loose} fitView fitViewOptions={{ padding: 0.23 }} minZoom={0.35} maxZoom={1.5} proOptions={{ hideAttribution: false }}><Background color="#d8e2ef" gap={22} size={1} /><Controls /></ReactFlow>
          {contextMenu && <div className="canvas-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onContextMenu={event => event.preventDefault()}>
            <span className="context-menu-title">Add node</span>
            <div className="context-menu-grid">
              <button role="menuitem" onClick={() => addNode('skill', contextMenu.flowPosition)} disabled={busy}><SquarePlus size={14} />Step</button>
            </div>
            {contextMenu.target?.kind === 'node' && <>
              <span className="context-menu-divider" />
              <button className="danger" role="menuitem" onClick={() => contextMenu.target?.kind === 'node' && removeNode(contextMenu.target.id)}><Trash2 size={14} />Delete node</button>
            </>}
            {contextMenu.target?.kind === 'edge' && <>
              <span className="context-menu-divider" />
              {edgeIsPinned(contextMenu.target.id, contextMenu.target.source, contextMenu.target.target) && <button role="menuitem" onClick={() => contextMenu.target?.kind === 'edge' && unpinEdge(contextMenu.target.id, contextMenu.target.source, contextMenu.target.target)}><Magnet size={14} />Auto-place connection points</button>}
              <button className="danger" role="menuitem" onClick={() => contextMenu.target?.kind === 'edge' && removeEdge(contextMenu.target.id, contextMenu.target.source, contextMenu.target.target)}><Unplug size={14} />Delete connection</button>
            </>}
          </div>}
          <div className="line-style-toggle" role="radiogroup" aria-label="Line style">{LINE_STYLES.map(({ value, label, icon: Icon }) => <button key={value} type="button" role="radio" aria-checked={lineStyle === value} aria-label={label} title={label} className={lineStyle === value ? 'active' : ''} onClick={() => setLineStyle(value)}><Icon size={14} /></button>)}</div>
          <div className="canvas-hint">Drag nodes to arrange · Connect handles to add transitions</div>
        </div>

      </main>

      {selected && !inspectorCollapsed && <div className="resize-handle right" role="separator" aria-orientation="vertical" aria-label="Resize Inspector" aria-valuemin={160} aria-valuemax={440} aria-valuenow={inspectorWidth} tabIndex={0} onPointerDown={event => beginResize('right', event)} onKeyDown={event => { if (event.key === 'ArrowRight') setInspectorWidth(value => Math.min(440, value + 12)); if (event.key === 'ArrowLeft') setInspectorWidth(value => Math.max(160, value - 12)) }}><GripVertical size={13} /></div>}

      {selected && <aside className={`inspector dock-right ${inspectorCollapsed ? 'collapsed' : ''} ${mobileInspectorOpen ? 'open' : ''}`}><div className="inspector-top"><div className="inspector-panel-actions"><button className="icon-plain desktop-collapse" title="Collapse Inspector" onClick={() => setInspectorCollapsed(true)}>×</button></div><button className="mobile-close" onClick={() => setMobileInspectorOpen(false)}>Close ×</button><span className="eyebrow">INSPECTOR</span><h2>{selected.label || selectedNode}</h2><p>Edit this step and its instructions.</p></div>
        <div className="inspector-body">
          <div className="field"><label>Label</label><input value={selected.label || ''} onChange={e => updateNode(selectedNode!, { label: e.target.value })} /></div>
          <div className="field"><label>Description</label><textarea rows={2} value={selected.description || ''} onChange={e => updateNode(selectedNode!, { description: e.target.value })} placeholder="Briefly describe this step" /></div>
          <fieldset className="field state-field"><legend>State</legend><div className="state-options">{(['normal', 'initial', 'final'] as const).map(state => {
            const checked = workflow.start === selectedNode ? state === 'initial' : selected.terminal ? state === 'final' : state === 'normal'
            const disabled = (state === 'normal' || state === 'final') && workflow.start === selectedNode && Object.keys(workflow.nodes).length === 1
            return <label key={state} className={checked ? 'checked' : ''}><input type="radio" name="node-state" value={state} checked={checked} disabled={disabled} onChange={() => setNodeState(selectedNode!, state)} />{state === 'initial' ? 'Initial' : state === 'final' ? 'Final' : 'Normal'}</label>
          })}</div></fieldset>
          <div className="field node-skill-actions"><label>Skill</label><button type="button" className="button skill-open-button" onClick={openSkillEditor} disabled={skillBusy}><BookOpen size={15} /> Edit Skill Markdown</button><input ref={importSkillInput} type="file" multiple hidden onChange={event => importSkillFiles(event.target.files)} /><button type="button" className="button skill-import-button" onClick={() => importSkillInput.current?.click()} disabled={skillBusy}><Upload size={15} /> Import files</button><p className="helper">Markdown, PDF, code and other reference files.</p>
            {!!skillResources.length && <ul className="skill-resources" aria-label="Imported files">{skillResources.map(path => {
              const name = path.slice(skillDirectory.length)
              return <li key={path} className={confirmingDelete === path ? 'confirming' : ''}>
                <FileText size={13} /><span className="resource-name" title={path}>{name}</span>
                {confirmingDelete === path
                  ? <span className="resource-confirm"><button type="button" className="resource-delete-confirm" disabled={skillBusy} onClick={() => deleteResource(path)}>Delete</button><button type="button" className="resource-cancel" onClick={() => setConfirmingDelete('')}>Cancel</button></span>
                  : <button type="button" className="icon-plain resource-delete" aria-label={`Delete ${name}`} title="Delete file" disabled={skillBusy} onClick={() => setConfirmingDelete(path)}><Trash2 size={13} /></button>}
              </li>
            })}</ul>}
          </div>
          {!selected.terminal && <EvaluationEditor key={selectedNode} node={selected} nodeId={selectedNode!} nodes={workflow.nodes} onChange={patch => updateNode(selectedNode!, patch)} />}
          {!selected.terminal && <div className="field"><label>Next steps</label><ArcConditions node={selected} nodes={workflow.nodes} onChange={next => updateNode(selectedNode!, { next })} /></div>}
        </div>
      </aside>}
    </div>
    {testsOpen && projectId && <TestsPanel key={projectId} projectId={projectId} labels={Object.fromEntries(Object.entries(workflow.nodes).map(([id, node]: [string, any]) => [id, node.label || id]))} onClose={() => setTestsOpen(false)} onHighlight={setHighlightedPath} onSaved={async () => setFiles(await api(`/projects/${projectId}/files`))} />}
    {skillEditorOpen && <section className="skill-editor-drawer" aria-label="Skill Markdown editor"><header className="skill-editor-header"><div><span className="eyebrow">SKILL · {skillEditorLabel}</span><h2>Markdown editor</h2></div><div className="skill-editor-header-actions"><button className="button subtle preview-toggle" aria-label={skillPreview ? 'Edit Markdown' : 'Preview Markdown'} onClick={() => setSkillPreview(value => !value)}>{skillPreview ? <Code2 size={15} /> : <Eye size={15} />}{skillPreview ? 'Edit' : 'Preview'}</button><button className="icon-plain" aria-label="Close Skill editor" title="Close" onClick={closeSkillEditor}>×</button></div></header>{skillPreview ? <article className="markdown-preview" dangerouslySetInnerHTML={{ __html: renderedSkillMarkdown }} /> : <div className="skill-markdown-editor"><Editor height="100%" language="markdown" theme="vs-light" value={skillMarkdown} onChange={value => { setSkillMarkdown(value || ''); setSkillDirty(true) }} options={{ minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, wordWrap: 'on' }} /></div>}<footer className="skill-editor-footer"><span className={skillBusy || skillDirty ? 'unsaved' : 'saved'}>{skillBusy || skillDirty ? 'Saving…' : 'Saved'}</span></footer></section>}
    {dialog && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setDialog(null) }}><form className={`modal ${dialog.kind === 'project' ? 'project-create-modal' : ''}`} onSubmit={event => { event.preventDefault(); submitDialog() }}>
      <span className="eyebrow">{dialog.kind === 'project' ? 'NEW PROJECT' : dialog.kind === 'rename' ? 'RENAME PROJECT' : 'DELETE PROJECT'}</span>
      <h2>{dialog.kind === 'project' ? 'Create a project' : dialog.kind === 'rename' ? 'Rename project' : 'Delete project?'}</h2>
      {dialog.kind === 'delete' ? <p>Delete “{dialogName}”, its project folder and everything inside it? This cannot be undone.</p> : <>
        <p>{dialog.kind === 'project' ? 'Choose a name and location for this project.' : 'Choose a new project name.'}</p>
        <label>Project name<input autoFocus required value={dialogName} onChange={event => setDialogName(event.target.value)} placeholder="My workflow" /></label>
        {dialog.kind === 'project' && <div className="project-folder-picker"><label>Project location</label><div className="project-folder-row"><input value={projectParentPath} onChange={event => setProjectParentPath(event.target.value)} placeholder="Choose a parent folder" aria-label="Project parent folder" /><button type="button" className="button" onClick={chooseProjectFolder} disabled={folderPickerBusy}><FolderPlus size={15} />{folderPickerBusy ? 'Opening…' : 'Choose folder'}</button></div>{projectParentPath && <p className="project-folder-preview">Project files will be saved to <strong>{projectParentPath}/{slug(dialogName || 'project')}</strong></p>}</div>}
      </>}
      <div className="modal-actions"><button type="button" onClick={() => setDialog(null)}>Cancel</button><button type="submit" disabled={dialog.kind === 'project' && (!projectParentPath || folderPickerBusy)} className={dialog.kind === 'delete' ? 'delete-confirm' : 'create'}>{dialog.kind === 'project' ? 'Create project' : dialog.kind === 'rename' ? 'Save name' : 'Delete project'}</button></div>
    </form></div>}
    {notice && <div className="notice"><span>{notice}</span><button onClick={() => setNotice('')}>×</button></div>}
  </div>
}
