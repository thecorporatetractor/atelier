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
| Planning nudge | off | Ask Claude to keep its own task list: `nudge-once`, `always` or `describe` |
| Attention sound | off | Play a sound when Claude waits on you (macOS) |
| Test command | `npm test` | What `t` runs |
| Start compact | off | Open in one-line mode |

## 💸 What the observer costs

The observer makes small Haiku calls through your own Claude Code session: a few per prompt, batched and debounced, never in the way of a hook. Its token count sits in the Agents section and the stats screen, so the overhead is never hidden. Switch it off in `/config` and the sidebar keeps everything that does not need a model: usage, context, activity, files, agents.

Nothing leaves your machine except those calls, which go to the same API your session already uses. History is kept locally in the plugin's own store.

## 🖥 Where it draws

In the terminal it draws with text glyphs. In the desktop app's Code tab, VS Code and mobile it draws the same layout as an SVG, with real buttons beside it.

## 🛠 Working on it

```sh
git clone git@github.com:thecorporatetractor/atelier.git
claude --plugin-dir ./atelier      # run it from the folder; edits reload as you save
claude plugin validate ./atelier --strict
claude plugin test ./atelier
```

Conventions for people and agents working on the code are in [AGENTS.md](AGENTS.md).

> atelier is built on Claude Code's function-hooks plugin API, which is in early access and changes between releases. If something stops drawing after an update, `claude --debug` says why.
