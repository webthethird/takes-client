import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Claim } from './schema.ts'
import type { OpinionRoot, TakesStore } from './adapters/store.ts'
import type { Classifier } from './adapters/claude.ts'

// Embeddings are scripted per question; no network.
const VECTORS = new Map<string, Float32Array>()
vi.mock('./adapters/openai.ts', () => ({
  embedMany: async (_key: string, texts: readonly string[]) => ({ ok: true, vectors: texts.map(t => VECTORS.get(t)!) }),
}))
const { runMerge } = await import('./merge.ts')
const { decodeEmbedding, questionHash } = await import('./core/market.ts')

/** A unit vector at `deg` degrees in the plane: cosine between two of them is cos(difference). */
const at = (deg: number) => new Float32Array([Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0])

const claim = (question: string, answer: 'yes' | 'no'): Claim => ({
  question, answer, claim_type: 'evaluative', aspect: 'x', confidence: 0.9, challengeability: 0.8,
  externally_resolvable: false, challenge_reason: 'r',
})

type Member = { castHash: string; marketId: string; answer: 'yes' | 'no'; via: string; embedding: ArrayBuffer }

/** The parts of TakesStore that merging uses, in memory. */
const fakeStore = (roots: OpinionRoot[]) => {
  const markets: Array<{ id: string; question: string; embedding: ArrayBuffer }> = []
  const members: Member[] = []
  const store = {
    resetMergeIfStale: async () => false,
    unmergedClaims: async () => roots.filter(r => !members.some(m => m.castHash === r.hash)),
    marketsOfType: async () => markets,
    memberEmbeddingsOfType: async () => members.map(m => ({ market_id: m.marketId, embedding: m.embedding })),
    marketById: async (id: string) => markets.find(m => m.id === id) ?? null,
    putMarket: async (m: { id: string; question: string; embedding: ArrayBuffer }) => { markets.push(m) },
    putMember: async (m: Member) => { members.push(m) },
    absorbMarket: async () => 0,
  }
  return { store: store as unknown as TakesStore, markets, members }
}

/** A classifier whose merge verdicts are scripted by candidate question; records what it was asked. */
const scripted = (verdicts: Record<string, { same_market: boolean; yes_means_same: boolean }>) => {
  const asked: Array<{ existing: string; candidate: string }> = []
  const c = {
    adjudicateMarket: async (i: { existing: string; candidate: string }) => {
      asked.push(i)
      return { reason: 'scripted', ...(verdicts[i.candidate] ?? { same_market: false, yes_means_same: true }) }
    },
  }
  return { classifier: c as unknown as Classifier, asked }
}

const root = (hash: string, ts: number, q: string, a: 'yes' | 'no'): OpinionRoot => ({ hash, fid: 1, ts, lane: 'global', claim: claim(q, a) })
const run = (store: TakesStore, classifier: Classifier) =>
  runMerge({ store, classifier, openaiKey: 'k', since: 0, now: 100, spend: () => true, fail: () => 'stop' })

describe('runMerge (merge-5): Claude decides every join, against the canonical question', () => {
  beforeEach(() => VECTORS.clear())

  it('a close question that Claude says is a different claim founds its own market (it used to join on similarity)', async () => {
    VECTORS.set('Is the album good?', at(0))
    VECTORS.set('Is the lead single good?', at(10)) // cos 0.985: far above 0.82
    const { store, markets, members } = fakeStore([root('0x1', 1, 'Is the album good?', 'yes'), root('0x2', 2, 'Is the lead single good?', 'yes')])
    const { classifier, asked } = scripted({ 'Is the lead single good?': { same_market: false, yes_means_same: true } })
    const r = await run(store, classifier)
    expect(asked).toEqual([{ existing: 'Is the album good?', candidate: 'Is the lead single good?' }])
    expect(markets.map(m => m.question)).toEqual(['Is the album good?', 'Is the lead single good?'])
    expect(members.map(m => m.via)).toEqual(['seed', 'seed'])
    expect(r).toMatchObject({ founded: 2, merged: 0, adjudicated: 1 })
  })

  it('the same claim turned around joins with its answer flipped to the canonical question', async () => {
    VECTORS.set('Is the dress code good?', at(0))
    VECTORS.set('Would scrapping the dress code be good?', at(20)) // cos 0.94
    const { store, members } = fakeStore([root('0x1', 1, 'Is the dress code good?', 'yes'), root('0x2', 2, 'Would scrapping the dress code be good?', 'yes')])
    const { classifier } = scripted({ 'Would scrapping the dress code be good?': { same_market: true, yes_means_same: false } })
    await run(store, classifier)
    expect(members[1]).toMatchObject({ castHash: '0x2', marketId: questionHash('Is the dress code good?'), answer: 'no', via: 'join' })
  })

  it('a question found through a member is still judged against the title: no drift along a chain', async () => {
    // A (0deg) <- B (30deg: cos 0.87 to A, joins) <- C (55deg: cos 0.91 to B, above 0.82, but 0.57 to A).
    VECTORS.set('A?', at(0)); VECTORS.set('B?', at(30)); VECTORS.set('C?', at(55))
    const { store, markets, members } = fakeStore([root('0x1', 1, 'A?', 'yes'), root('0x2', 2, 'B?', 'yes'), root('0x3', 3, 'C?', 'yes')])
    const { classifier, asked } = scripted({ 'B?': { same_market: true, yes_means_same: true }, 'C?': { same_market: false, yes_means_same: true } })
    await run(store, classifier)
    // C reached the market through B, but Claude was asked about A, the canonical question.
    expect(asked.find(a => a.candidate === 'C?')?.existing).toBe('A?')
    expect(markets.map(m => m.question)).toEqual(['A?', 'C?'])
    expect(members.find(m => m.castHash === '0x2')?.marketId).toBe(questionHash('A?'))
    expect(decodeEmbedding(markets[1]!.embedding)[0]).toBeCloseTo(Math.cos((55 * Math.PI) / 180))
  })

  it('below the floor nothing is asked: the question founds its own market', async () => {
    VECTORS.set('X?', at(0)); VECTORS.set('Y?', at(60)) // cos 0.5
    const { store, markets } = fakeStore([root('0x1', 1, 'X?', 'yes'), root('0x2', 2, 'Y?', 'no')])
    const { classifier, asked } = scripted({})
    await run(store, classifier)
    expect(asked).toEqual([])
    expect(markets).toHaveLength(2)
  })
})
