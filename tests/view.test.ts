import { describe, expect, test } from 'claude-code/testing'

import type { Els, SidebarData } from '../hooks/view'
import { drawSidebar } from '../hooks/view'

const T0 = 1_000_000

// Stub constructors: the drawing only needs something to call; the tree's
// strings are what the test reads, wherever `h` put them.
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

function data(over: Partial<SidebarData>): SidebarData {
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

/** Every string in the tree, in document order, whatever shape `h` gave it. */
function strings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node)
  else if (Array.isArray(node)) for (const c of node) strings(c, out)
  else if (node !== null && typeof node === 'object') for (const v of Object.values(node as Record<string, unknown>)) strings(v, out)

  return out
}

describe('terminal decisions wrap', () => {
  const rationale = 'the throttle hides a second bug in the resize path that only shows once the layout settles after a frame'
  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
  const decision = { id: 'd1', at: T0, title: 'Approach', chosen: 'patch handler', rejected: [{ option: 'rewrite', reason: 'broad' }], rationale, confidence: 0.75, isReversible: true, evidence: [], files: 1, isPending: false }
  const pending = { ...decision, id: 'd2', title: long, isPending: true, options: ['keep', 'drop'], lean: 'keep', rationale: '' }

  test('a hundred-character rationale draws over two or three lines, uncut', () => {
    // 4a shows the rationale on a pending decision's rows, 4b on every decision's.
    const cases = [
      { view: { isCompact: false, isNoteOpen: false }, decisions: [{ ...pending, title: 'Throttle', rationale }] },
      { view: { isCompact: false, isNoteOpen: false, isDetail: true }, decisions: [decision] },
    ]
    for (const c of cases) {
      const all = strings(drawSidebar(ELS, data(c), ACT))
      const quoted = all.filter(s => {
        const t = s.replace(/"/g, '').trim()

        return t.split(' ').length >= 2 && rationale.includes(t)
      })
      expect(quoted.length).toBeGreaterThanOrEqual(2)
      expect(quoted.length).toBeLessThanOrEqual(3)
      expect(quoted.join(' ').replace(/"/g, '')).toBe(rationale)
      expect(all.some(s => s.includes(rationale.slice(0, 30)) && s.includes('…'))).toBe(false)
    }
  })

  test('a four-hundred-character title stops at three lines with an ellipsis', () => {
    const all = strings(drawSidebar(ELS, data({ view: { isCompact: false, isNoteOpen: false, isDetail: true }, decisions: [pending] }), ACT))
    const words = all.filter(s => /^word\d+/.test(s))
    expect(words).toHaveLength(3)
    expect(words[2]?.endsWith('…')).toBe(true)
    expect(words.join(' ').length).toBeLessThan(long.length)
  })
})
