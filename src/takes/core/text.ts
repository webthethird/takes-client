// What the classifier reads. Farcaster stores @mentions outside the text, as FIDs at byte
// positions, and the cast index keeps them that way; sent as-is, "@terminusapp doesn't get
// enough flowers" reaches Claude as " doesn't get enough flowers", and it rightly finds no
// subject. Positions are UTF-8 byte offsets, not string indices.

export type Mention = { fid: number; position: number }

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The text with each mention restored as @username, or @fid:N when the name is unknown. */
export const renderMentions = (text: string, mentions: readonly Mention[], names: ReadonlyMap<number, string>): string => {
  if (mentions.length === 0) return text
  const bytes = encoder.encode(text)
  // Stable sort by position: several mentions at one position keep their protocol order.
  const sorted = mentions.map((m, i) => ({ ...m, i })).sort((a, b) => a.position - b.position || a.i - b.i)
  const parts: string[] = []
  let at = 0
  for (const m of sorted) {
    const pos = Math.min(Math.max(m.position, at), bytes.length)
    parts.push(decoder.decode(bytes.subarray(at, pos)), `@${names.get(m.fid) ?? `fid:${m.fid}`}`)
    at = pos
  }
  parts.push(decoder.decode(bytes.subarray(at)))
  return parts.join('')
}

export type Embed = { kind: 'url'; url: string } | { kind: 'cast'; cast: { fid: number; hash: string } }

/** Parses the index's embeds column; unknown shapes are ignored rather than trusted. */
export const parseEmbeds = (json: string): { urls: string[]; quoted: { fid: number; hash: string } | null } => {
  const urls: string[] = []
  let quoted: { fid: number; hash: string } | null = null
  let list: unknown
  try { list = JSON.parse(json) } catch { return { urls, quoted } }
  if (!Array.isArray(list)) return { urls, quoted }
  for (const e of list as Array<Partial<Embed>>) {
    if (e?.kind === 'url' && typeof e.url === 'string') urls.push(e.url)
    else if (e?.kind === 'cast' && e.cast && typeof e.cast.hash === 'string' && typeof e.cast.fid === 'number') quoted ??= e.cast
  }
  return { urls, quoted }
}

export const parseMentions = (json: string): Mention[] => {
  let list: unknown
  try { list = JSON.parse(json) } catch { return [] }
  if (!Array.isArray(list)) return []
  return list.filter((m): m is Mention =>
    typeof m?.fid === 'number' && typeof m?.position === 'number' && m.position >= 0)
}

/**
 * How a cast cases the start of its sentences and lines: 'lower' when most starts are
 * lowercase, 'sentence' when most are capitalized, null when it has no letters to judge by.
 * Only the first letter of each start counts, so ALL-CAPS emphasis ("REGULATE") in the middle
 * of a lowercase cast doesn't change its style.
 */
export const castCasing = (cast: string): 'lower' | 'sentence' | null => {
  const starts = cast.split(/(?:[.!?]+\s+|\n+)/).map(s => s.trim().match(/\p{L}/u)?.[0]).filter((c): c is string => c !== undefined)
  if (starts.length === 0) return null
  const lowerStarts = starts.filter(c => c === c.toLowerCase() && c !== c.toUpperCase()).length
  return lowerStarts * 2 > starts.length ? 'lower' : 'sentence'
}

export const isLowercaseStyle = (cast: string): boolean => castCasing(cast) === 'lower'

/**
 * Brings a generated reply into the cast's casing. The suggest prompt asks for this, but on
 * live casts it was ignored in both directions: long lowercase casts got sentence-case replies
 * (a 57-word lowercase tax rant), and sentence-case casts got lowercase ones (a Navarro cast).
 * So casing is enforced here.
 *
 * 'lower': everything lowercased, "I" included, as people writing in lowercase do. Kept as
 * written: all-caps tokens of 2+ letters (AI, VVD), inner capitals (DeFi, McMahon, iPhone), and
 * $tickers, @mentions, #tags and URLs.
 * 'sentence': each sentence's first letter capitalized; nothing else is touched (a proper
 * noun the model lowercased mid-sentence stays as it is).
 */
export const matchCasing = (cast: string, reply: string): string => {
  const style = castCasing(cast)
  if (style === 'sentence') {
    return reply.replace(/(^|[.!?]\s+)(\p{Ll})/gu, (_, pre: string, c: string) => pre + c.toUpperCase())
  }
  if (style !== 'lower') return reply
  return reply.replace(/\S+/g, tok => {
    if (/^[$@#]|^https?:\/\//i.test(tok)) return tok
    const letters = tok.replace(/[^\p{L}]/gu, '')
    if (letters.length >= 2 && letters === letters.toUpperCase()) return tok // acronym or emphasis
    if (/\p{Ll}\p{Lu}/u.test(letters)) return tok // DeFi, McMahon, iPhone
    return tok.toLowerCase()
  })
}
