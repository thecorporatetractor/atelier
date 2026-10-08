import type { EngineInterface, Register } from 'claude-code'

import { drawHello } from './lib/draw'

const PANE = 'atelier'
const COUNT = { plugin: 'atelier', key: 'count' } as const
let timer: { cancel: () => void } | undefined
let pending = 0

async function updateCount($: EngineInterface, change: (value: number) => number): Promise<void> {
  for (;;) {
    const held = await $.state.get(COUNT)
    const value = change(held.value ?? 0)
    const written = await $.state.set(COUNT, value, { ifVersion: held.version })
    if (written.isSet) return
  }
}

function quietly(work: Promise<unknown>) {
  work.catch(() => {})
}

// R1: a helper given a callback, passing it on inside another callback
async function setLike($: EngineInterface, fn: (value: number) => number) {
  const held = await $.state.get(COUNT)
  if (held.value === fn(0)) return
  await updateCount($, value => fn(value))
}

// R2: a helper reached from a timer callback that captures $
async function publishLike($: EngineInterface) {
  const value = pending
  await updateCount($, () => value)
}

// R3: a helper that starts a timer whose callback passes $ on
function schedule($: EngineInterface) {
  if (timer !== undefined) return
  timer = $.clock.after(100, () => {
    timer = undefined
    void quietly(publishLike($))
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.ui.open({ id: PANE, title: 'Atelier' })
    await setLike($, value => value + 1)
    schedule($)

    return next(e)
  })

  // R4: closures capturing $ handed to an imported drawing function
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)

    return drawHello(els, { bump: () => quietly(updateCount($, value => value + 1)) })
  })
}
