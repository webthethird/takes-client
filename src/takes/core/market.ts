// Canonical markets: casts that argue the same question, merged into one market whose identity
// is the one the contracts use. Pure: no I/O, no clock.
//
// Identity. TakesFactory addresses a market by keccak256(question) (with a lockup duration),
// so a market here is keyed by the same hash: merging casts into a market means mapping them
// to one canonical question STRING. The first question to found a market is canonical and
// never changes, like an on-chain market's question (and the mini-app's commitMarket).
//
// Matching follows the mini-app (lib/market-index.ts): cosine similarity of question
// embeddings (OpenAI text-embedding-3-small), within the same claim_type, aspect ignored.

import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

/** Bump when matching rules or the adjudication prompt change: memberships are redone. */
export const MERGE_VERSION = 'merge-1'

/**
 * At or above: the same market, as far as similarity goes. 0.82, the classifier's measured
 * value ([0.80, 0.85) was "overwhelmingly genuine duplicates" over 208 pooled questions); the
 * mini-app still uses 0.85 and should be aligned.
 */
export const MATCH_THRESHOLD = 0.82
/** Below: a different market. Between this and MATCH_THRESHOLD, Claude decides. */
export const AMBIGUOUS_THRESHOLD = 0.70

/** keccak256 of the question's UTF-8 bytes, 0x-hex: Solidity's keccak256(bytes(question)). */
export const questionHash = (question: string): string => `0x${bytesToHex(keccak_256(utf8ToBytes(question)))}`

/** Cosine similarity; both vectors from the same model. Guarded so a zero vector is 0, not NaN. */
export const cosine = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length) throw new Error(`embedding dimensions differ: ${a.length} vs ${b.length}`)
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}

export type MarketRef = { id: string; question: string; embedding: Float32Array }

export type MatchPlan =
  | { kind: 'identical'; market: MarketRef }
  | { kind: 'join'; market: MarketRef; similarity: number } // join; Claude checks polarity only
  | { kind: 'ambiguous'; market: MarketRef; similarity: number } // Claude decides both
  | { kind: 'new'; best: number }

/**
 * Where a question goes, before any model is asked. Identical text joins outright: same
 * string, same hash, same on-chain market. Otherwise the best match by similarity decides
 * which questions Claude must see. Ties go to the older market (earlier in `markets`), so the
 * choice is stable.
 */
export const planMatch = (question: string, embedding: Float32Array, markets: readonly MarketRef[]): MatchPlan => {
  const exact = markets.find(m => m.question === question)
  if (exact) return { kind: 'identical', market: exact }
  let best: MarketRef | null = null
  let bestSim = -1
  for (const m of markets) {
    const s = cosine(embedding, m.embedding)
    if (s > bestSim + 1e-12) { best = m; bestSim = s }
  }
  if (!best || bestSim < AMBIGUOUS_THRESHOLD) return { kind: 'new', best: Math.max(bestSim, 0) }
  return bestSim >= MATCH_THRESHOLD ? { kind: 'join', market: best, similarity: bestSim } : { kind: 'ambiguous', market: best, similarity: bestSim }
}

/**
 * A member's answer restated against the market's canonical question. Embeddings barely see
 * negation ("Was X fair?" vs "Was X unfair?"), so any non-identical join carries Claude's
 * judgment of whether YES means the same thing in both; when it doesn't, the answer flips.
 */
export const canonicalAnswer = (answer: 'yes' | 'no', yesMeansSame: boolean): 'yes' | 'no' =>
  yesMeansSame ? answer : answer === 'yes' ? 'no' : 'yes'

/** D1 hands BLOBs back as an ArrayBuffer or as an array of byte values; accept both. */
export const decodeEmbedding = (blob: ArrayBuffer | ArrayLike<number>): Float32Array => {
  const bytes = blob instanceof ArrayBuffer ? new Uint8Array(blob) : Uint8Array.from(blob as ArrayLike<number>)
  if (bytes.byteLength % 4 !== 0) throw new Error(`embedding blob is ${bytes.byteLength} bytes, not a multiple of 4`)
  // Copy into an aligned buffer: Float32Array needs 4-byte alignment.
  return new Float32Array(bytes.slice().buffer)
}

export const encodeEmbedding = (v: Float32Array): ArrayBuffer => v.slice().buffer
