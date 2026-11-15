// The topic tabs. Seeded Nov 15, 2026 from clustering every market's question embedding
// (scripts/seed-topics.mts, cut 0.75, clusters of 10+), reviewed and edited by hand: four
// merges, one phrasing-only cluster dropped to Other, and four small subjects the clustering
// couldn't reach added directly (Sports, Music, Travel & Places, Work & Relationships).
//
// An id is permanent: tabs, links and anything stored against a topic use it. Rename by
// changing `name`; retire a topic by merging it (a later change), never by reusing its id.
// `description` is what Claude files a market against, so a change to one is a change to the
// classifier: bump TOPIC_VERSION and re-run scripts/eval-topics.mts.

export const TOPIC_VERSION = 'topics-1'

export type Topic = { id: string; name: string; description: string }

export const TOPICS: readonly Topic[] = [
  { id: 'farcaster', name: 'Farcaster', description: "Farcaster itself: its future, health and ownership, its clients (Warpcast, Quilcast, Terminus and others), mini apps, the protocol and the community's direction." },
  { id: 'crypto', name: 'Crypto', description: 'Crypto tokens, airdrops, Base and other chains, DeFi, wallets, onchain payments, DAOs and market moves.' },
  { id: 'ai', name: 'AI', description: "AI's impact on work, software and creativity; AI models and coding tools (Claude, Codex, vibecoding); AI safety and consciousness." },
  { id: 'food-drink', name: 'Food & Drink', description: 'Whether specific foods, dishes, snacks, drinks or restaurants are good, tasty or worth it.' },
  { id: 'feeds-platforms', name: 'Feeds & Platforms', description: 'Social platform design in general: feeds, algorithms, moderation tools, platform features and online community norms.' },
  { id: 'politics', name: 'Politics', description: 'Elections, parties, government policy and political figures (Trump, Musk, Democrats), mainly US but any country.' },
  { id: 'life-ideas', name: 'Life & Ideas', description: 'Personal growth and how to live (discipline, purpose, gratitude, character), and philosophical questions about meaning, freedom and human nature. Not specific situations at work or with people.' },
  { id: 'bans-free-speech', name: 'Bans & Free Speech', description: 'Bans, deplatforming, moderation fairness and free speech, including the Network State / Balaji takeover of Farcaster and the bans around it.' },
  { id: 'tv-movies', name: 'TV & Movies', description: 'Whether shows, films, reality TV or entertainers are good, funny or worth watching.' },
  { id: 'security-hacks', name: 'Security & Hacks', description: 'Hacks, exploits, cyberattacks, self-custody and key safety, and security practices.' },
  { id: 'startups-vc', name: 'Startups & VC', description: 'Founders, venture capital, startup strategy, fundraising and tech business culture.' },
  { id: 'big-tech', name: 'Big Tech', description: 'Big Tech companies and their products (Apple, Google, Microsoft, browsers, devices) and everyday tech habits.' },
  { id: 'art', name: 'Art', description: 'Artists, artworks, art mediums and the meaning of art.' },
  { id: 'sports', name: 'Sports', description: 'Sports and athletes: matches, players, teams, races, leagues and fitness competitions.' },
  { id: 'music', name: 'Music', description: 'Musicians, bands, songs, albums, genres and music culture.' },
  { id: 'travel-places', name: 'Travel & Places', description: 'Travel destinations, cities and countries as places to visit or live, cost of living, and local sights.' },
  { id: 'work-relationships', name: 'Work & Relationships', description: 'Specific situations with coworkers, bosses, partners, family and friends: workplace conduct, etiquette and relationship dilemmas.' },
]

const IDS = new Set(TOPICS.map(t => t.id))
export const isTopicId = (s: string): boolean => IDS.has(s)

/** A market's filing as stored: its main topic ('other' when none fits) and an optional second. */
export type StoredTopics = { primary: string; secondary: string | null }
/** A card's topic columns: null where it has none. */
export type CardTopics = { a: string | null; b: string | null }

/**
 * The model's answer as stored. A second topic is dropped when it repeats the first, is "none",
 * or comes without a first (a market in Other is in no tab at all); an id that isn't a topic
 * (the schema allows none, but a prompt and TOPICS out of step could) is treated as no topic.
 */
export const fromAssignment = (a: { primary: string; secondary: string }): StoredTopics => {
  const primary = isTopicId(a.primary) ? a.primary : 'other'
  const secondary = primary !== 'other' && isTopicId(a.secondary) && a.secondary !== primary ? a.secondary : null
  return { primary, secondary }
}

export const cardTopics = (t: StoredTopics | undefined): CardTopics =>
  !t || t.primary === 'other' ? { a: null, b: null } : { a: t.primary, b: t.secondary }

/** A tab is shown once it has this many cards: fewer reads as a broken page, not a topic. */
export const MIN_TAB_CARDS = 5

/** The tabs to show: topics with enough cards, busiest first; ties in TOPICS order. */
export const tabsFrom = (cards: ReadonlyMap<string, number>): Array<Topic & { cards: number }> =>
  TOPICS.map((t, i) => ({ ...t, cards: cards.get(t.id) ?? 0, i }))
    .filter(t => t.cards >= MIN_TAB_CARDS)
    .sort((a, b) => b.cards - a.cards || a.i - b.i)
    .map(({ i: _, ...t }) => t)
