// Topic assignment eval: nearest-centroid (embeddings) vs Claude Haiku, on the reviewed topic
// list. One Haiku call per sampled market. Prints a side-by-side table to judge by eye.
//
//   node --env-file=.dev.vars scripts/eval-topics.mts <topics.json> <takes.sqlite> <warp.sqlite> <out.tsv>
//
// The sample is where the methods differ most: markets in Other (spread across similarity
// bands), seed members whose nearest centre is another topic ("contested"), and a few members
// where cluster and centre agree, as a control.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { z } from 'zod'

const MODEL = 'claude-haiku-5-5'
const FLOOR = 0.45
const [topicsFile, db, warpDb, out] = process.argv.slice(2)
if (!out) throw new Error('usage: eval-topics.mts <topics.json> <takes.sqlite> <warp.sqlite> <out.tsv>')
const key = process.env.ANTHROPIC_API_KEY
if (!key) throw new Error('ANTHROPIC_API_KEY is not set')

import { TOPICS } from '../src/takes/core/topics.ts'
import { TOPIC_PROMPT } from '../src/takes/prompts.ts'
import { TopicAssignment } from '../src/takes/schema.ts'

// Seed members give the embedding baseline its clusters and centres; topics added by hand
// (no members) are only in Claude's list, so the baseline can never pick them.
const final = JSON.parse(readFileSync(topicsFile, 'utf8')) as { topics: Array<{ id: string; members: string[] }> }
const membersOf = new Map(final.topics.map(t => [t.id, t.members]))
const topics = TOPICS.filter(t => membersOf.has(t.id)).map(t => ({ ...t, members: membersOf.get(t.id)! }))
const nameOf = new Map(TOPICS.map(t => [t.id, t.name]))

type Row = { id: string; question: string; e: string; t: string | null }
const rows: Row[] = JSON.parse(execFileSync('sqlite3', ['-json', db, `attach '${warpDb}' as w;
  select m.id, m.question, hex(m.embedding) e,
         coalesce((select text from archive_casts a where a.hash = m.seed_hash), (select text from w.casts c where c.hash = m.seed_hash)) t
    from markets m order by m.id`], { maxBuffer: 1 << 28 }).toString())
const unit = (v: ArrayLike<number>) => { let s = 0; for (let k = 0; k < v.length; k++) s += v[k]! * v[k]!; s = Math.sqrt(s); return Float32Array.from(v, x => x / s) }
const vec = new Map(rows.map(r => { const b = Buffer.from(r.e, 'hex'); return [r.id, unit(new Float32Array(b.buffer, b.byteOffset, b.length / 4))] }))
const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let k = 0; k < a.length; k++) s += a[k]! * b[k]!; return s }
const centroid = new Map(topics.map(t => {
  const sum = new Float64Array(1536); for (const m of t.members) vec.get(m)!.forEach((x, k) => (sum[k] += x))
  return [t.id, unit(sum)]
}))
const clusterOf = new Map(topics.flatMap(t => t.members.map(m => [m, t.id] as const)))
const nearest = (id: string) => {
  const s = topics.map(t => ({ id: t.id, s: dot(vec.get(id)!, centroid.get(t.id)!) })).sort((a, b) => b.s - a.s)
  return { top: s[0]!, second: s[1]! }
}

// Deterministic pseudo-random order, so a rerun samples the same markets.
const order = (xs: Row[]) => xs.map(r => [parseInt(r.id.slice(2, 10), 16), r] as const).sort((a, b) => a[0] - b[0]).map(([, r]) => r)
const other = order(rows.filter(r => !clusterOf.has(r.id)))
const contested = order(rows.filter(r => clusterOf.has(r.id) && nearest(r.id).top.id !== clusterOf.get(r.id)))
const agreeing = order(rows.filter(r => clusterOf.has(r.id) && nearest(r.id).top.id === clusterOf.get(r.id)))
// Other spread over bands: above the floor, just below it, and far below.
const band = (lo: number, hi: number) => other.filter(r => { const s = nearest(r.id).top.s; return s >= lo && s < hi })
const sample = [
  ...band(FLOOR, 1).slice(0, 15).map(r => ({ r, group: 'other>=0.45' })),
  ...band(0.4, FLOOR).slice(0, 15).map(r => ({ r, group: 'other 0.40-0.45' })),
  ...band(0, 0.4).slice(0, 15).map(r => ({ r, group: 'other<0.40' })),
  ...contested.slice(0, 40).map(r => ({ r, group: 'contested' })),
  ...agreeing.slice(0, 15).map(r => ({ r, group: 'agreeing' })),
]

// The production prompt and schema, so the eval measures what the pipeline runs.
const Assignment = TopicAssignment
const SYSTEM = TOPIC_PROMPT

const client = new Anthropic({ apiKey: key })
let inTok = 0, outTok = 0, cacheRead = 0
const results: Array<{ group: string; r: Row; haiku: z.infer<typeof Assignment> | null }> = []
const queue = [...sample]
await Promise.all(Array.from({ length: 5 }, async () => {
  for (let s = queue.shift(); s; s = queue.shift()) {
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 2048,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `<question>${s.r.question}</question>\n<cast>${s.r.t ?? ''}</cast>` }],
      output_config: { effort: 'low', format: zodOutputFormat(Assignment) },
    })
    inTok += res.usage.input_tokens; outTok += res.usage.output_tokens; cacheRead += res.usage.cache_read_input_tokens ?? 0
    results.push({ ...s, haiku: res.parsed_output ?? null })
  }
}))
console.error(`${results.length} calls; tokens: ${inTok} in, ${cacheRead} cache-read, ${outTok} out (${MODEL})`)

const groups = ['other>=0.45', 'other 0.40-0.45', 'other<0.40', 'contested', 'agreeing']
const lines = ['group\tquestion\tcluster\tcentroid\tsim\thaiku\thaiku2\treason']
for (const g of groups) {
  const rs = results.filter(x => x.group === g)
  const agree = rs.filter(x => x.haiku?.primary === (clusterOf.get(x.r.id) ?? (nearest(x.r.id).top.s >= FLOOR ? nearest(x.r.id).top.id : 'other'))).length
  const toOther = rs.filter(x => x.haiku?.primary === 'other').length
  const withSecond = rs.filter(x => x.haiku && x.haiku.secondary !== 'none').length
  const vsCluster = g === 'contested' ? `, Haiku = cluster ${rs.filter(x => x.haiku?.primary === clusterOf.get(x.r.id)).length}, Haiku = centre ${rs.filter(x => x.haiku?.primary === nearest(x.r.id).top.id).length}` : ''
  console.log(`\n== ${g} (${rs.length}): Haiku agrees with the embedding label ${agree}, Haiku says other ${toOther}, has a 2nd topic ${withSecond}${vsCluster}`)
  for (const x of rs) {
    const n = nearest(x.r.id)
    const emb = clusterOf.has(x.r.id) ? `cluster ${nameOf.get(clusterOf.get(x.r.id)!)} / centre ${nameOf.get(n.top.id)}` : n.top.s >= FLOOR ? `centre ${nameOf.get(n.top.id)}` : `other (nearest ${nameOf.get(n.top.id)})`
    const h = x.haiku ? `${nameOf.get(x.haiku.primary) ?? 'Other'}${x.haiku.secondary !== 'none' ? ` + ${nameOf.get(x.haiku.secondary)}` : ''}` : '(no output)'
    console.log(`  ${n.top.s.toFixed(2)}  emb: ${emb.padEnd(48)} haiku: ${h.padEnd(36)} ${x.r.question}`)
    lines.push([g, x.r.question, nameOf.get(clusterOf.get(x.r.id) ?? '') ?? '', nameOf.get(n.top.id), n.top.s.toFixed(3), x.haiku?.primary ?? '', x.haiku?.secondary ?? '', x.haiku?.reason ?? ''].join('\t'))
  }
}
writeFileSync(out, lines.join('\n'))
