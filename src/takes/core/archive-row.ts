// A node cast message as a row of archive_casts: the same shape Warpstack's index stores
// (Warpstack's core/rows.ts castRowOf, which isn't exported), so parseEmbeds and parseMentions
// read both. Anything that isn't a well-formed CAST_ADD is null, never a guess.

import { z } from 'zod'
import type { Embed } from './text.ts'

/** Farcaster timestamps count seconds from 2021-01-01T00:00:00Z. */
export const FARCASTER_EPOCH = 1_609_459_200

const CastId = z.object({ fid: z.number().int().positive(), hash: z.string().regex(/^0x[0-9a-f]{40}$/) })
export const CastMessage = z.object({
  hash: z.string().regex(/^0x[0-9a-f]{40}$/),
  data: z.object({
    type: z.string(),
    fid: z.number().int().positive(),
    timestamp: z.number().int().nonnegative(),
    castAddBody: z.object({
      text: z.string(),
      mentions: z.array(z.number().int().positive()).default([]),
      mentionsPositions: z.array(z.number().int().nonnegative()).default([]),
      embeds: z.array(z.object({ url: z.string().optional(), castId: CastId.optional() })).default([]),
      parentCastId: CastId.nullish(),
    }).nullish(),
  }),
})
export type CastMessage = z.infer<typeof CastMessage>

export type ArchiveRow = {
  hash: string; fid: number; ts: number; reply: 0 | 1; parent_hash: string | null; parent_fid: number | null
  text: string; embeds: string; mentions: string
}

export const archiveRowOf = (m: CastMessage): ArchiveRow | null => {
  const body = m.data.castAddBody
  if (m.data.type !== 'MESSAGE_TYPE_CAST_ADD' || !body) return null
  const embeds = body.embeds.flatMap((e): Embed[] =>
    e.castId ? [{ kind: 'cast', cast: { fid: e.castId.fid, hash: e.castId.hash } }] : e.url ? [{ kind: 'url', url: e.url }] : [])
  const mentions = body.mentions.map((fid, i) => ({ fid, position: body.mentionsPositions[i] ?? 0 }))
  return {
    hash: m.hash,
    fid: m.data.fid,
    ts: m.data.timestamp + FARCASTER_EPOCH,
    reply: body.parentCastId ? 1 : 0,
    parent_hash: body.parentCastId?.hash ?? null,
    parent_fid: body.parentCastId?.fid ?? null,
    text: body.text,
    embeds: JSON.stringify(embeds),
    mentions: JSON.stringify(mentions),
  }
}
