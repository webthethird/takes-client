-- How many casts argue the card's claim (its market's size, 1 when alone). Scoring credits a
-- cast for other takes on its claim, and an older cast whose claim is still being argued in
-- other casts resurfaces at a lower bar than one alone (MARKET_RESURFACE_MIN_BAND).
ALTER TABLE scores ADD COLUMN market_takes INTEGER NOT NULL DEFAULT 1;
