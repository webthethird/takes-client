import { describe, expect, it } from 'vitest'
import { SEE_MORE_COLOR } from './collapse.ts'
import { CAST_BODY, schemeOf, SIDE_BORDER, SIDE_PALETTES } from './side-palette.ts'

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
  for (const scheme of ['light', 'dark'] as const) {
    for (const [side, p] of Object.entries(SIDE_PALETTES[scheme])) {
      it(`${scheme} ${side}: text 4.5:1, icons and border 3:1`, () => {
        for (const k of ['text', 'muted', 'accent', 'danger'] as const) expect(contrast(p[k], p.bg), k).toBeGreaterThanOrEqual(4.5)
        for (const k of ['text', 'muted'] as const) expect(contrast(p[k], p.pressed), `${k} pressed`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(p.accentText, p.accentFill), 'button').toBeGreaterThanOrEqual(4.5)
        for (const k of ['faint', 'liked'] as const) expect(contrast(p[k], p.bg), k).toBeGreaterThanOrEqual(3)
        expect(contrast(SEE_MORE_COLOR[scheme][side as 'yes' | 'no'], p.bg), 'See more').toBeGreaterThanOrEqual(4.5)
        const body = CAST_BODY[scheme][side as 'yes' | 'no']
        if (body) expect(contrast(body, p.bg), 'cast body').toBeGreaterThanOrEqual(4.5)
      })
    }
    it(`${scheme}: the no side's border shows against the page`, () => {
      // The no card shares the page's background, so its outline is all that marks it out.
      expect(contrast(SIDE_BORDER, SIDE_PALETTES[scheme].no.bg)).toBeGreaterThanOrEqual(3)
    })
  }
  it('matches the spec: yes is purple, black text in dark mode and white in light; no takes the page background', () => {
    expect(SIDE_PALETTES.dark.yes.text).toBe('#000000')
    expect(SIDE_PALETTES.light.yes.text).toBe('#ffffff')
    expect(SIDE_PALETTES.dark.no.bg).toBe('#000000')
    expect(SIDE_PALETTES.light.no.bg).toBe('#ffffff')
    expect(SIDE_BORDER).toBe(SIDE_PALETTES.dark.yes.bg)
    // The no side's body is the page's plain text color; its names stay purple.
    expect(CAST_BODY).toEqual({ dark: { no: '#ffffff' }, light: { no: '#000000' } })
  })
  it('follows the system scheme as Warpstack does', () => {
    expect(schemeOf('dark')).toBe('dark')
    expect(schemeOf('light')).toBe('light')
    expect(schemeOf(null)).toBe('light')
  })
})
