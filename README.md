# Takes

A Farcaster client that ranks debates. It finds casts that take a side on a question, asks
who backs and who challenges each one, and shows the liveliest arguments first: on the web,
on iPhone, and from its own server on Cloudflare. It is built from
[Warpstack](https://github.com/daemons404/warpstack)'s building blocks; the Farcaster
network (a Hypersnap or Snapchain node) is the database, and Takes keeps only its scores.

## What you see

- **For you**: debates from people you follow, mixed with ones drawing attention across the
  network. Type a username or FID in "Viewing as" to see it through that account's follows;
  no sign-in needed. A new viewer's follows are scored first, which takes up to about an hour.
- **Topic tabs** (Farcaster, Crypto, AI, Politics, ...): the same feed, filtered by topic.
- **Each card**: the take, the strongest reply from the other side, and how many people back
  and challenge it (never counting the author). Tap a count to see every one, one reply per
  person.

The web is read-only. Signing in and casting work in the iPhone app (Warpstack's screens).

## How it works

Scoring runs on the server, once a minute (`src/takes/pipeline.ts`); a page load only reads
stored scores. Each pass:

1. Refreshes a few viewers' follow lists from the node.
2. Classifies new root casts with Claude: is it an opinion, and on what yes/no question?
   Casts from active viewers' follows go first; casts drawing attention across the network
   keep at least a quarter of the budget.
3. Reads each new reply's stance on its root's question (back, challenge, or neither).
4. Merges takes on the same question into one market (OpenAI embeddings, then Claude), files
   it under topics, and rescores every live card.

Claude calls share one budget per pass (`TAKES_MAX_CALLS`, default 40); leftover work waits
for the next minute. The model is Claude Haiku 5.5 (`src/takes/adapters/claude.ts`).

Viewers (`src/takes/core/viewers.ts`): up to 200 are active at once, each for 14 days after
their last visit. New ones are admitted at most 30 an hour across the server and one a minute
per IP address. The server's own viewer (`VIEWER_FID`) is always active.

| Where | What |
|---|---|
| `src/worker.ts` | The Worker: Warpstack plus the `/api/takes/*` routes and the scoring cron |
| `src/takes/` | Scoring: `pipeline.ts`, `feed.ts`, `merge.ts`, `viewers.ts`; adapters for the node, Claude, OpenAI and the databases |
| `src/takes/core/` | Pure logic, unit-tested: scoring, markets, topics, viewers |
| `src/takes-ui/DebatesScreen.tsx` | The debate feed (the app's home page) |
| `migrations-takes/` | The scores database (D1 binding `TAKES`); Warpstack's own index is `DB` |
| `scripts/eval-*.mts` | Evaluations of the prompts against real casts (they call the APIs) |

## Costs

Production keeps scoring whether or not anyone visits. At about 1,700 Claude calls a day
with no new viewers (measured Nov 2026), that is roughly $1-2 a day in Anthropic credits.
The cost per call is an estimate, not measured: check the Anthropic Console. Each new viewer
adds a one-time backlog (a few hundred to a thousand calls). The hard ceiling is
`TAKES_MAX_CALLS` × 1,440 passes a day. Cloudflare needs Workers Paid ($5 a month).

To pause scoring, keeping the site up with its current scores:
`pnpm run deploy --max-calls 0`. To resume: `pnpm run deploy --max-calls 40`. Deploying
without `--max-calls` keeps the stored value, so it does not resume. Setting a spend limit in
the Anthropic Console is the backstop.

## Run it here

```sh
cp .dev.vars.example .dev.vars    # then fill it in: openssl rand -hex 32 makes a key
pnpm dev                          # the server and web app on localhost:8787, no Cloudflare account
```

Locally the cron doesn't fire on its own. Trigger one scoring pass with:

```sh
curl -X POST 'http://localhost:8787/cdn-cgi/local/explorer/api/local/scheduled?worker=takes-client' \
  -H 'content-type: application/json' -d '{"cron":"* * * * *"}'
```

`pnpm test` runs the unit tests; `pnpm typecheck` checks the app and the Worker.

## Your own server

[SETUP.md](SETUP.md): about ten minutes in a browser, then `pnpm run deploy`. Put
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in `.env.deploy` next to the Cloudflare token.
Without the Anthropic key, scoring is off.

```sh
pnpm run deploy --dry-run --public     # what it would create, set and migrate; changes nothing
pnpm run deploy --public               # deploy; --public lets browsers read it (the web can't sign in)
pnpm run deploy --viewer-fid 1234      # the server's own viewer
pnpm run deploy --max-calls 40         # Claude calls per pass; 0 pauses scoring
```

Settings you don't pass keep their stored values, including `--public` and `--max-calls`
(`--private` makes it private again). Migrations for both databases run on every deploy.

## The iPhone app

Needs Xcode and Rust. The first build compiles the vault from source, which takes a few
minutes. Set `CARGO_TARGET_DIR` to a folder outside `node_modules` to keep later builds fast.

```sh
EXPO_PUBLIC_API_URL=https://<your server> pnpm run ios:release
```

## Known gaps

- Deleted replies are still counted in a card's back/challenge counts.
- The OpenAI embeddings call sometimes times out; the merge resumes on the next pass.
- A feed page requested during a scoring pass can come back short.
- Stance accuracy at Claude's `low` effort hasn't been re-measured since the move to Haiku 5.5.
