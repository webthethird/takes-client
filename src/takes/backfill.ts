// The archive walk: one bounded step per scoring pass, until every author is walked.
//
// The cast index is built from the node's event stream, which both Snapchain and Hypersnap keep
// for only a few days, so a deployment can't index further back than when it started. But the
// node keeps every message, and castsByFid serves an author's casts newest first. So each author
// seen in the index (and each account the viewer follows) is walked back to the floor, 28 days
// before the walk was seeded, and what's older than the index lands in the archive.
//
// Measured on 60 sampled authors (Nov 14, 2026, haatz.quilibrium.com): 69 requests at 131 ms
// average and no errors, so ~4,900 requests for the whole set of ~4,250 authors; about 1,300
// casts from before the index per 60 authors. At REQUESTS_PER_PASS a minute, about two hours.
//
// It's polite to a public node: few requests per pass, WALK_CONCURRENCY at a time, and a
// transient error (429, 5xx, timeout) ends the step, to resume next minute where it stopped.

import { Archive, type ArchiveProgress } from './adapters/archive.ts'
import { readCastsPage } from './adapters/node.ts'
import { archiveRowOf, CastMessage, type ArchiveRow } from './core/archive-row.ts'
import { MIN_TEXT_LEN, RESURFACE_MAX_DAYS } from './core/score.ts'

/** How far back the walk reaches: as far as resurfacing and merging look. */
export const ARCHIVE_DAYS = RESURFACE_MAX_DAYS
export const REQUESTS_PER_PASS = 40
const WALK_CONCURRENCY = 4
const PAGE_SIZE = 200

export type BackfillReport = {
  seeded?: number
  requests: number
  stored: number
  authorsDone: number
  remaining?: number
  stoppedEarly?: string
}

/**
 * What a page contributes, and whether the walk is past the floor. Messages are newest first, so
 * the first one older than the floor ends the author. Kept: root casts from before the index
 * starts (long enough to be takes), and every reply in the window, in or out of the index, since
 * replies are what an archived root's repliers are counted from.
 */
export const rowsOfPage = (messages: readonly unknown[], floor: number, indexStart: number): { rows: ArchiveRow[]; pastFloor: boolean } => {
  const rows: ArchiveRow[] = []
  for (const raw of messages) {
    const m = CastMessage.safeParse(raw)
    if (!m.success) continue
    const row = archiveRowOf(m.data)
    if (!row) continue // not a cast add
    if (row.ts < floor) return { rows, pastFloor: true }
    if (row.reply === 1 || (row.ts < indexStart && row.text.trim().length >= MIN_TEXT_LEN)) rows.push(row)
  }
  return { rows, pastFloor: false }
}

export const runBackfillStep = async (opts: {
  archive: Archive; indexDb: D1Database; nodeUrls: string; follows: ReadonlySet<number>; now: number; requests?: number
}): Promise<BackfillReport | null> => {
  const { archive, now } = opts
  const report: BackfillReport = { requests: 0, stored: 0, authorsDone: 0 }

  let meta = await archive.meta()
  if (!meta) {
    // Where the index is complete: the latest shard's covered_since, as Warpstack's own reads
    // compute it (IndexReader.coverage). Not min(ts): the index also holds a few older casts,
    // read on demand (measured: 19 from Nov 5-8 in an index complete from Nov 10).
    const { results: shards } = await opts.indexDb.prepare('SELECT covered_since FROM ingest_cursor').all<{ covered_since: number }>()
    if (shards.length < 2) return { ...report, stoppedEarly: 'the cast index has not started; nothing to walk from yet' }
    const indexStart = Math.max(...shards.map(r => r.covered_since))
    const { results } = await opts.indexDb.prepare('SELECT fid, count(*) AS n FROM casts GROUP BY fid').all<{ fid: number; n: number }>()
    const authors = new Map(results.map(r => [r.fid, r.n]))
    for (const fid of opts.follows) if (!authors.has(fid)) authors.set(fid, 0)
    meta = { seededTs: now, floorTs: now - ARCHIVE_DAYS * 86_400, indexStart }
    await archive.seed(meta, [...authors].map(([fid, priority]) => ({ fid, priority })))
    report.seeded = authors.size
  }

  let budget = opts.requests ?? REQUESTS_PER_PASS
  const queue = await archive.nextAuthors(budget)
  if (queue.length === 0) return null // walked: nothing to report
  let stop: string | undefined
  let next = 0
  const walkOne = async (fid: number, token: string | null) => {
    for (;;) {
      if (stop || budget <= 0) return
      budget--
      report.requests++
      const r = await readCastsPage(opts.nodeUrls, fid, token, PAGE_SIZE)
      if (!r.ok) {
        if (r.transient) { stop ??= r.error; return }
        await archive.skipAuthor(fid, now) // the node won't serve this author: move on
        report.authorsDone++
        return
      }
      const { rows, pastFloor } = rowsOfPage(r.messages, meta.floorTs, meta.indexStart)
      const done = pastFloor || r.next === null || r.messages.length === 0
      await archive.putPage(fid, rows, { pageToken: done ? null : r.next, done }, now)
      report.stored += rows.length
      if (done) { report.authorsDone++; return }
      token = r.next
    }
  }
  await Promise.all(Array.from({ length: Math.min(WALK_CONCURRENCY, queue.length) }, async () => {
    while (!stop && budget > 0 && next < queue.length) {
      const a = queue[next++]!
      await walkOne(a.fid, a.pageToken)
    }
  }))
  if (stop) report.stoppedEarly = stop
  const p: ArchiveProgress = await archive.progress()
  report.remaining = p.authors - p.done
  return report
}
