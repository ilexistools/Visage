import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultPosition, edgeId, layoutEdgePorts, NODE_HEIGHT as H, NODE_WIDTH as W, PORT_SLOTS, portId, spreadSlots, type EdgePorts, type PortSide } from '../../frontend/src/edgeLayout.ts'

type Nodes = Record<string, { position?: { x: number; y: number }; terminal?: boolean; next?: { goto: string }[] }>
type Point = { x: number; y: number }

const point = (pos: Point, side: PortSide, offset: number): Point => ({
  left: { x: pos.x, y: pos.y + H * offset / 100 },
  right: { x: pos.x + W, y: pos.y + H * offset / 100 },
  top: { x: pos.x + W * offset / 100, y: pos.y },
  bottom: { x: pos.x + W * offset / 100, y: pos.y + H },
})[side]

const orientation = (p: Point, q: Point, r: Point) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
const crosses = (a: Point, b: Point, c: Point, d: Point) => orientation(a, b, c) * orientation(a, b, d) < 0 && orientation(c, d, a) * orientation(c, d, b) < 0

/** Count ports shared by two arcs and crossings between straight lines joining each arc's ports. */
function measure(nodes: Nodes) {
  const ports = layoutEdgePorts(nodes)
  const ids = Object.keys(nodes)
  const position = (id: string) => nodes[id].position ?? defaultPosition(ids.indexOf(id))
  const spots = new Map<string, number>()
  const segments: [Point, Point][] = []
  for (const [source, node] of Object.entries(nodes)) {
    ;(node.terminal ? [] : node.next ?? []).forEach((next, index) => {
      const port: EdgePorts = ports[edgeId(source, next.goto, index)]
      for (const spot of [`${source}:${port.sourceSide}:${Math.round(port.sourceOffset)}`, `${next.goto}:${port.targetSide}:${Math.round(port.targetOffset)}`]) spots.set(spot, (spots.get(spot) ?? 0) + 1)
      segments.push([point(position(source), port.sourceSide, port.sourceOffset), point(position(next.goto), port.targetSide, port.targetOffset)])
    })
  }
  let crossings = 0
  segments.forEach((a, i) => segments.slice(i + 1).forEach(b => { if (crosses(a[0], a[1], b[0], b[1])) crossings++ }))
  return { shared: [...spots.values()].filter(count => count > 1).length, crossings }
}

const scenarios: Record<string, Nodes> = {
  'arcs in both directions': { a: { position: { x: 0, y: 0 }, next: [{ goto: 'b' }] }, b: { position: { x: 400, y: 0 }, next: [{ goto: 'a' }, { goto: 'c' }] }, c: { position: { x: 800, y: 0 }, terminal: true } },
  'fan-out listed out of order': { a: { position: { x: 0, y: 200 }, next: [{ goto: 'd' }, { goto: 'b' }, { goto: 'c' }] }, b: { position: { x: 400, y: 0 }, terminal: true }, c: { position: { x: 400, y: 200 }, terminal: true }, d: { position: { x: 400, y: 400 }, terminal: true } },
  'review loop with a fix step': { draft: { position: { x: 0, y: 0 }, next: [{ goto: 'review' }] }, review: { position: { x: 350, y: 0 }, next: [{ goto: 'done' }, { goto: 'draft' }, { goto: 'fix' }] }, fix: { position: { x: 350, y: 250 }, next: [{ goto: 'draft' }, { goto: 'review' }] }, done: { position: { x: 700, y: 0 }, terminal: true } },
  'self-loop': { a: { position: { x: 0, y: 0 }, next: [{ goto: 'a' }, { goto: 'b' }] }, b: { position: { x: 400, y: 0 }, terminal: true } },
  'diagonal round trip': {
    especificar: { position: { x: -524, y: 442 }, next: [{ goto: 'implementar' }] },
    implementar: { position: { x: -160, y: 322 }, next: [{ goto: 'verificar' }] },
    verificar: { position: { x: -217, y: 562 }, next: [{ goto: 'concluido' }, { goto: 'corrigir' }] },
    corrigir: { position: { x: 246, y: 794 }, next: [{ goto: 'verificar' }] },
    concluido: { position: { x: 312, y: 333 }, terminal: true },
  },
  'nodes without positions': { a: { next: [{ goto: 'b' }, { goto: 'c' }] }, b: { next: [{ goto: 'c' }] }, c: { terminal: true } },
}

for (const [name, nodes] of Object.entries(scenarios)) {
  test(`edge layout gives every arc its own ports without crossings: ${name}`, () => {
    assert.deepEqual(measure(nodes), { shared: 0, crossings: 0 })
  })
}

test('arcs between the same nodes use parallel ports in the same order at both ends', () => {
  const ports = layoutEdgePorts(scenarios['arcs in both directions'])
  const forward = ports['a::b::0']
  const back = ports['b::a::0']
  assert.equal(forward.sourceSide, back.targetSide)
  assert.equal(forward.targetSide, back.sourceSide)
  assert.equal(forward.sourceOffset < back.targetOffset, forward.targetOffset < back.sourceOffset)
})

test('ports on a side follow the position of the other node', () => {
  const ports = layoutEdgePorts(scenarios['fan-out listed out of order'])
  const offsets = ['a::b::1', 'a::c::2', 'a::d::0'].map(id => ports[id].sourceOffset)
  assert.ok(offsets[0] < offsets[1] && offsets[1] < offsets[2], JSON.stringify(offsets))
})

test('ports snap to the fixed connection points of the box', () => {
  for (const nodes of Object.values(scenarios)) {
    for (const port of Object.values(layoutEdgePorts(nodes))) {
      assert.equal(port.sourceHandle, portId(port.sourceSide, PORT_SLOTS[port.sourceSide].indexOf(port.sourceOffset)))
      assert.equal(port.targetHandle, portId(port.targetSide, PORT_SLOTS[port.targetSide].indexOf(port.targetOffset)))
    }
  }
})

test('ports on a side are spread along it and stay unique', () => {
  assert.deepEqual(spreadSlots(1, 5), [2])
  assert.deepEqual(spreadSlots(2, 5), [0, 4])
  assert.deepEqual(spreadSlots(3, 5), [0, 2, 4])
  assert.deepEqual(spreadSlots(4, 5), [0, 1, 3, 4])
  assert.deepEqual(spreadSlots(2, 3), [0, 2])
  const ports = layoutEdgePorts(scenarios['fan-out listed out of order'])
  assert.deepEqual(['a::b::1', 'a::c::2', 'a::d::0'].map(id => ports[id].sourceHandle), ['right-0', 'right-1', 'right-2'])
})

test('a full side overflows to the next best side instead of sharing a point', () => {
  const nodes: Nodes = { hub: { position: { x: 0, y: 300 }, next: [] } }
  for (let index = 0; index < 6; index++) {
    nodes[`n${index}`] = { position: { x: 500, y: index * 120 }, terminal: true }
    nodes.hub.next!.push({ goto: `n${index}` })
  }
  const ports = Object.values(layoutEdgePorts(nodes))
  const handles = ports.map(port => port.sourceHandle)
  assert.equal(new Set(handles).size, 6)
  assert.equal(handles.filter(handle => handle.startsWith('right-')).length, 3)
  assert.deepEqual(measure(nodes), { shared: 0, crossings: 0 })
})

test('a connection drawn from a chosen point keeps that point', () => {
  // The target is to the left, so automatic placement would use the left side.
  const nodes: Nodes = {
    a: { position: { x: 400, y: 0 }, next: [{ goto: 'b', source_handle: 'bottom-1', target_handle: 'top-3' } as any, { goto: 'c' }] },
    b: { position: { x: 0, y: 40 }, terminal: true },
    c: { position: { x: 400, y: 300 }, terminal: true },
  }
  const ports = layoutEdgePorts(nodes)
  assert.deepEqual([ports['a::b::0'].sourceHandle, ports['a::b::0'].targetHandle], ['bottom-1', 'top-3'])
  assert.equal(ports['a::c::1'].sourceSide, 'bottom')
  assert.notEqual(ports['a::c::1'].sourceHandle, 'bottom-1', 'automatic arcs avoid pinned points')
  const invalid = layoutEdgePorts({ a: { next: [{ goto: 'b', source_handle: 'bottom-9' } as any] }, b: { terminal: true } })
  assert.match(invalid['a::b::0'].sourceHandle, /^(top|bottom|left|right)-\d$/)
})

test('arc IDs stay unique when node IDs contain hyphens', () => {
  const ports = layoutEdgePorts({ a: { next: [{ goto: 'b-c' }] }, 'a-b': { next: [{ goto: 'c' }] }, 'b-c': { terminal: true }, c: { terminal: true } })
  assert.equal(Object.keys(ports).length, 2)
  assert.notEqual(edgeId('a', 'b-c', 0), edgeId('a-b', 'c', 0))
})
