-- Usernames for rendering @mentions in what the classifier reads. Warpstack's users table
-- fills names lazily and locally held none, so names come from the node, cached here.
-- username NULL: the node has none for this FID (looked up, not missing).
CREATE TABLE names (
  fid      INTEGER PRIMARY KEY,
  username TEXT,
  ts       INTEGER NOT NULL
);
