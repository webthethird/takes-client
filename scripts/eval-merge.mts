// Fixed eval for the merge adjudication (MERGE_PROMPT), through the Worker's own classifier.
//
//   pnpm eval-merge             (one Claude call per case)
//
// The bar (merge-5, Nov 15, 2026): a market is one CLAIM, since its id is keccak256(question)
// and a stake on it must mean what its title says. Two questions are one market only when no one
// could answer them differently without contradicting themselves. Same subject with the same
// overall verdict is a TOPIC, not a market. Cases marked "relabelled" were "same" under the
// looser merge-2 bar.
//
// Pairs come from cases the classifier README recorded, plus polarity pairs: the failure that
// matters most, since a wrong polarity silently flips every stance in a merged market.

import { ClaudeClassifier } from '../src/takes/adapters/claude.ts'

type Case = { a: string; b: string; same: boolean; yesSame?: boolean; why: string }
const CASES: Case[] = [
  { a: 'Is the new press secretary competent?', b: 'Is the new press secretary performing well?', same: false, why: 'relabelled: ability vs results (README called it a duplicate at 0.843)' },
  { a: 'Is the diesel deal strategically significant?', b: 'Is the fuel deal geopolitically significant?', same: false, why: 'relabelled after a merge-5 run: strategic vs geopolitical significance' },
  { a: 'Was the $SNAP airdrop fair?', b: 'Was the $SNAP airdrop fair to real users?', same: false, why: 'relabelled: narrower claim (fair overall vs to one group)' },
  { a: 'Are the Coinbase layoffs bullish for $COIN?', b: 'Are the Coinbase layoffs a strategic mistake?', same: false, why: 'README: same subject, different aspect' },
  { a: 'Will Raikkonen win the championship?', b: 'Will Raikkonen win the Singapore Grand Prix?', same: false, why: 'README: the clearest false merge in the band' },
  { a: 'Is contrarianism easier than most people think?', b: 'Does a cognitive bias make contrarian views seem credible?', same: false, why: 'README: mechanism, not the same claim' },
  { a: 'Was the $SNAP airdrop fair?', b: 'Was the $SNAP airdrop unfair?', same: true, yesSame: false, why: 'polarity: negation' },
  { a: 'Should Farcaster drop the storage fee?', b: 'Should Farcaster keep the storage fee?', same: true, yesSame: false, why: 'polarity: inverse action' },
  { a: 'Is ketchup ideal for anything besides hot dogs?', b: 'Is ketchup only good on hot dogs?', same: false, why: 'relabelled after a merge-5 run: "ideal" vs "good", one-way implication' },
  { a: 'Is Base the best L2 for developers?', b: 'Is Base the best L2 for developers?', same: true, yesSame: true, why: 'identical (merge never asks; sanity)' },
  // Held out: none of these appear in MERGE_PROMPT, so they test the rule, not recall of examples.
  { a: 'Will AI replace most software engineers?', b: 'Will AI make most software engineers obsolete?', same: true, yesSame: true, why: 'held-out: paraphrase' },
  { a: 'Is pineapple on pizza good?', b: 'Does pineapple belong on pizza?', same: true, yesSame: true, why: 'held-out: paraphrase, taste' },
  { a: 'Is tea better than coffee?', b: 'Is coffee better than tea?', same: true, yesSame: false, why: 'held-out: swapped comparison' },
  { a: 'Is Bitcoin a good store of value?', b: 'Is Bitcoin a poor store of value?', same: true, yesSame: false, why: 'held-out: antonym' },
  { a: "Is Farcaster's storage fee fair?", b: "Is Farcaster's storage fee too high?", same: false, why: 'relabelled after a merge-5 run: fairness vs size (fair and high is coherent)' },
  { a: 'Is the Jensen Huang controversy a legitimate story?', b: 'Was the Jensen Huang story blown out of proportion?', same: false, why: 'relabelled after a merge-5 run: legitimate-but-exaggerated is coherent' },
  { a: 'Is remote work better for productivity?', b: 'Is office work better for productivity?', same: true, yesSame: false, why: 'held-out: opposite alternative' },
  { a: "Is the Fed's rate cut good for crypto?", b: "Is the Fed's rate cut good for stocks?", same: false, why: 'held-out: different object' },
  { a: 'Is Bessent sincerely trying to make the Treasury succeed?', b: 'Is Bessent a competent Treasury Secretary?', same: false, why: 'held-out: sincerity vs competence' },
  { a: 'Is Network School good for founders?', b: 'Is Network School good for Farcaster?', same: false, why: 'held-out: different beneficiary' },
  // Live $BASED facets: one market under merge-2 (the user's call then); one topic under merge-5.
  { a: 'Is $BASED a good daily app to stake in?', b: 'Is the $BASED project good?', same: false, why: 'relabelled: a facet vs the whole' },
  { a: 'Is $BASED one of the best projects on Farcaster?', b: 'Is the $BASED project good?', same: false, why: 'relabelled: "one of the best" vs "good"' },
  { a: 'Is $BASED a good daily app to stake in?', b: 'Is $BASED one of the best projects on Farcaster?', same: false, why: 'relabelled: a facet vs a ranking' },
  { a: 'Is disabling reply bumping in the following feed a good change?', b: 'Is reply bumping a good feature?', same: true, yesSame: false, why: 'live: reply bumping, inverted (user: one market)' },
  // Live near-misses that should stay apart under the looser rule.
  { a: 'Is avoiding Google and Apple products worthwhile?', b: 'Is avoiding Microsoft products a good choice?', same: false, why: 'live: different objects' },
  { a: 'Is Jensen Huang behaving admirably in his personal life?', b: 'Is the Jensen Huang controversy legitimate?', same: false, why: 'live: conduct vs the story' },
  { a: 'Is the FAA nationwide ground stop a historically significant event?', b: "Was the FAA's nationwide flight grounding a good decision?", same: false, why: 'live: significance vs wisdom' },

  // Live, Nov 15 after the 28-day backfill: merges made under merge-4 that are different claims.
  { a: 'Is the product delicious?', b: 'Is the lemon product delicious?', same: false, why: 'live merge-4: a vague title absorbing specific products' },
  { a: 'Is the lemon product delicious?', b: 'Is this kiwi product delicious?', same: false, why: 'live merge-4: different products' },
  { a: 'Was the Network State takeover of Farcaster handled well?', b: 'Was the Network State acquisition of Farcaster legitimate?', same: false, why: 'live merge-4: execution vs legitimacy' },
  { a: 'Is alt-client Farcaster a nice diversion?', b: 'Are Farcaster alt clients worth using for engagement?', same: false, why: 'live merge-4: enjoyment vs engagement' },
  { a: 'Is alt-client Farcaster a nice diversion?', b: 'Is Farcaster more enjoyable lately?', same: false, why: 'live merge-4 (chain drift): alt clients vs Farcaster overall' },
  { a: 'Does Farcaster work well?', b: "Did Farcaster's recent changes under new management benefit the platform?", same: false, why: 'live merge-4: state vs effect of a change' },
  { a: 'Is decentralisation of Farcaster moving in a good direction?', b: 'Is Farcaster truly decentralised?', same: false, why: 'live merge-4 (0.87 join): direction vs current state' },
  { a: 'Are Farcaster Articles better than longcasts?', b: 'Are Farcaster articles worth reading?', same: false, why: 'live merge-4 (0.85 join): comparison vs absolute' },
  { a: 'Should there be a mass migration to a new party if Schumer and Jeffries keep leadership?', b: 'Should Schumer and Jeffries be replaced as Democratic leaders?', same: false, why: 'live merge-4: conditional exit vs replacement' },
  // Live, Nov 15: merges that are the same claim and must stay merged.
  { a: 'Should Farcaster lift the moderation bans?', b: 'Should the Farcaster moderation bans be lifted?', same: true, yesSame: true, why: 'live: rephrasing' },
  { a: 'Is Base the best Layer-2 to build on?', b: 'Is Base the best Layer-2 for building on?', same: true, yesSame: true, why: 'live: rephrasing' },
  { a: 'Was the Network State takeover of Farcaster handled well?', b: 'Was the Farcaster takeover handled well?', same: true, yesSame: true, why: 'live: same event named two ways' },
  { a: 'Were the retroactive Farcaster bans justified?', b: 'Was the Farcaster ban justified?', same: true, yesSame: true, why: 'live: same bans' },
  { a: 'Is web3 exciting right now?', b: 'Is the blockchain space exciting right now?', same: true, yesSame: true, why: 'live: synonyms' },
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
