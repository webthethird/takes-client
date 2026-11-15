// Filling one feed page from hydrated rows, in rank order.
//
// A row's cast is either live (kept), gone (deleted since it was scored: skipped for good, so
// the cursor moves past it), or unavailable (refused by a rate limit, or the node failed). An
// unavailable row must not be skipped like a gone one: that silently drops a card the viewer
// would have seen, and a burst of refusals turns into empty pages whose cursors run past the
// whole feed (measured: 40 lookups a page against Warpstack's 120-a-minute upstream limit).
// So the page ends before it, and the next request retries from there.
//
// The cost: a cast that is unavailable every time holds the feed at that position, with the
// client's "tap to retry". A gone cast is answered 404 or not-live, not an error, so this
// takes a persistently failing node, which would empty the feed anyway.

export type Hydrated<C, A> = { cast: C | 'gone' | 'unavailable'; rebuttal: C | 'gone' | 'unavailable' | null; after: A }

export const fillPage = <C, A, H extends Hydrated<C, A>>(rows: readonly H[], at: A, limit: number):
  { kept: H[]; next: A; stalled: boolean } => {
  const kept: H[] = []
  let next = at
  for (const h of rows) {
    if (kept.length === limit) return { kept, next, stalled: false }
    // A card whose rebuttal didn't load would claim no one disagreed, so it waits too.
    if (h.cast === 'unavailable' || h.rebuttal === 'unavailable') return { kept, next, stalled: true }
    next = h.after
    if (h.cast !== 'gone') kept.push(h)
  }
  return { kept, next, stalled: false }
}
