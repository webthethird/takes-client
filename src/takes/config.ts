import type { Env as WarpEnv } from '@warpstack/api/worker'

/** Warpstack's bindings plus Takes' own. */
export interface Env extends WarpEnv {
  /** Takes' derived state: classifications, stances, scores, follows. */
  TAKES: D1Database
  /** Unset: scoring is off and the feed is empty, with a log line saying why. */
  ANTHROPIC_API_KEY?: string
  /**
   * The deployment's own viewer: always active, so its follows keep being scored. Visitors
   * pick their own ("Viewing as", core/viewers.ts); this is not a default for them.
   */
  VIEWER_FID?: string
  /** Embeddings for merging casts into canonical markets. Unset: merging is off. */
  OPENAI_API_KEY?: string
  /** New viewers admitted per IP: 1 a minute (core/viewers.ts). Unset: only the hourly cap applies. */
  NEW_VIEWER_IP?: RateLimit
  /** Most Claude calls per scoring pass (one pass per minute). Default 40. */
  TAKES_MAX_CALLS?: string
}

export type TakesConfig = { apiKey: string | null; openaiKey: string | null; viewerFid: number | null; maxCalls: number }

export const takesConfig = (env: Env): TakesConfig => {
  const viewer = Number(env.VIEWER_FID)
  const max = Number(env.TAKES_MAX_CALLS)
  return {
    apiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    openaiKey: env.OPENAI_API_KEY?.trim() || null,
    viewerFid: Number.isSafeInteger(viewer) && viewer > 0 ? viewer : null,
    maxCalls: Number.isSafeInteger(max) && max >= 0 ? max : 40,
  }
}
