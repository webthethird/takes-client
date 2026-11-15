import { describe, expect, it } from 'vitest'
import { fillPage, type Hydrated } from './page.ts'

type Row = Hydrated<string, number>
const row = (cast: Row['cast'], after: number, rebuttal: Row['rebuttal'] = null): Row => ({ cast, rebuttal, after })

describe('fillPage', () => {
  it('keeps live casts up to the limit; the cursor is past the last row examined', () => {
    const r = fillPage([row('a', 1), row('b', 2), row('c', 3)], 0, 2)
    expect(r.kept.map(h => h.cast)).toEqual(['a', 'b'])
    expect(r).toMatchObject({ next: 2, stalled: false })
  })
  it('skips a deleted cast for good: the cursor moves past it', () => {
    const r = fillPage([row('a', 1), row('gone', 2), row('c', 3)], 0, 5)
    expect(r.kept.map(h => h.cast)).toEqual(['a', 'c'])
    expect(r.next).toBe(3)
  })
  it('ends the page before an unavailable cast, so the next page retries it (the rate-limit bug)', () => {
    const r = fillPage([row('a', 1), row('unavailable', 2), row('c', 3)], 0, 5)
    expect(r.kept.map(h => h.cast)).toEqual(['a'])
    expect(r).toMatchObject({ next: 1, stalled: true })
  })
  it('a refusal on the first row keeps nothing and does not move the cursor', () => {
    expect(fillPage([row('unavailable', 8), row('b', 9)], 7, 5)).toEqual({ kept: [], next: 7, stalled: true })
  })
  it('waits on an unavailable rebuttal too, but not on a deleted one', () => {
    expect(fillPage([row('a', 1, 'unavailable')], 0, 5)).toMatchObject({ kept: [], next: 0, stalled: true })
    expect(fillPage([row('a', 1, 'gone')], 0, 5).kept).toHaveLength(1)
  })
  it('a full page never stalls on rows past the limit', () => {
    expect(fillPage([row('a', 1), row('unavailable', 2)], 0, 1)).toMatchObject({ next: 1, stalled: false })
  })
})
