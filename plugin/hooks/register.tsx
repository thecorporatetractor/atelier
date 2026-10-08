import type { EngineInterface, Register } from 'claude-code'

const PANE = 'atelier'
const COUNT = { plugin: 'atelier', key: 'count' } as const
type Held = { count: number }
type HeldCount = Held['count']

// V1: plain helper, $ only
async function v1($: EngineInterface) {
  $.ui.toast('v1')
}

// V2: helper with extra plain parameters
async function v2($: EngineInterface, text: string, n: number) {
  $.ui.toast(text + String(n))
}

// V3: helper taking a callback parameter it calls
async function v3($: EngineInterface, change: (value: number) => number) {
  $.ui.toast(String(change(1)))
}

// V4: helper reading state through a const reference
async function v4($: EngineInterface) {
  const held = await $.state.get(COUNT)
  $.ui.toast(String(held.value ?? 0))
}

// V5: helper writing state with ifVersion from a read
async function v5($: EngineInterface) {
  const held = await $.state.get(COUNT)
  const written = await $.state.set(COUNT, (held.value ?? 0) + 1, { ifVersion: held.version })
  if (written.isSet) $.ui.toast('v5')
}

// V6: the exact shape of atelier's updateX helpers
async function v6($: EngineInterface, change: (value: HeldCount) => HeldCount): Promise<void> {
  for (;;) {
    const held = await $.state.get(COUNT)
    const value = change(held.value ?? 0)
    const written = await $.state.set(COUNT, value, { ifVersion: held.version })
    if (written.isSet) return
  }
}

// V7: a helper passing $ on to another helper
async function v7($: EngineInterface) {
  await v1($)
}

// V8: background work through a wrapper
function quietly(work: Promise<unknown>) {
  work.catch(() => {})
}

// V9: helper with a for(;;) loop and no callback
async function v9($: EngineInterface) {
  for (;;) {
    const held = await $.state.get(COUNT)
    const written = await $.state.set(COUNT, held.value ?? 0, { ifVersion: held.version })
    if (written.isSet) return
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.ui.open({ id: PANE, title: 'Atelier' })
    await v1($)
    await v2($, 'a', 1)
    await v3($, value => value + 1)
    await v4($)
    await v5($)
    await v6($, value => value + 1)
    await v7($)
    void quietly(v1($))
    await v9($)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>Hello</Text>
  })
}
