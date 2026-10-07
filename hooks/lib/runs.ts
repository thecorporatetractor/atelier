// Rows of coloured cells drawn as few Text elements: consecutive cells of
// one colour become one run. Pure, so the merge is tested.

export type CellRun = { text: string; color: string }

/** Merges consecutive cells of the same colour into one run of glyphs. */
export function mergeRuns(cells: readonly { ch: string; color: string }[]): CellRun[] {
  const out: CellRun[] = []
  for (const c of cells) {
    const last = out[out.length - 1]
    if (last !== undefined && last.color === c.color) last.text += c.ch
    else out.push({ text: c.ch, color: c.color })
  }

  return out
}
