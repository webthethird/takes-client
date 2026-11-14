// The home screen: casts ranked by how debatable they are. Each card leads with the real cast,
// never an AI paraphrase; the derived question sits above it as the axis of disagreement.
// A real rebuttal from someone else is shown as evidence; only when there is none does the
// card fall back to the classifier's challenge_reason, labelled as an AI hypothesis.

import { useInfiniteQuery } from '@tanstack/react-query'
import { routes } from '@warpstack/app-core'
import { Cast } from '@warpstack/contract'
import { CastCard, ColorsOverride, Loading, Message, useColors } from '@warpstack/ui'
import { useRouter } from 'expo-router'
import { useMemo, type ReactNode } from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { z } from 'zod'
import { apiUrl } from './api-url.ts'
import { collapseFor } from './collapse.ts'
import { opposite, SIDE_PALETTES, type Side } from './side-palette.ts'

const Item = z.object({
  cast: Cast,
  rebuttal: Cast.nullable(),
  question: z.string(),
  challengeReason: z.string(),
  /** AI-written replies for each side, in the cast's voice; null until written (or declined). */
  backSuggestion: z.string().nullable(),
  challengeSuggestion: z.string().nullable(),
  authorStance: z.enum(['yes', 'no']),
  bothSides: z.boolean(),
  yesAuthors: z.number().int().nonnegative(),
  noAuthors: z.number().int().nonnegative(),
  band: z.number().int(),
  following: z.boolean(),
  resurfaced: z.boolean(),
})
type Item = z.infer<typeof Item>
const Feed = z.object({ items: z.array(Item), next: z.string().nullable(), viewerFid: z.number().nullable() })

const fetchFeed = async (cursor: string | null): Promise<z.infer<typeof Feed>> => {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  const res = await fetch(`${apiUrl}/api/takes/feed${q}`, { headers: { accept: 'application/json' } })
  if (res.status === 401) throw new Error('This server is private. Sign in on the phone app to see the feed.')
  if (!res.ok) throw new Error(`The feed did not load (${res.status}).`)
  // Parsed at the boundary: a malformed card fails loudly instead of rendering half a cast.
  return Feed.parse(await res.json())
}

const laneLabel = (i: Item) =>
  i.resurfaced ? 'Resurfaced · still unsettled' : i.following ? 'From someone you follow' : 'Across Farcaster'

/** People, not casts: these count distinct authors whose replies took a side. */
const sides = (i: Item) => {
  const backing = i.authorStance === 'yes' ? i.yesAuthors : i.noAuthors
  const challenging = i.authorStance === 'yes' ? i.noAuthors : i.yesAuthors
  return `${backing} backing · ${challenging} challenging`
}

/**
 * One side's reply box. A pressable, not a text field: it opens the stock composer as a reply
 * to the cast (which posts from the phone; the web composer opens but is read-only).
 */
const SideBox = ({ side, title, count, hint, aiHint, onPress }: {
  side: Side; title: string; count: string; hint: string; aiHint: boolean; onPress: () => void
}) => {
  const c = SIDE_PALETTES[side]
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${count}. ${aiHint ? 'AI-suggested angle: ' : ''}${hint}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexGrow: 1, flexBasis: 150, borderColor: SIDE_PALETTES.no.border, borderWidth: 1, borderRadius: 12,
        backgroundColor: pressed ? c.pressed : c.bg, paddingHorizontal: 12, paddingVertical: 10, gap: 4,
      })}>
      <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }}>{title}</Text>
      <Text style={{ color: c.muted, fontSize: 12 }}>{count}</Text>
      <Text style={{ color: c.muted, fontSize: 14, fontStyle: 'italic', marginTop: 2 }}>{hint}</Text>
      {aiHint && <Text style={{ color: c.muted, fontSize: 11 }}>Suggested by AI · not a real reply</Text>}
    </Pressable>
  )
}

/**
 * An unchallenged card ends in an invitation to either side, not a dead end and not only to
 * dissent: two equal reply boxes, side by side (stacked on narrow screens). The challenge box
 * carries the classifier's AI-written challenge_reason, labelled as such and styled as
 * placeholder text, so it never reads as a real person's reply (classifier README, "Real
 * disagreement outranks hypothesised disagreement"). The suggest stage writes one reply per
 * side in the cast's own voice; until it has, the back box asks and the challenge box shows
 * stage 1's challenge_reason.
 */
const SidePrompt = ({ item }: { item: Item }) => {
  const c = useColors()
  const router = useRouter()
  const backing = item.authorStance === 'yes' ? item.yesAuthors : item.noAuthors
  // router.push rather than <Link asChild>: Warpstack's ui notes a style array under asChild
  // reaches the DOM on the web and crashes the page.
  const reply = () => router.push(routes.compose({ reply: { fid: item.cast.fid, hash: item.cast.hash } }))
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: c.accent, fontSize: 13, fontWeight: '600' }}>⚑ Open debate · pick a side</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {/* Each side shows an AI reply in the cast's own voice when one exists. Until then the
            back box asks and the challenge box falls back to stage 1's challenge_reason. */}
        <SideBox
          side={item.authorStance}
          title="Back this take"
          count={`${backing} ${backing === 1 ? 'person' : 'people'} so far`}
          hint={item.backSuggestion ? `e.g. “${item.backSuggestion}”` : 'What makes them right?'}
          aiHint={item.backSuggestion !== null}
          onPress={reply}
        />
        <SideBox
          side={opposite(item.authorStance)}
          title="Challenge it"
          count="No one yet · be the first"
          hint={`e.g. “${item.challengeSuggestion ?? item.challengeReason}”`}
          aiHint
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
const SideFrame = ({ side, children }: { side: Side; children: ReactNode }) => (
  <ColorsOverride.Provider value={SIDE_PALETTES[side]}>
    <View style={{
      marginHorizontal: 16, marginVertical: 8, borderRadius: 12, borderWidth: 1, overflow: 'hidden',
      borderColor: SIDE_PALETTES.no.border, backgroundColor: SIDE_PALETTES[side].bg,
    }}>
      <View style={{ marginBottom: -StyleSheet.hairlineWidth }}>{children}</View>
    </View>
  </ColorsOverride.Provider>
)

const authorName = (cast: Item['cast']) => cast.author.displayName || cast.author.username || `fid:${cast.fid}`

/** "<author> says Yes": which answer to the question the cast argues, as a chip in that side's colors. */
const AuthorSide = ({ item }: { item: Item }) => {
  const c = useColors()
  const side = SIDE_PALETTES[item.authorStance]
  const answer = item.authorStance === 'yes' ? 'Yes' : 'No'
  return (
    <View accessible accessibilityLabel={`${authorName(item.cast)} says ${answer}`}
      style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
      <Text style={{ color: c.muted, fontSize: 14 }}>
        <Text style={{ color: c.text, fontWeight: '600' }}>{authorName(item.cast)}</Text> says
      </Text>
      <View style={{
        backgroundColor: side.bg, borderColor: SIDE_PALETTES.no.border, borderWidth: 1, borderRadius: 999,
        paddingHorizontal: 10, paddingVertical: 2,
      }}>
        <Text style={{ color: side.text, fontSize: 13, fontWeight: '700' }}>{answer}</Text>
      </View>
    </View>
  )
}

const DebateCard = ({ item }: { item: Item }) => {
  const c = useColors()
  return (
    <View style={{ borderBottomColor: c.border, borderBottomWidth: 1, paddingTop: 12, paddingBottom: 8 }}>
      <View style={{ paddingHorizontal: 16, gap: 4 }}>
        <Text style={{ color: c.muted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {laneLabel(item)}
        </Text>
        <Text style={{ color: c.text, fontSize: 17, fontWeight: '700' }}>{item.question}</Text>
        <AuthorSide item={item} />
      </View>
      <SideFrame side={item.authorStance}><CastCard cast={item.cast} collapse={collapseFor(item.cast.text, item.authorStance)} /></SideFrame>
      <View style={{ paddingHorizontal: 16, gap: 6 }}>
        {item.rebuttal ? (
          <>
            <Text style={{ color: c.accent, fontSize: 13, fontWeight: '600' }}>Someone already disagrees</Text>
            <View style={{ marginHorizontal: -16 }}>
              <SideFrame side={opposite(item.authorStance)}><CastCard cast={item.rebuttal} collapse={collapseFor(item.rebuttal.text, opposite(item.authorStance))} /></SideFrame>
            </View>
          </>
        ) : (
          <SidePrompt item={item} />
        )}
        {/* The side boxes carry their own counts. */}
        {item.rebuttal && <Text style={{ color: c.muted, fontSize: 13 }}>{sides(item)}</Text>}
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

export const DebatesScreen = () => {
  const c = useColors()
  const feed = useInfiniteQuery({
    queryKey: ['takes', 'feed'],
    queryFn: ({ pageParam }) => fetchFeed(pageParam),
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
  if (feed.isPending) return <Loading />
  if (feed.isError && items.length === 0) return <Message tone="danger">{feed.error.message}</Message>
  const more = () => { if (feed.hasNextPage && !feed.isFetchingNextPage && !feed.isFetchNextPageError) void feed.fetchNextPage() }
  return (
    <FlatList
      data={items}
      keyExtractor={i => i.cast.hash}
      renderItem={({ item }) => <DebateCard item={item} />}
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
      ListEmptyComponent={
        <Message>Nothing debatable yet. Takes classifies new casts every minute; check back shortly.</Message>
      }
    />
  )
}
