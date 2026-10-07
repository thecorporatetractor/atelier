import { expect, test } from 'claude-code/testing'

import { mergeRuns } from '../hooks/lib/runs'

test('consecutive cells of one colour merge into one run', () => {
  const cells = [
    { ch: '━', color: 'a' },
    { ch: '━', color: 'a' },
    { ch: '━', color: 'b' },
    { ch: ' ', color: 'b' },
    { ch: '▃', color: 'a' },
  ]
  expect(mergeRuns(cells)).toEqual([
    { text: '━━', color: 'a' },
    { text: '━ ', color: 'b' },
    { text: '▃', color: 'a' },
  ])
  expect(mergeRuns([])).toEqual([])
  // The glyphs survive in order: the drawing reads the same.
  expect(mergeRuns(cells).map(r => r.text).join('')).toBe(cells.map(c => c.ch).join(''))
})
