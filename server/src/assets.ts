import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Locate a build asset (runner bundle or UI). When bundled, assets sit next to
 * visage.js; in development they live in server/build and frontend/dist.
 */
export function assetPath(name: 'flow.mjs' | 'ui'): string | null {
  const candidates = name === 'ui'
    ? [join(here, 'ui'), join(here, '..', 'build', 'ui'), join(here, '..', '..', 'frontend', 'dist')]
    : [join(here, name), join(here, '..', 'build', name)]
  return candidates.find(path => existsSync(path)) ?? null
}
