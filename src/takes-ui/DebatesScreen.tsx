// The home screen: casts ranked by how debatable they are. Each card leads with the real cast,
// never an AI paraphrase; the derived question sits above it as the axis of disagreement.
// A real rebuttal from someone else is shown as evidence; only when there is none does the
// card invite either side, with an AI question for each, labelled as AI.

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { routes } from '@warpstack/app-core'
import { Cast } from '@warpstack/contract'
import { CastCard, ColorsOverride, Loading, Message, useColors } from '@warpstack/ui'
import { useRouter } from 'expo-router'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, FlatList, Linking, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, useColorScheme, View, type ScrollViewInstance } from 'react-native'
import { z } from 'zod'
import { apiUrl } from './api-url.ts'
import { collapseFor } from './collapse.ts'
import { CAST_BODY, opposite, schemeOf, SIDE_BORDER, SIDE_BORDER_WIDTH, SIDE_PALETTES, type Scheme, type Side } from './side-palette.ts'

const Item = z.object({
  cast: Cast,
  rebuttal: Cast.nullable(),
  question: z.string(),
  /** AI-written questions for each side, leaning its way; null until written (or declined). */
  backSuggestion: z.string().nullable(),
  challengeSuggestion: z.string().nullable(),
  authorStance: z.enum(['yes', 'no']),
  bothSides: z.boolean(),
  yesAuthors: z.number().int().nonnegative(),
  noAuthors: z.number().int().nonnegative(),
  band: z.number().int(),
  following: z.boolean(),
  resurfaced: z.boolean(),
  /** The cast's market when it has other takes: counts are on THIS card's question. */
  market: z.object({
    id: z.string(), takes: z.number().int(), yes: z.number().int().nonnegative(), no: z.number().int().nonnegative(),
    /** The market's other casts, loaded with the card (the first few), answers on this card's question. */
    others: z.array(z.object({ cast: Cast, answer: z.enum(['yes', 'no']) })),
  }).nullable(),
})
type Item = z.infer<typeof Item>
const MarketResponse = z.object({ items: z.array(z.object({ cast: Cast, answer: z.enum(['yes', 'no']) })) })
type Take = z.infer<typeof MarketResponse>['items'][number]

const fetchMarket = async (id: string, forHash: string): Promise<z.infer<typeof MarketResponse>> => {
  const q = new URLSearchParams({ id, for: forHash })
  const res = await fetch(`${apiUrl}/api/takes/market?${q}`, { headers: { accept: 'application/json' } })
  if (res.status === 429) throw new Error('Busy. Try again in a minute.')
  if (!res.ok) throw new Error(`The other takes did not load (${res.status}).`)
  return MarketResponse.parse(await res.json())
}
const SidesResponse = z.object({ items: z.array(z.object({ cast: Cast })) })
type SideName = 'back' | 'challenge'

/** The replies behind one side's count: one per person, strongest first. */
const fetchSides = async (hash: string, side: SideName): Promise<z.infer<typeof SidesResponse>> => {
  const q = new URLSearchParams({ hash, side })
  const res = await fetch(`${apiUrl}/api/takes/sides?${q}`, { headers: { accept: 'application/json' } })
  if (res.status === 429) throw new Error('Busy. Try again in a minute.')
  if (!res.ok) throw new Error(`The replies did not load (${res.status}).`)
  return SidesResponse.parse(await res.json())
}
const ViewerStatus = z.enum(['ready', 'personalizing', 'unknown', 'busy'])
const Feed = z.object({
  items: z.array(Item), next: z.string().nullable(),
  /** Whose follows shaped this page, and how far along that is; null without a viewer. */
  viewer: z.object({ fid: z.number(), username: z.string().nullable(), status: ViewerStatus }).nullable(),
})

/** "Viewing as": who the feed is for, remembered in this browser only (no account involved). */
const Viewer = z.object({ fid: z.number().int().positive(), username: z.string() })
type Viewer = z.infer<typeof Viewer>
const VIEWER_KEY = 'takes.viewer'
const loadViewer = (): Viewer | null => {
  if (Platform.OS !== 'web') return null
  try {
    const raw = globalThis.localStorage?.getItem(VIEWER_KEY)
    const parsed = raw ? Viewer.safeParse(JSON.parse(raw)) : null
    return parsed?.success ? parsed.data : null
  } catch {
    return null
  }
}
const saveViewer = (v: Viewer | null) => {
  if (Platform.OS !== 'web') return
  try {
    if (v) globalThis.localStorage?.setItem(VIEWER_KEY, JSON.stringify(v))
    else globalThis.localStorage?.removeItem(VIEWER_KEY)
  } catch { /* storage blocked: the choice lasts this visit only */ }
}

/** A username or FID to the account: { fid, username }. */
const lookupViewer = async (q: string): Promise<Viewer> => {
  const res = await fetch(`${apiUrl}/api/takes/viewer?${new URLSearchParams({ q })}`, { headers: { accept: 'application/json' } })
  const body = (await res.json().catch(() => null)) as { message?: unknown } | null
  if (!res.ok) throw new Error(typeof body?.message === 'string' ? body.message : `That didn't work (${res.status}).`)
  return Viewer.parse(body)
}

const Topics = z.object({ topics: z.array(z.object({ id: z.string(), name: z.string(), cards: z.number().int() })) })
type TopicTab = z.infer<typeof Topics>['topics'][number]

/** The topic tabs worth showing, busiest first (the server hides sparse ones). */
const fetchTopics = async (): Promise<TopicTab[]> => {
  const res = await fetch(`${apiUrl}/api/takes/topics`, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`The topics did not load (${res.status}).`)
  return Topics.parse(await res.json()).topics
}

/** `topic` null: "For you", the main feed. `fid`: whose follows shape it ("Viewing as"). */
const fetchFeed = async (topic: string | null, cursor: string | null, fid: number | null): Promise<z.infer<typeof Feed>> => {
  const q = new URLSearchParams({ ...(topic ? { topic } : {}), ...(cursor ? { cursor } : {}), ...(fid ? { fid: String(fid) } : {}) })
  const res = await fetch(`${apiUrl}/api/takes/feed?${q}`, { headers: { accept: 'application/json' } })
  if (res.status === 401) throw new Error('This server is private. Sign in on the phone app to see the feed.')
  // The server ends a page early rather than skip cards it couldn't read; retrying resumes there.
  if (res.status === 429) throw new Error('The feed is busy. Try again in a minute.')
  if (!res.ok) throw new Error(`The feed did not load (${res.status}).`)
  // Parsed at the boundary: a malformed card fails loudly instead of rendering half a cast.
  return Feed.parse(await res.json())
}

/** The system color scheme, as Warpstack's useColors reads it, for picking side palettes. */
const useScheme = (): Scheme => schemeOf(useColorScheme())
const useSidePalette = (side: Side) => SIDE_PALETTES[useScheme()][side]

const laneLabel = (i: Item) =>
  i.resurfaced ? 'Resurfaced · still unsettled' : i.following ? 'From someone you follow' : 'Across Farcaster'

/** People, not casts: distinct repliers on each side, relative to the cast; never the author. */
const sideCounts = (i: Item) => ({
  backing: i.authorStance === 'yes' ? i.yesAuthors : i.noAuthors,
  challenging: i.authorStance === 'yes' ? i.noAuthors : i.yesAuthors,
})

/**
 * One side's reply box. A pressable, not a text field: it replies to the cast (see useReply).
 */
const SideBox = ({ side, title, count, hint, aiHint, onPress }: {
  side: Side; title: string; count: string; hint: string; aiHint: boolean; onPress: () => void
}) => {
  const c = useSidePalette(side)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${count}. ${aiHint ? 'A question to think about, from AI: ' : ''}${hint}${IN_YOUR_CLIENT ? '. Opens the cast in your Farcaster client' : ''}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexGrow: 1, flexBasis: 150, borderColor: SIDE_BORDER, borderWidth: 1, borderRadius: 12,
        backgroundColor: pressed ? c.pressed : c.bg, paddingHorizontal: 12, paddingVertical: 10, gap: 4,
      })}>
      <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }}>{title}</Text>
      <Text style={{ color: c.muted, fontSize: 12 }}>{count}</Text>
      <Text style={{ color: c.muted, fontSize: 14, fontStyle: 'italic', marginTop: 2 }}>{hint}</Text>
      {aiHint && <Text style={{ color: c.muted, fontSize: 11 }}>A question to think about · from AI</Text>}
      {IN_YOUR_CLIENT && <Text style={{ color: c.text, fontSize: 12, marginTop: 4 }}>Reply in your Farcaster client ↗</Text>}
    </Pressable>
  )
}

/**
 * Every card ends in an invitation to either side, not a dead end and not only to dissent: two
 * equal reply boxes, side by side (stacked on narrow screens), whether or not anyone has replied. Each box carries an
 * AI-written question that leans toward its side, to start the reader thinking; never a reply
 * to paste, since people should argue in their own words. Labelled as AI and styled as
 * placeholder text, so it never reads as a real person's reply. Until the suggest stage has
 * run, each box asks a plain question of its own instead.
 */
/**
 * The web can't post (Warpstack's web is read-only), so there Back and Challenge hand off to the
 * visitor's own Farcaster client. forkcaster.xyz shows the cast with "Open in ..." for the clients
 * in its open registry (Farcaster, Quilcast, Terminus, Firefly and more) and remembers the
 * visitor's choice, so Takes keeps no client list of its own. The hash-only route redirects to
 * the cast's page under the author's current name.
 */
const IN_YOUR_CLIENT = Platform.OS === 'web'
const replyElsewhereUrl = (hash: string) => `https://forkcaster.xyz/~/conversations/${hash}`

/**
 * Replies to the card's cast: both sides argue with the cast itself. On the phone, Warpstack's
 * composer, which posts; on the web, the cast in the visitor's own client, in a new tab.
 */
const useReply = (item: Item) => {
  const router = useRouter()
  if (IN_YOUR_CLIENT) return () => { void Linking.openURL(replyElsewhereUrl(item.cast.hash)) }
  // router.push rather than <Link asChild>: Warpstack's ui notes a style array under asChild
  // reaches the DOM on the web and crashes the page.
  return () => router.push(routes.compose({ reply: { fid: item.cast.fid, hash: item.cast.hash } }))
}

const SidePrompt = ({ item, label }: { item: Item; label: boolean }) => {
  const c = useColors()
  const reply = useReply(item)
  const { backing, challenging } = sideCounts(item)
  const people = (n: number) => n === 0 ? 'No one yet · be the first' : `${n} ${n === 1 ? 'person' : 'people'} so far`
  return (
    <View style={{ gap: 8 }}>
      {label && <Text style={{ color: c.accent, fontSize: 13, fontWeight: '600' }}>⚑ Open debate · pick a side</Text>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {/* Each side shows an AI question leaning its way when one exists, labelled as AI. Until
            then both boxes ask a plain question of their own, with no AI label: stage 1's
            challenge_reason is a statement, not a question, so it isn't shown here. */}
        <SideBox
          side={item.authorStance}
          title="Back this take"
          count={people(backing)}
          hint={item.backSuggestion ?? 'What makes them right?'}
          aiHint={item.backSuggestion !== null}
          onPress={reply}
        />
        <SideBox
          side={opposite(item.authorStance)}
          title="Challenge it"
          count={people(challenging)}
          hint={item.challengeSuggestion ?? 'What would the other side say?'}
          aiHint={item.challengeSuggestion !== null}
          onPress={reply}
        />
      </View>
    </View>
  )
}

/**
 * A cast in its side's colors: the stock CastCard, rendered with that side's palette. The
 * card's own bottom hairline is tucked under the frame's border.
 */
const SideFrame = ({ side, children }: { side: Side; children: ReactNode }) => {
  const palette = useSidePalette(side)
  return (
    <ColorsOverride.Provider value={palette}>
      <View style={{
        marginHorizontal: 16, marginVertical: 8, borderRadius: 12, borderWidth: SIDE_BORDER_WIDTH[side], overflow: 'hidden',
        borderColor: SIDE_BORDER, backgroundColor: palette.bg,
      }}>
        <View style={{ marginBottom: -StyleSheet.hairlineWidth }}>{children}</View>
      </View>
    </ColorsOverride.Provider>
  )
}

const authorName = (cast: Item['cast']) => cast.author.displayName || cast.author.username || `fid:${cast.fid}`

/** "<author> says Yes": which answer to the card's question a cast argues, as a chip in that side's colors. */
const Says = ({ cast, stance }: { cast: Item['cast']; stance: Side }) => {
  const c = useColors()
  const side = useSidePalette(stance)
  const answer = stance === 'yes' ? 'Yes' : 'No'
  return (
    <View accessible accessibilityLabel={`${authorName(cast)} says ${answer}`}
      style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
      <Text style={{ color: c.muted, fontSize: 14 }}>
        <Text style={{ color: c.text, fontWeight: '600' }}>{authorName(cast)}</Text> says
      </Text>
      <View style={{
        backgroundColor: side.bg, borderColor: SIDE_BORDER, borderWidth: 1, borderRadius: 999,
        paddingHorizontal: 10, paddingVertical: 2,
      }}>
        <Text style={{ color: side.text, fontSize: 13, fontWeight: '700' }}>{answer}</Text>
      </View>
    </View>
  )
}

/**
 * Another cast on the card's question: who said what, then the cast in its side's colors.
 * `replyTo`: the card's cast, when this one replies to it, so it skips "Replying to a cast".
 */
const OtherTake = ({ take, replyTo }: { take: Take; replyTo?: string }) => {
  const scheme = useScheme()
  return (
    <View style={{ gap: 2 }}>
      <Says cast={take.cast} stance={take.answer} />
      <View style={{ marginHorizontal: -16 }}>
        <SideFrame side={take.answer}>
          <CastCard cast={take.cast} threadRoot={replyTo} collapse={collapseFor(take.cast.text, take.answer, scheme)} textColor={CAST_BODY[scheme][take.answer]} />
        </SideFrame>
      </View>
    </View>
  )
}

/**
 * The market's other casts, under the card's own: one card per market, so everyone arguing the
 * question is seen together. The first few come with the card; a market with more shows the rest
 * on "Show more". The heading counts every take, the card's own included.
 */
const MarketTakes = ({ item, market }: { item: Item; market: NonNullable<Item['market']> }) => {
  const c = useColors()
  const [more, setMore] = useState(false)
  const rest = useQuery({
    queryKey: ['takes', 'market', market.id, item.cast.hash],
    queryFn: () => fetchMarket(market.id, item.cast.hash),
    enabled: more,
    staleTime: 60_000,
  })
  const shown = new Set(market.others.map(o => o.cast.hash))
  const hidden = market.takes - 1 - market.others.length
  return (
    <View style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={{ color: c.accent, fontSize: 13, fontWeight: '600' }}>
        {market.takes} takes on this question · {market.yes} Yes · {market.no} No
      </Text>
      {market.others.map(o => <OtherTake key={o.cast.hash} take={o} />)}
      {more && (rest.isPending ? <ActivityIndicator color={c.muted} style={{ alignSelf: 'flex-start' }} />
        : rest.isError ? <Text style={{ color: c.muted, fontSize: 13 }}>{rest.error.message}</Text>
        : rest.data.items.filter(o => !shown.has(o.cast.hash)).map(o => <OtherTake key={o.cast.hash} take={o} />))}
      {hidden > 0 && !more && (
        <Pressable accessibilityRole="button" onPress={() => setMore(true)} hitSlop={6}
          style={{ alignSelf: 'flex-start', borderRadius: 999, borderWidth: 1, borderColor: c.accent, paddingHorizontal: 14, paddingVertical: 6 }}>
          <Text style={{ color: c.accent, fontSize: 14, fontWeight: '600' }}>Show {hidden} more</Text>
        </Pressable>
      )}
    </View>
  )
}

/**
 * "2 more challenges ›", "1 person backs it ›": opens the replies behind a side's count, one
 * per person, under the card. Loaded only when opened. `skip` is a reply the card already
 * shows (the rebuttal), left out of the list and the label.
 */
const SideList = ({ item, side, count, skip }: { item: Item; side: SideName; count: number; skip: string | null }) => {
  const c = useColors()
  const [open, setOpen] = useState(false)
  const replies = useQuery({
    queryKey: ['takes', 'sides', item.cast.hash, side],
    queryFn: () => fetchSides(item.cast.hash, side),
    enabled: open,
    staleTime: 60_000,
  })
  const rest = skip ? count - 1 : count
  if (rest <= 0) return null
  const answer = side === 'back' ? item.authorStance : opposite(item.authorStance)
  const label = side === 'challenge'
    ? `${rest}${skip ? ' more' : ''} ${rest === 1 ? 'challenge' : 'challenges'}`
    : `${rest} ${rest === 1 ? 'person backs' : 'people back'} it`
  return (
    <View style={{ gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} hitSlop={6}
        style={{ alignSelf: 'flex-start', paddingVertical: 4 }}>
        <Text style={{ color: c.accent, fontSize: 14, fontWeight: '600' }}>{open ? `Hide ${side === 'challenge' ? 'challenges' : 'backers'}` : `${label} ›`}</Text>
      </Pressable>
      {open && (replies.isPending ? <ActivityIndicator color={c.muted} style={{ alignSelf: 'flex-start' }} />
        : replies.isError ? <Text style={{ color: c.muted, fontSize: 13 }}>{replies.error.message}</Text>
        : replies.data.items.filter(r => r.cast.hash !== skip).map(r => <OtherTake key={r.cast.hash} take={{ cast: r.cast, answer }} replyTo={item.cast.hash} />))}
    </View>
  )
}

/**
 * What Takes is, for someone who has never seen it. Above the first card rather than in the
 * sticky bar, so it scrolls away. Worded for both platforms: the boxes say where a reply goes.
 */
const Intro = () => {
  const c = useColors()
  return (
    <Text style={{ color: c.muted, fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 }}>
      The debates happening on Farcaster right now. Each card is one take, with the replies backing and challenging it. Reply to pick a side.
    </Text>
  )
}

const DebateCard = ({ item }: { item: Item }) => {
  const c = useColors()
  const scheme = useScheme()
  return (
    <View style={{ borderBottomColor: c.border, borderBottomWidth: 1, paddingTop: 12, paddingBottom: 8 }}>
      <View style={{ paddingHorizontal: 16, gap: 4 }}>
        <Text style={{ color: c.muted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {laneLabel(item)}
        </Text>
        <Text style={{ color: c.text, fontSize: 17, fontWeight: '700' }}>{item.question}</Text>
        <Says cast={item.cast} stance={item.authorStance} />
      </View>
      <SideFrame side={item.authorStance}><CastCard cast={item.cast} collapse={collapseFor(item.cast.text, item.authorStance, scheme)} textColor={CAST_BODY[scheme][item.authorStance]} /></SideFrame>
      <View style={{ paddingHorizontal: 16, gap: 6 }}>
        {/* Directly under the cast: the market's other casts, always shown. Their heading
            stands in for the "Open debate" label, which a card in a market doesn't need. */}
        {item.market && <MarketTakes item={item} market={item.market} />}
        {item.rebuttal && (
          <>
            <Text style={{ color: c.accent, fontSize: 13, fontWeight: '600' }}>Someone already disagrees</Text>
            <View style={{ marginHorizontal: -16 }}>
              <SideFrame side={opposite(item.authorStance)}><CastCard cast={item.rebuttal} threadRoot={item.cast.hash} collapse={collapseFor(item.rebuttal.text, opposite(item.authorStance), scheme)} textColor={CAST_BODY[scheme][opposite(item.authorStance)]} /></SideFrame>
            </View>
          </>
        )}
        <SideList item={item} side="challenge" count={sideCounts(item).challenging} skip={item.rebuttal?.hash ?? null} />
        <SideList item={item} side="back" count={sideCounts(item).backing} skip={null} />
        {/* Every card ends the same way: the people already arguing, then a box for each side.
            "Open debate" only where nothing above says the debate is already on. */}
        <SidePrompt item={item} label={!item.rebuttal && !item.market} />
      </View>
    </View>
  )
}

/** Pages after the first: a spinner while loading, a retry after a failure, nothing at the end. */
const Footer = ({ loading, error, retry }: { loading: boolean; error: Error | null; retry: () => void }) => {
  const c = useColors()
  if (loading) return <View style={{ padding: 16 }}><ActivityIndicator color={c.muted} /></View>
  if (!error) return null
  return (
    <Pressable accessibilityRole="button" onPress={retry} style={{ padding: 16, alignItems: 'center' }}>
      <Text style={{ color: c.muted, fontSize: 14 }}>{error.message} Tap to retry.</Text>
    </Pressable>
  )
}

/**
 * Tabs above the feed: "For you", then the topics, busiest first, in one row that scrolls
 * sideways (up to 18 tabs). The row runs to the screen's edge, so a cut-off tab shows there's
 * more, and an arrow at each end appears while there's more that way: on the web a mouse can't
 * easily scroll sideways, so the arrows are also how you get there. Stuck to the top of the
 * list, so it has a solid background. If the topics don't load, "For you" is still there.
 */
const TopicBar = ({ value, onChange }: { value: string | null; onChange: (t: string | null) => void }) => {
  const c = useColors()
  const topics = useQuery({ queryKey: ['takes', 'topics'], queryFn: fetchTopics, staleTime: 60_000 })
  const scroller = useRef<ScrollViewInstance>(null)
  const [at, setAt] = useState({ x: 0, width: 0, content: 0 })
  const tabs: Array<{ id: string | null; label: string }> = [
    { id: null, label: 'For you' },
    ...(topics.data ?? []).map(t => ({ id: t.id, label: t.name })),
  ]
  // A tab picked earlier stays, even after it drops below the bar for showing.
  if (value !== null && !tabs.some(t => t.id === value)) tabs.push({ id: value, label: value })
  const moreLeft = at.x > 4
  const moreRight = at.x + at.width < at.content - 4
  const page = (dir: 1 | -1) => scroller.current?.scrollTo({ x: Math.max(0, at.x + dir * at.width * 0.7), animated: true })
  const arrow = (dir: 1 | -1) => (
    <Pressable accessibilityRole="button" accessibilityLabel={dir === 1 ? 'More topics' : 'Previous topics'} onPress={() => page(dir)}
      style={({ pressed }) => ({
        position: 'absolute', top: 0, bottom: 0, [dir === 1 ? 'right' : 'left']: 0, width: 40,
        alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? c.pressed : c.bg,
        [dir === 1 ? 'borderLeftWidth' : 'borderRightWidth']: 1, borderColor: c.border,
      })}>
      <Text style={{ color: c.text, fontSize: 22, fontWeight: '600', lineHeight: 24 }}>{dir === 1 ? '›' : '‹'}</Text>
    </Pressable>
  )
  return (
    <View style={{ backgroundColor: c.bg }}>
      <ScrollView ref={scroller} horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist"
        // flexGrow 0: without it a horizontal ScrollView fills the height of its column (seen
        // while the feed loads: every tab stretched down the page).
        style={{ flexGrow: 0 }} contentContainerStyle={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10 }}
        scrollEventThrottle={32}
        onScroll={e => { const x = e.nativeEvent.contentOffset.x; setAt(a => ({ ...a, x })) }}
        onLayout={e => { const width = e.nativeEvent.layout.width; setAt(a => ({ ...a, width })) }}
        onContentSizeChange={content => setAt(a => ({ ...a, content }))}>
        {tabs.map(t => {
          const on = t.id === value
          return (
            <Pressable key={t.id ?? ''} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onChange(t.id)}
              style={{ borderRadius: 999, borderWidth: 1, borderColor: on ? c.accent : c.border, backgroundColor: on ? c.accent : 'transparent', paddingHorizontal: 14, paddingVertical: 6 }}>
              <Text style={{ color: on ? c.accentText : c.text, fontSize: 14, fontWeight: '600' }}>{t.label}</Text>
            </Pressable>
          )
        })}
      </ScrollView>
      {moreLeft && arrow(-1)}
      {moreRight && arrow(1)}
    </View>
  )
}

const STATUS_NOTE: Record<z.infer<typeof ViewerStatus>, string | null> = {
  ready: null,
  personalizing: 'Still scoring some casts from people you follow.',
  busy: 'Too many new viewers right now. Showing debates from across Farcaster; try again in a few minutes.',
  unknown: 'No Farcaster account has that FID.',
}

/**
 * "Viewing as": a username or FID whose follows shape "For you". Not a sign-in: follow lists
 * are public, and anyone can view as anyone. Without one, the feed has no following lane.
 */
const ViewerBar = ({ viewer, status, onChange }: {
  viewer: Viewer | null; status: z.infer<typeof ViewerStatus> | null; onChange: (v: Viewer | null) => void
}) => {
  const c = useColors()
  const [editing, setEditing] = useState(viewer === null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      onChange(await lookupViewer(text))
      setEditing(false)
      setText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const note = status ? STATUS_NOTE[status] : null
  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 10, gap: 6, backgroundColor: c.bg }}>
      {viewer && !editing ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <Text style={{ color: c.muted, fontSize: 14 }}>
            Viewing as <Text style={{ color: c.text, fontWeight: '600' }}>@{viewer.username}</Text>
          </Text>
          <Pressable accessibilityRole="button" onPress={() => setEditing(true)} hitSlop={6}>
            <Text style={{ color: c.accent, fontSize: 14, fontWeight: '600' }}>Change</Text>
          </Pressable>
        </View>
      ) : (
        <View style={{ gap: 6 }}>
          <Text style={{ color: c.muted, fontSize: 14 }}>See debates from people you follow on Farcaster:</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TextInput value={text} onChangeText={setText} onSubmitEditing={() => void submit()} placeholder="@username or FID"
              placeholderTextColor={c.muted} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Farcaster username or FID"
              style={{ flex: 1, maxWidth: 320, color: c.text, borderColor: c.border, borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, fontSize: 14 }} />
            <Pressable accessibilityRole="button" onPress={() => void submit()} disabled={busy}
              style={{ borderRadius: 999, backgroundColor: c.accent, paddingHorizontal: 14, paddingVertical: 7, opacity: busy ? 0.6 : 1 }}>
              <Text style={{ color: c.accentText, fontSize: 14, fontWeight: '600' }}>{busy ? 'Looking…' : 'Go'}</Text>
            </Pressable>
            {viewer && (
              <Pressable accessibilityRole="button" onPress={() => { setEditing(false); setError(null) }} hitSlop={6}>
                <Text style={{ color: c.muted, fontSize: 14 }}>Cancel</Text>
              </Pressable>
            )}
            {viewer && (
              <Pressable accessibilityRole="button" onPress={() => { onChange(null); setError(null) }} hitSlop={6}>
                <Text style={{ color: c.muted, fontSize: 14 }}>Stop</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
      {error && <Text style={{ color: c.danger ?? c.text, fontSize: 13 }}>{error}</Text>}
      {note && !editing && <Text style={{ color: c.muted, fontSize: 13 }}>{note}</Text>}
    </View>
  )
}

const INTRO = 'intro' as const

export const DebatesScreen = () => {
  const c = useColors()
  const [topic, setTopic] = useState<string | null>(null)
  const [viewer, setViewerState] = useState<Viewer | null>(loadViewer)
  const setViewer = (v: Viewer | null) => { saveViewer(v); setViewerState(v) }
  const fid = viewer?.fid ?? null
  const feed = useInfiniteQuery({
    queryKey: ['takes', 'feed', topic, fid],
    queryFn: ({ pageParam }) => fetchFeed(topic, pageParam, fid),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.next,
    staleTime: 30_000,
  })
  // The ranking is live, so a card can move across a page boundary between requests and come
  // back on a later page: drop repeats, keeping each card where it was first shown.
  const items = useMemo(() => {
    const seen = new Set<string>()
    return (feed.data?.pages ?? []).flatMap(p => p.items).filter(i => !seen.has(i.cast.hash) && (seen.add(i.cast.hash), true))
  }, [feed.data])
  const status = feed.data?.pages[0]?.viewer?.status ?? null
  const bar = (
    <View style={{ backgroundColor: c.bg }}>
      <TopicBar value={topic} onChange={setTopic} />
      {topic === null && <ViewerBar viewer={viewer} status={status} onChange={setViewer} />}
    </View>
  )
  if (feed.isPending) return <View style={{ flex: 1 }}>{bar}<Loading /></View>
  if (feed.isError && items.length === 0) return <View style={{ flex: 1 }}>{bar}<Message tone="danger">{feed.error.message}</Message></View>
  const more = () => { if (feed.hasNextPage && !feed.isFetchingNextPage && !feed.isFetchNextPageError) void feed.fetchNextPage() }
  return (
    <FlatList<Item | typeof INTRO>
      // The intro is the list's first row, not part of its header: the header sticks.
      data={items.length > 0 ? [INTRO, ...items] : []}
      keyExtractor={i => i === INTRO ? 'intro' : i.cast.hash}
      renderItem={({ item }) => item === INTRO ? <Intro /> : <DebateCard item={item} />}
      onEndReached={more}
      onEndReachedThreshold={0.6}
      ListFooterComponent={
        <Footer
          loading={feed.isFetchingNextPage}
          error={feed.isFetchNextPageError ? feed.error : null}
          retry={() => void feed.fetchNextPage()}
        />
      }
      refreshControl={
        <RefreshControl refreshing={feed.isRefetching && !feed.isFetchingNextPage} onRefresh={() => void feed.refetch()} tintColor={c.muted} />
      }
      ListHeaderComponent={bar}
      stickyHeaderIndices={[0]}
      ListEmptyComponent={topic !== null
        ? <Message>No debates in this topic right now.</Message>
        : <Message>Nothing debatable yet. Takes classifies new casts every minute; check back shortly.</Message>}
    />
  )
}
