// The home screen: casts ranked by how debatable they are. Each card leads with the real cast,
// never an AI paraphrase; the derived question sits above it as the axis of disagreement.
// A real rebuttal from someone else is shown as evidence; only when there is none does the
// card fall back to the classifier's challenge_reason, labelled as an AI hypothesis.

import { useQuery } from '@tanstack/react-query'
import { routes } from '@warpstack/app-core'
import { Cast } from '@warpstack/contract'
import { CastCard, Loading, Message, useColors } from '@warpstack/ui'
import { useRouter } from 'expo-router'
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native'
import { z } from 'zod'
import { apiUrl } from './api-url.ts'

const Item = z.object({
  cast: Cast,
  rebuttal: Cast.nullable(),
  question: z.string(),
  challengeReason: z.string(),
  authorStance: z.enum(['yes', 'no']),
  bothSides: z.boolean(),
  yesAuthors: z.number().int().nonnegative(),
  noAuthors: z.number().int().nonnegative(),
  band: z.number().int(),
  following: z.boolean(),
  resurfaced: z.boolean(),
})
type Item = z.infer<typeof Item>
const Feed = z.object({ items: z.array(Item), viewerFid: z.number().nullable() })

const fetchFeed = async (): Promise<z.infer<typeof Feed>> => {
  const res = await fetch(`${apiUrl}/api/takes/feed`, { headers: { accept: 'application/json' } })
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
 * An unchallenged card ends in an invitation, not a dead end: a reply box whose placeholder is
 * the other side's argument. It is a pressable, not a text field; it opens the stock composer
 * as a reply to this cast (which posts from the phone; the web composer opens but is
 * read-only). The suggestion is AI-written, so it is labelled as such and styled as
 * placeholder text: it must never read as a real person's reply (classifier README, "Real
 * disagreement outranks hypothesised disagreement").
 */
const ChallengePrompt = ({ item }: { item: Item }) => {
  const c = useColors()
  const router = useRouter()
  // router.push rather than <Link asChild>: Warpstack's ui notes a style array under asChild
  // reaches the DOM on the web and crashes the page.
  const open = () => router.push(routes.compose({ reply: { fid: item.cast.fid, hash: item.cast.hash } }))
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: c.accent, fontSize: 13, fontWeight: '600' }}>⚑ Open debate · no challengers yet</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Make the case against this take. Suggested angle: ${item.challengeReason}`}
        onPress={open}
        style={({ pressed }) => ({
          borderColor: pressed ? c.accent : c.border, borderWidth: 1, borderRadius: 12,
          backgroundColor: c.bg, paddingHorizontal: 14, paddingVertical: 12, gap: 4,
        })}>
        <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }}>💬 Make the case against…</Text>
        <Text style={{ color: c.muted, fontSize: 14, fontStyle: 'italic' }}>e.g. “{item.challengeReason}”</Text>
        <Text style={{ color: c.muted, fontSize: 11, marginTop: 2 }}>Suggested by AI · not a real reply</Text>
      </Pressable>
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
      </View>
      <CastCard cast={item.cast} />
      <View style={{ paddingHorizontal: 16, gap: 6 }}>
        {item.rebuttal ? (
          <>
            <Text style={{ color: c.accent, fontSize: 13, fontWeight: '600' }}>Someone already disagrees</Text>
            <View style={{ borderLeftColor: c.border, borderLeftWidth: 3 }}>
              <CastCard cast={item.rebuttal} />
            </View>
          </>
        ) : (
          <ChallengePrompt item={item} />
        )}
        <Text style={{ color: c.muted, fontSize: 13 }}>{sides(item)}</Text>
      </View>
    </View>
  )
}

export const DebatesScreen = () => {
  const c = useColors()
  const feed = useQuery({ queryKey: ['takes', 'feed'], queryFn: fetchFeed, staleTime: 30_000 })
  if (feed.isPending) return <Loading />
  if (feed.isError) return <Message tone="danger">{feed.error.message}</Message>
  return (
    <FlatList
      data={feed.data.items}
      keyExtractor={i => i.cast.hash}
      renderItem={({ item }) => <DebateCard item={item} />}
      refreshControl={<RefreshControl refreshing={feed.isRefetching} onRefresh={() => void feed.refetch()} tintColor={c.muted} />}
      ListEmptyComponent={
        <Message>Nothing debatable yet. Takes classifies new casts every minute; check back shortly.</Message>
      }
    />
  )
}
