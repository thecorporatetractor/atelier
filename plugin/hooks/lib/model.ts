// Pure logic of the sidebar: no `$`, so the tests reach every rule directly.
import type { AgentNode, ContextView, DayStats, Decision, Phase, StatsRange, StatsView, Task, TaskStatus, TokenKinds } from '../../types'

export const PHASES: readonly Phase[] = ['exploring', 'planning', 'editing', 'verifying', 'done']

export const PHASE_RANGES: Record<Phase, readonly [number, number]> = {
  exploring: [0, 0.2],
  planning: [0.2, 0.3],
  editing: [0.3, 0.75],
  verifying: [0.75, 0.95],
  done: [1, 1],
}

const STATUSES: readonly TaskStatus[] = ['pending', 'running', 'waiting', 'blocked', 'done']

export const MAX_TASKS = 200

export function clamp01(n: number) {
  return Math.min(1, Math.max(0, n))
}

export function isPhase(v: unknown): v is Phase {
  return typeof v === 'string' && (PHASES as readonly string[]).includes(v)
}

export function isStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v)
}

/** Progress a phase alone stands for: the estimate held inside its range. */
export function phaseProgress(phase: Phase, estimate?: number) {
  const [lo, hi] = PHASE_RANGES[phase]

  return estimate === undefined ? lo : Math.min(hi, Math.max(lo, estimate))
}

/** The phase a tool call suggests, or undefined when it says nothing. */
export function phaseOfTool(tool: string, command?: string): Phase | undefined {
  if (/^(Read|Grep|Glob|WebFetch|WebSearch|LSP|ToolSearch)$/.test(tool)) return 'exploring'
  if (/^(TaskCreate|TodoWrite|EnterPlanMode|ExitPlanMode)$/.test(tool)) return 'planning'
  if (/^(Edit|Write|NotebookEdit)$/.test(tool)) return 'editing'
  if (tool === 'Bash' && command !== undefined) {
    if (isVerifyCommand(command)) return 'verifying'
    if (/^\s*(ls|cat|grep|rg|find|head|tail|sed -n|git (log|status|diff|show))\b/.test(command)) return 'exploring'
  }

  return undefined
}

export function isVerifyCommand(command: string) {
  return /\b(test|tests|jest|vitest|pytest|mocha|tsc|typecheck|lint|eslint|cargo (test|check)|go (test|vet)|make check|plugin (test|validate))\b/.test(command)
}

export function isTypecheckCommand(command: string) {
  return /\b(tsc|typecheck|mypy|pyright|cargo check|go vet)\b/.test(command)
}

export function childrenOf(tasks: readonly Task[], id: string) {
  return tasks.filter(t => t.parentId === id)
}

/**
 * Where a task's bar should stand, by the priority of sources: declared
 * subtasks done/total, then inferred subtasks done/total, then its phase.
 */
export function targetProgress(task: Task, tasks: readonly Task[]): number {
  if (task.status === 'done') return 1
  const kids = childrenOf(tasks, task.id)
  const declared = kids.filter(k => k.source === 'declared')
  const counted = declared.length > 0 ? declared : kids
  if (counted.length > 0) {
    // A step half done counts half, so the parent moves within a step too.
    const sum = counted.reduce((n, k) => n + (k.status === 'done' ? 1 : k.progress), 0)

    return Math.min(0.99, sum / counted.length)
  }

  return phaseProgress(task.phase, task.estimate)
}

/** Applies the monotonic rule: a bar only goes back when re-scoped. */
export function settle(tasks: readonly Task[]): Task[] {
  // Children first, so a parent reads its children's settled values.
  const depth = (t: Task) => {
    let d = 0
    let p = t.parentId
    while (p !== null && d < 20) {
      d += 1
      p = tasks.find(x => x.id === p)?.parentId ?? null
    }

    return d
  }
  const order = [...tasks].sort((a, b) => depth(b) - depth(a))
  const byId = new Map(tasks.map(t => [t.id, t]))
  for (const t of order) {
    const now = byId.get(t.id) as Task
    const target = clamp01(targetProgress(now, [...byId.values()]))
    const progress = now.rescoped !== undefined ? target : Math.max(now.progress, target)
    byId.set(t.id, { ...now, progress, rescoped: undefined })
  }

  return tasks.map(t => byId.get(t.id) as Task).slice(-MAX_TASKS)
}

/** Re-scopes a task: its next settle may lower the bar, noting why. */
export function rescope(tasks: readonly Task[], id: string, why: string): Task[] {
  return tasks.map(t => (t.id === id ? { ...t, rescoped: why, note: `re-scoped: ${why}` } : t))
}

// ---------- the observer's diff ----------

export type DiffAdd = { id?: string; title: string; parentId?: string | null; status?: TaskStatus; phase?: Phase; progress?: number }
export type DiffUpdate = { id: string; status?: TaskStatus; phase?: Phase; progress?: number; note?: string; title?: string }
export type DecisionInput = Partial<Omit<Decision, 'at'>> & { title: string }
export type TaskDiff = {
  add: DiffAdd[]
  update: DiffUpdate[]
  complete: string[]
  merge: { inferredId: string; declaredId: string }[]
  decisions?: DecisionInput[]
}

function str(v: unknown, max = 200) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined
}

function num(v: unknown) {
  return typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : undefined
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** The first JSON object in a reply, fences and prose around it ignored. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/** A validated diff, or undefined when the reply is not one. */
export function parseDiff(text: string): TaskDiff | undefined {
  const root = obj(extractJson(text))
  if (root === undefined) return undefined
  const known = ['add', 'update', 'complete', 'merge', 'decisions']
  if (!known.some(k => k in root)) return undefined
  if (known.some(k => k in root && !Array.isArray(root[k]))) return undefined

  const add: DiffAdd[] = []
  for (const raw of arr(root.add)) {
    const o = obj(raw)
    const title = str(o?.title)
    if (o === undefined || title === undefined) continue
    add.push({
      id: str(o.id, 64),
      title,
      parentId: o.parentId === null ? null : str(o.parentId, 64),
      status: isStatus(o.status) ? o.status : undefined,
      phase: isPhase(o.phase) ? o.phase : undefined,
      progress: num(o.progress),
    })
  }
  const update: DiffUpdate[] = []
  for (const raw of arr(root.update)) {
    const o = obj(raw)
    const id = str(o?.id, 64)
    if (o === undefined || id === undefined) continue
    update.push({
      id,
      status: isStatus(o.status) ? o.status : undefined,
      phase: isPhase(o.phase) ? o.phase : undefined,
      progress: num(o.progress),
      note: str(o.note, 120),
      title: str(o.title),
    })
  }
  const complete = arr(root.complete).map(v => str(v, 64)).filter((v): v is string => v !== undefined)
  const merge: TaskDiff['merge'] = []
  for (const raw of arr(root.merge)) {
    const o = obj(raw)
    const inferredId = str(o?.inferredId, 64)
    const declaredId = str(o?.declaredId, 64)
    if (inferredId !== undefined && declaredId !== undefined) merge.push({ inferredId, declaredId })
  }

  const decisions = arr(root.decisions).map(parseDecision).filter((d): d is DecisionInput => d !== undefined)

  return { add, update, complete, merge, decisions }
}

function strs(v: unknown, max = 8, len = 80) {
  return arr(v).map(x => str(x, len)).filter((x): x is string => x !== undefined).slice(0, max)
}

/** One decision from the observer's reply, or undefined when it has no title. */
export function parseDecision(raw: unknown): DecisionInput | undefined {
  const o = obj(raw)
  const title = str(o?.title, 40)
  if (o === undefined || title === undefined) return undefined
  const rejected: Decision['rejected'] = []
  for (const r of arr(o.rejected)) {
    const ro = obj(r)
    const option = str(ro?.option, 60) ?? str(r, 60)
    if (option !== undefined) rejected.push({ option, reason: str(ro?.reason, 30) ?? '' })
  }

  return {
    id: str(o.id, 64),
    title,
    chosen: str(o.chosen, 60),
    rejected: rejected.slice(0, 4),
    rationale: str(o.rationale, 100),
    confidence: num(o.confidence),
    isReversible: typeof o.reversible === 'boolean' ? o.reversible : undefined,
    evidence: strs(o.evidence, 4, 40),
    files: typeof o.files === 'number' && o.files >= 0 ? Math.round(o.files) : undefined,
    isPending: typeof o.pending === 'boolean' ? o.pending : undefined,
    lean: str(o.lean, 60),
    options: strs(o.options, 4, 60),
    blocks: str(o.blocks, 40),
    outsidePlan: str(o.outsidePlan, 60),
  }
}

export const DECISIONS_MAX = 30

/** Adds new decisions and updates known ones, matched by id, then by title. */
export function applyDecisions(list: readonly Decision[], incoming: readonly DecisionInput[], now: number): Decision[] {
  let out = [...list]
  for (const d of incoming) {
    const at = out.findIndex(x => (d.id !== undefined && x.id === d.id) || x.title.toLowerCase() === d.title.toLowerCase())
    const defined = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)))
    if (at >= 0) {
      const was = out[at] as Decision
      out[at] = { ...was, ...defined, id: was.id, at: was.at }
    } else {
      out.push({
        id: d.id ?? `dc${now.toString(36)}${out.length}`,
        at: now,
        title: d.title,
        chosen: d.chosen ?? '',
        rejected: d.rejected ?? [],
        rationale: d.rationale ?? '',
        confidence: d.confidence ?? 0.5,
        isReversible: d.isReversible ?? true,
        evidence: d.evidence ?? [],
        files: d.files ?? 0,
        isPending: d.isPending ?? false,
        lean: d.lean,
        options: d.options,
        blocks: d.blocks,
        outsidePlan: d.outsidePlan,
      })
    }
  }

  return out.slice(-DECISIONS_MAX)
}

/** Closes the pending decisions once the person answered in a prompt. */
export function answerPending(list: readonly Decision[], answer: string): Decision[] {
  const said = answer.trim().split('\n')[0]?.slice(0, 50) ?? ''

  return list.map(d => (d.isPending ? { ...d, isPending: false, chosen: d.chosen || `you: ${said}`, blocks: undefined } : d))
}

export function newTask(fields: Partial<Task> & Pick<Task, 'id' | 'title'>, now: number): Task {
  return {
    parentId: null,
    source: 'inferred',
    status: 'pending',
    phase: 'exploring',
    progress: 0,
    confidence: 0.6,
    startedAt: now,
    updatedAt: now,
    tokens: 0,
    order: now,
    ...fields,
  }
}

/** Folds an inferred task into the declared one it duplicates. */
export function mergeTasks(tasks: readonly Task[], inferredId: string, declaredId: string): Task[] {
  const inferred = tasks.find(t => t.id === inferredId)
  const declared = tasks.find(t => t.id === declaredId)
  if (inferred === undefined || declared === undefined) return [...tasks]
  if (inferred.source !== 'inferred' || declared.source !== 'declared') return [...tasks]

  return tasks
    .filter(t => t.id !== inferredId)
    .map(t => {
      if (t.id === declaredId) {
        return {
          ...t,
          tokens: t.tokens + inferred.tokens,
          startedAt: Math.min(t.startedAt, inferred.startedAt),
          progress: Math.max(t.progress, inferred.progress),
          isPinned: t.isPinned === true || inferred.isPinned === true,
        }
      }

      return t.parentId === inferredId ? { ...t, parentId: declaredId } : t
    })
}

/**
 * Applies an observer diff. Declared tasks are Claude's: the observer may
 * move their phase and note, never their status or title.
 */
export function applyDiff(tasks: readonly Task[], diff: TaskDiff, now: number, rootId: string | null): Task[] {
  let list = [...tasks]
  const ids = new Set(list.map(t => t.id))
  const minted = new Map<string, string>()
  let n = 0
  for (const a of diff.add) {
    let id = `i${now.toString(36)}${(n += 1)}`
    while (ids.has(id)) id = `${id}x`
    if (a.id !== undefined) minted.set(a.id, id)
    ids.add(id)
    const parent = a.parentId === undefined || a.parentId === 'root' ? rootId : a.parentId === null ? null : (minted.get(a.parentId) ?? a.parentId)
    list.push(
      newTask(
        {
          id,
          title: a.title,
          parentId: parent !== null && ids.has(parent) ? parent : rootId,
          status: a.status ?? 'pending',
          phase: a.phase ?? 'exploring',
          estimate: a.progress,
          order: now + n,
        },
        now,
      ),
    )
  }
  for (const u of diff.update) {
    list = list.map(t => {
      if (t.id !== u.id) return t
      const isDeclared = t.source === 'declared'
      const phase = u.phase ?? t.phase
      // A phase that goes backwards is a re-scope: the bar may follow it down.
      const isBack = PHASES.indexOf(phase) < PHASES.indexOf(t.phase)

      return {
        ...t,
        phase,
        estimate: u.progress ?? (u.phase !== undefined ? undefined : t.estimate),
        status: isDeclared || u.status === undefined ? t.status : u.status,
        title: isDeclared || u.title === undefined ? t.title : u.title,
        note: u.note ?? t.note,
        rescoped: isBack ? `back to ${phase}` : t.rescoped,
        updatedAt: now,
      }
    })
  }
  for (const id of diff.complete) {
    list = list.map(t =>
      t.id === id && t.source === 'inferred' ? { ...t, status: 'done' as const, phase: 'done' as const, updatedAt: now } : t,
    )
  }
  for (const m of diff.merge) list = mergeTasks(list, m.inferredId, m.declaredId)

  return settle(list)
}

// ---------- tool calls in plain language ----------

export function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function shortCommand(command: string) {
  return command.replace(/\s+/g, ' ').trim().slice(0, 60)
}

type Loose = Record<string, unknown>

function field(input: Loose, key: string) {
  const v = input[key]

  return typeof v === 'string' ? v : undefined
}

/** One line a person reads: "Editing auth.ts", "Running tests". */
export function describeCall(tool: string, input: Loose): string {
  const file = field(input, 'file_path') ?? field(input, 'notebook_path') ?? field(input, 'path')
  const command = field(input, 'command')
  switch (tool) {
    case 'Read':
      return `Reading ${basename(file ?? '')}`
    case 'Edit':
    case 'NotebookEdit':
      return `Editing ${basename(file ?? '')}`
    case 'Write':
      return `Writing ${basename(file ?? '')}`
    case 'Grep':
      return `Searching for ${field(input, 'pattern') ?? ''}`.trim()
    case 'Glob':
      return `Finding ${field(input, 'pattern') ?? 'files'}`
    case 'WebFetch':
      return `Fetching ${field(input, 'url') ?? 'a page'}`
    case 'WebSearch':
      return `Searching the web: ${field(input, 'query') ?? ''}`
    case 'Agent':
      return `Starting agent: ${field(input, 'description') ?? ''}`
    case 'TaskCreate':
      return `Planning: ${field(input, 'subject') ?? ''}`
    case 'TaskUpdate':
      return 'Updating a task'
    case 'TodoWrite':
      return 'Updating the plan'
    case 'AskUserQuestion':
      return 'Asking you a question'
    case 'Bash': {
      const c = command ?? ''
      if (isVerifyCommand(c)) return /\btsc|typecheck\b/.test(c) ? 'Type-checking' : 'Running tests'
      if (/^\s*git\b/.test(c)) return `Git: ${shortCommand(c.replace(/^\s*git\s+/, ''))}`
      if (/^\s*(npm|pnpm|yarn|bun) (i|install|add)\b/.test(c)) return 'Installing packages'

      return field(input, 'description') ?? `Running ${shortCommand(c)}`
    }
    default:
      return tool.startsWith('mcp__') ? `Calling ${tool.split('__').slice(1).join(' ')}` : `Using ${tool}`
  }
}

/** What identifies "the same attempt again": the tool and its target. */
export function signatureOf(tool: string, input: Loose): string {
  const command = field(input, 'command')
  if (command !== undefined) return `${tool}:${command.replace(/\s+/g, ' ').trim()}`
  const file = field(input, 'file_path')
  const old = field(input, 'old_string')
  if (file !== undefined) return `${tool}:${file}:${(old ?? '').slice(0, 80)}`

  return `${tool}:${JSON.stringify(input).slice(0, 120)}`
}

/** A compact line for the observer's buffer. */
export function summarizeCall(tool: string, input: Loose, outcome: 'ok' | 'error' | 'denied', agentId?: string) {
  const target = field(input, 'file_path') ?? field(input, 'command') ?? field(input, 'pattern') ?? field(input, 'subject') ?? ''

  return `${agentId !== undefined ? `[agent ${agentId}] ` : ''}${tool} ${shortCommand(target)} -> ${outcome}`
}

// ---------- subagent tasks ----------

/** The top-level task a subagent's work hangs under, if it has one. */
export function agentTaskOf(tasks: readonly Task[], agentId: string) {
  return tasks.find(t => t.agentId === agentId && t.parentId === null)
}

/** A subagent's own task, top level: kept out of the prompt root's progress. */
export function agentTask(agentId: string, title: string, now: number): Task {
  return newTask({ id: `a:${agentId}`, agentId, title: title.slice(0, 80), status: 'running', confidence: 0, order: now }, now)
}

/**
 * Moves the phase forward on the running leaf tasks of one loop: the main
 * loop's (under the root, no agent id) or one subagent's (its agent id).
 */
export function advancePhase(tasks: readonly Task[], phase: Phase, rootId: string | null, agentId: string | undefined, now: number): Task[] {
  return tasks.map(t => {
    const isOwn = agentId === undefined ? t.agentId === undefined && (t.id === rootId || t.source === 'declared') : t.agentId === agentId
    const isLeaf = childrenOf(tasks, t.id).length === 0
    const isForward = PHASES.indexOf(phase) > PHASES.indexOf(t.phase)

    return isOwn && isLeaf && t.status === 'running' && isForward ? { ...t, phase, updatedAt: now } : t
  })
}

/** A subagent's work ends: its task and open inferred steps close, or the task blocks on error. */
export function finishAgentTask(tasks: readonly Task[], agentId: string, isError: boolean, now: number): Task[] {
  return tasks.map(t => {
    if (t.agentId !== agentId || t.status === 'done') return t
    if (isError) return t.parentId === null ? { ...t, status: 'blocked' as const, updatedAt: now } : t
    // Claude's own declared steps keep the status it gave them.
    if (t.parentId !== null && t.source === 'declared') return t

    return { ...t, status: 'done' as const, phase: 'done' as const, updatedAt: now }
  })
}

/** Where usage is charged: the loop's running step, else its own task, else the root. */
export function chargeableFor(tasks: readonly Task[], rootId: string | null, agentId: string | undefined) {
  if (agentId !== undefined) {
    const own = agentTaskOf(tasks, agentId)
    const step = tasks.filter(t => t.agentId === agentId && t.status === 'running' && t.parentId !== null).at(-1)

    return step?.id ?? own?.id ?? rootId
  }
  const running = tasks.filter(t => t.status === 'running' && t.id !== rootId && t.agentId === undefined)

  return running.at(-1)?.id ?? rootId
}

export type AgentTaskRow = {
  agentId: string
  type: string
  title: string
  status: TaskStatus
  progress: number
  confidence: number
  steps: Task[]
  isRunning: boolean
}

const RECENT_MS = 2 * 60_000

/** Subagent tasks for the status block: running first, then finished in the last 2 min; newest first. */
export function agentTaskRows(tasks: readonly Task[], agents: readonly AgentNode[], now: number): AgentTaskRow[] {
  const rows: (AgentTaskRow & { at: number })[] = []
  for (const a of agents) {
    if (a.id === 'main') continue
    const t = agentTaskOf(tasks, a.id)
    if (t === undefined) continue
    const isRunning = a.status === 'running'
    if (!isRunning && now - (a.endedAt ?? t.updatedAt) > RECENT_MS) continue
    rows.push({
      agentId: a.id,
      type: a.type,
      title: t.title,
      status: t.status,
      progress: t.progress,
      confidence: t.confidence,
      steps: ordered(childrenOf(tasks, t.id)),
      isRunning,
      at: a.startedAt,
    })
  }

  return rows.sort((x, y) => Number(y.isRunning) - Number(x.isRunning) || y.at - x.at).map(({ at: _at, ...row }) => row)
}

export type AgentListEntry = { id: string; type: string; description: string; status: string }

/** The engine's agent statuses folded into the sidebar's four. */
export function nodeStatus(status: string): AgentNode['status'] {
  if (status === 'running' || status === 'pending') return 'running'
  if (status === 'completed') return 'done'
  if (status === 'failed' || status === 'killed') return 'error'

  return 'idle'
}

/**
 * Folds the engine's agent list into the sidebar's nodes: agents it never saw
 * spawn (started before the mod loaded, or resumed by a message) join, and
 * statuses follow the list. Answers the ids that are running now and were
 * not before, so their tasks can open.
 */
export function mergeAgentList(nodes: readonly AgentNode[], list: readonly AgentListEntry[], now: number) {
  const out = [...nodes]
  const started: string[] = []
  for (const info of list) {
    const status = nodeStatus(info.status)
    const at = out.findIndex(n => n.id === info.id)
    if (at < 0) {
      // One that finished before the mod saw it has nothing to show: left out, so the list stays small.
      if (status === 'done' || status === 'error') continue
      out.push({ id: info.id, type: info.type, model: '', description: info.description, status, tokens: 0, startedAt: now, isBackground: true })
      if (status === 'running') started.push(info.id)
      continue
    }
    const was = out[at] as AgentNode
    if (was.status === status) continue
    if (status === 'running') started.push(info.id)
    out[at] = {
      ...was,
      status,
      startedAt: status === 'running' ? now : was.startedAt,
      endedAt: status === 'running' ? undefined : (was.endedAt ?? now),
      currentTool: status === 'running' ? was.currentTool : undefined,
    }
  }

  return { nodes: out, started }
}

/** Whether two plain-data values are the same, so a write that changes nothing can be skipped. */
export function isSame(a: unknown, b: unknown) {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

export const AGENTS_MAX = 30

/**
 * Keeps the agent list bounded without churn: `main` and every running
 * agent always stay; finished ones fill what is left, newest first.
 */
export function trimAgents(nodes: readonly AgentNode[], max = AGENTS_MAX): AgentNode[] {
  const keep = new Set(nodes.filter(n => n.id === 'main' || n.status === 'running').map(n => n.id))
  const finished = nodes
    .filter(n => !keep.has(n.id))
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
    .slice(0, Math.max(0, max - keep.size))
  for (const n of finished) keep.add(n.id)

  return nodes.filter(n => keep.has(n.id))
}

/**
 * Sets each agent's current tool from the pending map (`undefined` clears);
 * answers the same array when nothing changes, so the caller skips the write.
 */
export function applyCurrentTools(nodes: readonly AgentNode[], tools: ReadonlyMap<string, string | undefined>): readonly AgentNode[] {
  let isChanged = false
  const next = nodes.map(n => {
    if (!tools.has(n.id)) return n
    const tool = tools.get(n.id)
    if (n.currentTool === tool) return n
    isChanged = true

    return { ...n, currentTool: tool }
  })

  return isChanged ? next : nodes
}

/** Running subagents that showed activity within `staleMs`; `main` is the turn's, not counted here. */
export function liveAgents(nodes: readonly AgentNode[], lastActivity: ReadonlyMap<string, number>, now: number, staleMs: number) {
  return nodes.filter(n => n.id !== 'main' && n.status === 'running' && now - (lastActivity.get(n.id) ?? n.startedAt) < staleMs)
}

/** Opens a subagent's task: creates it, or reopens a finished one when the agent runs again. */
export function openAgentTask(tasks: readonly Task[], agentId: string, title: string, now: number): Task[] {
  const own = agentTaskOf(tasks, agentId)
  if (own === undefined) return [...tasks, agentTask(agentId, title, now)]
  if (own.status === 'running') return [...tasks]

  return tasks.map(t => (t.id === own.id ? { ...t, status: 'running' as const, phase: 'exploring' as const, rescoped: 'resumed', startedAt: now, updatedAt: now } : t))
}

export function isAnythingRunning(isMainTurnRunning: boolean, agents: readonly AgentNode[]) {
  return isMainTurnRunning || agents.some(a => a.id !== 'main' && a.status === 'running')
}

/**
 * Appends one tok/s sample per loop: each loop still in the agent list gets
 * its rate this tick (zero when it streamed nothing), keeping `window` each.
 */
export function appendRates(rates: Readonly<Record<string, number[]>>, charsBy: ReadonlyMap<string, number>, known: ReadonlySet<string>, tickMs: number, window: number) {
  const next: Record<string, number[]> = {}
  for (const key of new Set([...Object.keys(rates), ...charsBy.keys()])) {
    if (!known.has(key)) continue
    const rate = (charsBy.get(key) ?? 0) / 4 / (tickMs / 1000)
    next[key] = [...(rates[key] ?? []), rate].slice(-window)
  }

  return next
}

// ---------- usage stats, per day ----------

export const STATS_DAYS = 120

export function emptyKinds(): TokenKinds {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

export function emptyDay(): DayStats {
  return {
    cost: 0,
    requests: 0,
    turns: 0,
    turnMs: 0,
    sessions: 0,
    compactions: 0,
    linesAdded: 0,
    linesRemoved: 0,
    filesEdited: 0,
    testsPassed: 0,
    testsFailed: 0,
    tokens: emptyKinds(),
    byModel: {},
    byProject: {},
    tools: {},
    agents: {},
    observer: { calls: 0, input: 0, output: 0 },
  }
}

function addKinds(a: TokenKinds, b: TokenKinds): TokenKinds {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite }
}

export function kindsTotal(k: TokenKinds) {
  return k.input + k.output + k.cacheRead + k.cacheWrite
}

function addRecord<T extends Record<string, number>>(a: Record<string, T>, b: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = { ...a }
  for (const [key, v] of Object.entries(b)) {
    const was = out[key]
    if (was === undefined) {
      out[key] = { ...v }
      continue
    }
    const sum = { ...was } as Record<string, number>
    for (const [f, n] of Object.entries(v)) sum[f] = (sum[f] ?? 0) + n
    out[key] = sum as T
  }

  return out
}

/** Sums two days field by field; a stored day may predate a field, so each read defaults. */
export function addDay(a: Partial<DayStats>, b: DayStats): DayStats {
  const x = { ...emptyDay(), ...a }

  return {
    cost: x.cost + b.cost,
    requests: x.requests + b.requests,
    turns: x.turns + b.turns,
    turnMs: x.turnMs + b.turnMs,
    sessions: x.sessions + b.sessions,
    compactions: x.compactions + b.compactions,
    linesAdded: x.linesAdded + b.linesAdded,
    linesRemoved: x.linesRemoved + b.linesRemoved,
    filesEdited: x.filesEdited + b.filesEdited,
    testsPassed: x.testsPassed + b.testsPassed,
    testsFailed: x.testsFailed + b.testsFailed,
    tokens: addKinds({ ...emptyKinds(), ...x.tokens }, b.tokens),
    byModel: addRecord(x.byModel, b.byModel),
    byProject: addRecord(x.byProject, b.byProject),
    tools: addRecord(x.tools, b.tools),
    agents: addRecord(x.agents, b.agents),
    observer: { calls: x.observer.calls + b.observer.calls, input: x.observer.input + b.observer.input, output: x.observer.output + b.observer.output },
  }
}

/** Whether a pending delta holds anything worth a store write. */
export function isEmptyDay(d: DayStats) {
  return (
    d.cost === 0 &&
    d.requests === 0 &&
    d.turns === 0 &&
    d.sessions === 0 &&
    d.compactions === 0 &&
    d.filesEdited === 0 &&
    d.linesAdded === 0 &&
    d.linesRemoved === 0 &&
    d.testsPassed + d.testsFailed === 0 &&
    kindsTotal(d.tokens) === 0 &&
    Object.keys(d.tools).length === 0 &&
    Object.keys(d.agents).length === 0 &&
    d.observer.calls === 0
  )
}

export function dayKey(ms: number) {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Keeps the newest STATS_DAYS days. */
export function pruneDays(days: Record<string, DayStats>): Record<string, DayStats> {
  const keep = Object.keys(days).sort().slice(-STATS_DAYS)

  return Object.fromEntries(keep.map(k => [k, days[k] as DayStats]))
}

function rangeOf(days: readonly DayStats[]): StatsRange {
  const d = days.reduce((acc, x) => addDay(acc, x), emptyDay())
  const readable = d.tokens.input + d.tokens.cacheRead + d.tokens.cacheWrite
  const own = kindsTotal(d.tokens)

  return {
    cost: d.cost,
    requests: d.requests,
    turns: d.turns,
    avgTurnMs: d.turns > 0 ? d.turnMs / d.turns : 0,
    sessions: d.sessions,
    compactions: d.compactions,
    tokens: d.tokens,
    cacheHitRate: readable > 0 ? d.tokens.cacheRead / readable : 0,
    linesAdded: d.linesAdded,
    linesRemoved: d.linesRemoved,
    filesEdited: d.filesEdited,
    testsPassed: d.testsPassed,
    testsFailed: d.testsFailed,
    observer: d.observer,
    observerShare: own > 0 ? (d.observer.input + d.observer.output) / own : 0,
  }
}

/** The Stats view's figures: ranges, 30-day series, and the top models, projects, tools and agents of the month. */
export function summarizeStats(days: Readonly<Record<string, DayStats>>, now: number): StatsView {
  const within = (n: number) => Object.entries(days).filter(([k]) => k >= dayKey(now - (n - 1) * 86_400_000)).map(([, v]) => v)
  const month = within(30).reduce((acc, x) => addDay(acc, x), emptyDay())
  const series = Array.from({ length: 30 }, (_, i) => days[dayKey(now - (29 - i) * 86_400_000)])
  const monthTokens = kindsTotal(month.tokens)
  const keys = Object.keys(days).sort()

  return {
    today: rangeOf(within(1)),
    week: rangeOf(within(7)),
    month: rangeOf(within(30)),
    all: rangeOf(Object.values(days)),
    dailyCost: series.map(d => d?.cost ?? 0),
    dailyTokens: series.map(d => (d === undefined ? 0 : kindsTotal({ ...emptyKinds(), ...d.tokens }))),
    models: Object.entries(month.byModel)
      .map(([model, m]) => ({ model, cost: m.cost, tokens: kindsTotal(m), requests: m.requests, share: monthTokens > 0 ? kindsTotal(m) / monthTokens : 0 }))
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
      .slice(0, 6),
    projects: Object.entries(month.byProject)
      .map(([project, p]) => ({ project, ...p }))
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
      .slice(0, 6),
    tools: Object.entries(month.tools)
      .map(([tool, t]) => ({ tool, calls: t.calls, failRate: t.calls > 0 ? t.fails / t.calls : 0, avgMs: t.calls > 0 ? t.ms / t.calls : 0 }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 10),
    agents: Object.entries(month.agents)
      .map(([type, a]) => ({ type, spawns: a.spawns, tokens: a.tokens, avgMs: a.spawns > 0 ? a.ms / a.spawns : 0, failRate: a.spawns > 0 ? a.fails / a.spawns : 0 }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 6),
    activeDays: Object.values(days).filter(d => !isEmptyDay({ ...emptyDay(), ...d })).length,
    since: keys[0] ?? null,
  }
}

// ---------- spin loops ----------

export type Attempts = Record<string, { fails: number; tries: number }>

export const SPIN_AT = 3

/**
 * Counts an attempt; a success clears its record. Answers the warning to
 * show once the same thing failed or was retried SPIN_AT times or more.
 */
export function recordAttempt(attempts: Attempts, signature: string, isFailed: boolean) {
  const was = attempts[signature] ?? { fails: 0, tries: 0 }
  const next = isFailed ? { fails: was.fails + 1, tries: was.tries + 1 } : { fails: 0, tries: was.tries + 1 }
  const out: Attempts = { ...attempts }
  if (!isFailed && was.fails === 0) {
    // A plain success: count tries only for edits, where repeats mean churn.
    if (signature.startsWith('Edit:')) out[signature] = next
    else delete out[signature]
  } else if (!isFailed) {
    delete out[signature]
  } else {
    out[signature] = next
  }
  const count = Math.max(next.fails, signature.startsWith('Edit:') ? next.tries : 0)
  const warning = count >= SPIN_AT ? `Claude has retried this ${count} times` : undefined

  return { attempts: out, count, warning }
}

// ---------- diffs of edits ----------

/** Lines of `next` not in `old` and the other way round, as multisets. */
export function lineDelta(old: string, next: string): { added: number; removed: number } {
  const count = (text: string) => {
    const m = new Map<string, number>()
    if (text === '') return m
    for (const l of text.split('\n')) m.set(l, (m.get(l) ?? 0) + 1)

    return m
  }
  const a = count(old)
  const b = count(next)
  let added = 0
  let removed = 0
  for (const [l, n] of b) added += Math.max(0, n - (a.get(l) ?? 0))
  for (const [l, n] of a) removed += Math.max(0, n - (b.get(l) ?? 0))

  return { added, removed }
}

/**
 * +/- line counts of an Edit or Write: its structured patch when the engine
 * made one, else its git diff, else the strings themselves (the engine
 * leaves `structuredPatch` empty for a large file, or when the diff timed out).
 */
export function patchStats(result: unknown, input?: Loose): { added: number; removed: number } {
  const r = obj(result)
  const hunks = r?.structuredPatch
  let added = 0
  let removed = 0
  for (const h of arr(hunks)) {
    for (const line of arr(obj(h)?.lines)) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  if (added + removed > 0) return { added, removed }
  const git = obj(r?.gitDiff)
  if (git !== undefined && typeof git.additions === 'number' && typeof git.deletions === 'number' && git.additions + git.deletions > 0) {
    return { added: git.additions, removed: git.deletions }
  }
  const old = input === undefined ? undefined : field(input, 'old_string')
  const next = input === undefined ? undefined : field(input, 'new_string')
  if (old !== undefined && next !== undefined) return lineDelta(old, next)
  const content = (input === undefined ? undefined : field(input, 'content')) ?? (typeof r?.content === 'string' ? r.content : undefined)
  if (content !== undefined) {
    const original = typeof r?.originalFile === 'string' ? r.originalFile : ''

    return lineDelta(original, content)
  }

  return { added, removed }
}

/** The path relative to the project root, as the sidebar shows it. */
export function relPath(path: string, root: string) {
  const prefix = root === '' ? '' : `${root.replace(/\/$/, '')}/`

  return prefix !== '' && path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** The Activity line of a call, as the design spells it: `Edit src/a.ts`, `Grep "onResize"`. */
export function feedLine(tool: string, input: Loose, root = ''): string {
  const file = field(input, 'file_path') ?? field(input, 'notebook_path') ?? field(input, 'path')
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `${tool} ${file === undefined ? '' : relPath(file, root)}`.trim()
    case 'Grep':
      return `Grep "${field(input, 'pattern') ?? ''}"`
    case 'Glob':
      return `Glob ${field(input, 'pattern') ?? ''}`.trim()
    case 'WebFetch':
      return `Fetch ${field(input, 'url') ?? ''}`.trim()
    case 'WebSearch':
      return `Search "${field(input, 'query') ?? ''}"`
    case 'Agent':
      return `Agent ${field(input, 'description') ?? ''}`.trim()
    case 'TaskCreate':
      return `Plan ${field(input, 'subject') ?? ''}`.trim()
    case 'TaskUpdate':
      return 'Task update'
    case 'TodoWrite':
      return 'Plan update'
    case 'AskUserQuestion':
      return 'Question for you'
    case 'Bash': {
      const c = field(input, 'command') ?? ''
      if (isVerifyCommand(c)) return /\btsc|typecheck\b/.test(c) ? `tsc ${shortCommand(c).replace(/^.*\btsc\b\s*/, '')}`.trim() : `Tests ${shortCommand(c)}`

      return `$ ${shortCommand(c)}`
    }
    default:
      return tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' ') : tool
  }
}

/** What to show after a call ended: diff counts, hit counts, a failure. */
export function callDetail(tool: string, input: Loose, result: unknown, text: string | undefined, isFailed: boolean): string | undefined {
  if (isFailed) return 'failed'
  const lines = (text ?? '').split('\n').filter(l => l.trim() !== '').length
  switch (tool) {
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const { added, removed } = patchStats(result, input)

      return `+${added} −${removed}`
    }
    case 'Grep': {
      const m = /Found (\d+) (?:files?|matches|lines)/.exec(text ?? '')
      const n = m !== null ? Number(m[1]) : Math.max(0, lines - 1)

      return `${n} hit${n === 1 ? '' : 's'}`
    }
    case 'Glob': {
      const n = /No files found/.test(text ?? '') ? 0 : lines

      return `${n} file${n === 1 ? '' : 's'}`
    }
    case 'Read': {
      const n = obj(obj(result)?.file)?.numLines

      return typeof n === 'number' ? `${n} lines` : undefined
    }
    case 'Bash':
      return lines > 0 ? `${lines} line${lines === 1 ? '' : 's'}` : undefined
    default:
      return undefined
  }
}

/**
 * Appends a feed item; a repeat of the last line (same text, same agent)
 * folds into it, the new id taking over, with a count.
 */
export function pushFeedItem<T extends { id: string; text: string; agentId?: string; count?: number }>(list: readonly T[], item: T, max: number): T[] {
  const last = list.at(-1)
  if (last !== undefined && last.text === item.text && last.agentId === item.agentId) {
    return [...list.slice(0, -1), { ...item, count: (last.count ?? 1) + 1 }]
  }

  return [...list, item].slice(-max)
}

// ---------- drawing helpers ----------

const RING = ['○', '◔', '◑', '◕', '●']

export function ring(progress: number) {
  return RING[Math.round(clamp01(progress) * 4)] as string
}

/** A text bar `width` cells wide; low confidence draws a striped one. */
export function bar(progress: number, width: number, isUnsure: boolean, tick = 0) {
  const w = Math.max(4, width)
  if (isUnsure) {
    const stripe = '▚▞'

    return Array.from({ length: w }, (_, i) => stripe[(i + tick) % 2]).join('')
  }
  const cells = clamp01(progress) * w
  const full = Math.floor(cells)
  const part = cells - full > 0.5 ? '▌' : ''

  return '█'.repeat(full) + part + '░'.repeat(Math.max(0, w - full - part.length))
}

/** Moves a shown value a step toward its target: eased, never a jump. */
export function ease(shown: number, target: number) {
  const gap = target - shown
  if (Math.abs(gap) < 0.005) return target

  return shown + gap * 0.35
}

export function elapsed(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`

  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export function tokens(n: number) {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`

  return `${(n / 1_000_000).toFixed(1)}M`
}

/** Trivial prompts get no seeded task: short questions and one-liners. */
export function looksTrivial(text: string) {
  const t = text.trim()
  if (t.length === 0 || t.startsWith('/')) return true
  const isOneLine = !t.includes('\n')

  return isOneLine && (t.length < 25 || (t.endsWith('?') && t.length < 120))
}

/** Tasks in the order the list draws them: pinned first, then by order. */
export function ordered(tasks: readonly Task[]) {
  return [...tasks].sort((a, b) => Number(b.isPinned === true) - Number(a.isPinned === true) || a.order - b.order)
}

/** Swaps a task with its neighbour among its siblings. */
export function move(tasks: readonly Task[], id: string, by: -1 | 1): Task[] {
  const task = tasks.find(t => t.id === id)
  if (task === undefined) return [...tasks]
  const siblings = ordered(tasks.filter(t => t.parentId === task.parentId && t.isPinned === task.isPinned))
  const at = siblings.findIndex(t => t.id === id)
  const other = siblings[at + by]
  if (other === undefined) return [...tasks]

  return tasks.map(t => (t.id === id ? { ...t, order: other.order } : t.id === other.id ? { ...t, order: task.order } : t))
}

// ---------- the redesign's drawing math ----------

/** Cuts text to `width` cells, ending with an ellipsis when cut. */
export function fit(text: string, width: number) {
  const chars = [...text]
  if (chars.length <= width) return text
  if (width <= 1) return chars.slice(0, Math.max(0, width)).join('')

  return `${chars.slice(0, width - 1).join('')}…`
}

const SPARK = '▁▂▃▅▆▇'

/** A sparkline over `values`, one glyph each, scaled to the largest. */
export function sparkline(values: readonly number[]) {
  const max = Math.max(1, ...values)

  return values.map(v => SPARK[Math.min(SPARK.length - 1, Math.round((Math.max(0, v) / max) * (SPARK.length - 1)))]).join('')
}

/** Confidence as four pips: `▰▰▰▱`. */
export function pips(confidence: number) {
  const n = Math.round(clamp01(confidence) * 4)

  return '▰'.repeat(n) + '▱'.repeat(4 - n)
}

export type HeatCategory = 'system' | 'tools' | 'chat' | 'files' | 'empty'

/**
 * The heatmap's cells in fill order: each cell is `1/cells` of the window,
 * categories laid left to right, top to bottom, the rest empty.
 */
export function heatCells(ctx: Pick<ContextView, 'system' | 'tools' | 'chat' | 'files' | 'window'>, cells: number): HeatCategory[] {
  const per = ctx.window / cells
  const out: HeatCategory[] = []
  let carry = 0
  for (const cat of ['system', 'tools', 'chat', 'files'] as const) {
    carry += ctx[cat] / per
    while (out.length < Math.min(cells, Math.round(carry))) out.push(cat)
  }
  while (out.length < cells) out.push('empty')

  return out
}

/** Turns left before compaction at the average growth per turn. */
export function turnsLeft(ctx: Pick<ContextView, 'used' | 'window' | 'threshold' | 'perTurn'>) {
  const recent = ctx.perTurn.slice(-12).filter(n => n > 0)
  if (recent.length === 0) return { avg: 0, left: undefined }
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length
  const limit = ctx.threshold ?? ctx.window

  return { avg, left: Math.max(0, Math.floor((limit - ctx.used) / avg)) }
}

export type CacheState = { state: 'hot' | 'warm' | 'cold'; remainingMs: number }

/** Hot while more than a minute is left, warm under it, cold at zero. */
export function cacheState(lastHitAt: number | null, ttlMs: number, now: number): CacheState {
  const remainingMs = lastHitAt === null ? 0 : Math.max(0, lastHitAt + ttlMs - now)
  const state = remainingMs <= 0 ? 'cold' : remainingMs < 60_000 ? 'warm' : 'hot'

  return { state, remainingMs }
}

export function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))

  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * The plan's segments: one per step, done ones full, the current one
 * partly filled, upcoming ones empty. Percent is completed steps plus the
 * current step's fraction.
 */
export function planSegments(steps: readonly Pick<Task, 'status' | 'progress'>[]) {
  const current = steps.findIndex(s => s.status !== 'done')
  const done = steps.filter(s => s.status === 'done').length
  const frac = current < 0 ? 0 : clamp01(steps[current]?.progress ?? 0)
  const percent = steps.length === 0 ? 0 : (done + (current < 0 ? 0 : frac)) / steps.length

  return { current, done, frac, percent }
}
