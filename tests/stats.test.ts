import { describe, expect, test } from 'claude-code/testing'

import type { DayStats } from '../types'
import { addDay, dayKey, emptyDay, isEmptyDay, pruneDays, STATS_DAYS, summarizeStats } from '../hooks/lib/model'

const NOW = Date.UTC(2026, 9, 7, 12)
const DAY = 86_400_000

function day(fields: (d: DayStats) => void) {
  const d = emptyDay()
  fields(d)

  return d
}

describe('stats', () => {
  test('days sum field by field, models and tools merged by name', () => {
    const a = day(d => {
      d.cost = 1
      d.tokens = { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 }
      d.byModel = { opus: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, cost: 1, requests: 1 } }
      d.tools = { Edit: { calls: 1, fails: 0, ms: 100 } }
    })
    const b = day(d => {
      d.cost = 2
      d.byModel = { opus: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 2, requests: 1 }, haiku: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 1 } }
      d.tools = { Edit: { calls: 1, fails: 1, ms: 300 } }
    })
    const sum = addDay(a, b)
    expect(sum.cost).toBe(3)
    expect(sum.byModel.opus?.cost).toBe(3)
    expect(sum.byModel.opus?.requests).toBe(2)
    expect(sum.byModel.haiku?.requests).toBe(1)
    expect(sum.tools.Edit).toEqual({ calls: 2, fails: 1, ms: 400 })
  })

  test('a stored day missing newer fields still sums', () => {
    const old = { cost: 4 } as Partial<DayStats>
    expect(addDay(old, day(d => (d.turns = 1))).turns).toBe(1)
    expect(addDay(old, emptyDay()).cost).toBe(4)
  })

  test('ranges, series and rates', () => {
    const days: Record<string, DayStats> = {
      [dayKey(NOW)]: day(d => {
        d.cost = 2
        d.turns = 2
        d.turnMs = 6000
        d.tokens = { input: 50, output: 10, cacheRead: 150, cacheWrite: 0 }
        d.observer = { calls: 3, input: 20, output: 1 }
        d.tools = { Bash: { calls: 4, fails: 1, ms: 4000 } }
        d.agents = { Explore: { spawns: 2, tokens: 1000, ms: 60_000, fails: 0 } }
      }),
      [dayKey(NOW - 3 * DAY)]: day(d => (d.cost = 5)),
      [dayKey(NOW - 20 * DAY)]: day(d => (d.cost = 7)),
      [dayKey(NOW - 60 * DAY)]: day(d => (d.cost = 11)),
    }
    const s = summarizeStats(days, NOW)
    expect(s.today.cost).toBe(2)
    expect(s.week.cost).toBe(7)
    expect(s.month.cost).toBe(14)
    expect(s.all.cost).toBe(25)
    expect(s.today.avgTurnMs).toBe(3000)
    expect(s.today.cacheHitRate).toBe(0.75)
    expect(Math.abs(s.today.observerShare - 21 / 210) < 1e-9).toBe(true)
    expect(s.dailyCost).toHaveLength(30)
    expect(s.dailyCost.at(-1)).toBe(2)
    expect(s.dailyCost[26]).toBe(5)
    expect(s.tools[0]).toEqual({ tool: 'Bash', calls: 4, failRate: 0.25, avgMs: 1000 })
    expect(s.agents[0]?.avgMs).toBe(30_000)
    expect(s.activeDays).toBe(4)
    expect(s.since).toBe(dayKey(NOW - 60 * DAY))
  })

  test('history is capped and an empty delta is recognised', () => {
    const days: Record<string, DayStats> = {}
    for (let i = 0; i < STATS_DAYS + 5; i += 1) days[dayKey(NOW - i * DAY)] = day(d => (d.cost = 1))
    const kept = pruneDays(days)
    expect(Object.keys(kept)).toHaveLength(STATS_DAYS)
    expect(kept[dayKey(NOW)]).toBeDefined()
    expect(isEmptyDay(emptyDay())).toBe(true)
    expect(isEmptyDay(day(d => (d.turns = 1)))).toBe(false)
  })
})
