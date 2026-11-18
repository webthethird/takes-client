// The classifier calls, ported from takes-classifier/src/lib/classify.ts onto the
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
import { CLASSIFY_PROMPT, MERGE_PROMPT, STANCE_PROMPT, SUGGEST_PROMPT, TOPIC_PROMPT } from '../prompts.ts'
import { ClassifyResult, MarketVerdict, StanceResult, Suggestions, TopicAssignment } from '../schema.ts'

export const MODEL = 'claude-haiku-5-5'

/** A decision the model declined to make. Recorded, never retried. */
export type Declined = { declined: true; reason: string }

export interface Classifier {
  classifyCast(i: CastInput): Promise<ClassifyResult | Declined>
  classifyStance(i: { question: string; rootText: string; parentText: string; replyText: string; sameAuthor: boolean }):
    Promise<StanceResult | Declined>
  /** Merge: is `candidate` the same market as `existing`, and does YES mean the same in both? */
  adjudicateMarket(i: { existing: string; candidate: string }): Promise<MarketVerdict | Declined>
  /** Suggest: one question per side, leaning its way: a prompt to think, not a reply. */
  suggest(i: { text: string; question: string; answer: 'yes' | 'no'; images?: readonly string[] }): Promise<Suggestions | Declined>
  /** Topic: which tabs a market's question belongs under, read with the cast it came from. */
  assignTopic(i: { question: string; text: string; images?: readonly string[] }): Promise<TopicAssignment | Declined>
}

/**
 * A root cast as the classifier reads it: mentions already rendered. The quoted cast and link
 * URLs are context, the way the classifier's `<parent>` and `<embedded_link>` tags were: a
 * quote cast is often a take ON the quoted cast, and is unreadable without it.
 */
export type CastInput = { text: string; quoted?: string; links?: readonly string[]; images?: readonly string[] }

export const isDeclined = (r: object): r is Declined => 'declined' in r

/**
 * Runs `call` with the cast's images and, if the API rejects that request (a 400: typically an
 * image it couldn't fetch, deleted or not really an image), once more without them, so a cast is
 * never lost to its picture. Any other error, or a 400 on the retry, goes to the caller as before.
 */
export const retryWithoutImages = async <T>(images: readonly string[] | undefined, call: (images: readonly string[] | undefined) => Promise<T>): Promise<T> => {
  try {
    return await call(images)
  } catch (e) {
    if (images && images.length > 0 && e instanceof Anthropic.BadRequestError) return call(undefined)
    throw e
  }
}

/**
 * A user turn with the cast's images (URLs, at most 4: a cast's embed limit) ahead of the text,
 * as takes-classifier's classifyCast sends them. Anthropic fetches each URL; one it can't fetch
 * fails the request. With no images the turn is the plain text, unchanged.
 */
export const withImages = (text: string, images: readonly string[] | undefined): string | Anthropic.ContentBlockParam[] => {
  const urls = (images ?? []).slice(0, 4)
  if (urls.length === 0) return text
  return [
    { type: 'text', text: `The cast has ${urls.length === 1 ? 'this image' : `these ${urls.length} images`} attached; they are part of what it says.` },
    ...urls.map((url): Anthropic.ImageBlockParam => ({ type: 'image', source: { type: 'url', url } })),
    { type: 'text', text },
  ]
}

export class ClaudeClassifier implements Classifier {
  private readonly client: Anthropic

  constructor(apiKey: string) {
    // Workers: the SDK uses the global fetch. Its own retries (2, with backoff) cover 429/5xx.
    this.client = new Anthropic({ apiKey, timeout: 60_000 })
  }

  classifyCast(i: CastInput): Promise<ClassifyResult | Declined> {
    return retryWithoutImages(i.images, images => this.classifyOnce({ ...i, images }))
  }

  private async classifyOnce(i: CastInput): Promise<ClassifyResult | Declined> {
    const parts = [
      ...(i.quoted ? [`<quoted_cast>${i.quoted}</quoted_cast>`] : []),
      ...(i.links ?? []).map(u => `<embedded_link>${u}</embedded_link>`),
      `<cast>${i.text}</cast>`,
    ]
    const r = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: 'text', text: CLASSIFY_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: withImages(parts.join('\n\n'), i.images) }],
      output_config: { effort: 'low', format: zodOutputFormat(ClassifyResult) },
    })
    if (r.stop_reason === 'refusal') return { declined: true, reason: `refused: ${r.stop_details?.category ?? 'unspecified'}` }
    if (!r.parsed_output) return { declined: true, reason: `no parsed output (stop_reason ${r.stop_reason})` }
    return r.parsed_output
  }

  adjudicateMarket(i: { existing: string; candidate: string }): Promise<MarketVerdict | Declined> {
    return adjudicateWith(this.client, i)
  }

  suggest(i: { text: string; question: string; answer: 'yes' | 'no'; images?: readonly string[] }): Promise<Suggestions | Declined> {
    return retryWithoutImages(i.images, images => this.suggestOnce({ ...i, images }))
  }

  private async suggestOnce(i: { text: string; question: string; answer: 'yes' | 'no'; images?: readonly string[] }): Promise<Suggestions | Declined> {
    const r = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 2048,
      system: [{ type: 'text', text: SUGGEST_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: withImages(`<cast>${i.text}</cast>\n\n<question>${i.question}</question>\n\n<answer>${i.answer}</answer>`, i.images),
      }],
      output_config: { effort: 'low', format: zodOutputFormat(Suggestions) },
    })
    if (r.stop_reason === 'refusal') return { declined: true, reason: `refused: ${r.stop_details?.category ?? 'unspecified'}` }
    if (!r.parsed_output) return { declined: true, reason: `no parsed output (stop_reason ${r.stop_reason})` }
    return r.parsed_output
  }

  assignTopic(i: { question: string; text: string; images?: readonly string[] }): Promise<TopicAssignment | Declined> {
    return retryWithoutImages(i.images, images => this.assignTopicOnce({ ...i, images }))
  }

  private async assignTopicOnce(i: { question: string; text: string; images?: readonly string[] }): Promise<TopicAssignment | Declined> {
    const r = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 2048,
      system: [{ type: 'text', text: TOPIC_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: withImages(`<question>${i.question}</question>\n<cast>${i.text}</cast>`, i.images) }],
      output_config: { effort: 'low', format: zodOutputFormat(TopicAssignment) },
    })
    if (r.stop_reason === 'refusal') return { declined: true, reason: `refused: ${r.stop_details?.category ?? 'unspecified'}` }
    if (!r.parsed_output) return { declined: true, reason: `no parsed output (stop_reason ${r.stop_reason})` }
    return r.parsed_output
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
