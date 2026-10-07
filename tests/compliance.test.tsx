// What the directory's review asks of the mod's behaviour: programs started
// by name with fixed arguments, and the spawn hook passing the event on.
import { describe, expect, test } from 'claude-code/testing'

import type { AgentNode, Task } from '../types'
import { harness, ROOT } from './support/harness'

const PROPS = {
  title: 'Atelier',
  isFocused: false,
  bodyColumns: 52,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

const SPAWN = {
  tool_use_id: 'tu1',
  prompt: 'look around',
  description: 'Map the code',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-test',
  background: true,
  fork: false,
}

const RUNNERS: [string, string[]][] = [
  ['npm test', ['npm', 'test']],
  ['pnpm test', ['pnpm', 'test']],
  ['yarn test', ['yarn', 'test']],
  ['bun test', ['bun', 'test']],
  ['make test', ['make', 'test']],
  ['pytest', ['pytest']],
  ['cargo test', ['cargo', 'test']],
  ['go test', ['go', 'test', './...']],
]

describe('compliance', () => {
  for (const [choice, argv] of RUNNERS) {
    test(`the test button starts ${choice} by name, never through a shell`, { options: { observer: false, testCommand: choice } }, async ($, on) => {
      const h = harness(on)
      const ran: string[][] = []
      const loose = on as unknown as (event: string, hook: (...args: never[]) => unknown) => unknown
      loose('process.run', (_$: unknown, e: { argv: readonly string[]; init?: { cwd?: string } }) => {
        ran.push([...e.argv])

        return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      })
      await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'atelier', surface: 'terminal', component: 'Pane', requestId: 'atelier', props: PROPS })
      await ui.press({ key: 'tests' })
      await h.clock.advance(10)
      expect(ran).toEqual([argv])
      await ui.unmount()
    })
  }

  test('a setting outside the list falls back to npm test', { options: { observer: false, testCommand: 'rm -rf /' } }, async ($, on) => {
    const h = harness(on)
    const ran: string[][] = []
    const loose = on as unknown as (event: string, hook: (...args: never[]) => unknown) => unknown
    loose('process.run', (_$: unknown, e: { argv: readonly string[] }) => {
      ran.push([...e.argv])

      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'atelier', surface: 'terminal', component: 'Pane', requestId: 'atelier', props: PROPS })
    await ui.press({ key: 'tests' })
    await h.clock.advance(10)
    expect(ran).toEqual([['npm', 'test']])
    await ui.unmount()
  })

  test('agent.spawn passes the event on unchanged; the sync then picks the agent up with its plan', { options: { observer: false } }, async ($, on) => {
    const h = harness(on)
    let seen: unknown
    on('agent.spawn', (_, e) => {
      seen = e

      return { model: 'claude-test', agentId: 'a1' }
    })
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    const answer = await $.agent.spawn(SPAWN)
    expect(answer.agentId).toBe('a1')
    expect((seen as { prompt: string; description: string }).prompt).toBe('look around')
    expect((seen as { description: string }).description).toBe('Map the code')
    // The engine lists the new agent; the sync right after the spawn finds it.
    h.listed.push({ id: 'a1', type: 'Explore', description: 'Map the code', status: 'running' })
    await h.clock.advance(400)
    const node = h.state<AgentNode[]>('agents')?.find(a => a.id === 'a1')
    expect(node?.status).toBe('running')
    expect(node?.model).toBe('claude-test')
    expect(h.state<Task[]>('tasks')?.find(t => t.agentId === 'a1')?.title).toBe('Map the code')
  })
})
