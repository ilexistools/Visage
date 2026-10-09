/**
 * Automatic layered layout for the workflow canvas.
 *
 * Steps are placed in ranks following the flow from the start node (arcs that loop back are
 * ignored when ranking), ordered inside each rank to reduce crossings, aligned with their
 * neighbours and spaced so arc labels fit between ranks. Both orientations are computed and
 * the one that fits the visible canvas at the larger zoom wins.
 *
 * A seed gives a variation instead: a different order inside ranks, side for the branches,
 * spacing and possibly orientation, with the same guarantees (no overlaps, room for labels).
 */
import { NODE_HEIGHT, NODE_WIDTH } from './edgeLayout.ts'

type Point = { x: number; y: number }
type LayoutNode = { position?: Point; terminal?: boolean; next?: { goto: string }[] }
export type Direction = 'horizontal' | 'vertical'
export type LabelSize = { width: number; height: number }
/** `crossings` counts pairs of arcs between neighbouring ranks that cross. */
export type Layout = { direction: Direction; positions: Record<string, Point>; width: number; height: number; crossings: number }
type Options = { seed?: number }

/** Space between nodes of the same rank, and the least space between ranks. */
const SIBLING_GAP = 64
/** Space kept beside an arc that passes through a rank it does not stop in. */
const LANE_GAP = 28
const LANE_WEIGHT = 4
const MIN_RANK_GAP = 90
/** Room around a label inside the gap between ranks. */
const LABEL_MARGIN = 28
const SWEEPS = 8
/** A variation may cross arcs this many times more than the best layout. */
const EXTRA_CROSSINGS = 1
const VARIATION_ATTEMPTS = 16

/** Small deterministic random generator (mulberry32), so a seed always gives the same layout. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Arc = { source: string; target: string; label: LabelSize }

export function layeredLayout(nodes: Record<string, LayoutNode>, start: string, direction: Direction, labelSize: (source: string, index: number) => LabelSize = () => ({ width: 0, height: 0 }), options: Options = {}): Layout {
  const ids = Object.keys(nodes || {})
  if (!ids.length) return { direction, positions: {}, width: 0, height: 0, crossings: 0 }
  const rng = options.seed ? random(options.seed) : null
  const siblingGap = rng ? Math.round(SIBLING_GAP * (0.8 + rng() * 0.7)) : SIBLING_GAP
  const rankGap = rng ? Math.round(MIN_RANK_GAP + rng() * 60) : MIN_RANK_GAP
  // Only drawn arcs count: on_fail routes are not shown on the canvas.
  const arcs: Arc[] = ids.flatMap(source => {
    const node = nodes[source]
    return (node.terminal ? [] : node.next || []).map((transition, index) => ({ source, target: transition.goto, label: labelSize(source, index) }))
      .filter(arc => Object.hasOwn(nodes, arc.target))
  })

  // Depth-first from the start: an arc to a node still on the stack loops back.
  const discovery: string[] = []
  const postorder: string[] = []
  const onStack = new Set<string>()
  const back = new Set<Arc>()
  const outgoing = (id: string) => arcs.filter(arc => arc.source === id)
  const visit = (id: string) => {
    discovery.push(id)
    onStack.add(id)
    for (const arc of outgoing(id)) {
      if (arc.target === id || onStack.has(arc.target)) back.add(arc)
      else if (!discovery.includes(arc.target)) visit(arc.target)
    }
    onStack.delete(id)
    postorder.push(id)
  }
  for (const root of [...(Object.hasOwn(nodes, start) ? [start] : []), ...ids]) if (!discovery.includes(root)) visit(root)
  const forward = arcs.filter(arc => !back.has(arc) && arc.source !== arc.target)

  // Longest path from the roots, in topological order (reverse postorder).
  const rank: Record<string, number> = Object.fromEntries(ids.map(id => [id, 0]))
  for (const id of [...postorder].reverse()) for (const arc of forward.filter(arc => arc.source === id)) rank[arc.target] = Math.max(rank[arc.target], rank[id] + 1)
  const rankCount = Math.max(...Object.values(rank)) + 1
  const layers: string[][] = Array.from({ length: rankCount }, () => [])
  for (const id of discovery) layers[rank[id]].push(id)

  const horizontal = direction === 'horizontal'
  const mainSize = horizontal ? NODE_WIDTH : NODE_HEIGHT
  const crossSize = horizontal ? NODE_HEIGHT : NODE_WIDTH

  // An arc that skips ranks gets a placeholder in each rank it passes, so it keeps a free lane
  // there and no node is placed on top of it or its label.
  const size = new Map<string, number>(ids.map(id => [id, crossSize]))
  const links: [string, string][] = []
  forward.forEach((arc, index) => {
    let previous = arc.source
    for (let r = rank[arc.source] + 1; r < rank[arc.target]; r++) {
      const lane = `\u0000${index}:${r}`
      rank[lane] = r
      size.set(lane, Math.max(16, horizontal ? arc.label.height : arc.label.width))
      layers[r].push(lane)
      links.push([previous, lane])
      previous = lane
    }
    links.push([previous, arc.target])
  })
  // Arcs that loop back help ordering but not alignment, so the main path stays straight.
  const loops: [string, string][] = [...back].filter(arc => arc.source !== arc.target).map(arc => [arc.source, arc.target])
  const adjacency = (pairs: [string, string][]) => {
    const map = new Map<string, string[]>([...size.keys()].map(id => [id, []]))
    for (const [a, b] of pairs) { map.get(a)!.push(b); map.get(b)!.push(a) }
    return map
  }
  const neighbours = adjacency([...links, ...loops])
  const aligned = adjacency(links)
  const isLane = (id: string) => id.startsWith('\u0000')
  // A variation starts from a shuffled order, which changes how ties are broken below.
  if (rng) for (const layer of layers) for (let i = layer.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [layer[i], layer[j]] = [layer[j], layer[i]] }

  // Crossing reduction: sort each rank by the mean position of its neighbours, sweeping down and up.
  const order = () => new Map(layers.flatMap(layer => layer.map((id, index) => [id, index - (layer.length - 1) / 2] as const)))
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const down = sweep % 2 === 0
    for (const r of down ? layers.keys() : [...layers.keys()].reverse()) {
      const at = order()
      const layer = layers[r]
      const weight = new Map(layer.map(id => {
        const near = neighbours.get(id)!.filter(other => down ? rank[other] < r : rank[other] > r)
        return [id, near.length ? near.reduce((sum, other) => sum + at.get(other)!, 0) / near.length : at.get(id)!]
      }))
      layer.sort((a, b) => weight.get(a)! - weight.get(b)! || layer.indexOf(a) - layer.indexOf(b))
    }
  }

  const position = new Map(layers.flatMap(layer => layer.map((id, index) => [id, index] as const)))
  const between = links.filter(([a, b]) => Math.abs(rank[a] - rank[b]) === 1).map(([a, b]) => rank[a] < rank[b] ? [a, b] : [b, a])
  let crossings = 0
  for (const [i, [a1, b1]] of between.entries()) for (const [a2, b2] of between.slice(i + 1)) {
    if (rank[a1] === rank[a2] && (position.get(a1)! - position.get(a2)!) * (position.get(b1)! - position.get(b2)!) < 0) crossings++
  }

  // Cross axis (centres): start packed, then pull each item towards its neighbours while keeping order and spacing.
  const separation = (a: string, b: string) => (size.get(a)! + size.get(b)!) / 2 + (isLane(a) || isLane(b) ? LANE_GAP : siblingGap)
  const cross = new Map<string, number>()
  for (const layer of layers) {
    let at = 0
    layer.forEach((id, index) => { if (index) at += separation(layer[index - 1], id); cross.set(id, at) })
    layer.forEach(id => cross.set(id, cross.get(id)! - at / 2))
  }
  // Alternate between aligning with the ranks before and after; the last pass aligns each node
  // with what leads to it, so a chain of steps forms a straight line.
  for (let pass = 0; pass < SWEEPS; pass++) {
    const down = pass % 2 === 1
    for (const layer of down ? layers : [...layers].reverse()) {
      // Lanes pull hardest, so an arc that skips ranks runs straight through its lane.
      const desired = layer.map(id => {
        const near = aligned.get(id)!.filter(other => down ? rank[other] < rank[id] : rank[other] > rank[id])
        const weight = (other: string) => isLane(other) ? LANE_WEIGHT : 1
        const total = near.reduce((sum, other) => sum + weight(other), 0)
        return total ? near.reduce((sum, other) => sum + weight(other) * cross.get(other)!, 0) / total : cross.get(id)!
      })
      const placed = [...desired]
      for (let index = 1; index < placed.length; index++) placed[index] = Math.max(placed[index], placed[index - 1] + separation(layer[index - 1], layer[index]))
      const shift = placed.reduce((sum, value, index) => sum + desired[index] - value, 0) / placed.length
      layer.forEach((id, index) => cross.set(id, placed[index] + shift))
    }
  }
  // Open the branches towards the other side.
  if (rng && rng() < 0.5) for (const [id, centre] of cross) cross.set(id, -centre)

  // Main axis: each gap between ranks is wide enough for the labels of the arcs that cross it.
  const gaps = Array.from({ length: Math.max(rankCount - 1, 0) }, () => rankGap)
  for (const arc of forward) {
    const room = (horizontal ? arc.label.width : arc.label.height) + 2 * LABEL_MARGIN
    for (let r = rank[arc.source]; r < rank[arc.target]; r++) gaps[r] = Math.max(gaps[r], room)
  }
  const main: number[] = [0]
  gaps.forEach((gap, r) => main.push(main[r] + mainSize + gap))

  const minCross = Math.min(...[...cross].map(([id, centre]) => centre - size.get(id)! / 2))
  const positions: Record<string, Point> = {}
  for (const id of ids) {
    const along = main[rank[id]]
    const across = cross.get(id)! - crossSize / 2 - minCross
    positions[id] = horizontal ? { x: Math.round(along), y: Math.round(across) } : { x: Math.round(across), y: Math.round(along) }
  }
  const width = Math.max(...ids.map(id => positions[id].x)) + NODE_WIDTH
  const height = Math.max(...ids.map(id => positions[id].y)) + NODE_HEIGHT
  return { direction, positions, width, height, crossings }
}

const samePositions = (a: Record<string, Point>, b: Record<string, Point>) =>
  Object.keys(a).every(id => b[id] && Math.abs(a[id].x - b[id].x) < 1 && Math.abs(a[id].y - b[id].y) < 1)

/**
 * Lay out in the orientation that shows the workflow largest in a viewport of the given size.
 * With `seed`, return a variation instead: as readable as the best layout (at most one more
 * crossing, an orientation that still fits well) and different from `avoid`, the current positions.
 */
export function autoLayout(nodes: Record<string, LayoutNode>, start: string, viewport: { width: number; height: number }, labelSize?: (source: string, index: number) => LabelSize, options: { seed?: number; avoid?: Record<string, Point> } = {}): Layout {
  const scale = (layout: Layout) => Math.min(viewport.width / (layout.width || 1), viewport.height / (layout.height || 1))
  const horizontal = layeredLayout(nodes, start, 'horizontal', labelSize)
  const vertical = layeredLayout(nodes, start, 'vertical', labelSize)
  // Workflows read left to right; switch only when the vertical layout is clearly larger on screen.
  const best = scale(vertical) > scale(horizontal) * 1.1 ? vertical : horizontal
  if (!options.seed) return best
  const next = random(options.seed)
  const directions = [horizontal, vertical].filter(layout => scale(layout) >= scale(best) * 0.7).map(layout => layout.direction)
  for (let attempt = 0; attempt < VARIATION_ATTEMPTS; attempt++) {
    const direction = directions[Math.floor(next() * directions.length)]
    const variation = layeredLayout(nodes, start, direction, labelSize, { seed: Math.floor(next() * 2 ** 31) + 1 })
    if (variation.crossings <= best.crossings + EXTRA_CROSSINGS && !(options.avoid && samePositions(variation.positions, options.avoid))) return variation
  }
  return best
}

/** Rough on-screen size of an arc label: its text and, above it, the step's question (two lines at most). */
export function estimateLabelSize(text: string, question?: string): LabelSize {
  const textWidth = text ? text.length * 6.4 : 0
  const questionWidth = question ? Math.min(170, question.length * 5.4) : 0
  const questionLines = question ? (question.length * 5.4 > 170 ? 2 : 1) : 0
  return { width: Math.max(textWidth, questionWidth) + 12, height: 18 + questionLines * 12 }
}
