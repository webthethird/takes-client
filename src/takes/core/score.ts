// Scoring for the debate feed: pure, no I/O, no clock. Ported from
// takes-classifier/src/lib/score.ts, whose README explains each rule with the measurement
// that motivated it. Two deliberate differences:
//
// 1. One card per ROOT CAST, not per merged question: a card is a cast and its own thread.
//    Casts that argue the same claim share a market (merge.ts), which a card shows as a line
//    that expands to the market's other takes; it doesn't fold them into one card.
// 2. The viewer's following graph splits the feed into two lanes, alternated one-for-one
//    (mergeFeed); it doesn't reorder cards within a lane.

import type { Claim, StanceResult } from '../schema.ts'

/**
 * Stage 1's version: bump when the classify prompt or its schema changes, and stored
 * classifications count as unclassified. Stage 2 has its own, so a stance-only change
 * re-runs only stances (the classifier keeps the same split: CLASSIFY_ / STANCE_VERSION).
 */
export const PROMPT_VERSION = 'client-4:haiku-5-5' // 3: taste claims arguable (classifier 54e4220); 4: broadest question the caster argues
/** The suggest stage's version: bump when its prompt or schema changes; suggestions are redone. */
export const SUGGEST_VERSION = 'suggest-3:haiku-5-5' // 2: casing enforced in code; 3: a question per side, leaning its way, not a reply
/**
 * Share of each pass's Claude budget held back, before classification, for live cards that lack
 * suggestions. Without it, a backlog of new casts took every call (measured: 10 local passes,
 * 400 calls, all classification) and visible cards kept their fallback text after a
 * SUGGEST_VERSION bump or a pause in scoring.
 */
export const SUGGEST_SHARE = 0.25

/** Calls to hold back for suggestions: as many as cards need, at most SUGGEST_SHARE of the budget (rounded up). */
export const suggestReserve = (need: number, budget: number, share = SUGGEST_SHARE): number =>
  budget <= 0 || need <= 0 ? 0 : Math.min(need, Math.ceil(budget * share), budget)
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
/**
 * An older cast whose claim other casts also argue (its market has more than one take)
 * resurfaces from this band: several people independently arguing one claim across threads is
 * itself evidence the question is unsettled. First guess, Nov 15, 2026: 16 of 25 casts in
 * multi-cast markets were older than a week and only 1 reached band 7.
 */
export const MARKET_RESURFACE_MIN_BAND = 5

/** Whether an older cast comes back into the feed. */
export const resurfaces = (band: number, marketTakes: number): boolean =>
  band >= RESURFACE_MIN_BAND || (marketTakes >= 2 && band >= MARKET_RESURFACE_MIN_BAND)
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
/**
 * Other casts arguing the same claim (the card's market). A separate cast is a deliberate take,
 * so each other author is worth a little more than a replier. First guesses, to tune by eye.
 */
export const MARKET_TAKE_CREDIT = 0.15
export const MAX_MARKET_TAKE_CREDIT = 0.45
/** The market's casts take both sides: the same weight as a two-sided reply thread. */
export const MARKET_BOTH_SIDES_CREDIT = 0.5
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

/** The card's market, seen from it: distinct authors of the OTHER casts, and whether the market's casts take both sides. */
export type MarketContext = { id: string | null; otherAuthors: number; bothSides: boolean; takes: number }
export const NO_MARKET: MarketContext = { id: null, otherAuthors: 0, bothSides: false, takes: 1 }

export type CardScore = {
  band: number
  credit: number
  marketTakes: number
  /** Set only when the market has other casts: the feed shows one card per market. */
  marketId: string | null
  bothSides: boolean
  /** People other than the author whose replies took each side (the author is on their own side, uncounted). */
  yesAuthors: number
  noAuthors: number
  rebuttal: ReplyStance | null
}

/**
 * Scores one root cast and its thread. The root author is a member on their own answer;
 * replies count only with a stance (off_topic is most of a real thread, and is not a side).
 */
export const scoreCard = (root: { fid: number }, claim: Claim, replies: readonly ReplyStance[], market: MarketContext = NO_MARKET): CardScore => {
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
  // The counts the card shows: other people only. The sets above keep the author, for credit.
  const others = (side: Set<number>) => side.size - (side.has(root.fid) ? 1 : 0)
  const band = Math.floor(gatedChallenge(claim) / CHALLENGE_BAND + 1e-9)
  const credit = Math.min(MAX_CREDIT,
    (bothSides ? BOTH_SIDES_CREDIT : 0) + Math.min(PER_AUTHOR_CREDIT * (people - 1), MAX_AUTHOR_CREDIT)
    + Math.min(MARKET_TAKE_CREDIT * market.otherAuthors, MAX_MARKET_TAKE_CREDIT) + (market.bothSides ? MARKET_BOTH_SIDES_CREDIT : 0))
  return {
    band, credit, marketTakes: market.takes, marketId: market.takes >= 2 ? market.id : null, bothSides, yesAuthors: others(yes), noAuthors: others(no),
    rebuttal: pickRebuttal(root.fid, claim.answer, replies),
  }
}

/** A reply's weight as evidence: confidence, weighted by substance, saturating at ~200 characters. */
const replyWeight = (r: ReplyStance) => r.confidence * Math.min(1, 0.4 + r.textLen / 200)

/**
 * The replies on one side of the root's question, one per person (their strongest), strongest
 * first, never the author's own. What a card's side count counts, as casts. Ties fall to the
 * hash, so the order is deterministic.
 */
export const sideReplies = (rootFid: number, side: 'yes' | 'no', replies: readonly ReplyStance[]): ReplyStance[] => {
  const best = new Map<number, ReplyStance>()
  const stronger = (a: ReplyStance, b: ReplyStance) => {
    const d = replyWeight(a) - replyWeight(b)
    return d > 1e-9 || (Math.abs(d) <= 1e-9 && a.hash < b.hash)
  }
  for (const r of replies) {
    if (r.stance !== side || r.fid === rootFid) continue
    const had = best.get(r.fid)
    if (!had || stronger(r, had)) best.set(r.fid, r)
  }
  return [...best.values()].sort((a, b) => (stronger(a, b) ? -1 : stronger(b, a) ? 1 : 0))
}

/**
 * The strongest reply from someone else on the other side of the root's own answer. Shown on
 * the card as evidence, which is worth more than an AI-written challenge reason; a developed
 * counter-argument beats a one-line reaction (replyWeight).
 */
export const pickRebuttal = (rootFid: number, rootAnswer: 'yes' | 'no', replies: readonly ReplyStance[]): ReplyStance | null =>
  sideReplies(rootFid, rootAnswer === 'yes' ? 'no' : 'yes', replies)[0] ?? null

/* ──────────────────────────────── Ranking ────────────────────────────── */

export type Ranked<T> = T & { following: boolean; key: number }

/**
 * Orders cards by debatability alone: band first; within a band, corroboration, capped below
 * one band; then newer first; then hash, for a total order. Whether the viewer follows the
 * author doesn't move a card here; it decides which lane the card fills (mergeFeed).
 */
export const rankFeed = <T extends { fid: number; band: number; credit: number; ts: number; hash: string }>(
  rows: readonly T[], follows: ReadonlySet<number>,
): Ranked<T>[] =>
  rows
    .map(r => ({ ...r, following: follows.has(r.fid), key: r.band + Math.min(MAX_CREDIT, r.credit) }))
    .sort((a, b) => b.key - a.key || b.ts - a.ts || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))

/**
 * One card per market: of the casts that share a market, only the best-ranked one is kept,
 * across the fresh and resurfaced lists together (a market can have casts in both). Its card
 * shows the others. Casts alone in their market (market_id null) are all kept. Order is kept.
 */
export const onePerMarket = <T extends { hash: string; key: number; ts: number; market_id: string | null }>(
  fresh: readonly T[], old: readonly T[],
): { fresh: T[]; old: T[] } => {
  const best = new Map<string, T>()
  const better = (a: T, b: T) => a.key - b.key || a.ts - b.ts || (a.hash < b.hash ? 1 : -1)
  for (const r of [...fresh, ...old]) {
    if (r.market_id === null) continue
    const cur = best.get(r.market_id)
    if (!cur || better(r, cur) > 0) best.set(r.market_id, r)
  }
  const keep = (r: T) => r.market_id === null || best.get(r.market_id) === r
  return { fresh: fresh.filter(keep), old: old.filter(keep) }
}

/** A ranked list split by whether the viewer follows the author, each half still in rank order. */
export type Lanes<T> = { following: readonly T[]; others: readonly T[] }
export const toLanes = <T extends { following: boolean }>(ranked: readonly T[]): Lanes<T> =>
  ({ following: ranked.filter(r => r.following), others: ranked.filter(r => !r.following) })

/**
 * A position in the merged feed: rows consumed from each list (fresh or resurfaced, following
 * or others). Counting rows consumed, not cards returned, means a row skipped at hydration (its
 * cast was deleted) still advances the cursor.
 */
export type FeedCursor = { ff: number; fo: number; of: number; oo: number }
export const FEED_START: FeedCursor = { ff: 0, fo: 0, of: 0, oo: 0 }

/**
 * Which lane fills the next slot of a stream that has taken `i` following and `j` others rows:
 * they alternate, following first, so the split stays even (it never differs by more than
 * one) while both last. When one runs out, the other fills the rest. Null: both are empty.
 */
const laneFor = <T>(l: Lanes<T>, i: number, j: number): 'following' | 'others' | null => {
  const f = i < l.following.length, o = j < l.others.length
  if (f && (i <= j || !o)) return 'following'
  return o ? 'others' : null
}

/**
 * The feed, resumably. Every `every`-th slot (1-based, from the very start of the feed) takes
 * the next resurfaced card while any remain; when either stream runs out, the other fills the
 * rest. Within each stream, cards from people the viewer follows alternate with everyone
 * else's, so neither side of the viewer's graph can crowd out the other. Each entry carries
 * the cursor just past it, so a page can stop anywhere and the next continues the sequence.
 */
export const mergeFeed = <T>(fresh: Lanes<T>, old: Lanes<T>, every: number, at: FeedCursor, take: number):
  Array<{ item: T; resurfaced: boolean; after: FeedCursor }> => {
  const out: Array<{ item: T; resurfaced: boolean; after: FeedCursor }> = []
  let { ff, fo, of, oo } = at
  while (out.length < take) {
    const freshLane = laneFor(fresh, ff, fo)
    const oldLane = laneFor(old, of, oo)
    if (!freshLane && !oldLane) break
    const fromOld = oldLane !== null && ((ff + fo + of + oo + 1) % every === 0 || freshLane === null)
    let item: T
    if (fromOld) item = oldLane === 'following' ? old.following[of++]! : old.others[oo++]!
    else item = freshLane === 'following' ? fresh.following[ff++]! : fresh.others[fo++]!
    out.push({ item, resurfaced: fromOld, after: { ff, fo, of, oo } })
  }
  return out
}

/** The whole merged feed from the start. */
export const mergeAll = <T>(fresh: Lanes<T>, old: Lanes<T>, every: number): T[] =>
  mergeFeed(fresh, old, every, FEED_START, Infinity).map(e => e.item)

/** Cursors travel as "ff.fo.of.oo": opaque to clients, trivially validated here. */
export const encodeCursor = (c: FeedCursor): string => `${c.ff}.${c.fo}.${c.of}.${c.oo}`
export const decodeCursor = (s: string | null): FeedCursor | null => {
  if (s === null || s === '') return FEED_START
  const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(s)
  return m ? { ff: Number(m[1]), fo: Number(m[2]), of: Number(m[3]), oo: Number(m[4]) } : null
}
