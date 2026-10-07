import type { Register } from 'claude-code'

const PANE = 'atelier'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.ui.open({ id: PANE, title: 'Atelier' })

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>Hello</Text>
  })
}
