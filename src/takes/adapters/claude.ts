// The two classifier calls, ported from takes-classifier/src/lib/classify.ts onto the
// current Haiku. Behind an interface so the pipeline can run against a fake.
//
// Model: claude-haiku-5-5, the current generation of the Haiku the classifier used
// (claude-haiku-4-5). Two differences matter here:
// - Thinking is on by default; effort is pinned to `low` for these short classifications.
//   Whether stance accuracy holds at `low` is unmeasured: re-run the classifier's
//   audit-stances cases before trusting it.
// - The cache minimum is 512 tokens (4096 on Haiku 4.5), so both system prompts now cache.

import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { CLASSIFY_PROMPT, MERGE_PROMPT, STANCE_PROMPT } from '../prompts.ts'
import { ClassifyResult, MarketVerdict, StanceResult } from '../schema.ts'

export const MODEL = 'claude-haiku-5-5'

/** A decision the model declined to make. Recorded, never retried. */
export type Declined = { declined: true; reason: string }

export interface Classifier {
  classifyCast(i: CastInput): Promise<ClassifyResult | Declined>
  classifyStance(i: { question: string; rootText: string; parentText: string; replyText: string; sameAuthor: boolean }):
    Promise<StanceResult | Declined>
  /** Merge: is `candidate` the same market as `existing`, and does YES mean the same in both? */
  adjudicateMarket(i: { existing: string; candidate: string }): Promise<MarketVerdict | Declined>
}

/**
 * A root cast as the classifier reads it: mentions already rendered. The quoted cast and link
 * URLs are context, the way the classifier's `<parent>` and `<embedded_link>` tags were: a
 * quote cast is often a take ON the quoted cast, and is unreadable without it.
 */
export type CastInput = { text: string; quoted?: string; links?: readonly string[] }

export const isDeclined = (r: object): r is Declined => 'declined' in r

export class ClaudeClassifier implements Classifier {
  private readonly client: Anthropic

  constructor(apiKey: string) {
    // Workers: the SDK uses the global fetch. Its own retries (2, with backoff) cover 429/5xx.
    this.client = new Anthropic({ apiKey, timeout: 60_000 })
  }

  async classifyCast(i: CastInput): Promise<ClassifyResult | Declined> {
    const parts = [
      ...(i.quoted ? [`<quoted_cast>${i.quoted}</quoted_cast>`] : []),
      ...(i.links ?? []).map(u => `<embedded_link>${u}</embedded_link>`),
      `<cast>${i.text}</cast>`,
    ]
    const r = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: 'text', text: CLASSIFY_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: parts.join('\n\n') }],
      output_config: { effort: 'low', format: zodOutputFormat(ClassifyResult) },
    })
    if (r.stop_reason === 'refusal') return { declined: true, reason: `refused: ${r.stop_details?.category ?? 'unspecified'}` }
    if (!r.parsed_output) return { declined: true, reason: `no parsed output (stop_reason ${r.stop_reason})` }
    return r.parsed_output
  }

  adjudicateMarket(i: { existing: string; candidate: string }): Promise<MarketVerdict | Declined> {
    return adjudicateWith(this.client, i)
  }

  async classifyStance(i: { question: string; rootText: string; parentText: string; replyText: string; sameAuthor: boolean }):
    Promise<StanceResult | Declined> {
    const r = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 2048,
      system: [{ type: 'text', text: STANCE_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `<question>${i.question}</question>\n\n<root>${i.rootText}</root>\n\n<parent>${i.parentText}</parent>\n\n`
          + `<same_author>${i.sameAuthor ? 'yes' : 'no'}</same_author>\n\n<reply>${i.replyText}</reply>`,
      }],
      output_config: { effort: 'low', format: zodOutputFormat(StanceResult) },
    })
    if (r.stop_reason === 'refusal') return { declined: true, reason: `refused: ${r.stop_details?.category ?? 'unspecified'}` }
    if (!r.parsed_output) return { declined: true, reason: `no parsed output (stop_reason ${r.stop_reason})` }
    return r.parsed_output
  }
}

export const adjudicateWith = async (client: Anthropic, i: { existing: string; candidate: string }):
  Promise<MarketVerdict | Declined> => {
  const r = await client.messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: [{ type: 'text', text: MERGE_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `<first>${i.existing}</first>\n\n<second>${i.candidate}</second>` }],
    output_config: { effort: 'low', format: zodOutputFormat(MarketVerdict) },
  })
  if (r.stop_reason === 'refusal') return { declined: true, reason: `refused: ${r.stop_details?.category ?? 'unspecified'}` }
  if (!r.parsed_output) return { declined: true, reason: `no parsed output (stop_reason ${r.stop_reason})` }
  return r.parsed_output
}

/**
 * Whether an error should stop this pass (try again next minute) rather than be recorded
 * against the cast. Rate limits, overload, server errors and network failures are transient;
 * a 400 on one cast would fail the same way every minute, so it is recorded and skipped.
 */
export const isTransient = (e: unknown): boolean =>
  e instanceof Anthropic.RateLimitError
  || e instanceof Anthropic.InternalServerError
  || e instanceof Anthropic.APIConnectionError
  || (e instanceof Anthropic.APIError && (e.status === 529 || e.status === 408 || e.status === 409))
