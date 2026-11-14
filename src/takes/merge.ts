// The merge stage: place each classified claim in a canonical market. Runs after stage 1 in
// every pass. Sequential by design: each new market changes what later claims can match, and
// processing oldest first makes the earliest question canonical, as on-chain.
//
//   identical text   -> join (same string, same hash, same on-chain market)
//   similarity >= 0.82 -> join; Claude checks only whether YES means the same in both
//   0.70 .. 0.82      -> Claude decides whether it is the same market, and the polarity
//   otherwise         -> found a new market
//
// A question Claude declines to compare founds its own market: a missed merge costs two
// small markets, a wrong one puts people in a market they never joined.

import { isDeclined, isTransient, type Classifier } from './adapters/claude.ts'
import { embedMany } from './adapters/openai.ts'
import type { TakesStore } from './adapters/store.ts'
import {
  MERGE_VERSION, canonicalAnswer, decodeEmbedding, encodeEmbedding, planMatch, questionHash, type MarketRef,
} from './core/market.ts'

/** Claims placed per pass. The embedding call is one request; adjudications share the Claude budget. */
const PER_PASS = 200

export type MergeReport = { merged: number; founded: number; adjudicated: number; skipped?: string; stoppedEarly?: string }

export const runMerge = async (opts: {
  store: TakesStore; classifier: Classifier; openaiKey: string | null; since: number; now: number
  spend: () => boolean; fail: (e: unknown, what: string) => 'stop'
}): Promise<MergeReport> => {
  const { store, classifier, now } = opts
  const report: MergeReport = { merged: 0, founded: 0, adjudicated: 0 }
  if (!opts.openaiKey) return { ...report, skipped: 'OPENAI_API_KEY is not set; merging is off' }
  if (await store.resetMergeIfStale(MERGE_VERSION)) console.log(`takes: merge rules changed; rebuilding markets under ${MERGE_VERSION}`)

  const claims = await store.unmergedClaims(opts.since, PER_PASS)
  if (claims.length === 0) return report
  const embedded = await embedMany(opts.openaiKey, claims.map(c => c.claim.question))
  if (!embedded.ok) {
    if (embedded.transient) return { ...report, stoppedEarly: embedded.error }
    return { ...report, skipped: embedded.error }
  }

  const byType = new Map<string, MarketRef[]>()
  const marketsFor = async (type: string) => {
    let list = byType.get(type)
    if (!list) {
      list = (await store.marketsOfType(type)).map(m => ({ id: m.id, question: m.question, embedding: decodeEmbedding(m.embedding) }))
      byType.set(type, list)
    }
    return list
  }

  for (let i = 0; i < claims.length; i++) {
    const root = claims[i]!
    const { question, answer, claim_type: type } = root.claim
    const embedding = embedded.vectors[i]!
    const markets = await marketsFor(type)
    const plan = planMatch(question, embedding, markets)
    const member = { castHash: root.hash, mergeVersion: MERGE_VERSION, now }

    const found = async () => {
      const id = questionHash(question)
      // The same question text under another claim type already founded this on-chain market.
      const existing = await store.marketById(id)
      if (existing) {
        await store.putMember({ ...member, marketId: id, answer, via: 'identical', similarity: 1, detail: { crossType: true } })
        report.merged++
        return
      }
      await store.putMarket({ id, question, claimType: type, embedding: encodeEmbedding(embedding), seedHash: root.hash, createdTs: root.ts })
      await store.putMember({ ...member, marketId: id, answer, via: 'seed', similarity: null, detail: undefined })
      markets.push({ id, question, embedding })
      report.founded++
    }

    if (plan.kind === 'identical') {
      await store.putMember({ ...member, marketId: plan.market.id, answer, via: 'identical', similarity: 1, detail: undefined })
      report.merged++
      continue
    }
    if (plan.kind === 'new') {
      await found()
      continue
    }

    // join or ambiguous: Claude sees the pair.
    if (!opts.spend()) { report.stoppedEarly ??= 'Claude budget spent; the rest merge next pass'; break }
    let verdict: Awaited<ReturnType<Classifier['adjudicateMarket']>>
    try {
      verdict = await classifier.adjudicateMarket({ existing: plan.market.question, candidate: question })
    } catch (e) {
      if (isTransient(e)) { opts.fail(e, 'merge'); report.stoppedEarly ??= String(e).slice(0, 200); break }
      verdict = { declined: true, reason: `error: ${String(e).slice(0, 200)}` }
    }
    report.adjudicated++
    if (isDeclined(verdict)) { await found(); continue }
    // At or above the match threshold, similarity decides membership and Claude only the
    // polarity; in the ambiguous band Claude decides both.
    const same = plan.kind === 'join' || verdict.same_market
    if (!same) { await found(); continue }
    await store.putMember({
      ...member, marketId: plan.market.id, answer: canonicalAnswer(answer, verdict.yes_means_same),
      via: plan.kind === 'join' ? 'join' : 'adjudicated', similarity: plan.similarity, detail: verdict,
    })
    report.merged++
  }
  return report
}
