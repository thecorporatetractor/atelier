import type { EngineInterface, PluginState, ModelUsage, PluginOptions, Register, Timer } from 'claude-code'

import type {
  AgentNode,
  Confidence,
  ContextView,
  DayStats,
  FeedItem,
  FileStat,
  PeerSession,
  SearchHit,
  Summary,
  Task,
  TaskStatus,
  TimelineEntry,
  SpendView,
  UsageView,
  ViewState,
} from '../types'
import {
  type Attempts,
  type DecisionInput,
  advancePhase,
  appendRates,
  applyCurrentTools,
  isSame,
  liveAgents,
  trimAgents,
  mergeAgentList,
  openAgentTask,
  agentTask,
  agentTaskOf,
  addDay,
  answerPending,
  chargeableFor,
  emptyDay,
  isEmptyDay,
  pruneDays,
  summarizeStats,
  finishAgentTask,
  applyDecisions,
  agentTaskRows,
  applyDiff,
  basename,
  callDetail,
  childrenOf,
  describeCall,
  feedLine,
  ease,
  elapsed,
  extractJson,
  isTypecheckCommand,
  isVerifyCommand,
  looksTrivial,
  newTask,
  parseDiff,
  patchStats,
  phaseOfTool,
  PHASES,
  pushFeedItem,
  recordAttempt,
  settle,
  signatureOf,
  summarizeCall,
} from './lib/model'
import { RANGES, type RangeKey } from './stats'
import {
  DECISION_SYSTEM,
  OBSERVER_SYSTEM,
  type Options,
  readOptions,
  SEED_SYSTEM,
  SUMMARY_SYSTEM,
  type TestCommand,
  burned,
  dayKey,
  decisionBrief,
  declaredParent,
  handoffText,
  mapStatus,
  taskBrief,
} from './lib/support'
import { drawSidebar } from './view'

// The Stats screen's range (`r` cycles it): a drawing choice, this load's only.
let statsRange: RangeKey = 'today'

const PANE = 'atelier'
const TITLE = 'Atelier'
const SHARE = 0.35
// The frame's left and right edges sit outside the body columns.
const FRAME = 2
const FEED_MAX = 20
const TIMELINE_MAX = 200
const FILES_MAX = 100
const SUMMARIES_MAX = 40
const PEER_TTL = 15 * 60_000
const RATE_MS = 3000
const RATE_WINDOW = 20
const CACHE_TTL_MS = 5 * 60_000
const SPEND_DAYS = 62

// The sidebar's state: each value read and written through $.state with
// its literal reference, the way the directory's review reads the code.
type Held = PluginState['atelier']

const TASKS = { plugin: 'atelier', key: 'tasks' } as const

async function readTasks($: EngineInterface): Promise<Held['tasks']> {
  return (await $.state.get(TASKS)).value ?? []
}

async function updateTasks($: EngineInterface, change: (value: Held['tasks']) => Held['tasks']): Promise<Held['tasks']> {
  for (;;) {
    const held = await $.state.get(TASKS)
    const value = change(held.value ?? [])
    if ((await $.state.set(TASKS, value, { ifVersion: held.version })).isSet) return value
  }
}

const ROOT = { plugin: 'atelier', key: 'rootId' } as const

async function readRoot($: EngineInterface): Promise<Held['rootId']> {
  return (await $.state.get(ROOT)).value ?? null
}

async function updateRoot($: EngineInterface, change: (value: Held['rootId']) => Held['rootId']): Promise<Held['rootId']> {
  for (;;) {
    const held = await $.state.get(ROOT)
    const value = change(held.value ?? null)
    if ((await $.state.set(ROOT, value, { ifVersion: held.version })).isSet) return value
  }
}

const AGENTS = { plugin: 'atelier', key: 'agents' } as const

async function readAgents($: EngineInterface): Promise<Held['agents']> {
  return (await $.state.get(AGENTS)).value ?? []
}

async function updateAgents($: EngineInterface, change: (value: Held['agents']) => Held['agents']): Promise<Held['agents']> {
  for (;;) {
    const held = await $.state.get(AGENTS)
    const value = change(held.value ?? [])
    if ((await $.state.set(AGENTS, value, { ifVersion: held.version })).isSet) return value
  }
}

const USAGE = { plugin: 'atelier', key: 'usage' } as const

async function readUsage($: EngineInterface): Promise<Held['usage']> {
  return (await $.state.get(USAGE)).value ?? null
}

async function updateUsage($: EngineInterface, change: (value: Held['usage']) => Held['usage']): Promise<Held['usage']> {
  for (;;) {
    const held = await $.state.get(USAGE)
    const value = change(held.value ?? null)
    if ((await $.state.set(USAGE, value, { ifVersion: held.version })).isSet) return value
  }
}

const FEED = { plugin: 'atelier', key: 'feed' } as const

async function readFeed($: EngineInterface): Promise<Held['feed']> {
  return (await $.state.get(FEED)).value ?? []
}

async function updateFeed($: EngineInterface, change: (value: Held['feed']) => Held['feed']): Promise<Held['feed']> {
  for (;;) {
    const held = await $.state.get(FEED)
    const value = change(held.value ?? [])
    if ((await $.state.set(FEED, value, { ifVersion: held.version })).isSet) return value
  }
}

const CURRENT = { plugin: 'atelier', key: 'current' } as const

async function readCurrent($: EngineInterface): Promise<Held['current']> {
  return (await $.state.get(CURRENT)).value ?? null
}

async function updateCurrent($: EngineInterface, change: (value: Held['current']) => Held['current']): Promise<Held['current']> {
  for (;;) {
    const held = await $.state.get(CURRENT)
    const value = change(held.value ?? null)
    if ((await $.state.set(CURRENT, value, { ifVersion: held.version })).isSet) return value
  }
}

const FILES = { plugin: 'atelier', key: 'files' } as const

async function readFiles($: EngineInterface): Promise<Held['files']> {
  return (await $.state.get(FILES)).value ?? []
}

async function updateFiles($: EngineInterface, change: (value: Held['files']) => Held['files']): Promise<Held['files']> {
  for (;;) {
    const held = await $.state.get(FILES)
    const value = change(held.value ?? [])
    if ((await $.state.set(FILES, value, { ifVersion: held.version })).isSet) return value
  }
}

const ALERTS = { plugin: 'atelier', key: 'alerts' } as const

async function readAlerts($: EngineInterface): Promise<Held['alerts']> {
  return (await $.state.get(ALERTS)).value ?? { attention: null, spins: [], drift: null }
}

async function updateAlerts($: EngineInterface, change: (value: Held['alerts']) => Held['alerts']): Promise<Held['alerts']> {
  for (;;) {
    const held = await $.state.get(ALERTS)
    const value = change(held.value ?? { attention: null, spins: [], drift: null })
    if ((await $.state.set(ALERTS, value, { ifVersion: held.version })).isSet) return value
  }
}

const VIEW = { plugin: 'atelier', key: 'view' } as const

async function readView($: EngineInterface): Promise<Held['view']> {
  return (await $.state.get(VIEW)).value ?? {
  isCompact: false,
  isNoteOpen: false,
  usageTab: 'limits',
  isDetail: false,
}
}

async function updateView($: EngineInterface, change: (value: Held['view']) => Held['view']): Promise<Held['view']> {
  for (;;) {
    const held = await $.state.get(VIEW)
    const value = change(held.value ?? {
  isCompact: false,
  isNoteOpen: false,
  usageTab: 'limits',
  isDetail: false,
})
    if ((await $.state.set(VIEW, value, { ifVersion: held.version })).isSet) return value
  }
}

const OBSERVER = { plugin: 'atelier', key: 'observer' } as const

async function readObserver($: EngineInterface): Promise<Held['observer']> {
  return (await $.state.get(OBSERVER)).value ?? {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  lastKind: null,
  dropped: 0,
}
}

async function updateObserver($: EngineInterface, change: (value: Held['observer']) => Held['observer']): Promise<Held['observer']> {
  for (;;) {
    const held = await $.state.get(OBSERVER)
    const value = change(held.value ?? {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  lastKind: null,
  dropped: 0,
})
    if ((await $.state.set(OBSERVER, value, { ifVersion: held.version })).isSet) return value
  }
}

const TIMELINE = { plugin: 'atelier', key: 'timeline' } as const

async function readTimeline($: EngineInterface): Promise<Held['timeline']> {
  return (await $.state.get(TIMELINE)).value ?? []
}

async function updateTimeline($: EngineInterface, change: (value: Held['timeline']) => Held['timeline']): Promise<Held['timeline']> {
  for (;;) {
    const held = await $.state.get(TIMELINE)
    const value = change(held.value ?? [])
    if ((await $.state.set(TIMELINE, value, { ifVersion: held.version })).isSet) return value
  }
}

const CONFIDENCE = { plugin: 'atelier', key: 'confidence' } as const

async function readConfidence($: EngineInterface): Promise<Held['confidence']> {
  return (await $.state.get(CONFIDENCE)).value ?? {
  untestedEdits: 0,
  testsPassed: null,
  typecheckClean: null,
}
}

async function updateConfidence($: EngineInterface, change: (value: Held['confidence']) => Held['confidence']): Promise<Held['confidence']> {
  for (;;) {
    const held = await $.state.get(CONFIDENCE)
    const value = change(held.value ?? {
  untestedEdits: 0,
  testsPassed: null,
  typecheckClean: null,
})
    if ((await $.state.set(CONFIDENCE, value, { ifVersion: held.version })).isSet) return value
  }
}

const PEERS = { plugin: 'atelier', key: 'peers' } as const

async function readPeers($: EngineInterface): Promise<Held['peers']> {
  return (await $.state.get(PEERS)).value ?? []
}

async function updatePeers($: EngineInterface, change: (value: Held['peers']) => Held['peers']): Promise<Held['peers']> {
  for (;;) {
    const held = await $.state.get(PEERS)
    const value = change(held.value ?? [])
    if ((await $.state.set(PEERS, value, { ifVersion: held.version })).isSet) return value
  }
}

const HANDOFF = { plugin: 'atelier', key: 'handoff' } as const

async function readHandoff($: EngineInterface): Promise<Held['handoff']> {
  return (await $.state.get(HANDOFF)).value ?? null
}

async function updateHandoff($: EngineInterface, change: (value: Held['handoff']) => Held['handoff']): Promise<Held['handoff']> {
  for (;;) {
    const held = await $.state.get(HANDOFF)
    const value = change(held.value ?? null)
    if ((await $.state.set(HANDOFF, value, { ifVersion: held.version })).isSet) return value
  }
}

const SEARCH = { plugin: 'atelier', key: 'search' } as const

async function readSearch($: EngineInterface): Promise<Held['search']> {
  return (await $.state.get(SEARCH)).value ?? null
}

async function updateSearch($: EngineInterface, change: (value: Held['search']) => Held['search']): Promise<Held['search']> {
  for (;;) {
    const held = await $.state.get(SEARCH)
    const value = change(held.value ?? null)
    if ((await $.state.set(SEARCH, value, { ifVersion: held.version })).isSet) return value
  }
}

const DECISIONS = { plugin: 'atelier', key: 'decisions' } as const

async function readDecisions($: EngineInterface): Promise<Held['decisions']> {
  return (await $.state.get(DECISIONS)).value ?? []
}

async function updateDecisions($: EngineInterface, change: (value: Held['decisions']) => Held['decisions']): Promise<Held['decisions']> {
  for (;;) {
    const held = await $.state.get(DECISIONS)
    const value = change(held.value ?? [])
    if ((await $.state.set(DECISIONS, value, { ifVersion: held.version })).isSet) return value
  }
}

const RATE = { plugin: 'atelier', key: 'rate' } as const

async function readRate($: EngineInterface): Promise<Held['rate']> {
  return (await $.state.get(RATE)).value ?? { samples: [], peak: 0, sum: 0, count: 0, tokens: 0 }
}

async function updateRate($: EngineInterface, change: (value: Held['rate']) => Held['rate']): Promise<Held['rate']> {
  for (;;) {
    const held = await $.state.get(RATE)
    const value = change(held.value ?? { samples: [], peak: 0, sum: 0, count: 0, tokens: 0 })
    if ((await $.state.set(RATE, value, { ifVersion: held.version })).isSet) return value
  }
}

const CACHE = { plugin: 'atelier', key: 'cache' } as const

async function readCache($: EngineInterface): Promise<Held['cache']> {
  return (await $.state.get(CACHE)).value ?? { lastHitAt: null, ttlMs: CACHE_TTL_MS, readTokens: 0, inputTokens: 0 }
}

async function updateCache($: EngineInterface, change: (value: Held['cache']) => Held['cache']): Promise<Held['cache']> {
  for (;;) {
    const held = await $.state.get(CACHE)
    const value = change(held.value ?? { lastHitAt: null, ttlMs: CACHE_TTL_MS, readTokens: 0, inputTokens: 0 })
    if ((await $.state.set(CACHE, value, { ifVersion: held.version })).isSet) return value
  }
}

const CONTEXT = { plugin: 'atelier', key: 'context' } as const

async function readContext($: EngineInterface): Promise<Held['context']> {
  return (await $.state.get(CONTEXT)).value ?? null
}

async function updateContext($: EngineInterface, change: (value: Held['context']) => Held['context']): Promise<Held['context']> {
  for (;;) {
    const held = await $.state.get(CONTEXT)
    const value = change(held.value ?? null)
    if ((await $.state.set(CONTEXT, value, { ifVersion: held.version })).isSet) return value
  }
}

const SPEND = { plugin: 'atelier', key: 'spend' } as const

async function readSpend($: EngineInterface): Promise<Held['spend']> {
  return (await $.state.get(SPEND)).value ?? null
}

async function updateSpend($: EngineInterface, change: (value: Held['spend']) => Held['spend']): Promise<Held['spend']> {
  for (;;) {
    const held = await $.state.get(SPEND)
    const value = change(held.value ?? null)
    if ((await $.state.set(SPEND, value, { ifVersion: held.version })).isSet) return value
  }
}

const STATS = { plugin: 'atelier', key: 'stats' } as const

async function readStats($: EngineInterface): Promise<Held['stats']> {
  return (await $.state.get(STATS)).value ?? null
}

async function updateStats($: EngineInterface, change: (value: Held['stats']) => Held['stats']): Promise<Held['stats']> {
  for (;;) {
    const held = await $.state.get(STATS)
    const value = change(held.value ?? null)
    if ((await $.state.set(STATS, value, { ifVersion: held.version })).isSet) return value
  }
}

const AGENT_RATES = { plugin: 'atelier', key: 'agentRates' } as const

async function readAgentRates($: EngineInterface): Promise<Held['agentRates']> {
  return (await $.state.get(AGENT_RATES)).value ?? {}
}

async function updateAgentRates($: EngineInterface, change: (value: Held['agentRates']) => Held['agentRates']): Promise<Held['agentRates']> {
  for (;;) {
    const held = await $.state.get(AGENT_RATES)
    const value = change(held.value ?? {})
    if ((await $.state.set(AGENT_RATES, value, { ifVersion: held.version })).isSet) return value
  }
}

let opt: Options = readOptions({})
let isPlaced = false
let asked: number | undefined
let buffer: string[] = []
let flushTimer: Timer | undefined
let isFlushing = false
let attempts: Attempts = {}
let turnId: string | undefined
let isTurnRunning = false
let flushesSinceDrift = 0
let isSummaryDirty = false
let sessionId = ''
let root = ''
let lastPeerAt = 0
let ticker: Timer | undefined
let tick = 0
let turnStartedAt: number | null = null
let lastFile: string | null = null
let sessionStartedAt = Date.now()
let streamChars = 0
// The same characters by loop (`main` or a subagent id), for each agent's own chart.
let streamCharsBy = new Map<string, number>()
// Loops that got a live sample this turn: the others get their turn's average.
const sampledBy = new Set<string>()
let streamCount = 0
let sampler: Timer | undefined
let idleSamples = 0
let readChars = 0
let lastCost: number | undefined
let lastStepModel = ''
let pendingSpend: Record<string, number> = {}
// This process's usage since the last stats write; summed into the store's day.
let pendingStats: DayStats = emptyDay()
let isStatsTimerOn = false
let peersTimer: Timer | undefined
let syncTimer: Timer | undefined
// The busiest values (feed, current call, each agent's tool) change on every
// tool call; they are kept here and published together at most every 300ms,
// since every state write redraws the whole sidebar.
const PUBLISH_MS = 1000
let liveFeed: FeedItem[] | undefined
let isFeedDirty = false
let liveCurrent: string | null | undefined
const liveTools = new Map<string, string | undefined>()
let publishTimer: Timer | undefined
// Last tool call or step per subagent: one listed as running but silent for
// STALE_MS no longer keeps the redraw timer alive.
const lastActivity = new Map<string, number>()
const STALE_MS = 30_000
// What happened since the last decisions pass; it runs after DECIDE_MS of quiet.
const DECIDE_MS = 5_000
let decideLines: string[] = []
let decideTimer: Timer | undefined
let isDeciding = false
let lastPhase: string | undefined
let lastMeasured: number | undefined
let isBreakdownLogged = false
// Step usage waiting for the sampler's tick, per loop ('main' or an agent id):
// one state write a tick, not one per step. `counted` is what the steps of a
// loop's current turn already added, so its turn.complete adds the rest only.
type StepTally = { tokens: number; cacheRead: number; input: number; isHit: boolean }
let pendingSteps = new Map<string, StepTally>()
const counted = new Map<string, number>()
let sampledTokens = 0
const shown = new Map<string, number>()

// ---------- state helpers ----------

function nowMs() {
  return Date.now()
}

function rid(prefix: string) {
  return (String(prefix) + String(nowMs().toString(36)) + String(Math.floor(Math.random() * 1e6).toString(36)))
}

async function setTasks($: EngineInterface, fn: (list: Task[], rootId: string | null) => Task[]) {
  const rootId = await readRoot($)
  // A change that changes nothing (a phase already reached) writes nothing.
  if (isSame(settle(fn(await readTasks($), rootId)), await readTasks($))) return
  await updateTasks($, list => settle(fn(list, rootId)))
  isSummaryDirty = true
  startTicker($)
}

async function editFeed($: EngineInterface, fn: (list: FeedItem[]) => FeedItem[]) {
  if (liveFeed === undefined) liveFeed = await readFeed($)
  liveFeed = fn(liveFeed)
  isFeedDirty = true
  schedulePublish($)
}

async function pushFeed($: EngineInterface, item: FeedItem) {
  await editFeed($, list => pushFeedItem(list, item, FEED_MAX))
}

async function endFeed($: EngineInterface, feedId: string, isFailed: boolean, detail: string | undefined) {
  await editFeed($, list => list.map(f => (f.id === feedId ? { ...f, state: isFailed ? ('error' as const) : ('ok' as const), detail } : f)))
}

function setCurrent($: EngineInterface, text: string | null, agentId: string | undefined, tool: string | undefined) {
  liveCurrent = text
  liveTools.set(agentId ?? 'main', tool)
  schedulePublish($)
}

function schedulePublish($: EngineInterface) {
  if (publishTimer !== undefined) return
  publishTimer = $.clock.after(PUBLISH_MS, () => {
    publishTimer = undefined
    void quietly(publishLive($))
  })
}

/** Writes what changed since the last publish: one write per value, none when equal. */
async function publishLive($: EngineInterface) {
  if (isFeedDirty && liveFeed !== undefined) {
    isFeedDirty = false
    const feed = liveFeed
    await updateFeed($, () => feed)
  }
  if (liveCurrent !== undefined) {
    const current = liveCurrent
    liveCurrent = undefined
    if (current !== (await readCurrent($))) await updateCurrent($, () => current)
  }
  if (liveTools.size > 0) {
    const tools = new Map(liveTools)
    liveTools.clear()
    const agents = await readAgents($)
    if (applyCurrentTools(agents, tools) !== agents) await updateAgents($, list => [...applyCurrentTools(list, tools)])
  }
}

async function addTimeline($: EngineInterface, kind: TimelineEntry['kind'], text: string, feedId?: string) {
  const entry: TimelineEntry = { id: rid('t'), at: nowMs(), kind, text, feedId }
  await updateTimeline($, list => [...list, entry].slice(-TIMELINE_MAX))
}

async function countObserver($: EngineInterface, usage: ModelUsage | undefined, estimate: number, kind?: string) {
  stat(d => {
    d.observer = {
      calls: 1,
      input: usage === undefined ? estimate : usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
      output: usage === undefined ? 4 : usage.output_tokens,
    }
  })
  await updateObserver($, o => ({
    ...o,
    calls: o.calls + 1,
    inputTokens: o.inputTokens + (usage === undefined ? estimate : usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens),
    outputTokens: o.outputTokens + (usage === undefined ? 4 : usage.output_tokens),
    lastKind: kind ?? o.lastKind,
  }))
}

// Eases shown bars toward their targets and keeps elapsed times live; stops
// itself once nothing moves and nothing runs.
function startTicker($: EngineInterface) {
  if (ticker !== undefined) return
  ticker = $.clock.every(250, () => {
    tick += 1
    void quietly(stepTicker($))
  })
}

async function stepTicker($: EngineInterface) {
  const list = await readTasks($)
  const agents = await readAgents($)
  let isMoving = false
  for (const t of list) {
    const was = shown.get(t.id) ?? 0
    const eased = ease(was, t.progress)
    if (eased !== was) isMoving = true
    shown.set(t.id, eased)
  }
  const isRunning = isTurnRunning || liveAgents(agents, lastActivity, nowMs(), STALE_MS).length > 0
  if (isMoving || (isRunning && tick % 20 === 0)) $.ui.invalidate('ui.render')
  if (!isMoving && !isRunning && ticker !== undefined) {
    ticker.cancel()
    ticker = undefined
  }
}

// ---------- the pane ----------

function columnsFor(terminal: number) {
  return Math.max(20, Math.floor(terminal * SHARE) - FRAME)
}

// Opened unasked, a pane is placed only from 144 columns; below that it
// waits, so the first prompt (a person's act) asks again and places it.
async function open($: EngineInterface, terminal?: number) {
  asked = terminal === undefined ? asked : columnsFor(terminal)
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: asked })
  isPlaced = opened.isPlaced
}

// ---------- seeding a task from a prompt ----------

async function seed($: EngineInterface, text: string, rootId: string) {
  const kind = await $.model.classify(text.slice(0, 2000), ['question-or-chat', 'multi-step-work', 'single-small-change'], {
    model: opt.observerModel,
  })
  await countObserver($, undefined, Math.ceil(text.length / 4) + 80, kind)
  if (kind === 'question-or-chat') {
    await setTasks($, list => list.filter(t => t.id !== rootId))
    await updateRoot($, id => (id === rootId ? null : id))

    return
  }
  const r = await $.model.complete({
    model: opt.observerModel,
    system: SEED_SYSTEM,
    prompt: text.slice(0, 6000),
    maxTokens: 400,
    effort: 'low',
    timeoutMs: 20_000,
  })
  await countObserver($, r.usage, 0)
  if (!r.isAnswered) return
  const plan = extractJson(r.text) as { goal?: unknown; steps?: unknown } | undefined
  if (plan === undefined || typeof plan !== 'object') return
  const goal = typeof plan.goal === 'string' ? plan.goal.slice(0, 80) : undefined
  const steps = Array.isArray(plan.steps) ? plan.steps.filter((s): s is string => typeof s === 'string').slice(0, 7) : []
  const now = nowMs()
  await setTasks($, list => {
    const hasDeclared = list.some(t => t.parentId === rootId && t.source === 'declared')
    const named = list.map(t => (t.id === rootId ? { ...t, title: goal ?? t.title, confidence: steps.length > 0 ? 0.7 : 0.3 } : t))
    if (hasDeclared) return named

    return [
      ...named,
      ...steps.map((s, i) => newTask({ id: (String(rootId) + '.' + String(i)), title: s.slice(0, 60), parentId: rootId, order: now + i, confidence: 0.6 }, now)),
    ]
  })
  await addTimeline($, 'task', ('Goal: ' + String(goal ?? text.slice(0, 50))))
}

/** A subagent's task gets its plan from its own instructions, as a prompt does. */
async function seedAgent($: EngineInterface, agentId: string, prompt: string) {
  const r = await $.model.complete({
    model: opt.observerModel,
    system: SEED_SYSTEM,
    prompt: prompt.slice(0, 6000),
    maxTokens: 400,
    effort: 'low',
    timeoutMs: 20_000,
  })
  await countObserver($, r.usage, 0, 'seed-agent')
  if (!r.isAnswered) return
  const plan = extractJson(r.text) as { goal?: unknown; steps?: unknown } | undefined
  if (plan === undefined || typeof plan !== 'object') return
  const goal = typeof plan.goal === 'string' ? plan.goal.slice(0, 80) : undefined
  const steps = Array.isArray(plan.steps) ? plan.steps.filter((s): s is string => typeof s === 'string').slice(0, 7) : []
  const now = nowMs()
  await setTasks($, list => {
    const own = agentTaskOf(list, agentId)
    if (own === undefined) return list
    const hasSteps = list.some(t => t.parentId === own.id)
    const named = list.map(t => (t.id === own.id ? { ...t, title: goal ?? t.title, confidence: steps.length > 0 ? 0.7 : 0.3 } : t))
    if (hasSteps || own.status !== 'running') return named

    return [
      ...named,
      ...steps.map((s, i) =>
        newTask({ id: (String(own.id) + '.' + String(i)), agentId, title: s.slice(0, 60), parentId: own.id, order: now + i, confidence: 0.6 }, now),
      ),
    ]
  })
}

// ---------- the observer ----------

function scheduleFlush($: EngineInterface) {
  if (!opt.isObserverOn) {
    buffer = []

    return
  }
  flushTimer?.cancel()
  if (buffer.length >= opt.batchSize) {
    flushTimer = undefined
    void quietly(flush($))

    return
  }
  flushTimer = $.clock.after(opt.debounceMs, () => {
    flushTimer = undefined
    void quietly(flush($))
  })
}

async function flush($: EngineInterface) {
  if (isFlushing || buffer.length === 0) return
  isFlushing = true
  const batch = buffer.splice(0, buffer.length)
  try {
    const lines = batch.join('\n')
    const kind = await $.model.classify(lines, ['noise', 'progress', 'new_work', 'blocked'], { model: opt.observerModel })
    await countObserver($, undefined, Math.ceil(lines.length / 4) + 80, kind ?? 'unknown')
    if (kind === undefined || kind === 'noise') return
    const rootId = await readRoot($)
    const list = await readTasks($)
    const goal = list.find(t => t.id === rootId)?.title ?? '(none)'
    const r = await $.model.complete({
      model: opt.observerModel,
      system: OBSERVER_SYSTEM,
      prompt: ('Root task id: ' + String(rootId ?? 'none') + '\nGoal: ' + String(goal) + '\nTasks: ' + String(taskBrief(list)) + '\nThe batch reads as: ' + String(kind) + '\nRecent tool calls:\n' + String(lines)),
      maxTokens: 700,
      effort: 'low',
      timeoutMs: 25_000,
    })
    await countObserver($, r.usage, 0)
    const diff = r.isAnswered ? parseDiff(r.text) : undefined
    if (diff === undefined) {
      await updateObserver($, o => ({ ...o, dropped: o.dropped + 1 }))

      return
    }
    const now = nowMs()
    await setTasks($, (l, id) => applyDiff(l, diff, now, id))
    await recordDecisions($, diff.decisions, now)
    for (const a of diff.add) await addTimeline($, 'task', ('+ ' + String(a.title)))
    flushesSinceDrift += 1
    if (flushesSinceDrift >= 4) {
      flushesSinceDrift = 0
      await checkDrift($, goal, lines)
    }
  } finally {
    isFlushing = false
    if (buffer.length >= opt.batchSize) scheduleFlush($)
  }
}

async function recordDecisions($: EngineInterface, incoming: DecisionInput[] | undefined, now: number) {
  if (incoming === undefined || incoming.length === 0) return
  await updateDecisions($, list => applyDecisions(list, incoming, now))
  for (const d of incoming) await addTimeline($, 'task', ('Decision: ' + String(d.title) + String(d.chosen !== undefined ? (' (' + String(d.chosen) + ')') : '')))
}

// ---------- decisions: a Haiku pass of their own ----------

/** Notes something a decision may hang on; the pass runs once things go quiet. */
function noteForDecisions($: EngineInterface, line: string) {
  if (!opt.isObserverOn) return
  decideLines = [...decideLines, line.replace(/\s+/g, ' ').slice(0, 500)].slice(-30)
  decideTimer?.cancel()
  decideTimer = $.clock.after(DECIDE_MS, () => {
    decideTimer = undefined
    void quietly(decide($))
  })
}

/** Asks Haiku for new decisions and changes to known ones, from what happened since the last pass. */
async function decide($: EngineInterface) {
  if (isDeciding || decideLines.length === 0) return
  isDeciding = true
  const lines = decideLines
  decideLines = []
  try {
    const known = await readDecisions($)
    const r = await $.model.complete({
      model: opt.observerModel,
      system: DECISION_SYSTEM,
      prompt: ('Known decisions: ' + String(decisionBrief(known)) + '\nSince the last check:\n' + String(lines.join('\n'))),
      maxTokens: 700,
      effort: 'low',
      timeoutMs: 25_000,
    })
    await countObserver($, r.usage, 0, 'decisions')
    const diff = r.isAnswered ? parseDiff(r.text) : undefined
    if (diff !== undefined) await recordDecisions($, diff.decisions, nowMs())
  } finally {
    isDeciding = false
    if (decideLines.length > 0) noteForDecisions($, decideLines.pop() as string)
  }
}

async function checkDrift($: EngineInterface, goal: string, lines: string) {
  if (goal === '(none)') return
  const text = ('Goal: ' + String(goal) + '\nRecent activity:\n' + String(lines))
  const kind = await $.model.classify(text, ['on-task', 'off-task'], { model: opt.observerModel })
  await countObserver($, undefined, Math.ceil(text.length / 4) + 60, kind)
  await updateAlerts($, a => ({ ...a, drift: kind === 'off-task' ? 'May be off-task' : null }))
}

async function reconcile($: EngineInterface, answer: string) {
  const rootId = await readRoot($)
  const list = await readTasks($)
  if (rootId === null || !opt.isObserverOn) return
  const batch = buffer.splice(0, buffer.length).join('\n')
  const r = await $.model.complete({
    model: opt.observerModel,
    system: OBSERVER_SYSTEM,
    prompt: ('The turn just ended. Reconcile: complete the steps that are finished, merge inferred tasks that duplicate declared ones, complete the root (id ' + String(rootId) + ') only if its goal looks met; if the agent is waiting on the person, set the root\'s status to waiting.\nTasks: ' + String(taskBrief(list)) + '\nLast tool calls:\n' + String(batch || '(none)') + '\nThe agent\'s final answer:\n' + String(answer.slice(0, 2500))),
    maxTokens: 700,
    effort: 'low',
    timeoutMs: 25_000,
  })
  await countObserver($, r.usage, 0, 'reconcile')
  const diff = r.isAnswered ? parseDiff(r.text) : undefined
  if (diff === undefined) return
  const now = nowMs()
  await recordDecisions($, diff.decisions, now)
  await setTasks($, (l, id) => {
    const applied = applyDiff(l, diff, now, id)

    // The root is inferred; its own completion comes through `complete`.
    return applied.map(t => (t.id === rootId && diff.complete.includes(rootId) ? { ...t, status: 'done' as const, phase: 'done' as const } : t))
  })
  if (diff.complete.includes(rootId)) await addTimeline($, 'task', 'Goal met')
}

// ---------- usage ----------

async function refreshUsage($: EngineInterface) {
  const u = await $.session.usage()
  const view: UsageView = {
    contextTokens: u.context.tokens,
    window: u.context.window,
    percent: u.context.percent,
    costUsd: u.cost?.usd,
    rateLimits: u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
  }
  await updateUsage($, () => view)
}

/** Charges usage to the loop's own work: a subagent's to its task, the main loop's under the root. */
async function attribute($: EngineInterface, amount: number, agentId?: string) {
  if (amount <= 0) return
  const rootId = await readRoot($)
  await updateTasks($, list => {
    const id = chargeableFor(list, rootId, agentId)

    return list.map(t => (t.id === id ? { ...t, tokens: t.tokens + amount } : t))
  })
}

// ---------- alerts ----------

async function attention($: EngineInterface, text: string) {
  await updateAlerts($, a => ({ ...a, attention: text }))
  await setTasks($, (list, rootId) => list.map(t => (t.id === rootId && t.status === 'running' ? { ...t, status: 'waiting' as const } : t)))
  $.ui.toast(('Atelier: ' + String(text)))
}

async function clearAttention($: EngineInterface) {
  const a = await readAlerts($)
  if (a.attention === null) return
  await updateAlerts($, x => ({ ...x, attention: null }))
  await setTasks($, (list, rootId) => list.map(t => (t.id === rootId && t.status === 'waiting' ? { ...t, status: 'running' as const } : t)))
}

// ---------- declared tasks ----------

async function declare($: EngineInterface, externalId: string, subject: string, agentId?: string) {
  const now = nowMs()
  await setTasks($, (list, rootId) => [
    ...list,
    newTask(
      { id: ('d' + String(externalId)), externalId, agentId, title: subject.slice(0, 80), parentId: declaredParent(list, rootId, agentId), source: 'declared', phase: 'planning', confidence: 1, order: now },
      now,
    ),
  ])
  buffer.push(('TaskCreate declared task d' + String(externalId) + ': ' + String(subject)))
  await addTimeline($, 'task', ('Declared: ' + String(subject)))
}

async function declareUpdate($: EngineInterface, externalId: string, status: string | undefined, subject: string | undefined) {
  const now = nowMs()
  const mapped = mapStatus(status)
  await setTasks($, list => {
    if (status === 'deleted') return list.filter(t => t.externalId !== externalId)

    return list.map(t =>
      t.externalId === externalId
        ? {
            ...t,
            title: subject ?? t.title,
            status: mapped ?? t.status,
            phase: mapped === 'done' ? ('done' as const) : mapped === 'running' && t.phase === 'planning' ? ('exploring' as const) : t.phase,
            startedAt: mapped === 'running' ? now : t.startedAt,
            updatedAt: now,
          }
        : t,
    )
  })
  if (mapped === 'done') {
    const done = (await readTasks($)).find(t => t.externalId === externalId)
    if (done !== undefined) await addTimeline($, 'task', ('Done: ' + String(done.title)))
  }
}

async function declareTodos($: EngineInterface, todos: readonly { content: string; status: string }[], agentId?: string) {
  const now = nowMs()
  // Each loop keeps its own todo list: one loop's TodoWrite replaces only its own.
  const prefix = agentId === undefined ? 'todo:' : ('todo:' + String(agentId) + ':')
  const isOwn = (t: Task) => t.externalId?.startsWith('todo:') === true && t.agentId === agentId
  await setTasks($, (list, rootId) => {
    const kept = list.filter(t => !(t.source === 'declared' && isOwn(t)))
    const old = new Map(list.filter(isOwn).map(t => [t.externalId, t]))

    return [
      ...kept,
      ...todos.map((todo, i) => {
        const externalId = (String(prefix) + String(todo.content))
        const was = old.get(externalId)
        const status = mapStatus(todo.status) ?? 'pending'

        return {
          ...(was ?? newTask({ id: rid('d'), agentId, title: todo.content.slice(0, 80), source: 'declared', confidence: 1 }, now)),
          externalId,
          parentId: was?.parentId ?? declaredParent(list, rootId, agentId),
          status,
          phase: status === 'done' ? ('done' as const) : (was?.phase ?? ('planning' as const)),
          order: now + i,
          updatedAt: now,
        }
      }),
    ]
  })
}

// ---------- files, confidence, spins, hotspots ----------

async function recordFile($: EngineInterface, path: string, result: unknown, input: Record<string, unknown>) {
  const { added, removed } = patchStats(result, input)
  await updateFiles($, list => {
    const was = list.find(f => f.path === path)
    const fileStat: FileStat = {
      path,
      added: (was?.added ?? 0) + added,
      removed: (was?.removed ?? 0) + removed,
      edits: (was?.edits ?? 0) + 1,
      at: nowMs(),
    }

    return [...list.filter(f => f.path !== path), fileStat].slice(-FILES_MAX)
  })
  const isFirst = (await readFiles($)).find(f => f.path === path)?.edits === 1
  stat(d => {
    d.linesAdded = added
    d.linesRemoved = removed
    d.filesEdited = isFirst ? 1 : 0
  })
  if (isFirst) await addTimeline($, 'file', ('Touched ' + String(basename(path))))
  await updateConfidence($, c => ({ ...c, untestedEdits: c.untestedEdits + 1, testsPassed: null }))
}

async function recordVerify($: EngineInterface, command: string, isOk: boolean) {
  if (!isTypecheckCommand(command)) {
    stat(d => {
      d.testsPassed = isOk ? 1 : 0
      d.testsFailed = isOk ? 0 : 1
    })
  }
  await updateConfidence($, (c): Confidence => {
    if (isTypecheckCommand(command)) return { ...c, typecheckClean: isOk }

    return { ...c, testsPassed: isOk, untestedEdits: isOk ? 0 : c.untestedEdits, lastPassAt: isOk ? nowMs() : c.lastPassAt }
  })
}

async function recordSpin($: EngineInterface, signature: string, isFailed: boolean, text: string) {
  const r = recordAttempt(attempts, signature, isFailed)
  attempts = r.attempts
  const warning = r.warning
  const spinsOf = (a: { spins: { signature: string; count: number; text: string }[] }) =>
    warning === undefined
      ? a.spins.filter(s => s.signature !== signature)
      : [...a.spins.filter(s => s.signature !== signature), { signature, count: r.count, text: (String(warning) + ': ' + String(text)) }].slice(-3)
  // Most calls change no warning: no write, no redraw.
  const alerts = await readAlerts($)
  if (!isSame(spinsOf(alerts), alerts.spins)) await updateAlerts($, a => ({ ...a, spins: spinsOf(a) }))
  if (warning !== undefined && r.count === 3) {
    $.ui.toast(('Atelier: ' + String(warning)))
    await addTimeline($, 'alert', (String(warning) + ': ' + String(text)))
  }
}

// ---------- actions ----------

async function interrupt($: EngineInterface) {
  if (turnId === undefined) {
    $.ui.toast('Atelier: no turn is running')

    return
  }
  await $.turn.abort({ turnId })
}

async function compactNow($: EngineInterface) {
  try {
    const r = await $.session.compact({})
    $.ui.toast(r.skip === undefined ? 'Atelier: compacted' : 'Atelier: compaction skipped')
  } catch {
    $.ui.toast('Atelier: compact only between turns')
  }
}

async function runTests($: EngineInterface) {
  const id = rid('f')
  await pushFeed($, { id, at: nowMs(), text: ('Running ' + String(opt.testCommand)), tool: 'atelier', state: 'running' })
  const r = await runTestCommand($, opt.testCommand)
  const isOk = r.exitCode === 0
  await editFeed($, list => list.map(f => (f.id === id ? { ...f, state: isOk ? ('ok' as const) : ('error' as const), text: ('Tests ' + String(isOk ? 'passed' : ('failed (' + String(r.exitCode) + ')'))) } : f)))
  await recordVerify($, opt.testCommand, isOk)
  $.ui.toast(('Atelier: tests ' + String(isOk ? 'passed' : 'failed')))
}

async function runTestCommand($: EngineInterface, command: TestCommand) {
  const init = { cwd: root || undefined, timeoutMs: 600_000 }
  switch (command) {
    case 'pnpm test':
      return $.process.run(['pnpm', 'test'], init)
    case 'yarn test':
      return $.process.run(['yarn', 'test'], init)
    case 'bun test':
      return $.process.run(['bun', 'test'], init)
    case 'make test':
      return $.process.run(['make', 'test'], init)
    case 'pytest':
      return $.process.run(['pytest'], init)
    case 'cargo test':
      return $.process.run(['cargo', 'test'], init)
    case 'go test':
      return $.process.run(['go', 'test', './...'], init)
    default:
      return $.process.run(['npm', 'test'], init)
  }
}

async function commitCheckpoint($: EngineInterface) {
  const answer = await $.ui.ask('Stage every change (git add -A) and commit a checkpoint?', ['Commit', 'Cancel'])
  if (answer !== 'Commit') return
  const add = await $.process.run(['git', 'add', '-A'], { cwd: root || undefined })
  const r = add.exitCode === 0 ? await $.process.run(['git', 'commit', '-m', 'checkpoint (atelier)'], { cwd: root || undefined }) : add
  $.ui.toast(r.exitCode === 0 ? 'Atelier: checkpoint committed' : ('Atelier: commit failed: ' + String((r.stderr || r.stdout).slice(0, 80))))
}

async function sendNote($: EngineInterface, text: string) {
  if (text.trim() === '') return
  await $.prompt.submit({ text: ('Note from the person (via the sidebar): ' + String(text.trim())) })
  await updateView($, v => ({ ...v, isNoteOpen: false }))
}

async function openDiff($: EngineInterface, path: string) {
  try {
    await $.command.run({ command: 'diff' })
  } catch {
    $.ui.toast(('Atelier: run /diff to see the changes to ' + String(basename(path))))
  }
}

// ---------- across sessions ----------

async function publishPeer($: EngineInterface) {
  const now = nowMs()
  if (sessionId === '' || now - lastPeerAt < 10_000) return
  lastPeerAt = now
  const rootId = await readRoot($)
  const rootTask = (await readTasks($)).find(t => t.id === rootId)
  const peer: PeerSession = {
    id: sessionId,
    title: rootTask?.title ?? 'idle',
    progress: rootTask?.progress ?? 0,
    status: rootTask?.status ?? 'pending',
    cwd: root,
    at: now,
  }
  await $.store.set(('peer:' + String(sessionId)), peer)
}

async function loadPeers($: EngineInterface) {
  const now = nowMs()
  const peers: PeerSession[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('peer:') || key === ('peer:' + String(sessionId))) continue
    const p = (await $.store.get(key)) as PeerSession | undefined
    if (p === undefined || now - p.at > PEER_TTL) {
      if (p !== undefined) await $.store.delete(key)
      continue
    }
    peers.push(p)
  }
  await updatePeers($, () => peers)
}

async function readSummaries($: EngineInterface): Promise<Summary[]> {
  const v = await $.store.get('summaries')

  return Array.isArray(v) ? (v as Summary[]) : []
}

// Precomputed at each turn's end: session.end has 1.5s, too little for a model call.
async function saveSummary($: EngineInterface) {
  if (!isSummaryDirty || !opt.isObserverOn || sessionId === '') return
  isSummaryDirty = false
  const list = await readTasks($)
  if (list.length === 0) return
  const files = (await readFiles($)).map(f => basename(f.path)).join(', ')
  const r = await $.model.complete({
    model: opt.observerModel,
    system: SUMMARY_SYSTEM,
    prompt: ('Tasks: ' + String(taskBrief(list)) + '\nFiles changed: ' + String(files || 'none')),
    maxTokens: 500,
    effort: 'low',
    timeoutMs: 25_000,
  })
  await countObserver($, r.usage, 0, 'summary')
  const parsed = r.isAnswered ? (extractJson(r.text) as Partial<Summary> | undefined) : undefined
  if (parsed === undefined || typeof parsed !== 'object') return
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, 12) : [])
  const summary: Summary = {
    sessionId,
    root,
    at: nowMs(),
    done: strs(parsed.done),
    remaining: strs(parsed.remaining),
    questions: strs(parsed.questions),
    text: typeof parsed.text === 'string' ? parsed.text.slice(0, 600) : '',
  }
  const all = await readSummaries($)
  await $.store.set('summaries', [...all.filter(s => s.sessionId !== sessionId), summary].slice(-SUMMARIES_MAX))
}

async function loadHandoff($: EngineInterface) {
  const all = await readSummaries($)
  const last = all.filter(s => s.root === root && s.sessionId !== sessionId && nowMs() - s.at < 14 * 86_400_000).at(-1)
  await updateHandoff($, () => last ?? null)
}

async function search($: EngineInterface, query: string) {
  const q = query.toLowerCase()
  const hits: SearchHit[] = []
  for (const s of await readSummaries($)) {
    for (const line of [s.text, ...s.done, ...s.remaining, ...s.questions]) {
      if (line.toLowerCase().includes(q)) hits.push({ at: s.at, text: line, source: basename(s.root) })
    }
  }
  for (const t of await readTasks($)) {
    if (t.title.toLowerCase().includes(q)) hits.push({ at: t.updatedAt, text: t.title, source: 'this session' })
  }
  hits.sort((a, b) => b.at - a.at)
  await updateSearch($, () => ({ query, hits: hits.slice(0, 20) }))

  return hits
}

// ---------- decisions ----------

async function answerDecision($: EngineInterface, id: string, option: string) {
  const d = (await readDecisions($)).find(x => x.id === id)
  if (d === undefined) return
  await $.prompt.fill({ text: option === '' ? (String(d.title) + ': ') : (String(d.title) + ': go with ' + String(option) + '.') })
}

async function revertDecision($: EngineInterface, id: string) {
  const d = (await readDecisions($)).find(x => x.id === id)
  if (d === undefined) return
  const answer = await $.ui.ask(('Ask Claude to revert "' + String(d.title) + ': ' + String(d.chosen) + '"?'), ['Ask Claude', 'Cancel'])
  if (answer !== 'Ask Claude') return
  await updateDecisions($, list => list.map(x => (x.id === id ? { ...x, isReverted: true } : x)))
  await $.prompt.submit({
    text: ('Please revert the change from the decision "' + String(d.title) + ': ' + String(d.chosen) + '"' + String(d.outsidePlan !== undefined ? (' (' + String(d.outsidePlan) + ')') : '') + ' and keep to the plan.'),
  })
}

// ---------- view toggles, kept across sessions ----------

async function setView($: EngineInterface, fn: (v: ViewState) => ViewState) {
  const saved = await updateView($, fn)
  await $.store.set('view', { usageTab: saved.usageTab, isDetail: saved.isDetail, isStats: saved.isStats })
}

async function loadView($: EngineInterface) {
  const saved = (await $.store.get('view')) as Partial<ViewState> | undefined
  if (saved === undefined || typeof saved !== 'object') return
  await updateView($, v => ({
    ...v,
    usageTab: saved.usageTab === 'api' ? ('api' as const) : ('limits' as const),
    isDetail: saved.isDetail === true,
    isStats: saved.isStats === true,
  }))
}

// ---------- tok/s, cache, context, spend ----------

// One sample every 1.2s while a response streams; zeros keep the window
// scrolling after it, and the sampler stops once the window is all quiet.
function startSampler($: EngineInterface) {
  if (sampler !== undefined) return
  idleSamples = 0
  sampler = $.clock.every(RATE_MS, () => {
    void quietly(sampleTick($))
  })
}

async function sampleTick($: EngineInterface) {
  const chars = streamChars
  streamChars = 0
  const rate = chars / 4 / (RATE_MS / 1000)
  if (rate > 0) sampledTokens += 1
  idleSamples = streamCount > 0 || rate > 0 ? 0 : idleSamples + 1
  // Two quiet ticks and the sampler stops; the next step starts it again.
  if (idleSamples >= 2 && sampler !== undefined) {
    sampler.cancel()
    sampler = undefined
  }
  await pushSamples($, [rate])
  await pushAgentSamples($)
  await flushSteps($)
}

/** One sample per loop: each agent in the list, zero when it streamed nothing this tick. */
async function pushAgentSamples($: EngineInterface) {
  const by = streamCharsBy
  streamCharsBy = new Map()
  const known = new Set((await readAgents($)).map(a => a.id))
  for (const [key, n] of by) if (n > 0) sampledBy.add(key)
  await updateAgentRates($, rates => appendRates(rates, by, known, RATE_MS, RATE_WINDOW))
}

async function pushSamples($: EngineInterface, rates: number[]) {
  await updateRate($, r => {
    const samples = [...r.samples, ...rates].slice(-RATE_WINDOW)
    const live = rates.filter(x => x > 0)

    return {
      ...r,
      samples,
      peak: Math.max(0, ...samples),
      sum: r.sum + live.reduce((a, b) => a + b, 0),
      count: r.count + live.length,
    }
  })
}

/** Tallies one step's usage for its loop; no state write until the tick. */
function tallyStep(usage: ModelUsage & { model?: string }, agentId: string | undefined) {
  if (usage.model !== undefined) lastStepModel = usage.model
  statTokens(usage.model ?? lastStepModel, usage, 1)
  const key = agentId ?? 'main'
  const was = pendingSteps.get(key) ?? { tokens: 0, cacheRead: 0, input: 0, isHit: false }
  const tokens = burned(usage)
  pendingSteps.set(key, {
    tokens: was.tokens + tokens,
    cacheRead: was.cacheRead + usage.cache_read_input_tokens,
    input: was.input + usage.input_tokens + usage.cache_creation_input_tokens,
    isHit: was.isHit || usage.cache_read_input_tokens > 0,
  })
  counted.set(key, (counted.get(key) ?? 0) + tokens)
}

/** Writes the tallied steps: agent nodes, cache, tok/min, task attribution. */
async function flushSteps($: EngineInterface) {
  if (pendingSteps.size === 0) return
  const batch = pendingSteps
  pendingSteps = new Map()
  const now = nowMs()
  let tokens = 0
  let cacheRead = 0
  let input = 0
  let isHit = false
  for (const t of batch.values()) {
    tokens += t.tokens
    cacheRead += t.cacheRead
    input += t.input
    isHit = isHit || t.isHit
  }
  await updateCache($, c => ({
    ...c,
    lastHitAt: isHit ? now : c.lastHitAt,
    readTokens: c.readTokens + cacheRead,
    inputTokens: c.inputTokens + input,
  }))
  await updateRate($, r => ({ ...r, tokens: r.tokens + tokens }))
  await updateAgents($, list => list.map(a => (batch.has(a.id) ? { ...a, tokens: a.tokens + (batch.get(a.id) as StepTally).tokens } : a)))
  for (const [key, t] of batch) await attribute($, t.tokens, key === 'main' ? undefined : key)
}

/**
 * A turn's end: whatever its steps did not already count (the step hook
 * missed, or never ran) is added from the turn's own usage, so the figures
 * hold either way; a main turn no sample caught gets its average drawn.
 */
async function settleTurn($: EngineInterface, agentId: string | undefined, usage: (ModelUsage & { model?: string }) | undefined, durationMs: number) {
  await flushSteps($)
  const key = agentId ?? 'main'
  const seen = counted.get(key) ?? 0
  counted.set(key, 0)
  if (usage === undefined) return 0
  const extra = Math.max(0, burned(usage) - seen)
  if (extra > 0) {
    const share = burned(usage) > 0 ? extra / burned(usage) : 0
    // What the step hook missed, by the turn's own model; a request when none was seen.
    statTokens(usage.model ?? lastStepModel, usage, seen === 0 ? 1 : 0, share)
    const now = nowMs()
    await updateCache($, c => ({
      ...c,
      lastHitAt: seen === 0 && usage.cache_read_input_tokens > 0 ? now : c.lastHitAt,
      readTokens: c.readTokens + Math.round(usage.cache_read_input_tokens * share),
      inputTokens: c.inputTokens + Math.round((usage.input_tokens + usage.cache_creation_input_tokens) * share),
    }))
    await updateRate($, r => ({ ...r, tokens: r.tokens + extra }))
  }
  if (agentId === undefined && sampledTokens === 0 && usage.output_tokens > 0 && durationMs > 0) {
    const n = Math.max(1, Math.min(RATE_WINDOW, Math.round(durationMs / RATE_MS)))
    const rate = usage.output_tokens / (durationMs / 1000)
    await pushSamples($, Array.from({ length: n }, () => rate))
  }
  if (agentId === undefined) sampledTokens = 0
  // A loop no live sample caught gets its turn's average across its chart.
  if (!sampledBy.has(key) && usage.output_tokens > 0 && durationMs > 0) {
    const n = Math.max(1, Math.min(RATE_WINDOW, Math.round(durationMs / RATE_MS)))
    const rate = usage.output_tokens / (durationMs / 1000)
    await updateAgentRates($, rates => ({ ...rates, [key]: [...(rates[key] ?? []), ...Array.from({ length: n }, () => rate)].slice(-RATE_WINDOW) }))
  }
  sampledBy.delete(key)

  return extra
}

type ContextSplit = { used: number; window: number; threshold?: number; system: number; tools: number; chat: number; isEstimate: boolean }

/** One line to the debug log, once; never in the way of what follows. */
function debugLog($: EngineInterface, text: string) {
  if (isBreakdownLogged) return
  isBreakdownLogged = true
  try {
    void quietly(Promise.resolve($.ui.log(text, { to: 'debug' })))
  } catch {
    // The log is a courtesy.
  }
}

/**
 * /context's categories folded into the heatmap's four. Without a breakdown
 * (the call refused, or none computed) the plain figures still draw it: the
 * whole as messages, the file reads inside them, marked as an estimate.
 */
async function refreshContext($: EngineInterface, plain?: { tokens?: number; window: number }) {
  let split: ContextSplit | undefined
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    const b = u.context.breakdown
    if (b !== undefined) {
      let system = 0
      let tools = 0
      let chat = 0
      for (const c of b.categories) {
        if (c.kind !== 'used' || c.isDeferred) continue
        if (/message/i.test(c.name)) chat += c.tokens
        else if (/tool/i.test(c.name)) tools += c.tokens
        else system += c.tokens
      }
      split = { used: b.totalTokens, window: b.rawMaxTokens, threshold: b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined, system, tools, chat, isEstimate: false }
    } else {
      plain = plain ?? u.context
      debugLog($, 'atelier: session.usage answered without a context breakdown; the heatmap is an estimate')
    }
  } catch (err) {
    debugLog($, ('atelier: session.usage({ breakdown }) failed: ' + String(String(err).slice(0, 200)) + '; the heatmap is an estimate'))
  }
  if (split === undefined) {
    const u = await readUsage($)
    const used = plain?.tokens ?? u?.contextTokens
    const window = plain?.window ?? u?.window ?? 0
    if (used === undefined || window <= 0) return
    split = { used, window, system: 0, tools: 0, chat: used, isEstimate: true }
  }
  const prev = await readContext($)
  const used = split.used
  // A drop means compaction: file reads in context start over.
  if (prev !== null && used < prev.used) readChars = 0
  // Files are an estimate: what Read returned, inside the messages' share.
  const files = Math.min(split.chat, Math.round(readChars / 4))
  const grew = prev === null ? 0 : used - prev.used
  const view: ContextView = {
    used,
    window: split.window,
    threshold: split.threshold,
    system: split.system,
    tools: split.tools,
    chat: split.chat - files,
    files,
    perTurn: grew > 0 ? [...(prev?.perTurn ?? []), grew].slice(-24) : (prev?.perTurn ?? []),
    isEstimate: split.isEstimate,
  }
  await updateContext($, () => view)
}

type SpendBook = Record<string, { total: number; byModel: Record<string, number> }>

/** Cost deltas, charged to the model of the latest response, kept per day. */
async function flushSpend($: EngineInterface) {
  const now = await $.clock.now()
  const entries = Object.entries(pendingSpend)
  pendingSpend = {}
  const raw = await $.store.get('spend')
  const book: SpendBook = raw !== null && typeof raw === 'object' ? (raw as SpendBook) : {}
  if (entries.length > 0) {
    const day = dayKey(now)
    const was = book[day] ?? { total: 0, byModel: {} }
    for (const [model, v] of entries) {
      was.total += v
      was.byModel[model] = (was.byModel[model] ?? 0) + v
    }
    book[day] = was
    const keep = Object.keys(book).sort().slice(-SPEND_DAYS)
    for (const k of Object.keys(book)) if (!keep.includes(k)) delete book[k]
    await $.store.set('spend', book)
  }
  const sumSince = (days: number) =>
    Object.entries(book)
      .filter(([k]) => k >= dayKey(now - (days - 1) * 86_400_000))
      .reduce((n, [, v]) => n + v.total, 0)
  const byModel: Record<string, number> = {}
  for (const [k, v] of Object.entries(book)) {
    if (k < dayKey(now - 29 * 86_400_000)) continue
    for (const [m, x] of Object.entries(v.byModel)) byModel[m] = (byModel[m] ?? 0) + x
  }
  const view: SpendView = {
    today: book[dayKey(now)]?.total ?? 0,
    week: sumSince(7),
    month: sumSince(30),
    byModel,
    daily: Array.from({ length: 14 }, (_, i) => book[dayKey(now - (13 - i) * 86_400_000)]?.total ?? 0),
  }
  await updateSpend($, () => view)
}

// ---------- agents the mod did not see spawn ----------

let lastSyncAt = 0
let syncIdleTicks = 0
let hasRunningAgents = false
// Spawns seen in agent.spawn, matched to the agent list by description and type.
type PendingSpawn = { description: string; type: string; prompt: string; model: string; isBackground: boolean; at: number }
let pendingSpawns: PendingSpawn[] = []
let syncSoon: Timer | undefined

function scheduleSync($: EngineInterface) {
  syncSoon?.cancel()
  syncSoon = $.clock.after(300, () => {
    syncSoon = undefined
    void quietly(syncAgents($))
  })
}

/**
 * Brings in agents from the engine's list: ones started before the mod loaded
 * and ones a message resumed raise no agent.spawn here. Each that starts
 * running gets its task opened (and planned, when new) like a spawned one.
 */
async function syncAgents($: EngineInterface) {
  lastSyncAt = nowMs()
  const list = await $.agent.list()
  const before = await readAgents($)
  const merged = mergeAgentList(before, list, nowMs())
  const nodes = trimAgents(merged.nodes)
  hasRunningAgents = nodes.some(n => n.id !== 'main' && n.status === 'running')
  const shape = (ns: readonly AgentNode[]) => ns.map(n => (String(n.id) + ':' + String(n.status)))
  if (merged.started.length === 0 && isSame(shape(nodes), shape(before))) return
  for (const id of merged.started) lastActivity.set(id, nowMs())
  await updateAgents($, () => trimAgents(mergeAgentList(before, list, nowMs()).nodes))
  for (const id of merged.started) {
    const info = list.find(a => a.id === id)
    const title = info?.description || info?.type || 'agent'
    // A spawn this mod saw carries the agent's instructions and model.
    const spawn = pendingSpawns.find(p => p.description === info?.description && p.type === info?.type)
    if (spawn !== undefined) {
      pendingSpawns = pendingSpawns.filter(p => p !== spawn)
      await updateAgents($, nodes => nodes.map(n => (n.id === id ? { ...n, model: n.model || spawn.model, isBackground: spawn.isBackground } : n)))
      await addTimeline($, 'task', ('Agent: ' + String(title)))
    }
    const isNew = agentTaskOf(await readTasks($), id) === undefined
    const now = nowMs()
    await setTasks($, tasks => openAgentTask(tasks, id, title, now))
    if (isNew && opt.isObserverOn && title !== '') void quietly(seedAgent($, id, spawn?.prompt ?? title))
  }
  // Agents the list calls finished close their tasks, as their turn.complete would.
  for (const n of merged.nodes) {
    if (n.id === 'main' || (n.status !== 'done' && n.status !== 'error')) continue
    const own = agentTaskOf(await readTasks($), n.id)
    if (own !== undefined && own.status === 'running') {
      const now = nowMs()
      await setTasks($, tasks => finishAgentTask(tasks, n.id, n.status === 'error', now))
    }
  }
  startTicker($)
}

// ---------- usage stats ----------
// Recorders only touch `pendingStats`; `flushStats` sums it into the store.

function statTokens(model: string, u: ModelUsage, requests: number, share = 1) {
  const k = {
    input: Math.round(u.input_tokens * share),
    output: Math.round(u.output_tokens * share),
    cacheRead: Math.round(u.cache_read_input_tokens * share),
    cacheWrite: Math.round(u.cache_creation_input_tokens * share),
  }
  const one = emptyDay()
  one.requests = requests
  one.tokens = k
  one.byModel = { [model || 'unknown']: { ...k, cost: 0, requests } }
  if (root !== '') one.byProject = { [root]: { cost: 0, tokens: k.input + k.output + k.cacheRead + k.cacheWrite, turns: 0 } }
  pendingStats = addDay(pendingStats, one)
}

function stat(fn: (d: DayStats) => void) {
  const one = emptyDay()
  fn(one)
  pendingStats = addDay(pendingStats, one)
}

function statCost(model: string, usd: number) {
  stat(d => {
    d.cost = usd
    d.byModel = { [model || 'unknown']: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: usd, requests: 0 } }
    if (root !== '') d.byProject = { [root]: { cost: usd, tokens: 0, turns: 0 } }
  })
}

async function flushStats($: EngineInterface) {
  const delta = pendingStats
  pendingStats = emptyDay()
  const raw = (await $.store.get('stats')) as { days?: Record<string, DayStats> } | undefined
  let days = raw !== undefined && typeof raw === 'object' && raw.days !== undefined ? raw.days : undefined
  if (days === undefined) days = await seedStatsFromSpend($)
  // Days follow Claude Code's clock, not the system's.
  const now = await $.clock.now()
  if (!isEmptyDay(delta)) {
    const day = dayKey(now)
    days = pruneDays({ ...days, [day]: addDay(days[day] ?? emptyDay(), delta) })
    await $.store.set('stats', { days })
  }
  await updateStats($, () => summarizeStats(days, now))
}

/** The first stats write carries over the spend book kept before stats existed. */
async function seedStatsFromSpend($: EngineInterface): Promise<Record<string, DayStats>> {
  const raw = await $.store.get('spend')
  const book = raw !== null && typeof raw === 'object' ? (raw as SpendBook) : {}
  const days: Record<string, DayStats> = {}
  for (const [k, v] of Object.entries(book)) {
    const d = emptyDay()
    d.cost = v.total
    d.byModel = Object.fromEntries(Object.entries(v.byModel).map(([m, c]) => [m, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: c, requests: 0 }]))
    days[k] = d
  }

  return days
}

/** A session's first stats: count it once, then write and summarize the store's days. */
async function startStats($: EngineInterface) {
  await countSession($)
  await flushStats($)
}

/** Counts a session once, however often a hot reload replays session.start. */
async function countSession($: EngineInterface) {
  const seen = (await $.store.get('sessionsSeen')) as string[] | undefined
  const list = Array.isArray(seen) ? seen : []
  if (sessionId === '' || list.includes(sessionId)) return
  await $.store.set('sessionsSeen', [...list, sessionId].slice(-200))
  stat(d => {
    d.sessions = 1
  })
}

// ---------- background work ----------

/** Lets background work run; a failure there is dropped, never thrown into a hook. */
function quietly(work: Promise<unknown>) {
  work.catch(() => {})
}

/** Fills in the model of an agent first seen through the agent list. */
async function fillAgentModel($: EngineInterface, agentId: string, model: string) {
  // Read first: most steps find the model already set and write nothing.
  const list = await readAgents($)
  if (list.some(a => a.id === agentId && a.model === '')) await updateAgents($, l => l.map(a => (a.id === agentId && a.model === '' ? { ...a, model } : a)))
}

/** What follows a main turn: close its steps, save a summary, tell the other sessions. */
async function afterTurn($: EngineInterface, answer: string) {
  await reconcile($, answer)
  await saveSummary($)
  await publishPeer($)
}

// ---------- model steps ----------

function startStep($: EngineInterface, agentId: string | undefined, model: string) {
  if (agentId !== undefined) {
    lastActivity.set(agentId, nowMs())
    void quietly(fillAgentModel($, agentId, model))
  }
  streamCount += 1
  startSampler($)
}

function endStep($: EngineInterface, agentId: string | undefined, result: { answer: string; usage: (ModelUsage & { model?: string }) | null }) {
  streamCount = Math.max(0, streamCount - 1)
  if (result.usage !== null) {
    // The sampler reads characters; four make a token, as in its rate.
    const chars = result.usage.output_tokens * 4
    streamChars += chars
    streamCharsBy.set(agentId ?? 'main', (streamCharsBy.get(agentId ?? 'main') ?? 0) + chars)
    tallyStep(result.usage, agentId)
  }
  const answer = result.answer.trim()
  if (answer === '') return
  if (agentId === undefined) buffer.push(('Agent said: ' + String(answer.replace(/\s+/g, ' ').slice(0, 300))))
  noteForDecisions($, (String(agentId === undefined ? 'Agent' : ('[agent ' + String(agentId) + ']')) + ' said: ' + String(answer)))
}

// ---------- tool calls ----------

/** Claude's own task tools: their calls feed the task list, not the observer's batch. */
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TodoWrite'])

/** A call between tool.call and its PostToolUse, by its tool_use_id. */
type OpenCall = { feedId: string; tool: string; input: Record<string, unknown>; text: string; agentId?: string; calledAt: number }
const openCalls = new Map<string, OpenCall>()

async function startCall($: EngineInterface, input: Record<string, unknown>, tool: string, toolUseId: string, agentId: string | undefined) {
  const text = describeCall(tool, input)
  const feedId = rid('f')
  openCalls.set(toolUseId, { feedId, tool, input, text, agentId, calledAt: nowMs() })
  if (openCalls.size > 200) openCalls.delete([...openCalls.keys()][0] as string)
  await pushFeed($, { id: feedId, at: nowMs(), text: feedLine(tool, input, root), tool, state: 'running', agentId })
  setCurrent($, text, agentId, text)
  if (agentId !== undefined) lastActivity.set(agentId, nowMs())
  if (agentId !== undefined && nowMs() - lastSyncAt > 1_000) {
    const isKnown = (await readAgents($)).some(a => a.id === agentId && a.status === 'running')
    if (!isKnown) void quietly(syncAgents($))
  }
  if (tool === 'AskUserQuestion') {
    await attention($, 'Claude is asking you a question')
    noteForDecisions($, (String(agentId === undefined ? 'Agent' : ('[agent ' + String(agentId) + ']')) + ' asks the person: ' + String(JSON.stringify(input.questions ?? input).slice(0, 1500))))
  }
  if (agentId === undefined && typeof input.file_path === 'string') lastFile = input.file_path
  const phase = phaseOfTool(tool, typeof input.command === 'string' ? input.command : undefined)
  if (phase !== undefined) {
    // Each loop moves only its own tasks: a subagent's calls, its task.
    const now = nowMs()
    await setTasks($, (list, rootId) => advancePhase(list, phase, rootId, agentId, now))
  }
  // The session's own milestones, from what the tools say: the root's
  // phase stops moving once it has steps, the timeline must not.
  if (phase !== undefined && agentId === undefined && phase !== lastPhase) {
    lastPhase = phase
    await addTimeline($, 'phase', phase)
  }
}

/** What a call's end changes: its feed line, retries, declared tasks, files, tests, the observer's batch. */
async function endCall($: EngineInterface, toolUseId: string, isFailed: boolean, result: unknown, error: string | undefined) {
  const call = openCalls.get(toolUseId)
  if (call === undefined) return
  openCalls.delete(toolUseId)
  const { tool, input, text, agentId } = call
  stat(d => {
    d.tools = { [tool]: { calls: 1, fails: isFailed ? 1 : 0, ms: nowMs() - call.calledAt } }
  })
  const resultText = typeof result === 'string' ? result : error
  await endFeed($, call.feedId, isFailed, callDetail(tool, input, result, resultText, isFailed))
  await clearAttention($)
  await recordSpin($, signatureOf(tool, input), isFailed, text)
  if (!isFailed) {
    const created = tool === 'TaskCreate' ? (result as { task?: { id?: unknown } } | null | undefined)?.task?.id : undefined
    if (tool === 'TaskCreate' && typeof created === 'string' && typeof input.subject === 'string') await declare($, created, input.subject, agentId)
    if (tool === 'TaskUpdate' && typeof input.taskId === 'string') {
      await declareUpdate($, input.taskId, typeof input.status === 'string' ? input.status : undefined, typeof input.subject === 'string' ? input.subject : undefined)
    }
    if (tool === 'TodoWrite' && Array.isArray(input.todos)) await declareTodos($, input.todos as { content: string; status: string }[], agentId)
    if ((tool === 'Edit' || tool === 'Write') && typeof input.file_path === 'string') await recordFile($, input.file_path, result, input)
    if (tool === 'Read') readChars += JSON.stringify(result ?? '').length
  }
  if (tool === 'Bash' && typeof input.command === 'string' && isVerifyCommand(input.command)) await recordVerify($, input.command, !isFailed)
  if (!TASK_TOOLS.has(tool)) buffer.push(summarizeCall(tool, input, isFailed ? 'error' : 'ok', agentId))
  scheduleFlush($)
}

// ---------- /atelier ----------

async function runAtelierCommand($: EngineInterface, args: string, columns: number) {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  if (verb === 'close') {
    await $.ui.close({ id: PANE })
    $.ui.toast('Atelier closed')

    return
  }
  if (verb === 'compact') {
    await updateView($, v => ({ ...v, isCompact: !v.isCompact }))
    await open($, columns)

    return
  }
  if (verb === 'stats') {
    await flushStats($)
    await setView($, v => ({ ...v, isStats: v.isStats !== true, isDetail: false }))
    await open($, columns)

    return
  }
  if (verb === 'search') {
    const query = rest.join(' ')
    if (query === '') {
      $.ui.toast('Atelier: /atelier search <words>')

      return
    }
    // The hits show in the sidebar's search panel.
    const hits = await search($, query)
    await open($, columns)
    $.ui.toast(hits.length === 0 ? ('Atelier: no matches for "' + String(query) + '"') : ('Atelier: ' + String(hits.length) + ' match' + String(hits.length === 1 ? '' : 'es') + ' in the sidebar'))

    return
  }
  await open($, columns)
}

// ---------- the hooks ----------

export const register: Register = (on, options) => {
  opt = readOptions(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'atelier',
      description: 'Sidebar: open, close, compact, stats, or search <query>',
    })
    sessionId = await $.session.id()
    // The project folder as the event hands it, rather than read from the machine.
    root = e.cwd
    sessionStartedAt = (await $.session.usage()).startedAt
    void quietly(loadView($))
    void quietly(flushSpend($))
    void quietly(startStats($))
    if (!isStatsTimerOn) {
      isStatsTimerOn = true
      $.clock.every(60_000, () => {
        void quietly(flushStats($))
      })
    }
    const view = await $.state.get({ plugin: 'atelier', key: 'view' })
    if (view.version === 0 && opt.isCompactDefault) await updateView($, v => ({ ...v, isCompact: true }))
    const model = await $.session.model()
    await updateAgents($, list =>
      list.some(a => a.id === 'main')
        ? list
        : [{ id: 'main', type: 'main', model, description: 'Main agent', status: 'idle', tokens: 0, startedAt: nowMs(), isBackground: false } satisfies AgentNode, ...list],
    )
    void quietly(open($))
    // The hand-off card is off until it has a better place; summaries are still saved.
    await updateHandoff($, () => null)
    void quietly(loadPeers($))
    peersTimer?.cancel()
    peersTimer = $.clock.every(20_000, () => {
      void quietly(loadPeers($))
    })
    void quietly(syncAgents($))
    syncTimer?.cancel()
    syncTimer = $.clock.every(5_000, () => {
      // Every 5s while work runs; once a minute when the session is idle.
      syncIdleTicks = isTurnRunning || hasRunningAgents ? 0 : syncIdleTicks + 1
      if (syncIdleTicks % 12 === 0) void quietly(syncAgents($))
    })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!isPlaced) void quietly(open($))
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'
    if (!isPerson) return next(e)
    lastPhase = undefined
    void quietly(clearAttention($))
    void quietly(updateDecisions($, list => (list.some(d => d.isPending) ? answerPending(list, e.text) : list)))
    noteForDecisions($, ('Person said: ' + String(e.text)))
    if (!looksTrivial(e.text)) {
      const id = rid('r')
      const now = nowMs()
      const title = e.text.trim().split('\n')[0]?.slice(0, 60) ?? 'Task'
      // The root shows at once, its bar indeterminate until Haiku answers.
      await setTasks($, list => [
        ...list.map(t => (t.parentId === null && t.agentId === undefined && t.status === 'running' ? { ...t, status: 'pending' as const } : t)),
        newTask({ id, title, status: 'running', confidence: 0, order: now }, now),
      ])
      await updateRoot($, () => id)
      if (opt.isObserverOn) void quietly(seed($, e.text, id))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    turnId = e.turnId
    isTurnRunning = true
    turnStartedAt = nowMs()
    await updateAgents($, list => list.map(a => (a.id === 'main' ? { ...a, status: 'running' as const, startedAt: nowMs() } : a)))
    startTicker($)

    return next(e)
  })

  // Notes the call and passes it on unchanged; what follows the call is
  // read from PostToolUse / PostToolUseFailure below.
  on('tool.call', async ($, e, next) => {
    await startCall($, e as unknown as Record<string, unknown>, String(e.tool), e.tool_use_id, e.agentId)

    return next(e)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    await endCall($, e.tool_use_id, false, e.tool_response, undefined)

    return next(e)
  })

  on('classic.PostToolUseFailure', async ($, e, next) => {
    await endCall($, e.tool_use_id, true, undefined, e.error)

    return next(e)
  })

  // Notes the spawn and passes it on unchanged; the agent's id comes from
  // the engine's agent list, which the sync below reads right after.
  on('agent.spawn', ($, e, next) => {
    pendingSpawns = [...pendingSpawns, { description: e.description, type: e.subagentType, prompt: e.prompt, model: e.model ?? e.parentModel, isBackground: e.background, at: nowMs() }].slice(-10)
    stat(d => {
      d.agents = { [e.subagentType]: { spawns: 1, tokens: 0, ms: 0, fails: 0 } }
    })
    scheduleSync($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // The steps counted as they came; this is only what they missed.
    const used = await settleTurn($, e.agentId, e.usage, e.durationMs)
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await updateAgents($, list =>
        list.map(a =>
          a.id === agentId
            ? { ...a, status: e.reason === 'error' ? ('error' as const) : ('done' as const), endedAt: nowMs(), tokens: a.tokens + used, currentTool: undefined }
            : a,
        ),
      )
      await attribute($, used, agentId)
      const isError = e.reason === 'error' || e.isAborted
      const node = (await readAgents($)).find(a => a.id === agentId)
      if (node !== undefined) {
        stat(d => {
          d.agents = { [node.type]: { spawns: 0, tokens: node.tokens, ms: nowMs() - node.startedAt, fails: isError ? 1 : 0 } }
        })
      }
      const now = nowMs()
      await setTasks($, list => finishAgentTask(list, agentId, isError, now))

      return next(e)
    }
    turnId = undefined
    isTurnRunning = false
    turnStartedAt = null
    stat(d => {
      d.turns = 1
      d.turnMs = e.durationMs
      if (root !== '') d.byProject = { [root]: { cost: 0, tokens: 0, turns: 1 } }
    })
    void quietly(flushStats($))
    void quietly(refreshContext($))
    void quietly(flushSpend($))
    await updateAgents($, list =>
      list.map(a => (a.id === 'main' ? { ...a, status: 'idle' as const, tokens: a.tokens + used, currentTool: undefined } : a)),
    )
    setCurrent($, null, undefined, undefined)
    await publishLive($)
    await attribute($, used)
    await setTasks($, (list, rootId) => list.map(t => (t.id === rootId && t.status === 'running' ? { ...t, status: 'waiting' as const } : t)))
    void quietly(refreshUsage($))
    void quietly(publishPeer($))
    flushTimer?.cancel()
    flushTimer = undefined
    const answer = e.answer
    // The turn's end settles decisions at once rather than after the quiet.
    if (decideLines.length > 0) {
      decideTimer?.cancel()
      decideTimer = undefined
      void quietly(decide($))
    }
    void quietly(afterTurn($, answer))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const view: UsageView = {
      contextTokens: e.context.tokens,
      window: e.context.window,
      percent: e.context.percent,
      costUsd: e.cost?.usd,
      rateLimits: e.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
    }
    await updateUsage($, () => view)
    // Between turns the heatmap follows the window from here too, and gets
    // its first reading here when turn.complete's refresh gave none; never
    // mid-turn, so "per turn" stays one reading a turn.
    const measured = e.context.tokens
    if (measured !== undefined && !isTurnRunning && measured !== lastMeasured) {
      lastMeasured = measured
      const ctx = await readContext($)
      if (ctx === null || Math.abs(ctx.used - measured) > 2000) void quietly(refreshContext($, e.context))
    }
    const cost = e.cost?.usd
    if (cost !== undefined) {
      // The first reading is the baseline: a resumed session's past spend counted already.
      if (lastCost !== undefined && cost > lastCost) {
        const model = lastStepModel || 'unknown'
        pendingSpend = { ...pendingSpend, [model]: (pendingSpend[model] ?? 0) + (cost - lastCost) }
        statCost(model, cost - lastCost)
      }
      lastCost = cost
    }

    return next(e)
  })

  // Passes the response through untouched (yield* next(e)); what it cost
  // is counted from the step's own usage once it has come back.
  on('turn.step', async function* ($, e, next) {
    startStep($, e.agentId, e.model)
    const result = yield* next(e)
    endStep($, e.agentId, result)

    return result
  })

  on('classic.PostCompact', async ($, e, next) => {
    stat(d => {
      d.compactions = 1
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (sessionId !== '') await $.store.delete(('peer:' + String(sessionId)))
    await quietly(flushStats($))

    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    if (/permission|idle|elicitation|input/i.test(e.notification_type)) await attention($, e.message.slice(0, 80))

    return next(e)
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    await attention($, ('Permission needed: ' + String(e.tool_name)))

    return next(e)
  })

  // Does what /atelier asks, says so in a toast, and passes the command on.
  on('command.run', { command: 'atelier' }, async ($, e, next) => {
    await runAtelierCommand($, e.args, e.presentation.columns)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const terminal = e.viewport?.columns
    // Sized once from the first docked draw. Resizing on every draw looped:
    // the dock's own width changes the viewport it is measured from, so each
    // request moved the next measurement (flicker). /atelier re-sizes it
    // from the terminal's true width.
    if (terminal !== undefined && e.props.placement === 'dock' && asked === undefined) {
      void quietly(open($, terminal))
    }
    const [tasks, rootId, agents, usage, feed, current, files, alerts, view, observer, timeline, confidence, peers, handoff, found, decisions, rate, cache, context, spend] =
      await Promise.all([
        readTasks($),
        readRoot($),
        readAgents($),
        readUsage($),
        readFeed($),
        readCurrent($),
        readFiles($),
        readAlerts($),
        readView($),
        readObserver($),
        readTimeline($),
        readConfidence($),
        readPeers($),
        readHandoff($),
        readSearch($),
        readDecisions($),
        readRate($),
        readCache($),
        readContext($),
        readSpend($),
      ])
    // Bars draw eased: the ticker walks `shown` toward each target.
    const eased = (t: Task): Task => {
      const v = shown.get(t.id)
      if (v === undefined) shown.set(t.id, t.progress)

      return { ...t, progress: v ?? t.progress }
    }
    const rootRaw = tasks.find(t => t.id === rootId)
    const steps = rootRaw === undefined ? [] : childrenOf(tasks, rootRaw.id).map(eased)
    const main = agents.find(a => a.id === 'main')
    const now = await $.clock.now()
    const stats = await readStats($)
    const agentRates = await readAgentRates($)

    return drawSidebar(
      {
        Box: els.Box,
        Text: els.Text,
        Button: els.Button,
        Input: 'Input' in els ? els.Input : undefined,
        // The table carries every constructor; the surface says which draw.
        // The cell-drawn bars looked worse than the text glyphs; the text drawing is used instead.
        Raster: undefined,
        Svg: e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined,
      },
      {
        now,
        cols: Math.max(24, e.props.bodyColumns),
        rows: Math.max(10, e.props.scroll.bodyRows),
        isWorking: isTurnRunning,
        turnStartedAt,
        model: main?.model ?? '',
        root: rootRaw === undefined ? undefined : eased(rootRaw),
        steps,
        agentTasks: agentTaskRows(tasks.map(eased), agents, now),
        runningAgents: agents.filter(a => a.id !== 'main' && a.status === 'running').length,
        stats,
        statsRange,
        agentRates,
        lastFile,
        sessionStartedAt,
        projectRoot: root,
        usage,
        context,
        rate,
        cache,
        spend,
        view,
        decisions,
        alerts,
        agents,
        observer,
        isObserverOn: opt.isObserverOn,
        feed,
        current,
        confidence,
        files,
        timeline,
        peers,
        handoff,
        search: found,
      },
      {
        toggleUsageTab: () => quietly(setView($, v => ({ ...v, usageTab: v.usageTab === 'api' ? 'limits' : 'api' }))),
        toggleDetail: () => quietly(setView($, v => ({ ...v, isDetail: v.isDetail !== true, isStats: false }))),
        toggleStats: () => quietly(setView($, v => ({ ...v, isStats: v.isStats !== true, isDetail: false }))),
        cycleRange: () => {
          statsRange = RANGES[(RANGES.indexOf(statsRange) + 1) % RANGES.length] ?? 'today'
          $.ui.invalidate('ui.render')
        },
        toggleCompact: () => quietly(updateView($, v => ({ ...v, isCompact: !v.isCompact }))),
        toggleNote: () => quietly(updateView($, v => ({ ...v, isNoteOpen: !v.isNoteOpen }))),
        stop: () => quietly(interrupt($)),
        compact: () => quietly(compactNow($)),
        tests: () => quietly(runTests($)),
        checkpoint: () => quietly(commitCheckpoint($)),
        sendNote: text => quietly(sendNote($, text)),
        answer: (id, option) => quietly(answerDecision($, id, option)),
        revert: id => quietly(revertDecision($, id)),
        openDiff: path => quietly(openDiff($, path)),
        useHandoff: () => (handoff === null ? undefined : quietly($.prompt.fill({ text: handoffText(handoff) }))),
        dismissHandoff: () => quietly(updateHandoff($, () => null)),
        closeSearch: () => quietly(updateSearch($, () => null)),
      },
    )
  })
}
