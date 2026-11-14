import { describe, expect, it } from 'vitest'
import { parseEmbeds, parseMentions, renderMentions } from './text.ts'

const names = new Map([[1, 'alice'], [2, 'bob']])

describe('renderMentions', () => {
  it('restores a leading mention (the real cast that exposed the bug)', () => {
    expect(renderMentions(" doesn't get enough flowers", [{ fid: 3356928, position: 0 }], new Map([[3356928, 'terminusapp']])))
      .toBe("@terminusapp doesn't get enough flowers")
  })
  it('uses byte offsets, so multibyte text before a mention does not shift it', () => {
    // "café 🔥 " is 11 bytes (é = 2, 🔥 = 4) but 7 UTF-16 units.
    const text = 'café 🔥  is right'
    expect(renderMentions(text, [{ fid: 1, position: 11 }], names)).toBe('café 🔥 @alice is right')
  })
  it('handles several mentions, including two at one position, in protocol order', () => {
    expect(renderMentions(' and  agree', [{ fid: 2, position: 5 }, { fid: 1, position: 0 }], names)).toBe('@alice and @bob agree')
    expect(renderMentions('hi ', [{ fid: 1, position: 3 }, { fid: 2, position: 3 }], names)).toBe('hi @alice@bob')
  })
  it('falls back to the FID when the name is unknown, and clamps bad positions', () => {
    expect(renderMentions('x', [{ fid: 9, position: 99 }], names)).toBe('x@fid:9')
  })
  it('leaves text without mentions untouched', () => expect(renderMentions('plain', [], names)).toBe('plain'))
})

describe('parsing index columns', () => {
  it('finds urls and the first quoted cast', () => {
    const e = parseEmbeds(JSON.stringify([
      { kind: 'url', url: 'https://a.example/x.jpg' },
      { kind: 'cast', cast: { fid: 7, hash: '0xabc' } },
      { kind: 'cast', cast: { fid: 8, hash: '0xdef' } },
      { kind: 'weird' },
    ]))
    expect(e).toEqual({ urls: ['https://a.example/x.jpg'], quoted: { fid: 7, hash: '0xabc' } })
  })
  it('tolerates junk', () => {
    expect(parseEmbeds('not json')).toEqual({ urls: [], quoted: null })
    expect(parseMentions('[{"fid":1},{"fid":2,"position":3}]')).toEqual([{ fid: 2, position: 3 }])
  })
})

import { isLowercaseStyle, matchCasing } from './text.ts'

describe('matchCasing', () => {
  const taxes = 'okay comparing taxes with splitting the bill between salad and lobster makes no fucking sense\n\neveryone gets the same quality of services and those who have more must pay more'
  it('lowercases replies to a lowercase cast (the live miss), keeping acronyms, names and tokens', () => {
    expect(matchCasing(taxes, 'Progressive rates hit a Nurse harder than DeFi whales or the IRS thinks, says @dwr about $DEGEN.'))
      .toBe('progressive rates hit a nurse harder than DeFi whales or the IRS thinks, says @dwr about $DEGEN.')
    expect(matchCasing(taxes, 'I think so')).toBe('i think so')
  })
  it('treats ALL-CAPS emphasis as neither style, and judges by sentence starts', () => {
    expect(isLowercaseStyle('even the people working on AI dont understand it, but lawmakers are supposed to REGULATE it? (and on what grounds?)')).toBe(true)
    expect(isLowercaseStyle('Lol network school turning into slop')).toBe(false)
    expect(isLowercaseStyle('Valuing a startup on cash flows is a category error. A startup has no cash flows.')).toBe(false)
  })
  it('leaves replies to sentence-cased casts untouched', () => {
    expect(matchCasing('Remote work made me productive. I am never going back.', 'No commute is two extra hours.')).toBe('No commute is two extra hours.')
  })
})
