// The stats screen draws from history kept across sessions: past days must
// survive, today's work must land in today's day, nothing counted twice.
import { describe, expect, test } from 'claude-code/testing'

import type { DayStats, StatsView } from '../types'
import { dayKey, emptyDay } from '../hooks/lib/model'
import { harness, ROOT, streamStep, T0, tools, USAGE } from './support/harness'

const OFF = { options: { observer: false } }
const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 7, 12)

function day(fields: Partial<DayStats>): DayStats {
  return { ...emptyDay(), ...fields }
}

type Book = { days: Record<string, DayStats> }

const SPAWN = {
  tool_use_id: 'tu1',
  prompt: 'look around',
  description: 'Map the code',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-test',
  background: true,
  fork: false,
}

async function drain(stream: AsyncIterable<unknown> & { result: Promise<unknown> }) {
  for await (const _c of stream) {
    // read to the end
  }
  await stream.result
}

describe('stats history', () => {
  test('past days in the store show in the ranges at session start', OFF, async ($, on) => {
    const past: Book = {
      days: {
        [dayKey(NOW - 2 * DAY)]: day({ cost: 3, turns: 4 }),
        [dayKey(NOW - 20 * DAY)]: day({ cost: 7, turns: 2 }),
        [dayKey(NOW - 90 * DAY)]: day({ cost: 11 }),
      },
    }
    const h = harness(on, { store: { stats: past }, now: NOW })
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await h.clock.advance(10)

    const stats = h.state<StatsView>('stats')
    expect(stats?.week.cost).toBe(3)
    expect(stats?.month.cost).toBe(10)
    expect(stats?.all.cost).toBe(21)
    expect(stats?.since).toBe(dayKey(NOW - 90 * DAY))
    expect(stats?.dailyCost).toHaveLength(30)
  })

  test("a turn's work lands in today's day and the past stays", OFF, async ($, on) => {
    const past: Book = { days: { [dayKey(NOW - DAY)]: day({ cost: 4, turns: 9 }) } }
    const h = harness(on, { store: { stats: past }, now: NOW })
    streamStep(on)
    on('agent.spawn', () => ({ model: 'claude-test', agentId: 'a1' }))
    const tool = tools(on)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    // The first measurement is the baseline; the second one's growth is today's cost.
    await $.session.measure({ context: { tokens: 1, window: 200_000 }, rateLimits: [], cost: { usd: 1 }, changed: ['cost'] })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-test', messageCount: 1 }))
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await tool.end($)
    h.listed.push({ id: 'a1', type: 'Explore', description: 'Map the code', status: 'running' })
    await $.agent.spawn(SPAWN)
    // The sync right after a spawn reads the agent list.
    await h.clock.advance(1100)
    await drain($.turn.step({ turnId: 'a1-t', index: 0, model: 'claude-haiku-test', messageCount: 1, agentId: 'a1' }))
    await $.session.measure({ context: { tokens: 1, window: 200_000 }, rateLimits: [], cost: { usd: 1.75 }, changed: ['cost'] })
    await $.turn.complete({ turnId: 'a1-t', agentId: 'a1', answer: 'ok', durationMs: 3000, isAborted: false, reason: 'answer', usage: USAGE })
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 5000, isAborted: false, reason: 'answer', usage: USAGE })
    await h.clock.advance(1300)

    const book = h.store<Book>('stats')
    const today = book?.days[dayKey(NOW)]
    expect(today?.turns).toBe(1)
    expect(today?.turnMs).toBe(5000)
    expect(today?.cost).toBe(0.75)
    expect(today?.sessions).toBe(1)
    // Both loops' tokens, by model: main's and the subagent's.
    expect(today?.tokens.output).toBe(400)
    expect(today?.byModel['claude-test']?.output).toBe(200)
    expect(today?.byModel['claude-haiku-test']?.output).toBe(200)
    expect(today?.byProject[ROOT]?.turns).toBe(1)
    expect(today?.tools.Bash?.calls).toBe(1)
    expect(today?.testsPassed).toBe(1)
    expect(today?.agents.Explore?.spawns).toBe(1)
    expect(today?.agents.Explore?.tokens).toBe(1200)
    // Yesterday untouched.
    expect(book?.days[dayKey(NOW - DAY)]).toEqual(day({ cost: 4, turns: 9 }))
    // And the screen's figures follow.
    const stats = h.state<StatsView>('stats')
    expect(stats?.today.turns).toBe(1)
    expect(stats?.week.turns).toBe(10)
  })

  test('a session counts once, however often session.start fires', OFF, async ($, on) => {
    const h = harness(on, { now: NOW })
    for (let i = 0; i < 3; i += 1) await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await h.clock.advance(61_000)
    expect(h.store<Book>('stats')?.days[dayKey(NOW)]?.sessions).toBe(1)
  })

  test('the spend kept before stats existed carries over', OFF, async ($, on) => {
    const spend = { [dayKey(NOW - 3 * DAY)]: { total: 2.5, byModel: { 'claude-test': 2.5 } } }
    const h = harness(on, { store: { spend }, now: NOW })
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await h.clock.advance(10)
    expect(h.state<StatsView>('stats')?.week.cost).toBe(2.5)
    expect(h.state<StatsView>('stats')?.models[0]?.model).toBe('claude-test')
    expect(T0).toBeGreaterThan(0)
  })
})
