import { describe, expect, it } from 'vitest'
import type { Claim } from '../schema.ts'
import {
  CHALLENGE_BAND, FEED_START, anchorToRoot, chooseClaim, decodeCursor, encodeCursor, mergeAll, mergeFeed, pickRebuttal, rankFeed, reconcileStance, scoreCard, toLanes, type Lanes, type ReplyStance,
} from './score.ts'

const lanes = (following: string[], others: string[]): Lanes<string> => ({ following, others })
const none = lanes([], [])

describe('mergeFeed: pages resume the same sequence', () => {
  const fresh = lanes(['F1', 'F2', 'F3', 'F4'], ['f1', 'f2', 'f3'])
  const old = lanes(['O1'], ['o1', 'o2'])
  it('any page split concatenates to the unpaged feed', () => {
    const whole = mergeAll(fresh, old, 4)
    expect(whole).toHaveLength(10)
    for (const size of [1, 2, 3, 5, 7]) {
      const got: string[] = []
      let at = FEED_START
      for (;;) {
        const page = mergeFeed(fresh, old, 4, at, size)
        if (page.length === 0) break
        got.push(...page.map(e => e.item))
        at = page[page.length - 1]!.after
      }
      expect(got).toEqual(whole)
    }
  })
  it('marks resurfaced rows and reports the cursor past each', () => {
    const page = mergeFeed(fresh, old, 4, { ff: 2, fo: 1, of: 0, oo: 0 }, 2)
    expect(page.map(e => [e.item, e.resurfaced])).toEqual([['O1', true], ['f2', false]])
    expect(page[1]!.after).toEqual({ ff: 2, fo: 2, of: 1, oo: 0 })
  })
})

describe('mergeFeed: the viewer\'s graph gets half the slots, not more', () => {
  it('alternates follows and others, follows first, each in rank order', () => {
    expect(mergeAll(lanes(['F1', 'F2', 'F3'], ['f1', 'f2', 'f3']), none, 4)).toEqual(['F1', 'f1', 'F2', 'f2', 'F3', 'f3'])
  })
  it('keeps the split within one card at every point, while both lanes last', () => {
    const feed = mergeAll(lanes(Array.from({ length: 50 }, (_, i) => `F${i}`), Array.from({ length: 50 }, (_, i) => `f${i}`)), none, 4)
    let diff = 0
    for (const c of feed) { diff += c.startsWith('F') ? 1 : -1; expect(Math.abs(diff)).toBeLessThanOrEqual(1) }
  })
  it('when one lane runs out, the other fills the rest, losing nothing', () => {
    expect(mergeAll(lanes(['F1', 'F2', 'F3', 'F4'], ['f1']), none, 4)).toEqual(['F1', 'f1', 'F2', 'F3', 'F4'])
    expect(mergeAll(lanes([], ['f1', 'f2']), none, 4)).toEqual(['f1', 'f2']) // no viewer: no follows
  })
  it('splits resurfaced cards the same way, in every n-th slot', () => {
    expect(mergeAll(lanes(['F1', 'F2', 'F3'], ['f1', 'f2', 'f3']), lanes(['O1'], ['o1']), 4))
      .toEqual(['F1', 'f1', 'F2', 'O1', 'f2', 'F3', 'f3', 'o1'])
  })
  it('fills from whichever stream remains', () => {
    expect(mergeAll(lanes(['F1'], []), lanes(['O1'], ['o1']), 4)).toEqual(['F1', 'O1', 'o1'])
    expect(mergeAll(none, none, 4)).toEqual([])
  })
})

describe('feed cursors', () => {
  it('round-trips, starts at the top when absent, and rejects junk and the old two-part form', () => {
    expect(decodeCursor(encodeCursor({ ff: 12, fo: 3, of: 1, oo: 0 }))).toEqual({ ff: 12, fo: 3, of: 1, oo: 0 })
    expect(decodeCursor(null)).toEqual(FEED_START)
    expect(decodeCursor('12.3')).toBeNull()
    expect(decodeCursor('-1.0.0.0')).toBeNull()
    expect(decodeCursor('1.2.3.4.5')).toBeNull()
  })
})

const claim = (over: Partial<Claim> = {}): Claim => ({
  question: 'Was the $SNAP airdrop fair?', answer: 'no', claim_type: 'evaluative', aspect: 'fairness',
  confidence: 1, challengeability: 0.8, externally_resolvable: false, challenge_reason: 'Farmers were the users.', ...over,
})
const reply = (fid: number, stance: ReplyStance['stance'], over: Partial<ReplyStance> = {}): ReplyStance =>
  ({ hash: `0x${fid.toString(16).padStart(4, '0')}`, fid, stance, confidence: 0.9, textLen: 120, ...over })

describe('chooseClaim', () => {
  it('drops externally resolvable claims, even the most challengeable', () => {
    const resolvable = claim({ question: 'Will $BTC hit $200k?', challengeability: 0.95, externally_resolvable: true })
    const judgment = claim({ challengeability: 0.6 })
    expect(chooseClaim([resolvable, judgment])).toBe(judgment)
    expect(chooseClaim([resolvable])).toBeNull()
  })
  it('picks by confidence-gated challengeability, not raw', () => {
    const shaky = claim({ challengeability: 0.9, confidence: 0.2 }) // gated 0.54
    const solid = claim({ challengeability: 0.7, confidence: 1 }) // gated 0.70
    expect(chooseClaim([shaky, solid])).toBe(solid)
  })
})

describe('scoreCard: both sides means different people', () => {
  it('a self-reply on the other side is not a debate', () => {
    const s = scoreCard({ fid: 1 }, claim({ answer: 'no' }), [reply(1, 'yes')])
    expect(s.bothSides).toBe(false)
    expect(s.yesAuthors).toBe(1) // the author counted on both sides, once each
  })
  it('Alice yes, Bob yes and no: Alice and Bob still disagree', () => {
    // Root (fid 1, Alice) answers yes; Bob (2) posts on both sides.
    const s = scoreCard({ fid: 1 }, claim({ answer: 'yes' }), [reply(2, 'yes'), reply(2, 'no', { hash: '0xb2' })])
    expect(s.bothSides).toBe(true)
  })
  it('counts people, not casts', () => {
    const s = scoreCard({ fid: 1 }, claim({ answer: 'no' }), [reply(2, 'yes'), reply(2, 'yes', { hash: '0xff' }), reply(3, 'off_topic')])
    expect(s.yesAuthors).toBe(1)
    expect(s.noAuthors).toBe(1)
  })
  it('an exact band edge lands in that band, not below it', () => {
    expect(scoreCard({ fid: 1 }, claim({ challengeability: 0.7, confidence: 1 }), []).band).toBe(7)
  })
})

describe('pickRebuttal', () => {
  it('ignores the author, off-topic replies and agreement', () => {
    const r = pickRebuttal(1, 'no', [reply(1, 'yes'), reply(2, 'off_topic'), reply(3, 'no')])
    expect(r).toBeNull()
  })
  it('prefers a developed counter-argument over a confident one-liner', () => {
    const terse = reply(2, 'yes', { confidence: 1, textLen: 10 }) // 1.0 * 0.45
    const developed = reply(3, 'yes', { confidence: 0.8, textLen: 200 }) // 0.8 * 1.0
    expect(pickRebuttal(1, 'no', [terse, developed])).toBe(developed)
  })
  it('is deterministic on ties', () => {
    const a = reply(2, 'yes', { hash: '0xaa' })
    const b = reply(3, 'yes', { hash: '0xbb' })
    expect(pickRebuttal(1, 'no', [b, a])).toBe(a)
    expect(pickRebuttal(1, 'no', [a, b])).toBe(a)
  })
})

describe('anchorToRoot: a direct reply is judged against stage 1, not a re-reading', () => {
  // The live case: root argues "security paranoia holds you back" (really YES on "Is distrust
  // of signer security a hindrance?"), stage 1 stored NO; a reply agrees and stage 2 read the
  // root as YES. Unanchored, the reply came out YES and showed as a rebuttal to a NO author.
  const reply = { parent_stance: 'yes' as const, agreement: 'agree' as const, stance: 'yes' as const, explicit_reversal: false }

  it('an agreeing reply lands on the author\'s stored side, so it is never a rebuttal', () => {
    const { anchored, conflict } = anchorToRoot(reply, 'no')
    expect(reconcileStance(anchored)).toEqual({ stance: 'no', corrected: true })
    expect(conflict).toBe(true)
    expect(pickRebuttal(1, 'no', [{ hash: '0x02', fid: 2, stance: reconcileStance(anchored).stance, confidence: 0.85, textLen: 150 }]))
      .toBeNull()
  })
  it('a disagreeing reply still lands on the other side', () => {
    const { anchored } = anchorToRoot({ ...reply, agreement: 'disagree' as const, stance: 'no' as const }, 'no')
    expect(reconcileStance(anchored).stance).toBe('yes')
  })
  it('no conflict when the readings match, or the model saw no stance in the root', () => {
    expect(anchorToRoot(reply, 'yes').conflict).toBe(false)
    expect(anchorToRoot({ ...reply, parent_stance: 'none' as const }, 'no').conflict).toBe(false)
  })
  it('anchoring also decides replies where the model saw no stance in the root', () => {
    // Without the anchor, parent_stance 'none' defers to the verdict; anchored, agreement decides.
    const { anchored } = anchorToRoot({ ...reply, parent_stance: 'none' as const, stance: 'yes' as const }, 'no')
    expect(reconcileStance(anchored).stance).toBe('no')
  })
})

describe('reconcileStance (ported cases)', () => {
  it('agreeing with a no parent is no, whatever the verdict said', () => {
    expect(reconcileStance({ parent_stance: 'no', agreement: 'agree', stance: 'yes', explicit_reversal: false }))
      .toEqual({ stance: 'no', corrected: true })
  })
  it('disagreeing with a no parent is yes', () => {
    expect(reconcileStance({ parent_stance: 'no', agreement: 'disagree', stance: 'yes', explicit_reversal: false }).stance).toBe('yes')
  })
  it('a self-reply keeps its stance without an explicit reversal', () => {
    expect(reconcileStance({ parent_stance: 'none', agreement: 'neither', stance: 'yes', explicit_reversal: false }, { rootStance: 'no' }))
      .toEqual({ stance: 'no', corrected: true })
    expect(reconcileStance({ parent_stance: 'none', agreement: 'neither', stance: 'yes', explicit_reversal: true }, { rootStance: 'no' }).stance)
      .toBe('yes')
  })
  it('defers to the model where the intermediates do not decide', () => {
    expect(reconcileStance({ parent_stance: 'none', agreement: 'agree', stance: 'no', explicit_reversal: false }))
      .toEqual({ stance: 'no', corrected: false })
    expect(reconcileStance({ parent_stance: 'yes', agreement: 'agree', stance: 'off_topic', explicit_reversal: false }).stance)
      .toBe('off_topic')
  })
})

describe('rankFeed: debatability alone orders cards', () => {
  const row = (hash: string, fid: number, band: number, credit: number, ts = 100) => ({ hash, fid, band, credit, ts })

  it('following does not move a card; it only marks its lane', () => {
    const ranked = rankFeed([row('0x01', 10, 7, 0.2), row('0x02', 20, 7, 0)], new Set([20]))
    expect(ranked.map(r => r.hash)).toEqual(['0x01', '0x02'])
    expect(toLanes(ranked).following.map(r => r.hash)).toEqual(['0x02'])
  })
  it('credit never crosses a band', () => {
    const ranked = rankFeed([row('0x01', 10, 6, 5), row('0x02', 20, 7, 0)], new Set())
    expect(ranked.map(r => r.hash)).toEqual(['0x02', '0x01'])
  })
  it('is a total order: newer first, then hash', () => {
    const ranked = rankFeed([row('0x02', 1, 5, 0, 100), row('0x01', 1, 5, 0, 100), row('0x03', 1, 5, 0, 200)], new Set())
    expect(ranked.map(r => r.hash)).toEqual(['0x03', '0x01', '0x02'])
  })
  it('band arithmetic matches CHALLENGE_BAND', () => expect(CHALLENGE_BAND).toBe(0.1))
})

import { MARKET_BOTH_SIDES_CREDIT, MARKET_RESURFACE_MIN_BAND, MARKET_TAKE_CREDIT, MAX_MARKET_TAKE_CREDIT, RESURFACE_MIN_BAND, resurfaces } from './score.ts'

describe('scoreCard: other casts arguing the same claim', () => {
  const alone = scoreCard({ fid: 1 }, claim(), [])
  it('credits each other author, capped, without changing the band', () => {
    const one = scoreCard({ fid: 1 }, claim(), [], { id: '0xm', otherAuthors: 1, bothSides: false, takes: 2 })
    expect(one.credit - alone.credit).toBeCloseTo(MARKET_TAKE_CREDIT)
    expect(one.band).toBe(alone.band)
    expect(one.marketTakes).toBe(2)
    const many = scoreCard({ fid: 1 }, claim(), [], { id: '0xm', otherAuthors: 20, bothSides: false, takes: 21 })
    expect(many.credit - alone.credit).toBeCloseTo(MAX_MARKET_TAKE_CREDIT)
  })
  it('credits a market whose casts take both sides, and never crosses into the next band', () => {
    const two = scoreCard({ fid: 1 }, claim(), [], { id: '0xm', otherAuthors: 1, bothSides: true, takes: 2 })
    expect(two.credit - alone.credit).toBeCloseTo(MARKET_TAKE_CREDIT + MARKET_BOTH_SIDES_CREDIT)
    const maxed = scoreCard({ fid: 1 }, claim(), [reply(2, 'no'), reply(3, 'no'), reply(4, 'yes'), reply(5, 'no')],
      { id: '0xm', otherAuthors: 9, bothSides: true, takes: 10 })
    expect(maxed.credit).toBeLessThan(1)
  })
  it('a cast alone in its market scores as before', () => {
    expect(scoreCard({ fid: 1 }, claim(), [], { id: '0xm', otherAuthors: 0, bothSides: false, takes: 1 })).toEqual(alone)
  })
})

describe('resurfaces: older casts that come back', () => {
  it('alone, only from RESURFACE_MIN_BAND', () => {
    expect(resurfaces(RESURFACE_MIN_BAND, 1)).toBe(true)
    expect(resurfaces(RESURFACE_MIN_BAND - 1, 1)).toBe(false)
  })
  it('argued in other casts too, from MARKET_RESURFACE_MIN_BAND', () => {
    expect(resurfaces(MARKET_RESURFACE_MIN_BAND, 2)).toBe(true)
    expect(resurfaces(MARKET_RESURFACE_MIN_BAND - 1, 5)).toBe(false)
  })
})

import { onePerMarket } from './score.ts'

describe('onePerMarket: a market\'s casts share one card', () => {
  const r = (hash: string, key: number, market_id: string | null, ts = 100) => ({ hash, key, ts, market_id })
  it('keeps only the best-ranked cast of each market, across fresh and resurfaced, in order', () => {
    const fresh = [r('a', 7.2, 'm1'), r('b', 6.5, null), r('c', 4.1, 'm1'), r('d', 3.0, 'm2')]
    const old = [r('e', 8.0, 'm2'), r('f', 5.0, null)]
    const kept = onePerMarket(fresh, old)
    expect(kept.fresh.map(x => x.hash)).toEqual(['a', 'b'])   // c loses to a; d loses to e
    expect(kept.old.map(x => x.hash)).toEqual(['e', 'f'])
  })
  it('breaks ties by recency, then hash, so pages stay stable', () => {
    expect(onePerMarket([r('a', 5, 'm', 100), r('b', 5, 'm', 200)], []).fresh.map(x => x.hash)).toEqual(['b'])
    expect(onePerMarket([r('b', 5, 'm'), r('a', 5, 'm')], []).fresh.map(x => x.hash)).toEqual(['a'])
  })
  it('a scored cast shows its market id only when the market has other casts', () => {
    expect(scoreCard({ fid: 1 }, claim(), [], { id: '0xm', otherAuthors: 1, bothSides: false, takes: 2 }).marketId).toBe('0xm')
    expect(scoreCard({ fid: 1 }, claim(), [], { id: '0xm', otherAuthors: 0, bothSides: false, takes: 1 }).marketId).toBeNull()
  })
})
