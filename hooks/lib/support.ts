// Pure parts of the hooks module: options, the observer's prompts, and the
// small helpers the hooks use. No `$` here.
import type { ModelUsage, PluginOptions } from 'claude-code'

import type { Summary, Task, TaskStatus } from '../../types'
import { agentTaskOf, PHASES } from './model'

export type Options = {
  isObserverOn: boolean
  observerModel: string
  batchSize: number
  debounceMs: number
  testCommand: TestCommand
  isCompactDefault: boolean
}

export function readOptions(o: PluginOptions): Options {
  return {
    isObserverOn: o.observer !== false,
    observerModel: typeof o.observerModel === 'string' && o.observerModel !== '' ? o.observerModel : 'haiku',
    batchSize: typeof o.batchSize === 'number' && o.batchSize > 0 ? o.batchSize : 5,
    debounceMs: typeof o.debounceMs === 'number' && o.debounceMs > 0 ? o.debounceMs : 4000,
    testCommand: (TEST_COMMANDS as readonly string[]).includes(String(o.testCommand)) ? (o.testCommand as TestCommand) : 'npm test',
    isCompactDefault: o.compactDefault === true,
  }
}

// The test runners the Run tests button may start: one program by name with
// fixed arguments each, never a shell or a command line from a setting.
export const TEST_COMMANDS = ['npm test', 'pnpm test', 'yarn test', 'bun test', 'make test', 'pytest', 'cargo test', 'go test'] as const
export type TestCommand = (typeof TEST_COMMANDS)[number]

export const SEED_SYSTEM =
  'You turn a coding request into a goal and a short plan. Reply with JSON only, no prose: {"goal": string (at most 60 characters), "steps": string[] (2 to 7 short imperative steps, at most 50 characters each)}.'

export const OBSERVER_SYSTEM = `You keep a task list for a coding session by watching the agent's tool calls. Reply with JSON only, a diff:
{"add":[{"id":"temp id","title":"...","parentId":"existing id, temp id or root","phase":"...","status":"..."}],
 "update":[{"id":"...","status":"...","phase":"...","progress":0.5,"note":"..."}],
 "complete":["id"],
 "merge":[{"inferredId":"...","declaredId":"..."}]}
Phases: ${PHASES.join(', ')}. Statuses: pending, running, waiting, blocked, done. progress is 0 to 1 overall.
Tasks may carry an agentId: those belong to a subagent. A tool call prefixed [agent <id>] is that subagent's: it advances only that subagent's tasks (the one with that agentId and parentId null, and its steps); add a subagent's new steps with parentId set to its task's id. Unprefixed calls are the main agent's.
Declared tasks are the agent's own: never add a task a declared one already covers; merge an inferred task into the declared task that describes the same work.
Decisions are tracked by a separate pass: leave them out.
Titles at most 50 characters. Use empty arrays when nothing changed.`

export const DECISION_SYSTEM = `You keep the list of decisions a coding agent makes while it works, for a sidebar the person watches.
You get the decisions known so far and what happened since: what the agent said, what it asked, what the person answered, notable tool calls.
Reply with JSON only: {"decisions":[...]} holding only new decisions and changes to known ones (match a known one by its id). Fields:
"decisions":[{"id":"existing id when updating","title":"one or two words","chosen":"what it picked","rejected":[{"option":"...","reason":"two or three words"}],"rationale":"why, at most 12 words","confidence":0.75,"reversible":true,"evidence":["file:line","3 test runs"],"files":1,"outsidePlan":"set only when it touches work outside the plan, e.g. 1 file outside plan"}]
A decision is a point where the agent picked one approach over others (an approach, a scope change, how to test, what to skip), or settled something the person asked.
When the agent asks the person to choose, add one with "pending":true, "options":[...], "lean":"the option it prefers", "blocks":"what waits on it".
When the person answers or the agent goes ahead, update that pending one: "pending":false and "chosen".
When the agent changes course on a known decision, update its "chosen", "rejected" and "rationale".
Only real choices; reply {"decisions":[]} when nothing changed.`

export const SUMMARY_SYSTEM =
  'You write a hand-off note for a coding session. Reply with JSON only: {"done": string[], "remaining": string[], "questions": string[], "text": "two or three plain sentences"}. Each list item at most 80 characters.'

export function taskBrief(list: readonly Task[]) {
  return JSON.stringify(
    list
      .filter(t => t.status !== 'done' || Date.now() - t.updatedAt < 10 * 60_000)
      .slice(-40)
      .map(t => ({ id: t.id, title: t.title, source: t.source, status: t.status, phase: t.phase, parentId: t.parentId, agentId: t.agentId })),
  )
}

export function decisionBrief(list: readonly { id: string; title: string; chosen: string; isPending: boolean; options?: string[]; lean?: string }[]) {
  return JSON.stringify(list.slice(-12).map(d => ({ id: d.id, title: d.title, chosen: d.chosen, pending: d.isPending, options: d.options, lean: d.lean })))
}

export function mapStatus(s: string | undefined): TaskStatus | undefined {
  if (s === 'in_progress') return 'running'
  if (s === 'completed') return 'done'
  if (s === 'pending') return 'pending'

  return undefined
}

/** Where a loop's declared tasks hang: a subagent's under its own task, the main loop's under the root. */
export function declaredParent(list: readonly Task[], rootId: string | null, agentId: string | undefined) {
  return agentId === undefined ? rootId : (agentTaskOf(list, agentId)?.id ?? rootId)
}

export function handoffText(s: Summary) {
  const part = (title: string, items: string[]) => (items.length === 0 ? '' : `\n${title}:\n${items.map(i => `- ${i}`).join('\n')}`)

  return `Hand-off from the last session: ${s.text}${part('Done', s.done)}${part('Remaining', s.remaining)}${part('Open questions', s.questions)}`
}

/** Tokens a response burned: what was sent uncached or written, and what came back. */
export function burned(u: ModelUsage) {
  return u.input_tokens + u.cache_creation_input_tokens + u.output_tokens
}

export function dayKey(ms: number) {
  return new Date(ms).toISOString().slice(0, 10)
}
