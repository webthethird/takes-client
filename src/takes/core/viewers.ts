// Viewers: the people whose follow graphs shape scoring and the "For you" feed.
//
// Until the web can sign in, a viewer is whoever types a username or FID ("Viewing as"). Follow
// lists are public, so this reveals nothing; the limits below bound the load a stranger can add
// (node reads for follow lists, and casts queued for Claude), not access.
//
// Claude spend doesn't grow with viewers: every pass has one budget (TAKES_MAX_CALLS). Viewers'
// follows go first, newest viewer first, taking turns; a floor keeps a share for the
// network-wide lanes, which every viewer sees, so a burst of new viewers can't stall them.

/** At most this many viewers are active (most recently seen first). */
export const MAX_ACTIVE_VIEWERS = 200
/** A viewer stays active this long after their last visit. */
export const VIEWER_ACTIVE_DAYS = 14
/** New viewers admitted per hour, across the deployment: the real bound on added load. */
export const NEW_VIEWERS_PER_HOUR = 30
/** A visit refreshes last_seen at most this often, so most feed requests write nothing. */
export const TOUCH_EVERY = 3600
/** Share of each pass's classification budget kept for the network-wide lanes when they have work. */
export const GLOBAL_FLOOR = 0.25
/** Follow lists fetched from the node per pass, at most. */
export const FOLLOWS_REFRESH_PER_PASS = 3
/** New viewers whose follows' whole window is scanned per pass (one query each). */
export const BACKLOG_VIEWERS_PER_PASS = 4
/** Caught-up viewers' follows are found in one scan of this many recent hours of root casts. */
export const FOLLOW_SCAN_HOURS = 6

export type ViewerQuery = { fid: number } | { username: string }

/**
 * What someone typed into "Viewing as": an FID, or a username with or without the @. Usernames
 * are Farcaster names (a-z, 0-9, hyphens, up to 16) or ENS names ending in .eth. Null when it
 * can be neither, so the node is never asked about junk.
 */
export const parseViewerQuery = (raw: string): ViewerQuery | null => {
  const q = raw.trim().replace(/^@/, '').toLowerCase()
  if (/^[0-9]{1,12}$/.test(q)) {
    const fid = Number(q)
    return fid > 0 && Number.isSafeInteger(fid) ? { fid } : null
  }
  if (/^[a-z0-9][a-z0-9-]{0,15}$/.test(q)) return { username: q }
  if (/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.eth$/.test(q) && q.length <= 255) return { username: q }
  return null
}

/**
 * The casts to classify this pass, in order, at most `budget`. Follows first: the newest
 * viewer's backlog first, viewers taking one cast each in turn, then the caught-up viewers'
 * new casts; then the network-wide lanes. When the network-wide lanes have work, they keep
 * `GLOBAL_FLOOR` of the budget (rounded up); whatever either side can't use goes to the other.
 * Each cast appears once, at its first position.
 */
export const planStage1 = <T extends { hash: string }>(opts: {
  /** Per viewer, newest viewer first: their follows' unclassified casts, in their own order. */
  backlogs: ReadonlyArray<readonly T[]>
  /** Caught-up viewers' follows' new casts. */
  steady: readonly T[]
  /** The network-wide lanes, in priority order. */
  global: readonly T[]
  budget: number
  floor?: number
}): Array<T & { lane: 'following' | 'global' }> => {
  const { backlogs, steady, global, budget } = opts
  if (budget <= 0) return []
  const seen = new Set<string>()
  const follows: T[] = []
  const take = (into: T[], x: T) => {
    if (seen.has(x.hash)) return
    seen.add(x.hash)
    into.push(x)
  }
  // Round-robin over the backlogs, then the steady list.
  const longest = Math.max(0, ...backlogs.map(b => b.length))
  for (let i = 0; i < longest; i++) for (const b of backlogs) if (i < b.length) take(follows, b[i]!)
  for (const x of steady) take(follows, x)
  const others: T[] = []
  for (const x of global) take(others, x)

  const reserved = Math.min(others.length, Math.ceil(budget * (opts.floor ?? GLOBAL_FLOOR)))
  const nFollow = Math.min(follows.length, budget - reserved)
  const nGlobal = Math.min(others.length, budget - nFollow)
  return [
    ...follows.slice(0, nFollow).map(x => ({ ...x, lane: 'following' as const })),
    ...others.slice(0, nGlobal).map(x => ({ ...x, lane: 'global' as const })),
  ]
}

/** Viewers whose follow list is missing go first (newest first), then the stalest refreshed. */
export const followsToRefresh = <V extends { fid: number; firstSeen: number; followsTs: number | null }>(
  viewers: readonly V[], now: number, ttl: number, n = FOLLOWS_REFRESH_PER_PASS,
): V[] => {
  const missing = viewers.filter(v => v.followsTs === null).sort((a, b) => b.firstSeen - a.firstSeen || a.fid - b.fid)
  const stale = viewers.filter(v => v.followsTs !== null && now - v.followsTs > ttl).sort((a, b) => a.followsTs! - b.followsTs! || a.fid - b.fid)
  return [...missing, ...stale].slice(0, n)
}

export type ViewerStatus =
  /** Their follows are loaded and caught up: the feed is theirs. */
  | 'ready'
  /** Admitted; their follows are loading or their follows' casts are still being scored. */
  | 'personalizing'
  /** No Farcaster account with that FID. */
  | 'unknown'
  /** Not admitted just now (too many new viewers, or the node didn't answer): try again later. */
  | 'busy'

export const statusOf = (v: { followsTs: number | null; caughtUp: boolean }): ViewerStatus =>
  v.followsTs !== null && v.caughtUp ? 'ready' : 'personalizing'
