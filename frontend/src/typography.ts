/**
 * Numeric mirror of the `--text-*` tokens in `style.css`.
 *
 * CSS is the source of truth for the editor's type scale; Monaco and React
 * Flow need numbers, so this module keeps those two consumers on the same
 * scale instead of repeating magic sizes in components.
 */
export const TEXT = {
  micro: 11,
  small: 12,
  body: 13,
  emphasis: 14,
  title: 16,
  heading: 18,
} as const

export const FONT_MONO = "'SFMono-Regular', Consolas, monospace"
