import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEXT } from '../../frontend/src/typography.ts'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '../../frontend/src/style.css'), 'utf8')

test('the editor type scale is declared once and mirrored in TypeScript', () => {
  const declared = [...css.matchAll(/--text-(\w+):(\d+)px/g)].map(match => [match[1], Number(match[2])])
  assert.deepEqual(declared, Object.entries(TEXT))
  for (const [token, size] of Object.entries(TEXT)) assert.ok(size >= 11, `${token} is ${size}px, below the 11px floor`)
})

test('interface text uses the type scale instead of ad-hoc pixel sizes', () => {
  const sizes = [...css.matchAll(/font-size:([^;}]+)/g)].map(match => match[1].trim())
  const literals = sizes.filter(value => /\d+px/.test(value)).sort()
  // The only exceptions are the × glyphs, which are icon metrics rather than text.
  assert.deepEqual(literals, ['16px', '18px'])
  for (const value of sizes) {
    if (value === '16px' || value === '18px') continue
    assert.match(value, /^(var\(--text-\w+\)(!important)?|[\d.]+em)$/, `unexpected font-size: ${value}`)
  }
  for (const match of css.matchAll(/font:([^;}]+)/g)) assert.doesNotMatch(match[1], /\d+px/, `font shorthand still uses a pixel size: ${match[1]}`)
})
