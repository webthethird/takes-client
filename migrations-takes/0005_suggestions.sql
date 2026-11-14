-- AI-written reply suggestions for each side of a card, in the original cast's voice. Shown
-- in the "Back this take" / "Challenge it" boxes, labelled as AI. Written by their own stage
-- (SUGGEST_VERSION), so the copy can be iterated without re-classifying anything.
CREATE TABLE suggestions (
  hash       TEXT PRIMARY KEY,           -- the root cast
  version    TEXT NOT NULL,
  back       TEXT NOT NULL,              -- a reply siding with the cast
  challenge  TEXT NOT NULL,              -- a reply pushing back on it
  register   TEXT NOT NULL,              -- the model's read of the cast's voice, for auditing
  ts         INTEGER NOT NULL
) WITHOUT ROWID;
