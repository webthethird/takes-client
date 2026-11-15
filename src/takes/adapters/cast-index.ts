// Read-only queries against Warpstack's cast index (the DB binding). Warpstack owns that
// schema (node_modules/@warpstack/api/migrations); everything here only SELECTs, and only from
// casts and cast_counts. If an upgrade changes those tables, this file is what breaks.

import { parseEmbeds, parseMentions, type Mention } from '../core/text.ts'

export type IndexedCast = {
  hash: string; fid: number; ts: number; text: string; parentHash: string | null
  mentions: Mention[]; urls: string[]; quoted: { fid: number; hash: string } | null
}
export type Candidate = IndexedCast & { repliers: number; likes: number }

export type Row = {
  hash: string; fid: number; ts: number; text: string; parent_hash: string | null; mentions: string; embeds: string
  repliers?: number; likes?: number
}
export const toCast = (r: Row): IndexedCast => ({
  hash: r.hash, fid: r.fid, ts: r.ts, text: r.text, parentHash: r.parent_hash, mentions: parseMentions(r.mentions), ...parseEmbeds(r.embeds),
})

export class CastIndex {
  constructor(private readonly db: D1Database) {}

  /** Live root casts by these authors since `since`, newest first. */
  async byAuthors(fids: readonly number[], since: number, minLen: number, limit: number): Promise<IndexedCast[]> {
    if (fids.length === 0) return []
    const { results } = await this.db.prepare(
      `SELECT hash, fid, ts, text, parent_hash, mentions, embeds FROM casts
        WHERE reply = 0 AND state = 0 AND ts >= ?1 AND length(text) >= ?3
          AND fid IN (SELECT value FROM json_each(?2))
        ORDER BY ts DESC LIMIT ?4`,
    ).bind(since, JSON.stringify(fids), minLen, limit).all<Row>()
    return results.map(toCast)
  }

  /**
   * Root casts in [since, until) that drew attention: replies from at least `minRepliers`
   * distinct people other than the author, or at least `minLikes` likes. Direct replies only;
   * a nested argument still shows up as direct replies to the root in practice, and keeps this
   * a single grouped scan of the reply index. Newest first.
   */
  async attention(opts: { since: number; until: number; minRepliers: number; minLikes: number; minLen: number; limit: number }):
    Promise<Candidate[]> {
    const { results } = await this.db.prepare(
      `WITH rep AS (
         SELECT r.parent_hash AS hash, COUNT(DISTINCT r.fid) AS repliers
           FROM casts r JOIN casts c ON c.hash = r.parent_hash
          WHERE r.state = 0 AND r.ts >= ?1 AND r.fid != c.fid AND c.reply = 0 AND c.ts >= ?1 AND c.ts < ?2
          GROUP BY r.parent_hash
       )
       SELECT c.hash, c.fid, c.ts, c.text, c.parent_hash, c.mentions, c.embeds,
              coalesce(rep.repliers, 0) AS repliers, coalesce(k.likes, 0) AS likes
         FROM casts c
         LEFT JOIN rep ON rep.hash = c.hash
         LEFT JOIN cast_counts k ON k.hash = c.hash
        WHERE c.reply = 0 AND c.state = 0 AND c.ts >= ?1 AND c.ts < ?2 AND length(c.text) >= ?5
          AND (coalesce(rep.repliers, 0) >= ?3 OR coalesce(k.likes, 0) >= ?4)
        ORDER BY c.ts DESC LIMIT ?6`,
    ).bind(opts.since, opts.until, opts.minRepliers, opts.minLikes, opts.minLen, opts.limit).all<Row>()
    return results.map(r => ({ ...toCast(r), repliers: r.repliers ?? 0, likes: r.likes ?? 0 }))
  }

  /** Live casts by hash; missing or deleted ones are simply absent. */
  async byHashes(hashes: readonly string[]): Promise<Map<string, IndexedCast>> {
    const out = new Map<string, IndexedCast>()
    // Chunked so a bound JSON array stays small (~20 KB) however many roots there are.
    for (let i = 0; i < hashes.length; i += 400) {
      const { results } = await this.db.prepare(
        `SELECT hash, fid, ts, text, parent_hash, mentions, embeds FROM casts
          WHERE state = 0 AND hash IN (SELECT value FROM json_each(?1))`,
      ).bind(JSON.stringify(hashes.slice(i, i + 400))).all<Row>()
      for (const r of results) out.set(r.hash, toCast(r))
    }
    return out
  }

  /** A root's thread, breadth by depth, oldest first, bounded in depth and size. */
  async thread(rootHash: string, maxDepth: number, limit: number): Promise<IndexedCast[]> {
    const { results } = await this.db.prepare(
      `WITH RECURSIVE t(hash, fid, ts, text, parent_hash, mentions, embeds, depth) AS (
         SELECT hash, fid, ts, text, parent_hash, mentions, embeds, 1 FROM casts WHERE parent_hash = ?1 AND state = 0
         UNION ALL
         SELECT c.hash, c.fid, c.ts, c.text, c.parent_hash, c.mentions, c.embeds, t.depth + 1
           FROM casts c JOIN t ON c.parent_hash = t.hash
          WHERE c.state = 0 AND t.depth < ?2
       )
       SELECT hash, fid, ts, text, parent_hash, mentions, embeds FROM t ORDER BY ts, hash LIMIT ?3`,
    ).bind(rootHash, maxDepth, limit).all<Row>()
    return results.map(toCast)
  }
}
