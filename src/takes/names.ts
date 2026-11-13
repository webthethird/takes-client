// Resolves mention FIDs to usernames for one scoring pass: the TAKES cache first, then the
// node, bounded per pass. A failed lookup is not cached, so it is retried next pass; until
// then the mention renders as @fid:N, which still tells the model someone is named there.

import { readUsername } from './adapters/node.ts'
import type { TakesStore } from './adapters/store.ts'
import type { IndexedCast } from './adapters/cast-index.ts'
import { renderMentions } from './core/text.ts'

const LOOKUPS_PER_PASS = 80
const CONCURRENCY = 8

export class Names {
  private readonly known = new Map<number, string>()
  private readonly looked = new Set<number>()
  private lookups = 0

  constructor(private readonly store: TakesStore, private readonly nodeUrls: string, private readonly now: number) {}

  async ensure(casts: Iterable<IndexedCast>): Promise<void> {
    const want = new Set<number>()
    for (const c of casts) for (const m of c.mentions) if (!this.looked.has(m.fid)) want.add(m.fid)
    if (want.size === 0) return
    const cached = await this.store.names([...want])
    for (const [fid, name] of cached) {
      this.looked.add(fid)
      want.delete(fid)
      if (name) this.known.set(fid, name)
    }
    const queue = [...want].slice(0, Math.max(0, LOOKUPS_PER_PASS - this.lookups))
    this.lookups += queue.length
    const worker = async () => {
      for (let fid = queue.shift(); fid !== undefined; fid = queue.shift()) {
        this.looked.add(fid)
        const r = await readUsername(this.nodeUrls, fid)
        if (!r.ok) continue
        await this.store.putName(fid, r.name, this.now)
        if (r.name) this.known.set(fid, r.name)
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  }

  render(c: IndexedCast): string {
    return renderMentions(c.text, c.mentions, this.known)
  }
}
