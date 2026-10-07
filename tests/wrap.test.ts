import { describe, expect, test } from 'claude-code/testing'

import { wrapLines } from '../hooks/lib/wrap'

const RATIONALE = 'the throttle hides a second bug in the resize path that only shows once the layout settles after a frame'

describe('wrapLines', () => {
  test('a hundred-character rationale wraps over two or three lines, uncut', () => {
    expect(RATIONALE.length).toBeGreaterThanOrEqual(100)
    const lines = wrapLines(RATIONALE, 43, 3)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines.length).toBeLessThanOrEqual(3)
    expect(lines.join(' ')).toBe(RATIONALE)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(43)
  })

  test('four hundred characters stop at three lines with an ellipsis', () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
    expect(long.length).toBeGreaterThan(400)
    const lines = wrapLines(long, 40, 3)
    expect(lines).toHaveLength(3)
    expect(lines[2]?.endsWith('…')).toBe(true)
    expect(lines[2]?.length).toBeLessThanOrEqual(40)
  })

  test('the first line may be narrower, long words are cut, empty text is one line', () => {
    const lines = wrapLines('aaaa bbbb cccc dddd', 10, 3, 4)
    expect(lines[0]).toBe('aaaa')
    expect(lines[1]).toBe('bbbb cccc')
    expect(wrapLines('abcdefghij', 4, 5)).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrapLines('', 10, 3)).toEqual([''])
    expect(wrapLines('short', 10, 3)).toEqual(['short'])
  })
})
