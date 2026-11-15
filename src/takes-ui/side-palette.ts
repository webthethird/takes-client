// The two sides of a debate, by color: "yes" to the card's question is purple, with black text
// in dark mode and white text in light mode; "no" takes the page's own background, light or dark as the browser is set, with purple text
// and a purple border. A cast card, a rebuttal and the "Back this take" / "Challenge it" boxes
// all wear the color of the side they argue.
//
// These are whole Warpstack palettes, so the stock CastCard renders inside one unchanged (via
// ColorsOverride, which patches/@warpstack__ui@0.1.0.patch adds). side-palette.test.ts holds
// them to the same contrast bar as Warpstack's own: text 4.5:1, icons and borders 3:1. That bar
// is why light mode uses deeper purples: #866aff is 3.8:1 against white, enough for a border
// but not for text, so the light "no" side's text and the light "yes" side's fill go deeper.

import type { useColors } from '@warpstack/ui'

export type Side = 'yes' | 'no'
type Colors = ReturnType<typeof useColors>

/** The purple both sides share: the yes card's fill, the no card's border and text. */
export const PURPLE = '#866aff'

export type Scheme = 'light' | 'dark'
/** Matches Warpstack's useColors: the system color scheme, light unless it says dark. */
export const schemeOf = (system: string | null | undefined): Scheme => (system === 'dark' ? 'dark' : 'light')

/** Every side-colored element's outline, in both schemes. */
export const SIDE_BORDER = PURPLE

/** Dark mode's yes side: the brand purple with black text. */
const YES_DARK: Colors = {
  bg: PURPLE, surface: PURPLE, text: '#000000', muted: '#1a0f3d', faint: '#2d1f66', border: '#2d1f66',
  accent: '#000000', accentFill: '#000000', accentText: PURPLE, danger: '#000000', liked: '#000000',
  pressed: '#9a84ff', field: '#9a84ff',
}

/**
 * Light mode's yes side: white text, so a deeper purple than dark mode's. #6246e0 is the
 * lightest that holds white (6.0:1), its lavender secondary text (4.5:1) and icons (3.3:1).
 */
const YES_LIGHT: Colors = {
  bg: '#6246e0', surface: '#6246e0', text: '#ffffff', muted: '#e2daff', faint: '#c4b5ff', border: '#c4b5ff',
  accent: '#ffffff', accentFill: '#ffffff', accentText: '#6246e0', danger: '#ffffff', liked: '#ffffff',
  pressed: '#583cd2', field: '#583cd2',
}

export const SIDE_PALETTES: Record<Scheme, Record<Side, Colors>> = {
  dark: {
    yes: YES_DARK,
    no: {
      bg: '#000000', surface: '#000000', text: '#a48bff', muted: PURPLE, faint: '#6f58c9', border: PURPLE,
      accent: '#a48bff', accentFill: '#7556e8', accentText: '#ffffff', danger: '#f97066', liked: '#f0446a',
      pressed: '#140d2e', field: '#140d2e',
    },
  },
  light: {
    yes: YES_LIGHT,
    no: {
      bg: '#ffffff', surface: '#ffffff', text: '#4a2fc0', muted: '#5b3fd6', faint: '#8f7ae0', border: PURPLE,
      accent: '#5b3fd6', accentFill: '#5b3fd6', accentText: '#ffffff', danger: '#d92d20', liked: '#d51338',
      pressed: '#f3f0ff', field: '#f3f0ff',
    },
  },
}

export const opposite = (s: Side): Side => (s === 'yes' ? 'no' : 'yes')
