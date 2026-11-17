import { describe, expect, it } from 'vitest'
import type { StoredViewer } from './adapters/store.ts'
import { NEW_VIEWERS_PER_HOUR } from './core/viewers.ts'
import { admitViewer, type AdmitDeps } from './viewers.ts'

const NOW = 1_800_000_000

/** An in-memory store and counters for the node and the limiter. */
const setup = (opts: { rows?: StoredViewer[]; admittedLastHour?: number; allow?: boolean; name?: string | null | Error } = {}) => {
  const rows = new Map((opts.rows ?? []).map(r => [r.fid, r]))
  const calls = { node: 0, limiter: 0, touched: [] as number[], added: [] as number[] }
  const deps: AdmitDeps = {
    now: NOW,
    store: {
      viewer: async fid => rows.get(fid) ?? null,
      addViewer: async (fid, username, now) => { calls.added.push(fid); rows.set(fid, { fid, username, firstSeen: now, lastSeen: now, caughtUp: false, followsTs: null }) },
      touchViewer: async fid => { calls.touched.push(fid) },
      viewersAdmittedSince: async () => opts.admittedLastHour ?? 0,
    },
    allowNew: async () => { calls.limiter++; return opts.allow ?? true },
    usernameOf: async () => {
      calls.node++
      const n = opts.name === undefined ? 'alice' : opts.name
      return n instanceof Error ? { ok: false, error: n.message } : { ok: true, name: n }
    },
  }
  return { deps, calls }
}

const row = (over: Partial<StoredViewer> = {}): StoredViewer =>
  ({ fid: 7, username: 'alice', firstSeen: NOW - 100, lastSeen: NOW - 100, caughtUp: false, followsTs: null, ...over })

describe('admitViewer', () => {
  it('admits a new viewer whose account exists', async () => {
    const { deps, calls } = setup()
    expect(await admitViewer(7, deps)).toMatchObject({ fid: 7, username: 'alice', status: 'personalizing' })
    expect(calls.added).toEqual([7])
  })
  it('a known viewer is touched, never re-checked, and ready once caught up', async () => {
    const { deps, calls } = setup({ rows: [row({ followsTs: NOW - 10, caughtUp: true })], admittedLastHour: 999, allow: false })
    expect(await admitViewer(7, deps)).toMatchObject({ status: 'ready', username: 'alice' })
    expect(calls).toMatchObject({ node: 0, limiter: 0, touched: [7], added: [] })
  })
  it('the hourly cap refuses before the limiter or the node is asked', async () => {
    const { deps, calls } = setup({ admittedLastHour: NEW_VIEWERS_PER_HOUR })
    expect((await admitViewer(7, deps)).status).toBe('busy')
    expect(calls).toMatchObject({ node: 0, limiter: 0, added: [] })
  })
  it('the per-IP limiter refuses before the node is asked', async () => {
    const { deps, calls } = setup({ allow: false })
    expect((await admitViewer(7, deps)).status).toBe('busy')
    expect(calls).toMatchObject({ node: 0, limiter: 1, added: [] })
  })
  it('an FID with no account (no username) is unknown, not admitted', async () => {
    const { deps, calls } = setup({ name: null })
    expect((await admitViewer(7, deps)).status).toBe('unknown')
    expect(calls.added).toEqual([])
  })
  it('a node failure is busy (try again), not unknown', async () => {
    const { deps, calls } = setup({ name: new Error('timeout') })
    expect((await admitViewer(7, deps)).status).toBe('busy')
    expect(calls.added).toEqual([])
  })
})
