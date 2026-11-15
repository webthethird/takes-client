-- The card's market, so the feed shows one card per market: a market's casts share one card,
-- led by its best-ranked cast. NULL: the cast is alone in its market (or in none).
ALTER TABLE scores ADD COLUMN market_id TEXT;
