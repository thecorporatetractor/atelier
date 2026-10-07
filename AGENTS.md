# Working on atelier

atelier is a Claude Code mod: a plugin of function hooks, today a docked sidebar, growing into a workspace. These are the conventions for anyone changing it, people and coding agents alike.

## Layout

| Path | What lives there |
| --- | --- |
| `hooks/register.tsx` | Every hook, the timers, all state writes, the `ui.render` hook |
| `hooks/view.tsx` | The terminal drawing: `drawSidebar(els, data, actions)` |
| `hooks/svg.ts` | The same layout as one Svg, for desktop, VS Code and mobile |
| `hooks/stats.ts` | The stats screen's rows |
| `hooks/lib/model.ts` | Pure logic: tasks, progress, decisions, stats, agents |
| `hooks/lib/*.ts` | Pure helpers for drawing: runs, wrapping, raster cells |
| `types/index.d.ts` | The `$.state` contract: every value the sidebar keeps |
| `tests/` | `claude plugin test` suites |

## Rules the engine enforces

- In `register.tsx`, `$` is passed only to functions declared at the top level of that file, and is always spelled `$.noun.method(...)` at the call site. Closures that capture `$` (button handlers, timers) are fine.
- `view.tsx`, `svg.ts`, `stats.ts` and everything in `hooks/lib/` never touch `$`. They take plain data and return a tree or a value, which keeps them testable.
- Every `$.state` key is a literal and is declared in `types/index.d.ts`.
- JSX compiles against the global `h`. Elements come from `$.ui.resolve(e)`; a Button never sits inside a Text (use a row Box).
- Hooks never wait on a model call. Model work runs in the background, batched and debounced, and its tokens are counted in the observer figures.
- Anything that changes what Claude reads is off by default and switched on in `userConfig`.

## Keeping it cheap

Every state write redraws the whole sidebar, so writes are the budget.

- Write only when the value changed. `isSame` in `model.ts` is there for that.
- Values that change on every tool call (feed, current call, each agent's tool) are kept in memory and published together every 300 ms.
- Draw runs of the same colour as one Text, never one element per cell. `tests/perf.test.ts` holds a busy sidebar under 1000 elements and 75 KB.
- Timers are kept in module variables and cancelled before they are started again.

## Staying publishable

atelier is published in the Claude plugin directory, whose review checks the code. Keep to these:

- A hook that observes passes the event on unchanged with `return next(e)`. Hooks on `agent.spawn`, `agent.register`, `command.run` (other than atelier's own command), `config.set`, `fs.write` and permission checks never change or answer the event.
- Programs run by name with fixed arguments written in the call (`$.process.run(['git', 'add', '-A'])`), never through a shell and never from a string a setting holds. A choice the person makes picks one of a fixed set of calls.
- Anything new the mod sends, runs, submits into a prompt, or changes in what Claude reads goes in the README's "What atelier sends, runs and changes" section in the same change.
- No secrets read from the machine: a value the mod needs from the person is a `userConfig` option (`sensitive: true` for anything secret).
- The `types` field in `plugin.json` stays: `claude plugin validate` checks the state contract through it, though Claude Code ignores it at load time.

## How work is split

- **Logic**: hooks, observer prompts, data, `model.ts`, the state contract.
- **Drawing**: `view.tsx`, `svg.ts`, `stats.ts`, the drawing helpers in `hooks/lib/`.

Keep a change on one side of that line where you can, and agree the data contract (a type in `types/index.d.ts` or an export from `model.ts`) before the other side codes against it.

## Before you commit

From the repository root:

```sh
npx -y -p typescript@5 tsc -p .
claude plugin validate . --strict
claude plugin test .
```

All three must pass. New behaviour comes with a test: pure logic in `tests/*.test.ts`, drawing by mounting the Pane with `$.ui.mount` on each surface it supports. Leave no probe or debug tests behind.

One change per commit, with a message that says what changed and why, so any change can be reverted on its own.

## Style

Comments explain why, in plain sentences. Names say what a thing is: `isRunning`, `agentTaskOf`, `pushFeed`. Match the code around you before inventing a new pattern.
