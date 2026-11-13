import { describe, expect, it } from 'vitest'
import type { Claim } from '../schema.ts'
import {
  CHALLENGE_BAND, FOLLOWING_CREDIT, anchorToRoot, chooseClaim, interleave, pickRebuttal, rankFeed, reconcileStance, scoreCard, type ReplyStance,
} from './score.ts'

describe('interleave', () => {
  it('puts a resurfaced card in every n-th slot', () => {
    expect(interleave(['f1', 'f2', 'f3', 'f4', 'f5', 'f6'], ['o1', 'o2'], 4)).toEqual(['f1', 'f2', 'f3', 'o1', 'f4', 'f5', 'f6', 'o2'])
  })
  it('fills from whichever list remains, losing nothing', () => {
    expect(interleave(['f1'], ['o1', 'o2'], 4)).toEqual(['f1', 'o1', 'o2'])
    expect(interleave([], ['o1'], 4)).toEqual(['o1'])
    expect(interleave(['f1', 'f2'], [], 4)).toEqual(['f1', 'f2'])
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

describe('rankFeed: following reorders within a band, never across', () => {
  const row = (hash: string, fid: number, band: number, credit: number, ts = 100) => ({ hash, fid, band, credit, ts })

  it('a followed author beats an equally debatable stranger', () => {
    const ranked = rankFeed([row('0x01', 10, 7, 0), row('0x02', 20, 7, 0)], new Set([20]))
    expect(ranked.map(r => r.hash)).toEqual(['0x02', '0x01'])
    expect(ranked[0]!.following).toBe(true)
  })
  it('a followed author never beats a stranger one band up, even with full credit', () => {
    const ranked = rankFeed([row('0x01', 10, 7, 0), row('0x02', 20, 6, 0.99)], new Set([20]))
    expect(ranked.map(r => r.hash)).toEqual(['0x01', '0x02'])
  })
  it('within-band credit can outweigh following', () => {
    // A live two-sided argument (0.5) beats a followed author with no corroboration (0.3).
    expect(FOLLOWING_CREDIT).toBeLessThan(0.5)
    const ranked = rankFeed([row('0x01', 10, 7, 0.5), row('0x02', 20, 7, 0)], new Set([20]))
    expect(ranked.map(r => r.hash)).toEqual(['0x01', '0x02'])
  })
  it('is a total order: newer first, then hash', () => {
    const ranked = rankFeed([row('0x02', 1, 5, 0, 100), row('0x01', 1, 5, 0, 100), row('0x03', 1, 5, 0, 200)], new Set())
    expect(ranked.map(r => r.hash)).toEqual(['0x03', '0x01', '0x02'])
  })
  it('band arithmetic matches CHALLENGE_BAND', () => expect(CHALLENGE_BAND).toBe(0.1))
})
