// Admitting viewers ("Viewing as"): the feed's ?fid= and GET /api/takes/viewer. The limits are
// core/viewers.ts's; this file applies them, in an order that keeps the node calls bounded:
// the deployment-wide hourly cap first, then the per-IP limiter, and only then the node.

import type { StoredViewer, TakesStore } from './adapters/store.ts'
import { NEW_VIEWERS_PER_HOUR, TOUCH_EVERY, statusOf, type ViewerStatus } from './core/viewers.ts'

type UsernameRead = { ok: true; name: string | null } | { ok: false; error: string }

export type AdmitDeps = {
  store: Pick<TakesStore, 'viewer' | 'addViewer' | 'touchViewer' | 'viewersAdmittedSince'>
  /** The per-IP limiter for new viewers: true when this request may admit one. */
  allowNew: () => Promise<boolean>
  /** The FID's current username from the node (null: no such account, or none set). */
  usernameOf: (fid: number) => Promise<UsernameRead>
  now: number
}

export type Admitted = { fid: number; username: string | null; status: ViewerStatus; viewer: StoredViewer | null }

/**
 * The viewer for `fid`: a known one is touched (at most hourly) and returned with its status;
 * an unknown one is admitted when the limits allow and the account exists. Never throws for a
 * limit: the feed still serves, network-wide, with the status saying why.
 */
export const admitViewer = async (fid: number, deps: AdmitDeps): Promise<Admitted> => {
  const { store, now } = deps
  const known = await store.viewer(fid)
  if (known) {
    await store.touchViewer(fid, now, TOUCH_EVERY)
    return { fid, username: known.username, status: statusOf(known), viewer: known }
  }
  if ((await store.viewersAdmittedSince(now - 3600)) >= NEW_VIEWERS_PER_HOUR) return { fid, username: null, status: 'busy', viewer: null }
  if (!(await deps.allowNew())) return { fid, username: null, status: 'busy', viewer: null }
  const name = await deps.usernameOf(fid)
  if (!name.ok) return { fid, username: null, status: 'busy', viewer: null }
  // An account with no username can't be shown as "Viewing as @…", and an FID that doesn't
  // exist has none: both are refused, so a typo doesn't become a viewer.
  if (name.name === null) return { fid, username: null, status: 'unknown', viewer: null }
  await store.addViewer(fid, name.name, now)
  return { fid, username: name.name, status: 'personalizing', viewer: null }
}
