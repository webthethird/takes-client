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
export const MERGE_VERSION = 'merge-5' // 2: same subject + same overall verdict; 3: match every member; 4: consolidate bridged markets; 5: same claim, Claude decides every join

/**
 * Similarity only shortlists: below AMBIGUOUS_THRESHOLD a question founds its own market without
 * asking; at or above it, Claude decides against the market's canonical question in every band.
 * MATCH_THRESHOLD now only labels a membership ('join' vs 'adjudicated').
 *
 * Until merge-5, a question at or above 0.82 joined on similarity alone (Claude judged only its
 * polarity), and similarity was the best over the title AND every member. Measured Nov 15, 2026:
 * 7 of 21 such joins came in through a member, 2 of them under 0.70 from the title ("Is
 * Farcaster more enjoyable lately?" into "Is alt-client Farcaster a nice diversion?", 0.68).
 */
export const MATCH_THRESHOLD = 0.82
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

/**
 * A market as matching sees it: its canonical question, and the embeddings of that question
 * and of every member's own question. A new question is compared with all of them, so the
 * market is found through whichever cast is closest; but Claude decides membership against the
 * canonical question, always, so membership can't drift along a chain of near neighbours.
 */
export type MarketRef = { id: string; question: string; embeddings: Float32Array[] }

/**
 * `bridges`: other markets this question is also close to (at or above AMBIGUOUS_THRESHOLD).
 * Claims are placed one at a time, so a question can arrive that belongs with two markets
 * founded separately before it existed (live: three $BASED questions, the middle one founded
 * a market at 0.652 from the first, before the third arrived at 0.763 / 0.762 from both).
 * Once it joins one, the others are candidates to consolidate into one market.
 */
export type MatchPlan =
  | { kind: 'identical'; market: MarketRef; bridges: MarketRef[] }
  | { kind: 'join'; market: MarketRef; similarity: number; bridges: MarketRef[] } // close; Claude decides membership and polarity
  | { kind: 'ambiguous'; market: MarketRef; similarity: number; bridges: MarketRef[] } // nearer the floor; Claude decides both
  | { kind: 'new'; best: number }

/**
 * Where a question goes, before any model is asked. Identical text joins outright: same
 * string, same hash, same on-chain market. Otherwise the best match by similarity decides
 * which questions Claude must see. Ties go to the older market (earlier in `markets`), so the
 * choice is stable.
 */
export const planMatch = (question: string, embedding: Float32Array, markets: readonly MarketRef[]): MatchPlan => {
  const scored = markets.map(m => {
    let s = -1
    for (const e of m.embeddings) s = Math.max(s, cosine(embedding, e))
    return { m, s }
  })
  const near = (except: MarketRef) => scored.filter(x => x.m !== except && x.s >= AMBIGUOUS_THRESHOLD).map(x => x.m)
  const exact = markets.find(m => m.question === question)
  if (exact) return { kind: 'identical', market: exact, bridges: near(exact) }
  let best: { m: MarketRef; s: number } | null = null
  for (const x of scored) if (!best || x.s > best.s + 1e-12) best = x
  if (!best || best.s < AMBIGUOUS_THRESHOLD) return { kind: 'new', best: Math.max(best?.s ?? 0, 0) }
  const bridges = near(best.m)
  return best.s >= MATCH_THRESHOLD
    ? { kind: 'join', market: best.m, similarity: best.s, bridges }
    : { kind: 'ambiguous', market: best.m, similarity: best.s, bridges }
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
