// The merge stage: place each classified claim in a canonical market. Runs after stage 1 in
// every pass. Sequential by design: each new market changes what later claims can match, and
// processing oldest first makes the earliest question canonical, as on-chain.
//
//   identical text    -> join (same string, same hash, same on-chain market)
//   similarity >= 0.70 -> Claude decides whether it is the same CLAIM as the market's
//                         canonical question, and the polarity (MERGE_PROMPT, merge-5)
//   otherwise          -> found a new market
//
// Similarity is the best over the market's canonical question AND every member's question, so
// a market is found through its closest cast. Claude always decides against the CANONICAL
// question, though: every member is judged against one anchor, so a chain of near neighbours
// can't drift a market away from its title, and polarity is always relative to the title.
// (Before merge-5, similarity alone admitted joins at >= 0.82, and drift happened: see
// MATCH_THRESHOLD in core/market.ts.)
//
// A question Claude declines to compare founds its own market: a missed merge costs two
// small markets, a wrong one puts people in a market they never joined.

import { isDeclined, isTransient, type Classifier } from './adapters/claude.ts'
import { embedMany } from './adapters/openai.ts'
import type { TakesStore } from './adapters/store.ts'
import { PROMPT_VERSION } from './core/score.ts'
import {
  MERGE_VERSION, canonicalAnswer, decodeEmbedding, encodeEmbedding, planMatch, questionHash, type MarketRef,
} from './core/market.ts'

/**
 * Memberships are valid for one set of merge rules AND one stage-1 prompt: a membership says
 * which market a cast's QUESTION belongs to, and a stage-1 change rewrites the questions.
 * Without the second half, a re-classified cast keeps its old row, looks already placed, and
 * is never merged under its new question.
 */
const MERGE_KEY = `${MERGE_VERSION}|${PROMPT_VERSION}`

/** Claims placed per pass. The embedding call is one request; adjudications share the Claude budget. */
const PER_PASS = 200

export type MergeReport = { merged: number; founded: number; adjudicated: number; absorbed: number; skipped?: string; stoppedEarly?: string }

export const runMerge = async (opts: {
  store: TakesStore; classifier: Classifier; openaiKey: string | null; since: number; now: number
  spend: () => boolean; fail: (e: unknown, what: string) => 'stop'
}): Promise<MergeReport> => {
  const { store, classifier, now } = opts
  const report: MergeReport = { merged: 0, founded: 0, adjudicated: 0, absorbed: 0 }
  if (!opts.openaiKey) return { ...report, skipped: 'OPENAI_API_KEY is not set; merging is off' }
  if (await store.resetMergeIfStale(MERGE_KEY)) console.log(`takes: merge rules or questions changed; rebuilding markets under ${MERGE_KEY}`)

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
      const members = new Map<string, Float32Array[]>()
      for (const e of await store.memberEmbeddingsOfType(type)) {
        members.set(e.market_id, [...(members.get(e.market_id) ?? []), decodeEmbedding(e.embedding)])
      }
      list = (await store.marketsOfType(type)).map(m => ({
        id: m.id, question: m.question, embeddings: [decodeEmbedding(m.embedding), ...(members.get(m.id) ?? [])],
      }))
      byType.set(type, list)
    }
    return list
  }

  /**
   * After a claim joins `joined`, each bridge (another market it is also close to) may be the
   * same market founded separately. Claude compares the two CANONICAL questions, the same
   * anchor-to-anchor rule as every join; if they are one market, the newer is absorbed into the
   * older, so the earliest question stays canonical. Returns false when the budget ran out.
   */
  const consolidate = async (joined: MarketRef, bridges: readonly MarketRef[], markets: MarketRef[]): Promise<boolean> => {
    for (const other of bridges) {
      if (!markets.includes(other) || !markets.includes(joined)) continue // already absorbed this pass
      const [older, newer] = markets.indexOf(other) < markets.indexOf(joined) ? [other, joined] : [joined, other]
      if (!opts.spend()) { report.stoppedEarly ??= 'Claude budget spent; consolidation continues next pass'; return false }
      let v: Awaited<ReturnType<Classifier['adjudicateMarket']>>
      try {
        v = await classifier.adjudicateMarket({ existing: older.question, candidate: newer.question })
      } catch (e) {
        if (isTransient(e)) { opts.fail(e, 'consolidate'); report.stoppedEarly ??= String(e).slice(0, 200); return false }
        continue
      }
      report.adjudicated++
      if (isDeclined(v) || !v.same_market) continue
      report.absorbed += await store.absorbMarket(newer.id, older.id, !v.yes_means_same, { from: newer.question, verdict: v })
      older.embeddings.push(...newer.embeddings)
      markets.splice(markets.indexOf(newer), 1)
    }
    return true
  }

  for (let i = 0; i < claims.length; i++) {
    const root = claims[i]!
    const { question, answer, claim_type: type } = root.claim
    const embedding = embedded.vectors[i]!
    const markets = await marketsFor(type)
    const plan = planMatch(question, embedding, markets)
    const member = { castHash: root.hash, mergeVersion: MERGE_KEY, now, embedding: encodeEmbedding(embedding) }

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
      markets.push({ id, question, embeddings: [embedding] })
      report.founded++
    }

    if (plan.kind === 'identical') {
      await store.putMember({ ...member, marketId: plan.market.id, answer, via: 'identical', similarity: 1, detail: undefined })
      plan.market.embeddings.push(embedding)
      report.merged++
      if (!(await consolidate(plan.market, plan.bridges, markets))) break
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
    // Claude decides membership in every band; similarity only found the candidate.
    if (!verdict.same_market) { await found(); continue }
    await store.putMember({
      ...member, marketId: plan.market.id, answer: canonicalAnswer(answer, verdict.yes_means_same),
      via: plan.kind === 'join' ? 'join' : 'adjudicated', similarity: plan.similarity, detail: verdict,
    })
    // Later claims in this pass can now match through this member too.
    plan.market.embeddings.push(embedding)
    report.merged++
    if (!(await consolidate(plan.market, plan.bridges, markets))) break
  }
  return report
}
