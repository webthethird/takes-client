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

/**
 * Stage 1's version: bump when the classify prompt or its schema changes, and stored
 * classifications count as unclassified. Stage 2 has its own, so a stance-only change
 * re-runs only stances (the classifier keeps the same split: CLASSIFY_ / STANCE_VERSION).
 */
export const PROMPT_VERSION = 'client-4:haiku-5-5' // 3: taste claims arguable (classifier 54e4220); 4: broadest question the caster argues
/** The suggest stage's version: bump when its prompt or schema changes; suggestions are redone. */
export const SUGGEST_VERSION = 'suggest-2:haiku-5-5' // 2: casing from the cast's start, enforced in code; 35-word cap
/** Stage 2's version: bump when the stance prompt, schema or reconciliation changes. */
export const STANCE_VERSION = 'stance-2:haiku-5-5' // 2: direct replies anchored to stage 1's answer

/* ──────────────────────────── Selection ──────────────────────────────── */

/**
 * The fresh feed: casts from the last this-many hours, ranked band-first with no recency
 * preference inside the window beyond a tiebreak (a 6-day-old 0.7 outranks today's 0.6).
 * A week, so a take people are still arguing over days later stays in the feed. Note a new
 * deployment can index only ~4 days back: both Snapchain and Hypersnap keep their event
 * stream that long (measured Nov 13, 2026), and the index is built from events.
 */
export const FRESH_HOURS = 168
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

/**
 * For a reply directly under the root, the parent's stance IS the root author's answer, and
 * stage 1 already decided it. Letting stage 2 re-read it independently means the two stages
 * can disagree about the same cast, and then an agreeing reply shows as "Someone already
 * disagrees" (seen live: stage 1 stored "no" on a cast arguing "yes"; stage 2 read "yes",
 * correctly, and the card invented a dispute). So reconciliation is anchored to stage 1's
 * answer, which keeps every card internally consistent: if stage 1 misread the polarity, the
 * whole card is misread the same way, and since cards are relative to the cast ("backing" /
 * "challenging"), readers still see it right.
 *
 * The model's own reading is not discarded: `conflict` is true when it named a definite stance
 * for the root that differs from stage 1's, a measurable signal of stage-1 polarity errors.
 */
export const anchorToRoot = <T extends Pick<StanceResult, 'parent_stance'>>(r: T, rootAnswer: 'yes' | 'no'):
  { anchored: T; conflict: boolean } => ({
  anchored: { ...r, parent_stance: rootAnswer },
  conflict: r.parent_stance !== 'none' && r.parent_stance !== rootAnswer,
})

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
 * A position in the merged feed: how many fresh and how many resurfaced rows have been
 * consumed. Counting rows consumed, not cards returned, means a row skipped at hydration (its
 * cast was deleted) still advances the cursor.
 */
export type FeedCursor = { f: number; o: number }
export const FEED_START: FeedCursor = { f: 0, o: 0 }

/**
 * Merges the fresh feed with resurfaced cards, resumably: every `every`-th slot (1-based,
 * counted from the very start of the feed) takes the next resurfaced card while any remain;
 * when either list runs out, the other fills the rest. Each entry carries the cursor just
 * past it, so a page can stop anywhere and the next one continues the same sequence.
 */
export const interleaveFrom = <T>(fresh: readonly T[], old: readonly T[], every: number, at: FeedCursor, take: number):
  Array<{ item: T; resurfaced: boolean; after: FeedCursor }> => {
  const out: Array<{ item: T; resurfaced: boolean; after: FeedCursor }> = []
  let { f, o } = at
  while (out.length < take && (f < fresh.length || o < old.length)) {
    const slotForOld = (f + o + 1) % every === 0
    const fromOld = (slotForOld && o < old.length) || f >= fresh.length
    const item = fromOld ? old[o++]! : fresh[f++]!
    out.push({ item, resurfaced: fromOld, after: { f, o } })
  }
  return out
}

/** The whole merged feed from the start. */
export const interleave = <T>(fresh: readonly T[], old: readonly T[], every: number): T[] =>
  interleaveFrom(fresh, old, every, FEED_START, Infinity).map(e => e.item)

/** Cursors travel as "f.o": opaque to clients, trivially validated here. */
export const encodeCursor = (c: FeedCursor): string => `${c.f}.${c.o}`
export const decodeCursor = (s: string | null): FeedCursor | null => {
  if (s === null || s === '') return FEED_START
  const m = /^(\d{1,6})\.(\d{1,6})$/.exec(s)
  return m ? { f: Number(m[1]), o: Number(m[2]) } : null
}
