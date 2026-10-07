import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, PluginOptions, Register, Timer } from 'claude-code'

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
const NUDGE_AFTER = 6
const SOUND = 'assets/attention.wav'
const RATE_MS = 1200
const RATE_WINDOW = 50
const CACHE_TTL_MS = 5 * 60_000
const SPEND_DAYS = 62

const tasksAtom = atom({ plugin: 'atelier', key: 'tasks' } as const, [])
const rootAtom = atom({ plugin: 'atelier', key: 'rootId' } as const, null)
const agentsAtom = atom({ plugin: 'atelier', key: 'agents' } as const, [])
const usageAtom = atom({ plugin: 'atelier', key: 'usage' } as const, null)
const feedAtom = atom({ plugin: 'atelier', key: 'feed' } as const, [])
const currentAtom = atom({ plugin: 'atelier', key: 'current' } as const, null)
const filesAtom = atom({ plugin: 'atelier', key: 'files' } as const, [])
const alertsAtom = atom({ plugin: 'atelier', key: 'alerts' } as const, { attention: null, spins: [], drift: null })
const viewAtom = atom({ plugin: 'atelier', key: 'view' } as const, {
  isCompact: false,
  isNoteOpen: false,
  usageTab: 'limits',
  isDetail: false,
})
const observerAtom = atom({ plugin: 'atelier', key: 'observer' } as const, {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  lastKind: null,
  dropped: 0,
})
const timelineAtom = atom({ plugin: 'atelier', key: 'timeline' } as const, [])
const confidenceAtom = atom({ plugin: 'atelier', key: 'confidence' } as const, {
  untestedEdits: 0,
  testsPassed: null,
  typecheckClean: null,
})
const peersAtom = atom({ plugin: 'atelier', key: 'peers' } as const, [])
const handoffAtom = atom({ plugin: 'atelier', key: 'handoff' } as const, null)
const searchAtom = atom({ plugin: 'atelier', key: 'search' } as const, null)
const decisionsAtom = atom({ plugin: 'atelier', key: 'decisions' } as const, [])
const rateAtom = atom({ plugin: 'atelier', key: 'rate' } as const, { samples: [], peak: 0, sum: 0, count: 0, tokens: 0 })
const cacheAtom = atom({ plugin: 'atelier', key: 'cache' } as const, { lastHitAt: null, ttlMs: CACHE_TTL_MS, readTokens: 0, inputTokens: 0 })
const contextAtom = atom({ plugin: 'atelier', key: 'context' } as const, null)
const spendAtom = atom({ plugin: 'atelier', key: 'spend' } as const, null)
const statsAtom = atom({ plugin: 'atelier', key: 'stats' } as const, null)
const agentRatesAtom = atom({ plugin: 'atelier', key: 'agentRates' } as const, {})

type Options = {
  isObserverOn: boolean
  observerModel: string
  batchSize: number
  debounceMs: number
  nudge: 'off' | 'nudge-once' | 'always' | 'describe'
  isSoundOn: boolean
  testCommand: string
  isCompactDefault: boolean
}

function readOptions(o: PluginOptions): Options {
  const nudge = o.planningNudge

  return {
    isObserverOn: o.observer !== false,
    observerModel: typeof o.observerModel === 'string' && o.observerModel !== '' ? o.observerModel : 'haiku',
    batchSize: typeof o.batchSize === 'number' && o.batchSize > 0 ? o.batchSize : 5,
    debounceMs: typeof o.debounceMs === 'number' && o.debounceMs > 0 ? o.debounceMs : 4000,
    nudge: nudge === 'nudge-once' || nudge === 'always' || nudge === 'describe' ? nudge : 'off',
    isSoundOn: o.sound === true,
    testCommand: typeof o.testCommand === 'string' && o.testCommand !== '' ? o.testCommand : 'npm test',
    isCompactDefault: o.compactDefault === true,
  }
}

const NUDGE =
  'This work has several steps. Track them with the TaskCreate and TaskUpdate tools (one task per step, marked in_progress and completed as you go) so the person can follow progress.'

const DESCRIBE_EXTRA =
  '\n\nUse this proactively whenever the work takes three or more steps: create one task per step before starting, and keep each status current.'

const SEED_SYSTEM =
  'You turn a coding request into a goal and a short plan. Reply with JSON only, no prose: {"goal": string (at most 60 characters), "steps": string[] (2 to 7 short imperative steps, at most 50 characters each)}.'

const OBSERVER_SYSTEM = `You keep a task list for a coding session by watching the agent's tool calls. Reply with JSON only, a diff:
{"add":[{"id":"temp id","title":"...","parentId":"existing id, temp id or root","phase":"...","status":"..."}],
 "update":[{"id":"...","status":"...","phase":"...","progress":0.5,"note":"..."}],
 "complete":["id"],
 "merge":[{"inferredId":"...","declaredId":"..."}]}
Phases: ${PHASES.join(', ')}. Statuses: pending, running, waiting, blocked, done. progress is 0 to 1 overall.
Tasks may carry an agentId: those belong to a subagent. A tool call prefixed [agent <id>] is that subagent's: it advances only that subagent's tasks (the one with that agentId and parentId null, and its steps); add a subagent's new steps with parentId set to its task's id. Unprefixed calls are the main agent's.
Declared tasks are the agent's own: never add a task a declared one already covers; merge an inferred task into the declared task that describes the same work.
Decisions are tracked by a separate pass: leave them out.
Titles at most 50 characters. Use empty arrays when nothing changed.`

const DECISION_SYSTEM = `You keep the list of decisions a coding agent makes while it works, for a sidebar the person watches.
You get the decisions known so far and what happened since: what the agent said, what it asked, what the person answered, notable tool calls.
Reply with JSON only: {"decisions":[...]} holding only new decisions and changes to known ones (match a known one by its id). Fields:
"decisions":[{"id":"existing id when updating","title":"one or two words","chosen":"what it picked","rejected":[{"option":"...","reason":"two or three words"}],"rationale":"why, at most 12 words","confidence":0.75,"reversible":true,"evidence":["file:line","3 test runs"],"files":1,"outsidePlan":"set only when it touches work outside the plan, e.g. 1 file outside plan"}]
A decision is a point where the agent picked one approach over others (an approach, a scope change, how to test, what to skip), or settled something the person asked.
When the agent asks the person to choose, add one with "pending":true, "options":[...], "lean":"the option it prefers", "blocks":"what waits on it".
When the person answers or the agent goes ahead, update that pending one: "pending":false and "chosen".
When the agent changes course on a known decision, update its "chosen", "rejected" and "rationale".
Only real choices; reply {"decisions":[]} when nothing changed.`

const SUMMARY_SYSTEM =
  'You write a hand-off note for a coding session. Reply with JSON only: {"done": string[], "remaining": string[], "questions": string[], "text": "two or three plain sentences"}. Each list item at most 80 characters.'

let opt: Options = readOptions({})
let isPlaced = false
let asked: number | undefined
let buffer: string[] = []
let flushTimer: Timer | undefined
let isFlushing = false
let attempts: Attempts = {}
let turnId: string | undefined
let isTurnRunning = false
let callsThisPrompt = 0
let isNudged = false
let isMultiStep = false
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
const PUBLISH_MS = 300
let liveFeed: FeedItem[] | undefined
let isFeedDirty = false
let liveCurrent: string | null | undefined
const liveTools = new Map<string, string | undefined>()
let publishTimer: Timer | undefined
// Last tool call or step per subagent: one listed as running but silent for
// STALE_MS no longer keeps the redraw timer alive.
const lastActivity = new Map<string, number>()
const STALE_MS = 10 * 60_000
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
  return `${prefix}${nowMs().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
}

async function setTasks($: EngineInterface, fn: (list: Task[], rootId: string | null) => Task[]) {
  const rootId = await read($, rootAtom)
  // A change that changes nothing (a phase already reached) writes nothing.
  if (isSame(settle(fn(await read($, tasksAtom), rootId)), await read($, tasksAtom))) return
  await update($, tasksAtom, list => settle(fn(list, rootId)))
  isSummaryDirty = true
  startTicker($)
}

async function editFeed($: EngineInterface, fn: (list: FeedItem[]) => FeedItem[]) {
  if (liveFeed === undefined) liveFeed = await read($, feedAtom)
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
    void publishLive($).catch(() => {})
  })
}

/** Writes what changed since the last publish: one write per value, none when equal. */
async function publishLive($: EngineInterface) {
  if (isFeedDirty && liveFeed !== undefined) {
    isFeedDirty = false
    const feed = liveFeed
    await update($, feedAtom, () => feed)
  }
  if (liveCurrent !== undefined) {
    const current = liveCurrent
    liveCurrent = undefined
    if (current !== (await read($, currentAtom))) await update($, currentAtom, () => current)
  }
  if (liveTools.size > 0) {
    const tools = new Map(liveTools)
    liveTools.clear()
    const agents = await read($, agentsAtom)
    if (applyCurrentTools(agents, tools) !== agents) await update($, agentsAtom, list => [...applyCurrentTools(list, tools)])
  }
}

async function addTimeline($: EngineInterface, kind: TimelineEntry['kind'], text: string, feedId?: string) {
  const entry: TimelineEntry = { id: rid('t'), at: nowMs(), kind, text, feedId }
  await update($, timelineAtom, list => [...list, entry].slice(-TIMELINE_MAX))
}

async function countObserver($: EngineInterface, usage: ModelUsage | undefined, estimate: number, kind?: string) {
  stat(d => {
    d.observer = {
      calls: 1,
      input: usage === undefined ? estimate : usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
      output: usage === undefined ? 4 : usage.output_tokens,
    }
  })
  await update($, observerAtom, o => ({
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
    void stepTicker($).catch(() => {})
  })
}

async function stepTicker($: EngineInterface) {
  const list = await read($, tasksAtom)
  const agents = await read($, agentsAtom)
  let isMoving = false
  for (const t of list) {
    const was = shown.get(t.id) ?? 0
    const next = ease(was, t.progress)
    if (next !== was) isMoving = true
    shown.set(t.id, next)
  }
  const isRunning = isTurnRunning || liveAgents(agents, lastActivity, nowMs(), STALE_MS).length > 0
  if (isMoving || (isRunning && tick % 4 === 0)) $.ui.invalidate('ui.render')
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
    await update($, rootAtom, id => (id === rootId ? null : id))

    return
  }
  isMultiStep = kind === 'multi-step-work'
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
    const next = list.map(t => (t.id === rootId ? { ...t, title: goal ?? t.title, confidence: steps.length > 0 ? 0.7 : 0.3 } : t))
    if (hasDeclared) return next

    return [
      ...next,
      ...steps.map((s, i) => newTask({ id: `${rootId}.${i}`, title: s.slice(0, 60), parentId: rootId, order: now + i, confidence: 0.6 }, now)),
    ]
  })
  await addTimeline($, 'task', `Goal: ${goal ?? text.slice(0, 50)}`)
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
    const next = list.map(t => (t.id === own.id ? { ...t, title: goal ?? t.title, confidence: steps.length > 0 ? 0.7 : 0.3 } : t))
    if (hasSteps || own.status !== 'running') return next

    return [
      ...next,
      ...steps.map((s, i) =>
        newTask({ id: `${own.id}.${i}`, agentId, title: s.slice(0, 60), parentId: own.id, order: now + i, confidence: 0.6 }, now),
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
    void flush($).catch(() => {})

    return
  }
  flushTimer = $.clock.after(opt.debounceMs, () => {
    flushTimer = undefined
    void flush($).catch(() => {})
  })
}

function taskBrief(list: readonly Task[]) {
  return JSON.stringify(
    list
      .filter(t => t.status !== 'done' || nowMs() - t.updatedAt < 10 * 60_000)
      .slice(-40)
      .map(t => ({ id: t.id, title: t.title, source: t.source, status: t.status, phase: t.phase, parentId: t.parentId, agentId: t.agentId })),
  )
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
    const rootId = await read($, rootAtom)
    const list = await read($, tasksAtom)
    const goal = list.find(t => t.id === rootId)?.title ?? '(none)'
    const r = await $.model.complete({
      model: opt.observerModel,
      system: OBSERVER_SYSTEM,
      prompt: `Root task id: ${rootId ?? 'none'}\nGoal: ${goal}\nTasks: ${taskBrief(list)}\nThe batch reads as: ${kind}\nRecent tool calls:\n${lines}`,
      maxTokens: 700,
      effort: 'low',
      timeoutMs: 25_000,
    })
    await countObserver($, r.usage, 0)
    const diff = r.isAnswered ? parseDiff(r.text) : undefined
    if (diff === undefined) {
      await update($, observerAtom, o => ({ ...o, dropped: o.dropped + 1 }))

      return
    }
    const now = nowMs()
    await setTasks($, (l, id) => applyDiff(l, diff, now, id))
    await recordDecisions($, diff.decisions, now)
    for (const a of diff.add) await addTimeline($, 'task', `+ ${a.title}`)
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
  await update($, decisionsAtom, list => applyDecisions(list, incoming, now))
  for (const d of incoming) await addTimeline($, 'task', `Decision: ${d.title}${d.chosen !== undefined ? ` (${d.chosen})` : ''}`)
}

// ---------- decisions: a Haiku pass of their own ----------

/** Notes something a decision may hang on; the pass runs once things go quiet. */
function noteForDecisions($: EngineInterface, line: string) {
  if (!opt.isObserverOn) return
  decideLines = [...decideLines, line.replace(/\s+/g, ' ').slice(0, 500)].slice(-30)
  decideTimer?.cancel()
  decideTimer = $.clock.after(DECIDE_MS, () => {
    decideTimer = undefined
    void decide($).catch(() => {})
  })
}

function decisionBrief(list: readonly { id: string; title: string; chosen: string; isPending: boolean; options?: string[]; lean?: string }[]) {
  return JSON.stringify(list.slice(-12).map(d => ({ id: d.id, title: d.title, chosen: d.chosen, pending: d.isPending, options: d.options, lean: d.lean })))
}

/** Asks Haiku for new decisions and changes to known ones, from what happened since the last pass. */
async function decide($: EngineInterface) {
  if (isDeciding || decideLines.length === 0) return
  isDeciding = true
  const lines = decideLines
  decideLines = []
  try {
    const known = await read($, decisionsAtom)
    const r = await $.model.complete({
      model: opt.observerModel,
      system: DECISION_SYSTEM,
      prompt: `Known decisions: ${decisionBrief(known)}\nSince the last check:\n${lines.join('\n')}`,
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
  const text = `Goal: ${goal}\nRecent activity:\n${lines}`
  const kind = await $.model.classify(text, ['on-task', 'off-task'], { model: opt.observerModel })
  await countObserver($, undefined, Math.ceil(text.length / 4) + 60, kind)
  await update($, alertsAtom, a => ({ ...a, drift: kind === 'off-task' ? 'May be off-task' : null }))
}

async function reconcile($: EngineInterface, answer: string) {
  const rootId = await read($, rootAtom)
  const list = await read($, tasksAtom)
  if (rootId === null || !opt.isObserverOn) return
  const batch = buffer.splice(0, buffer.length).join('\n')
  const r = await $.model.complete({
    model: opt.observerModel,
    system: OBSERVER_SYSTEM,
    prompt: `The turn just ended. Reconcile: complete the steps that are finished, merge inferred tasks that duplicate declared ones, complete the root (id ${rootId}) only if its goal looks met; if the agent is waiting on the person, set the root's status to waiting.\nTasks: ${taskBrief(list)}\nLast tool calls:\n${batch || '(none)'}\nThe agent's final answer:\n${answer.slice(0, 2500)}`,
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
    const next = applyDiff(l, diff, now, id)

    // The root is inferred; its own completion comes through `complete`.
    return next.map(t => (t.id === rootId && diff.complete.includes(rootId) ? { ...t, status: 'done' as const, phase: 'done' as const } : t))
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
  await update($, usageAtom, () => view)
}

/** Charges usage to the loop's own work: a subagent's to its task, the main loop's under the root. */
async function attribute($: EngineInterface, amount: number, agentId?: string) {
  if (amount <= 0) return
  const rootId = await read($, rootAtom)
  await update($, tasksAtom, list => {
    const id = chargeableFor(list, rootId, agentId)

    return list.map(t => (t.id === id ? { ...t, tokens: t.tokens + amount } : t))
  })
}

// ---------- alerts ----------

async function attention($: EngineInterface, text: string) {
  await update($, alertsAtom, a => ({ ...a, attention: text }))
  await setTasks($, (list, rootId) => list.map(t => (t.id === rootId && t.status === 'running' ? { ...t, status: 'waiting' as const } : t)))
  $.ui.toast(`Atelier: ${text}`)
  if (opt.isSoundOn) void $.audio.play({ asset: SOUND }).catch(() => {})
}

async function clearAttention($: EngineInterface) {
  const a = await read($, alertsAtom)
  if (a.attention === null) return
  await update($, alertsAtom, x => ({ ...x, attention: null }))
  await setTasks($, (list, rootId) => list.map(t => (t.id === rootId && t.status === 'waiting' ? { ...t, status: 'running' as const } : t)))
}

// ---------- declared tasks ----------

function mapStatus(s: string | undefined): TaskStatus | undefined {
  if (s === 'in_progress') return 'running'
  if (s === 'completed') return 'done'
  if (s === 'pending') return 'pending'

  return undefined
}

/** Where a loop's declared tasks hang: a subagent's under its own task, the main loop's under the root. */
function declaredParent(list: readonly Task[], rootId: string | null, agentId: string | undefined) {
  return agentId === undefined ? rootId : (agentTaskOf(list, agentId)?.id ?? rootId)
}

async function declare($: EngineInterface, externalId: string, subject: string, agentId?: string) {
  const now = nowMs()
  await setTasks($, (list, rootId) => [
    ...list,
    newTask(
      { id: `d${externalId}`, externalId, agentId, title: subject.slice(0, 80), parentId: declaredParent(list, rootId, agentId), source: 'declared', phase: 'planning', confidence: 1, order: now },
      now,
    ),
  ])
  buffer.push(`TaskCreate declared task d${externalId}: ${subject}`)
  await addTimeline($, 'task', `Declared: ${subject}`)
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
    const done = (await read($, tasksAtom)).find(t => t.externalId === externalId)
    if (done !== undefined) await addTimeline($, 'task', `Done: ${done.title}`)
  }
}

async function declareTodos($: EngineInterface, todos: readonly { content: string; status: string }[], agentId?: string) {
  const now = nowMs()
  // Each loop keeps its own todo list: one loop's TodoWrite replaces only its own.
  const prefix = agentId === undefined ? 'todo:' : `todo:${agentId}:`
  const isOwn = (t: Task) => t.externalId?.startsWith('todo:') === true && t.agentId === agentId
  await setTasks($, (list, rootId) => {
    const kept = list.filter(t => !(t.source === 'declared' && isOwn(t)))
    const old = new Map(list.filter(isOwn).map(t => [t.externalId, t]))

    return [
      ...kept,
      ...todos.map((todo, i) => {
        const externalId = `${prefix}${todo.content}`
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
  await update($, filesAtom, list => {
    const was = list.find(f => f.path === path)
    const next: FileStat = {
      path,
      added: (was?.added ?? 0) + added,
      removed: (was?.removed ?? 0) + removed,
      edits: (was?.edits ?? 0) + 1,
      at: nowMs(),
    }

    return [...list.filter(f => f.path !== path), next].slice(-FILES_MAX)
  })
  const isFirst = (await read($, filesAtom)).find(f => f.path === path)?.edits === 1
  stat(d => {
    d.linesAdded = added
    d.linesRemoved = removed
    d.filesEdited = isFirst ? 1 : 0
  })
  if (isFirst) await addTimeline($, 'file', `Touched ${basename(path)}`)
  await update($, confidenceAtom, c => ({ ...c, untestedEdits: c.untestedEdits + 1, testsPassed: null }))
}

async function recordVerify($: EngineInterface, command: string, isOk: boolean) {
  if (!isTypecheckCommand(command)) {
    stat(d => {
      d.testsPassed = isOk ? 1 : 0
      d.testsFailed = isOk ? 0 : 1
    })
  }
  await update($, confidenceAtom, (c): Confidence => {
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
      : [...a.spins.filter(s => s.signature !== signature), { signature, count: r.count, text: `${warning}: ${text}` }].slice(-3)
  // Most calls change no warning: no write, no redraw.
  const alerts = await read($, alertsAtom)
  if (!isSame(spinsOf(alerts), alerts.spins)) await update($, alertsAtom, a => ({ ...a, spins: spinsOf(a) }))
  if (warning !== undefined && r.count === 3) {
    $.ui.toast(`Atelier: ${warning}`)
    await addTimeline($, 'alert', `${warning}: ${text}`)
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
  await pushFeed($, { id, at: nowMs(), text: `Running ${opt.testCommand}`, tool: 'atelier', state: 'running' })
  const r = await $.process.run(['sh', '-c', opt.testCommand], { cwd: root || undefined, timeoutMs: 600_000 })
  const isOk = r.exitCode === 0
  await editFeed($, list => list.map(f => (f.id === id ? { ...f, state: isOk ? ('ok' as const) : ('error' as const), text: `Tests ${isOk ? 'passed' : `failed (${r.exitCode})`}` } : f)))
  await recordVerify($, opt.testCommand, isOk)
  $.ui.toast(`Atelier: tests ${isOk ? 'passed' : 'failed'}`)
}

async function commitCheckpoint($: EngineInterface) {
  const answer = await $.ui.ask('Stage every change (git add -A) and commit a checkpoint?', ['Commit', 'Cancel'])
  if (answer !== 'Commit') return
  const rootId = await read($, rootAtom)
  const title = (await read($, tasksAtom)).find(t => t.id === rootId)?.title ?? 'work in progress'
  const add = await $.process.run(['git', 'add', '-A'], { cwd: root || undefined })
  const r = add.exitCode === 0 ? await $.process.run(['git', 'commit', '-m', `checkpoint: ${title}`], { cwd: root || undefined }) : add
  $.ui.toast(r.exitCode === 0 ? 'Atelier: checkpoint committed' : `Atelier: commit failed: ${(r.stderr || r.stdout).slice(0, 80)}`)
}

async function sendNote($: EngineInterface, text: string) {
  if (text.trim() === '') return
  await $.prompt.submit({ text: `Note from the person (via the sidebar): ${text.trim()}` })
  await update($, viewAtom, v => ({ ...v, isNoteOpen: false }))
}

async function openDiff($: EngineInterface, path: string) {
  try {
    await $.command.run({ command: 'diff' })
  } catch {
    const r = await $.process.run(['git', 'diff', '--stat', '--', path], { cwd: root || undefined })
    $.ui.toast(r.stdout.trim().split('\n').at(-1) ?? `no diff for ${basename(path)}`)
  }
}

// ---------- across sessions ----------

async function publishPeer($: EngineInterface) {
  const now = nowMs()
  if (sessionId === '' || now - lastPeerAt < 10_000) return
  lastPeerAt = now
  const rootId = await read($, rootAtom)
  const rootTask = (await read($, tasksAtom)).find(t => t.id === rootId)
  const peer: PeerSession = {
    id: sessionId,
    title: rootTask?.title ?? 'idle',
    progress: rootTask?.progress ?? 0,
    status: rootTask?.status ?? 'pending',
    cwd: root,
    at: now,
  }
  await $.store.set(`peer:${sessionId}`, peer)
}

async function loadPeers($: EngineInterface) {
  const now = nowMs()
  const peers: PeerSession[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('peer:') || key === `peer:${sessionId}`) continue
    const p = (await $.store.get(key)) as PeerSession | undefined
    if (p === undefined || now - p.at > PEER_TTL) {
      if (p !== undefined) await $.store.delete(key)
      continue
    }
    peers.push(p)
  }
  await update($, peersAtom, () => peers)
}

async function readSummaries($: EngineInterface): Promise<Summary[]> {
  const v = await $.store.get('summaries')

  return Array.isArray(v) ? (v as Summary[]) : []
}

// Precomputed at each turn's end: session.end has 1.5s, too little for a model call.
async function saveSummary($: EngineInterface) {
  if (!isSummaryDirty || !opt.isObserverOn || sessionId === '') return
  isSummaryDirty = false
  const list = await read($, tasksAtom)
  if (list.length === 0) return
  const files = (await read($, filesAtom)).map(f => basename(f.path)).join(', ')
  const r = await $.model.complete({
    model: opt.observerModel,
    system: SUMMARY_SYSTEM,
    prompt: `Tasks: ${taskBrief(list)}\nFiles changed: ${files || 'none'}`,
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
  await update($, handoffAtom, () => last ?? null)
}

function handoffText(s: Summary) {
  const part = (title: string, items: string[]) => (items.length === 0 ? '' : `\n${title}:\n${items.map(i => `- ${i}`).join('\n')}`)

  return `Hand-off from the last session: ${s.text}${part('Done', s.done)}${part('Remaining', s.remaining)}${part('Open questions', s.questions)}`
}

async function search($: EngineInterface, query: string) {
  const q = query.toLowerCase()
  const hits: SearchHit[] = []
  for (const s of await readSummaries($)) {
    for (const line of [s.text, ...s.done, ...s.remaining, ...s.questions]) {
      if (line.toLowerCase().includes(q)) hits.push({ at: s.at, text: line, source: basename(s.root) })
    }
  }
  for (const t of await read($, tasksAtom)) {
    if (t.title.toLowerCase().includes(q)) hits.push({ at: t.updatedAt, text: t.title, source: 'this session' })
  }
  hits.sort((a, b) => b.at - a.at)
  await update($, searchAtom, () => ({ query, hits: hits.slice(0, 20) }))

  return hits
}

// ---------- decisions ----------

async function answerDecision($: EngineInterface, id: string, option: string) {
  const d = (await read($, decisionsAtom)).find(x => x.id === id)
  if (d === undefined) return
  await $.prompt.fill({ text: option === '' ? `${d.title}: ` : `${d.title}: go with ${option}.` })
}

async function revertDecision($: EngineInterface, id: string) {
  const d = (await read($, decisionsAtom)).find(x => x.id === id)
  if (d === undefined) return
  const answer = await $.ui.ask(`Ask Claude to revert "${d.title}: ${d.chosen}"?`, ['Ask Claude', 'Cancel'])
  if (answer !== 'Ask Claude') return
  await update($, decisionsAtom, list => list.map(x => (x.id === id ? { ...x, isReverted: true } : x)))
  await $.prompt.submit({
    text: `Please revert the change from the decision "${d.title}: ${d.chosen}"${d.outsidePlan !== undefined ? ` (${d.outsidePlan})` : ''} and keep to the plan.`,
  })
}

// ---------- view toggles, kept across sessions ----------

async function setView($: EngineInterface, fn: (v: ViewState) => ViewState) {
  const next = await update($, viewAtom, fn)
  await $.store.set('view', { usageTab: next.usageTab, isDetail: next.isDetail, isStats: next.isStats })
}

async function loadView($: EngineInterface) {
  const saved = (await $.store.get('view')) as Partial<ViewState> | undefined
  if (saved === undefined || typeof saved !== 'object') return
  await update($, viewAtom, v => ({
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
    void sampleTick($).catch(() => {})
  })
}

async function sampleTick($: EngineInterface) {
  const chars = streamChars
  streamChars = 0
  const rate = chars / 4 / (RATE_MS / 1000)
  if (rate > 0) sampledTokens += 1
  idleSamples = streamCount > 0 || rate > 0 ? 0 : idleSamples + 1
  if (idleSamples >= RATE_WINDOW && sampler !== undefined) {
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
  const known = new Set((await read($, agentsAtom)).map(a => a.id))
  for (const [key, n] of by) if (n > 0) sampledBy.add(key)
  await update($, agentRatesAtom, rates => appendRates(rates, by, known, RATE_MS, RATE_WINDOW))
}

async function pushSamples($: EngineInterface, rates: number[]) {
  await update($, rateAtom, r => {
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

function chunkChars(c: unknown) {
  const o = c as { kind?: string; text?: unknown; json?: unknown }
  if (typeof o.text === 'string') return o.text.length
  if (typeof o.json === 'string') return o.json.length

  return 0
}

/** Tokens a response burned: what was sent uncached or written, and what came back. */
function burned(u: ModelUsage) {
  return u.input_tokens + u.cache_creation_input_tokens + u.output_tokens
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
  await update($, cacheAtom, c => ({
    ...c,
    lastHitAt: isHit ? now : c.lastHitAt,
    readTokens: c.readTokens + cacheRead,
    inputTokens: c.inputTokens + input,
  }))
  await update($, rateAtom, r => ({ ...r, tokens: r.tokens + tokens }))
  await update($, agentsAtom, list => list.map(a => (batch.has(a.id) ? { ...a, tokens: a.tokens + (batch.get(a.id) as StepTally).tokens } : a)))
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
    await update($, cacheAtom, c => ({
      ...c,
      lastHitAt: seen === 0 && usage.cache_read_input_tokens > 0 ? now : c.lastHitAt,
      readTokens: c.readTokens + Math.round(usage.cache_read_input_tokens * share),
      inputTokens: c.inputTokens + Math.round((usage.input_tokens + usage.cache_creation_input_tokens) * share),
    }))
    await update($, rateAtom, r => ({ ...r, tokens: r.tokens + extra }))
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
    await update($, agentRatesAtom, rates => ({ ...rates, [key]: [...(rates[key] ?? []), ...Array.from({ length: n }, () => rate)].slice(-RATE_WINDOW) }))
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
    void Promise.resolve($.ui.log(text, { to: 'debug' })).catch(() => {})
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
    debugLog($, `atelier: session.usage({ breakdown }) failed: ${String(err).slice(0, 200)}; the heatmap is an estimate`)
  }
  if (split === undefined) {
    const u = await read($, usageAtom)
    const used = plain?.tokens ?? u?.contextTokens
    const window = plain?.window ?? u?.window ?? 0
    if (used === undefined || window <= 0) return
    split = { used, window, system: 0, tools: 0, chat: used, isEstimate: true }
  }
  const prev = await read($, contextAtom)
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
  await update($, contextAtom, () => view)
}

function dayKey(ms: number) {
  return new Date(ms).toISOString().slice(0, 10)
}

type SpendBook = Record<string, { total: number; byModel: Record<string, number> }>

/** Cost deltas, charged to the model of the latest response, kept per day. */
async function flushSpend($: EngineInterface) {
  const entries = Object.entries(pendingSpend)
  pendingSpend = {}
  const raw = await $.store.get('spend')
  const book: SpendBook = raw !== null && typeof raw === 'object' ? (raw as SpendBook) : {}
  if (entries.length > 0) {
    const day = dayKey(nowMs())
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
  const now = nowMs()
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
  await update($, spendAtom, () => view)
}

// ---------- agents the mod did not see spawn ----------

let lastSyncAt = 0

/**
 * Brings in agents from the engine's list: ones started before the mod loaded
 * and ones a message resumed raise no agent.spawn here. Each that starts
 * running gets its task opened (and planned, when new) like a spawned one.
 */
async function syncAgents($: EngineInterface) {
  lastSyncAt = nowMs()
  const list = await $.agent.list()
  const before = await read($, agentsAtom)
  const merged = mergeAgentList(before, list, nowMs())
  const nodes = trimAgents(merged.nodes)
  const shape = (ns: readonly AgentNode[]) => ns.map(n => `${n.id}:${n.status}`)
  if (merged.started.length === 0 && isSame(shape(nodes), shape(before))) return
  for (const id of merged.started) lastActivity.set(id, nowMs())
  await update($, agentsAtom, () => trimAgents(mergeAgentList(before, list, nowMs()).nodes))
  for (const id of merged.started) {
    const info = list.find(a => a.id === id)
    const title = info?.description || info?.type || 'agent'
    const isNew = agentTaskOf(await read($, tasksAtom), id) === undefined
    const now = nowMs()
    await setTasks($, tasks => openAgentTask(tasks, id, title, now))
    if (isNew && opt.isObserverOn && title !== '') void seedAgent($, id, title).catch(() => {})
  }
  // Agents the list calls finished close their tasks, as their turn.complete would.
  for (const n of merged.nodes) {
    if (n.id === 'main' || (n.status !== 'done' && n.status !== 'error')) continue
    const own = agentTaskOf(await read($, tasksAtom), n.id)
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
  if (!isEmptyDay(delta)) {
    const day = dayKey(nowMs())
    days = pruneDays({ ...days, [day]: addDay(days[day] ?? emptyDay(), delta) })
    await $.store.set('stats', { days })
  }
  await update($, statsAtom, () => summarizeStats(days, nowMs()))
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

// ---------- the hooks ----------

export const register: Register = (on, options) => {
  opt = readOptions(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'atelier',
      description: 'Sidebar: open, close, compact, stats, or search <query>',
    })
    sessionId = await $.session.id()
    root = await $.session.root()
    sessionStartedAt = (await $.session.usage()).startedAt
    void loadView($).catch(() => {})
    void flushSpend($).catch(() => {})
    void countSession($)
      .then(() => flushStats($))
      .catch(() => {})
    if (!isStatsTimerOn) {
      isStatsTimerOn = true
      $.clock.every(60_000, () => {
        void flushStats($).catch(() => {})
      })
    }
    const view = await $.state.get({ plugin: 'atelier', key: 'view' })
    if (view.version === 0 && opt.isCompactDefault) await update($, viewAtom, v => ({ ...v, isCompact: true }))
    const model = await $.session.model()
    await update($, agentsAtom, list =>
      list.some(a => a.id === 'main')
        ? list
        : [{ id: 'main', type: 'main', model, description: 'Main agent', status: 'idle', tokens: 0, startedAt: nowMs(), isBackground: false } satisfies AgentNode, ...list],
    )
    void open($).catch(() => {})
    // The hand-off card is off until it has a better place; summaries are still saved.
    await update($, handoffAtom, () => null)
    void loadPeers($).catch(() => {})
    peersTimer?.cancel()
    peersTimer = $.clock.every(20_000, () => {
      void loadPeers($).catch(() => {})
    })
    void syncAgents($).catch(() => {})
    syncTimer?.cancel()
    syncTimer = $.clock.every(5_000, () => {
      void syncAgents($).catch(() => {})
    })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!isPlaced) void open($).catch(() => {})
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'
    if (!isPerson) return next(e)
    callsThisPrompt = 0
    isNudged = false
    lastPhase = undefined
    void clearAttention($).catch(() => {})
    void update($, decisionsAtom, list => (list.some(d => d.isPending) ? answerPending(list, e.text) : list)).catch(() => {})
    noteForDecisions($, `Person said: ${e.text}`)
    if (!looksTrivial(e.text)) {
      const id = rid('r')
      const now = nowMs()
      const title = e.text.trim().split('\n')[0]?.slice(0, 60) ?? 'Task'
      // The root shows at once, its bar indeterminate until Haiku answers.
      await setTasks($, list => [
        ...list.map(t => (t.parentId === null && t.agentId === undefined && t.status === 'running' ? { ...t, status: 'pending' as const } : t)),
        newTask({ id, title, status: 'running', confidence: 0, order: now }, now),
      ])
      await update($, rootAtom, () => id)
      if (opt.isObserverOn) void seed($, e.text, id).catch(() => {})
    }
    if (opt.nudge === 'always') return next({ ...e, context: [...(e.context ?? []), NUDGE] })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    turnId = e.turnId
    isTurnRunning = true
    turnStartedAt = nowMs()
    await update($, agentsAtom, list => list.map(a => (a.id === 'main' ? { ...a, status: 'running' as const, startedAt: nowMs() } : a)))
    startTicker($)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    const text = describeCall(tool, input)
    const feedId = rid('f')
    const agentId = e.agentId
    callsThisPrompt += agentId === undefined ? 1 : 0
    await pushFeed($, { id: feedId, at: nowMs(), text: feedLine(tool, input, root), tool, state: 'running', agentId })
    setCurrent($, text, agentId, text)
    if (agentId !== undefined) lastActivity.set(agentId, nowMs())
    if (agentId !== undefined && nowMs() - lastSyncAt > 1_000) {
      const isKnown = (await read($, agentsAtom)).some(a => a.id === agentId && a.status === 'running')
      if (!isKnown) void syncAgents($).catch(() => {})
    }
    if (tool === 'AskUserQuestion') {
      await attention($, 'Claude is asking you a question')
      noteForDecisions($, `${agentId === undefined ? 'Agent' : `[agent ${agentId}]`} asks the person: ${JSON.stringify(input.questions ?? input).slice(0, 1500)}`)
    }
    if (agentId === undefined && typeof input.file_path === 'string') lastFile = input.file_path
    const phase = phaseOfTool(tool, typeof input.command === 'string' ? input.command : undefined)
    if (phase !== undefined) {
      // Each loop moves only its own tasks: a subagent's calls, its task.
      const now = nowMs()
      await setTasks($, (list, rootId) => advancePhase(list, phase, rootId, agentId, now))
    }
    if (phase !== undefined && agentId === undefined) {
      // The session's own milestones, from what the tools say: the root's
      // phase stops moving once it has steps, the timeline must not.
      if (phase !== lastPhase) {
        lastPhase = phase
        await addTimeline($, 'phase', phase)
      }
    }

    const calledAt = nowMs()
    const ran = await next(e)

    const isFailed = ran.deny !== undefined || ran.isError === true
    stat(d => {
      d.tools = { [tool]: { calls: 1, fails: isFailed ? 1 : 0, ms: nowMs() - calledAt } }
    })
    await endFeed($, feedId, isFailed, callDetail(tool, input, ran.result, ran.text, isFailed))
    await clearAttention($)
    await recordSpin($, signatureOf(tool, input), isFailed, text)
    if (!isFailed) {
      const created = e.tool === 'TaskCreate' ? (ran.result as { task?: { id?: unknown } } | null | undefined)?.task?.id : undefined
      if (e.tool === 'TaskCreate' && typeof created === 'string') await declare($, created, e.subject, agentId)
      if (e.tool === 'TaskUpdate') await declareUpdate($, e.taskId, e.status, e.subject)
      if (e.tool === 'TodoWrite') await declareTodos($, e.todos, agentId)
      if ((e.tool === 'Edit' || e.tool === 'Write') && typeof input.file_path === 'string') await recordFile($, input.file_path, ran.result, input)
      if (tool === 'Read') readChars += ran.text?.length ?? 0
    }
    if (e.tool === 'Bash' && isVerifyCommand(e.command)) await recordVerify($, e.command, !isFailed)
    if (!/^(TaskCreate|TaskUpdate|TaskGet|TaskList|TodoWrite)$/.test(tool)) {
      buffer.push(summarizeCall(tool, input, ran.deny !== undefined ? 'denied' : isFailed ? 'error' : 'ok', agentId))
    }
    scheduleFlush($)

    // The optional planning nudge: once per prompt, after the read the model
    // gets with this tool's result, when the work is multi-step and undeclared.
    if (opt.nudge === 'nudge-once' && !isNudged && agentId === undefined && ran.deny === undefined && callsThisPrompt >= NUDGE_AFTER && isMultiStep) {
      const rootId = await read($, rootAtom)
      const hasDeclared = (await read($, tasksAtom)).some(t => t.source === 'declared' && t.parentId === rootId)
      if (!hasDeclared) {
        isNudged = true

        return { ...ran, context: [...(ran.context ?? []), NUDGE] }
      }
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    const agentId = ran.agentId
    if (agentId !== undefined) {
      const node: AgentNode = {
        id: agentId,
        type: e.subagentType,
        model: ran.model ?? e.model ?? e.parentModel,
        description: e.description,
        status: 'running',
        tokens: 0,
        startedAt: nowMs(),
        isBackground: e.background,
      }
      await update($, agentsAtom, list => [...list.filter(a => a.status === 'running' || nowMs() - (a.endedAt ?? 0) < 10 * 60_000), node].slice(-30))
      const now = nowMs()
      stat(d => {
        d.agents = { [e.subagentType]: { spawns: 1, tokens: 0, ms: 0, fails: 0 } }
      })
      await setTasks($, list => (agentTaskOf(list, agentId) === undefined ? [...list, agentTask(agentId, e.description || e.subagentType, now)] : list))
      if (opt.isObserverOn) void seedAgent($, agentId, e.prompt).catch(() => {})
      await addTimeline($, 'task', `Agent: ${e.description}`)
      startTicker($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    // The steps counted as they came; this is only what they missed.
    const used = await settleTurn($, e.agentId, e.usage, e.durationMs)
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await update($, agentsAtom, list =>
        list.map(a =>
          a.id === agentId
            ? { ...a, status: e.reason === 'error' ? ('error' as const) : ('done' as const), endedAt: nowMs(), tokens: a.tokens + used, currentTool: undefined }
            : a,
        ),
      )
      await attribute($, used, agentId)
      const isError = e.reason === 'error' || e.isAborted
      const node = (await read($, agentsAtom)).find(a => a.id === agentId)
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
    void flushStats($).catch(() => {})
    void refreshContext($).catch(() => {})
    void flushSpend($).catch(() => {})
    await update($, agentsAtom, list =>
      list.map(a => (a.id === 'main' ? { ...a, status: 'idle' as const, tokens: a.tokens + used, currentTool: undefined } : a)),
    )
    setCurrent($, null, undefined, undefined)
    await publishLive($)
    await attribute($, used)
    await setTasks($, (list, rootId) => list.map(t => (t.id === rootId && t.status === 'running' ? { ...t, status: 'waiting' as const } : t)))
    void refreshUsage($).catch(() => {})
    void publishPeer($).catch(() => {})
    flushTimer?.cancel()
    flushTimer = undefined
    const answer = e.answer
    // The turn's end settles decisions at once rather than after the quiet.
    if (decideLines.length > 0) {
      decideTimer?.cancel()
      decideTimer = undefined
      void decide($).catch(() => {})
    }
    void (async () => {
      await reconcile($, answer)
      await saveSummary($)
      await publishPeer($)
    })().catch(() => {})

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
    await update($, usageAtom, () => view)
    // Between turns the heatmap follows the window from here too, and gets
    // its first reading here when turn.complete's refresh gave none; never
    // mid-turn, so "per turn" stays one reading a turn.
    const measured = e.context.tokens
    if (measured !== undefined && !isTurnRunning && measured !== lastMeasured) {
      lastMeasured = measured
      const ctx = await read($, contextAtom)
      if (ctx === null || Math.abs(ctx.used - measured) > 2000) void refreshContext($, e.context).catch(() => {})
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

  // Counts the response as it streams, for tok/s; every chunk passes on as
  // it came. The hook's budget counts its own code alone, not the stream.
  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    if (e.agentId !== undefined) {
      const id = e.agentId
      const model = e.model
      lastActivity.set(id, nowMs())
      // Read first: most steps find the model already set and write nothing.
      void read($, agentsAtom)
        .then(list => (list.some(a => a.id === id && a.model === '') ? update($, agentsAtom, l => l.map(a => (a.id === id && a.model === '' ? { ...a, model } : a))) : undefined))
        .catch(() => {})
    }
    streamCount += 1
    try {
      startSampler($)
    } catch {
      // No sampler: turn.complete still settles the figures.
    }
    let isTallied = false
    try {
      const stream = next(e)
      for await (const c of stream) {
        const n = chunkChars(c)
        streamChars += n
        if (n > 0) streamCharsBy.set(e.agentId ?? 'main', (streamCharsBy.get(e.agentId ?? 'main') ?? 0) + n)
        // The stop chunk carries the usage first: counted here, before
        // anything after the stream could fail.
        if (c.kind === 'stop' && c.usage !== null && !isTallied) {
          isTallied = true
          tallyStep(c.usage, e.agentId)
        }
        yield c
      }
      const r = await stream.result
      if (r.usage !== null && !isTallied) {
        isTallied = true
        tallyStep(r.usage, e.agentId)
      }
      if (isMain && r.answer.trim() !== '') buffer.push(`Agent said: ${r.answer.replace(/\s+/g, ' ').slice(0, 300)}`)
      if (r.answer.trim() !== '') noteForDecisions($, `${isMain ? 'Agent' : `[agent ${e.agentId}]`} said: ${r.answer}`)

      return r
    } finally {
      streamCount = Math.max(0, streamCount - 1)
    }
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (r.skip === undefined) {
      stat(d => {
        d.compactions = 1
      })
    }

    return r
  })

  on('session.end', async ($, e, next) => {
    if (sessionId !== '') await $.store.delete(`peer:${sessionId}`)
    await flushStats($).catch(() => {})

    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    if (/permission|idle|elicitation|input/i.test(e.notification_type)) await attention($, e.message.slice(0, 80))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    await attention($, `Permission needed: ${e.tool_name}`)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.describe', async ($, e, next) => {
    const d = await next(e)
    if (opt.nudge !== 'describe' || (e.tool !== 'TaskCreate' && e.tool !== 'TodoWrite')) return d

    return { ...d, description: d.description + DESCRIBE_EXTRA }
  })

  on('command.run', { command: 'atelier' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    if (verb === 'close') {
      await $.ui.close({ id: PANE })

      return { text: 'Atelier closed.' }
    }
    if (verb === 'compact') {
      await update($, viewAtom, v => ({ ...v, isCompact: !v.isCompact }))
      await open($, e.presentation.columns)

      return { text: 'Atelier compact mode toggled.' }
    }
    if (verb === 'stats') {
      await flushStats($)
      await setView($, v => ({ ...v, isStats: v.isStats !== true, isDetail: false }))
      await open($, e.presentation.columns)

      return { text: 'Atelier stats view toggled.' }
    }
    if (verb === 'search') {
      const query = rest.join(' ')
      if (query === '') return { text: 'Usage: /atelier search <query>' }
      const hits = await search($, query)
      await open($, e.presentation.columns)
      if (hits.length === 0) return { text: `No matches for "${query}".` }

      return { text: hits.slice(0, 10).map(h => `${new Date(h.at).toISOString().slice(0, 10)} [${h.source}] ${h.text}`).join('\n') }
    }
    await open($, e.presentation.columns)

    return { text: 'Atelier opened. Args: close | compact | stats | search <query>' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const terminal = e.viewport?.columns
    // Sized once from the first docked draw. Resizing on every draw looped:
    // the dock's own width changes the viewport it is measured from, so each
    // request moved the next measurement (flicker). /atelier re-sizes it
    // from the terminal's true width.
    if (terminal !== undefined && e.props.placement === 'dock' && asked === undefined) {
      void open($, terminal).catch(() => {})
    }
    const [tasks, rootId, agents, usage, feed, current, files, alerts, view, observer, timeline, confidence, peers, handoff, found, decisions, rate, cache, context, spend] =
      await Promise.all([
        read($, tasksAtom),
        read($, rootAtom),
        read($, agentsAtom),
        read($, usageAtom),
        read($, feedAtom),
        read($, currentAtom),
        read($, filesAtom),
        read($, alertsAtom),
        read($, viewAtom),
        read($, observerAtom),
        read($, timelineAtom),
        read($, confidenceAtom),
        read($, peersAtom),
        read($, handoffAtom),
        read($, searchAtom),
        read($, decisionsAtom),
        read($, rateAtom),
        read($, cacheAtom),
        read($, contextAtom),
        read($, spendAtom),
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
    const swallow = (p: Promise<unknown>) => void p.catch(() => {})
    const now = await $.clock.now()
    const stats = await read($, statsAtom)
    const agentRates = await read($, agentRatesAtom)

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
        toggleUsageTab: () => swallow(setView($, v => ({ ...v, usageTab: v.usageTab === 'api' ? 'limits' : 'api' }))),
        toggleDetail: () => swallow(setView($, v => ({ ...v, isDetail: v.isDetail !== true, isStats: false }))),
        toggleStats: () => swallow(setView($, v => ({ ...v, isStats: v.isStats !== true, isDetail: false }))),
        cycleRange: () => {
          statsRange = RANGES[(RANGES.indexOf(statsRange) + 1) % RANGES.length] ?? 'today'
          $.ui.invalidate('ui.render')
        },
        toggleCompact: () => swallow(update($, viewAtom, v => ({ ...v, isCompact: !v.isCompact }))),
        toggleNote: () => swallow(update($, viewAtom, v => ({ ...v, isNoteOpen: !v.isNoteOpen }))),
        stop: () => swallow(interrupt($)),
        compact: () => swallow(compactNow($)),
        tests: () => swallow(runTests($)),
        checkpoint: () => swallow(commitCheckpoint($)),
        sendNote: text => swallow(sendNote($, text)),
        answer: (id, option) => swallow(answerDecision($, id, option)),
        revert: id => swallow(revertDecision($, id)),
        openDiff: path => swallow(openDiff($, path)),
        useHandoff: () => (handoff === null ? undefined : swallow($.prompt.fill({ text: handoffText(handoff) }))),
        dismissHandoff: () => swallow(update($, handoffAtom, () => null)),
        closeSearch: () => swallow(update($, searchAtom, () => null)),
      },
    )
  })
}
