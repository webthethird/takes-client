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

/**
 * Whether a link embed is an image, by URL: Farcaster's image host (imagedelivery.net), imgur,
 * or an image file extension. Not fetched; a URL that only looks like an image fails the model
 * call, which retries without images (adapters/claude.ts).
 */
export const isImageUrl = (u: string): boolean =>
  /^https:\/\/(imagedelivery\.net|i\.imgur\.com)\//.test(u) || /^https?:\/\/[^?#]+\.(jpe?g|png|gif|webp)([?#]|$)/i.test(u)

/** A cast's link embeds split into images (sent to the model as images) and other links. */
export const splitEmbeds = (urls: readonly string[]): { images: string[]; links: string[] } =>
  ({ images: urls.filter(isImageUrl), links: urls.filter(u => !isImageUrl(u)) })

export const parseMentions = (json: string): Mention[] => {
  let list: unknown
  try { list = JSON.parse(json) } catch { return [] }
  if (!Array.isArray(list)) return []
  return list.filter((m): m is Mention =>
    typeof m?.fid === 'number' && typeof m?.position === 'number' && m.position >= 0)
}
