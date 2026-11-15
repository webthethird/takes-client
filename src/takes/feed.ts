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
import { takesConfig, type Env } from './config.ts'
import {
  FRESH_HOURS, PROMPT_VERSION, RESURFACE_EVERY, STANCE_VERSION, RESURFACE_MAX_DAYS, RESURFACE_MIN_BAND, decodeCursor,
  encodeCursor, mergeFeed, rankFeed, SUGGEST_VERSION, toLanes, type FeedCursor,
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

  const cfg = takesConfig(env)
  const store = new TakesStore(env.TAKES, PROMPT_VERSION, STANCE_VERSION)
  const freshSince = now - FRESH_HOURS * 3600
  const [fresh, old, follows] = await Promise.all([
    store.scores({ since: freshSince, until: now + 1, minBand: 0, limit: FRESH_POOL }),
    store.scores({ since: now - RESURFACE_MAX_DAYS * 86_400, until: freshSince, minBand: RESURFACE_MIN_BAND, limit: OLD_POOL }),
    cfg.viewerFid === null ? Promise.resolve(new Set<number>()) : store.follows(cfg.viewerFid),
  ])
  const freshLanes = toLanes(rankFeed(fresh, follows))
  const oldLanes = toLanes(rankFeed(old, follows))
  const slots = mergeFeed(freshLanes, oldLanes, RESURFACE_EVERY, at, limit + HYDRATE_SLACK)

  // Hydrate more than the page needs: a cast deleted since it was scored is skipped.
  const headers = new Headers({ accept: 'application/json' })
  if (auth) headers.set('authorization', auth)
  const ip = req.headers.get('cf-connecting-ip')
  if (ip) headers.set('cf-connecting-ip', ip)
  /**
   * The cast as Warpstack serves it; 'gone' when it no longer exists (404, or not live);
   * 'unavailable' when it couldn't be read just now: a rate limit (429), a node failure (5xx),
   * or an exception. Only 'gone' may be skipped for good (fillPage).
   */
  const castOf = async (fid: number, hash: string): Promise<object | 'gone' | 'unavailable' | 'unauthorized'> => {
    let res: Response
    try {
      res = await warp(new Request(new URL(`/api/casts/${fid}/${hash}`, url.origin), { headers }), env, ctx)
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
  const suggestions = await store.suggestionsFor(kept.map(h => h.row.hash), SUGGEST_VERSION)
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
    }))
  return json({ items, next: exhausted ? null : encodeCursor(next), viewerFid: cfg.viewerFid })
}
