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
 * Whether a cast is written in lowercase style: most of its sentence and line starts are
 * lowercase. ALL-CAPS emphasis ("REGULATE") doesn't count either way; "Lol network school ..."
 * (one start, capitalized) is not lowercase style.
 */
export const isLowercaseStyle = (cast: string): boolean => {
  const starts = cast.split(/(?:[.!?]+\s+|\n+)/).map(s => s.trim().match(/\p{L}/u)?.[0]).filter((c): c is string => c !== undefined)
  if (starts.length === 0) return false
  const lowerStarts = starts.filter(c => c === c.toLowerCase() && c !== c.toUpperCase()).length
  return lowerStarts * 2 > starts.length
}

/**
 * Brings a generated reply into a lowercase-style cast's casing. The suggest prompt asks for
 * this, but measured on live casts it was ignored for long, serious lowercase casts (a 57-word
 * all-lowercase tax rant got sentence-case replies), so casing is enforced here instead.
 * Kept as written: all-caps tokens of 2+ letters (AI, VVD), mixed case inside a word (DeFi,
 * McMahon, iPhone), and $tickers, @mentions, #tags and URLs. Everything else is lowercased,
 * "I" included, as people writing in lowercase do.
 */
export const matchCasing = (cast: string, reply: string): string => {
  if (!isLowercaseStyle(cast)) return reply
  return reply.replace(/\S+/g, tok => {
    if (/^[$@#]|^https?:\/\//i.test(tok)) return tok
    const letters = tok.replace(/[^\p{L}]/gu, '')
    if (letters.length >= 2 && letters === letters.toUpperCase()) return tok // acronym or emphasis
    if (/\p{Ll}\p{Lu}/u.test(letters)) return tok // DeFi, McMahon, iPhone
    return tok.toLowerCase()
  })
}
