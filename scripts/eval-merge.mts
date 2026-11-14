// Fixed eval for the merge adjudication (MERGE_PROMPT), through the Worker's own classifier.
//
//   pnpm eval-merge             (10 Claude calls)
//
// Pairs come from cases the classifier README recorded, plus polarity pairs: the failure that
// matters most, since a wrong polarity silently flips every stance in a merged market.

import { ClaudeClassifier } from '../src/takes/adapters/claude.ts'

type Case = { a: string; b: string; same: boolean; yesSame?: boolean; why: string }
const CASES: Case[] = [
  { a: 'Is the new press secretary competent?', b: 'Is the new press secretary performing well?', same: true, yesSame: true, why: 'README: genuine duplicate at 0.843' },
  { a: 'Is the diesel deal strategically significant?', b: 'Is the fuel deal geopolitically significant?', same: true, yesSame: true, why: 'README: genuine duplicate in [0.80, 0.85)' },
  { a: 'Was the $SNAP airdrop fair?', b: 'Was the $SNAP airdrop fair to real users?', same: true, yesSame: true, why: 'narrower phrasing, same dispute' },
  { a: 'Are the Coinbase layoffs bullish for $COIN?', b: 'Are the Coinbase layoffs a strategic mistake?', same: false, why: 'README: same subject, different aspect' },
  { a: 'Will Raikkonen win the championship?', b: 'Will Raikkonen win the Singapore Grand Prix?', same: false, why: 'README: the clearest false merge in the band' },
  { a: 'Is contrarianism easier than most people think?', b: 'Does a cognitive bias make contrarian views seem credible?', same: false, why: 'README: mechanism, not the same claim' },
  { a: 'Was the $SNAP airdrop fair?', b: 'Was the $SNAP airdrop unfair?', same: true, yesSame: false, why: 'polarity: negation' },
  { a: 'Should Farcaster drop the storage fee?', b: 'Should Farcaster keep the storage fee?', same: true, yesSame: false, why: 'polarity: inverse action' },
  { a: 'Is ketchup ideal for anything besides hot dogs?', b: 'Is ketchup only good on hot dogs?', same: true, yesSame: false, why: 'polarity: the live ketchup question, inverted' },
  { a: 'Is Base the best L2 for developers?', b: 'Is Base the best L2 for developers?', same: true, yesSame: true, why: 'identical (merge never asks; sanity)' },
  // Held out: none of these appear in MERGE_PROMPT, so they test the rule, not recall of examples.
  { a: 'Will AI replace most software engineers?', b: 'Will AI make most software engineers obsolete?', same: true, yesSame: true, why: 'held-out: paraphrase' },
  { a: 'Is pineapple on pizza good?', b: 'Does pineapple belong on pizza?', same: true, yesSame: true, why: 'held-out: paraphrase, taste' },
  { a: 'Is tea better than coffee?', b: 'Is coffee better than tea?', same: true, yesSame: false, why: 'held-out: swapped comparison' },
  { a: 'Is Bitcoin a good store of value?', b: 'Is Bitcoin a poor store of value?', same: true, yesSame: false, why: 'held-out: antonym' },
  { a: "Is Farcaster's storage fee fair?", b: "Is Farcaster's storage fee too high?", same: true, yesSame: false, why: 'held-out: implicit inversion' },
  { a: 'Is the Jensen Huang controversy a legitimate story?', b: 'Was the Jensen Huang story blown out of proportion?', same: true, yesSame: false, why: 'held-out: implicit inversion (live card)' },
  { a: 'Is remote work better for productivity?', b: 'Is office work better for productivity?', same: true, yesSame: false, why: 'held-out: opposite alternative' },
  { a: "Is the Fed's rate cut good for crypto?", b: "Is the Fed's rate cut good for stocks?", same: false, why: 'held-out: different object' },
  { a: 'Is Bessent sincerely trying to make the Treasury succeed?', b: 'Is Bessent a competent Treasury Secretary?', same: false, why: 'held-out: sincerity vs competence' },
  { a: 'Is Network School good for founders?', b: 'Is Network School good for Farcaster?', same: false, why: 'held-out: different beneficiary' },
]

const key = process.env.ANTHROPIC_API_KEY
if (!key) { console.error('ANTHROPIC_API_KEY is not set (expected in .dev.vars)'); process.exit(2) }
const c = new ClaudeClassifier(key)

const rows = await Promise.all(CASES.map(async k => ({ k, r: await c.adjudicateMarket({ existing: k.a, candidate: k.b }) })))
let pass = 0
for (const { k, r } of rows) {
  if ('declined' in r) { console.log(`MISS  declined: ${r.reason}  ${k.a} | ${k.b}`); continue }
  const ok = r.same_market === k.same && (!k.same || r.yes_means_same === k.yesSame)
  if (ok) pass++
  console.log(`${ok ? 'PASS' : 'MISS'}  same=${r.same_market} yesSame=${r.yes_means_same}  (want ${k.same}${k.same ? `/${k.yesSame}` : ''})  ${k.why}`)
  if (!ok) console.log(`        ${k.a} | ${k.b}\n        reason: ${r.reason}`)
}
console.log(`\n${pass}/${CASES.length} correct`)
