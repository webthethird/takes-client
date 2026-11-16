// Warpstack's Worker, wrapped. Every request and cron goes to Warpstack unchanged, except
// the Takes routes (/api/takes/feed, /market, /sides and /topics), and the minute cron also runs a
// Takes scoring pass after Warpstack's own watchdog. Warpstack is used from npm as published;
// nothing of it is forked.

import warp, { IngestionObject, UserObject } from '@warpstack/api/worker'
import type { Env } from './takes/config.ts'
import { takesFeed, takesMarket, takesSides, takesTopics } from './takes/feed.ts'
import { runScoringPass } from './takes/pipeline.ts'

export { IngestionObject, UserObject }

const MINUTE_CRON = '* * * * *'
/** The 28-day resurfacing scan runs on every 15th minute; the fresh lanes every minute. */
const OLD_SCAN_EVERY_MINUTES = 15

const nowSeconds = (ms: number) => Math.floor(ms / 1000)

export default {
  fetch(req, env, ctx) {
    const path = new URL(req.url).pathname
    if (path === '/api/takes/feed') return takesFeed(req, env, ctx, warp.fetch, nowSeconds(Date.now()))
    if (path === '/api/takes/market') return takesMarket(req, env, ctx, warp.fetch)
    if (path === '/api/takes/sides') return takesSides(req, env, ctx, warp.fetch)
    if (path === '/api/takes/topics') return takesTopics(req, env, nowSeconds(Date.now()))
    return warp.fetch(req, env, ctx)
  },

  async scheduled(controller, env) {
    await warp.scheduled(controller, env)
    if (controller.cron !== MINUTE_CRON) return
    const now = nowSeconds(controller.scheduledTime)
    const includeOld = Math.floor(now / 60) % OLD_SCAN_EVERY_MINUTES === 0
    const report = await runScoringPass(env, { now, includeOld })
    console.log(`takes: ${JSON.stringify(report)}`)
  },
} satisfies ExportedHandler<Env>
