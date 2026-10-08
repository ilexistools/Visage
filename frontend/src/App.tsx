import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Background, BaseEdge, Controls, EdgeLabelRenderer, getSmoothStepPath, Handle, MarkerType, Position, ReactFlow, useEdgesState, useNodesState, type Connection, type Edge, type EdgeProps, type Node, type ReactFlowInstance } from '@xyflow/react'
import Editor from '@monaco-editor/react'
import yaml from 'js-yaml'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { BookOpen, Code2, Ellipsis, Eye, Folder, FolderPlus, GripVertical, Package, Pencil, Plus, SquarePlus, Trash2, Unplug, Upload, Workflow } from 'lucide-react'
import { api, del, post, put } from './api'

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

function JsonField({ value, onCommit, placeholder }: { value: unknown; onCommit: (value: unknown) => void; placeholder?: string }) {
  const serialized = value === undefined ? '' : JSON.stringify(value, null, 2)
  const [draft, setDraft] = useState(serialized)
  const [invalid, setInvalid] = useState('')
  useEffect(() => { setDraft(serialized); setInvalid('') }, [serialized])
  const commit = () => {
    if (!draft.trim()) { setInvalid(''); if (value !== undefined) onCommit(undefined); return }
    try { const parsed = JSON.parse(draft); setInvalid(''); if (JSON.stringify(parsed, null, 2) !== serialized) onCommit(parsed) } catch (error) { setInvalid((error as Error).message) }
  }
  return <><textarea className="code-input" rows={6} spellCheck={false} value={draft} placeholder={placeholder} onChange={event => setDraft(event.target.value)} onBlur={commit} />{invalid && <p className="helper field-error">Invalid JSON: {invalid}</p>}</>
}

type Check = { when: string; message?: string }
const checksToText = (checks: Check[] = []) => checks.map(check => typeof check === 'string' ? check : check.message ? `${check.when} :: ${check.message}` : check.when).join('\n')
const textToChecks = (text: string): Check[] => text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
  const [when, ...message] = line.split('::')
  return message.length ? { when: when.trim(), message: message.join('::').trim() } : { when: when.trim() }
})

function ChecksField({ value, onCommit }: { value: Check[] | undefined; onCommit: (value: Check[] | undefined) => void }) {
  const serialized = checksToText(value)
  const [draft, setDraft] = useState(serialized)
  useEffect(() => setDraft(serialized), [serialized])
  return <textarea className="code-input" rows={3} spellCheck={false} value={draft} placeholder={'output.score >= 0.8 :: Score must be at least 0.8'} onChange={event => setDraft(event.target.value)} onBlur={() => { if (draft !== serialized) { const checks = textToChecks(draft); onCommit(checks.length ? checks : undefined) } }} />
}

function FlowNode({ data, selected }: any) {
  const incomingHandles = data.incomingHandles?.length ? data.incomingHandles : data.kind === 'start' ? [] : [{ id: `${data.nodeId}-in-default`, side: 'left', offset: 50 }]
  const outgoingHandles = data.outgoingHandles?.length ? data.outgoingHandles : data.kind === 'end' || data.terminal ? [] : [{ id: `${data.nodeId}-out-default`, side: 'right', offset: 50 }]
  return <div className={`flow-node ${data.kind} ${data.isFinal ? 'final' : ''} ${data.status || ''} ${selected ? 'selected' : ''}`}>
    {data.isInitial && <svg className="initial-state-arrow" viewBox="0 0 24 30" aria-label="Initial state"><path d="M1 1 L22 15 L1 29 Z" /></svg>}
    {incomingHandles.map((handle: any) => <FlowPort key={handle.id} {...handle} type="target" />)}
    <InlineText tag="strong" className="flow-node-title" value={data.label} onCommit={data.onLabelChange} title="Double-click to edit label" />
    <InlineText className="flow-node-description" value={data.description || ''} onCommit={data.onDescriptionChange} title="Double-click to edit description" />
    {outgoingHandles.map((handle: any) => <FlowPort key={handle.id} {...handle} type="source" />)}
  </div>
}
const nodeTypes = { vasm: FlowNode }

function FlowEdge(props: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX: props.sourceX, sourceY: props.sourceY, sourcePosition: props.sourcePosition, targetX: props.targetX, targetY: props.targetY, targetPosition: props.targetPosition })
  const data = props.data as { onLabelChange?: (value: string) => void } | undefined
  return <>
    <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} interactionWidth={20} />
    <EdgeLabelRenderer><div className="editable-arc-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}><InlineText value={String(props.label || '')} onCommit={data?.onLabelChange || (() => {})} title="Double-click to edit arc text" placeholder="+" /></div></EdgeLabelRenderer>
  </>
}
const edgeTypes = { editable: FlowEdge }

type PortSide = 'left' | 'right' | 'top' | 'bottom'
type EdgePorts = { sourceHandle: string; targetHandle: string; sourceSide: PortSide; targetSide: PortSide; sourceOffset: number; targetOffset: number }
const portDirections: Record<PortSide, [number, number]> = { right: [1, 0], bottom: [0, 1], left: [-1, 0], top: [0, -1] }
const portPosition = (side: PortSide) => ({ left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom })[side]

function FlowPort({ id, side, offset, type }: { id: string; side: PortSide; offset: number; type: 'source' | 'target' }) {
  const style = side === 'left' || side === 'right' ? { top: `${offset}%` } : { left: `${offset}%` }
  return <Handle id={id} type={type} position={portPosition(side)} style={style} />
}

function layoutEdgePorts(workflow: WorkflowDoc): Record<string, EdgePorts> {
  const nodeEntries = Object.entries(workflow.nodes || {})
  const positions = new Map(nodeEntries.map(([id, node], index) => [id, node.position || { x: 100 + (index % 3) * 260, y: 120 + Math.floor(index / 3) * 190 }]))
  const edges = nodeEntries.flatMap(([source, node]) => (node.next || []).map((next: any, index: number) => ({ id: `${source}-${next.goto}-${index}`, source, target: next.goto })))
  const result: Record<string, EdgePorts> = {}

  const assign = (ownerKey: 'source' | 'target', otherKey: 'source' | 'target', sideKey: 'sourceSide' | 'targetSide', offsetKey: 'sourceOffset' | 'targetOffset') => {
    const groups = new Map<string, typeof edges>()
    edges.forEach(edge => groups.set(edge[ownerKey], [...(groups.get(edge[ownerKey]) || []), edge]))
    groups.forEach((group, owner) => {
      const used: Record<PortSide, number> = { left: 0, right: 0, top: 0, bottom: 0 }
      const bySide = new Map<PortSide, string[]>()
      group.forEach(edge => {
        const from = positions.get(owner) || { x: 0, y: 0 }
        const to = positions.get(edge[otherKey]) || { x: 0, y: 0 }
        const dx = to.x - from.x
        const dy = to.y - from.y
        const distance = Math.hypot(dx, dy) || 1
        const side = (Object.keys(portDirections) as PortSide[]).map(candidate => {
          const [vx, vy] = portDirections[candidate]
          const alignment = (dx * vx + dy * vy) / distance
          const duplicatePenalty = used[candidate] ? 1.05 + used[candidate] * 0.1 : 0
          return { candidate, score: alignment - duplicatePenalty }
        }).sort((a, b) => b.score - a.score)[0].candidate
        used[side] += 1
        bySide.set(side, [...(bySide.get(side) || []), edge.id])
        result[edge.id] ||= { sourceHandle: `${edge.id}-out`, targetHandle: `${edge.id}-in`, sourceSide: 'right', targetSide: 'left', sourceOffset: 50, targetOffset: 50 }
        result[edge.id][sideKey] = side
      })
      bySide.forEach(edgeIds => edgeIds.forEach((edgeId, index) => {
        result[edgeId][offsetKey] = ((index + 1) / (edgeIds.length + 1)) * 100
      }))
    })
  }

  assign('source', 'target', 'sourceSide', 'sourceOffset')
  assign('target', 'source', 'targetSide', 'targetOffset')
  return result
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

  const exportPlugin = async () => {
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
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a'); link.href = url; link.download = filename
      document.body.appendChild(link); link.click(); link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
      setNotice(`Plugin exported to the project's dist/ folder and downloaded as ${filename}.`)
    } catch (e) { tell(e) } finally { setBusy(false) }
  }
  const tell = (value: unknown) => setNotice(value instanceof Error ? value.message : String(value))
  const loadProjects = useCallback(async () => { try { setProjects(await api('/projects')) } catch (e) { tell(e) } }, [])
  useEffect(() => { loadProjects() }, [loadProjects])

  const loadProject = useCallback(async (id: string) => {
    try {
      const [result, projectFiles] = await Promise.all([api(`/projects/${id}/workflow`), api(`/projects/${id}/files`)])
      setWorkflow(result.workflow); setSource(result.source); setFiles(projectFiles); setProjectId(id); setSelectedNode(null); setDirty(false); setYamlDirty(false); setMobileProjectOpen(false); setSkillEditorOpen(false); setSkillDirty(false)
      setNotice(result.warnings?.join(' · ') || '')
    } catch (e) { tell(e) }
  }, [])
  useEffect(() => {
    if (projectId || !projects.length) return
    const requested = new URLSearchParams(window.location.search).get('project')
    loadProject(projects.some(project => project.id === requested) ? requested! : projects[0].id)
  }, [projects, projectId, loadProject])


  useEffect(() => {
    const ports = layoutEdgePorts(workflow)
    const mappedNodes: Node[] = Object.entries(workflow.nodes || {}).map(([id, node], index) => ({
      id, type: 'vasm', position: node.position || { x: 100 + (index % 3) * 260, y: 120 + Math.floor(index / 3) * 190 },
      data: {
        nodeId: id, kind: 'skill', label: node.label || defaultNodeLabel(node.type), description: node.description || '', skill: node.skill?.path, terminal: node.terminal, isInitial: workflow.start === id, isFinal: !!node.terminal,
        onLabelChange: (label: string) => { setWorkflow(old => ({ ...old, nodes: { ...old.nodes, [id]: { ...old.nodes[id], label } } })); setDirty(true) },
        onDescriptionChange: (description: string) => { setWorkflow(old => ({ ...old, nodes: { ...old.nodes, [id]: { ...old.nodes[id], description } } })); setDirty(true) },
        outgoingHandles: (node.terminal ? [] : node.next || []).map((next: any, index: number) => {
          const port = ports[`${id}-${next.goto}-${index}`]
          return { id: port.sourceHandle, side: port.sourceSide, offset: port.sourceOffset }
        }),
        incomingHandles: Object.entries(workflow.nodes || {}).flatMap(([source, sourceNode]) => (sourceNode.next || []).flatMap((next: any, edgeIndex: number) => next.goto === id ? (() => {
          const port = ports[`${source}-${id}-${edgeIndex}`]
          return [{ id: port.targetHandle, side: port.targetSide, offset: port.targetOffset }]
        })() : [])),
      },
    }))
    const mappedEdges: Edge[] = Object.entries(workflow.nodes || {}).flatMap(([id, node]) => (node.terminal ? [] : node.next || []).map((next: any, index: number) => ({
      id: `${id}-${next.goto}-${index}`, source: id, target: next.goto, sourceHandle: ports[`${id}-${next.goto}-${index}`].sourceHandle, targetHandle: ports[`${id}-${next.goto}-${index}`].targetHandle, label: next.label || '', type: 'editable', data: { onLabelChange: (label: string) => { setWorkflow(old => ({ ...old, nodes: { ...old.nodes, [id]: { ...old.nodes[id], next: (old.nodes[id].next || []).map((transition: any, transitionIndex: number) => transitionIndex === index ? { ...transition, label } : transition) } } })); setDirty(true) } },
      markerEnd: { type: MarkerType.Arrow, color: '#667b99', width: 14, height: 14 },
      style: { stroke: '#667b99', strokeWidth: 2.2 }, labelStyle: { fill: '#64748b', fontSize: 11 },
    })))
    setNodes(mappedNodes); setEdges(mappedEdges)
  }, [workflow, setNodes, setEdges])

  const updateNode = (id: string, patch: Record<string, unknown>) => {
    const node = { ...workflow.nodes[id], ...patch }
    Object.keys(patch).forEach(key => { if (patch[key] === undefined) delete node[key] })
    setWorkflow(old => ({ ...old, nodes: { ...old.nodes, [id]: { ...old.nodes[id], ...node } } })); setDirty(true)
  }
  const onMoveEnd = (_: unknown, node: Node) => updateNode(node.id, { position: { x: Math.round(node.position.x), y: Math.round(node.position.y) } })
  const onConnect = (connection: Connection) => {
    if (!connection.source || !connection.target) return
    const current = workflow.nodes[connection.source]
    updateNode(connection.source, { next: [...(current.next || []), { goto: connection.target }] })
  }
  const openContextMenu = (event: MouseEvent | ReactMouseEvent, target: ContextTarget = null) => {
    event.preventDefault(); event.stopPropagation()
    const flowPosition = flowInstance?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) || { x: 0, y: 0 }
    setContextMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 220)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 280)), flowPosition, target })
  }
  const removeNode = (id: string) => {
    const removed = workflow.nodes[id]
    if (!removed) return
    const remaining: Record<string, any> = {}
    Object.entries(workflow.nodes).forEach(([nodeId, node]) => {
      if (nodeId === id) return
      remaining[nodeId] = node.next ? { ...node, next: node.next.filter((transition: any) => transition.goto !== id) } : node
    })
    let start = workflow.start
    if (start === id) start = removed.next?.[0]?.goto || Object.keys(remaining)[0] || ''
    if (!remaining[start]) start = Object.keys(remaining)[0] || ''
    setWorkflow(old => ({ ...old, start, nodes: remaining })); setDirty(true); setSelectedNode(null); setContextMenu(null)
  }
  const removeEdge = (id: string, source: string, target: string) => {
    const transitions = workflow.nodes[source]?.next || []
    const index = transitions.findIndex((transition: any, position: number) => `${source}-${transition.goto}-${position}` === id && transition.goto === target)
    if (index < 0) return
    updateNode(source, { next: transitions.filter((_: any, position: number) => position !== index) })
    setContextMenu(null)
  }
  const setNodeState = (id: string, state: 'normal' | 'initial' | 'final') => {
    setWorkflow(old => {
      const nextNodes = { ...old.nodes, [id]: { ...old.nodes[id], terminal: state === 'final' } }
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
        if (result.warnings?.length) setNotice(result.warnings.join(' · '))
      }
      return true
    } catch (e) { tell(e); return false } finally { setBusy(false) }
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
      const width = Math.max(160, Math.min(440, initialWidth + delta))
      currentWidth = width
      if (panel === 'explorer') setExplorerWidth(width)
      else setInspectorWidth(width)
    }
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      if (panel === 'explorer') setExplorerWidth(currentWidth)
      else {
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
      <div className="brand"><div className="brand-mark"><Workflow size={21} /></div><strong>Visage</strong></div>
      <div className="top-actions"><button className="button subtle icon-button" data-tooltip="Export plugin" aria-label="Export plugin" onClick={exportPlugin} disabled={!projectId || busy}><Package size={15} /></button></div>
    </header>

    <div className="workspace" style={{ '--left-panel-width': `${explorerWidth}px`, '--right-panel-width': `${selected && !inspectorCollapsed ? inspectorWidth : 0}px` } as React.CSSProperties}>
      <aside className={`sidebar dock-left ${mobileProjectOpen ? 'open' : ''}`}>
        <div className="sidebar-title">EXPLORER <div className="sidebar-title-actions"><button className="icon-plain" title="New project" onClick={createProject}><Plus size={16} /></button></div></div>
        <div className="sidebar-section"><div className="section-heading"><Folder size={15} /> PROJECTS</div>{projects.map(project => <div className={`project-item-row ${project.id === projectId ? 'active' : ''}`} key={project.id}><button className="tree-item project-select" title={project.root_path || project.name} onClick={() => loadProject(project.id)}><span className="tree-dot" />{project.name}</button><div className="project-menu-wrap"><button className="project-more" aria-label={`Options for ${project.name}`} title="Project options" aria-haspopup="menu" aria-expanded={projectMenuId === project.id} onClick={event => { event.stopPropagation(); setProjectMenuId(value => value === project.id ? '' : project.id) }}><Ellipsis size={17} /></button>{projectMenuId === project.id && <div className="project-menu" role="menu"><button role="menuitem" onClick={() => renameProject(project)}><Pencil size={14} />Rename project</button><button role="menuitem" className="danger" onClick={() => confirmDeleteProject(project)}><Trash2 size={14} />Delete project</button></div>}</div></div>)}{!projects.length && <div className="empty-small">Create a project to begin.</div>}</div>
      </aside>
      {mobileProjectOpen && <div className="mobile-sidebar-backdrop" onClick={() => setMobileProjectOpen(false)} />}

      <div className="resize-handle left" role="separator" aria-orientation="vertical" aria-label="Resize Explorer" aria-valuemin={160} aria-valuemax={440} aria-valuenow={explorerWidth} tabIndex={0} onPointerDown={event => beginResize('left', event)} onKeyDown={event => { if (event.key === 'ArrowLeft') setExplorerWidth(value => Math.min(440, value + 12)); if (event.key === 'ArrowRight') setExplorerWidth(value => Math.max(160, value - 12)) }}><GripVertical size={13} /></div>

      <main className="main-area">
        <div className="canvas-wrap">
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={setFlowInstance} onPaneClick={() => { setContextMenu(null); setSelectedNode(null) }} onPaneContextMenu={event => openContextMenu(event)} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeClick={(_, node) => { setSelectedNode(node.id); setContextMenu(null) }} onNodeContextMenu={(event, node) => { setSelectedNode(node.id); openContextMenu(event, { kind: 'node', id: node.id }) }} onEdgeClick={() => setContextMenu(null)} onEdgeContextMenu={(event, edge) => openContextMenu(event, { kind: 'edge', id: edge.id, source: edge.source, target: edge.target })} onNodeDragStop={onMoveEnd} onConnect={onConnect} fitView fitViewOptions={{ padding: 0.23 }} minZoom={0.35} maxZoom={1.5} proOptions={{ hideAttribution: false }}><Background color="#d8e2ef" gap={22} size={1} /><Controls /></ReactFlow>
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
              <button className="danger" role="menuitem" onClick={() => contextMenu.target?.kind === 'edge' && removeEdge(contextMenu.target.id, contextMenu.target.source, contextMenu.target.target)}><Unplug size={14} />Delete connection</button>
            </>}
          </div>}
          <div className="canvas-hint">Drag nodes to arrange · Connect handles to add transitions</div>
        </div>

      </main>

      {selected && !inspectorCollapsed && <div className="resize-handle right" role="separator" aria-orientation="vertical" aria-label="Resize Inspector" aria-valuemin={160} aria-valuemax={440} aria-valuenow={inspectorWidth} tabIndex={0} onPointerDown={event => beginResize('right', event)} onKeyDown={event => { if (event.key === 'ArrowRight') setInspectorWidth(value => Math.min(440, value + 12)); if (event.key === 'ArrowLeft') setInspectorWidth(value => Math.max(160, value - 12)) }}><GripVertical size={13} /></div>}

      {selected && <aside className={`inspector dock-right ${inspectorCollapsed ? 'collapsed' : ''} ${mobileInspectorOpen ? 'open' : ''}`}><div className="inspector-top"><div className="inspector-panel-actions"><button className="icon-plain desktop-collapse" title="Collapse Inspector" onClick={() => setInspectorCollapsed(true)}>×</button></div><button className="mobile-close" onClick={() => setMobileInspectorOpen(false)}>Close ×</button><span className="eyebrow">INSPECTOR</span><h2>{selected.label || selectedNode}</h2><p>Edit this step and its instructions.</p></div>
        <div className="inspector-body">
          <div className="field"><label>Label</label><input value={selected.label || ''} onChange={e => updateNode(selectedNode!, { label: e.target.value })} /></div>
          <div className="field"><label>Description</label><textarea rows={2} value={selected.description || ''} onChange={e => updateNode(selectedNode!, { description: e.target.value })} placeholder="Briefly describe this step" /></div>
          <div className="field"><label>Arc</label>{!selected.terminal && !!selected.next?.length ? selected.next.map((transition: any, index: number) => <div className="arc-text-edit" key={`${transition.goto}-${index}`}><span className="arc-target">→ {workflow.nodes[transition.goto]?.label || transition.goto}</span><input aria-label={`Arc text to ${workflow.nodes[transition.goto]?.label || transition.goto}`} placeholder="Label" value={transition.label || ''} onChange={event => { const next = [...selected.next]; next[index] = { ...next[index], label: event.target.value }; updateNode(selectedNode!, { next }) }} /><input className="code-input" aria-label={`Condition to ${workflow.nodes[transition.goto]?.label || transition.goto}`} placeholder={index === selected.next.length - 1 ? 'Condition (empty = default)' : 'output.status == "approved"'} value={transition.when || ''} onChange={event => { const next = [...selected.next]; const { when: _when, ...rest } = next[index]; next[index] = event.target.value ? { ...rest, when: event.target.value } : rest; updateNode(selectedNode!, { next }) }} /></div>) : <p className="helper">This node has no outgoing arcs.</p>}</div>
          <fieldset className="field state-field"><legend>State</legend><div className="state-options">{(['normal', 'initial', 'final'] as const).map(state => {
            const checked = workflow.start === selectedNode ? state === 'initial' : selected.terminal ? state === 'final' : state === 'normal'
            const disabled = (state === 'normal' || state === 'final') && workflow.start === selectedNode && Object.keys(workflow.nodes).length === 1
            return <label key={state} className={checked ? 'checked' : ''}><input type="radio" name="node-state" value={state} checked={checked} disabled={disabled} onChange={() => setNodeState(selectedNode!, state)} />{state === 'initial' ? 'Initial' : state === 'final' ? 'Final' : 'Normal'}</label>
          })}</div></fieldset>
          <div className="field node-skill-actions"><label>Skill</label><button type="button" className="button skill-open-button" onClick={openSkillEditor} disabled={skillBusy}><BookOpen size={15} /> Edit Skill Markdown</button><input ref={importSkillInput} type="file" multiple hidden onChange={event => importSkillFiles(event.target.files)} /><button type="button" className="button skill-import-button" onClick={() => importSkillInput.current?.click()} disabled={skillBusy}><Upload size={15} /> Import files</button><p className="helper">Markdown, PDF, code and other reference files.</p></div>
          {!selected.terminal && <fieldset className="field evaluation-field"><legend>Evaluation</legend>
            <label>Output schema (JSON Schema)</label><JsonField value={selected.output_schema} placeholder={'{"type": "object", "required": ["status"]}'} onCommit={value => updateNode(selectedNode!, { output_schema: value })} />
            <label>Checks <span className="helper">one per line · expression :: message</span></label><ChecksField value={selected.checks} onCommit={value => updateNode(selectedNode!, { checks: value })} />
            <div className="evaluation-row"><label>Max attempts<input type="number" min={1} max={20} value={selected.max_attempts || 1} onChange={event => updateNode(selectedNode!, { max_attempts: Math.min(20, Math.max(1, Number(event.target.value) || 1)) })} /></label>
            <label>On failure<select value={selected.on_fail || ''} onChange={event => updateNode(selectedNode!, { on_fail: event.target.value || undefined })}><option value="">Fail the run</option>{Object.entries(workflow.nodes).filter(([id]) => id !== selectedNode).map(([id, node]: [string, any]) => <option key={id} value={id}>Go to {node.label || id}</option>)}</select></label></div>
            <p className="helper">Failed outputs are retried with feedback up to the attempt limit, then routed to the failure target.</p>
          </fieldset>}
        </div>
      </aside>}
    </div>
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
