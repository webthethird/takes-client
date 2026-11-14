import { describe, expect, it } from 'vitest'
import { SIDE_PALETTES } from './side-palette.ts'

// WCAG 2 relative luminance and contrast ratio.
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

describe('side palettes meet the contrast bar', () => {
  for (const [side, p] of Object.entries(SIDE_PALETTES)) {
    it(`${side}: text 4.5:1, icons 3:1`, () => {
      for (const k of ['text', 'muted', 'accent', 'danger'] as const) expect(contrast(p[k], p.bg), k).toBeGreaterThanOrEqual(4.5)
      for (const k of ['text', 'muted'] as const) expect(contrast(p[k], p.pressed), `${k} pressed`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.accentText, p.accentFill), 'button').toBeGreaterThanOrEqual(4.5)
      for (const k of ['faint', 'liked'] as const) expect(contrast(p[k], p.bg), k).toBeGreaterThanOrEqual(3)
    })
  }
  it('matches the spec: yes is purple with black text, no is black with purple text', () => {
    expect(SIDE_PALETTES.yes.text).toBe('#000000')
    expect(SIDE_PALETTES.no.bg).toBe('#000000')
    expect(SIDE_PALETTES.no.border).toBe(SIDE_PALETTES.yes.bg)
  })
})

import { SEE_MORE_COLOR } from './collapse.ts'
it('the "See more" toggle is readable on both sides', () => {
  for (const side of ['yes', 'no'] as const) expect(contrast(SEE_MORE_COLOR[side], SIDE_PALETTES[side].bg)).toBeGreaterThanOrEqual(4.5)
})
