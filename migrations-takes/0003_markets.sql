-- Canonical markets: casts that argue the same question, merged. A market's id is
-- keccak256(question), the hash TakesFactory addresses markets by, so a row here names exactly
-- one on-chain market (per lockup duration). The question is the first one to found the
-- market and never changes, as on-chain.

CREATE TABLE markets (
  id          TEXT PRIMARY KEY,          -- 0x keccak256(bytes(question))
  question    TEXT NOT NULL,
  claim_type  TEXT NOT NULL,             -- matching only within a claim type, as the mini-app
  embedding   BLOB NOT NULL,             -- float32, text-embedding-3-small (1536 dims)
  seed_hash   TEXT NOT NULL,             -- the cast whose claim founded it
  created_ts  INTEGER NOT NULL           -- the seed cast's time, so canonical = earliest
) WITHOUT ROWID;
CREATE INDEX markets_type ON markets(claim_type, created_ts);

-- One row per classified root cast with a claim: which market it argues, and on which side.
CREATE TABLE market_members (
  cast_hash     TEXT PRIMARY KEY,
  market_id     TEXT NOT NULL,
  merge_version TEXT NOT NULL,
  answer        TEXT NOT NULL,           -- the caster's side ON THE CANONICAL QUESTION
  via           TEXT NOT NULL,           -- seed, identical, join or adjudicated
  similarity    REAL,                    -- to the canonical question; NULL for a seed
  detail        TEXT,                    -- JSON: Claude's adjudication, when there was one
  ts            INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX market_members_market ON market_members(market_id);
