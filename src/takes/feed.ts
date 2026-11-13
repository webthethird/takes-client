// GET /api/takes/feed: the ranked debate feed for the configured viewer.
//
// Each card is hydrated by calling Warpstack's own `cast.get` handler in-process, so the casts
// it returns are exactly the contract's Cast objects, the ones CastCard renders, with no
// presenter of our own to keep in step with Warpstack's.

import { TakesStore, type ScoreRow } from './adapters/store.ts'
import { takesConfig, type Env } from './config.ts'
import {
  FRESH_HOURS, PROMPT_VERSION, RESURFACE_EVERY, STANCE_VERSION, RESURFACE_MAX_DAYS, RESURFACE_MIN_BAND, interleave, rankFeed,
} from './core/score.ts'

type Fetch = (req: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 50
const FRESH_POOL = 300
const OLD_POOL = 100

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

  const cfg = takesConfig(env)
  const store = new TakesStore(env.TAKES, PROMPT_VERSION, STANCE_VERSION)
  const freshSince = now - FRESH_HOURS * 3600
  const [fresh, old, follows] = await Promise.all([
    store.scores({ since: freshSince, until: now + 1, minBand: 0, limit: FRESH_POOL }),
    store.scores({ since: now - RESURFACE_MAX_DAYS * 86_400, until: freshSince, minBand: RESURFACE_MIN_BAND, limit: OLD_POOL }),
    cfg.viewerFid === null ? Promise.resolve(new Set<number>()) : store.follows(cfg.viewerFid),
  ])
  const ranked = interleave(
    rankFeed(fresh, follows).map(r => ({ ...r, resurfaced: false })),
    rankFeed(old, follows).map(r => ({ ...r, resurfaced: true })),
    RESURFACE_EVERY,
  )

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

  const page = ranked.slice(0, limit + 10)
  const hydrated = await Promise.all(page.map(async (row: ScoreRow & { following: boolean; resurfaced: boolean }) => {
    const [cast, rebuttal] = await Promise.all([
      castOf(row.fid, row.hash),
      row.rebuttal_hash && row.rebuttal_fid !== null ? castOf(row.rebuttal_fid, row.rebuttal_hash) : Promise.resolve(null),
    ])
    return { row, cast, rebuttal }
  }))
  if (hydrated.some(h => h.cast === 'unauthorized')) return unauthorized()

  const items = hydrated
    .filter(h => h.cast !== null)
    .slice(0, limit)
    .map(({ row, cast, rebuttal }) => ({
      cast,
      rebuttal: rebuttal === 'unauthorized' ? null : rebuttal,
      question: row.question,
      challengeReason: row.challenge_reason,
      authorStance: row.author_stance,
      bothSides: row.both_sides === 1,
      yesAuthors: row.yes_authors,
      noAuthors: row.no_authors,
      band: row.band,
      following: row.following,
      resurfaced: row.resurfaced,
    }))
  return json({ items, viewerFid: cfg.viewerFid })
}
