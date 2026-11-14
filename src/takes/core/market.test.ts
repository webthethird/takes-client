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
const market = (id: string, question: string, deg: number): MarketRef => ({ id, question, embedding: at(deg) })

describe('planMatch', () => {
  const markets = [market('m1', 'Was the $SNAP airdrop fair?', 0), market('m2', 'Is Base the best L2?', 90)]

  it('identical text joins outright, whatever the embedding says', () => {
    expect(planMatch('Is Base the best L2?', at(0), markets)).toEqual({ kind: 'identical', market: markets[1] })
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
