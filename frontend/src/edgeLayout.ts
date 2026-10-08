/**
 * Port assignment for workflow arcs.
 *
 * Every node has fixed connection points on each side. Every endpoint (incoming
 * and outgoing) gets its own point, points used on a side are spread along it,
 * ports are ordered by where the other node is so arcs do not cross, and arcs
 * between the same pair of nodes stay parallel.
 */

export type PortSide = 'left' | 'right' | 'top' | 'bottom'
export type EdgePorts = {
  sourceHandle: string; targetHandle: string
  sourceSide: PortSide; targetSide: PortSide
  sourceOffset: number; targetOffset: number
}
type Point = { x: number; y: number }
/** A transition may pin its ends to points chosen by the user (source_handle / target_handle). */
type LayoutTransition = { goto: string; source_handle?: string; target_handle?: string }
type LayoutNode = { position?: Point; terminal?: boolean; next?: LayoutTransition[] }

export const NODE_WIDTH = 207
export const NODE_HEIGHT = 91
/** Connection points per side, as a percentage along the side. */
export const PORT_SLOTS: Record<PortSide, number[]> = {
  top: [15, 32.5, 50, 67.5, 85],
  bottom: [15, 32.5, 50, 67.5, 85],
  left: [22, 50, 78],
  right: [22, 50, 78],
}
export const portId = (side: PortSide, slot: number) => `${side}-${slot}`

/** Parse a connection point ID such as `bottom-2`; invalid IDs return null. */
export function parsePortId(id: unknown): { side: PortSide; slot: number } | null {
  const match = typeof id === 'string' ? /^(top|bottom|left|right)-(\d+)$/.exec(id) : null
  if (!match) return null
  const side = match[1] as PortSide
  const slot = Number(match[2])
  return slot < PORT_SLOTS[side].length ? { side, slot } : null
}
const SIDES: PortSide[] = ['right', 'bottom', 'left', 'top']
const DIRECTIONS: Record<PortSide, Point> = { right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, top: { x: 0, y: -1 } }
/** Score lost per port already on a side: sharing a side is fine, but a nearly as good free side wins. */
const CROWDING_PENALTY = 0.12
/** Arcs between the same two nodes share a side so they run as parallel lines. */
const PAIR_AFFINITY = 0.6

export const defaultPosition = (index: number): Point => ({ x: 100 + (index % 3) * 260, y: 120 + Math.floor(index / 3) * 190 })
/** Node IDs never contain ':', so `a`->`b-c` and `a-b`->`c` cannot share an arc ID. */
export const edgeId = (source: string, target: string, index: number) => `${source}::${target}::${index}`

type Endpoint = { edge: string; node: string; other: string; role: 'source' | 'target'; side?: PortSide; slot?: number; pairRank: number }

export function layoutEdgePorts(nodes: Record<string, LayoutNode>): Record<string, EdgePorts> {
  const entries = Object.entries(nodes || {})
  const centers = new Map(entries.map(([id, node], index) => {
    const position = node.position || defaultPosition(index)
    return [id, { x: position.x + NODE_WIDTH / 2, y: position.y + NODE_HEIGHT / 2 }]
  }))
  const edges = entries.flatMap(([source, node]) => (node.terminal ? [] : node.next || [])
    .map((next, index) => ({ id: edgeId(source, next.goto, index), source, target: next.goto, sourcePin: parsePortId(next.source_handle), targetPin: parsePortId(next.target_handle) }))
    .filter(edge => centers.has(edge.target)))

  const result: Record<string, EdgePorts> = {}
  const endpoints = new Map<string, Endpoint[]>()
  const add = (endpoint: Endpoint) => endpoints.set(endpoint.node, [...(endpoints.get(endpoint.node) || []), endpoint])
  // Rank arcs between the same unordered pair so both ends list them in the same order.
  const pairs = new Map<string, string[]>()
  edges.forEach(edge => {
    const key = [edge.source, edge.target].sort().join('\u0000')
    pairs.set(key, [...(pairs.get(key) || []), edge.id])
  })
  const pairRank = (edge: { id: string; source: string; target: string }) => pairs.get([edge.source, edge.target].sort().join('\u0000'))!.indexOf(edge.id)

  for (const edge of edges) {
    result[edge.id] = { sourceHandle: portId('right', 1), targetHandle: portId('left', 1), sourceSide: 'right', targetSide: 'left', sourceOffset: 50, targetOffset: 50 }
    const rank = pairRank(edge)
    // Self-loops leave on the right and come back from the top, around the corner, unless pinned.
    const loop = edge.source === edge.target
    add({ edge: edge.id, node: edge.source, other: edge.target, role: 'source', pairRank: rank, side: edge.sourcePin?.side ?? (loop ? 'right' : undefined), slot: edge.sourcePin?.slot })
    add({ edge: edge.id, node: edge.target, other: edge.source, role: 'target', pairRank: rank, side: edge.targetPin?.side ?? (loop ? 'top' : undefined), slot: edge.targetPin?.slot })
  }

  for (const [nodeId, list] of endpoints) {
    const center = centers.get(nodeId)!
    const direction = (endpoint: Endpoint) => {
      const other = centers.get(endpoint.other)!
      // Use the free gap between the boxes: a node beside this one is reached from the side,
      // one above or below from the top or bottom, whatever the distance between centers.
      const gap = (delta: number, size: number) => Math.sign(delta) * Math.max(Math.abs(delta) - size, 1)
      const dx = other.x === center.x ? 0 : gap(other.x - center.x, NODE_WIDTH)
      const dy = other.y === center.y ? 0 : gap(other.y - center.y, NODE_HEIGHT)
      const length = Math.hypot(dx, dy) || 1
      return { x: dx / length, y: dy / length }
    }
    const used: Record<PortSide, number> = { left: 0, right: 0, top: 0, bottom: 0 }
    list.filter(endpoint => endpoint.side).forEach(endpoint => { used[endpoint.side!] += 1 })
    // Decide the most clear-cut endpoints first so they claim their natural side.
    const pending = list.filter(endpoint => !endpoint.side).map(endpoint => {
      const vector = direction(endpoint)
      const scores = SIDES.map(side => ({ side, alignment: vector.x * DIRECTIONS[side].x + vector.y * DIRECTIONS[side].y }))
      return { endpoint, scores, best: Math.max(...scores.map(score => score.alignment)) }
    }).sort((a, b) => b.best - a.best)
    const full = (side: PortSide) => used[side] >= PORT_SLOTS[side].length
    const allFull = () => SIDES.every(full)
    for (const { endpoint, scores } of pending) {
      const partnerSides = new Set(list.filter(other => other !== endpoint && other.other === endpoint.other && other.side).map(other => other.side))
      endpoint.side = scores
        .map(({ side, alignment }) => ({ side, score: alignment - used[side] * CROWDING_PENALTY - (alignment < 0 ? 1 : 0) + (partnerSides.has(side) ? PAIR_AFFINITY : 0) - (full(side) && !allFull() ? 100 : 0) }))
        .sort((a, b) => b.score - a.score)[0].side
      used[endpoint.side] += 1
    }

    // Order ports along each side (left to right, top to bottom) by the angle at which the
    // other node is seen, so arcs fan out from the box without crossing each other.
    const angle = (endpoint: Endpoint, side: PortSide) => {
      const other = centers.get(endpoint.other)!
      const degrees = Math.atan2(other.y - center.y, other.x - center.x) * 180 / Math.PI
      const normalized = side === 'left' && degrees < 0 ? degrees + 360 : degrees
      return side === 'bottom' || side === 'left' ? -normalized : normalized
    }
    for (const side of SIDES) {
      const onSide = list.filter(endpoint => endpoint.side === side)
      onSide.sort((a, b) => {
        const difference = angle(a, side) - angle(b, side)
        return Math.abs(difference) > 0.5 ? difference : a.pairRank - b.pairRank
      })
      // Pinned ends keep their point; the others spread over the points still free.
      const pinned = new Set(onSide.filter(endpoint => endpoint.slot !== undefined).map(endpoint => endpoint.slot!))
      const free = onSide.filter(endpoint => endpoint.slot === undefined)
      const freeSlots = PORT_SLOTS[side].map((_, slot) => slot).filter(slot => !pinned.has(slot))
      const pool = freeSlots.length ? freeSlots : PORT_SLOTS[side].map((_, slot) => slot)
      const picks = spreadSlots(free.length, pool.length).map(index => pool[index])
      free.forEach((endpoint, index) => { endpoint.slot = picks[index] })
      onSide.forEach(endpoint => {
        const ports = result[endpoint.edge]
        const slot = endpoint.slot!
        if (endpoint.role === 'source') { ports.sourceSide = side; ports.sourceOffset = PORT_SLOTS[side][slot]; ports.sourceHandle = portId(side, slot) }
        else { ports.targetSide = side; ports.targetOffset = PORT_SLOTS[side][slot]; ports.targetHandle = portId(side, slot) }
      })
    }
  }
  return result
}

/**
 * Pick `count` of `capacity` slots spread as far apart as possible, in order.
 * A single port takes the middle slot. Past capacity, slots are reused.
 */
export function spreadSlots(count: number, capacity: number): number[] {
  if (count === 1) return [Math.floor(capacity / 2)]
  if (count > capacity) return Array.from({ length: count }, (_, index) => Math.min(capacity - 1, Math.floor(index * capacity / count)))
  return Array.from({ length: count }, (_, index) => Math.round(index * (capacity - 1) / (count - 1)))
}

/**
 * Shift the middle segment of a step path so arcs that share a side do not run on top of each other.
 * Ports nearer the turn direction turn first, which keeps neighbouring arcs from crossing.
 */
export function routeCenter(ports: Pick<EdgePorts, 'sourceSide' | 'targetSide' | 'sourceOffset' | 'targetOffset'>, source: Point, target: Point): { centerX?: number; centerY?: number } {
  const horizontal = (side: PortSide) => side === 'left' || side === 'right'
  const SPREAD = 0.45
  if (horizontal(ports.sourceSide) && horizontal(ports.targetSide)) {
    const sign = target.y < source.y ? 1 : -1
    const shift = sign * ((ports.sourceOffset - 50) + (ports.targetOffset - 50)) * SPREAD
    return { centerX: (source.x + target.x) / 2 + shift }
  }
  if (!horizontal(ports.sourceSide) && !horizontal(ports.targetSide)) {
    const sign = target.x < source.x ? 1 : -1
    const shift = sign * ((ports.sourceOffset - 50) + (ports.targetOffset - 50)) * SPREAD
    return { centerY: (source.y + target.y) / 2 + shift }
  }
  return {}
}
