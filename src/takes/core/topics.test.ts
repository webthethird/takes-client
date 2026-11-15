import { describe, expect, it } from 'vitest'
import { cardTopics, fromAssignment, MIN_TAB_CARDS, tabsFrom, TOPICS } from './topics.ts'

describe('topics', () => {
  it('ids are unique and slug-shaped (they are permanent: tabs and links use them)', () => {
    const ids = TOPICS.map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/)
    expect(ids).not.toContain('other')
  })

  it('stores a main topic and a distinct second', () => {
    expect(fromAssignment({ primary: 'crypto', secondary: 'farcaster' })).toEqual({ primary: 'crypto', secondary: 'farcaster' })
    expect(fromAssignment({ primary: 'crypto', secondary: 'none' })).toEqual({ primary: 'crypto', secondary: null })
    expect(fromAssignment({ primary: 'crypto', secondary: 'crypto' })).toEqual({ primary: 'crypto', secondary: null })
  })

  it('a market in Other has no second topic, and is in no tab', () => {
    expect(fromAssignment({ primary: 'other', secondary: 'farcaster' })).toEqual({ primary: 'other', secondary: null })
    expect(cardTopics({ primary: 'other', secondary: null })).toEqual({ a: null, b: null })
    expect(cardTopics(undefined)).toEqual({ a: null, b: null })
  })

  it('an id that is not a topic counts as none', () => {
    expect(fromAssignment({ primary: 'sport', secondary: 'none' })).toEqual({ primary: 'other', secondary: null })
    expect(fromAssignment({ primary: 'ai', secondary: 'gaming' })).toEqual({ primary: 'ai', secondary: null })
  })

  it('tabs: busiest first, sparse ones hidden, ties in list order', () => {
    const tabs = tabsFrom(new Map([['ai', 9], ['crypto', 30], ['farcaster', 9], ['art', MIN_TAB_CARDS - 1], ['nope', 50]]))
    expect(tabs.map(t => [t.id, t.cards])).toEqual([['crypto', 30], ['farcaster', 9], ['ai', 9]])
  })
})
