// Takes' own tables (the TAKES binding; schema in migrations-takes/).

import type { Claim } from '../schema.ts'
import type { CardScore, ReplyStance, Stance } from '../core/score.ts'

/** Hashes per bound JSON array: ~44 bytes each keeps a parameter near 20 KB. */
const CHUNK = 400

export type OpinionRoot = { hash: string; fid: number; ts: number; claim: Claim; lane: string }
export type ScoreRow = {
  hash: string; fid: number; ts: number; band: number; credit: number; both_sides: number
  yes_authors: number; no_authors: number; question: string; challenge_reason: string
  author_stance: 'yes' | 'no'; rebuttal_hash: string | null; rebuttal_fid: number | null
}

export class TakesStore {
  constructor(private readonly db: D1Database, private readonly promptVersion: string) {}

  /* Lease: one scoring pass at a time. */

  async acquire(name: string, now: number, ttl: number): Promise<boolean> {
    const r = await this.db.prepare(
      `INSERT INTO leases (name, until) VALUES (?1, ?2)
       ON CONFLICT (name) DO UPDATE SET until = excluded.until WHERE leases.until < ?3`,
    ).bind(name, now + ttl, now).run()
    return r.meta.changes > 0
  }

  async release(name: string): Promise<void> {
    await this.db.prepare('DELETE FROM leases WHERE name = ?1').bind(name).run()
  }

  /* Follows */

  async followsAge(viewer: number): Promise<number | null> {
    const r = await this.db.prepare('SELECT ts FROM follows_meta WHERE viewer = ?1').bind(viewer).first<{ ts: number }>()
    return r?.ts ?? null
  }

  async follows(viewer: number): Promise<Set<number>> {
    const { results } = await this.db.prepare('SELECT fid FROM follows WHERE viewer = ?1').bind(viewer).all<{ fid: number }>()
    return new Set(results.map(r => r.fid))
  }

  /** Replaces the viewer's follow set in one batch: readers see the old set or the new one. */
  async putFollows(viewer: number, fids: readonly number[], now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM follows WHERE viewer = ?1').bind(viewer),
      this.db.prepare('INSERT INTO follows (viewer, fid) SELECT ?1, value FROM json_each(?2)').bind(viewer, JSON.stringify(fids)),
      this.db.prepare(
        'INSERT INTO follows_meta (viewer, ts, count) VALUES (?1, ?2, ?3) ON CONFLICT (viewer) DO UPDATE SET ts = excluded.ts, count = excluded.count',
      ).bind(viewer, now, fids.length),
    ])
  }

  /* Names, for rendering mentions */

  async names(fids: readonly number[]): Promise<Map<number, string | null>> {
    if (fids.length === 0) return new Map()
    const { results } = await this.db.prepare('SELECT fid, username FROM names WHERE fid IN (SELECT value FROM json_each(?1))')
      .bind(JSON.stringify(fids)).all<{ fid: number; username: string | null }>()
    return new Map(results.map(r => [r.fid, r.username]))
  }

  async putName(fid: number, username: string | null, now: number): Promise<void> {
    await this.db.prepare('INSERT OR REPLACE INTO names (fid, username, ts) VALUES (?1, ?2, ?3)').bind(fid, username, now).run()
  }

  /* Stage 1 */

  /** Which of these hashes are already classified under the current prompt version. */
  async classified(hashes: readonly string[]): Promise<Set<string>> {
    const out = new Set<string>()
    // Chunked: one bound JSON parameter of thousands of hashes would pass D1's size limits.
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const { results } = await this.db.prepare(
        'SELECT hash FROM classifications WHERE prompt_version = ?1 AND hash IN (SELECT value FROM json_each(?2))',
      ).bind(this.promptVersion, JSON.stringify(hashes.slice(i, i + CHUNK))).all<{ hash: string }>()
      for (const r of results) out.add(r.hash)
    }
    return out
  }

  async putClassification(c: {
    hash: string; fid: number; ts: number; lane: string; isOpinion: boolean; reason: string; claim: Claim | null; now: number
  }): Promise<void> {
    await this.db.prepare(
      `INSERT OR REPLACE INTO classifications (hash, fid, ts, lane, prompt_version, is_opinion, reason, claim, classified_ts)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(c.hash, c.fid, c.ts, c.lane, this.promptVersion, c.isOpinion ? 1 : 0, c.reason, c.claim ? JSON.stringify(c.claim) : null, c.now).run()
  }

  /** Opinion roots with a usable claim, cast at or after `since`, newest first. */
  async opinionRoots(since: number): Promise<OpinionRoot[]> {
    const { results } = await this.db.prepare(
      `SELECT hash, fid, ts, claim, lane FROM classifications
        WHERE claim IS NOT NULL AND prompt_version = ?1 AND ts >= ?2 ORDER BY ts DESC`,
    ).bind(this.promptVersion, since).all<{ hash: string; fid: number; ts: number; claim: string; lane: string }>()
    return results.map(r => ({ hash: r.hash, fid: r.fid, ts: r.ts, lane: r.lane, claim: JSON.parse(r.claim) as Claim }))
  }

  /* Stage 2 */

  async stances(rootHashes: readonly string[]): Promise<Map<string, ReplyStance[]>> {
    const out = new Map<string, ReplyStance[]>()
    for (let i = 0; i < rootHashes.length; i += CHUNK) {
    const { results } = await this.db.prepare(
      `SELECT root_hash, reply_hash, fid, stance, confidence, text_len FROM stances
        WHERE prompt_version = ?1 AND root_hash IN (SELECT value FROM json_each(?2))`,
    ).bind(this.promptVersion, JSON.stringify(rootHashes.slice(i, i + CHUNK)))
      .all<{ root_hash: string; reply_hash: string; fid: number; stance: Stance; confidence: number; text_len: number }>()
    for (const r of results) {
      const list = out.get(r.root_hash) ?? []
      list.push({ hash: r.reply_hash, fid: r.fid, stance: r.stance, confidence: r.confidence, textLen: r.text_len })
      out.set(r.root_hash, list)
    }
    }
    return out
  }

  async putStance(s: {
    rootHash: string; replyHash: string; fid: number; stance: Stance; confidence: number; textLen: number
    corrected: boolean; detail: unknown; now: number
  }): Promise<void> {
    await this.db.prepare(
      `INSERT OR REPLACE INTO stances
         (reply_hash, root_hash, prompt_version, fid, stance, confidence, text_len, corrected, detail, classified_ts)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(s.replyHash, s.rootHash, this.promptVersion, s.fid, s.stance, s.confidence, s.textLen, s.corrected ? 1 : 0,
      JSON.stringify(s.detail), s.now).run()
  }

  /* Scores */

  async putScores(rows: ReadonlyArray<{ root: OpinionRoot; score: CardScore }>, now: number): Promise<void> {
    if (rows.length === 0) return
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO scores (hash, fid, ts, band, credit, both_sides, yes_authors, no_authors, question,
         challenge_reason, author_stance, rebuttal_hash, rebuttal_fid, updated_ts)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    )
    await this.db.batch(rows.map(({ root, score: s }) => stmt.bind(
      root.hash, root.fid, root.ts, s.band, s.credit, s.bothSides ? 1 : 0, s.yesAuthors, s.noAuthors, root.claim.question,
      root.claim.challenge_reason, root.claim.answer, s.rebuttal?.hash ?? null, s.rebuttal?.fid ?? null, now,
    )))
  }

  /** Scores for casts in [since, until) at `minBand` or above, best band first, bounded. */
  async scores(opts: { since: number; until: number; minBand: number; limit: number }): Promise<ScoreRow[]> {
    const { results } = await this.db.prepare(
      `SELECT hash, fid, ts, band, credit, both_sides, yes_authors, no_authors, question, challenge_reason,
              author_stance, rebuttal_hash, rebuttal_fid
         FROM scores WHERE ts >= ?1 AND ts < ?2 AND band >= ?3 ORDER BY band DESC, ts DESC LIMIT ?4`,
    ).bind(opts.since, opts.until, opts.minBand, opts.limit).all<ScoreRow>()
    return results
  }

  /** Drops cards whose root is gone from the index (deleted, or pruned past retention). */
  async dropScores(hashes: readonly string[]): Promise<void> {
    if (hashes.length === 0) return
    await this.db.prepare('DELETE FROM scores WHERE hash IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(hashes)).run()
  }
}
