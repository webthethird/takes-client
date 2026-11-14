// The two sides of a debate, by color: "yes" to the card's question is purple with black text,
// "no" is black with purple text and a purple border. A cast card, a rebuttal and the "Back
// this take" / "Challenge it" boxes all wear the color of the side they argue, whatever the
// system color scheme.
//
// These are whole Warpstack palettes, so the stock CastCard renders inside one unchanged (via
// ColorsOverride, which patches/@warpstack__ui@0.1.0.patch adds). side-palette.test.ts holds
// them to the same contrast bar as Warpstack's own: text 4.5:1, icons 3:1.

import type { useColors } from '@warpstack/ui'

export type Side = 'yes' | 'no'
type Colors = ReturnType<typeof useColors>

/** The purple both sides share: the yes card's fill, the no card's border and text. */
export const PURPLE = '#866aff'

export const SIDE_PALETTES: Record<Side, Colors> = {
  yes: {
    bg: PURPLE, surface: PURPLE, text: '#000000', muted: '#1a0f3d', faint: '#2d1f66', border: '#2d1f66',
    accent: '#000000', accentFill: '#000000', accentText: PURPLE, danger: '#000000', liked: '#000000',
    pressed: '#9a84ff', field: '#9a84ff',
  },
  no: {
    bg: '#000000', surface: '#000000', text: '#a48bff', muted: PURPLE, faint: '#6f58c9', border: PURPLE,
    accent: '#a48bff', accentFill: '#7556e8', accentText: '#ffffff', danger: '#f97066', liked: '#f0446a',
    pressed: '#140d2e', field: '#140d2e',
  },
}

export const opposite = (s: Side): Side => (s === 'yes' ? 'no' : 'yes')
