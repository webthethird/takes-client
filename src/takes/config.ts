import type { Env as WarpEnv } from '@warpstack/api/worker'

/** Warpstack's bindings plus Takes' own. */
export interface Env extends WarpEnv {
  /** Takes' derived state: classifications, stances, scores, follows. */
  TAKES: D1Database
  /** Unset: scoring is off and the feed is empty, with a log line saying why. */
  ANTHROPIC_API_KEY?: string
  /**
   * Whose follow graph boosts the feed. Stands in for the session's FID until the web can
   * sign in (Warpstack's browser client is read-only). Unset: no following lane or credit.
   */
  VIEWER_FID?: string
  /** Most Claude calls per scoring pass (one pass per minute). Default 40. */
  TAKES_MAX_CALLS?: string
}

export type TakesConfig = { apiKey: string | null; viewerFid: number | null; maxCalls: number }

export const takesConfig = (env: Env): TakesConfig => {
  const viewer = Number(env.VIEWER_FID)
  const max = Number(env.TAKES_MAX_CALLS)
  return {
    apiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    viewerFid: Number.isSafeInteger(viewer) && viewer > 0 ? viewer : null,
    maxCalls: Number.isSafeInteger(max) && max >= 0 ? max : 40,
  }
}
