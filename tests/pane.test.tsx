import { expect, mock, test } from 'claude-code/testing'

import { tools } from './support/harness'

const PROPS = {
  title: 'Atelier',
  isFocused: false,
  bodyColumns: 52,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, model: 'claude-test' }

const SPAWN = {
  tool_use_id: 'tu1',
  prompt: 'look',
  description: 'Look around',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-test',
  background: false,
  fork: false,
}

const KEYED: readonly (readonly [string, string])[] = [
  ['compact', 'c'],
  ['tests', 't'],
  ['ckpt', 'k'],
  ['note', 'n'],
  ['stats', 's'],
  ['d-toggle', 'd'],
]

test('the terminal draws the sections as text; the remote surfaces an Svg with native controls', { options: { observer: false } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.usage', () => ({ value: { startedAt: 900_000, context: { tokens: 50_000, window: 200_000, percent: 25 }, rateLimits: [] } }))
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 4000, isAborted: false, reason: 'answer', usage: USAGE })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'atelier', surface, component: 'Pane', requestId: 'atelier', props: PROPS })
    if (surface === 'terminal') {
      for (const name of [/^Context$/, /^Usage$/, /^Decisions$/, /^Agents$/, /^Activity$/, /^Files$/, /^Timeline$/]) {
        expect(await ui.find({ type: 'Text', text: name })).toBeDefined()
      }
      // The heatmap, the tok/s chart and the cache bar draw as text glyphs, not Raster cells.
      expect(await ui.find({ type: 'Raster' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^api$/ })).toBeUndefined()
      // No rate-limit rows in the main view.
      expect(await ui.find({ type: 'Text', text: /resets/ })).toBeUndefined()
      // Files, then Timeline, pinned right above the rule; the spare space sits between Activity and Files.
      const tree = JSON.stringify(await ui.drawn())
      const at = (needle: string) => tree.indexOf(needle)
      expect(at('"Activity"')).toBeGreaterThan(0)
      expect(at('"spacer"')).toBeGreaterThan(at('"Activity"'))
      expect(at('"Files"')).toBeGreaterThan(at('"spacer"'))
      expect(at('"Timeline"')).toBeGreaterThan(at('"Files"'))
      // The rule is a Text (keys of Texts are not kept): find it by its glyphs.
      const rule = at(`"${'─'.repeat(20)}`)
      expect(rule).toBeGreaterThan(at('"Timeline"'))
      expect(at('"toolbar"')).toBeGreaterThan(rule)
      // The tok/s chart is four rows of glyphs.
      for (const r of [0, 1, 2, 3]) expect(await ui.find({ type: 'Box', key: `chart-${r}` })).toBeDefined()
      expect(await ui.find({ type: 'Box', key: 'chart-4' })).toBeUndefined()
    } else {
      const svg = await ui.find({ type: 'Svg' })
      expect(svg).toBeDefined()
      const source = String(svg?.props.source)
      for (const name of ['Context', 'Usage', 'Decisions', 'Agents', 'Activity', 'Files', 'Timeline']) expect(source).toContain(name)
      expect(svg?.props.isInteractive).toBe(true)
      expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    }
    // The keyed controls are native Buttons on every surface.
    for (const [key, hotkey] of KEYED) {
      const b = await ui.find({ type: 'Button', key })
      expect(b).toBeDefined()
      expect(b?.props.hotkey).toBe(hotkey)
    }
    expect(await ui.find({ type: 'Button', text: /^stop$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('Activity keeps at least eight past items', { options: { observer: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const tool = tools(on)
  for (let i = 0; i < 12; i += 1) await $.tool.call({ tool: 'Bash', command: `echo step${i}` })
  await tool.end($)
  // The feed is published in batches, at most every second.
  await clock.advance(1100)
  const ui = await $.ui.mount({ plugin: 'atelier', surface: 'terminal', component: 'Pane', requestId: 'atelier', props: PROPS })
  const shown = await ui.findAll({ type: 'Text', text: /\$ echo step\d+/ })
  expect(shown.length).toBeGreaterThanOrEqual(8)
  await ui.unmount()
})

test('failing tool calls reach the feed and a spin loop warns', { options: { observer: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('ui.toast', () => ({ value: undefined }))
  const tool = tools(on, () => ({ isError: true as const, result: 'boom', text: 'boom' }))
  for (let i = 0; i < 3; i += 1) {
    await $.tool.call({ tool: 'Bash', command: 'npm run flaky' })
    await tool.end($)
  }
  await clock.advance(1100)
  const ui = await $.ui.mount({ plugin: 'atelier', surface: 'terminal', component: 'Pane', requestId: 'atelier', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /retried this 3 times/ })).toBeDefined()
  // Three identical calls fold into one Activity line with a count.
  expect(await ui.find({ type: 'Text', text: /\$ npm run flaky/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /×3/ })).toBeDefined()
  await ui.unmount()
})

test('d switches the whole sidebar to the decisions screen and back', { options: { observer: false } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'atelier', surface, component: 'Pane', requestId: 'atelier', props: PROPS })
    const headerShown = async (name: string) => {
      if (surface === 'terminal') return (await ui.find({ type: 'Text', text: new RegExp(`^${name}$`) })) !== undefined

      return String((await ui.find({ type: 'Svg' }))?.props.source).includes(`>${name}<`)
    }
    expect((await ui.find({ type: 'Button', key: 'd-toggle' }))?.text).toBe('detail')
    expect(await headerShown('Context')).toBe(true)
    await ui.press({ key: 'd-toggle' })
    expect((await ui.find({ type: 'Button', key: 'd-toggle' }))?.text).toBe('compact')
    expect(await headerShown('Context')).toBe(false)
    expect(await headerShown('Usage')).toBe(false)
    expect(await headerShown('Timeline')).toBe(false)
    expect(await headerShown('Decisions')).toBe(true)
    if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: /observer off/ })).toBeDefined()
    await ui.press({ key: 'd-toggle' })
    expect(await headerShown('Context')).toBe(true)
    await ui.unmount()
  }
})

test('s switches to the stats screen, which says it is collecting until figures come', { options: { observer: false } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const ui = await $.ui.mount({ plugin: 'atelier', surface: 'terminal', component: 'Pane', requestId: 'atelier', props: PROPS })
  await ui.press({ key: 'stats' })
  expect(await ui.find({ type: 'Text', text: /^Context$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Usage$/ })).toBeUndefined()
  const stats = await ui.find({ type: 'Text', text: /^Stats$/ })
  const spend = await ui.find({ type: 'Text', text: /^Spend$/ })
  expect(stats ?? spend).toBeDefined()
  if (stats !== undefined) expect(await ui.find({ type: 'Text', text: /collecting…/ })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'stats' }))?.text).toBe('back')
  // `d` leaves the stats screen for the decisions one; `s` again returns home.
  await ui.press({ key: 'd-toggle' })
  expect(await ui.find({ type: 'Text', text: /^Decisions$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Spend$/ })).toBeUndefined()
  await ui.press({ key: 'stats' })
  await ui.press({ key: 'stats' })
  expect(await ui.find({ type: 'Text', text: /^Context$/ })).toBeDefined()
  await ui.unmount()
})

test('an edit the engine did not diff still counts its lines', { options: { observer: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const tool = tools(on, e =>
    e.tool === 'Edit'
      ? {
          result: { filePath: e.file_path, oldString: e.old_string, newString: e.new_string, originalFile: null, structuredPatch: [], userModified: false, replaceAll: false },
          text: 'ok',
        }
      : { result: 'ok', text: 'ok' },
  )
  await $.tool.call({ tool: 'Edit', file_path: '/p/src/a.ts', old_string: 'keep\nold', new_string: 'keep\nnew\nmore' })
  await tool.end($)
  await clock.advance(1100)
  const ui = await $.ui.mount({ plugin: 'atelier', surface: 'terminal', component: 'Pane', requestId: 'atelier', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /\+2 −1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Edit \/p\/src\/a\.ts/ })).toBeDefined()
  await ui.unmount()
})

test('the heatmap draws from the plain figures when no breakdown comes', { options: { observer: false } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('session.usage', () => ({ value: { startedAt: 900_000, context: { tokens: 50_000, window: 200_000, percent: 25 }, rateLimits: [] } }))
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 4000, isAborted: false, reason: 'answer', usage: USAGE })
  const ui = await $.ui.mount({ plugin: 'atelier', surface: 'terminal', component: 'Pane', requestId: 'atelier', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /heatmap after the first turn/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /chat 50k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /est\./ })).toBeDefined()
  // Without a stream sample, the turn's own usage draws the rate and the cache.
  expect(await ui.find({ type: 'Text', text: /^50$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /● hot/ })).toBeDefined()
  await ui.unmount()
})

test("a subagent's steps count live, and its turn's end adds nothing twice", { options: { observer: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ model: 'claude-test', agentId: 'a1' }))
  // The engine lists the spawned agent; atelier's sync reads it after the spawn.
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'Explore', description: 'Look around', status: 'running' as const }] }))
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.step', async function* (_, e) {
    yield { kind: 'text' as const, index: 0, text: 'x'.repeat(480) }
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: USAGE }

    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn' as const, usage: USAGE }
  })
  await $.agent.spawn(SPAWN)
  await clock.advance(1100)
  const step = $.turn.step({ turnId: 'a1-t', index: 0, model: 'claude-test', messageCount: 1, agentId: 'a1' })
  for await (const _c of step) {
    // drained
  }
  await step.result
  await clock.advance(3000)
  const ui = await $.ui.mount({ plugin: 'atelier', surface: 'terminal', component: 'Pane', requestId: 'atelier', props: PROPS })
  // 1000 + 200 burned tokens on the agent's row, and a tok/s sample from its step.
  expect(await ui.find({ type: 'Text', text: /Explore.*1\.2k/ })).toBeDefined()
  // Its own chart row sits under it, scaled to its own peak.
  expect(await ui.find({ type: 'Box', key: 'agent-chart-a1' })).toBeDefined()
  // 200 output tokens over the 3s tick: 67 tok/s.
  expect(await ui.find({ type: 'Text', text: /peak 67 / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^67$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /● hot/ })).toBeDefined()
  await $.turn.complete({ turnId: 'a1-t', agentId: 'a1', answer: 'hi', durationMs: 1200, isAborted: false, reason: 'answer', usage: USAGE })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /Explore.*1\.2k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2\.4k/ })).toBeUndefined()
  await ui.unmount()
})

test('the status block says Working while only a subagent runs', { options: { observer: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ model: 'claude-test', agentId: 'a1' }))
  // The engine lists the spawned agent; atelier's sync reads it after the spawn.
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'Explore', description: 'Look around', status: 'running' as const }] }))
  const before = await $.ui.mount({ plugin: 'atelier', surface: 'terminal', component: 'Pane', requestId: 'atelier', props: PROPS })
  expect(await before.find({ type: 'Text', text: /^Idle$/ })).toBeDefined()
  await before.unmount()
  await $.agent.spawn(SPAWN)
  await clock.advance(1100)
  const ui = await $.ui.mount({ plugin: 'atelier', surface: 'terminal', component: 'Pane', requestId: 'atelier', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /^Working$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 agent/ })).toBeDefined()
  await ui.unmount()
})
