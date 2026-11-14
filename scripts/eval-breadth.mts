// Eval for question breadth: does stage 1 phrase casts that argue the same thing so their
// questions COLLIDE (and casts that argue different things so they don't)? Graded on what
// merging actually uses: embedding similarity between the two generated questions, against the
// merge stage's own thresholds. Also reports challengeability, the price broader questions
// might pay in specificity.
//
//   pnpm eval-breadth            (2 Claude calls per pair, plus one embeddings call)

import { ClaudeClassifier } from '../src/takes/adapters/claude.ts'
import { embedMany } from '../src/takes/adapters/openai.ts'
import { AMBIGUOUS_THRESHOLD, MATCH_THRESHOLD, cosine } from '../src/takes/core/market.ts'
import { chooseClaim } from '../src/takes/core/score.ts'

type Pair = { a: string; b: string; collide: boolean; why: string }
const PAIRS: Pair[] = [
  // Should collide: one argument, different facets or words.
  { a: '$BASED is the best daily app to stake in right now, been stacking every single day', b: '$BASED is one of the best projects on farcaster, not even close', collide: true, why: '$BASED facets (live case)' },
  { a: 'the $BASED project is genuinely good, people are sleeping on it', b: '$BASED is the best daily app to stake in right now, been stacking every single day', collide: true, why: '$BASED facets (live case)' },
  { a: 'Vitalik is the best leader crypto has ever had', b: 'Vitalik has honestly been a great steward of Ethereum', collide: true, why: 'one person, same verdict' },
  { a: "Base's developer experience is the best of any L2 by miles", b: 'building on Base is so much nicer than on any other L2', collide: true, why: 'same claim, different words' },
  { a: 'Farcaster articles are pointless, who is actually going to read them', b: 'farcaster articles are actually great, finally real long-form here', collide: true, why: 'opposite sides of one market (live)' },
  { a: 'disabling reply bumping in the following feed was a great change', b: 'reply bumping was a good feature and I want it back', collide: true, why: 'a change and the thing it changes (live)' },
  // Should NOT collide: same subject, different question.
  { a: 'Coinbase layoffs are bullish for $COIN, leaner company', b: 'Coinbase laying people off right now is a huge strategic mistake', collide: false, why: 'stock impact vs strategy' },
  { a: 'Bessent is sincerely trying to make the Treasury work', b: 'Bessent is out of his depth as Treasury Secretary', collide: false, why: 'sincerity vs competence' },
  { a: 'The Fed cut is great for crypto', b: 'The Fed cut is great for stocks', collide: false, why: 'different object' },
  { a: "Jensen Huang's personal life is his own business", b: 'the Jensen Huang story is a hit piece', collide: false, why: 'conduct vs the coverage' },
]

const key = process.env.ANTHROPIC_API_KEY
const okey = process.env.OPENAI_API_KEY
if (!key || !okey) { console.error('ANTHROPIC_API_KEY and OPENAI_API_KEY must be set (expected in .dev.vars)'); process.exit(2) }
const c = new ClaudeClassifier(key)

const question = async (text: string) => {
  const r = await c.classifyCast({ text })
  if ('declined' in r || !r.is_opinion) return null
  return chooseClaim(r.claims)
}
const claims = await Promise.all(PAIRS.flatMap(p => [question(p.a), question(p.b)]))
const texts = claims.map(q => q?.question ?? '')
const emb = await embedMany(okey, texts.map(t => t || '(none)'))
if (!emb.ok) { console.error(emb.error); process.exit(1) }

let join = 0, band = 0, apart = 0, positives = 0, negatives = 0
const challenge: number[] = []
PAIRS.forEach((p, i) => {
  const qa = claims[2 * i], qb = claims[2 * i + 1]
  for (const q of [qa, qb]) if (q) challenge.push(q.challengeability)
  const sim = qa && qb ? cosine(emb.vectors[2 * i]!, emb.vectors[2 * i + 1]!) : 0
  const tier = !qa || !qb ? 'no claim' : qa.question === qb.question ? 'identical' : sim >= MATCH_THRESHOLD ? 'join' : sim >= AMBIGUOUS_THRESHOLD ? 'band' : 'apart'
  let ok: boolean
  if (p.collide) {
    positives++
    if (tier === 'identical' || tier === 'join') join++
    else if (tier === 'band') band++
    ok = tier === 'identical' || tier === 'join' || tier === 'band'
  } else {
    negatives++
    if (tier === 'apart' || tier === 'band' || tier === 'no claim') apart++
    ok = tier !== 'identical' && tier !== 'join'
  }
  console.log(`${ok ? 'PASS' : 'MISS'}  ${sim.toFixed(3)} ${tier.padEnd(9)} ${p.why}`)
  console.log(`        ${qa?.question ?? '(no claim)'}  [${qa?.challengeability ?? '-'}]`)
  console.log(`        ${qb?.question ?? '(no claim)'}  [${qb?.challengeability ?? '-'}]`)
})
const mean = challenge.reduce((s, x) => s + x, 0) / Math.max(challenge.length, 1)
console.log(`\nshould collide: ${join}/${positives} auto-join (identical or >= ${MATCH_THRESHOLD}), ${band} more in Claude's band`)
console.log(`should stay apart: ${apart}/${negatives} below auto-join`)
console.log(`mean challengeability: ${mean.toFixed(3)} over ${challenge.length} claims`)
