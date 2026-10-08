import { describe, expect, test } from 'claude-code/testing'

import { addSpend, asSpendBook, dayKey, type SpendBook, spendView } from '../hooks/lib/support'

const DAY = 86_400_000
const now = Date.UTC(2026, 9, 8, 12)

describe('spend book', () => {
  test('deltas add to today, by model, and old days fall off', () => {
    const book: SpendBook = { [dayKey(now - DAY)]: { total: 1, byModel: { haiku: 1 } }, [dayKey(now)]: { total: 2, byModel: { opus: 2 } } }
    const added = addSpend(book, [['opus', 0.5], ['haiku', 0.25]], dayKey(now), 2)
    expect(added[dayKey(now)]).toEqual({ total: 2.75, byModel: { opus: 2.5, haiku: 0.25 } })
    expect(book[dayKey(now)]?.total).toBe(2)
    expect(Object.keys(addSpend(added, [['opus', 1]], dayKey(now + DAY), 2))).toEqual([dayKey(now), dayKey(now + DAY)])
  })

  test('the view sums today, 7 and 30 days, and 14 daily totals', () => {
    const book: SpendBook = { [dayKey(now)]: { total: 1, byModel: { opus: 1 } }, [dayKey(now - 6 * DAY)]: { total: 2, byModel: { opus: 2 } }, [dayKey(now - 20 * DAY)]: { total: 4, byModel: { haiku: 4 } }, [dayKey(now - 40 * DAY)]: { total: 8, byModel: { haiku: 8 } } }
    const view = spendView(book, now)
    expect([view.today, view.week, view.month]).toEqual([1, 3, 7])
    expect(view.byModel).toEqual({ opus: 3, haiku: 4 })
    expect(view.daily).toHaveLength(14)
    expect(view.daily[13]).toBe(1)
    expect(view.daily[7]).toBe(2)
  })

  test('anything but an object reads as an empty book', () => {
    expect(asSpendBook(undefined)).toEqual({})
    expect(asSpendBook(null)).toEqual({})
  })
})
