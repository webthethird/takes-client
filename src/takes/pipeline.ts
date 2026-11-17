// One scoring pass, run by the minute cron:
//
//   1. refresh a few active viewers' follows (on a TTL), then a step of the archive walk (backfill.ts)
//   2. stage 1 on new root casts: those from people the active viewers follow, newest viewer
//      first (core/viewers.ts); and, from the rest of the network, those that drew attention
//      (repliers or likes), with archived casts from before the index begins that drew repliers.
//      The network-wide lanes keep a share of the budget (GLOBAL_FLOOR)
//   3. stage 2 on the threads of opinion roots: each new reply's stance on the root's question
//   4. rescore every live card
//
// Claude calls share one budget per pass, spent in that order of priority. Anything left
// over waits for the next minute. Transient API errors end the pass early; nothing is lost.

import { ClaudeClassifier, isDeclined, isTransient, type Classifier } from './adapters/claude.ts'
import { Archive, Casts } from './adapters/archive.ts'
import { CastIndex, type IndexedCast } from './adapters/cast-index.ts'
import { runBackfillStep, type BackfillReport } from './backfill.ts'
import { readFollows, readUsername } from './adapters/node.ts'
import { TakesStore, type OpinionRoot } from './adapters/store.ts'
import { takesConfig, type Env } from './config.ts'
import { Names } from './names.ts'
import { runMerge, type MergeReport } from './merge.ts'
import { cardTopics, fromAssignment, TOPIC_VERSION, type StoredTopics } from './core/topics.ts'
import { splitEmbeds } from './core/text.ts'
import {
  BACKLOG_VIEWERS_PER_PASS, FOLLOW_SCAN_HOURS, MAX_ACTIVE_VIEWERS, TOUCH_EVERY, VIEWER_ACTIVE_DAYS, followsToRefresh, planStage1,
} from './core/viewers.ts'
import {
  CHALLENGE_BAND, FRESH_HOURS, MAX_REPLIES_PER_THREAD, MAX_THREAD_DEPTH, MIN_LIKES, MIN_REPLIERS, MIN_TEXT_LEN,
  NO_MARKET, PROMPT_VERSION, RESURFACE_MAX_DAYS, STANCE_VERSION, SUGGEST_VERSION, anchorToRoot, chooseClaim, gatedChallenge, resurfaces,
  reconcileStance, scoreCard,
} from './core/score.ts'

export const FOLLOWS_TTL = 6 * 3600
const LEASE = 'scoring'
const LEASE_TTL = 10 * 60
const CONCURRENCY = 4
/**
 * Candidates read per lane per pass, BEFORE dropping already-classified ones. It must exceed
 * a lane's whole window: an earlier limit of 200 was applied first, so once the newest 200
 * were classified, older casts never entered the queue (measured: 219 of 490 following-lane
 * casts classified, then the lane ran dry). 2,000 is a safety cap, not a working size.
 */
const CANDIDATE_LIMIT = 2000
/** FIDs per author query when scanning a viewer's follows. */
const AUTHOR_CHUNK = 1000

export type PassReport = {
  skipped?: string
  follows?: number
  classified: number
  stances: number
  suggested: number
  declined: number
  scored: number
  dropped: number
  /** Active viewers this pass (core/viewers.ts). */
  viewers?: number
  /** Casts this pass set out to classify, by lane (core/viewers.ts planStage1). */
  planned?: { following: number; global: number }
  /** Markets filed under topics this pass. */
  topics?: number
  stoppedEarly?: string
  merge?: MergeReport
  backfill?: BackfillReport
}

/**
 * An error and its causes, outermost first. The Anthropic SDK wraps a failed fetch as
 * "Connection error." with the runtime's own error as `cause`; without the chain, a stalled
 * worker can't be told apart from a down API.
 */
export const describeError = (e: unknown): string => {
  const parts: string[] = []
  for (let x: unknown = e, depth = 0; x !== undefined && x !== null && depth < 4; depth++) {
    parts.push(x instanceof Error ? `${x.name}: ${x.message}` : String(x))
    x = x instanceof Error ? (x as Error & { cause?: unknown }).cause : undefined
  }
  return parts.join(' <- ')
}

const bandOf = (claim: OpinionRoot['claim']) => Math.floor(gatedChallenge(claim) / CHALLENGE_BAND + 1e-9)

/** Runs `jobs` with bounded concurrency until one returns 'stop' or all finish. */
const pool = async (jobs: Array<() => Promise<'ok' | 'stop'>>, n: number): Promise<boolean> => {
  let next = 0
  let stopped = false
  const worker = async () => {
    while (!stopped && next < jobs.length) {
      const job = jobs[next++]!
      if ((await job()) === 'stop') stopped = true
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker))
  return stopped
}

export const runScoringPass = async (
  env: Env,
  opts: { now: number; includeOld: boolean; classifier?: Classifier },
): Promise<PassReport> => {
  const report: PassReport = { classified: 0, stances: 0, suggested: 0, declined: 0, scored: 0, dropped: 0 }
  const cfg = takesConfig(env)
  if (!cfg.apiKey && !opts.classifier) return { ...report, skipped: 'ANTHROPIC_API_KEY is not set; scoring is off' }
  const classifier = opts.classifier ?? new ClaudeClassifier(cfg.apiKey!)
  const store = new TakesStore(env.TAKES, PROMPT_VERSION, STANCE_VERSION)
  const index = new CastIndex(env.DB)
  const archive = new Archive(env.TAKES)
  // Where a cast may be in either: the index for recent casts, the archive for older ones.
  const casts = new Casts(index, archive)
  const { now } = opts
  if (!(await store.acquire(LEASE, now, LEASE_TTL))) return { ...report, skipped: 'another pass holds the lease' }

  try {
    let budget = cfg.maxCalls
    let stop: string | undefined
    const spend = () => (budget > 0 && !stop ? (budget--, true) : false)
    const fail = (e: unknown, what: string): 'stop' => {
      stop ??= `${what}: ${describeError(e)}`.slice(0, 300)
      return 'stop'
    }

    /* 1. Viewers and their follows (core/viewers.ts) */
    if (cfg.viewerFid !== null) {
      // The deployment's own viewer is always active, so its follows keep being scored. Its
      // username is read once, for "Viewing as" (again only while the account has none).
      const own = await store.viewer(cfg.viewerFid)
      if (!own?.username) {
        const name = await readUsername(env.SNAPCHAIN_URL, cfg.viewerFid)
        if (!own) await store.addViewer(cfg.viewerFid, name.ok ? name.name : null, now)
        else if (name.ok && name.name) await store.setUsername(cfg.viewerFid, name.name)
      }
      await store.touchViewer(cfg.viewerFid, now, TOUCH_EVERY)
    }
    const activeSince = now - VIEWER_ACTIVE_DAYS * 86_400
    const archiveMetaBefore = await archive.meta()
    for (const v of followsToRefresh(await store.activeViewers(activeSince, MAX_ACTIVE_VIEWERS), now, FOLLOWS_TTL)) {
      const r = await readFollows(env.SNAPCHAIN_URL, v.fid)
      if (!r.ok) {
        console.warn(`takes: follows for ${v.fid} not refreshed: ${r.error}`)
        continue
      }
      const before = v.followsTs === null ? new Set<number>() : await store.follows(v.fid)
      await store.putFollows(v.fid, r.fids, now)
      const added = r.fids.filter(f => !before.has(f))
      // Newly followed accounts: their recent casts haven't been looked at for this viewer, so
      // the viewer's whole window is scanned again, and their older casts join the archive walk.
      if (added.length > 0 && v.caughtUp) await store.setCaughtUp(v.fid, false)
      if (added.length > 0 && archiveMetaBefore) await archive.addAuthors(added)
    }
    const viewers = await store.activeViewers(activeSince, MAX_ACTIVE_VIEWERS)
    report.viewers = viewers.length
    const follows = cfg.viewerFid === null ? new Set<number>() : await store.follows(cfg.viewerFid)
    report.follows = follows.size

    /* 1b. Archive walk: node requests only, outside the Claude budget. Null once it's done. */
    const walked = await runBackfillStep({ archive, indexDb: env.DB, nodeUrls: env.SNAPCHAIN_URL, follows, now })
    if (walked) report.backfill = walked
    const archiveMeta = await archive.meta()

    /* 2. Stage 1: viewers' follows first, then the network-wide lanes (planStage1). */
    const freshSince = now - FRESH_HOURS * 3600
    const oldSince = now - RESURFACE_MAX_DAYS * 86_400
    const unclassified = async (xs: IndexedCast[]) => {
      const done = await store.classified(xs.map(x => x.hash))
      return xs.filter(x => !done.has(x.hash))
    }
    const loaded = viewers.filter(v => v.followsTs !== null)
    // New viewers (newest first): their follows' casts across the whole fresh window, index and
    // archive, until nothing there is left unclassified. One query each, a few viewers a pass.
    const backlogs: IndexedCast[][] = []
    const behind = loaded.filter(v => !v.caughtUp).sort((a, b) => b.firstSeen - a.firstSeen || a.fid - b.fid)
    for (const v of behind.slice(0, BACKLOG_VIEWERS_PER_PASS)) {
      const fids = [...(await store.follows(v.fid))]
      // In chunks: a bound JSON list of thousands of FIDs would pass D1's size limits.
      const found: IndexedCast[] = []
      for (let i = 0; i < fids.length; i += AUTHOR_CHUNK) {
        const chunk = fids.slice(i, i + AUTHOR_CHUNK)
        found.push(...(await index.byAuthors(chunk, freshSince, MIN_TEXT_LEN, CANDIDATE_LIMIT)))
        if (archiveMeta) found.push(...(await archive.byAuthors(chunk, freshSince, MIN_TEXT_LEN, CANDIDATE_LIMIT, PROMPT_VERSION)))
      }
      // Newest first across the chunks, as one query would have returned them.
      const list = await unclassified(found.sort((a, b) => b.ts - a.ts || (a.hash < b.hash ? -1 : 1)).slice(0, CANDIDATE_LIMIT))
      if (list.length === 0) await store.setCaughtUp(v.fid, true)
      backlogs.push(list)
    }
    // Caught-up viewers: one scan of recent root casts, kept when any active viewer follows the author.
    const recent = await index.rootsSince(now - FOLLOW_SCAN_HOURS * 3600, MIN_TEXT_LEN, CANDIDATE_LIMIT)
    const followed = await store.followedBy([...new Set(recent.map(x => x.fid))], loaded.map(v => v.fid))
    const steady = await unclassified(recent.filter(x => followed.has(x.fid)))
    const gate = { minRepliers: MIN_REPLIERS, minLikes: MIN_LIKES, minLen: MIN_TEXT_LEN, limit: CANDIDATE_LIMIT }
    const global = await unclassified([
      ...(await index.attention({ ...gate, since: freshSince, until: now + 1 })),
      // The 28-day scan is the expensive query; the cron runs it on a slower cadence.
      ...(opts.includeOld ? await index.attention({ ...gate, since: oldSince, until: freshSince }) : []),
      // The archive holds what's older than the index: the attention gate across all of it.
      ...(archiveMeta ? await archive.attention({ ...gate, since: oldSince, until: archiveMeta.indexStart, promptVersion: PROMPT_VERSION }) : []),
    ])
    // Only as many as the budget can classify this pass: names and quotes are fetched for these.
    const plan = planStage1({ backlogs, steady, global, budget })
    const todo = plan.map(({ lane, ...cast }) => ({ cast: cast as IndexedCast, lane }))
    report.planned = { following: plan.filter(x => x.lane === 'following').length, global: plan.filter(x => x.lane === 'global').length }
    const names = new Names(store, env.SNAPCHAIN_URL, now)
    const quoted = await casts.byHashes(todo.flatMap(q => (q.cast.quoted ? [q.cast.quoted.hash] : [])))
    await names.ensure([...todo.map(q => q.cast), ...quoted.values()])
    await pool(todo.map(({ cast, lane }) => async () => {
      if (!spend()) return 'stop'
      try {
        const quote = cast.quoted ? quoted.get(cast.quoted.hash) : undefined
        // Images go to the model as images (new casts only: earlier ones aren't re-classified).
        const r = await classifier.classifyCast({
          text: names.render(cast), ...splitEmbeds(cast.urls), ...(quote ? { quoted: names.render(quote) } : {}),
        })
        const base = { hash: cast.hash, fid: cast.fid, ts: cast.ts, lane, now }
        if (isDeclined(r)) {
          report.declined++
          await store.putClassification({ ...base, isOpinion: false, reason: r.reason, claim: null })
        } else {
          await store.putClassification({ ...base, isOpinion: r.is_opinion, reason: r.reason, claim: r.is_opinion ? chooseClaim(r.claims) : null })
        }
        report.classified++
        return 'ok'
      } catch (e) {
        if (isTransient(e)) return fail(e, 'stage 1')
        report.declined++
        await store.putClassification({ hash: cast.hash, fid: cast.fid, ts: cast.ts, lane, now, isOpinion: false, reason: `error: ${String(e).slice(0, 200)}`, claim: null })
        return 'ok'
      }
    }), CONCURRENCY)

    /* 2b. Merge: place new claims in canonical markets (shares the Claude budget). */
    if (!stop) report.merge = await runMerge({ store, classifier, openaiKey: cfg.openaiKey, since: oldSince, now, spend, fail })

    /* 3. Stage 2: fresh roots, and older ones good enough to resurface. Best band first. */
    const opinions = await store.opinionRoots(oldSince)
    // A market's deleted or taken-down casts are left out of its counts.
    const removed = await index.removed(await store.marketMemberHashes(opinions.map(r => r.hash)))
    const markets = await store.marketContexts(opinions.map(r => r.hash), removed)
    // Scored: fresh casts, and older ones that resurface (a lower bar when others argue the claim).
    const roots = opinions
      .filter(r => r.ts >= freshSince || resurfaces(bandOf(r.claim), markets.get(r.hash)?.takes ?? 1))
      .sort((a, b) => bandOf(b.claim) - bandOf(a.claim) || b.ts - a.ts)
    const rootCasts = await casts.byHashes(roots.map(r => r.hash))
    const live = roots.filter(r => rootCasts.has(r.hash))
    const gone = roots.filter(r => !rootCasts.has(r.hash)).map(r => r.hash)
    /* 2c. Suggest: a reply for each side, in the cast's voice, for cards that lack one. Shares
       the budget, ahead of stage 2: a card shows its suggestions before it has any replies. */
    const done2 = await store.suggested(live.map(r => r.hash), SUGGEST_VERSION)
    const need = live.filter(r => !done2.has(r.hash))
    if (need.length > 0 && !stop && budget > 0) {
      await names.ensure(need.map(r => rootCasts.get(r.hash)!))
      await pool(need.map(root => async () => {
        if (!spend()) return 'stop'
        try {
          const cast = rootCasts.get(root.hash)!
          const r = await classifier.suggest({
            text: names.render(cast), question: root.claim.question, answer: root.claim.answer, images: splitEmbeds(cast.urls).images,
          })
          if (isDeclined(r)) {
            // Recorded empty, or it would be retried every minute; the boxes fall back to static copy.
            report.declined++
            await store.putSuggestion({ hash: root.hash, version: SUGGEST_VERSION, back: '', challenge: '', register: r.reason, now })
            return 'ok'
          }
          // Stored as the model wrote them; casing is matched to the cast when the feed is served.
          await store.putSuggestion({ hash: root.hash, version: SUGGEST_VERSION, back: r.back, challenge: r.challenge, register: r.register, now })
          report.suggested++
          return 'ok'
        } catch (e) {
          return isTransient(e) ? fail(e, 'suggest') : (report.declined++, 'ok')
        }
      }), CONCURRENCY)
    }

    /* 2d. Topics: file each card's market under the topic tabs, once per TOPIC_VERSION, read
       with one of its live casts. Shares the budget, after suggestions: a card shows in the
       main feed without a topic, but not without its suggestions. */
    const marketOf = (hash: string) => markets.get(hash)?.id ?? null
    const liveMarkets = [...new Set(live.map(r => marketOf(r.hash)).filter((m): m is string => m !== null))]
    let filed = await store.topicsOf(liveMarkets, TOPIC_VERSION)
    const unfiled = new Map<string, OpinionRoot>()
    for (const r of live) {
      const m = marketOf(r.hash)
      if (m !== null && !filed.has(m) && !unfiled.has(m)) unfiled.set(m, r)
    }
    if (unfiled.size > 0 && !stop && budget > 0) {
      await names.ensure([...unfiled.values()].map(r => rootCasts.get(r.hash)!))
      await pool([...unfiled].map(([marketId, root]) => async () => {
        if (!spend()) return 'stop'
        // Recorded either way, as Other when it can't be filed, or it would be asked every minute.
        const file = (topics: StoredTopics, reason: string) =>
          store.putTopics({ marketId, version: TOPIC_VERSION, topics, reason: reason.slice(0, 200), now })
        try {
          const cast = rootCasts.get(root.hash)!
          const r = await classifier.assignTopic({ question: root.claim.question, text: names.render(cast), images: splitEmbeds(cast.urls).images })
          if (isDeclined(r)) {
            report.declined++
            await file({ primary: 'other', secondary: null }, r.reason)
            return 'ok'
          }
          await file(fromAssignment(r), r.reason)
          report.topics = (report.topics ?? 0) + 1
          return 'ok'
        } catch (e) {
          if (isTransient(e)) return fail(e, 'topic')
          report.declined++
          await file({ primary: 'other', secondary: null }, `error: ${String(e)}`)
          return 'ok'
        }
      }), CONCURRENCY)
      filed = await store.topicsOf(liveMarkets, TOPIC_VERSION)
    }

    let stances = await store.stances(live.map(r => r.hash))

    for (const root of live) {
      if (stop || budget <= 0) break
      const rootCast = rootCasts.get(root.hash)!
      const thread = await casts.thread(root.hash, MAX_THREAD_DEPTH, MAX_REPLIES_PER_THREAD)
      const byHash = new Map(thread.map(c => [c.hash, c]))
      const judged = new Set((stances.get(root.hash) ?? []).map(s => s.hash))
      const pending = thread.filter(r => !judged.has(r.hash))
      if (pending.length === 0) continue
      await names.ensure([rootCast, ...thread])
      const rootText = names.render(rootCast)
      await pool(pending.map(reply => async () => {
        if (!spend()) return 'stop'
        const parent = reply.parentHash && reply.parentHash !== root.hash ? byHash.get(reply.parentHash) : undefined
        const sameAuthor = reply.fid === root.fid
        try {
          const r = await classifier.classifyStance({
            question: root.claim.question, rootText, parentText: parent ? names.render(parent) : rootText,
            replyText: names.render(reply), sameAuthor,
          })
          const base = { rootHash: root.hash, replyHash: reply.hash, fid: reply.fid, textLen: reply.text.trim().length, now }
          if (isDeclined(r)) {
            report.declined++
            await store.putStance({ ...base, stance: 'off_topic', confidence: 0, corrected: false, detail: r })
          } else {
            // A direct reply's parent is the root, whose stance stage 1 already decided.
            const direct = reply.parentHash === root.hash
            const { anchored, conflict } = direct ? anchorToRoot(r, root.claim.answer) : { anchored: r, conflict: false }
            const { stance, corrected } = reconcileStance(anchored, sameAuthor ? { rootStance: root.claim.answer } : undefined)
            // detail keeps the model's own reading, so root_read_conflict can be counted.
            await store.putStance({ ...base, stance, confidence: r.confidence, corrected, detail: { ...r, root_read_conflict: conflict } })
          }
          report.stances++
          return 'ok'
        } catch (e) {
          if (isTransient(e)) return fail(e, 'stage 2')
          // Recorded, or the same reply would fail again every minute.
          report.declined++
          await store.putStance({
            rootHash: root.hash, replyHash: reply.hash, fid: reply.fid, textLen: reply.text.trim().length, now,
            stance: 'off_topic', confidence: 0, corrected: false, detail: { error: String(e).slice(0, 200) },
          })
          return 'ok'
        }
      }), CONCURRENCY)
    }

    /* 4. Rescore everything live; drop cards whose cast is gone. */
    stances = await store.stances(live.map(r => r.hash))
    await store.putScores(live.map(root => ({
      root, score: scoreCard(root, root.claim, stances.get(root.hash) ?? [], markets.get(root.hash) ?? NO_MARKET),
      topics: cardTopics(filed.get(marketOf(root.hash) ?? '')),
    })), now)
    // Also dropped: cards no longer eligible, such as an older cast whose market lost its other
    // take, so a stale row can't keep it in the feed or a topic tab.
    const chosen = new Set(roots.map(r => r.hash))
    const ineligible = opinions.filter(r => !chosen.has(r.hash)).map(r => r.hash)
    await store.dropScores([...gone, ...ineligible])
    report.scored = live.length
    report.dropped = gone.length + (await store.pruneStaleScores())
    // Past the lookback nothing reads an archived cast; pruned on the slow cadence.
    if (opts.includeOld) await archive.prune(oldSince - 86_400)
    if (stop) report.stoppedEarly = stop
    return report
  } finally {
    await store.release(LEASE)
  }
}
