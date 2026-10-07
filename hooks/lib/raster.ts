// Cells for the terminal's `Raster` element: pure, so the encoding is tested.
// A cell is `[codePoint, fg, bg]` as little-endian u32s, the whole grid
// row-major, base64. A colour is 0x00RRGGBB; DEFAULT is the terminal's own.

export const DEFAULT = 0x01000000

export type Cell = { ch: string; fg: number; bg?: number }

export type RasterCells = { columns: number; rows: number; cells: string }

/** `#e0a458` → 0xe0a458. */
export function rgb(hex: string): number {
  const n = Number.parseInt(hex.replace(/^#/, ''), 16)

  return Number.isFinite(n) ? n & 0xffffff : DEFAULT
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64, written out: the module has no Buffer. */
export function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]
    out += B64[(n >> 12) & 63]
    out += b === undefined ? '=' : B64[(n >> 6) & 63]
    out += c === undefined ? '=' : B64[n & 63]
  }

  return out
}

/** The grid's `cells` string: every cell a triplet, rows first. */
export function encodeCells(cells: readonly Cell[]): string {
  const bytes = new Uint8Array(cells.length * 12)
  let at = 0
  const put = (v: number) => {
    bytes[at] = v & 0xff
    bytes[at + 1] = (v >>> 8) & 0xff
    bytes[at + 2] = (v >>> 16) & 0xff
    bytes[at + 3] = (v >>> 24) & 0xff
    at += 4
  }
  for (const c of cells) {
    put(c.ch.codePointAt(0) ?? 0x20)
    put(c.fg)
    put(c.bg ?? DEFAULT)
  }

  return base64(bytes)
}

export function raster(columns: number, rows: readonly (readonly Cell[])[]): RasterCells {
  const flat: Cell[] = []
  for (const r of rows) {
    for (let i = 0; i < columns; i += 1) flat.push(r[i] ?? { ch: ' ', fg: DEFAULT })
  }

  return { columns, rows: rows.length, cells: encodeCells(flat) }
}

const EIGHTHS = ' ▁▂▃▄▅▆▇█'

/**
 * The glyph of a chart column's cell at row `r` (0 the top) when the column
 * stands `level` eighths tall over `rows` rows: full below the bar's top,
 * the top cell a partial block, blank above.
 */
export function chartGlyph(level: number, r: number, rows: number): string {
  const below = (rows - 1 - r) * 8
  const here = Math.max(0, Math.min(8, Math.round(level) - below))

  return EIGHTHS[here] as string
}

/**
 * A two-row (or taller) bar chart: one column per value, scaled to `peak`,
 * each column in its own colour, a track-coloured baseline under the empties.
 */
export function chartCells(values: readonly number[], rows: number, peak: number, colorOf: (v: number) => number, track: number): Cell[][] {
  const scale = Math.max(1, peak)
  const out: Cell[][] = Array.from({ length: rows }, () => [])
  for (const v of values) {
    const level = Math.round((Math.max(0, v) / scale) * rows * 8)
    for (let r = 0; r < rows; r += 1) {
      const g = chartGlyph(level, r, rows)
      const isBase = r === rows - 1 && level === 0
      ;(out[r] as Cell[]).push(isBase ? { ch: '▁', fg: track } : { ch: g, fg: colorOf(v) })
    }
  }

  return out
}

/** A thin strip: `filled` of `total` cells in `color`, the rest in `track`. */
export function stripCells(filled: number, total: number, color: number, track: number, glyph = '▃'): Cell[] {
  const n = Math.max(0, Math.min(total, Math.round(filled)))

  return Array.from({ length: total }, (_, i) => ({ ch: glyph, fg: i < n ? color : track }))
}

/**
 * The heatmap: `perRow` tiles a row spread over `columns`, each tile the
 * colour of its category, drawn as a low block so the rows read as tiles.
 */
export function heatRows(categories: readonly number[], perRow: number, columns: number, rows: number): Cell[][] {
  const out: Cell[][] = []
  for (let r = 0; r < rows; r += 1) {
    const cells: Cell[] = []
    for (let i = 0; i < perRow; i += 1) {
      const w = Math.max(1, Math.floor(((i + 1) * columns) / perRow) - Math.floor((i * columns) / perRow))
      const color = categories[r * perRow + i] ?? DEFAULT
      for (let j = 0; j < w; j += 1) cells.push({ ch: '▆', fg: color })
    }
    out.push(cells.slice(0, columns))
  }

  return out
}
