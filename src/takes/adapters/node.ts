// Reads the viewer's follow list from the configured node. A fixed, operator-configured
// host (the first node in SNAPCHAIN_URL), never a user-supplied URL, like Warpstack's own
// HttpSnapchain. Only the first node: Hypersnap and Snapchain number events differently, and
// a follow list is the same on both, so there is nothing to fail over for here.

import { z } from 'zod'

const LinksPage = z.object({
  messages: z.array(z.object({ data: z.object({ linkBody: z.object({ targetFid: z.number().int().positive() }).optional() }) })),
  nextPageToken: z.string().optional(),
})

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
    for (const m of parsed.data.messages) if (m.data.linkBody) fids.add(m.data.linkBody.targetFid)
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
