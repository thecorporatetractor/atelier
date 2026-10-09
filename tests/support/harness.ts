// Test support: stands in for the engine beneath the mod, so a test can read
// exactly what the mod recorded (state and store), whatever the drawing does.
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const SESSION_ID = 'session-1'
export const ROOT = '/work/project'
export const T0 = 1_000_000

/** A model response's usage, the shape steps and turns report. */
export const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, model: 'claude-test' }
export const BURNED = 1000 + 200

export type Harness = {
  clock: ReturnType<typeof mock.clock>
  /** What the mod wrote under `studiolo.<key>`, as plain data. */
  state: <T = unknown>(key: string) => T | undefined
  /** What the mod wrote to its store. */
  store: <T = unknown>(key: string) => T | undefined
  /** Ids the engine's agent list answers, with their status. */
  listed: { id: string; type: string; description: string; status: string }[]
}

/**
 * State and store held in memory, the engine's session facts answered, and
 * every drawing call accepted: what a test needs to drive the hooks.
 */
export function harness(on: On, init: { store?: Record<string, unknown>; now?: number } = {}): Harness {
  const clock = mock.clock(on, { now: init.now ?? T0 })
  const state = new Map<string, { value: unknown; version: number }>()
  const store = new Map<string, unknown>(Object.entries(init.store ?? {}))
  const listed: Harness['listed'] = []
  const key = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}.${e.key}${e.id === undefined ? '' : `#${e.id}`}`
  const loose = on as unknown as (event: string, hook: (...args: never[]) => unknown) => unknown
  const copy = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

  loose('state.get', (_$: unknown, e: { plugin: string; key: string; id?: string }) => {
    const held = state.get(key(e))

    return { value: { value: copy(held?.value), version: held?.version ?? 0 } }
  })
  loose('state.set', (_$: unknown, e: { plugin: string; key: string; id?: string; value: unknown; ifVersion?: number }) => {
    const held = state.get(key(e))
    const version = held?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
    state.set(key(e), { value: copy(e.value), version: version + 1 })

    return { value: { isSet: true, version: version + 1 } }
  })
  loose('store.get', (_$: unknown, e: { key: string }) => ({ value: copy(store.get(e.key)) }))
  loose('store.set', (_$: unknown, e: { key: string; value: unknown }) => {
    store.set(e.key, copy(e.value))

    return { value: undefined }
  })
  loose('store.delete', (_$: unknown, e: { key: string }) => {
    store.delete(e.key)

    return { value: undefined }
  })
  loose('store.keys', () => ({ value: [...store.keys()] }))

  const quiet = ['ui.toast', 'ui.log', 'ui.invalidate', 'ui.status', 'ui.close']
  for (const event of quiet) loose(event, () => ({ value: undefined }))
  loose('ui.open', () => ({ value: { isPlaced: true } }))
  loose('command.register', () => ({ value: undefined }))
  loose('session.id', () => ({ value: SESSION_ID }))
  loose('session.root', () => ({ value: ROOT }))
  loose('session.cwd', () => ({ value: ROOT }))
  loose('session.model', () => ({ value: 'claude-opus-test' }))
  loose('session.usage', () => ({ value: { startedAt: T0 - 60_000, context: { tokens: 40_000, window: 200_000, percent: 20 }, rateLimits: [], cost: { usd: 1 } } }))
  loose('agent.list', () => ({ value: listed.map(a => ({ ...a })) }))
  loose('turn.complete', (_$: unknown, e: { answer: string }) => ({ text: e.answer }))
  loose('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  loose('session.end', () => ({}))
  loose('session.measure', (_$: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  loose('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))

  return {
    clock,
    state: <T>(k: string) => copy(state.get(`studiolo.${k}`)?.value) as T | undefined,
    store: <T>(k: string) => copy(store.get(k)) as T | undefined,
    listed,
  }
}

/** A streamed model response beneath the mod: `chars` of text, then its usage. */
export function streamStep(on: On, chars = 480) {
  const loose = on as unknown as (event: string, hook: (...args: never[]) => unknown) => unknown
  loose('turn.step', async function* (_$: unknown, e: { turnId: string; index: number; model: string }) {
    // The response's usage names the model that answered the step.
    const usage = { ...USAGE, model: e.model }
    yield { kind: 'text', index: 0, text: 'x'.repeat(chars) }
    yield { kind: 'stop', stopReason: 'end_turn', usage }

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
}

type Loose = (event: string, hook: (...args: never[]) => unknown) => unknown
type ToolAnswer = { result: unknown; text?: string; isError?: true }

/**
 * Tools beneath the mod, as the engine runs them: `tool.call` answers with
 * `answer`, and `end($)` then raises PostToolUse (or PostToolUseFailure for
 * an error) for every call made since, which is where the mod reads results.
 */
export function tools(on: On, answer: (e: Record<string, unknown>) => ToolAnswer = () => ({ result: 'ok', text: 'ok' })) {
  const loose = on as unknown as Loose
  const open: { id: string; tool: string; input: Record<string, unknown>; answer: ToolAnswer }[] = []
  loose('tool.call', (_$: unknown, e: Record<string, unknown>) => {
    const a = answer(e)
    open.push({ id: String(e.tool_use_id), tool: String(e.tool), input: e, answer: a })

    return a
  })
  for (const event of ['classic.PostToolUse', 'classic.PostToolUseFailure', 'classic.PostCompact']) loose(event, () => ({}))

  return {
    /** Raises each open call's end, in order, as the engine does after running it. */
    end: async ($: unknown) => {
      const classic = ($ as { classic: Record<string, (e: unknown) => Promise<unknown>> }).classic
      for (const c of open.splice(0)) {
        const { tool: _t, tool_use_id: _id, ...toolInput } = c.input
        if (c.answer.isError === true) {
          await classic.PostToolUseFailure!({ tool_name: c.tool, tool_input: toolInput, tool_use_id: c.id, error: String(c.answer.text ?? c.answer.result) })
        } else {
          await classic.PostToolUse!({ tool_name: c.tool, tool_input: toolInput, tool_response: c.answer.result, tool_use_id: c.id })
        }
      }
    },
  }
}
