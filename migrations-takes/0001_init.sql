-- Takes' own state, kept apart from Warpstack's cast index (the DB binding), whose migrations
-- live in node_modules and are Warpstack's to change. Everything here is derived: the cast
-- index plus Claude's judgments of it. Wiping this database costs only re-classification.
-- Hashes are lowercase 0x-hex TEXT, as in the cast index.

-- Who the viewer follows, from the node. Refreshed on a TTL by the scoring cron.
CREATE TABLE follows (
  viewer INTEGER NOT NULL,
  fid    INTEGER NOT NULL,
  PRIMARY KEY (viewer, fid)
) WITHOUT ROWID;

CREATE TABLE follows_meta (
  viewer   INTEGER PRIMARY KEY,
  ts       INTEGER NOT NULL,             -- Unix seconds of the last complete refresh
  count    INTEGER NOT NULL
);

-- Stage 1, one row per root cast classified. A row with an older prompt_version counts as
-- unclassified, so bumping PROMPT_VERSION re-classifies everything in the window.
CREATE TABLE classifications (
  hash           TEXT PRIMARY KEY,
  fid            INTEGER NOT NULL,
  ts             INTEGER NOT NULL,       -- the cast's own time
  lane           TEXT NOT NULL,          -- 'following' or 'global': why it was picked
  prompt_version TEXT NOT NULL,
  is_opinion     INTEGER NOT NULL,
  reason         TEXT NOT NULL,
  claim          TEXT,                   -- JSON: the chosen claim, or NULL when none qualifies
  classified_ts  INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX classifications_time ON classifications(ts DESC) WHERE claim IS NOT NULL;

-- Stage 2, one row per (reply, root): where the reply lands on the root's question.
CREATE TABLE stances (
  reply_hash     TEXT NOT NULL,
  root_hash      TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  fid            INTEGER NOT NULL,
  stance         TEXT NOT NULL,          -- 'yes', 'no' or 'off_topic', after reconciliation
  confidence     REAL NOT NULL,
  text_len       INTEGER NOT NULL,
  corrected      INTEGER NOT NULL,       -- 1 when reconciliation overrode the model's verdict
  detail         TEXT NOT NULL,          -- JSON: the model's typed intermediates, for auditing
  classified_ts  INTEGER NOT NULL,
  PRIMARY KEY (root_hash, reply_hash)
) WITHOUT ROWID;

-- One feed card per opinion root. Viewer-independent: the following-graph credit is applied
-- at read time, so one scoring pass serves every viewer.
CREATE TABLE scores (
  hash             TEXT PRIMARY KEY,
  fid              INTEGER NOT NULL,
  ts               INTEGER NOT NULL,
  band             INTEGER NOT NULL,     -- confidence-gated challengeability, in 0.1 bands
  credit           REAL NOT NULL,        -- corroboration within the band, in [0, 1)
  both_sides       INTEGER NOT NULL,
  yes_authors      INTEGER NOT NULL,
  no_authors       INTEGER NOT NULL,
  question         TEXT NOT NULL,
  challenge_reason TEXT NOT NULL,
  author_stance    TEXT NOT NULL,        -- the root author's answer: what "back this take" means
  rebuttal_hash    TEXT,
  rebuttal_fid     INTEGER,
  updated_ts       INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX scores_rank ON scores(band DESC, ts DESC);

-- A lease so overlapping cron ticks don't classify the same casts twice.
CREATE TABLE leases (
  name  TEXT PRIMARY KEY,
  until INTEGER NOT NULL
) WITHOUT ROWID;
