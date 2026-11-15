// Seed topics for the topic tabs: cluster every market's question embedding, then have Claude
// name each cluster in one call. Writes nothing to the database: the result is a file to review.
//
//   node --env-file=.dev.vars scripts/seed-topics.mts <takes.sqlite> <out.json>
//
// Clustering: average linkage on cosine distance, cut at CUT; clusters of MIN+ markets are
// topics, the rest are Other. The stability replay (Nov 15, 2026) chose 0.8/10: about nine
// topics, and the fewest markets changing topic between daily re-clusters. Topics found here
// are meant to be assigned once and kept, not re-cut daily.

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'

const CUT = Number(process.env.CUT ?? 0.8)
const MIN = Number(process.env.MIN ?? 10)
const SAMPLE = 25
const MODEL = 'claude-opus-5-5'

const [db, out] = process.argv.slice(2)
if (!db || !out) throw new Error('usage: seed-topics.mts <takes.sqlite> <out.json>')
const key = process.env.ANTHROPIC_API_KEY
if (!key) throw new Error('ANTHROPIC_API_KEY is not set')

type Row = { id: string; question: string; e: string; live: number }
// live: scored cards (the feed's pool) on this market, which is what makes a tab worth showing.
const rows: Row[] = JSON.parse(execFileSync('sqlite3', ['-json', db,
  `select m.id, m.question, hex(m.embedding) e,
          (select count(*) from market_members mm join scores s on s.hash = mm.cast_hash where mm.market_id = m.id) live
     from markets m order by m.created_ts, m.id`], { maxBuffer: 1 << 28 }).toString())

const unit = (h: string) => {
  const b = Buffer.from(h, 'hex'); const v = new Float32Array(b.buffer, b.byteOffset, b.length / 4)
  let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s); return Float32Array.from(v, x => x / s)
}

/** Average-linkage clusters at CUT, by the nearest-neighbour chain; indices into `vecs`. */
const cluster = (vecs: Float32Array[]): number[][] => {
  const n = vecs.length, D = new Float64Array(n * n)
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    let s = 0; const a = vecs[i]!, b = vecs[j]!; for (let k = 0; k < a.length; k++) s += a[k]! * b[k]!
    D[i * n + j] = D[j * n + i] = 1 - s
  }
  const size = new Array<number>(n).fill(1), alive = new Array<boolean>(n).fill(true)
  const merges: Array<[number, number, number]> = [], chain: number[] = []
  for (let left = n; left > 1;) {
    if (chain.length === 0) chain.push(alive.indexOf(true))
    const a = chain[chain.length - 1]!; let best = -1, bd = Infinity
    for (let k = 0; k < n; k++) {
      if (k === a || !alive[k]) continue
      const d = D[a * n + k]!
      if (d < bd || (d === bd && k === chain[chain.length - 2])) { bd = d; best = k }
    }
    if (chain.length >= 2 && best === chain[chain.length - 2]) {
      chain.pop(); chain.pop(); merges.push([a, best, bd])
      for (let k = 0; k < n; k++) if (alive[k] && k !== a && k !== best) {
        D[a * n + k] = D[k * n + a] = (size[a]! * D[a * n + k]! + size[best]! * D[best * n + k]!) / (size[a]! + size[best]!)
      }
      size[a]! += size[best]!; alive[best] = false; left--
    } else chain.push(best)
  }
  const p = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => (p[x] === x ? x : (p[x] = find(p[x]!)))
  for (const [a, b, h] of merges.sort((x, y) => x[2] - y[2])) if (h <= CUT) p[find(b)] = find(a)
  const g = new Map<number, number[]>()
  for (let i = 0; i < n; i++) g.set(find(i), [...(g.get(find(i)) ?? []), i])
  return [...g.values()].sort((x, y) => y.length - x.length)
}

const groups = cluster(rows.map(r => unit(r.e)))
const topics = groups.filter(g => g.length >= MIN)
const other = groups.filter(g => g.length < MIN).flat()
// A fixed-seed sample, so a rerun shows Claude the same questions.
const sample = (g: number[]) => g.map(i => [((i * 2654435761) >>> 0) % 100_000, i] as const)
  .sort((a, b) => a[0] - b[0]).slice(0, SAMPLE).map(([, i]) => rows[i]!.question)

const Naming = z.object({
  topics: z.array(z.object({
    cluster: z.number().int().describe('The cluster number, as given'),
    name: z.string().describe('Tab label: 1-3 words, Title Case, plain (e.g. "Crypto", "Food & Drink")'),
    description: z.string().describe('One sentence: what belongs here, written to decide whether a new question fits'),
    coherent: z.boolean().describe('false if the cluster mixes unrelated subjects or groups by question phrasing rather than subject'),
    note: z.string().describe('Why, in a few words: what is mixed in, or what is notable'),
  })),
  merges: z.array(z.object({
    clusters: z.array(z.number().int()),
    reason: z.string(),
  })).describe('Clusters a reader would expect under one tab (e.g. two halves of one subject); empty if none'),
})

const prompt = `These are clusters of debate questions from Farcaster, a social network, found by embedding similarity. Each will become a topic tab in a feed of debatable casts. For each cluster, name it as a tab (1-3 words) and describe it in one sentence that would let someone decide whether a new question belongs. Judge coherence honestly: say so when a cluster groups questions by their wording ("Is X better than Y?") rather than their subject, or mixes subjects. Then list any clusters that readers would expect under one tab.

${topics.map((g, i) => `<cluster number="${i}" size="${g.length}">\n${sample(g).map(q => `- ${q}`).join('\n')}\n</cluster>`).join('\n\n')}`

const client = new Anthropic({ apiKey: key })
const r = await client.messages.parse({
  model: MODEL,
  max_tokens: 16_000,
  thinking: { type: 'adaptive' },
  messages: [{ role: 'user', content: prompt }],
  output_config: { format: zodOutputFormat(Naming) },
})
if (!r.parsed_output) throw new Error(`no parsed output (stop_reason ${r.stop_reason})`)
console.error(`usage: ${r.usage.input_tokens} in, ${r.usage.output_tokens} out (${MODEL})`)

const named = r.parsed_output.topics
const result = {
  generated: new Date().toISOString(), cut: CUT, min: MIN, model: MODEL, markets: rows.length,
  topics: topics.map((g, i) => {
    const n = named.find(t => t.cluster === i)
    return {
      cluster: i, name: n?.name ?? '(unnamed)', description: n?.description ?? '', coherent: n?.coherent ?? null, note: n?.note ?? '',
      markets: g.length, liveCards: g.reduce((s, k) => s + rows[k]!.live, 0),
      members: g.map(k => rows[k]!.id), sample: sample(g),
    }
  }),
  merges: r.parsed_output.merges,
  other: { markets: other.length, liveCards: other.reduce((s, k) => s + rows[k]!.live, 0), sample: sample(other) },
}
writeFileSync(out, JSON.stringify(result, null, 2))

for (const t of result.topics) {
  console.log(`#${t.cluster} ${t.name} — ${t.markets} markets, ${t.liveCards} live cards${t.coherent === false ? '  [INCOHERENT]' : ''}`)
  console.log(`   ${t.description}`)
  console.log(`   note: ${t.note}`)
}
console.log(`Other — ${result.other.markets} markets, ${result.other.liveCards} live cards`)
for (const m of result.merges) console.log(`merge? ${m.clusters.join(' + ')}: ${m.reason}`)
