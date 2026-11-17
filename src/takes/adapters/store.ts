// Takes' own tables (the TAKES binding; schema in migrations-takes/).

import type { Claim } from '../schema.ts'
import type { CardScore, ReplyStance, Stance } from '../core/score.ts'
import type { CardTopics, StoredTopics } from '../core/topics.ts'

/** Hashes per bound JSON array: ~44 bytes each keeps a parameter near 20 KB. */
const CHUNK = 400

export type OpinionRoot = { hash: string; fid: number; ts: number; claim: Claim; lane: string }
export type ScoreRow = {
  hash: string; fid: number; ts: number; band: number; credit: number; both_sides: number
  yes_authors: number; no_authors: number; question: string; challenge_reason: string
  author_stance: 'yes' | 'no'; rebuttal_hash: string | null; rebuttal_fid: number | null
  market_id: string | null
}

export type StoredViewer = {
  fid: number; username: string | null; firstSeen: number; lastSeen: number; caughtUp: boolean
  /** When their follow list was last read from the node; null before the first read. */
  followsTs: number | null
}
type ViewerRow = { fid: number; username: string | null; first_seen: number; last_seen: number; caught_up: number; follows_ts: number | null }
const toViewer = (r: ViewerRow): StoredViewer => ({
  fid: r.fid, username: r.username, firstSeen: r.first_seen, lastSeen: r.last_seen, caughtUp: r.caught_up === 1, followsTs: r.follows_ts,
})

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

  /* Viewers (core/viewers.ts) */

  async viewer(fid: number): Promise<StoredViewer | null> {
    const r = await this.db.prepare(
      `SELECT v.fid, v.username, v.first_seen, v.last_seen, v.caught_up, m.ts AS follows_ts
         FROM viewers v LEFT JOIN follows_meta m ON m.viewer = v.fid WHERE v.fid = ?1`,
    ).bind(fid).first<ViewerRow>()
    return r ? toViewer(r) : null
  }

  /** The active viewers: seen since `since`, most recent first, at most `limit`. */
  async activeViewers(since: number, limit: number): Promise<StoredViewer[]> {
    const { results } = await this.db.prepare(
      `SELECT v.fid, v.username, v.first_seen, v.last_seen, v.caught_up, m.ts AS follows_ts
         FROM viewers v LEFT JOIN follows_meta m ON m.viewer = v.fid
        WHERE v.last_seen >= ?1 ORDER BY v.last_seen DESC, v.fid LIMIT ?2`,
    ).bind(since, limit).all<ViewerRow>()
    return results.map(toViewer)
  }

  /** Viewers admitted since `since`: what the hourly cap on new viewers counts. */
  async viewersAdmittedSince(since: number): Promise<number> {
    const r = await this.db.prepare('SELECT count(*) AS n FROM viewers WHERE first_seen >= ?1').bind(since).first<{ n: number }>()
    return r?.n ?? 0
  }

  /** Admits a viewer; a viewer already there keeps their row (and first_seen). */
  async addViewer(fid: number, username: string | null, now: number): Promise<void> {
    await this.db.prepare('INSERT OR IGNORE INTO viewers (fid, username, first_seen, last_seen) VALUES (?1, ?2, ?3, ?3)')
      .bind(fid, username, now).run()
  }

  /** Marks a visit, writing only when the last one is older than `every` seconds. */
  async touchViewer(fid: number, now: number, every: number): Promise<void> {
    await this.db.prepare('UPDATE viewers SET last_seen = ?2 WHERE fid = ?1 AND last_seen < ?2 - ?3').bind(fid, now, every).run()
  }

  async setUsername(fid: number, username: string): Promise<void> {
    await this.db.prepare('UPDATE viewers SET username = ?2 WHERE fid = ?1').bind(fid, username).run()
  }

  async setCaughtUp(fid: number, caughtUp: boolean): Promise<void> {
    await this.db.prepare('UPDATE viewers SET caught_up = ?2 WHERE fid = ?1').bind(fid, caughtUp ? 1 : 0).run()
  }

  /** Of these authors, the ones any of these viewers follow. */
  async followedBy(authors: readonly number[], viewers: readonly number[]): Promise<Set<number>> {
    const out = new Set<number>()
    if (viewers.length === 0) return out
    for (let i = 0; i < authors.length; i += CHUNK) {
      const { results } = await this.db.prepare(
        `SELECT DISTINCT fid FROM follows
          WHERE fid IN (SELECT value FROM json_each(?1)) AND viewer IN (SELECT value FROM json_each(?2))`,
      ).bind(JSON.stringify(authors.slice(i, i + CHUNK)), JSON.stringify(viewers)).all<{ fid: number }>()
      for (const r of results) out.add(r.fid)
    }
    return out
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

  /**
   * Each cast's market, for the feed: its id, the cast's answer as stored (on the canonical
   * question) and as the cast itself gave it (on its own question), and the market's size and
   * stored YES count. Casts in no market, or alone in theirs, are absent.
   */
  async marketsOf(hashes: readonly string[]): Promise<Map<string, { marketId: string; stored: 'yes' | 'no'; own: 'yes' | 'no'; takes: number; storedYes: number }>> {
    const out = new Map<string, { marketId: string; stored: 'yes' | 'no'; own: 'yes' | 'no'; takes: number; storedYes: number }>()
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const { results } = await this.db.prepare(
        `SELECT mm.cast_hash, mm.market_id, mm.answer AS stored, json_extract(k.claim, '$.answer') AS own, t.takes, t.yes
           FROM market_members mm
           JOIN classifications k ON k.hash = mm.cast_hash
           JOIN (SELECT market_id, count(*) AS takes, sum(answer = 'yes') AS yes FROM market_members GROUP BY market_id) t
             ON t.market_id = mm.market_id
          WHERE mm.cast_hash IN (SELECT value FROM json_each(?1)) AND t.takes >= 2`,
      ).bind(JSON.stringify(hashes.slice(i, i + CHUNK))).all<{ cast_hash: string; market_id: string; stored: 'yes' | 'no'; own: 'yes' | 'no'; takes: number; yes: number }>()
      for (const r of results) out.set(r.cast_hash, { marketId: r.market_id, stored: r.stored, own: r.own, takes: r.takes, storedYes: r.yes })
    }
    return out
  }

  /** Every member of the markets these casts are in, the casts themselves included. */
  async marketMemberHashes(hashes: readonly string[]): Promise<string[]> {
    const out = new Set<string>()
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const { results } = await this.db.prepare(
        `SELECT x.cast_hash AS hash FROM market_members x
          WHERE x.market_id IN (SELECT market_id FROM market_members WHERE cast_hash IN (SELECT value FROM json_each(?1)))`,
      ).bind(JSON.stringify(hashes.slice(i, i + CHUNK))).all<{ hash: string }>()
      for (const r of results) out.add(r.hash)
    }
    return [...out]
  }

  /**
   * Each cast's market as scoring sees it: the market's size, the distinct authors of its OTHER
   * casts, and whether its casts take both sides (stored answers are all on the canonical
   * question, so two distinct values means two sides). Casts in no market are absent.
   *
   * Members in `removed` (deleted or taken down) count for nothing: markets keep such members,
   * and counting them showed an author's deleted-and-reposted cast as "2 takes" on one claim.
   */
  async marketContexts(hashes: readonly string[], removed: ReadonlySet<string> = new Set()):
    Promise<Map<string, { id: string; takes: number; otherAuthors: number; bothSides: boolean }>> {
    const out = new Map<string, { id: string; takes: number; otherAuthors: number; bothSides: boolean }>()
    const gone = JSON.stringify([...removed])
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const { results } = await this.db.prepare(
        `SELECT me.cast_hash AS hash, me.market_id,
                (SELECT count(*) FROM market_members x WHERE x.market_id = me.market_id
                  AND x.cast_hash NOT IN (SELECT value FROM json_each(?2))) AS takes,
                (SELECT count(DISTINCT k.fid) FROM market_members x JOIN classifications k ON k.hash = x.cast_hash
                  WHERE x.market_id = me.market_id AND k.fid != mine.fid
                    AND x.cast_hash NOT IN (SELECT value FROM json_each(?2))) AS other_authors,
                (SELECT count(DISTINCT x.answer) FROM market_members x WHERE x.market_id = me.market_id
                  AND x.cast_hash NOT IN (SELECT value FROM json_each(?2))) AS sides
           FROM market_members me JOIN classifications mine ON mine.hash = me.cast_hash
          WHERE me.cast_hash IN (SELECT value FROM json_each(?1))`,
      ).bind(JSON.stringify(hashes.slice(i, i + CHUNK)), gone).all<{ hash: string; market_id: string; takes: number; other_authors: number; sides: number }>()
      for (const r of results) out.set(r.hash, { id: r.market_id, takes: r.takes, otherAuthors: r.other_authors, bothSides: r.sides >= 2 })
    }
    return out
  }

  /** A market's members, oldest first: who argued it and their answer on the canonical question. */
  async marketMembers(marketId: string, limit: number): Promise<Array<{ hash: string; fid: number; stored: 'yes' | 'no'; own: 'yes' | 'no' }>> {
    const { results } = await this.db.prepare(
      `SELECT mm.cast_hash AS hash, k.fid, mm.answer AS stored, json_extract(k.claim, '$.answer') AS own
         FROM market_members mm JOIN classifications k ON k.hash = mm.cast_hash
        WHERE mm.market_id = ?1 ORDER BY k.ts LIMIT ?2`,
    ).bind(marketId, limit).all<{ hash: string; fid: number; stored: 'yes' | 'no'; own: 'yes' | 'no' }>()
    return results
  }

  /* Suggest: one reply per side, in the cast's voice */

  /** Which of these roots already have suggestions under `version`. */
  async suggested(hashes: readonly string[], version: string): Promise<Set<string>> {
    const out = new Set<string>()
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const { results } = await this.db.prepare(
        'SELECT hash FROM suggestions WHERE version = ?1 AND hash IN (SELECT value FROM json_each(?2))',
      ).bind(version, JSON.stringify(hashes.slice(i, i + CHUNK))).all<{ hash: string }>()
      for (const r of results) out.add(r.hash)
    }
    return out
  }

  async putSuggestion(s: { hash: string; version: string; back: string; challenge: string; register: string; now: number }): Promise<void> {
    await this.db.prepare(
      'INSERT OR REPLACE INTO suggestions (hash, version, back, challenge, register, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    ).bind(s.hash, s.version, s.back, s.challenge, s.register, s.now).run()
  }

  async suggestionsFor(hashes: readonly string[], version: string): Promise<Map<string, { back: string; challenge: string }>> {
    const out = new Map<string, { back: string; challenge: string }>()
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const { results } = await this.db.prepare(
        'SELECT hash, back, challenge FROM suggestions WHERE version = ?1 AND hash IN (SELECT value FROM json_each(?2))',
      ).bind(version, JSON.stringify(hashes.slice(i, i + CHUNK))).all<{ hash: string; back: string; challenge: string }>()
      for (const r of results) out.set(r.hash, { back: r.back, challenge: r.challenge })
    }
    return out
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

  /** A scored card's author and answer, or null when the cast has no card. */
  async card(hash: string): Promise<{ fid: number; answer: 'yes' | 'no' } | null> {
    return await this.db.prepare('SELECT fid, author_stance AS answer FROM scores WHERE hash = ?1')
      .bind(hash).first<{ fid: number; answer: 'yes' | 'no' }>()
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

  /** Cards, with their topics as columns (null when none: Other, or not filed yet). */
  async putScores(rows: ReadonlyArray<{ root: OpinionRoot; score: CardScore; topics?: CardTopics }>, now: number): Promise<void> {
    if (rows.length === 0) return
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO scores (hash, fid, ts, band, credit, both_sides, yes_authors, no_authors, question,
         challenge_reason, author_stance, rebuttal_hash, rebuttal_fid, updated_ts, market_takes, market_id, topic_a, topic_b)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
    )
    await this.db.batch(rows.map(({ root, score: s, topics }) => stmt.bind(
      root.hash, root.fid, root.ts, s.band, s.credit, s.bothSides ? 1 : 0, s.yesAuthors, s.noAuthors, root.claim.question,
      root.claim.challenge_reason, root.claim.answer, s.rebuttal?.hash ?? null, s.rebuttal?.fid ?? null, now, s.marketTakes, s.marketId,
      topics?.a ?? null, topics?.b ?? null,
    )))
  }

  /**
   * Scored cards in [since, until) at `minBand` or above; with `marketMinBand`, also cards whose
   * market has other takes from that band up (resurfacing; see core/score.ts resurfaces). With
   * `topic`, only cards filed under it, as either of their two topics.
   */
  async scores(opts: { since: number; until: number; minBand: number; marketMinBand?: number; topic?: string; limit: number }): Promise<ScoreRow[]> {
    const { results } = await this.db.prepare(
      `SELECT hash, fid, ts, band, credit, both_sides, yes_authors, no_authors, question, challenge_reason,
              author_stance, rebuttal_hash, rebuttal_fid, market_id
         FROM scores WHERE ts >= ?1 AND ts < ?2 AND (band >= ?3 OR (market_takes >= 2 AND band >= ?5))
          AND (?6 IS NULL OR topic_a = ?6 OR topic_b = ?6)
        ORDER BY band DESC, ts DESC LIMIT ?4`,
    ).bind(opts.since, opts.until, opts.minBand, opts.limit, opts.marketMinBand ?? opts.minBand, opts.topic ?? null).all<ScoreRow>()
    return results
  }

  /**
   * Cards per topic, as the feed would show them: each market counted once (its casts share a
   * card), over the fresh window and the resurfacing window with its bars. Topics with no cards
   * are absent.
   */
  async topicCards(opts: { freshSince: number; oldSince: number; until: number; minBand: number; marketMinBand: number }):
    Promise<Map<string, number>> {
    const { results } = await this.db.prepare(
      `WITH shown AS (
         SELECT coalesce(market_id, hash) AS card, topic_a, topic_b FROM scores
          WHERE ts < ?3 AND (ts >= ?1 OR (ts >= ?2 AND (band >= ?4 OR (market_takes >= 2 AND band >= ?5))))
       ), filed AS (
         SELECT card, topic_a AS topic FROM shown WHERE topic_a IS NOT NULL
         UNION SELECT card, topic_b FROM shown WHERE topic_b IS NOT NULL
       )
       SELECT topic, count(DISTINCT card) AS cards FROM filed GROUP BY topic`,
    ).bind(opts.freshSince, opts.oldSince, opts.until, opts.minBand, opts.marketMinBand).all<{ topic: string; cards: number }>()
    return new Map(results.map(r => [r.topic, r.cards]))
  }

  /* Topics: each market filed once per version (core/topics.ts) */

  /** Markets' filed topics under `version`; markets not yet filed are absent. */
  async topicsOf(marketIds: readonly string[], version: string): Promise<Map<string, StoredTopics>> {
    const out = new Map<string, StoredTopics>()
    for (let i = 0; i < marketIds.length; i += CHUNK) {
      const { results } = await this.db.prepare(
        `SELECT market_id, rank, topic_id FROM market_topics
          WHERE version = ?1 AND market_id IN (SELECT value FROM json_each(?2)) ORDER BY rank`,
      ).bind(version, JSON.stringify(marketIds.slice(i, i + CHUNK))).all<{ market_id: string; rank: number; topic_id: string }>()
      for (const r of results) {
        const cur = out.get(r.market_id) ?? { primary: 'other', secondary: null }
        if (r.rank === 1) cur.primary = r.topic_id
        else cur.secondary = r.topic_id
        out.set(r.market_id, cur)
      }
    }
    return out
  }

  /** Files a market. 'other' at rank 1 records that it fits no topic, so it isn't asked again. */
  async putTopics(t: { marketId: string; version: string; topics: StoredTopics; reason: string; now: number }): Promise<void> {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO market_topics (market_id, version, rank, topic_id, reason, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    )
    await this.db.batch([
      stmt.bind(t.marketId, t.version, 1, t.topics.primary, t.reason, t.now),
      ...(t.topics.secondary ? [stmt.bind(t.marketId, t.version, 2, t.topics.secondary, t.reason, t.now)] : []),
    ])
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
    for (let i = 0; i < hashes.length; i += CHUNK) {
      await this.db.prepare('DELETE FROM scores WHERE hash IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(hashes.slice(i, i + CHUNK))).run()
    }
  }
}
