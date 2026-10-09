import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoLayout, estimateLabelSize, layeredLayout, type Layout } from '../../frontend/src/autoLayout.ts'
import { NODE_HEIGHT as H, NODE_WIDTH as W } from '../../frontend/src/edgeLayout.ts'

type Nodes = Record<string, { terminal?: boolean; next?: { goto: string }[]; on_fail?: string }>
const arcs = (...targets: string[]) => ({ next: targets.map(goto => ({ goto })) })

/** The six-step pilot workflow, with its repair loop and a give-up state. */
const PILOT: Nodes = {
  research: arcs('design'),
  design: arcs('build'),
  build: arcs('analyze'),
  analyze: arcs('review', 'fix', 'needs-human'),
  fix: arcs('analyze'),
  review: { ...arcs('delivered', 'build'), on_fail: 'needs-human' },
  delivered: { terminal: true },
  'needs-human': { terminal: true },
}

function assertNoOverlap(layout: Layout) {
  const boxes = Object.entries(layout.positions)
  for (const [i, [a, p]] of boxes.entries()) {
    for (const [b, q] of boxes.slice(i + 1)) {
      const apart = p.x + W <= q.x || q.x + W <= p.x || p.y + H <= q.y || q.y + H <= p.y
      assert.ok(apart, `${a} overlaps ${b}`)
    }
  }
}

test('steps are laid out along the flow without overlaps, loops pointing back', () => {
  const layout = layeredLayout(PILOT, 'research', 'horizontal')
  const x = (id: string) => layout.positions[id].x
  assertNoOverlap(layout)
  assert.ok(['research', 'design', 'build', 'analyze', 'review', 'delivered'].every((id, index, path) => index === 0 || x(path[index - 1]) < x(id)), 'the main path runs left to right')
  assert.ok(x('fix') > x('analyze'), 'the fix step comes after the step that sends work to it')
  assert.equal(layout.positions.research.x, 0)
  assert.deepEqual([layout.width, layout.height], [Math.max(...Object.values(layout.positions).map(p => p.x)) + W, Math.max(...Object.values(layout.positions).map(p => p.y)) + H])
})

test('a straight pipeline stays on one line', () => {
  const layout = layeredLayout({ a: arcs('b'), b: arcs('c'), c: { terminal: true } }, 'a', 'horizontal')
  assert.equal(new Set(Object.values(layout.positions).map(p => p.y)).size, 1)
})

test('crossings between ranks are removed', () => {
  // Declared in an order that crosses: a1 -> b2, a2 -> b1.
  const nodes: Nodes = { s: arcs('a1', 'a2'), a1: arcs('b2'), a2: arcs('b1'), b1: { terminal: true }, b2: { terminal: true } }
  const { positions: p } = layeredLayout(nodes, 's', 'horizontal')
  assert.equal(Math.sign(p.a1.y - p.a2.y), Math.sign(p.b2.y - p.b1.y), 'arcs between the two ranks do not cross')
})

test('the gap between ranks fits the widest label that crosses it', () => {
  const nodes: Nodes = { a: arcs('b'), b: arcs('c'), c: { terminal: true } }
  const wide = { width: 400, height: 20 }
  const layout = layeredLayout(nodes, 'a', 'horizontal', source => source === 'a' ? wide : { width: 10, height: 10 })
  const p = layout.positions
  assert.ok(p.b.x - (p.a.x + W) >= 400, 'the label of a -> b fits')
  assert.ok(p.c.x - (p.b.x + W) < 400, 'the next gap stays compact')
})

test('an arc that skips a rank keeps a free lane through it', () => {
  for (const direction of ['horizontal', 'vertical'] as const) {
    const { positions: p } = layeredLayout({ a: arcs('b', 'c'), b: arcs('c'), c: { terminal: true } }, 'a', direction, () => ({ width: 120, height: 30 }))
    const centre = (id: string) => ({ x: p[id].x + W / 2, y: p[id].y + H / 2 })
    // Sample the straight line from a to c: it never enters b's box.
    const [from, to] = [centre('a'), centre('c')]
    for (let t = 0; t <= 1; t += 0.02) {
      const x = from.x + (to.x - from.x) * t, y = from.y + (to.y - from.y) * t
      assert.ok(!(x > p.b.x && x < p.b.x + W && y > p.b.y && y < p.b.y + H), `${direction}: a -> c crosses b`)
    }
  }
})

test('on_fail routes, which the canvas does not draw, do not stretch the layout', () => {
  const { positions: p } = layeredLayout({ a: { ...arcs('b', 'stop'), on_fail: 'z' } as never, b: arcs('done'), done: { terminal: true }, stop: { terminal: true }, z: { terminal: true } }, 'a', 'horizontal')
  assert.equal(p.stop.x, p.b.x, 'stop sits right after a')
})

test('the orientation that fits the viewport best is chosen', () => {
  const chain: Nodes = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`s${i}`, i < 5 ? arcs(`s${i + 1}`) : { terminal: true }]))
  assert.equal(autoLayout(chain, 's0', { width: 1400, height: 600 }).direction, 'horizontal')
  assert.equal(autoLayout(chain, 's0', { width: 500, height: 1400 }).direction, 'vertical')
  assertNoOverlap(autoLayout(PILOT, 'research', { width: 500, height: 1400 }))
})

test('unreachable nodes, self-loops, a missing start and an empty workflow are handled', () => {
  const layout = layeredLayout({ a: arcs('a', 'b'), b: { terminal: true }, lonely: { terminal: true }, ghost: arcs('nowhere') }, 'missing', 'horizontal')
  assert.deepEqual(Object.keys(layout.positions).sort(), ['a', 'b', 'ghost', 'lonely'])
  assertNoOverlap(layout)
  assert.deepEqual(layeredLayout({}, '', 'horizontal'), { direction: 'horizontal', positions: {}, width: 0, height: 0, crossings: 0 })
})

test('seeds give different arrangements that stay as readable as the best one', () => {
  const viewport = { width: 1500, height: 900 }
  const best = autoLayout(PILOT, 'research', viewport)
  const seen = new Set([JSON.stringify(best.positions)])
  let previous = best.positions
  for (let seed = 1; seed <= 12; seed++) {
    const variation = autoLayout(PILOT, 'research', viewport, undefined, { seed, avoid: previous })
    assertNoOverlap(variation)
    assert.ok(variation.crossings <= best.crossings + 1, `seed ${seed}: ${variation.crossings} crossings, best has ${best.crossings}`)
    assert.notDeepEqual(variation.positions, previous, `seed ${seed} repeats the current arrangement`)
    assert.deepEqual(autoLayout(PILOT, 'research', viewport, undefined, { seed, avoid: previous }), variation, 'a seed always gives the same layout')
    seen.add(JSON.stringify(variation.positions))
    previous = variation.positions
  }
  assert.ok(seen.size >= 6, `only ${seen.size} distinct arrangements`)
  const x = (id: string) => best.positions[id]
  assert.ok(['research', 'design', 'build', 'analyze'].every((id, i, path) => !i || (best.direction === 'horizontal' ? x(path[i - 1]).x < x(id).x : x(path[i - 1]).y < x(id).y)), 'without a seed the layout is unchanged')
})

test('label sizes account for the question shown above the arc text', () => {
  assert.ok(estimateLabelSize('approved').width < estimateLabelSize('approved', 'Is the draft ready to publish to the blog today?').width)
  assert.ok(estimateLabelSize('x', 'q'.repeat(200)).width <= 182, 'questions wrap at the label width')
  assert.ok(estimateLabelSize('x', 'q'.repeat(200)).height > estimateLabelSize('x', 'short?').height)
})
