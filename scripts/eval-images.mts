// Image eval for the client-only calls: suggested replies and topic filing, without and with the
// cast's images. Cases are scored cards whose cast has images (from the local databases).
//
//   node --env-file=.dev.vars scripts/eval-images.mts <takes.sqlite> <warp.sqlite> <out.md> [--must <text>]... [--n 30]
//
// Topic runs three times per case: no images, no images again (a control: how often the topic
// changes between identical runs), and with images. Suggestions run twice, without and with;
// they are free text, so they are printed side by side for reading, not counted.
// Five Claude calls per case. The cast text is the stored text (mentions not rendered by name).

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { ClaudeClassifier, isDeclined } from '../src/takes/adapters/claude.ts'
import { matchCasing } from '../src/takes/core/text.ts'
import { TOPICS } from '../src/takes/core/topics.ts'

const args = process.argv.slice(2)
const must = args.flatMap((a, i) => (args[i - 1] === '--must' ? [a] : []))
const nAt = args.indexOf('--n')
const N = nAt >= 0 ? Number(args[nAt + 1]) : 30
const [takesDb, warpDb, out] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--must' && args[i - 1] !== '--n')
if (!out) { console.error('usage: eval-images.mts <takes.sqlite> <warp.sqlite> <out.md> [--must <text>]... [--n 30]'); process.exit(2) }
const key = process.env.ANTHROPIC_API_KEY
if (!key) { console.error('ANTHROPIC_API_KEY is not set (expected in .dev.vars)'); process.exit(2) }

type Row = { hash: string; text: string; embeds: string; question: string; answer: 'yes' | 'no'; topic_a: string | null; topic_b: string | null }
const rows: Row[] = JSON.parse(execFileSync('sqlite3', ['-json', takesDb, `attach '${warpDb}' as w;
  select s.hash, coalesce(c.text, a.text) text, coalesce(c.embeds, a.embeds) embeds, s.question, s.author_stance answer, s.topic_a, s.topic_b
    from scores s left join w.casts c on c.hash = s.hash left join archive_casts a on a.hash = s.hash
   where coalesce(c.embeds, a.embeds) is not null order by s.hash`], { maxBuffer: 1 << 28 }).toString() || '[]')

const imageLike = (u: string) => /^https:\/\/(imagedelivery\.net|i\.imgur\.com)\//.test(u) || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(u)
const isImage = async (url: string) => {
  for (const method of ['HEAD', 'GET'] as const) {
    try {
      const res = await fetch(url, { method, headers: method === 'GET' ? { range: 'bytes=0-0' } : {}, signal: AbortSignal.timeout(10_000) })
      await res.body?.cancel()
      if (res.ok || res.status === 206) return (res.headers.get('content-type') ?? '').startsWith('image/')
    } catch { /* next method */ }
  }
  return false
}
const ordered = [...rows.filter(r => must.some(m => r.text.includes(m))), ...rows.filter(r => !must.some(m => r.text.includes(m)))]
const cases: Array<Row & { images: string[] }> = []
for (const r of ordered) {
  if (cases.length >= N) break
  const urls = (JSON.parse(r.embeds) as Array<{ kind: string; url?: string }>).flatMap(e => (e.kind === 'url' && e.url && imageLike(e.url) ? [e.url] : []))
  const ok = (await Promise.all(urls.map(async u => ((await isImage(u)) ? u : null)))).filter((u): u is string => u !== null)
  if (ok.length > 0) cases.push({ ...r, images: ok })
}
console.error(`${cases.length} cases`)

const c = new ClaudeClassifier(key)
const name = new Map(TOPICS.map(t => [t.id, t.name]))
const topicOf = async (k: (typeof cases)[number], images: boolean) => {
  try {
    const r = await c.assignTopic({ question: k.question, text: k.text, ...(images ? { images: k.images } : {}) })
    return isDeclined(r) ? { label: `declined: ${r.reason}`, primary: null } : {
      label: `${name.get(r.primary) ?? 'Other'}${r.secondary !== 'none' ? ` + ${name.get(r.secondary)}` : ''}  (${r.reason})`, primary: r.primary,
    }
  } catch (e) { return { label: `ERROR ${String(e).slice(0, 200)}`, primary: null } }
}
const suggestOf = async (k: (typeof cases)[number], images: boolean) => {
  try {
    const r = await c.suggest({ text: k.text, question: k.question, answer: k.answer, ...(images ? { images: k.images } : {}) })
    return isDeclined(r) ? `declined: ${r.reason}` : `back: "${matchCasing(k.text, r.back)}"\n  - challenge: "${matchCasing(k.text, r.challenge)}"`
  } catch (e) { return `ERROR ${String(e).slice(0, 200)}` }
}

const results: Array<{ k: (typeof cases)[number]; t0: Awaited<ReturnType<typeof topicOf>>; t1: Awaited<ReturnType<typeof topicOf>>; ti: Awaited<ReturnType<typeof topicOf>>; s0: string; si: string }> = []
const queue = [...cases]
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let k = queue.shift(); k; k = queue.shift()) {
    const [t0, t1, ti, s0, si] = await Promise.all([topicOf(k, false), topicOf(k, false), topicOf(k, true), suggestOf(k, false), suggestOf(k, true)])
    results.push({ k, t0, t1, ti, s0, si })
  }
}))
results.sort((a, b) => a.k.hash.localeCompare(b.k.hash))

const controlFlips = results.filter(r => r.t0.primary !== r.t1.primary).length
const imageFlips = results.filter(r => r.t0.primary !== r.ti.primary).length
const errors = results.filter(r => r.ti.label.startsWith('ERROR') || r.si.startsWith('ERROR')).length
const summary = `${results.length} cases: main topic changed between two runs without images ${controlFlips}; without vs with images ${imageFlips}; image requests failed ${errors}`
console.log(summary)
const lines = [`# Suggest + topic image eval, ${new Date().toISOString()}`, '', summary, '']
for (const { k, t0, t1, ti, s0, si } of results) {
  lines.push(`## ${k.question} (author: ${k.answer})`, '', `> ${k.text.replace(/\n+/g, ' ').slice(0, 400)}`, '')
  lines.push(...k.images.map(u => `- image: ${u}`))
  lines.push(`- topic today: ${[k.topic_a, k.topic_b].filter(Boolean).map(t => name.get(t!)).join(' + ') || 'Other'}`)
  lines.push(`- topic, no images: ${t0.label}`, `- topic, no images again: ${t1.label}`, `- **topic, with images: ${ti.label}**`)
  lines.push(`- suggestions, no images:\n  - ${s0}`, `- **suggestions, with images:**\n  - ${si}`, '')
}
writeFileSync(out, lines.join('\n'))
console.log(`wrote ${out}`)
