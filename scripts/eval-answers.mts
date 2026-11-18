// Eval for stage 1's answer polarity: re-classifies casts and prints each one's earlier question
// and answer beside the new ones, so a flipped answer stands out when read. Whether the caster
// really argues yes or no is a judgment: read the casts.
//
//   pnpm eval-answers cases.jsonl     (one Claude call per case)
//
// cases.jsonl: lines of {"text","question","answer"}, the earlier classification; text only, so
// images and quoted casts the production pass would also send are left out.

import { readFileSync } from 'node:fs'
import { ClaudeClassifier } from '../src/takes/adapters/claude.ts'
import { chooseClaim } from '../src/takes/core/score.ts'

type Case = { text: string; question: string; answer: 'yes' | 'no' }
const file = process.argv[2]
if (!file) { console.error('usage: pnpm eval-answers cases.jsonl'); process.exit(2) }
const cases: Case[] = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Case)

const key = process.env.ANTHROPIC_API_KEY
if (!key) { console.error('ANTHROPIC_API_KEY is not set (expected in .dev.vars)'); process.exit(2) }
const c = new ClaudeClassifier(key)

/** At most 4 in flight, like the scoring pass. */
const results: string[] = new Array(cases.length)
let next = 0
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < cases.length) {
    const i = next++
    const k = cases[i]!
    let out: string
    try {
      const r = await c.classifyCast({ text: k.text })
      if ('declined' in r) out = `  new:  DECLINED ${r.reason}`
      else if (!r.is_opinion) out = '  new:  not an opinion'
      else {
        const claim = chooseClaim(r.claims)
        out = claim
          ? `  new:  [${claim.answer.toUpperCase()}] ${claim.question}` +
            (claim.question === k.question && claim.answer !== k.answer ? '   <-- ANSWER FLIPPED on the same question' : '')
          : '  new:  no usable claim'
      }
    } catch (e) {
      out = `  new:  ERROR ${String(e).slice(0, 200)}`
    }
    results[i] = `${i + 1}. ${k.text.replace(/\n+/g, ' / ').slice(0, 200)}\n  old:  [${k.answer.toUpperCase()}] ${k.question}\n${out}\n`
  }
}))
console.log(results.join('\n'))
console.log(`${cases.length} cases`)
