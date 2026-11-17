import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFollows } from './node.ts'

const link = (targetFid: unknown) => ({ data: { type: 'MESSAGE_TYPE_LINK_ADD', linkBody: { type: 'follow', targetFid } } })

afterEach(() => vi.unstubAllGlobals())

describe('readFollows', () => {
  it('skips a malformed follow instead of failing the whole list', async () => {
    const page = { messages: [link(2), link('4294967309'), link(3), { data: {} }, link(-1)], nextPageToken: '' }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(page)))
    expect(await readFollows('https://node.example', 1)).toEqual({ ok: true, fids: [2, 3], complete: true })
  })
  it('a page that is not a page at all is still an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ nope: true })))
    expect((await readFollows('https://node.example', 1)).ok).toBe(false)
  })
})
