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
import { takesConfig, type Env } from './config.ts'
import {
  FRESH_HOURS, PROMPT_VERSION, RESURFACE_EVERY, STANCE_VERSION, RESURFACE_MAX_DAYS, RESURFACE_MIN_BAND, decodeCursor,
  encodeCursor, interleaveFrom, rankFeed, SUGGEST_VERSION, type FeedCursor,
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
  const freshRanked = rankFeed(fresh, follows)
  const oldRanked = rankFeed(old, follows)
  const slots = interleaveFrom(freshRanked, oldRanked, RESURFACE_EVERY, at, limit + HYDRATE_SLACK)

  // Hydrate more than the page needs: a cast deleted since it was scored is skipped.
  const headers = new Headers({ accept: 'application/json' })
  if (auth) headers.set('authorization', auth)
  const ip = req.headers.get('cf-connecting-ip')
  if (ip) headers.set('cf-connecting-ip', ip)
  const castOf = async (fid: number, hash: string): Promise<unknown | 'unauthorized' | null> => {
    const res = await warp(new Request(new URL(`/api/casts/${fid}/${hash}`, url.origin), { headers }), env, ctx)
    if (res.status === 401) return 'unauthorized'
    if (!res.ok) return null
    const body = (await res.json()) as { cast?: { state?: string; cast?: unknown } }
    return body.cast?.state === 'live' ? body.cast.cast ?? null : null
  }

  const hydrated = await Promise.all(slots.map(async ({ item: row, resurfaced, after }) => {
    const [cast, rebuttal] = await Promise.all([
      castOf(row.fid, row.hash),
      row.rebuttal_hash && row.rebuttal_fid !== null ? castOf(row.rebuttal_fid, row.rebuttal_hash) : Promise.resolve(null),
    ])
    return { row, resurfaced, after, cast, rebuttal }
  }))
  if (hydrated.some(h => h.cast === 'unauthorized')) return unauthorized()

  // Walk in rank order until the page is full. The cursor is the position past the last row
  // examined, kept or skipped, so a deleted cast is never re-examined on the next page.
  let next: FeedCursor = at
  const kept: typeof hydrated = []
  for (const h of hydrated) {
    if (kept.length === limit) break
    next = h.after
    if (h.cast !== null) kept.push(h)
  }
  const exhausted = next.f >= freshRanked.length && next.o >= oldRanked.length

  // An empty suggestion was declined: sent as null so the boxes fall back to static copy.
  const suggestions = await store.suggestionsFor(kept.map(h => h.row.hash), SUGGEST_VERSION)
  const items = kept
    .map(({ row, resurfaced, cast, rebuttal }) => ({
      cast,
      rebuttal: rebuttal === 'unauthorized' ? null : rebuttal,
      question: row.question,
      challengeReason: row.challenge_reason,
      backSuggestion: suggestions.get(row.hash)?.back || null,
      challengeSuggestion: suggestions.get(row.hash)?.challenge || null,
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
