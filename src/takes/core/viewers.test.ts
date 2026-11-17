import { describe, expect, it } from 'vitest'
import { followsToRefresh, parseViewerQuery, planStage1, statusOf } from './viewers.ts'

const c = (hash: string) => ({ hash })
const hashes = (xs: Array<{ hash: string; lane: string }>) => xs.map(x => `${x.lane[0]}:${x.hash}`)

describe('parseViewerQuery', () => {
  it('reads FIDs and usernames, with or without the @', () => {
    expect(parseViewerQuery('374565')).toEqual({ fid: 374565 })
    expect(parseViewerQuery(' @Links ')).toEqual({ username: 'links' })
    expect(parseViewerQuery('andreaboi.eth')).toEqual({ username: 'andreaboi.eth' })
    expect(parseViewerQuery('vitalik.eth')).toEqual({ username: 'vitalik.eth' })
  })
  it('rejects what can be neither, so the node is never asked', () => {
    for (const bad of ['', '@', '0', 'a b', 'x'.repeat(17), 'https://evil', 'name.com', '../etc', '-dash']) {
      expect(parseViewerQuery(bad), bad).toBeNull()
    }
  })
})

describe('planStage1', () => {
  it("follows first: viewers take turns, newest viewer's backlog first, then steady, then global", () => {
    const plan = planStage1({ backlogs: [[c('a1'), c('a2'), c('a3')], [c('b1')]], steady: [c('s1')], global: [c('g1')], budget: 20 })
    expect(hashes(plan)).toEqual(['f:a1', 'f:b1', 'f:a2', 'f:a3', 'f:s1', 'g:g1'])
  })
  it('keeps 25% of the budget for the network-wide lanes when they have work', () => {
    const follows = Array.from({ length: 50 }, (_, i) => c(`f${i}`))
    const global = Array.from({ length: 50 }, (_, i) => c(`g${i}`))
    const plan = planStage1({ backlogs: [follows], steady: [], global, budget: 40 })
    expect(plan).toHaveLength(40)
    expect(plan.filter(x => x.lane === 'following')).toHaveLength(30)
    expect(plan.filter(x => x.lane === 'global')).toHaveLength(10)
  })
  it('rounds the floor up, so even a budget of 1 can reach the network', () => {
    const plan = planStage1({ backlogs: [[c('f')]], steady: [], global: [c('g')], budget: 1 })
    expect(hashes(plan)).toEqual(['g:g'])
  })
  it("gives either side's unused share to the other", () => {
    expect(planStage1({ backlogs: [], steady: [], global: Array.from({ length: 9 }, (_, i) => c(`g${i}`)), budget: 8 })).toHaveLength(8)
    const fewGlobal = planStage1({ backlogs: [Array.from({ length: 20 }, (_, i) => c(`f${i}`))], steady: [], global: [c('g')], budget: 8 })
    expect(fewGlobal.filter(x => x.lane === 'following')).toHaveLength(7)
    expect(fewGlobal.filter(x => x.lane === 'global')).toHaveLength(1)
  })
  it('lists each cast once, at its first place', () => {
    const plan = planStage1({ backlogs: [[c('x'), c('y')], [c('x')]], steady: [c('y')], global: [c('x'), c('z')], budget: 10 })
    expect(hashes(plan)).toEqual(['f:x', 'f:y', 'g:z'])
  })
  it('a budget of 0 plans nothing', () => {
    expect(planStage1({ backlogs: [[c('a')]], steady: [], global: [c('g')], budget: 0 })).toEqual([])
  })
})

describe('followsToRefresh', () => {
  const v = (fid: number, firstSeen: number, followsTs: number | null) => ({ fid, firstSeen, followsTs })
  it('missing lists first (newest viewer first), then the stalest, up to n', () => {
    const now = 100_000
    const vs = [v(1, 10, 1_000), v(2, 50, null), v(3, 90, null), v(4, 20, 50_000), v(5, 30, 99_000)]
    expect(followsToRefresh(vs, now, 6 * 3600).map(x => x.fid)).toEqual([3, 2, 1])
    expect(followsToRefresh(vs, now, 6 * 3600, 4).map(x => x.fid)).toEqual([3, 2, 1, 4])
  })
})

describe('statusOf', () => {
  it('ready only once follows are loaded and caught up', () => {
    expect(statusOf({ followsTs: null, caughtUp: false })).toBe('personalizing')
    expect(statusOf({ followsTs: 5, caughtUp: false })).toBe('personalizing')
    expect(statusOf({ followsTs: 5, caughtUp: true })).toBe('ready')
  })
})
