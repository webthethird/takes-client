// Eval for the suggest stage: is each side's suggestion a short question that leans toward its
// side, rather than an argument someone could paste as their reply? Prints every question with
// both sides stated, for reading (which way a question leans is a judgment), plus mechanical
// checks that catch the obvious misses.
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
  { text: 'Een vermogensbelasting jaagt ondernemers het land uit. Dat is geen mening, dat is wat er gebeurt.', question: 'Should the Netherlands tax wealth?', answer: 'no' },
]
const file = process.argv[2]
const extra: Case[] = file ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Case) : []
const CASES = [...BUILT_IN, ...extra]

const key = process.env.ANTHROPIC_API_KEY
if (!key) { console.error('ANTHROPIC_API_KEY is not set (expected in .dev.vars)'); process.exit(2) }
const c = new ClaudeClassifier(key)

const EMOJI = /\p{Extended_Pictographic}/u
const DUTCH = /\b(de|het|een|en|niet|van|wat|welke|dat|maar|ook|geen|is|er|als|zou|zouden|hoe|waarom)\b/i
const INSULTS = /\b(idiot|stupid|moron|clown|loser|dumb|retard|shill)\b/i
/** First person, or a verdict on the caster: an argument, not a question. */
const ARGUES = /\b(I|I'm|I've|my|we|our)\b|\byou'?re (right|wrong)\b/i
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length
const firstWord = (s: string) => s.trim().split(/\s+/)[0]?.toLowerCase() ?? ''

const rows = await Promise.all(CASES.map(async k => {
  try { return { k, r: await c.suggest(k) } } catch (e) { return { k, r: { declined: true as const, reason: `ERROR ${String(e).slice(0, 200)}` } } }
}))
let flags = 0
for (const { k, r } of rows) {
  console.log(`\nCAST  ${k.text.replace(/\n+/g, ' / ').slice(0, 160)}`)
  console.log(`  question:  ${k.question} (caster: ${k.answer})`)
  if ('declined' in r) { console.log(`  DECLINED: ${r.reason}`); flags++; continue }
  console.log(`  language:  ${r.language}  |  caster: ${r.caster_side}  |  other: ${r.other_side}`)
  for (const [side, s] of [['back', r.back], ['challenge', r.challenge]] as const) {
    const issues: string[] = []
    if (!s.trim().endsWith('?')) issues.push('not a question')
    if ((s.match(/\?/g) ?? []).length > 1 || /[.!]\s+\S/.test(s)) issues.push('more than one sentence')
    if (words(s) > 14) issues.push(`long (${words(s)} words)`)
    if (ARGUES.test(s)) issues.push('first person or verdict')
    if (DUTCH.test(k.text.split(' ').slice(0, 8).join(' ')) && /\b(een|het|de)\b/i.test(k.text) && !DUTCH.test(s)) issues.push('not Dutch')
    if (EMOJI.test(s)) issues.push('emoji')
    if (INSULTS.test(s)) issues.push('insult word')
    flags += issues.length
    console.log(`  ${side.padEnd(9)}  ${s}${issues.length ? `   <-- ${issues.join(', ')}` : ''}`)
  }
  if (firstWord(r.back) === firstWord(r.challenge)) { console.log('  <-- both start the same way'); flags++ }
}
console.log(`\n${CASES.length} cases, ${flags} mechanical flags (which way each question leans: read above)`)
