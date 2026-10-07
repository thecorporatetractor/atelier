import { describe, expect, test } from 'claude-code/testing'

import { base64, chartCells, chartGlyph, DEFAULT, encodeCells, heatRows, raster, rgb, stripCells } from '../hooks/lib/raster'

describe('raster cells', () => {
  test('one cell encodes as little-endian u32 triplets in padded base64', () => {
    // 0x2588 '█', orange, the terminal's default background.
    expect(encodeCells([{ ch: '█', fg: 0xff8800 }])).toBe('iCUAAACI/wAAAAAB')
    expect(encodeCells([{ ch: '▃', fg: rgb('#a3be8c') }, { ch: '▃', fg: rgb('#2a2622') }])).toBe('gyUAAIy+owAAAAABgyUAACImKgAAAAAB')
    expect(base64(new Uint8Array([77, 97]))).toBe('TWE=')
    expect(base64(new Uint8Array([77]))).toBe('TQ==')
    expect(rgb('#e0a458')).toBe(0xe0a458)
  })

  test('a grid pads short rows and reports its size', () => {
    const r = raster(3, [[{ ch: 'a', fg: 1 }], [{ ch: 'b', fg: 2 }, { ch: 'c', fg: 3 }]])
    expect(r.columns).toBe(3)
    expect(r.rows).toBe(2)
    expect(r.cells).toBe(encodeCells([{ ch: 'a', fg: 1 }, { ch: ' ', fg: DEFAULT }, { ch: ' ', fg: DEFAULT }, { ch: 'b', fg: 2 }, { ch: 'c', fg: 3 }, { ch: ' ', fg: DEFAULT }]))
  })

  test('chart columns fill from the bottom in eighths over two rows', () => {
    expect(chartGlyph(16, 0, 2)).toBe('█')
    expect(chartGlyph(16, 1, 2)).toBe('█')
    expect(chartGlyph(12, 0, 2)).toBe('▄')
    expect(chartGlyph(12, 1, 2)).toBe('█')
    expect(chartGlyph(3, 0, 2)).toBe(' ')
    expect(chartGlyph(3, 1, 2)).toBe('▃')
    expect(chartGlyph(0, 1, 2)).toBe(' ')
    // Four rows: 32 levels, filled from the floor.
    expect(chartGlyph(32, 0, 4)).toBe('█')
    expect(chartGlyph(20, 0, 4)).toBe(' ')
    expect(chartGlyph(20, 1, 4)).toBe('▄')
    expect(chartGlyph(20, 2, 4)).toBe('█')
    expect(chartGlyph(20, 3, 4)).toBe('█')
    expect(chartCells([100], 4, 100, () => 1, 2).map(r => r[0]?.ch)).toEqual(['█', '█', '█', '█'])
    const rows = chartCells([0, 100, 50], 2, 100, () => 0xabcdef, 0x2a2622)
    expect(rows[1]?.[0]).toEqual({ ch: '▁', fg: 0x2a2622 })
    expect(rows[0]?.[1]?.ch).toBe('█')
    expect(rows[0]?.[2]?.ch).toBe(' ')
    expect(rows[1]?.[2]?.ch).toBe('█')
  })

  test('strips and heat tiles', () => {
    const s = stripCells(2, 4, 1, 2)
    expect(s.map(c => c.fg)).toEqual([1, 1, 2, 2])
    const h = heatRows([5, 6, 7, 8], 2, 5, 2)
    expect(h[0]?.length).toBe(5)
    expect(h[0]?.map(c => c.fg)).toEqual([5, 5, 6, 6, 6])
    expect(h[1]?.map(c => c.fg)).toEqual([7, 7, 8, 8, 8])
  })
})
