// The archive (migrations-takes/0006_archive.sql): casts from before the cast index begins,
// in the TAKES database. Read alongside the index by Casts, below; D1 can't join the two
// databases, so anything spanning both is two queries merged here.

import type { ArchiveRow } from '../core/archive-row.ts'
import { CastIndex, toCast, type Candidate, type IndexedCast, type Row } from './cast-index.ts'

const CHUNK = 400
/** Rows per insert: one JSON parameter, kept well under D1's 2 MB value limit even for 10k-character casts. */
const INSERT_ROWS = 100

export type ArchiveMeta = { seededTs: number; floorTs: number; indexStart: number }
export type ArchiveProgress = { authors: number; done: number; stored: number; casts: number }

const COLS = 'hash, fid, ts, text, parent_hash, mentions, embeds'

/**
 * The archive lanes return only casts not yet classified under `promptVersion`. The archive
 * and the classifications share a database, so this is one query, and the lane's limit applies
 * to work still to do. Without it, a lane bigger than its limit stalls: measured, all 2,000 of
 * the newest gated roots were classified while 1,262 older ones never entered the queue.
 */
const unclassified = (param: string) => `NOT EXISTS (SELECT 1 FROM classifications k WHERE k.hash = c.hash AND k.prompt_version = ${param})`

export class Archive {
  constructor(private readonly db: D1Database) {}

  async meta(): Promise<ArchiveMeta | null> {
    const r = await this.db.prepare('SELECT seeded_ts, floor_ts, index_start FROM archive_meta WHERE id = 1')
      .first<{ seeded_ts: number; floor_ts: number; index_start: number }>()
    return r ? { seededTs: r.seeded_ts, floorTs: r.floor_ts, indexStart: r.index_start } : null
  }

  /** Records the walk's bounds and its authors, once, in one batch. */
  async seed(meta: ArchiveMeta, authors: ReadonlyArray<{ fid: number; priority: number }>): Promise<void> {
    const stmts = [this.db.prepare('INSERT INTO archive_meta (id, seeded_ts, floor_ts, index_start) VALUES (1, ?1, ?2, ?3)')
      .bind(meta.seededTs, meta.floorTs, meta.indexStart)]
    for (let i = 0; i < authors.length; i += 2000) {
      stmts.push(this.db.prepare(
        `INSERT OR IGNORE INTO archive_authors (fid, priority)
         SELECT json_extract(value, '$.fid'), json_extract(value, '$.priority') FROM json_each(?1)`,
      ).bind(JSON.stringify(authors.slice(i, i + 2000))))
    }
    await this.db.batch(stmts)
  }

  async nextAuthors(n: number): Promise<Array<{ fid: number; pageToken: string | null }>> {
    const { results } = await this.db.prepare(
      'SELECT fid, page_token FROM archive_authors WHERE done = 0 ORDER BY priority DESC, fid LIMIT ?1',
    ).bind(n).all<{ fid: number; page_token: string | null }>()
    return results.map(r => ({ fid: r.fid, pageToken: r.page_token }))
  }

  async progress(): Promise<ArchiveProgress> {
    const a = await this.db.prepare('SELECT count(*) AS authors, coalesce(sum(done), 0) AS done, coalesce(sum(stored), 0) AS stored FROM archive_authors')
      .first<{ authors: number; done: number; stored: number }>()
    const c = await this.db.prepare('SELECT count(*) AS n FROM archive_casts').first<{ n: number }>()
    return { authors: a?.authors ?? 0, done: a?.done ?? 0, stored: a?.stored ?? 0, casts: c?.n ?? 0 }
  }

  /**
   * One author's page, atomically: its casts and where the walk resumes. A pass that dies
   * between pages loses nothing and repeats nothing but the page it was on.
   */
  async putPage(fid: number, rows: readonly ArchiveRow[], resume: { pageToken: string | null; done: boolean }, now: number): Promise<void> {
    const stmts: D1PreparedStatement[] = []
    for (let i = 0; i < rows.length; i += INSERT_ROWS) {
      stmts.push(this.db.prepare(
        `INSERT OR IGNORE INTO archive_casts (hash, fid, ts, reply, parent_hash, parent_fid, text, embeds, mentions)
         SELECT json_extract(value, '$.hash'), json_extract(value, '$.fid'), json_extract(value, '$.ts'), json_extract(value, '$.reply'),
                json_extract(value, '$.parent_hash'), json_extract(value, '$.parent_fid'), json_extract(value, '$.text'),
                json_extract(value, '$.embeds'), json_extract(value, '$.mentions')
           FROM json_each(?1)`,
      ).bind(JSON.stringify(rows.slice(i, i + INSERT_ROWS))))
    }
    stmts.push(this.db.prepare(
      'UPDATE archive_authors SET page_token = ?2, done = ?3, stored = stored + ?4, updated_ts = ?5 WHERE fid = ?1',
    ).bind(fid, resume.pageToken, resume.done ? 1 : 0, rows.length, now))
    await this.db.batch(stmts)
  }

  /** An author the node won't serve (not a transient error): marked done so the walk moves on. */
  async skipAuthor(fid: number, now: number): Promise<void> {
    await this.db.prepare('UPDATE archive_authors SET done = 1, page_token = NULL, updated_ts = ?2 WHERE fid = ?1').bind(fid, now).run()
  }

  /** Root casts by these authors since `since`, newest first: the following lane, over the archive's range. */
  async byAuthors(fids: readonly number[], since: number, minLen: number, limit: number, promptVersion: string): Promise<IndexedCast[]> {
    if (fids.length === 0) return []
    const { results } = await this.db.prepare(
      `SELECT ${COLS} FROM archive_casts c
        WHERE reply = 0 AND ts >= ?1 AND length(text) >= ?3 AND fid IN (SELECT value FROM json_each(?2)) AND ${unclassified('?5')}
        ORDER BY ts DESC LIMIT ?4`,
    ).bind(since, JSON.stringify(fids), minLen, limit, promptVersion).all<Row>()
    return results.map(toCast)
  }

  /**
   * Root casts in [since, until) with replies from at least `minRepliers` distinct people other
   * than the author, counted among the replies the walk stored. Likes aren't read for archived
   * casts: in the index, only 18 of 727 attention-gated casts passed on likes alone.
   */
  async attention(opts: { since: number; until: number; minRepliers: number; minLen: number; limit: number; promptVersion: string }): Promise<Candidate[]> {
    const { results } = await this.db.prepare(
      `WITH rep AS (
         SELECT r.parent_hash AS hash, COUNT(DISTINCT r.fid) AS repliers
           FROM archive_casts r JOIN archive_casts c ON c.hash = r.parent_hash
          WHERE r.reply = 1 AND r.fid != c.fid AND c.reply = 0 AND c.ts >= ?1 AND c.ts < ?2
          GROUP BY r.parent_hash
       )
       SELECT c.hash, c.fid, c.ts, c.text, c.parent_hash, c.mentions, c.embeds, rep.repliers
         FROM rep JOIN archive_casts c ON c.hash = rep.hash
        WHERE rep.repliers >= ?3 AND length(c.text) >= ?4 AND ${unclassified('?6')}
        ORDER BY c.ts DESC LIMIT ?5`,
    ).bind(opts.since, opts.until, opts.minRepliers, opts.minLen, opts.limit, opts.promptVersion).all<Row>()
    return results.map(r => ({ ...toCast(r), repliers: r.repliers ?? 0, likes: 0 }))
  }

  async byHashes(hashes: readonly string[]): Promise<Map<string, IndexedCast>> {
    const out = new Map<string, IndexedCast>()
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const { results } = await this.db.prepare(`SELECT ${COLS} FROM archive_casts WHERE hash IN (SELECT value FROM json_each(?1))`)
        .bind(JSON.stringify(hashes.slice(i, i + CHUNK))).all<Row>()
      for (const r of results) out.set(r.hash, toCast(r))
    }
    return out
  }

  async thread(rootHash: string, maxDepth: number, limit: number): Promise<IndexedCast[]> {
    const { results } = await this.db.prepare(
      `WITH RECURSIVE t(${COLS}, depth) AS (
         SELECT ${COLS}, 1 FROM archive_casts WHERE parent_hash = ?1
         UNION ALL
         SELECT c.hash, c.fid, c.ts, c.text, c.parent_hash, c.mentions, c.embeds, t.depth + 1
           FROM archive_casts c JOIN t ON c.parent_hash = t.hash WHERE t.depth < ?2
       )
       SELECT ${COLS} FROM t ORDER BY ts, hash LIMIT ?3`,
    ).bind(rootHash, maxDepth, limit).all<Row>()
    return results.map(toCast)
  }

  /** Drops casts older than `before`: past the lookback, nothing reads them. */
  async prune(before: number): Promise<number> {
    const r = await this.db.prepare('DELETE FROM archive_casts WHERE ts < ?1').bind(before).run()
    return r.meta.changes
  }
}

/**
 * The cast index and the archive, read as one where a cast may be in either. The index wins
 * where both hold a cast (it tracks deletes; the archive is as of the walk).
 */
export class Casts {
  constructor(private readonly index: CastIndex, private readonly archive: Archive) {}

  async byHashes(hashes: readonly string[]): Promise<Map<string, IndexedCast>> {
    const found = await this.index.byHashes(hashes)
    const missing = hashes.filter(h => !found.has(h))
    if (missing.length > 0) for (const [h, c] of await this.archive.byHashes(missing)) found.set(h, c)
    return found
  }

  /**
   * A root's replies from both. Each side follows nesting within its own database only, so a
   * reply in one to a reply in the other is reached only if it's a direct reply to the root.
   */
  async thread(rootHash: string, maxDepth: number, limit: number): Promise<IndexedCast[]> {
    const [a, b] = await Promise.all([this.index.thread(rootHash, maxDepth, limit), this.archive.thread(rootHash, maxDepth, limit)])
    const byHash = new Map<string, IndexedCast>()
    for (const c of [...b, ...a]) byHash.set(c.hash, c) // index rows overwrite archive ones
    return [...byHash.values()].sort((x, y) => x.ts - y.ts || (x.hash < y.hash ? -1 : x.hash > y.hash ? 1 : 0)).slice(0, limit)
  }
}
