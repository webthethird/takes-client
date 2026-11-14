-- Each member's own question embedding, so a market attracts questions close to ANY of its
-- casts, not only the one that founded it. (merge-2 measured the gap: "Is $BASED one of the
-- best projects?" sat at 0.652 from the founding question but 0.762 from a member.)
ALTER TABLE market_members ADD COLUMN embedding BLOB;
