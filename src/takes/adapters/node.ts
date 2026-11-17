// Reads the viewer's follow list from the configured node. A fixed, operator-configured
// host (the first node in SNAPCHAIN_URL), never a user-supplied URL, like Warpstack's own
// HttpSnapchain. Only the first node: Hypersnap and Snapchain number events differently, and
// a follow list is the same on both, so there is nothing to fail over for here.

import { z } from 'zod'

// Messages are checked one by one: one malformed follow mustn't sink a viewer's whole list.
// Seen live: a node returned one targetFid as the string "4294967309" among 819 numbers.
const LinksPage = z.object({ messages: z.array(z.unknown()), nextPageToken: z.string().optional() })
const FollowTarget = z.object({ data: z.object({ linkBody: z.object({ targetFid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }) }) })

const PAGE_SIZE = 1000
/** Bounds the read: 20,000 follows is far past any real account. */
const MAX_PAGES = 20

export type FollowRead = { ok: true; fids: number[]; complete: boolean } | { ok: false; error: string }

export const readFollows = async (nodeUrls: string, fid: number): Promise<FollowRead> => {
  const node = nodeUrls.split(',')[0]?.trim()
  if (!node) return { ok: false, error: 'SNAPCHAIN_URL is not set' }
  const fids = new Set<number>()
  let token: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('/v1/linksByFid', node)
    url.searchParams.set('fid', String(fid))
    url.searchParams.set('link_type', 'follow')
    url.searchParams.set('pageSize', String(PAGE_SIZE))
    if (token) url.searchParams.set('pageToken', token)
    let body: unknown
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return { ok: false, error: `linksByFid: ${res.status}` }
      body = await res.json()
    } catch (e) {
      return { ok: false, error: `linksByFid: ${String(e)}` }
    }
    const parsed = LinksPage.safeParse(body)
    if (!parsed.success) return { ok: false, error: `linksByFid: unexpected shape: ${parsed.error.message.slice(0, 200)}` }
    for (const m of parsed.data.messages) {
      const f = FollowTarget.safeParse(m)
      if (f.success) fids.add(f.data.data.linkBody.targetFid)
    }
    // The node returns an empty token, not none, on the last page.
    token = parsed.data.nextPageToken || undefined
    if (!token) return { ok: true, fids: [...fids], complete: true }
  }
  return { ok: true, fids: [...fids], complete: false }
}

const UserData = z.object({
  messages: z.array(z.object({ data: z.object({ userDataBody: z.object({ type: z.string(), value: z.string() }).optional() }) })),
})

/** The FID's current username: a string, null when it has none, or an error. */
export const readUsername = async (nodeUrls: string, fid: number): Promise<{ ok: true; name: string | null } | { ok: false; error: string }> => {
  const node = nodeUrls.split(',')[0]?.trim()
  if (!node) return { ok: false, error: 'SNAPCHAIN_URL is not set' }
  const url = new URL('/v1/userDataByFid', node)
  url.searchParams.set('fid', String(fid))
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return { ok: false, error: `userDataByFid: ${res.status}` }
    const parsed = UserData.safeParse(await res.json())
    if (!parsed.success) return { ok: false, error: 'userDataByFid: unexpected shape' }
    const name = parsed.data.messages.find(m => m.data.userDataBody?.type === 'USER_DATA_TYPE_USERNAME')?.data.userDataBody?.value
    return { ok: true, name: name && /^[a-z0-9][a-z0-9.-]{0,63}$/i.test(name) ? name : null }
  } catch (e) {
    return { ok: false, error: `userDataByFid: ${String(e)}` }
  }
}

const NameProof = z.object({ fid: z.number().int().positive() })

/**
 * The FID that owns a username (a Farcaster name or an ENS name), from the node's proof of it:
 * a number, null when the node has no proof for that name, or an error. The caller passes a
 * name already checked by parseViewerQuery; it goes in the query string, never the path.
 */
export const readFidByName = async (nodeUrls: string, name: string): Promise<{ ok: true; fid: number | null } | { ok: false; error: string }> => {
  const node = nodeUrls.split(',')[0]?.trim()
  if (!node) return { ok: false, error: 'SNAPCHAIN_URL is not set' }
  const url = new URL('/v1/userNameProofByName', node)
  url.searchParams.set('name', name)
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) })
    // An unknown name is a 400 (or 404) whose body says the proof wasn't found.
    if (res.status === 400 || res.status === 404) {
      const body = await res.text()
      return /not\s*found/i.test(body) ? { ok: true, fid: null } : { ok: false, error: `userNameProofByName: ${res.status}` }
    }
    if (!res.ok) return { ok: false, error: `userNameProofByName: ${res.status}` }
    const parsed = NameProof.safeParse(await res.json())
    return parsed.success ? { ok: true, fid: parsed.data.fid } : { ok: false, error: 'userNameProofByName: unexpected shape' }
  } catch (e) {
    return { ok: false, error: `userNameProofByName: ${String(e)}` }
  }
}

const CastsPage = z.object({ messages: z.array(z.unknown()), nextPageToken: z.string().nullish() })

export type CastsPageRead =
  | { ok: true; messages: unknown[]; next: string | null }
  | { ok: false; error: string; transient: boolean }

/**
 * One page of an author's casts, newest first (castsByFid with reverse=true). Messages come
 * back unparsed: the caller validates each one, so one malformed message can't sink a page.
 */
export const readCastsPage = async (nodeUrls: string, fid: number, pageToken: string | null, pageSize: number): Promise<CastsPageRead> => {
  const node = nodeUrls.split(',')[0]?.trim()
  if (!node) return { ok: false, error: 'SNAPCHAIN_URL is not set', transient: false }
  const url = new URL('/v1/castsByFid', node)
  url.searchParams.set('fid', String(fid))
  url.searchParams.set('pageSize', String(pageSize))
  url.searchParams.set('reverse', 'true')
  if (pageToken) url.searchParams.set('pageToken', pageToken)
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return { ok: false, error: `castsByFid: ${res.status}`, transient: res.status === 429 || res.status >= 500 }
    const parsed = CastsPage.safeParse(await res.json())
    if (!parsed.success) return { ok: false, error: 'castsByFid: unexpected shape', transient: false }
    // The node returns an empty token, not none, on the last page.
    return { ok: true, messages: parsed.data.messages, next: parsed.data.nextPageToken || null }
  } catch (e) {
    return { ok: false, error: `castsByFid: ${String(e).slice(0, 200)}`, transient: true }
  }
}
