-- Topic tabs (src/takes/core/topics.ts). Each market is filed once per TOPIC_VERSION under up to
-- two topics, by Claude, and keeps them: rank 1 is its main topic, rank 2 an optional second.
-- A market that fits none is stored as topic_id 'other' at rank 1, so it isn't asked again.
CREATE TABLE market_topics (
  market_id TEXT NOT NULL,
  version   TEXT NOT NULL,
  rank      INTEGER NOT NULL,           -- 1 main, 2 second
  topic_id  TEXT NOT NULL,              -- a TOPICS id, or 'other'
  reason    TEXT,                       -- the model's few words on what the cast is about
  ts        INTEGER NOT NULL,
  PRIMARY KEY (market_id, version, rank)
) WITHOUT ROWID;

-- Copied onto each card at scoring time, so a tab is one indexed filter. NULL: no topic (Other,
-- or not filed yet).
ALTER TABLE scores ADD COLUMN topic_a TEXT;
ALTER TABLE scores ADD COLUMN topic_b TEXT;
CREATE INDEX scores_topic_a ON scores(topic_a) WHERE topic_a IS NOT NULL;
CREATE INDEX scores_topic_b ON scores(topic_b) WHERE topic_b IS NOT NULL;
