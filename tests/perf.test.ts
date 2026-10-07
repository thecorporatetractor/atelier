import { expect, test } from 'claude-code/testing'

import { newTask } from '../hooks/lib/model'
import type { Els, SidebarData } from '../hooks/view'
import { drawSidebar } from '../hooks/view'

const T0 = 1_000_000

const stub = (type: string) => ((props: unknown) => ({ type, props })) as unknown
const ELS = { Box: stub('Box'), Text: stub('Text'), Button: stub('Button') } as Els

const ACT = {
  toggleUsageTab: () => {},
  toggleDetail: () => {},
  toggleStats: () => {},
  cycleRange: () => {},
  toggleCompact: () => {},
  toggleNote: () => {},
  stop: () => {},
  compact: () => {},
  tests: () => {},
  checkpoint: () => {},
  sendNote: () => {},
  answer: () => {},
  revert: () => {},
  openDiff: () => {},
  useHandoff: () => {},
  dismissHandoff: () => {},
  closeSearch: () => {},
}

const samples = (n: number) => Array.from({ length: 50 }, (_, i) => ((i * 37 + n) % 97) * 3)

/** A busy session: a 52×40 pane, 20 feed items, 30 tasks, 6 agents with samples, a full heatmap. */
function busy(): SidebarData {
  const root = newTask({ id: 'r', title: 'Import Claude Code sidebar TUI design handoff', status: 'running', confidence: 0.9, progress: 0.52 }, T0)
  const steps = Array.from({ length: 8 }, (_, i) => newTask({ id: `r.${i}`, title: `Step ${i}`, parentId: 'r', status: i < 4 ? 'done' : i === 4 ? 'running' : 'pending', progress: i < 4 ? 1 : i === 4 ? 0.5 : 0 }, T0))
  const agents = [
    { id: 'main', type: 'main', model: 'claude-opus-5-5', description: 'Main agent', status: 'running' as const, tokens: 220_000, startedAt: T0, isBackground: false },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, type: ['Explore', 'general-purpose', 'Plan', 'Explore', 'claude'][i] as string, model: 'claude-opus-5-5', description: `Agent ${i}`, status: i < 3 ? ('running' as const) : ('done' as const), tokens: 50_000 * (i + 1), startedAt: T0 + i * 1000, endedAt: i < 3 ? undefined : T0 + 50_000, isBackground: i === 1 })),
  ]
  const agentRates = Object.fromEntries(agents.map((a, i) => [a.id, samples(i)]))
  const agentTasks = agents.slice(1, 4).map((a, i) => ({ agentId: a.id, type: a.type, title: `Look into area ${i}`, status: 'running' as const, progress: 0.3 * (i + 1), confidence: 0.8, steps: steps.slice(0, 3), isRunning: true }))
  const feed = Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, at: T0 + i * 2000, text: `Edit src/render/file${i}.ts`, tool: 'Edit', state: i === 19 ? ('running' as const) : ('ok' as const), detail: '+12 −4', count: i % 3 === 0 ? 2 : undefined }))
  const tasks = [root, ...steps, ...Array.from({ length: 21 }, (_, i) => newTask({ id: `x${i}`, title: `Task ${i}`, parentId: 'r' }, T0))]
  expect(tasks).toHaveLength(30)

  return {
    now: T0 + 58_000,
    cols: 52,
    rows: 40,
    isWorking: true,
    turnStartedAt: T0,
    model: 'claude-opus-5-5',
    root,
    steps,
    agentTasks,
    runningAgents: 3,
    stats: null,
    statsRange: 'today',
    lastFile: '/p/src/render/resize.ts',
    sessionStartedAt: T0,
    projectRoot: '/p',
    usage: { contextTokens: 220_000, window: 1_000_000, percent: 22, costUsd: 5.34, rateLimits: [] },
    context: { used: 220_000, window: 1_000_000, system: 42_000, tools: 58_000, chat: 94_000, files: 26_000, perTurn: [4000, 6000, 8000, 5000, 7000, 9000] },
    rate: { samples: samples(0), peak: 288, sum: 5000, count: 40, tokens: 500_000 },
    agentRates,
    cache: { lastHitAt: T0 + 50_000, ttlMs: 300_000, readTokens: 900_000, inputTokens: 200_000 },
    spend: null,
    view: { isCompact: false, isNoteOpen: false },
    decisions: [
      { id: 'd1', at: T0 + 12_000, title: 'Approach', chosen: 'patch handler', rejected: [{ option: 'rewrite layout engine', reason: 'too broad' }], rationale: 'the handler is the narrowest fix', confidence: 0.75, isReversible: true, evidence: [], files: 1, isPending: false },
      { id: 'd2', at: T0 + 41_000, title: 'Tests', chosen: 'extend resize.test.ts', rejected: [{ option: 'new integration suite', reason: 'slow' }], rationale: '', confidence: 1, isReversible: true, evidence: [], files: 1, isPending: false },
    ],
    alerts: { attention: null, spins: [], drift: null },
    agents,
    observer: { calls: 3, inputTokens: 285, outputTokens: 12, lastKind: null, dropped: 0 },
    isObserverOn: true,
    feed,
    current: 'Editing file19.ts',
    confidence: { untestedEdits: 0, testsPassed: true, typecheckClean: null, lastPassAt: T0 + 50_000 },
    files: Array.from({ length: 6 }, (_, i) => ({ path: `/p/src/render/file${i}.ts`, added: 12, removed: 4, edits: 2, at: T0 + i * 1000 })),
    timeline: [
      { id: 't1', at: T0 + 12_000, kind: 'phase', text: 'planning' },
      { id: 't2', at: T0 + 41_000, kind: 'phase', text: 'verifying' },
      { id: 't3', at: T0 + 50_000, kind: 'phase', text: 'editing' },
    ],
    peers: [],
    handoff: null,
    search: null,
  }
}

/** Elements in the tree: every object with a `type`. */
function count(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((n: number, c) => n + count(c), 0)
  if (node !== null && typeof node === 'object') {
    const o = node as Record<string, unknown>

    return (typeof o.type === 'string' ? 1 : 0) + Object.values(o).reduce((n: number, v) => n + count(v), 0)
  }

  return 0
}

/** Drawing the busy sidebar stays small: rows of cells are merged into runs. */
// Measured on this fixture: 1244 elements / 90,210 bytes with one Text per
// cell, 906 / 66,361 with merged runs. The budget leaves a little headroom.
export const ELEMENT_BUDGET = 1000
export const JSON_BUDGET = 75_000

test('a busy sidebar draws within the element budget', () => {
  const tree = drawSidebar(ELS, busy(), ACT)
  const elements = count(tree)
  const bytes = JSON.stringify(tree).length
  expect(elements).toBeLessThan(ELEMENT_BUDGET)
  expect(bytes).toBeLessThan(JSON_BUDGET)
  // The per-agent charts are capped at four, and only running ones get one.
  const json = JSON.stringify(tree)
  expect((json.match(/"agent-chart-/g) ?? []).length).toBe(4)
  expect(json).not.toContain('"agent-chart-a4"')
})
