import { describe, expect, it } from 'vitest'
import { COLLAPSE_OVER, collapseFor, estimatedLines, shouldCollapse } from './collapse.ts'

describe('collapsing extra-long casts', () => {
  it('leaves ordinary casts alone', () => {
    expect(shouldCollapse('My most controversial take is that the only thing ketchup is ideal for is hot dogs')).toBe(false)
    expect(collapseFor('short', 'no')).toBeUndefined()
    expect(shouldCollapse('x'.repeat(45 * COLLAPSE_OVER))).toBe(false) // exactly at the limit
  })
  it('collapses a long single paragraph', () => {
    expect(shouldCollapse('x'.repeat(45 * COLLAPSE_OVER + 1))).toBe(true)
    expect(collapseFor('x'.repeat(1000), 'no')).toEqual({ lines: 6, color: '#ffffff' })
    expect(collapseFor('x'.repeat(1000), 'yes')).toEqual({ lines: 6, color: '#000000' })
  })
  it('counts line breaks: a list of short lines is long too', () => {
    const list = Array.from({ length: 12 }, (_, i) => `${i + 1}. point`).join('\n')
    expect(estimatedLines(list)).toBe(12)
    expect(shouldCollapse(list)).toBe(true)
    expect(estimatedLines('a\n\nb')).toBe(3)
  })
  it('ignores trailing whitespace', () => expect(shouldCollapse(`short${'\n'.repeat(20)}`)).toBe(false))
})
