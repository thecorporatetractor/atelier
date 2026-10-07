export type TaskStatus = 'pending' | 'running' | 'waiting' | 'blocked' | 'done'
export type TaskSource = 'declared' | 'inferred'
export type Phase = 'exploring' | 'planning' | 'editing' | 'verifying' | 'done'

export type Task = {
  id: string
  title: string
  parentId: string | null
  source: TaskSource
  status: TaskStatus
  phase: Phase
  /** Shown progress, 0 to 1: never decreases unless the task is re-scoped. */
  progress: number
  /** The latest estimate from a source, before the monotonic rule. */
  estimate?: number
  confidence: number
  startedAt: number
  updatedAt: number
  tokens: number
  /** The subagent whose work this is; absent for the main loop's tasks. */
  agentId?: string
  /** The id Claude's TaskCreate gave a declared task. */
  externalId?: string
  /** Why the task was re-scoped, when it was: lets progress go back once. */
  rescoped?: string
  note?: string
  order: number
  isPinned?: boolean
}

export type AgentNode = {
  id: string
  type: string
  model: string
  description: string
  status: 'running' | 'idle' | 'done' | 'error'
  currentTool?: string
  tokens: number
  startedAt: number
  endedAt?: number
  isBackground: boolean
}

export type UsageView = {
  contextTokens?: number
  window: number
  percent?: number
  costUsd?: number
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
}

export type FeedItem = {
  id: string
  at: number
  text: string
  tool: string
  state: 'running' | 'ok' | 'error'
  agentId?: string
  /** A short outcome once the call ended: `+12 −4`, `14 hits`, `failed`. */
  detail?: string
  /** How many identical calls in a row this line stands for. */
  count?: number
}

export type FileStat = { path: string; added: number; removed: number; edits: number; at: number }

export type Alerts = {
  attention: string | null
  spins: { signature: string; count: number; text: string }[]
  drift: string | null
}

export type ViewState = {
  isCompact: boolean
  isNoteOpen: boolean
  /** `u` toggles the Usage tab; persisted across sessions. */
  usageTab?: 'limits' | 'api'
  /** `d` toggles the Decisions detail view; persisted across sessions. */
  isDetail?: boolean
  /** `s` toggles the Stats view; persisted across sessions. */
  isStats?: boolean
}

/** Token counts by kind. */
export type TokenKinds = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** One day of usage, every session in every project summed; kept in the store. */
export type DayStats = {
  cost: number
  requests: number
  turns: number
  turnMs: number
  sessions: number
  compactions: number
  linesAdded: number
  linesRemoved: number
  filesEdited: number
  testsPassed: number
  testsFailed: number
  tokens: TokenKinds
  byModel: Record<string, TokenKinds & { cost: number; requests: number }>
  byProject: Record<string, { cost: number; tokens: number; turns: number }>
  tools: Record<string, { calls: number; fails: number; ms: number }>
  agents: Record<string, { spawns: number; tokens: number; ms: number; fails: number }>
  observer: { calls: number; input: number; output: number }
}

export type StatsRange = {
  cost: number
  requests: number
  turns: number
  avgTurnMs: number
  sessions: number
  compactions: number
  tokens: TokenKinds
  /** Cache reads over everything read as input, 0 to 1. */
  cacheHitRate: number
  linesAdded: number
  linesRemoved: number
  filesEdited: number
  testsPassed: number
  testsFailed: number
  observer: { calls: number; input: number; output: number }
  /** Observer tokens over the session's own tokens, 0 to 1. */
  observerShare: number
}

/** What the Stats view draws, computed from the store's days. */
export type StatsView = {
  today: StatsRange
  week: StatsRange
  month: StatsRange
  all: StatsRange
  /** Oldest first, one entry a day, the last 30 days. */
  dailyCost: number[]
  dailyTokens: number[]
  models: { model: string; cost: number; tokens: number; requests: number; share: number }[]
  projects: { project: string; cost: number; tokens: number; turns: number }[]
  tools: { tool: string; calls: number; failRate: number; avgMs: number }[]
  agents: { type: string; spawns: number; tokens: number; avgMs: number; failRate: number }[]
  /** Days with any usage, of the kept history. */
  activeDays: number
  since: string | null
}

export type Decision = {
  id: string
  at: number
  title: string
  chosen: string
  rejected: { option: string; reason: string }[]
  rationale: string
  confidence: number
  isReversible: boolean
  evidence: string[]
  files: number
  isPending: boolean
  lean?: string
  options?: string[]
  blocks?: string
  outsidePlan?: string
  isReverted?: boolean
}

/** Output tokens per second, sampled every 1.2s over a 60s window. */
export type RateView = {
  samples: number[]
  peak: number
  sum: number
  count: number
  /** Tokens of every main-loop response this session, for tok/min. */
  tokens: number
}

export type CacheView = {
  lastHitAt: number | null
  ttlMs: number
  readTokens: number
  inputTokens: number
}

export type ContextView = {
  used: number
  window: number
  threshold?: number
  system: number
  tools: number
  chat: number
  files: number
  perTurn: number[]
  /** True when no breakdown was available and the split is an estimate. */
  isEstimate?: boolean
}

export type SpendView = {
  today: number
  week: number
  month: number
  byModel: Record<string, number>
  daily: number[]
}

export type ObserverStats = {
  calls: number
  inputTokens: number
  outputTokens: number
  lastKind: string | null
  dropped: number
}

export type TimelineEntry = { id: string; at: number; kind: 'task' | 'phase' | 'file' | 'alert'; text: string; feedId?: string }

export type Confidence = {
  lastPassAt?: number
  untestedEdits: number
  testsPassed: boolean | null
  typecheckClean: boolean | null
}

export type PeerSession = { id: string; title: string; progress: number; cwd: string; at: number; status: TaskStatus }

export type Summary = {
  sessionId: string
  root: string
  at: number
  done: string[]
  remaining: string[]
  questions: string[]
  text: string
}

export type SearchHit = { at: number; text: string; source: string }

declare module 'claude-code' {
  interface PluginState {
    atelier: {
      tasks: Task[]
      rootId: string | null
      agents: AgentNode[]
      usage: UsageView | null
      feed: FeedItem[]
      current: string | null
      files: FileStat[]
      alerts: Alerts
      view: ViewState
      observer: ObserverStats
      timeline: TimelineEntry[]
      confidence: Confidence
      peers: PeerSession[]
      handoff: Summary | null
      search: { query: string; hits: SearchHit[] } | null
      decisions: Decision[]
      rate: RateView
      cache: CacheView
      context: ContextView | null
      spend: SpendView | null
      stats: StatsView | null
      /** tok/s per loop, `main` and each subagent id: the same 1.2s samples, 50 each. */
      agentRates: Record<string, number[]>
    }
  }
}
