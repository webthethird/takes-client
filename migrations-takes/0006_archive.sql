-- Casts from before the cast index begins, read from the node so stage 1 and merging can see
-- the 28 days that resurfacing and merging look back over. A new deployment's index starts
-- only ~4 days back: both Snapchain and Hypersnap keep about that much event stream.
--
-- Filled by walking each active author's casts (castsByFid) back to the floor. Rows have the
-- same shape as Warpstack's casts table (mentions and embeds as the same JSON), so the same
-- parsers read both. Kept here, not in Warpstack's database, which Warpstack owns.
--
-- What's stored: root casts from before the index starts, and every reply the walk sees, in or
-- out of the index window, so a root's repliers can be counted here alone (D1 can't join two
-- databases). A cast deleted after it was read stays here; the feed hydrates through
-- Warpstack, which reports it gone, and the card is skipped.
CREATE TABLE archive_casts (
  hash        TEXT PRIMARY KEY,
  fid         INTEGER NOT NULL,
  ts          INTEGER NOT NULL,          -- Unix seconds
  reply       INTEGER NOT NULL,
  parent_hash TEXT,
  parent_fid  INTEGER,
  text        TEXT NOT NULL,
  embeds      TEXT NOT NULL,
  mentions    TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX archive_casts_parent ON archive_casts(parent_hash, ts) WHERE parent_hash IS NOT NULL;
CREATE INDEX archive_casts_roots  ON archive_casts(ts) WHERE reply = 0;

-- The walk's progress, one row per author: resumable mid-author (page_token) and done once the
-- walk passes the floor. Seeded from the authors in the cast index and the viewer's follows.
CREATE TABLE archive_authors (
  fid         INTEGER PRIMARY KEY,
  priority    INTEGER NOT NULL,          -- casts in the index: busier authors are walked first
  page_token  TEXT,                      -- where to resume; null: start from the newest cast
  done        INTEGER NOT NULL DEFAULT 0,
  stored      INTEGER NOT NULL DEFAULT 0,
  updated_ts  INTEGER
);
CREATE INDEX archive_authors_todo ON archive_authors(done, priority DESC);

-- One row: when the walk was seeded, the floor it walks back to, and where the index begins.
CREATE TABLE archive_meta (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  seeded_ts   INTEGER NOT NULL,
  floor_ts    INTEGER NOT NULL,
  index_start INTEGER NOT NULL
);
