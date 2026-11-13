// A small fixed eval for stage 1's "stakes" calibration, through the Worker's own classifier
// (Haiku 5.5, effort low, current prompt). Run before and after a prompt change and compare.
//
//   pnpm eval-stakes            (12 Claude calls)
//
// Targets are the intended challengeability ranges, not ground truth: they encode the product
// decision that a taste claim people split on is arguable (0.4-0.6), while a report of the
// caster's own preference or a truism is not (< 0.2), and consequential takes stay put.

import { ClaudeClassifier } from '../src/takes/adapters/claude.ts'
import { chooseClaim } from '../src/takes/core/score.ts'

type Case = { group: string; text: string; min: number; max: number }
const CASES: Case[] = [
  { group: 'taste, general', text: 'My most controversial take is that the only thing ketchup is ideal for is hot dogs', min: 0.4, max: 0.6 },
  { group: 'taste, general', text: 'Pineapple on pizza is genuinely good and the haters are wrong', min: 0.4, max: 0.6 },
  { group: 'taste, general', text: 'Tabs are objectively better than spaces. Fight me.', min: 0.4, max: 0.6 },
  { group: 'taste, general', text: 'Coffee is overrated. Tea is better in every way that matters.', min: 0.4, max: 0.6 },
  { group: 'own preference', text: 'I like dark mode', min: 0, max: 0.2 },
  { group: 'own preference', text: 'I could honestly eat tacos every single day', min: 0, max: 0.2 },
  { group: 'truism', text: 'Scams are bad', min: 0, max: 0.2 },
  { group: 'truism', text: 'Being kind to people is good', min: 0, max: 0.2 },
  { group: 'consequential', text: 'The $SNAP airdrop rewarded farmers over the people who actually used the app', min: 0.7, max: 1 },
  { group: 'consequential', text: 'Farcaster should drop the storage fee and let anyone post for free, spam be damned', min: 0.7, max: 1 },
  { group: 'consequential', text: 'Base has the best developer experience of the L2s', min: 0.5, max: 0.8 },
  { group: 'consequential', text: 'Valuing an early-stage startup on discounted cash flows is a category error', min: 0.5, max: 0.8 },
]

const key = process.env.ANTHROPIC_API_KEY
if (!key) { console.error('ANTHROPIC_API_KEY is not set (expected in .dev.vars)'); process.exit(2) }
const classifier = new ClaudeClassifier(key)

const rows = await Promise.all(CASES.map(async c => {
  const r = await classifier.classifyCast({ text: c.text })
  if ('declined' in r) return { c, score: null as number | null, note: r.reason }
  const claim = r.is_opinion ? chooseClaim(r.claims) : null
  return { c, score: claim ? claim.challengeability : null, note: claim ? claim.question : `not an opinion: ${r.reason}` }
}))

let pass = 0
for (const { c, score, note } of rows) {
  // A non-opinion counts as 0 for the low-target groups (it never reaches the feed).
  const s = score ?? 0
  const ok = s >= c.min - 1e-9 && s <= c.max + 1e-9
  if (ok) pass++
  console.log(`${ok ? 'PASS' : 'MISS'}  ${score === null ? ' -- ' : score.toFixed(2)}  [${c.min}-${c.max}]  ${c.group.padEnd(15)} ${c.text.slice(0, 60)}`)
  console.log(`                                     -> ${note.slice(0, 110)}`)
}
console.log(`\n${pass}/${CASES.length} in target range`)
