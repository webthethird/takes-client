import { describe, expect, it } from 'vitest'
import { rowsOfPage } from '../backfill.ts'
import { archiveRowOf, CastMessage, FARCASTER_EPOCH } from './archive-row.ts'
import { parseEmbeds, parseMentions } from './text.ts'

const H = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
// The shape castsByFid returns (abridged from a real Hypersnap response).
const msg = (o: { hash: number; ts: number; text?: string; parent?: number; type?: string; embeds?: unknown[] }) => ({
  hash: H(o.hash),
  data: {
    type: o.type ?? 'MESSAGE_TYPE_CAST_ADD', fid: 374565, timestamp: o.ts - FARCASTER_EPOCH, network: 'FARCASTER_NETWORK_MAINNET',
    castAddBody: {
      embedsDeprecated: [], mentions: [16823], mentionsPositions: [29], parentUrl: null, type: 'CAST',
      parentCastId: o.parent ? { fid: 1325, hash: H(o.parent) } : null,
      text: o.text ?? 'a take that is long enough to count', embeds: o.embeds ?? [],
    },
  },
})

describe('archiveRowOf: the same row Warpstack indexes', () => {
  it('converts time, parent, mentions and embeds into the index column formats', () => {
    const row = archiveRowOf(CastMessage.parse(msg({
      hash: 1, ts: 1_793_000_000, parent: 9,
      embeds: [{ url: 'https://a.example/x.jpg' }, { castId: { fid: 7, hash: H(2) } }],
    })))!
    expect(row).toMatchObject({ hash: H(1), fid: 374565, ts: 1_793_000_000, reply: 1, parent_hash: H(9), parent_fid: 1325 })
    // Read back by the same parsers the index's rows go through.
    expect(parseMentions(row.mentions)).toEqual([{ fid: 16823, position: 29 }])
    expect(parseEmbeds(row.embeds)).toEqual({ urls: ['https://a.example/x.jpg'], quoted: { fid: 7, hash: H(2) } })
  })
  it('is null for anything but a cast add', () => {
    expect(archiveRowOf(CastMessage.parse(msg({ hash: 1, ts: 1_793_000_000, type: 'MESSAGE_TYPE_CAST_REMOVE' })))).toBeNull()
  })
})

describe('rowsOfPage: what the walk keeps', () => {
  const floor = 1_791_000_000, indexStart = 1_792_000_000
  it('keeps older roots and every reply, and stops at the floor', () => {
    const page = [
      msg({ hash: 1, ts: 1_792_500_000 }),                // root in the index window: the index has it
      msg({ hash: 2, ts: 1_792_400_000, parent: 99 }),    // reply in the window: kept, for counting repliers
      msg({ hash: 3, ts: 1_791_500_000 }),                // root before the index: kept
      msg({ hash: 4, ts: 1_791_400_000, text: 'gm' }),    // too short to be a take
      msg({ hash: 5, ts: 1_790_900_000 }),                  // past the floor: ends the author
      msg({ hash: 6, ts: 1_790_800_000 }),
    ]
    const { rows, pastFloor } = rowsOfPage(page, floor, indexStart)
    expect(rows.map(r => r.hash)).toEqual([H(2), H(3)])
    expect(pastFloor).toBe(true)
  })
  it('skips malformed messages instead of failing the page', () => {
    const { rows, pastFloor } = rowsOfPage([{ junk: true }, { hash: 'nope', data: {} }, msg({ hash: 3, ts: 1_791_500_000 })], floor, indexStart)
    expect(rows.map(r => r.hash)).toEqual([H(3)])
    expect(pastFloor).toBe(false)
  })
})
