# 🎨 atelier

**A workspace for working with Claude Code.** An atelier is the studio where a master works with apprentices at one bench; this one puts you and your agents there. It starts as a live sidebar that shows what Claude is doing while it works: the plan and how far along it is, which agents are running, what the context window holds, what each turn costs, and the choices Claude made along the way.

```text
◉ Working  1m 12s                       main / opus-5-5
  Fix the flicker when the sidebar resizes
  ▃▃▃▃▃▃▃ ▃▃▃▃▃▃▃ ▃▃▃▃░░░ ░░░░░░░ ░░░░░░░        52%
  observer  step 3/5  editing resize.ts  ·  ~2m left
  └ Explore  map the layout code   ▃▃▃▃▃▃░░░░    61%

▍Context                          220k / 1.0M · 22%
▍▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆
▍▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆
▍■ system 42k  ■ tools 58k  ■ chat 94k  ■ files 26k
▍per turn ▁▂▂▃▅▂▇▃▂▁▂▃   avg 6.1k  ~34 turns left

▍Usage
▍tok/s 184  ·  avg 96                   peak 312  60s
▍         ▂▅▇▆▃          ▃▆█▇▅▂       ▁▄▆▇▆▃▁
▍▁▁▁▁▁▂▄▆██████▅▂▁▁▁▁▂▅██████▆▃▁▁▂▄▆███████▄▂▁▁▁▁▁▁
▍burn $1.42/h  ·  11.3k tok/min  ·  session $5.34
▍cache ● hot  4:12 until cold      ▪▪▪▪▪▪▪▪▪▪▪▪▪▪··

▍Decisions                4 · 1 open · drift low · d: detail
▍ 0:12 ◆ Approach  ● patch the resize handler    ▰▰▰▱ ↺
▍        ○ rewrite layout engine  ○ debounce caller
▍ 2:05 ◇ Pending  ▸ keep the 16ms throttle     ⏎ answer

▍Agents                                     1 running
▍● main  opus-5-5  ·  editing  ·  58s  ·  220k  peak 312
▍● Explore  haiku  ·  reading  ·  21s  ·  18k    peak 96

▍Activity
▍▸ Edit src/render/resize.ts  ·  +12 −4
▍  Grep "onResize"  ·  14 hits
▍  tests ✔  types –  0 untested edits

▍Files                           2 changed  ·  +12 −4
▍  M src/render/resize.ts                  +12 −4  ✔
▍Timeline                                          6
▍  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▍  0:00 start · 0:12 plan · 0:41 tests · 1:30 edit
────────────────────────────────────────────────────
■ ^C stop  ⇆ c: compact  ▶ t: tests  ◆ k: ckpt  ✎ n: note
```

## ✨ What it shows

**🎯 The task, with a real progress bar.** Every prompt you send becomes a task, and a small Haiku "observer" breaks it into steps and follows Claude's tool calls to move the bar. When Claude keeps its own task list, that list wins and the observer only fills the gaps. Subagents get their own row and bar right under the main task, so everything that is running sits in one place.

**🧠 Context at a glance.** A heatmap of the context window, one cell per percent, split into system, tools, chat and files, with how much each turn adds and roughly how many turns are left before compaction.

**⚡ Usage as it happens.** Tokens per second over the last minute, the burn rate, what the session has cost, and a countdown for the prompt cache so you know when a pause will make the next turn expensive. Each agent has its own small tok/s chart.

**🧩 Decisions.** When Claude picks one approach over another, the sidebar notes it: what was chosen, what was ruled out and why, how confident it looked, and whether it is easy to undo. Questions waiting on you show as pending, with Claude's preferred answer one key away.

**🗂 Activity, files, timeline.** The last few dozen tool calls in plain words, the files touched with their line counts, and a timeline of the session's phases.

**📊 Stats.** Press `s` for history across sessions and projects: spend by day, tokens by kind, cache hit rate, models, tools, subagent types, tests and lines changed, for today, this week, this month or all time.

## 📦 Install

At the prompt of a Claude Code terminal session:

```text
/plugin install atelier --marketplace thecorporatetractor/atelier
```

Answer `y` to add the marketplace, pick a scope, and the sidebar is live. It opens on its own when the terminal is wide enough (144 columns), or any time with `/atelier`. The fullscreen layout docks it to the right of the transcript.

## ⌨️ Keys and commands

| Key | Does |
| --- | --- |
| `d` | Decisions screen: every decision in full, with evidence and impact |
| `s` | Stats screen |
| `r` | Stats range: today, 7 days, 30 days, all time |
| `c` | Compact the conversation |
| `t` | Run your test command |
| `k` | Commit a checkpoint (asks first) |
| `n` | Send Claude a note mid-task |
| `x` | Ask Claude to revert a decision the observer flagged |

Keys work while the sidebar has focus (`ctrl+x tab` or a click).

| Command | Does |
| --- | --- |
| `/atelier` | Open the sidebar, sized to 35% of the terminal |
| `/atelier close` | Close it |
| `/atelier compact` | One-line mode |
| `/atelier stats` | Open the stats screen |
| `/atelier search <words>` | Search past sessions' summaries and tasks |

## ⚙️ Settings

All of them live in `/config` under atelier.

| Setting | Default | |
| --- | --- | --- |
| Observer | on | The Haiku observer that infers tasks, progress and decisions |
| Observer model | `haiku` | Any model alias or id |
| Observer batch size | 5 | Tool calls gathered before the observer looks |
| Observer debounce | 4000 ms | Quiet time before a partial batch is looked at |
| Test command | `npm test` | What `t` runs: one of `npm test`, `pnpm test`, `yarn test`, `bun test`, `make test`, `pytest`, `cargo test`, `go test` |
| Start compact | off | Open in one-line mode |

## 🔒 What atelier sends, runs and changes

atelier is meant to be watched, not trusted blindly, so here is everything it does outside its own sidebar.

### What it sends, and where

Only one thing leaves your machine: small model calls to **Haiku** (or the observer model you pick), made through Claude Code's own `$.model.complete` and `$.model.classify` calls. They go to the same API, account and provider your session already uses; atelier holds no key and opens no other connection. They run only while the **Observer** setting is on, which it is by default; switch it off in `/config` and atelier sends nothing at all.

| When | What is sent |
| --- | --- |
| You send a prompt | The prompt's text (up to 6,000 characters), to name the task and sketch its steps |
| A subagent starts | Its instructions (up to 6,000 characters), to plan its steps |
| Every few tool calls | One line per call (tool name, file path, the first 60 characters of a command or search), the task list's titles, and Claude's visible replies (up to 300 characters each) |
| After a pause in the conversation | What Claude said, what it asked you and what you answered, plus the decisions known so far, to keep the Decisions list current |
| When a turn ends | Claude's final answer (up to 2,500 characters) and the task list, to close finished steps; the task titles and changed file names, to write a short summary kept for search |

Every call's tokens are counted in the Agents section and on the stats screen.

### What it runs on your machine

| Program | When |
| --- | --- |
| Your test runner: `npm test`, `pnpm test`, `yarn test`, `bun test`, `make test`, `pytest`, `cargo test` or `go test ./...`, the one picked in `/config` | Only when you press `t`, in the project folder. It is started by name with those fixed arguments, never through a shell |
| `git add -A`, then `git commit -m "checkpoint (atelier)"` | Only when you press `k` and confirm the question, in the project folder |

It also runs one Claude Code command: `/diff`, when you press a file in the Files section.

### What it puts in Claude's prompts

atelier submits a prompt only when you press a button for it:

| You press | Claude receives |
| --- | --- |
| `n` and send a note | `Note from the person (via the sidebar): ` followed by your note |
| `x` on a flagged decision, then confirm | `Please revert the change from the decision "<title>: <choice>"` and the observer's flag, asking it to keep to the plan |
| `⏎ answer` on a pending decision | Nothing is sent: `<decision>: go with <option>.` is put in your prompt box for you to edit or send |

### What its hooks do

None of atelier's hooks change or answer what they see: each one notes the event and passes it on unchanged, so Claude reads exactly what it would without atelier.

| Hook | What atelier notes |
| --- | --- |
| `tool.call`, `PostToolUse`, `PostToolUseFailure` | Each tool call and how it ended: the activity feed, files and line counts, test results, repeated failures |
| `turn.step` | The tokens each model response used (the response itself streams through untouched) |
| `agent.spawn` | That a subagent started, to give it a row and a task |
| `turn.start`, `turn.complete`, `session.measure`, `PostCompact` | Turn timing, usage, cost, context and compactions, for the sidebar and the stats screen |
| `prompt.submit` | That you sent a prompt, to start a task for it |
| `PermissionRequest`, `Notification` | That Claude is waiting on you, to show a banner and a toast; they decide nothing |
| `session.start`, `session.end` | Setting up the sidebar, and saving the day's figures |
| `ui.render` | Drawing the sidebar |
| `command.run` | Answering atelier's own `/atelier` command, and no other |

Two buttons act on the session itself: `^C stop` cancels the running turn, and `c` compacts the conversation, the same as `/compact`.

### What it keeps

Everything atelier remembers stays on your machine, in its own plugin store: daily usage totals for the stats screen (the last 120 days), short summaries of past sessions for `/atelier search` (the last 40), your view choices, and the progress of your other open sessions for the "other sessions" line. It reads the session's id, project folder, model name and usage figures from Claude Code to fill those in.

## 🖥 Where it draws

In the terminal it draws with text glyphs. In the desktop app's Code tab, VS Code and mobile it draws the same layout as an SVG, with real buttons beside it.

## 🛠 Working on it

```sh
git clone git@github.com:thecorporatetractor/atelier.git
cd atelier
claude --plugin-dir ./plugin   # the plugin itself lives in plugin/
./scripts/check                # type-check, validate, and run the tests
```

The tests and tools live outside `plugin/`, so only the plugin ships. Conventions for people and agents working on the code are in [AGENTS.md](https://github.com/thecorporatetractor/atelier/blob/main/AGENTS.md).

> atelier is built on Claude Code's function-hooks plugin API, which is in early access and changes between releases. If something stops drawing after an update, `claude --debug` says why.
