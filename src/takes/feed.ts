// GET /api/takes/feed?cursor=&limit=: the ranked debate feed for the configured viewer, paged.
//
// Paging is by position in the merged ranking (see FeedCursor). The ranking is recomputed per
// request and scores change every minute, so pages are not a frozen snapshot: a card can move
// across a page boundary between requests. The client drops cards it has already shown; the
// cost is that a card which moved up past the boundary is missed until a refresh.
//
// Each card is hydrated by calling Warpstack's own `cast.get` handler in-process, so the casts
// it returns are exactly the contract's Cast objects, the ones CastCard renders, with no
// presenter of our own to keep in step with Warpstack's.

import { TakesStore } from './adapters/store.ts'
import { matchCasing } from './core/text.ts'
import { fillPage } from './core/page.ts'
import { isFlipped, orient, tallyOn } from './core/market.ts'
import { takesConfig, type Env } from './config.ts'
import {
  FRESH_HOURS, MARKET_RESURFACE_MIN_BAND, PROMPT_VERSION, RESURFACE_EVERY, STANCE_VERSION, RESURFACE_MAX_DAYS, RESURFACE_MIN_BAND, decodeCursor,
  encodeCursor, mergeFeed, onePerMarket, rankFeed, SUGGEST_VERSION, toLanes, type FeedCursor,
} from './core/score.ts'

type Fetch = (req: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 50
/**
 * Rows ranked per request. Every page ranks the whole pool, so the pool must hold the whole
 * window: at 300 it would have silently ended the feed at the 300th card (242 existed when
 * paging was added). Ranking a few thousand rows is cheap next to one hydration call.
 */
const FRESH_POOL = 5000
const OLD_POOL = 2000
/** Rows hydrated beyond the page size, so casts deleted since scoring don't shorten a page. */
const HYDRATE_SLACK = 10

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/**
 * Loads casts through Warpstack's own `cast.get`, in-process, as the viewer: their session and
 * IP go with each request, so Warpstack's access rules and rate limits apply as they would to
 * the app. Each result is the cast as Warpstack serves it; 'gone' when it no longer exists
 * (404, or not live); 'unavailable' when it couldn't be read just now: a rate limit (429), a
 * node failure (5xx), or an exception. Only 'gone' may be skipped for good (fillPage).
 */
const castLoader = (req: Request, env: Env, ctx: ExecutionContext, warp: Fetch) => {
  const origin = new URL(req.url).origin
  const headers = new Headers({ accept: 'application/json' })
  const auth = req.headers.get('authorization')
  if (auth) headers.set('authorization', auth)
  const ip = req.headers.get('cf-connecting-ip')
  if (ip) headers.set('cf-connecting-ip', ip)
  return async (fid: number, hash: string): Promise<object | 'gone' | 'unavailable' | 'unauthorized'> => {
    let res: Response
    try {
      res = await warp(new Request(new URL(`/api/casts/${fid}/${hash}`, origin), { headers }), env, ctx)
    } catch {
      return 'unavailable'
    }
    if (res.status === 401) return 'unauthorized'
    if (res.status === 429 || res.status >= 500) return 'unavailable'
    if (!res.ok) return 'gone'
    const body = (await res.json()) as { cast?: { state?: string; cast?: unknown } }
    const cast = body.cast?.state === 'live' ? body.cast.cast : undefined
    return typeof cast === 'object' && cast !== null ? cast : 'gone'
  }
}

/** Mirrors Warpstack's front door: a private deployment answers nothing without a session. */
const unauthorized = () =>
  json({ defined: true, code: 'UNAUTHORIZED', message: 'Sign in to see this deployment', data: { reason: 'session' } }, 401)

export const takesFeed = async (req: Request, env: Env, ctx: ExecutionContext, warp: Fetch, now: number): Promise<Response> => {
  if (req.method !== 'GET') return json({ defined: true, code: 'NOT_FOUND', message: 'Not found' }, 404)
  const auth = req.headers.get('authorization')
  if (env.ACCESS !== 'public' && !auth?.startsWith('Bearer ')) return unauthorized()

  const url = new URL(req.url)
  const asked = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isSafeInteger(asked) ? Math.min(Math.max(asked, 1), MAX_LIMIT) : DEFAULT_LIMIT
  const at = decodeCursor(url.searchParams.get('cursor'))
  if (!at) return json({ defined: true, code: 'BAD_INPUT', message: 'cursor is not one this feed issued' }, 400)
  // filter=markets: only casts whose claim other casts also argue ("Shared questions"), older
  // ones included whatever their band. Same ranking and lane split; its own cursor sequence.
  const filter = url.searchParams.get('filter') ?? 'all'
  if (filter !== 'all' && filter !== 'markets') return json({ defined: true, code: 'BAD_INPUT', message: 'filter must be all or markets' }, 400)
  const onlyMarkets = filter === 'markets'

  const cfg = takesConfig(env)
  const store = new TakesStore(env.TAKES, PROMPT_VERSION, STANCE_VERSION)
  const freshSince = now - FRESH_HOURS * 3600
  const [fresh, old, follows] = await Promise.all([
    store.scores({ since: freshSince, until: now + 1, minBand: 0, onlyMarkets, limit: FRESH_POOL }),
    store.scores({
      since: now - RESURFACE_MAX_DAYS * 86_400, until: freshSince, onlyMarkets, limit: OLD_POOL,
      ...(onlyMarkets ? { minBand: 0, marketMinBand: 0 } : { minBand: RESURFACE_MIN_BAND, marketMinBand: MARKET_RESURFACE_MIN_BAND }),
    }),
    cfg.viewerFid === null ? Promise.resolve(new Set<number>()) : store.follows(cfg.viewerFid),
  ])
  // One card per market, led by its best-ranked cast; the card shows the others.
  const ranked = onePerMarket(rankFeed(fresh, follows), rankFeed(old, follows))
  const freshLanes = toLanes(ranked.fresh)
  const oldLanes = toLanes(ranked.old)
  const slots = mergeFeed(freshLanes, oldLanes, RESURFACE_EVERY, at, limit + HYDRATE_SLACK)

  // Hydrate more than the page needs: a cast deleted since it was scored is skipped.
  const castOf = castLoader(req, env, ctx, warp)

  const hydrated = await Promise.all(slots.map(async ({ item: row, resurfaced, after }) => {
    const [cast, rebuttal] = await Promise.all([
      castOf(row.fid, row.hash),
      row.rebuttal_hash && row.rebuttal_fid !== null ? castOf(row.rebuttal_fid, row.rebuttal_hash) : Promise.resolve(null),
    ])
    return { row, resurfaced, after, cast, rebuttal }
  }))
  type Loaded = object | 'gone' | 'unavailable'
  const rows: Array<{ row: (typeof hydrated)[number]['row']; resurfaced: boolean; after: FeedCursor; cast: Loaded; rebuttal: Loaded | null }> = []
  for (const h of hydrated) {
    if (h.cast === 'unauthorized' || h.rebuttal === 'unauthorized') return unauthorized()
    rows.push({ ...h, cast: h.cast, rebuttal: h.rebuttal })
  }

  // Rank order until the page is full. A deleted cast is skipped for good; an unavailable one
  // ends the page early, so it's retried rather than lost.
  const { kept, next, stalled } = fillPage<object, FeedCursor, (typeof rows)[number]>(rows, at, limit)
  if (stalled && kept.length === 0) {
    return json({ defined: true, code: 'RATE_LIMITED', message: 'The feed is busy; try again in a minute', data: { retryAfter: 60 } }, 429)
  }
  const exhausted = !stalled && next.ff >= freshLanes.following.length && next.fo >= freshLanes.others.length &&
    next.of >= oldLanes.following.length && next.oo >= oldLanes.others.length

  // An empty suggestion was declined: sent as null so the boxes fall back to static copy.
  const cased = (cast: unknown, s: string | undefined): string | null => {
    if (!s) return null
    const text = (cast as { text?: unknown }).text
    return typeof text === 'string' ? matchCasing(text, s) : s
  }
  const [suggestions, markets] = await Promise.all([
    store.suggestionsFor(kept.map(h => h.row.hash), SUGGEST_VERSION),
    store.marketsOf(kept.map(h => h.row.hash)),
  ])
  // The market's other casts, shown on the card by default: loaded now, up to MARKET_INLINE
  // per card, each answer read on the lead cast's question. One that can't be read just now is
  // left out (the count still includes it); the rest load behind "Show more".
  const others = new Map<string, Array<{ cast: object; answer: 'yes' | 'no' }>>()
  await Promise.all(kept.map(async ({ row }) => {
    const m = markets.get(row.hash)
    if (!m) return
    const flipped = isFlipped(m.stored, m.own)
    const members = (await store.marketMembers(m.marketId, MARKET_INLINE + 1)).filter(x => x.hash !== row.hash).slice(0, MARKET_INLINE)
    const loaded = await Promise.all(members.map(async x => ({ x, cast: await castOf(x.fid, x.hash) })))
    others.set(row.hash, loaded.flatMap(l => (typeof l.cast === 'object' ? [{ cast: l.cast, answer: orient(l.x.stored, flipped) }] : [])))
  }))
  /**
   * The card's market, when it has other takes, counted on this card's own question. Markets
   * keep members whose cast was later deleted, so when every other cast was tried here (no more
   * than MARKET_INLINE), the count is of the casts that loaded, the card's own included; a
   * market left with no other live cast is no market on the card. (Seen live: an author deleted
   * a cast and posted it again, leaving a "2 takes" market of one live cast.)
   */
  const marketOf = (hash: string, own: 'yes' | 'no') => {
    const m = markets.get(hash)
    if (!m) return null
    const shown = others.get(hash) ?? []
    if (m.takes - 1 > MARKET_INLINE) {
      return { id: m.marketId, takes: m.takes, ...tallyOn(m.storedYes, m.takes, isFlipped(m.stored, m.own)), others: shown }
    }
    if (shown.length === 0) return null
    const yes = (own === 'yes' ? 1 : 0) + shown.filter(o => o.answer === 'yes').length
    return { id: m.marketId, takes: 1 + shown.length, yes, no: 1 + shown.length - yes, others: shown }
  }
  const items = kept
    .map(({ row, resurfaced, cast, rebuttal }) => ({
      cast,
      // A deleted rebuttal shows as none.
      rebuttal: rebuttal === 'gone' ? null : rebuttal,
      question: row.question,
      challengeReason: row.challenge_reason,
      // Casing is matched here, at read time, so a casing-rule change needs no regeneration.
      backSuggestion: cased(cast, suggestions.get(row.hash)?.back),
      challengeSuggestion: cased(cast, suggestions.get(row.hash)?.challenge),
      authorStance: row.author_stance,
      bothSides: row.both_sides === 1,
      yesAuthors: row.yes_authors,
      noAuthors: row.no_authors,
      band: row.band,
      following: row.following,
      resurfaced,
      market: marketOf(row.hash, row.author_stance),
    }))
  return json({ items, next: exhausted ? null : encodeCursor(next), viewerFid: cfg.viewerFid })
}

/** Members returned by the market endpoint ("Show more"). */
const MARKET_MEMBERS = 20
/** Other casts loaded with each market card; the rest behind "Show more". */
const MARKET_INLINE = 3

/**
 * GET /api/takes/market?id=<market id>&for=<cast hash>: the market's other takes, each with its
 * answer read on the question of the card asking (`for`), oldest first. Loaded only when a
 * card's market line is expanded, so the feed itself makes no extra cast lookups.
 */
export const takesMarket = async (req: Request, env: Env, ctx: ExecutionContext, warp: Fetch): Promise<Response> => {
  if (req.method !== 'GET') return json({ defined: true, code: 'NOT_FOUND', message: 'Not found' }, 404)
  if (env.ACCESS !== 'public' && !req.headers.get('authorization')?.startsWith('Bearer ')) return unauthorized()
  const url = new URL(req.url)
  const id = url.searchParams.get('id') ?? ''
  const forHash = url.searchParams.get('for') ?? ''
  if (!/^0x[0-9a-f]{64}$/.test(id) || !/^0x[0-9a-f]{40}$/.test(forHash)) {
    return json({ defined: true, code: 'BAD_INPUT', message: 'id must be a market id and for a cast hash' }, 400)
  }
  const store = new TakesStore(env.TAKES, PROMPT_VERSION, STANCE_VERSION)
  const members = await store.marketMembers(id, MARKET_MEMBERS + 1)
  const viewer = members.find(m => m.hash === forHash)
  if (!viewer) return json({ defined: true, code: 'NOT_FOUND', message: 'that cast is not in this market' }, 404)
  const flipped = isFlipped(viewer.stored, viewer.own)
  const castOf = castLoader(req, env, ctx, warp)
  const others = members.filter(m => m.hash !== forHash).slice(0, MARKET_MEMBERS)
  const loaded = await Promise.all(others.map(async m => ({ m, cast: await castOf(m.fid, m.hash) })))
  if (loaded.some(l => l.cast === 'unauthorized')) return unauthorized()
  if (loaded.some(l => l.cast === 'unavailable')) {
    return json({ defined: true, code: 'RATE_LIMITED', message: 'Busy; try again in a minute', data: { retryAfter: 60 } }, 429)
  }
  const items = loaded.filter(l => typeof l.cast === 'object').map(l => ({ cast: l.cast, answer: orient(l.m.stored, flipped) }))
  return json({ items })
}
