// Question embeddings from OpenAI text-embedding-3-small: the model the mini-app uses
// (lib/embed.ts), so both apps agree on what counts as the same market. A fixed-host adapter:
// one endpoint, called with fetch and parsed with zod, rather than another SDK dependency.

import { z } from 'zod'

export const EMBEDDING_MODEL = 'text-embedding-3-small'
const ENDPOINT = 'https://api.openai.com/v1/embeddings'
/** The API accepts up to 2048 inputs per call; questions are short, so this stays far below its token cap. */
const BATCH = 256

const Response = z.object({
  data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()) })),
})

export type EmbedResult = { ok: true; vectors: Float32Array[] } | { ok: false; error: string; transient: boolean }

export const embedMany = async (apiKey: string, texts: readonly string[]): Promise<EmbedResult> => {
  const vectors: Float32Array[] = []
  for (let i = 0; i < texts.length; i += BATCH) {
    const input = texts.slice(i, i + BATCH)
    let res: Response
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (e) {
      return { ok: false, error: `embeddings: ${String(e)}`, transient: true }
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200)
      return { ok: false, error: `embeddings: ${res.status} ${body}`, transient: res.status === 429 || res.status >= 500 }
    }
    const parsed = Response.safeParse(await res.json().catch(() => undefined))
    if (!parsed.success || parsed.data.data.length !== input.length) {
      return { ok: false, error: 'embeddings: unexpected response shape', transient: false }
    }
    // Results carry their input index; order by it rather than trusting array order.
    const ordered = [...parsed.data.data].sort((a, b) => a.index - b.index)
    for (const d of ordered) vectors.push(Float32Array.from(d.embedding))
  }
  return { ok: true, vectors }
}
