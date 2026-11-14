// Eval for the suggest stage: does each side's suggestion read like the original cast's voice?
// Prints every suggestion for reading (tone is a judgment), plus mechanical checks that catch
// the obvious misses: language, all-lowercase casing, emoji, length, and a short insult list.
//
//   pnpm eval-suggest [cases.jsonl]     (one Claude call per case)
//
// cases.jsonl: lines of {"text","question","answer"}; built-in cases are always included.

import { readFileSync } from 'node:fs'
import { ClaudeClassifier } from '../src/takes/adapters/claude.ts'

type Case = { text: string; question: string; answer: 'yes' | 'no' }
const BUILT_IN: Case[] = [
  { text: 'My most controversial take is that the only thing ketchup is ideal for is hot dogs', question: 'Is ketchup ideal for anything besides hot dogs?', answer: 'no' },
  { text: 'ngl $DEGEN tipping is the only reason i still open this app every morning 🎩🎩', question: 'Is $DEGEN tipping good for Farcaster?', answer: 'yes' },
]
const file = process.argv[2]
const extra: Case[] = file ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Case) : []
const CASES = [...BUILT_IN, ...extra]

const key = process.env.ANTHROPIC_API_KEY
if (!key) { console.error('ANTHROPIC_API_KEY is not set (expected in .dev.vars)'); process.exit(2) }
const c = new ClaudeClassifier(key)

const EMOJI = /\p{Extended_Pictographic}/u
const DUTCH = /\b(de|het|een|en|niet|van|wat|dat|maar|ook)\b/i
const INSULTS = /\b(idiot|stupid|moron|clown|loser|dumb|retard|shill)\b/i
const lower = (s: string) => s === s.toLowerCase()
const startsUpper = (s: string) => /^\p{Lu}/u.test(s.trim())
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length
/** Consistently sentence-cased: at least two sentence or line starts, all capitalized. "Lol network school ..." is not. */
const sentenceCased = (s: string) => {
  const starts = s.split(/(?:[.!?]+\s+|\n+)/).map(x => x.trim()).filter(x => /^\p{L}/u.test(x))
  return starts.length >= 2 && starts.every(x => /^\p{Lu}/u.test(x))
}
const sentences = (s: string) => s.split(/[.!?]+(?:\s|$)/).filter(x => x.trim().length > 0).length
const OPENER = /^\s*(agreed?|fair|disagree|makes sense|good point|this\b|exactly|hot take|respectfully|i see it differently|eens|ik zie het anders)/i

const rows = await Promise.all(CASES.map(async k => ({ k, r: await c.suggest(k) })))
let flags = 0
for (const { k, r } of rows) {
  console.log(`\nCAST  ${k.text.replace(/\n+/g, ' / ').slice(0, 160)}`)
  if ('declined' in r) { console.log(`  DECLINED: ${r.reason}`); flags++; continue }
  console.log(`  register:  ${r.register}`)
  for (const [side, s] of [['back', r.back], ['challenge', r.challenge]] as const) {
    const issues: string[] = []
    if (DUTCH.test(k.text) && DUTCH.test(k.text.split(' ').slice(0, 8).join(' ')) && !DUTCH.test(s)) issues.push('not Dutch')
    if (lower(k.text) && !lower(s)) issues.push('not lowercase')
    if (!EMOJI.test(k.text) && EMOJI.test(s)) issues.push('added emoji')
    if (words(s) > Math.max(1.5 * words(k.text), 22) || sentences(s) > 2) issues.push(`long (${words(s)} vs ${words(k.text)} words, ${sentences(s)} sentences)`)
    if (sentenceCased(k.text) && !startsUpper(s) && !/^[$@#\d]/.test(s)) issues.push('lowercased a sentence-cased cast')
    if (OPENER.test(s)) issues.push('template opener')
    if (INSULTS.test(s)) issues.push('insult word')
    flags += issues.length
    console.log(`  ${side.padEnd(9)}  ${s}${issues.length ? `   <-- ${issues.join(', ')}` : ''}`)
  }
}
console.log(`\n${CASES.length} cases, ${flags} mechanical flags (tone itself: read above)`)
