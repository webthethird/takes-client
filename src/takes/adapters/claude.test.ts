import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { retryWithoutImages, withImages } from './claude.ts'

const badRequest = () => new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'could not fetch image' } }, 'could not fetch image', new Headers())

describe('images in model calls', () => {
  it('a turn without images is the plain text, unchanged', () => {
    expect(withImages('<cast>hi</cast>', undefined)).toBe('<cast>hi</cast>')
    expect(withImages('<cast>hi</cast>', [])).toBe('<cast>hi</cast>')
  })

  it('images go ahead of the text, at most four', () => {
    const turn = withImages('<cast>hi</cast>', ['a', 'b', 'c', 'd', 'e']) as Anthropic.ContentBlockParam[]
    expect(turn.filter(b => b.type === 'image')).toHaveLength(4)
    expect(turn.at(-1)).toEqual({ type: 'text', text: '<cast>hi</cast>' })
  })

  it('a rejected request with images is retried once without them', async () => {
    const seen: Array<readonly string[] | undefined> = []
    const r = await retryWithoutImages(['https://x/img.png'], async images => {
      seen.push(images)
      if (images) throw badRequest()
      return 'ok'
    })
    expect(r).toBe('ok')
    expect(seen).toEqual([['https://x/img.png'], undefined])
  })

  it('no retry without images to drop, nor for other errors', async () => {
    let calls = 0
    await expect(retryWithoutImages(undefined, async () => { calls++; throw badRequest() })).rejects.toBeInstanceOf(Anthropic.BadRequestError)
    expect(calls).toBe(1)
    calls = 0
    await expect(retryWithoutImages(['u'], async () => { calls++; throw new Error('network') })).rejects.toThrow('network')
    expect(calls).toBe(1)
  })
})
