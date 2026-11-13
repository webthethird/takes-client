// One scoring pass, run by the minute cron:
//
//   1. refresh the viewer's follows (on a TTL)
//   2. stage 1 on new root casts: every one from people the viewer follows, and, from the
//      rest of the network, those that drew attention (repliers or likes)
//   3. stage 2 on the threads of opinion roots: each new reply's stance on the root's question
//   4. rescore every live card
//
// Claude calls share one budget per pass, spent in that order of priority. Anything left
// over waits for the next minute. Transient API errors end the pass early; nothing is lost.

import { ClaudeClassifier, isDeclined, isTransient, type Classifier } from './adapters/claude.ts'
import { CastIndex, type IndexedCast } from './adapters/cast-index.ts'
import { readFollows } from './adapters/node.ts'
import { TakesStore, type OpinionRoot } from './adapters/store.ts'
import { takesConfig, type Env } from './config.ts'
import { Names } from './names.ts'
import {
  CHALLENGE_BAND, FRESH_HOURS, MAX_REPLIES_PER_THREAD, MAX_THREAD_DEPTH, MIN_LIKES, MIN_REPLIERS, MIN_TEXT_LEN,
  PROMPT_VERSION, RESURFACE_MAX_DAYS, RESURFACE_MIN_BAND, chooseClaim, gatedChallenge, reconcileStance, scoreCard,
} from './core/score.ts'

export const FOLLOWS_TTL = 6 * 3600
const LEASE = 'scoring'
const LEASE_TTL = 10 * 60
const CONCURRENCY = 4
const CANDIDATE_LIMIT = 200

export type PassReport = {
  skipped?: string
  follows?: number
  classified: number
  stances: number
  declined: number
  scored: number
  dropped: number
  stoppedEarly?: string
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
  const report: PassReport = { classified: 0, stances: 0, declined: 0, scored: 0, dropped: 0 }
  const cfg = takesConfig(env)
  if (!cfg.apiKey && !opts.classifier) return { ...report, skipped: 'ANTHROPIC_API_KEY is not set; scoring is off' }
  const classifier = opts.classifier ?? new ClaudeClassifier(cfg.apiKey!)
  const store = new TakesStore(env.TAKES, PROMPT_VERSION)
  const index = new CastIndex(env.DB)
  const { now } = opts
  if (!(await store.acquire(LEASE, now, LEASE_TTL))) return { ...report, skipped: 'another pass holds the lease' }

  try {
    let budget = cfg.maxCalls
    let stop: string | undefined
    const spend = () => (budget > 0 && !stop ? (budget--, true) : false)
    const fail = (e: unknown, what: string): 'stop' => {
      stop ??= `${what}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)
      return 'stop'
    }

    /* 1. Follows */
    let follows = new Set<number>()
    if (cfg.viewerFid !== null) {
      const age = await store.followsAge(cfg.viewerFid)
      if (age === null || now - age > FOLLOWS_TTL) {
        const r = await readFollows(env.SNAPCHAIN_URL, cfg.viewerFid)
        if (r.ok) await store.putFollows(cfg.viewerFid, r.fids, now)
        else console.warn(`takes: follows for ${cfg.viewerFid} not refreshed: ${r.error}`)
      }
      follows = await store.follows(cfg.viewerFid)
      report.follows = follows.size
    }

    /* 2. Stage 1 */
    const freshSince = now - FRESH_HOURS * 3600
    const oldSince = now - RESURFACE_MAX_DAYS * 86_400
    const gate = { minRepliers: MIN_REPLIERS, minLikes: MIN_LIKES, minLen: MIN_TEXT_LEN, limit: CANDIDATE_LIMIT }
    const lanes: Array<{ lane: string; casts: IndexedCast[] }> = [
      { lane: 'following', casts: await index.byAuthors([...follows], freshSince, MIN_TEXT_LEN, CANDIDATE_LIMIT) },
      { lane: 'global', casts: await index.attention({ ...gate, since: freshSince, until: now + 1 }) },
      // The 28-day scan is the expensive query; the cron runs it on a slower cadence.
      ...(opts.includeOld ? [{ lane: 'global', casts: await index.attention({ ...gate, since: oldSince, until: freshSince }) }] : []),
    ]
    const seen = new Set<string>()
    const queue: Array<{ cast: IndexedCast; lane: string }> = []
    for (const { lane, casts } of lanes) {
      for (const cast of casts) {
        if (seen.has(cast.hash)) continue
        seen.add(cast.hash)
        queue.push({ cast, lane: follows.has(cast.fid) ? 'following' : lane })
      }
    }
    const done = await store.classified(queue.map(q => q.cast.hash))
    // Only as many as the budget can classify this pass: names and quotes are fetched for these.
    const todo = queue.filter(q => !done.has(q.cast.hash)).slice(0, budget)
    const names = new Names(store, env.SNAPCHAIN_URL, now)
    const quoted = await index.byHashes(todo.flatMap(q => (q.cast.quoted ? [q.cast.quoted.hash] : [])))
    await names.ensure([...todo.map(q => q.cast), ...quoted.values()])
    await pool(todo.map(({ cast, lane }) => async () => {
      if (!spend()) return 'stop'
      try {
        const quote = cast.quoted ? quoted.get(cast.quoted.hash) : undefined
        const r = await classifier.classifyCast({
          text: names.render(cast), links: cast.urls, ...(quote ? { quoted: names.render(quote) } : {}),
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

    /* 3. Stage 2: fresh roots, and older ones good enough to resurface. Best band first. */
    const roots = (await store.opinionRoots(oldSince))
      .filter(r => r.ts >= freshSince || bandOf(r.claim) >= RESURFACE_MIN_BAND)
      .sort((a, b) => bandOf(b.claim) - bandOf(a.claim) || b.ts - a.ts)
    const rootCasts = await index.byHashes(roots.map(r => r.hash))
    const live = roots.filter(r => rootCasts.has(r.hash))
    const gone = roots.filter(r => !rootCasts.has(r.hash)).map(r => r.hash)
    let stances = await store.stances(live.map(r => r.hash))

    for (const root of live) {
      if (stop || budget <= 0) break
      const rootCast = rootCasts.get(root.hash)!
      const thread = await index.thread(root.hash, MAX_THREAD_DEPTH, MAX_REPLIES_PER_THREAD)
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
            const { stance, corrected } = reconcileStance(r, sameAuthor ? { rootStance: root.claim.answer } : undefined)
            await store.putStance({ ...base, stance, confidence: r.confidence, corrected, detail: r })
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
    await store.putScores(live.map(root => ({ root, score: scoreCard(root, root.claim, stances.get(root.hash) ?? []) })), now)
    await store.dropScores(gone)
    report.scored = live.length
    report.dropped = gone.length
    if (stop) report.stoppedEarly = stop
    return report
  } finally {
    await store.release(LEASE)
  }
}
