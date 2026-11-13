// Scoring for the debate feed: pure, no I/O, no clock. Ported from
// takes-classifier/src/lib/score.ts, whose README explains each rule with the measurement
// that motivated it. Two deliberate differences:
//
// 1. One card per ROOT CAST, not per merged question. The classifier merged casts across
//    threads by question embedding; this client has no matcher yet, so a card is a cast and
//    its own thread. Cross-thread merging is a later step, not an accident of the port.
// 2. A following-graph credit, applied at read time per viewer. Like corroboration, it only
//    orders cards WITHIN a challengeability band: a take from someone you follow beats an
//    equally debatable stranger, never a clearly more debatable one.

import type { Claim, StanceResult } from '../schema.ts'

/** Bump whenever a prompt or the schema changes: older rows then count as unclassified. */
export const PROMPT_VERSION = 'client-1:haiku-5-5'

/* ──────────────────────────── Selection ──────────────────────────────── */

/** The fresh feed: casts from the last this-many hours. */
export const FRESH_HOURS = 72
/**
 * Resurfacing: older casts that proved highly debatable come back, every RESURFACE_EVERY-th
 * card, with their thread as it stands now. Only casts at RESURFACE_MIN_BAND or above
 * qualify, and the lookback is bounded by the cast index's retention (28 days by default).
 */
export const RESURFACE_MAX_DAYS = 28
export const RESURFACE_MIN_BAND = 7
export const RESURFACE_EVERY = 4
/** Global lane: casts this many distinct people (not the author) replied to. */
export const MIN_REPLIERS = 3
/**
 * Global lane, the other way in: casts this many people liked, replies or not. An
 * unchallenged take a lot of people saw is exactly what the feed exists to surface.
 */
export const MIN_LIKES = 30
/** Shorter casts are reactions, not takes; they never reach the classifier. */
export const MIN_TEXT_LEN = 20
/** Replies judged per thread, oldest first, and how deep a thread is followed. */
export const MAX_REPLIES_PER_THREAD = 40
export const MAX_THREAD_DEPTH = 4

/* ───────────────────────────── Weights ───────────────────────────────── */

/** Gated challengeability is cut into 0.1 bands; nothing below can cross a band. */
export const CHALLENGE_BAND = 0.1
/** Different people on opposite sides: the strongest evidence a question is live. */
export const BOTH_SIDES_CREDIT = 0.5
/** Per additional distinct person with a stance (people, not casts). */
export const PER_AUTHOR_CREDIT = 0.12
export const MAX_AUTHOR_CREDIT = 0.4
/** Confidence gates rather than boosts: a shaky extraction drops a band. */
export const CONFIDENCE_FLOOR = 0.5
/** The viewer follows the author. Same units as the corroboration credits. */
export const FOLLOWING_CREDIT = 0.3
/** Total within-band credit stays below one band, so it can never cross into the next. */
export const MAX_CREDIT = 0.99

export const gatedChallenge = (c: Pick<Claim, 'challengeability' | 'confidence'>): number =>
  c.challengeability * (CONFIDENCE_FLOOR + (1 - CONFIDENCE_FLOOR) * c.confidence)

/**
 * The claim a card is about: the most challengeable one a crowd could argue over forever.
 * Externally resolvable claims are dropped (Takes has no oracle; see the classifier README,
 * "Scope: no prediction markets"). Ties keep the classifier's order, so the choice is stable.
 */
export const chooseClaim = (claims: readonly Claim[]): Claim | null => {
  let best: Claim | null = null
  for (const c of claims) {
    if (c.externally_resolvable) continue
    if (!best || gatedChallenge(c) > gatedChallenge(best)) best = c
  }
  return best
}

/* ──────────────────────── Stage 2 reconciliation ─────────────────────── */

export type Stance = 'yes' | 'no' | 'off_topic'

/**
 * Derives a reply's stance from the model's typed intermediates instead of trusting its
 * verdict. Verbatim logic from the classifier's `reconcileStance`: agreement is transitive,
 * and a self-reply keeps its author's stance unless it explicitly retracts.
 */
export const reconcileStance = (
  r: Pick<StanceResult, 'parent_stance' | 'agreement' | 'stance' | 'explicit_reversal'>,
  self?: { rootStance: 'yes' | 'no' },
): { stance: Stance; corrected: boolean } => {
  if (r.stance === 'off_topic') return { stance: 'off_topic', corrected: false }
  if (self && !r.explicit_reversal) return { stance: self.rootStance, corrected: r.stance !== self.rootStance }
  if (r.parent_stance === 'none' || r.agreement === 'neither') return { stance: r.stance, corrected: false }
  const derived = r.agreement === 'agree' ? r.parent_stance : r.parent_stance === 'yes' ? 'no' : 'yes'
  return { stance: derived, corrected: derived !== r.stance }
}

/* ──────────────────────────── Card scoring ───────────────────────────── */

export type ReplyStance = {
  hash: string
  fid: number
  stance: Stance
  confidence: number
  textLen: number
}

export type CardScore = {
  band: number
  credit: number
  bothSides: boolean
  yesAuthors: number
  noAuthors: number
  rebuttal: ReplyStance | null
}

/**
 * Scores one root cast and its thread. The root author is a member on their own answer;
 * replies count only with a stance (off_topic is most of a real thread, and is not a side).
 */
export const scoreCard = (root: { fid: number }, claim: Claim, replies: readonly ReplyStance[]): CardScore => {
  const yes = new Set<number>()
  const no = new Set<number>()
  ;(claim.answer === 'yes' ? yes : no).add(root.fid)
  for (const r of replies) {
    if (r.stance === 'yes') yes.add(r.fid)
    else if (r.stance === 'no') no.add(r.fid)
  }
  // Different people on opposing sides. Not "someone only-yes and someone only-no": a person
  // on both sides still disagrees with everyone on the other (the classifier's Alice/Bob bug).
  let bothSides = false
  for (const y of yes) {
    for (const n of no) if (y !== n) { bothSides = true; break }
    if (bothSides) break
  }
  const people = new Set([...yes, ...no]).size
  const band = Math.floor(gatedChallenge(claim) / CHALLENGE_BAND + 1e-9)
  const credit = Math.min(MAX_CREDIT,
    (bothSides ? BOTH_SIDES_CREDIT : 0) + Math.min(PER_AUTHOR_CREDIT * (people - 1), MAX_AUTHOR_CREDIT))
  return { band, credit, bothSides, yesAuthors: yes.size, noAuthors: no.size, rebuttal: pickRebuttal(root.fid, claim.answer, replies) }
}

/**
 * The strongest reply from someone else on the other side of the root's own answer. Shown on
 * the card as evidence, which is worth more than an AI-written challenge reason. Confidence is
 * weighted by substance, saturating at ~200 characters, so a developed counter-argument beats
 * a one-line reaction. Ties fall to the hash, so the pick is deterministic.
 */
export const pickRebuttal = (rootFid: number, rootAnswer: 'yes' | 'no', replies: readonly ReplyStance[]): ReplyStance | null => {
  const weight = (r: ReplyStance) => r.confidence * Math.min(1, 0.4 + r.textLen / 200)
  let best: ReplyStance | null = null
  for (const r of replies) {
    if (r.stance === 'off_topic' || r.stance === rootAnswer || r.fid === rootFid) continue
    if (!best) { best = r; continue }
    const d = weight(r) - weight(best)
    if (d > 1e-9 || (Math.abs(d) <= 1e-9 && r.hash < best.hash)) best = r
  }
  return best
}

/* ──────────────────────────────── Ranking ────────────────────────────── */

export type Ranked<T> = T & { following: boolean; key: number }

/**
 * Orders cards for one viewer. Band first; within a band, corroboration plus the following
 * credit, capped below one band; then newer first; then hash, for a total order.
 */
export const rankFeed = <T extends { fid: number; band: number; credit: number; ts: number; hash: string }>(
  rows: readonly T[], follows: ReadonlySet<number>,
): Ranked<T>[] =>
  rows
    .map(r => {
      const following = follows.has(r.fid)
      return { ...r, following, key: r.band + Math.min(MAX_CREDIT, r.credit + (following ? FOLLOWING_CREDIT : 0)) }
    })
    .sort((a, b) => b.key - a.key || b.ts - a.ts || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))

/**
 * Merges the fresh feed with resurfaced cards: every `every`-th slot (1-based) takes the next
 * resurfaced card while any remain; when either list runs out, the other fills the rest.
 */
export const interleave = <T>(fresh: readonly T[], old: readonly T[], every: number): T[] => {
  const out: T[] = []
  let f = 0
  let o = 0
  while (f < fresh.length || o < old.length) {
    const slotForOld = (out.length + 1) % every === 0
    if ((slotForOld && o < old.length) || f >= fresh.length) out.push(old[o++]!)
    else out.push(fresh[f++]!)
  }
  return out
}
