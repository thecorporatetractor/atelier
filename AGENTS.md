# Working on atelier

atelier is a Claude Code mod: a plugin of function hooks, today a docked sidebar, growing into a workspace. These are the conventions for anyone changing it, people and coding agents alike.

## Layout

Only `plugin/` ships: it is what the marketplace file points at and what the directory reviews. Everything else is for working on it.

| Path | What lives there |
| --- | --- |
| `plugin/hooks/register.tsx` | Every hook, the timers, all state writes, the `ui.render` hook |
| `plugin/hooks/view.tsx` | The terminal drawing: `drawSidebar(els, data, actions)` |
| `plugin/hooks/svg.ts` | The same layout as one Svg, for desktop, VS Code and mobile |
| `plugin/hooks/stats.ts` | The stats screen's rows |
| `plugin/hooks/lib/model.ts` | Pure logic: tasks, progress, decisions, stats, agents |
| `plugin/hooks/lib/support.ts` | Options, the observer's prompts, small pure helpers |
| `plugin/hooks/lib/*.ts` | Pure helpers for drawing: runs, wrapping, raster cells |
| `plugin/types/index.d.ts` | The `$.state` contract: every value the sidebar keeps |
| `plugin/README.md` | The plugin's README, copied to the root as the repository's front page |
| `tests/` | `claude plugin test` suites; imports are written as if the tests sat in `plugin/` |
| `scripts/check` | Stages `plugin/` and `tests/` together, then type-checks, validates and tests |
| `.claude-plugin/marketplace.json` | Makes the repository installable; its one entry's source is `./plugin` |

## Rules the engine enforces

- In `register.tsx`, `$` is passed only to functions declared at the top level of that file, and is always spelled `$.noun.method(...)` at the call site. Closures that capture `$` (button handlers, timers) are fine.
- `view.tsx`, `svg.ts`, `stats.ts` and everything in `hooks/lib/` never touch `$`. They take plain data and return a tree or a value, which keeps them testable.
- Every `$.state` key is a literal and is declared in `types/index.d.ts`.
- JSX compiles against the global `h`. Elements come from `$.ui.resolve(e)`; a Button never sits inside a Text (use a row Box).
- Hooks never wait on a model call. Model work runs in the background, batched and debounced, and its tokens are counted in the observer figures.
- No hook changes or answers what Claude reads (see Staying publishable).

## Keeping it cheap

Every state write redraws the whole sidebar, so writes are the budget.

- Write only when the value changed. `isSame` in `model.ts` is there for that.
- Values that change on every tool call (feed, current call, each agent's tool) are kept in memory and published together every 300 ms.
- Draw runs of the same colour as one Text, never one element per cell. `tests/perf.test.ts` holds a busy sidebar under 1000 elements and 75 KB.
- Timers are kept in module variables and cancelled before they are started again.

## Staying publishable

atelier is published in the Claude plugin directory, whose review reads the code. These rules come from its findings; a change that breaks one gets the plugin held. Treat them as hard constraints, not style.

### Hooks

- Register each hook as its own statement: `on('event', hook)` or `on('event', matcher, hook)`. Nothing chained onto it: no `.catch(...)`, no stored registration.
- Write the hook inline in `register.tsx`, as `async ($, e, next) => { ... }` (or `async function* ($, e, next)` for `turn.step`). Name the parameters exactly `$`, `e`, `next`, and use those names for nothing else inside.
- End every hook with `return next(e)`, passing its own event unchanged. A streaming hook passes the stream through whole: `const result = yield* next(e)`, then `return result`. Work may happen before that line, never in place of it.
- Never rewrite an event (`next({ ...e, ... })`), never return a changed result (`{ ...ran, context }`), never answer for the engine (`{ deny }`, `{ ask }`, `{ result }`).
- To see how a tool call ended, hook `classic.PostToolUse` / `classic.PostToolUseFailure`. Never `await next(e)` in `tool.call` to read its result.
- The two hooks that answer: `ui.render` returns the sidebar's tree, and `command.run` answers atelier's own `/atelier` command (matcher `{ command: 'atelier' }`) with a literal `{ text }`.
- Don't hook `tool.check`, `tool.describe`, `prompt.compose`, `config.set`, `agent.register` or `fs.write`. Don't register agents, change the permission mode or touch Remote Control.

### `$` and calls

- Spell every call `$.noun.method(...)`. Pass `$` only as one whole argument: to a function declared at the top level of `register.tsx`, or to `read` / `update` from `claude-code`.
- Programs: `$.process.run` with the program's name and fixed arguments written in the call, e.g. `$.process.run(['git', 'add', '-A'], init)`. Never a shell, never an argument built from a setting, the model or a file. A choice the person makes selects one of a fixed set of such calls (see `runTestCommand`).
- The only way out of the machine is `$.model.complete` / `$.model.classify`. No `$.http`, `$.mcp` or `$.session.send` unless the README says exactly what goes where.
- `$.prompt.submit` and `$.prompt.fill` only from a button the person pressed, with text the README shows.
- Read nothing from the machine itself: no environment, no files, no settings. A value the person must give is a `userConfig` option, `sensitive: true` if it's a secret.

### Files

- Nothing but the plugin goes in `plugin/`: no tests, scripts, fixtures or notes. Tests deliberately break the hook rules (they stand in for the engine), so they must never ship.
- Ship readable source only: TypeScript as written, no bundles, no minified or generated code. Keep every file under 64 KB; move pure code from `register.tsx` into `hooks/lib/` before it grows past that.
- No binary files besides `.claude-plugin/icon.png`: no sounds, fonts or archives. An image must be a real PNG or JPEG with the matching extension.
- `plugin.json` keeps `license` (MIT) and `types`. The directory warns that Claude Code ignores `types`; it stays because `claude plugin validate` checks the state contract through it.

### The README goes with the code

The README's "What atelier sends, runs and changes" section is part of the contract. In the same commit as the code, update it for:

- anything sent out, and exactly what text;
- any program or Claude Code command run, and when;
- anything put in a prompt, and the exact text;
- any hook added, and what it notes or decides.

### Before pushing

Run `./scripts/check`, then re-run the directory's validation on the pushed commit. Fix what it reports here, and add any new rule it teaches to this section.

## How work is split

- **Logic**: hooks, observer prompts, data, `model.ts`, the state contract.
- **Drawing**: `view.tsx`, `svg.ts`, `stats.ts`, the drawing helpers in `hooks/lib/`.

Keep a change on one side of that line where you can, and agree the data contract (a type in `types/index.d.ts` or an export from `model.ts`) before the other side codes against it.

## Before you commit

From the repository root:

```sh
./scripts/check
```

It type-checks, validates (`--strict`, the plugin and the marketplace) and runs every test; all must pass. New behaviour comes with a test: pure logic in `tests/*.test.ts`, drawing by mounting the Pane with `$.ui.mount` on each surface it supports. Leave no probe or debug tests behind. After editing `plugin/README.md`, copy it to `README.md` (the check fails while they differ).

One change per commit, with a message that says what changed and why, so any change can be reverted on its own.

## Style

Comments explain why, in plain sentences. Names say what a thing is: `isRunning`, `agentTaskOf`, `pushFeed`. Match the code around you before inventing a new pattern.
