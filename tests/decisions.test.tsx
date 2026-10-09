import { expect, mock, test } from 'claude-code/testing'

const PROPS = {
  title: 'Studiolo',
  isFocused: false,
  bodyColumns: 52,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

test('the decisions pass runs once things go quiet and fills the Decisions section', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  const asked: string[] = []
  on('model.classify', () => ({ value: 'multi-step-work' }))
  on('model.complete', (_, e) => {
    const system = typeof e.system === 'string' ? e.system : ''
    if (!system.includes('decisions a coding agent makes')) return { value: { isAnswered: true as const, text: '{"goal":"Fix resize","steps":[]}', usage: NO_USAGE } }
    asked.push(String(e.prompt))

    return {
      value: {
        isAnswered: true as const,
        text: '{"decisions":[{"title":"Approach","chosen":"patch the resize handler in place","rejected":[{"option":"rewrite layout engine","reason":"too broad"}],"rationale":"resize fires before layout","confidence":0.75,"reversible":true}]}',
        usage: NO_USAGE,
      },
    }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.prompt.submit({ text: 'Fix the flicker when the sidebar resizes, keep the change small please', wait: false, origin: { kind: 'composer' } })
  // Nothing yet: the pass waits for 5s of quiet.
  expect(asked).toHaveLength(0)
  await clock.advance(5_500)
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('Person said: Fix the flicker')
  const ui = await $.ui.mount({ plugin: 'studiolo', surface: 'terminal', component: 'Pane', requestId: 'studiolo', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /Approach/ })).toBeDefined()
  await ui.unmount()
})
