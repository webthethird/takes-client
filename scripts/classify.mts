// One-off stage 1 on a piece of text, through the same ClaudeClassifier the Worker uses
// (model, effort and prompt included). For prompt iteration and "why isn't this in the feed?".
//
//   pnpm classify "My most controversial take is that ketchup is only for hot dogs"
//
// Reads ANTHROPIC_API_KEY from .dev.vars (via node --env-file). One Claude call per run.

import { ClaudeClassifier } from '../src/takes/adapters/claude.ts'
import { chooseClaim, gatedChallenge, CHALLENGE_BAND } from '../src/takes/core/score.ts'

const text = process.argv.slice(2).join(' ').trim()
if (!text) {
  console.error('usage: pnpm classify "<cast text>"')
  process.exit(2)
}
const key = process.env.ANTHROPIC_API_KEY
if (!key) {
  console.error('ANTHROPIC_API_KEY is not set (expected in .dev.vars)')
  process.exit(2)
}

const result = await new ClaudeClassifier(key).classifyCast({ text })
console.log(JSON.stringify(result, null, 2))
if (!('declined' in result) && result.is_opinion) {
  const claim = chooseClaim(result.claims)
  console.log(claim
    ? `\nchosen: "${claim.question}"  gated ${gatedChallenge(claim).toFixed(2)}  band ${Math.floor(gatedChallenge(claim) / CHALLENGE_BAND + 1e-9)}`
    : '\nno usable claim (all externally resolvable)')
}
