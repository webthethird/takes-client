// Which casts are collapsed on a debate card: the extra-long ones, so one essay doesn't push the
// feed off the screen. A collapsed cast shows its first COLLAPSED_LINES lines and a "See
// more" toggle in a color that stands out on each card (SEE_MORE_COLOR) (CastCard's `collapse`, added by patches/@warpstack__ui@0.1.0.patch).
//
// Decided from the text, not from layout: React Native on the web doesn't report how many
// lines a text rendered to. So the estimate assumes a phone-width line (CHARS_PER_LINE), and
// only casts well past the clamp are collapsed (COLLAPSE_OVER), so that on a wider screen,
// where lines hold more, the clamp still hides something worth a "See more".

export const COLLAPSED_LINES = 6
export const COLLAPSE_OVER = 10
const CHARS_PER_LINE = 45

/** Lines the text takes at phone width: each paragraph wraps, and blank lines count. */
export const estimatedLines = (text: string): number =>
  text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / CHARS_PER_LINE)), 0)

export const shouldCollapse = (text: string): boolean => estimatedLines(text.trim()) > COLLAPSE_OVER

/** The toggle's color on each side's card: the opposite of each card's background, for contrast. */
export const SEE_MORE_COLOR = {
  dark: { yes: '#000000', no: '#ffffff' },
  light: { yes: '#ffffff', no: '#000000' },
} as const

export const collapseFor = (text: string, side: 'yes' | 'no', scheme: 'light' | 'dark') =>
  shouldCollapse(text) ? { lines: COLLAPSED_LINES, color: SEE_MORE_COLOR[scheme][side] } : undefined
