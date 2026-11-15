import { describe, expect, it } from 'vitest'
import {
  AMBIGUOUS_THRESHOLD, MATCH_THRESHOLD, canonicalAnswer, cosine, decodeEmbedding, encodeEmbedding, planMatch, questionHash,
  type MarketRef,
} from './market.ts'

describe('questionHash matches Solidity keccak256(bytes(question))', () => {
  // Reference values from Foundry: `cast keccak "<question>"` (UTF-8 bytes, as the factory hashes).
  const vectors: Array<[string, string]> = [
    ['', '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
    ['Was the $SNAP airdrop fair?', '0xb36c80764208996c8779f7959c6d71b310dba7bb14d4095e6660b181c449fc0d'],
    ['Is ketchup ideal for anything besides hot dogs?', '0xc189f0ab868699f8cdadcb82f34ba49fb49529b7ceebda889ac0c34b37d76400'],
    ['Is café culture overrated? 🔥', '0xb6a4e5e54c7f425a7606e45a8f80d04fe15fb712a501e2482aa6d4a372fb9d0f'],
  ]
  for (const [q, h] of vectors) it(JSON.stringify(q), () => expect(questionHash(q)).toBe(h))
})

/** Unit vectors in 2D at an angle: cosine(a, b) is exactly cos(angle). */
const at = (deg: number) => new Float32Array([Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)])
const angleFor = (sim: number) => (Math.acos(sim) * 180) / Math.PI
const market = (id: string, question: string, ...degs: number[]): MarketRef => ({ id, question, embeddings: degs.map(at) })

describe('planMatch', () => {
  const markets = [market('m1', 'Was the $SNAP airdrop fair?', 0), market('m2', 'Is Base the best L2?', 90)]

  it('identical text joins outright, whatever the embedding says', () => {
    expect(planMatch('Is Base the best L2?', at(0), markets)).toEqual({ kind: 'identical', market: markets[1], bridges: [markets[0]] })
  })
  it('at or above the match threshold: join (Claude checks polarity only)', () => {
    const p = planMatch('Was the SNAP airdrop fair to users?', at(angleFor(MATCH_THRESHOLD) - 0.5), markets)
    expect(p.kind).toBe('join')
  })
  it('between the thresholds: ambiguous, Claude decides', () => {
    const mid = (MATCH_THRESHOLD + AMBIGUOUS_THRESHOLD) / 2
    expect(planMatch('Did $SNAP reward real users?', at(angleFor(mid)), markets).kind).toBe('ambiguous')
  })
  it('below the ambiguous threshold: a new market', () => {
    // 50 degrees from m1 is cos 0.643; 40 from m2 is 0.766, so pick an angle far from both.
    expect(planMatch('Is ketchup only for hot dogs?', at(-50), markets).kind).toBe('new')
  })
  it('picks the most similar market, and the older one on a tie', () => {
    const tied = [market('old', 'A?', 10), market('new', 'B?', -10)]
    const p = planMatch('C?', at(0), tied)
    expect(p.kind !== 'new' && p.market.id).toBe('old')
  })
  it('no markets yet: new', () => expect(planMatch('Q?', at(0), [])).toEqual({ kind: 'new', best: 0 }))
  it('a market is found through its closest member, not only its founding question', () => {
    // The live $BASED case: 0.652 from the founding question, 0.762 from a member.
    // Query at 0.652 from the seed (at 0 degrees); the member sits 0.762 from the query.
    const q = angleFor(0.652)
    const based = market('based', 'Is $BASED a good daily app to stake in?', 0, q + angleFor(0.762))
    expect(cosine(at(q), based.embeddings[0]!)).toBeCloseTo(0.652, 3)
    expect(cosine(at(q), based.embeddings[1]!)).toBeCloseTo(0.762, 3)
    const p = planMatch('Is $BASED one of the best projects on Farcaster?', at(q), [based])
    expect(p.kind).toBe('ambiguous')
    expect(p.kind !== 'new' && p.market.id).toBe('based')
  })
})

describe('planMatch bridges: one question close to two markets', () => {
  it('reports the other near markets, so they can be consolidated (the live $BASED order)', () => {
    // Founded in this order: "good daily app" at 0, then "best projects" 0.652 away (its own
    // market). The third question is 0.763 from the first and 0.762 from the second.
    const a = angleFor(0.763)
    const first = market('first', 'Is $BASED a good daily app to stake in?', 0)
    const second = market('second', 'Is $BASED one of the best projects on Farcaster?', a + angleFor(0.762))
    const p = planMatch('Is the $BASED project good?', at(a), [first, second])
    expect(p.kind).toBe('ambiguous')
    expect(p.kind !== 'new' && p.market.id).toBe('first')
    expect(p.kind !== 'new' && p.bridges.map(m => m.id)).toEqual(['second'])
  })
  it('a market below the ambiguous threshold is not a bridge', () => {
    const p = planMatch('Q?', at(0), [market('near', 'A?', 10), market('far', 'B?', 80)])
    expect(p.kind !== 'new' && p.bridges).toEqual([])
  })
})

describe('canonicalAnswer', () => {
  it('keeps the answer when YES means the same, flips it when the question is inverted', () => {
    expect(canonicalAnswer('no', true)).toBe('no')
    // "Was X unfair?" yes  ==  "Was X fair?" no
    expect(canonicalAnswer('yes', false)).toBe('no')
    expect(canonicalAnswer('no', false)).toBe('yes')
  })
})

describe('embeddings', () => {
  it('cosine of identical vectors is 1, of a zero vector 0, and mismatched sizes throw', () => {
    expect(cosine(at(30), at(30))).toBeCloseTo(1, 6)
    expect(cosine(new Float32Array([0, 0]), at(0))).toBe(0)
    expect(() => cosine(new Float32Array(3), at(0))).toThrow()
  })
  it('round-trips through a blob, from an ArrayBuffer or a byte array', () => {
    const v = new Float32Array([0.1, -0.25, 3.5])
    const blob = encodeEmbedding(v)
    expect([...decodeEmbedding(blob)]).toEqual([...v])
    expect([...decodeEmbedding(Array.from(new Uint8Array(blob)))]).toEqual([...v])
    expect(() => decodeEmbedding(new Uint8Array(5).buffer)).toThrow()
  })
})

import { isFlipped, orient, tallyOn } from './market.ts'

describe('a market seen from one member', () => {
  // Canonical: "Is disabling reply bumping a good idea?". A member argued "Is reply bumping a
  // good feature? -> no", stored as "yes" on the canonical question: flipped.
  it('detects a member that joined reversed', () => {
    expect(isFlipped('yes', 'no')).toBe(true)
    expect(isFlipped('no', 'no')).toBe(false)
  })
  it('reads other members on the viewer\'s own question', () => {
    expect(orient('no', true)).toBe('yes')   // a "no, don't disable it" is a "yes, it's a good feature"
    expect(orient('no', false)).toBe('no')
  })
  it('counts takes on the viewer\'s question', () => {
    expect(tallyOn(2, 3, false)).toEqual({ yes: 2, no: 1 })
    expect(tallyOn(2, 3, true)).toEqual({ yes: 1, no: 2 })
  })
})
