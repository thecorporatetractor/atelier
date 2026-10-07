// Word wrapping for the rows that may run to a few lines (the decisions):
// pure, so the line cap is the same on every surface and testable.
import { fit } from './model'

/**
 * Wraps `text` on spaces into at most `maxLines` lines: the first `firstWidth`
 * wide (room for a right-aligned part), the rest `width`. A word longer than
 * a line is cut; what does not fit the last line ends it with an ellipsis.
 */
export function wrapLines(text: string, width: number, maxLines: number, firstWidth = width): string[] {
  const w = Math.max(1, width)
  const first = Math.max(1, firstWidth)
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  const limitOf = (i: number) => (i === 0 ? first : w)
  for (let word of words) {
    while (word.length > 0) {
      const limit = limitOf(lines.length)
      if (cur === '') {
        if (word.length <= limit) {
          cur = word
          word = ''
        } else {
          lines.push(word.slice(0, limit))
          word = word.slice(limit)
        }
      } else if (cur.length + 1 + word.length <= limit) {
        cur = `${cur} ${word}`
        word = ''
      } else {
        lines.push(cur)
        cur = ''
      }
    }
  }
  if (cur !== '') lines.push(cur)
  if (lines.length === 0) return ['']
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines - 1)
  const rest = lines.slice(maxLines - 1).join(' ')

  return [...kept, fit(rest, limitOf(maxLines - 1))]
}
