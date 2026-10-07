// Usage must reach the sidebar from every loop: the main turn, spawned
// subagents, agents the mod never saw spawn, and turns no stream sample caught.
import { describe, expect, test } from 'claude-code/testing'

import type { AgentNode, CacheView, FeedItem, RateView, Task, UsageView } from '../types'
import { BURNED, harness, ROOT, streamStep, T0, tools, USAGE } from './support/harness'

// One step's 200 output tokens, sampled over the sampler's 1.2s tick.
const STEP_RATE = 200 / 1.2

const OFF = { options: { observer: false } }

async function drain(stream: AsyncIterable<unknown> & { result: Promise<unknown> }) {
  for await (const _c of stream) {
    // read to the end
  }
  await stream.result
}

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

describe('usage reaches the sidebar', () => {
  test('a main turn: tokens, tok/s, cache, the main agent, counted once', OFF, async ($, on) => {
    const h = harness(on)
    streamStep(on)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-test', messageCount: 1 }))
    await h.clock.advance(1200)

    const rate = h.state<RateView>('rate')
    expect(rate?.tokens).toBe(BURNED)
    expect(rate?.samples.at(-1)).toBe(STEP_RATE)
    const cache = h.state<CacheView>('cache')
    expect(cache?.lastHitAt).not.toBeNull()
    expect(cache?.readTokens).toBe(5000)
    expect(h.state<AgentNode[]>('agents')?.find(a => a.id === 'main')?.tokens).toBe(BURNED)
    expect(h.state<Record<string, number[]>>('agentRates')?.main?.at(-1)).toBe(STEP_RATE)

    // The turn's own usage then adds nothing the stream already counted.
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1200, isAborted: false, reason: 'answer', usage: USAGE })
    expect(h.state<RateView>('rate')?.tokens).toBe(BURNED)
    expect(h.state<AgentNode[]>('agents')?.find(a => a.id === 'main')?.status).toBe('idle')
  })

  test('a turn no stream sample caught still counts, from its own usage', OFF, async ($, on) => {
    const h = harness(on)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 4000, isAborted: false, reason: 'answer', usage: USAGE })

    expect(h.state<RateView>('rate')?.tokens).toBe(BURNED)
    expect(h.state<CacheView>('cache')?.readTokens).toBe(5000)
    // 200 output tokens over 4s: the chart gets the turn's average.
    expect(h.state<RateView>('rate')?.samples.at(-1)).toBe(50)
    expect(h.state<Record<string, number[]>>('agentRates')?.main?.at(-1)).toBe(50)
  })

  test('a spawned subagent: its node, task, tokens, chart, tool and end', OFF, async ($, on) => {
    const h = harness(on)
    streamStep(on)
    on('agent.spawn', () => ({ model: 'claude-test', agentId: 'a1' }))
    const tool = tools(on)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    h.listed.push({ id: 'a1', type: 'Explore', description: 'Map the code', status: 'running' })
    await $.agent.spawn(SPAWN)
    // The sync right after a spawn reads the agent list.
    await h.clock.advance(400)

    expect(h.state<AgentNode[]>('agents')?.find(a => a.id === 'a1')?.status).toBe('running')
    expect(h.state<Task[]>('tasks')?.find(t => t.agentId === 'a1')?.title).toBe('Map the code')

    await drain($.turn.step({ turnId: 'a1-t', index: 0, model: 'claude-test', messageCount: 1, agentId: 'a1' }))
    // A subagent's call: the kit's typing has no agentId, the event carries it.
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/a.ts`, agentId: 'a1' } as never)
    await tool.end($)
    await h.clock.advance(1200)

    const node = h.state<AgentNode[]>('agents')?.find(a => a.id === 'a1')
    expect(node?.tokens).toBe(BURNED)
    expect(node?.currentTool).toContain('a.ts')
    expect(h.state<Record<string, number[]>>('agentRates')?.a1?.at(-1)).toBe(STEP_RATE)
    expect(h.state<FeedItem[]>('feed')?.some(f => f.agentId === 'a1')).toBe(true)
    expect(h.state<Task[]>('tasks')?.find(t => t.id === 'a:a1')?.tokens).toBe(BURNED)
    // The session's totals include the subagent's work.
    expect(h.state<RateView>('rate')?.tokens).toBe(BURNED)

    await $.turn.complete({ turnId: 'a1-t', agentId: 'a1', answer: 'found it', durationMs: 1200, isAborted: false, reason: 'answer', usage: USAGE })
    expect(h.state<AgentNode[]>('agents')?.find(a => a.id === 'a1')?.status).toBe('done')
    expect(h.state<AgentNode[]>('agents')?.find(a => a.id === 'a1')?.tokens).toBe(BURNED)
    expect(h.state<Task[]>('tasks')?.find(t => t.id === 'a:a1')?.status).toBe('done')
  })

  test('an agent the mod never saw spawn is picked up and counted', OFF, async ($, on) => {
    const h = harness(on)
    streamStep(on)
    h.listed.push({ id: 'bg1', type: 'general-purpose', description: 'Rebuild the UI', status: 'running' })
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await h.clock.advance(100)

    expect(h.state<AgentNode[]>('agents')?.find(a => a.id === 'bg1')?.status).toBe('running')
    expect(h.state<Task[]>('tasks')?.find(t => t.agentId === 'bg1')?.status).toBe('running')

    await drain($.turn.step({ turnId: 'bg-t', index: 0, model: 'claude-fable', messageCount: 1, agentId: 'bg1' }))
    await h.clock.advance(1200)
    const node = h.state<AgentNode[]>('agents')?.find(a => a.id === 'bg1')
    expect(node?.tokens).toBe(BURNED)
    expect(node?.model).toBe('claude-fable')
    expect(h.state<Record<string, number[]>>('agentRates')?.bg1?.at(-1)).toBe(STEP_RATE)

    // The list says it finished: its task closes too.
    h.listed[0]!.status = 'completed'
    await h.clock.advance(5_000)
    expect(h.state<AgentNode[]>('agents')?.find(a => a.id === 'bg1')?.status).toBe('done')
    expect(h.state<Task[]>('tasks')?.find(t => t.agentId === 'bg1')?.status).toBe('done')
  })

  test('cost and context come in from session.measure', OFF, async ($, on) => {
    const h = harness(on)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await $.session.measure({ context: { tokens: 90_000, window: 200_000, percent: 45 }, rateLimits: [], cost: { usd: 2.5 }, changed: ['context', 'cost'] })

    const usage = h.state<UsageView>('usage')
    expect(usage?.costUsd).toBe(2.5)
    expect(usage?.percent).toBe(45)
    expect(usage?.contextTokens).toBe(90_000)
  })

  test('nothing is published before the batch window, everything after', OFF, async ($, on) => {
    const h = harness(on)
    const tool = tools(on)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await tool.end($)
    await h.clock.advance(400)
    expect(h.state<FeedItem[]>('feed')?.at(-1)?.state).toBe('ok')
    expect(T0).toBeGreaterThan(0)
  })
})
