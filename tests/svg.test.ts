import { describe, expect, test } from 'claude-code/testing'

import { newTask } from '../hooks/lib/model'
import { statsRows } from '../hooks/stats'
import { drawSvg, escapeXml, svgAlt } from '../hooks/svg'
import type { SidebarData } from '../hooks/view'

const T0 = 1_000_000

function data(over: Partial<SidebarData> = {}): SidebarData {
  return {
    now: T0 + 60_000,
    cols: 52,
    rows: 40,
    isWorking: false,
    turnStartedAt: null,
    model: 'claude-opus-5-5',
    root: undefined,
    steps: [],
    agentTasks: [],
    runningAgents: 0,
    stats: null,
    statsRange: 'today',
    lastFile: null,
    sessionStartedAt: T0,
    projectRoot: '/p',
    usage: null,
    context: null,
    rate: { samples: [], peak: 0, sum: 0, count: 0, tokens: 0 },
    agentRates: {},
    cache: { lastHitAt: null, ttlMs: 300_000, readTokens: 0, inputTokens: 0 },
    spend: null,
    view: { isCompact: false, isNoteOpen: false },
    decisions: [],
    alerts: { attention: null, spins: [], drift: null },
    agents: [],
    observer: { calls: 0, inputTokens: 0, outputTokens: 0, lastKind: null, dropped: 0 },
    isObserverOn: false,
    feed: [],
    current: null,
    confidence: { untestedEdits: 0, testsPassed: null, typecheckClean: null },
    files: [],
    timeline: [],
    peers: [],
    handoff: null,
    search: null,
    ...over,
  }
}

describe('svg drawing', () => {
  test('text from the model and the person is escaped', () => {
    expect(escapeXml('<script>&"')).toBe('&lt;script&gt;&amp;&quot;')
    const evil = '<script>alert("x")</script> & "quotes"'
    const svg = drawSvg(
      data({
        root: newTask({ id: 'r', title: evil, status: 'running', confidence: 0.9 }, T0),
        files: [{ path: `/p/${evil}.ts`, added: 1, removed: 0, edits: 1, at: T0 }],
        decisions: [{ id: 'd1', at: T0, title: evil, chosen: evil, rejected: [{ option: evil, reason: evil }], rationale: evil, confidence: 0.5, isReversible: true, evidence: [], files: 1, isPending: false }],
        feed: [{ id: 'f', at: T0, text: evil, tool: 'Bash', state: 'ok', detail: evil }],
      }),
    )
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).not.toContain('onload')
    expect(svgAlt(data())).toContain('idle')
  })

  test('the tok/s chart is four rows tall', () => {
    const svg = drawSvg(data({ rate: { samples: [10, 50, 100], peak: 100, sum: 160, count: 3, tokens: 0 } }))
    const rows = [...svg.matchAll(/<text x="12" y="(\d+)" xml:space="preserve"><tspan fill="#2a2622">▍<\/tspan><tspan fill="#6b6258">(tok\/s|burn)/g)].map(m => [m[2], Number(m[1])] as const)
    const tok = rows.find(r => r[0] === 'tok/s')?.[1]
    const burn = rows.find(r => r[0] === 'burn')?.[1]
    expect(tok).toBeDefined()
    expect(burn).toBeDefined()
    // The tok/s row, then four chart rows of 20px, then burn.
    expect((burn ?? 0) - (tok ?? 0)).toBe(5 * 20)
    // The tallest bar spans the whole chart height.
    expect(svg).toContain('height="80"')
  })

  test('every agent gets a small tok/s chart under its row', () => {
    const agents = [
      { id: 'main', type: 'main', model: 'claude-opus-5-5', description: 'Main agent', status: 'running' as const, tokens: 100, startedAt: T0, isBackground: false },
      { id: 'a1', type: 'Explore', model: 'claude-opus-5-5', description: 'Look', status: 'running' as const, tokens: 50, startedAt: T0, isBackground: false },
    ]
    const svg = drawSvg(data({ agents, agentRates: { main: [10, 20, 40], a1: [] } }))
    // One baseline per chart: the main tok/s chart and one per agent.
    expect((svg.match(/<line /g) ?? []).length).toBe(1 + agents.length)
    expect(svg).toContain('peak 40 ')
    expect(svg).toContain('peak 0 ')
  })

  test('decision text wraps over up to three lines instead of being cut', () => {
    const rationale = 'the throttle hides a second bug in the resize path that only shows once the layout settles after a frame'
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
    const decision = { id: 'd1', at: T0, title: 'Approach', chosen: 'patch handler', rejected: [{ option: 'rewrite', reason: 'broad' }], rationale, confidence: 0.75, isReversible: true, evidence: [], files: 1, isPending: false }
    const pending = { ...decision, id: 'd2', title: long, isPending: true, options: ['keep', 'drop'], lean: 'keep', rationale: '' }
    // 4a shows the rationale on a pending decision's rows, 4b on every decision's.
    const cases = [
      { view: { isCompact: false, isNoteOpen: false }, decisions: [{ ...pending, title: 'Throttle', rationale }] },
      { view: { isCompact: false, isNoteOpen: false, isDetail: true }, decisions: [decision] },
    ]
    for (const c of cases) {
      const svg = drawSvg(data(c))
      const runs = [...svg.matchAll(/<tspan[^>]*font-style="italic">([^<]*)<\/tspan>/g)].map(m => (m[1] ?? '').replace(/&quot;/g, ''))
      // The rationale spans two or three italic runs, none of them cut.
      expect(runs.length).toBeGreaterThanOrEqual(2)
      expect(runs.length).toBeLessThanOrEqual(3)
      expect(runs.join(' ')).toBe(rationale)
      expect(runs.some(r => r.includes('…'))).toBe(false)
    }
    // A 400-character title stops after three lines with an ellipsis.
    const detail = drawSvg(data({ view: { isCompact: false, isNoteOpen: false, isDetail: true }, decisions: [pending] }))
    const words = [...detail.matchAll(/<tspan fill="#f0e8d8">(word\d+[^<]*)<\/tspan>/g)].map(m => m[1] ?? '')
    expect(words).toHaveLength(3)
    expect(words[2]?.endsWith('…')).toBe(true)
  })

  test('the 4a and 4b screens carry their sections', () => {
    const a = drawSvg(data())
    for (const name of ['Context', 'Usage', 'Decisions', 'Agents', 'Activity', 'Files', 'Timeline', 'stats']) expect(a).toContain(name)
    expect(a).not.toContain('resets')
    expect(a.indexOf('>Files<')).toBeGreaterThan(a.indexOf('>Activity<'))
    expect(a.indexOf('>Timeline<')).toBeGreaterThan(a.indexOf('>Files<'))
    const b = drawSvg(data({ view: { isCompact: false, isNoteOpen: false, isDetail: true } }))
    expect(b).toContain('Decisions')
    expect(b).not.toContain('Timeline')
    expect(b).not.toContain('>Context<')
    const s = drawSvg(data({ view: { isCompact: false, isNoteOpen: false, isStats: true } }))
    expect(s).toContain('collecting…')
    expect(s).not.toContain('Timeline')
  })

  test('the status block says Working while only a subagent runs, with its row', () => {
    const svg = drawSvg(
      data({
        runningAgents: 2,
        agentTasks: [{ agentId: 'a1', type: 'Explore', title: 'Look around', status: 'running', progress: 0.4, confidence: 0.8, steps: [], isRunning: true }],
      }),
    )
    expect(svg).toContain('Working')
    expect(svg).toContain('2 agents')
    expect(svg).toContain('Look around')
    expect(svg).toContain('40%')
  })

  test('stats rows cover every section once there are figures', () => {
    const range = {
      cost: 12.5,
      requests: 40,
      turns: 10,
      avgTurnMs: 42_000,
      sessions: 2,
      compactions: 1,
      tokens: { input: 1000, output: 500, cacheRead: 9000, cacheWrite: 800 },
      cacheHitRate: 0.9,
      linesAdded: 120,
      linesRemoved: 30,
      filesEdited: 6,
      testsPassed: 3,
      testsFailed: 1,
      observer: { calls: 12, input: 3000, output: 200 },
      observerShare: 0.05,
    }
    const rows = statsRows(
      {
        today: range,
        week: range,
        month: range,
        all: range,
        dailyCost: Array.from({ length: 30 }, (_, i) => i),
        dailyTokens: Array.from({ length: 30 }, (_, i) => i * 10),
        models: [{ model: 'claude-opus-5-5', cost: 10, tokens: 5000, requests: 30, share: 0.8 }],
        projects: [{ project: '/home/me/app', cost: 12.5, tokens: 11_300, turns: 10 }],
        tools: [{ tool: 'Edit', calls: 20, failRate: 0.05, avgMs: 300 }],
        agents: [{ type: 'Explore', spawns: 2, tokens: 4000, avgMs: 90_000, failRate: 0 }],
        activeDays: 3,
        since: '2026-10-05',
      },
      'week',
      51,
    )
    const headers = rows.filter(r => r.kind === 'header').map(r => (r.kind === 'header' ? r.title : ''))
    expect(headers).toEqual(['Spend', 'Tokens', 'Models', 'Projects', 'Tools', 'Agents', 'Activity', 'Observer'])
    expect(rows.some(r => r.kind === 'bar' && r.runs[0]?.t.startsWith('cache hit') && r.filled === Math.round(0.9 * r.total))).toBe(true)
    expect(statsRows(null, 'today', 51).some(r => r.kind === 'line' && r.runs[0]?.t === 'collecting…')).toBe(true)
  })
})
