import { describe, expect, test } from 'claude-code/testing'

import type { AgentNode, Task } from '../types'
import {
  advancePhase,
  appendRates,
  applyCurrentTools,
  liveAgents,
  trimAgents,
  mergeAgentList,
  openAgentTask,
  agentTask,
  agentTaskOf,
  agentTaskRows,
  chargeableFor,
  finishAgentTask,
  isAnythingRunning,
  newTask,
  settle,
  summarizeCall,
} from '../hooks/lib/model'

const T0 = 1_000_000

function task(fields: Partial<Task> & Pick<Task, 'id'>): Task {
  return newTask({ title: fields.id, ...fields }, T0)
}

function agent(id: string, status: AgentNode['status'], endedAt?: number): AgentNode {
  return { id, type: 'general-purpose', model: 'fable-5-1', description: id, status, tokens: 0, startedAt: T0, endedAt, isBackground: true }
}

describe('subagent tasks', () => {
  test('a spawned agent gets its own top-level task, out of the root', () => {
    const list = settle([task({ id: 'r', status: 'running' }), agentTask('ag1', 'Build the UI', T0)])
    expect(agentTaskOf(list, 'ag1')?.parentId).toBeNull()
    expect(agentTaskOf(list, 'ag1')?.status).toBe('running')
    // The root has no children: the agent's task does not count toward it.
    expect(list.find(t => t.id === 'r')?.progress).toBe(0)
  })

  test("a subagent's calls advance only its own tasks", () => {
    const list = [task({ id: 'r', status: 'running' }), agentTask('ag1', 'x', T0), agentTask('ag2', 'y', T0)]
    const next = advancePhase(list, 'editing', 'r', 'ag1', T0)
    expect(agentTaskOf(next, 'ag1')?.phase).toBe('editing')
    expect(agentTaskOf(next, 'ag2')?.phase).toBe('exploring')
    expect(next.find(t => t.id === 'r')?.phase).toBe('exploring')
    const main = advancePhase(list, 'verifying', 'r', undefined, T0)
    expect(main.find(t => t.id === 'r')?.phase).toBe('verifying')
    expect(agentTaskOf(main, 'ag1')?.phase).toBe('exploring')
  })

  test('the phase moves on the running step, not the parent', () => {
    const list = [agentTask('ag1', 'x', T0), task({ id: 's', parentId: 'a:ag1', agentId: 'ag1', status: 'running' })]
    const next = advancePhase(list, 'editing', null, 'ag1', T0)
    expect(next.find(t => t.id === 's')?.phase).toBe('editing')
    expect(agentTaskOf(next, 'ag1')?.phase).toBe('exploring')
  })

  test('its end completes it and its inferred steps, keeps declared ones, blocks on error', () => {
    const list = [
      agentTask('ag1', 'x', T0),
      task({ id: 'i', parentId: 'a:ag1', agentId: 'ag1' }),
      task({ id: 'd', parentId: 'a:ag1', agentId: 'ag1', source: 'declared', status: 'running' }),
    ]
    const done = settle(finishAgentTask(list, 'ag1', false, T0 + 1))
    expect(agentTaskOf(done, 'ag1')?.status).toBe('done')
    expect(agentTaskOf(done, 'ag1')?.progress).toBe(1)
    expect(done.find(t => t.id === 'i')?.status).toBe('done')
    expect(done.find(t => t.id === 'd')?.status).toBe('running')
    const failed = finishAgentTask(list, 'ag1', true, T0 + 1)
    expect(agentTaskOf(failed, 'ag1')?.status).toBe('blocked')
  })

  test("usage is charged to the loop's own work", () => {
    const list = [
      task({ id: 'r', status: 'running' }),
      task({ id: 'm', parentId: 'r', status: 'running' }),
      agentTask('ag1', 'x', T0),
      task({ id: 's', parentId: 'a:ag1', agentId: 'ag1', status: 'running' }),
    ]
    expect(chargeableFor(list, 'r', 'ag1')).toBe('s')
    expect(chargeableFor(list, 'r', undefined)).toBe('m')
    expect(chargeableFor(list.slice(0, 3), 'r', 'ag1')).toBe('a:ag1')
    expect(chargeableFor(list, 'r', 'unknown')).toBe('r')
  })

  test('rows: running first, finished ones for two minutes, main excluded', () => {
    const list = [agentTask('old', 'old', T0), agentTask('recent', 'recent', T0), agentTask('live', 'live', T0)]
    const agents = [agent('main', 'running'), agent('old', 'done', T0), agent('recent', 'done', T0 + 170_000), agent('live', 'running')]
    const rows = agentTaskRows(list, agents, T0 + 200_000)
    expect(rows.map(r => r.agentId)).toEqual(['live', 'recent'])
    expect(rows[0]?.isRunning).toBe(true)
  })

  test('something runs while only a subagent works', () => {
    expect(isAnythingRunning(false, [agent('main', 'idle'), agent('ag1', 'running')])).toBe(true)
    expect(isAnythingRunning(false, [agent('main', 'idle'), agent('ag1', 'done')])).toBe(false)
    expect(isAnythingRunning(true, [])).toBe(true)
  })

  test('the observer sees which agent made a call', () => {
    expect(summarizeCall('Edit', { file_path: '/a.ts' }, 'ok', 'ag1')).toBe('[agent ag1] Edit /a.ts -> ok')
  })
})

describe('per-agent tok/s', () => {
  test('each known loop gets a sample a tick, idle ones zero, gone ones dropped', () => {
    const known = new Set(['main', 'ag1'])
    let rates = appendRates({}, new Map([['main', 480], ['ag1', 96]]), known, 1200, 3)
    expect(rates).toEqual({ main: [100], ag1: [20] })
    rates = appendRates(rates, new Map([['ag1', 48]]), known, 1200, 3)
    expect(rates).toEqual({ main: [100, 0], ag1: [20, 10] })
    rates = appendRates(rates, new Map(), new Set(['main']), 1200, 3)
    expect(rates).toEqual({ main: [100, 0, 0] })
    rates = appendRates(rates, new Map([['main', 48]]), known, 1200, 3)
    expect(rates.main).toEqual([0, 0, 10])
  })
})

describe('agents the mod did not see spawn', () => {
  test('an unseen running agent joins and starts; statuses follow the list', () => {
    let r = mergeAgentList([agent('main', 'idle')], [{ id: 'ag1', type: 'general-purpose', description: 'Rebuild UI', status: 'running' }], T0)
    expect(r.nodes.map(n => n.id)).toEqual(['main', 'ag1'])
    expect(r.started).toEqual(['ag1'])
    r = mergeAgentList(r.nodes, [{ id: 'ag1', type: 'general-purpose', description: 'Rebuild UI', status: 'completed' }], T0 + 5)
    expect(r.nodes[1]?.status).toBe('done')
    expect(r.nodes[1]?.endedAt).toBe(T0 + 5)
    expect(r.started).toEqual([])
    // A message resumes it: running again, counted as a start.
    r = mergeAgentList(r.nodes, [{ id: 'ag1', type: 'general-purpose', description: 'Rebuild UI', status: 'running' }], T0 + 9)
    expect(r.nodes[1]?.status).toBe('running')
    expect(r.nodes[1]?.endedAt).toBeUndefined()
    expect(r.started).toEqual(['ag1'])
  })

  test('its task opens, and a finished one reopens when it runs again', () => {
    let tasks = openAgentTask([], 'ag1', 'Rebuild UI', T0)
    expect(agentTaskOf(tasks, 'ag1')?.status).toBe('running')
    tasks = settle(finishAgentTask(tasks, 'ag1', false, T0 + 1))
    expect(agentTaskOf(tasks, 'ag1')?.progress).toBe(1)
    tasks = settle(openAgentTask(tasks, 'ag1', 'Rebuild UI', T0 + 2))
    expect(agentTaskOf(tasks, 'ag1')?.status).toBe('running')
    // Re-scoped on resume: its bar starts over instead of sitting at 100%.
    expect(agentTaskOf(tasks, 'ag1')?.progress).toBe(0)
    expect(tasks.filter(t => t.agentId === 'ag1')).toHaveLength(1)
  })
})

describe('fewer writes', () => {
  test('the agent list keeps main and running ones, trims finished, and stays put', () => {
    const nodes = [agent('main', 'idle'), ...Array.from({ length: 40 }, (_, i) => agent(`f${i}`, 'done', T0 + i)), agent('live', 'running')]
    const kept = trimAgents(nodes, 30)
    expect(kept).toHaveLength(30)
    expect(kept.some(n => n.id === 'main')).toBe(true)
    expect(kept.some(n => n.id === 'live')).toBe(true)
    expect(kept.some(n => n.id === 'f39')).toBe(true)
    expect(kept.some(n => n.id === 'f0')).toBe(false)
    expect(trimAgents(kept, 30)).toEqual(kept)
  })

  test('agents finished before the mod saw them are left out of the list', () => {
    const r = mergeAgentList([agent('main', 'idle')], [{ id: 'old', type: 'x', description: 'x', status: 'completed' }], T0)
    expect(r.nodes.map(n => n.id)).toEqual(['main'])
  })

  test('current tools apply only when they change', () => {
    const nodes = [agent('main', 'running'), agent('ag1', 'running')]
    expect(applyCurrentTools(nodes, new Map())).toBe(nodes)
    const next = applyCurrentTools(nodes, new Map([['ag1', 'Reading a.ts']]))
    expect(next).not.toBe(nodes)
    expect(next[1]?.currentTool).toBe('Reading a.ts')
    expect(applyCurrentTools(next, new Map([['ag1', 'Reading a.ts']]))).toBe(next)
  })

  test('a running agent silent past the stale time no longer counts as live', () => {
    const nodes = [agent('main', 'running'), agent('ag1', 'running'), agent('ag2', 'running')]
    const live = liveAgents(nodes, new Map([['ag1', T0 + 590_000]]), T0 + 600_001, 600_000)
    expect(live.map(n => n.id)).toEqual(['ag1'])
  })
})
