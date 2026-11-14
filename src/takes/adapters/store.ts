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
  /**
   * A stance is where a reply lands on ONE question, so it is only valid for the stage-1 prompt
   * that produced that question as well as the stance prompt: a stage-1 change rewrites the
   * questions and must invalidate stances too. Rows are keyed by both versions.
   */
  private readonly stanceVersion: string

  constructor(private readonly db: D1Database, private readonly promptVersion: string, stanceVersion: string) {
    this.stanceVersion = `${stanceVersion}|${promptVersion}`
  }

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

  /* Merge: canonical markets */

  /**
   * Memberships are only meaningful under the rules that made them, and a market's canonical
   * question depends on the order casts joined, so a MERGE_VERSION change rebuilds the whole
   * merge rather than mixing versions.
   */
  async resetMergeIfStale(mergeVersion: string): Promise<boolean> {
    const stale = await this.db.prepare('SELECT 1 FROM market_members WHERE merge_version != ?1 LIMIT 1').bind(mergeVersion).first()
    if (!stale) return false
    await this.db.batch([this.db.prepare('DELETE FROM market_members'), this.db.prepare('DELETE FROM markets')])
    return true
  }

  /** Claims not yet placed in a market, oldest cast first, so the earliest question founds a market. */
  async unmergedClaims(since: number, limit: number): Promise<OpinionRoot[]> {
    const { results } = await this.db.prepare(
      `SELECT c.hash, c.fid, c.ts, c.claim, c.lane FROM classifications c
         LEFT JOIN market_members m ON m.cast_hash = c.hash
        WHERE c.claim IS NOT NULL AND c.prompt_version = ?1 AND c.ts >= ?2 AND m.cast_hash IS NULL
        ORDER BY c.ts ASC, c.hash ASC LIMIT ?3`,
    ).bind(this.promptVersion, since, limit).all<{ hash: string; fid: number; ts: number; claim: string; lane: string }>()
    return results.map(r => ({ hash: r.hash, fid: r.fid, ts: r.ts, lane: r.lane, claim: JSON.parse(r.claim) as Claim }))
  }

  /** Every market of one claim type, oldest first (planMatch breaks ties toward older). */
  async marketsOfType(claimType: string): Promise<Array<{ id: string; question: string; embedding: ArrayBuffer | number[] }>> {
    const { results } = await this.db.prepare(
      'SELECT id, question, embedding FROM markets WHERE claim_type = ?1 ORDER BY created_ts ASC, id ASC',
    ).bind(claimType).all<{ id: string; question: string; embedding: ArrayBuffer | number[] }>()
    return results
  }

  /** Members' own question embeddings, for every market of one claim type. */
  async memberEmbeddingsOfType(claimType: string): Promise<Array<{ market_id: string; embedding: ArrayBuffer | number[] }>> {
    const { results } = await this.db.prepare(
      `SELECT mm.market_id, mm.embedding FROM market_members mm JOIN markets m ON m.id = mm.market_id
        WHERE m.claim_type = ?1 AND mm.embedding IS NOT NULL AND mm.via != 'seed'`,
    ).bind(claimType).all<{ market_id: string; embedding: ArrayBuffer | number[] }>()
    return results
  }

  /**
   * Consolidates market `from` into `into`: its members move over, their answers flipped when
   * YES means the opposite in the two canonical questions, and `from` is deleted. One batch, so
   * no reader sees a member pointing at a deleted market.
   */
  async absorbMarket(from: string, into: string, flip: boolean, detail: unknown): Promise<number> {
    const moved = await this.db.prepare('SELECT count(*) AS n FROM market_members WHERE market_id = ?1').bind(from).first<{ n: number }>()
    await this.db.batch([
      this.db.prepare(
        `UPDATE market_members SET market_id = ?2,
           answer = CASE WHEN ?3 = 1 THEN (CASE answer WHEN 'yes' THEN 'no' ELSE 'yes' END) ELSE answer END,
           detail = json_set(coalesce(detail, '{}'), '$.absorbed', json(?4))
         WHERE market_id = ?1`,
      ).bind(from, into, flip ? 1 : 0, JSON.stringify(detail)),
      this.db.prepare('DELETE FROM markets WHERE id = ?1').bind(from),
    ])
    return moved?.n ?? 0
  }

  async marketById(id: string): Promise<{ id: string; question: string } | null> {
    return this.db.prepare('SELECT id, question FROM markets WHERE id = ?1').bind(id).first<{ id: string; question: string }>()
  }

  async putMarket(m: { id: string; question: string; claimType: string; embedding: ArrayBuffer; seedHash: string; createdTs: number }): Promise<void> {
    await this.db.prepare(
      'INSERT OR IGNORE INTO markets (id, question, claim_type, embedding, seed_hash, created_ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    ).bind(m.id, m.question, m.claimType, m.embedding, m.seedHash, m.createdTs).run()
  }

  async putMember(m: {
    castHash: string; marketId: string; mergeVersion: string; answer: 'yes' | 'no'; via: string
    similarity: number | null; detail: unknown; embedding: ArrayBuffer; now: number
  }): Promise<void> {
    await this.db.prepare(
      `INSERT OR REPLACE INTO market_members (cast_hash, market_id, merge_version, answer, via, similarity, detail, ts, embedding)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(m.castHash, m.marketId, m.mergeVersion, m.answer, m.via, m.similarity, m.detail === undefined ? null : JSON.stringify(m.detail), m.now, m.embedding).run()
  }

  /* Stage 2 */

  async stances(rootHashes: readonly string[]): Promise<Map<string, ReplyStance[]>> {
    const out = new Map<string, ReplyStance[]>()
    for (let i = 0; i < rootHashes.length; i += CHUNK) {
    const { results } = await this.db.prepare(
      `SELECT root_hash, reply_hash, fid, stance, confidence, text_len FROM stances
        WHERE prompt_version = ?1 AND root_hash IN (SELECT value FROM json_each(?2))`,
    ).bind(this.stanceVersion, JSON.stringify(rootHashes.slice(i, i + CHUNK)))
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
    ).bind(s.replyHash, s.rootHash, this.stanceVersion, s.fid, s.stance, s.confidence, s.textLen, s.corrected ? 1 : 0,
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

  /**
   * Drops cards with no current-version claim behind them. Scores are only ever upserted, so
   * without this a cast that stopped being an opinion under a new prompt kept its old card.
   * After a version bump the feed refills as casts are re-classified.
   */
  async pruneStaleScores(): Promise<number> {
    const r = await this.db.prepare(
      `DELETE FROM scores WHERE hash NOT IN
         (SELECT hash FROM classifications WHERE prompt_version = ?1 AND claim IS NOT NULL)`,
    ).bind(this.promptVersion).run()
    return r.meta.changes
  }

  /** Drops cards whose root is gone from the index (deleted, or pruned past retention). */
  async dropScores(hashes: readonly string[]): Promise<void> {
    if (hashes.length === 0) return
    await this.db.prepare('DELETE FROM scores WHERE hash IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(hashes)).run()
  }
}
