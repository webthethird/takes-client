-- Viewers: the people whose follow graphs shape scoring and "For you" (core/viewers.ts). Until
-- the web can sign in, a viewer is whoever typed a username or FID. Follow lists stay in
-- follows / follows_meta, keyed by viewer as before.
CREATE TABLE viewers (
  fid        INTEGER PRIMARY KEY,
  username   TEXT,                       -- current username when admitted, for display
  first_seen INTEGER NOT NULL,           -- Unix seconds: admitted
  last_seen  INTEGER NOT NULL,           -- Unix seconds: last visit, refreshed at most hourly
  caught_up  INTEGER NOT NULL DEFAULT 0  -- 1 once their follows' whole window has been classified
);
CREATE INDEX viewers_last_seen ON viewers (last_seen);
CREATE INDEX viewers_first_seen ON viewers (first_seen);

-- "Does any active viewer follow this author?", asked of a pass's new casts.
CREATE INDEX follows_fid ON follows (fid);
