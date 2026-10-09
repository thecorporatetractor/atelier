// The sidebar as one SVG document for the remote surfaces (desktop, VS Code,
// mobile), after the design's 4a (default) and 4b (decisions) screens. Pure,
// `$`-free; every string from the model or the person goes through
// `escapeXml` before it reaches the markup. No script, no external fetch.
import type { Decision, FeedItem } from '../types'
import { type AgentTaskRow, basename, cacheState, clock, elapsed, fit, heatCells, pips, planSegments, relPath, sparkline, tokens, turnsLeft } from './lib/model'
import { wrapLines } from './lib/wrap'
import { RANGE_LABEL, type Run, statsRows } from './stats'
import { C, CHART_ROWS, HEAT, type SidebarData } from './view'

export const SVG_COLS = 52
const CH = 7.8
const LH = 20
const PAD = 12
const WIDTH = Math.round(SVG_COLS * CH + 2 * PAD)
const FONT = "'JetBrains Mono',ui-monospace,Menlo,monospace"

export function escapeXml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const PHASE_WORD: Record<string, string> = { exploring: 'reading', planning: 'planning', editing: 'editing', verifying: 'testing', done: 'done' }
const PHASE_LABEL: Record<string, string> = { planning: 'plan', editing: 'edit', verifying: 'tests', done: 'done' }

function mmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))

  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

function usd(n: number | undefined) {
  return n === undefined ? '$–' : `$${n.toFixed(2)}`
}

function rateColor(v: number) {
  return v > 250 ? C.rateHigh : v >= 100 ? C.accent : C.rateLow
}

function len(runs: readonly Run[]) {
  return runs.reduce((n, r) => n + [...r.t].length, 0)
}

/** Cuts the runs to `max` columns, the cut one ending in an ellipsis. */
function cut(runs: readonly Run[], max: number): Run[] {
  const out: Run[] = []
  let used = 0
  for (const r of runs) {
    const n = [...r.t].length
    if (used + n <= max) {
      out.push(r)
      used += n
      continue
    }
    const room = max - used
    if (room > 0) out.push({ ...r, t: fit(r.t, room) })

    return out
  }

  return out
}

class Doc {
  parts: string[] = []
  y = PAD
  x = (col: number) => PAD + col * CH

  tspan(r: Run) {
    const attrs = [`fill="${r.c ?? C.fg}"`, r.b === true ? 'font-weight="700"' : '', r.i === true ? 'font-style="italic"' : ''].filter(Boolean).join(' ')

    return `<tspan ${attrs}>${escapeXml(r.t)}</tspan>`
  }

  /** One text row: the runs from the left, `right` flush right, both cut to fit. */
  text(runs: readonly Run[], right: readonly Run[] = [], gutter?: string) {
    const all: Run[] = gutter === undefined ? [...runs] : [{ t: '▍', c: gutter }, ...runs]
    const r = cut(right, Math.floor(SVG_COLS / 2))
    const left = cut(all, SVG_COLS - len(r) - (r.length > 0 ? 1 : 0))
    const base = this.y + LH - 5
    this.parts.push(`<text x="${this.x(0)}" y="${base}" xml:space="preserve">${left.map(x => this.tspan(x)).join('')}</text>`)
    if (r.length > 0) this.parts.push(`<text x="${this.x(SVG_COLS)}" y="${base}" text-anchor="end" xml:space="preserve">${r.map(x => this.tspan(x)).join('')}</text>`)
    this.y += LH
  }

  gap(h = LH) {
    this.y += h
  }

  rect(col: number, width: number, top: number, h: number, fill: string, rx = 1) {
    this.parts.push(`<rect x="${this.x(col).toFixed(1)}" y="${(this.y + top).toFixed(1)}" width="${width.toFixed(1)}" height="${h}" rx="${rx}" fill="${fill}"/>`)
  }

  /** A row of thin strips: `[filled, total, color]` segments with a one-cell gap. */
  strips(col: number, segs: readonly { filled: number; total: number; color: string }[], top = 8) {
    let at = col
    for (const s of segs) {
      for (let i = 0; i < s.total; i += 1) this.rect(at + i, CH - 1, top, 6, i < s.filled ? s.color : C.track)
      at += s.total + 1
    }
  }
}

function statusBlock(doc: Doc, d: SidebarData) {
  const isWorking = d.isWorking || d.runningAgents > 0
  const turnMs = d.turnStartedAt === null ? 0 : d.now - d.turnStartedAt
  const first: Run[] = [{ t: '◉', c: isWorking ? C.accent : C.green }, { t: ' ' }, { t: isWorking ? 'Working' : 'Idle', c: C.bright, b: true }]
  if (d.isWorking) first.push({ t: `  ${mmss(turnMs)}`, c: C.dim })
  else if (d.runningAgents > 0) first.push({ t: ` · ${d.runningAgents} agent${d.runningAgents === 1 ? '' : 's'}`, c: C.dim })
  doc.text(first, [{ t: 'main ', c: C.dim }, { t: '/', c: C.faint }, { t: ` ${d.model.replace(/^claude-/, '')}`, c: C.dim }])
  const root = d.root
  if (root === undefined) {
    doc.text([{ t: '  awaiting prompt', c: C.dim }])
  } else {
    doc.text([{ t: '  ' }, { t: root.title, c: C.bright }])
    const room = SVG_COLS - 2 - 5
    const plan = planSegments(d.steps)
    const isUnsure = root.confidence < 0.5 && root.status !== 'done'
    const percent = d.steps.length > 0 ? Math.max(plan.percent, root.progress) : root.progress
    bar(doc, 2, room, d.steps, plan, percent, isUnsure, root.status === 'done' ? C.green : C.accent)
    doc.text([], [{ t: isUnsure ? '··' : `${Math.round(percent * 100)}%`, c: C.bright }])
    const step = plan.current >= 0 ? plan.current + 1 : d.steps.length
    const word = root.status === 'done' ? 'done' : root.status === 'waiting' ? 'waiting' : (PHASE_WORD[root.phase] ?? root.phase)
    const spent = d.now - root.startedAt
    const eta = percent > 0.05 && percent < 1 ? (spent / percent) * (1 - percent) : undefined
    const runs: Run[] = [{ t: '  observer  ', c: C.dim }]
    if (d.steps.length > 0) runs.push({ t: 'step ', c: C.dim }, { t: String(step), c: C.bright }, { t: `/${d.steps.length}  `, c: C.dim })
    runs.push({ t: word, c: C.accent })
    if (d.lastFile !== null && root.status !== 'done') runs.push({ t: ` ${basename(d.lastFile)}`, c: C.dim })
    if (eta !== undefined) runs.push({ t: `  ·  ~${Math.max(1, Math.round(eta / 60_000))}m left`, c: C.dim })
    doc.text(runs)
  }
  agentRows(doc, d.agentTasks)
}

/** One compact row per subagent's task: `  └ type title` then its own bar. */
function agentRows(doc: Doc, rows: readonly AgentTaskRow[]) {
  const shown = rows.slice(0, 3)
  const leftW = Math.floor(SVG_COLS / 2)
  for (const r of shown) {
    const plan = planSegments(r.steps)
    const percent = r.steps.length > 0 ? Math.max(plan.percent, r.progress) : r.progress
    const isUnsure = r.confidence < 0.5 && r.isRunning
    const color = r.status === 'blocked' ? C.red : r.isRunning ? C.accent : C.green
    const left = cut([{ t: '  └ ', c: C.dim }, { t: `${r.type} `, c: C.dim }, { t: r.title, c: C.fg }], leftW)
    bar(doc, leftW + 1, SVG_COLS - leftW - 6, r.steps, plan, percent, isUnsure, color)
    doc.text(left, [{ t: isUnsure ? '··' : `${Math.round(percent * 100)}%`, c: C.bright }])
  }
  if (rows.length > shown.length) doc.text([{ t: `    +${rows.length - shown.length} more`, c: C.dim }])
}

/** The segmented (or plain, or indeterminate) bar on the current row, before its text. */
function bar(
  doc: Doc,
  col: number,
  room: number,
  steps: readonly { status: string }[],
  plan: ReturnType<typeof planSegments>,
  percent: number,
  isUnsure: boolean,
  color: string,
) {
  if (isUnsure) {
    for (let i = 0; i < room; i += 2) doc.rect(col + i, CH - 1, 8, 6, C.faint)

    return
  }
  if (steps.length === 0) {
    doc.strips(col, [{ filled: Math.round(percent * room), total: room, color }])

    return
  }
  const each = Math.max(1, Math.min(8, Math.floor((room + 1) / steps.length) - 1))
  doc.strips(
    col,
    steps.map((s, i) => {
      const isDone = s.status === 'done'
      const filled = isDone ? each : i === plan.current ? Math.round(plan.frac * each) : 0

      return { filled, total: each, color: isDone ? C.green : color }
    }),
  )
}

function header(doc: Doc, title: string, right: Run[] = []) {
  doc.text([{ t: title, c: C.bright, b: true }], right, C.accent)
}

function contextSection(doc: Doc, d: SidebarData) {
  const ctx = d.context
  const used = ctx?.used ?? d.usage?.contextTokens ?? 0
  const window = ctx?.window ?? d.usage?.window ?? 0
  const pct = window > 0 ? Math.round((used / window) * 100) : 0
  header(doc, 'Context', [{ t: tokens(used), c: C.bright }, { t: ` / ${tokens(window)} `, c: C.dim }, { t: '·', c: C.faint }, { t: ` ${pct}% `, c: C.dim }])
  if (ctx === null || window <= 0) {
    doc.text([{ t: 'heatmap after the first turn', c: C.dim }], [], C.track)

    return
  }
  const cells = heatCells(ctx, 100)
  for (let r = 0; r < 4; r += 1) {
    doc.text([], [], C.track)
    doc.y -= LH
    for (let i = 0; i < 25; i += 1) doc.rect(1 + i * 2, 2 * CH - 1, 4, 12, HEAT[cells[r * 25 + i] ?? 'empty'], 2)
    doc.y += LH
  }
  const legend: Run[] = []
  const cats = (['system', 'tools', 'chat', 'files'] as const).filter(c => !(ctx.isEstimate === true && ctx[c] === 0))
  cats.forEach((c, i) => legend.push({ t: '■', c: HEAT[c] }, { t: ` ${c} ${tokens(ctx[c])}${i < cats.length - 1 ? '  ' : ''}`, c: C.dim }))
  if (ctx.isEstimate === true) legend.push({ t: '  est.', c: C.faint })
  doc.text(legend, [], C.track)
  const t = turnsLeft(ctx)
  const runs: Run[] = [{ t: 'per turn ', c: C.dim }, { t: sparkline(ctx.perTurn.slice(-12)), c: C.accent }, { t: `  avg ${tokens(Math.round(t.avg))}  `, c: C.dim }]
  if (t.left !== undefined) runs.push({ t: `~${t.left} turns`, c: t.left < 10 ? C.accent : C.bright }, { t: ' left', c: C.dim })
  doc.text(runs, [], C.track)
}

function usageSection(doc: Doc, d: SidebarData) {
  header(doc, 'Usage')
  const samples = d.rate.samples
  const nowRate = Math.round(samples.at(-1) ?? 0)
  const avg = d.rate.count > 0 ? Math.round(d.rate.sum / d.rate.count) : 0
  const peak = Math.round(Math.max(0, ...samples))
  doc.text(
    [{ t: 'tok/s  ', c: C.dim }, { t: String(nowRate), c: C.bright }, { t: `  ·  avg ${avg}`, c: C.dim }],
    [{ t: 'peak ', c: C.dim }, { t: String(peak), c: C.bright }, { t: '  60s ', c: C.dim }],
    C.track,
  )
  const chartW = SVG_COLS - 2
  const window = [...Array(Math.max(0, 20 - samples.length)).fill(0), ...samples.slice(-20)] as number[]
  const shown = Array.from({ length: chartW }, (_, j) => window[Math.floor((j * window.length) / chartW)] ?? 0)
  const scale = Math.max(1, peak)
  // The chart is CHART_ROWS rows tall, the bars drawn from its floor.
  const chartH = CHART_ROWS * LH
  for (let r = 0; r < CHART_ROWS; r += 1) doc.text([], [], C.track)
  doc.y -= chartH
  shown.forEach((v, j) => {
    const h = v <= 0 ? 0 : Math.max(2, Math.round((v / scale) * chartH))
    if (h > 0) doc.rect(1 + j, CH - 1, chartH - h, h, rateColor(v), 1)
  })
  doc.parts.push(`<line x1="${doc.x(1)}" y1="${doc.y + chartH}" x2="${doc.x(SVG_COLS - 1)}" y2="${doc.y + chartH}" stroke="${C.track}" stroke-width="1"/>`)
  doc.y += chartH
  const hours = Math.max(1 / 60, (d.now - d.sessionStartedAt) / 3_600_000)
  const cost = d.usage?.costUsd
  doc.text(
    [
      { t: 'burn  ', c: C.dim },
      { t: cost === undefined ? '$–' : `$${(cost / hours).toFixed(2)}/h`, c: C.bright },
      { t: '  ·  ', c: C.dim },
      { t: tokens(Math.round(d.rate.tokens / (hours * 60))), c: C.bright },
      { t: ' tok/min  ·  session ', c: C.dim },
      { t: usd(cost), c: C.bright },
    ],
    [],
    C.track,
  )
  doc.gap(LH / 2)
  const cs = cacheState(d.cache.lastHitAt, d.cache.ttlMs, d.now)
  const ttlCells = 20
  const left = Math.round((cs.remainingMs / d.cache.ttlMs) * ttlCells)
  const cacheColor = cs.state === 'hot' ? C.green : cs.state === 'warm' ? C.accent : C.dim
  doc.strips(SVG_COLS - ttlCells, [{ filled: left, total: ttlCells, color: cacheColor }])
  const cacheRuns: Run[] = [{ t: 'cache ', c: C.dim }, { t: `${cs.state === 'cold' ? '○' : '●'} ${cs.state}`, c: cacheColor }]
  if (cs.state !== 'cold') cacheRuns.push({ t: '  ', c: C.dim }, { t: clock(cs.remainingMs), c: C.bright }, { t: ' until cold', c: C.dim })
  doc.text(cacheRuns, [{ t: ' '.repeat(ttlCells) }], C.track)
  const totalIn = d.cache.readTokens + d.cache.inputTokens
  const readPct = totalIn > 0 ? Math.round((d.cache.readTokens / totalIn) * 100) : 0
  doc.text(
    [
      { t: `      last hit ${d.cache.lastHitAt === null ? '–' : `${clock(d.now - d.cache.lastHitAt)} ago`} · read ${readPct}% · saved `, c: C.dim },
      { t: `~${tokens(Math.round(d.cache.readTokens * 0.9))}`, c: C.bright },
      { t: ' tok', c: C.dim },
    ],
    [],
    C.track,
  )
}

/** The Stats screen's rows, as the shared module lays them out. */
function statsScreen(doc: Doc, d: SidebarData) {
  const rows = statsRows(d.stats, d.statsRange, SVG_COLS - 1)
  rows.forEach((r, i) => {
    if (r.kind === 'gap') {
      doc.gap()
    } else if (r.kind === 'header') {
      header(doc, r.title, i === 0 ? [...r.right, { t: 'r', c: C.bright }, { t: ` ${RANGE_LABEL[d.statsRange]} `, c: C.dim }] : r.right)
    } else if (r.kind === 'line') {
      doc.text(r.runs, r.right ?? [], C.track)
    } else {
      const col = 1 + r.runs.reduce((n, x) => n + [...x.t].length, 0)
      doc.strips(col, [{ filled: r.filled, total: r.total, color: r.color }])
      doc.text([...r.runs, { t: ' '.repeat(r.total + 1) }], r.right ?? [], C.track)
    }
  })
}

function decisionsHeader(doc: Doc, d: SidebarData, list: Decision[], isDetail: boolean) {
  const open = list.filter(x => x.isPending).length
  const drift = d.alerts.drift !== null ? 'high' : d.alerts.spins.length > 0 || list.some(x => x.outsidePlan !== undefined) ? 'medium' : 'low'
  const driftColor = drift === 'high' ? C.red : drift === 'medium' ? C.accent : C.green
  header(doc, 'Decisions', [
    { t: `${list.length}  ·  `, c: C.dim },
    { t: `${open} open`, c: open > 0 ? C.accent : C.dim },
    { t: '  ·  drift ', c: C.dim },
    { t: drift, c: driftColor },
    { t: '  ·  ', c: C.dim },
    { t: 'd', c: C.bright },
    { t: isDetail ? ' compact ' : ' detail ', c: C.dim },
  ])
}

function pipsRuns(x: Decision): Run[] {
  const n = pips(x.confidence)

  return [
    { t: n.replace(/▱/g, ''), c: C.accent },
    { t: n.replace(/▰/g, ''), c: C.faint },
    { t: ` ${x.isReversible ? '↺' : '⚠'} `, c: x.isReversible ? C.dim : C.red },
  ]
}

const WRAP = 3
const BODY = SVG_COLS - 1

/** The decisions' text runs to three lines, each continued under its own indent. */
function wrapped(text: string, indent: number, rightW: number) {
  return wrapLines(text, Math.max(8, BODY - indent), WRAP, Math.max(8, BODY - indent - rightW))
}

/** `title  ● chosen` with the marker coloured wherever the wrap put it. */
function choiceRuns(line: string): Run[] {
  const at = line.indexOf('●')
  if (at < 0) return [{ t: line, c: C.bright }]

  return [{ t: line.slice(0, at), c: C.bright }, { t: '●', c: C.green }, { t: line.slice(at + 1), c: C.bright }]
}

function decisionsCompact(doc: Doc, d: SidebarData) {
  const list = d.decisions.filter(x => x.isReverted !== true)
  decisionsHeader(doc, d, list, false)
  if (list.length === 0) doc.text([{ t: d.isObserverOn ? 'none yet: the observer notes choices as they happen' : 'observer off', c: C.dim }], [], C.track)
  const t = (x: Decision) => clock(x.at - d.sessionStartedAt)
  const pad = (n: number): Run => ({ t: ' '.repeat(n) })
  for (const x of list.slice(-4)) {
    if (x.isPending) {
      const lean = wrapped(x.lean ?? x.options?.[0] ?? x.title, 19, 9)
      doc.text(
        [{ t: ` ${t(x)} `, c: C.dim }, { t: '◇', c: C.accent }, { t: ' Pending', c: C.bright }, { t: '  ', c: C.dim }, { t: '▸', c: C.accent }, { t: ` ${lean[0] ?? ''}`, c: C.bright }],
        [{ t: '⏎ answer ', c: C.accent }],
        C.track,
      )
      for (const l of lean.slice(1)) doc.text([pad(19), { t: l, c: C.bright }], [], C.track)
      const others = (x.options ?? []).filter(o => o !== x.lean)
      if (others.length > 0) for (const l of wrapped(others.map(o => `○ ${o}`).join('  '), 8, 0)) doc.text([pad(8), { t: l, c: C.dim }], [], C.track)
      if (x.rationale !== '') for (const l of wrapped(`"${x.rationale}"`, 8, 0)) doc.text([pad(8), { t: l, c: C.quote, i: true }], [], C.track)
      continue
    }
    const lines = wrapped(`${x.title}  ● ${x.chosen}`, 8, 7)
    doc.text([{ t: ` ${t(x)} `, c: C.dim }, { t: '◆', c: C.accent }, { t: ' ' }, ...choiceRuns(lines[0] ?? '')], pipsRuns(x), C.track)
    for (const l of lines.slice(1)) doc.text([pad(8), ...choiceRuns(l)], [], C.track)
    if (x.outsidePlan !== undefined) {
      doc.text([{ t: '        ', c: C.dim }, { t: 'observer:', c: C.red }, { t: ` ${x.outsidePlan} · `, c: C.dim }, { t: 'x', c: C.bright }, { t: ' revert', c: C.dim }], [], C.track)
    } else if (x.rejected.length > 0) {
      for (const l of wrapped(x.rejected.map(r => `○ ${r.option}`).join('  '), 8, 0)) doc.text([pad(8), { t: l, c: C.dim }], [], C.track)
    }
  }
}

function decisionsDetail(doc: Doc, d: SidebarData) {
  const list = d.decisions.filter(x => x.isReverted !== true)
  decisionsHeader(doc, d, list, true)
  if (list.length === 0) doc.text([{ t: d.isObserverOn ? 'none yet: the observer notes choices as they happen' : 'observer off', c: C.dim }], [], C.track)
  const t = (x: Decision) => clock(x.at - d.sessionStartedAt)
  for (const x of list.slice(-6)) {
    const spine: Run[] = [{ t: ' ', c: C.dim }, { t: x.isPending ? '┆' : '│', c: C.faint }]
    // Continuation lines sit under the text's own column, past the spine.
    const under = (indent: number, run: Run) => doc.text([...spine, { t: ' '.repeat(indent - 2) }, run], [], C.track)
    doc.text([{ t: ' ' }, { t: '│', c: C.faint }], [], C.track)
    const title = wrapped(x.title, 9, x.isPending ? 20 : 18)
    doc.text(
      [{ t: ` ${x.isPending ? '◇' : '◆'}`, c: C.accent }, { t: ` ${t(x)}  `, c: C.dim }, { t: title[0] ?? '', c: C.bright }, ...(x.isPending ? [{ t: '  your call', c: C.dim }] : [])],
      x.isPending ? [{ t: '⏎ answer ', c: C.accent }] : [{ t: 'confidence ', c: C.dim }, ...pipsRuns(x)],
      C.track,
    )
    for (const l of title.slice(1)) under(9, { t: l, c: C.bright })
    const branches = x.isPending
      ? (x.options ?? []).map(o => ({ label: o, isChosen: o === x.lean, reason: o === x.lean ? 'agent lean' : '' }))
      : [{ label: x.chosen, isChosen: true, reason: 'chosen' }, ...x.rejected.map(r => ({ label: r.option, isChosen: false, reason: r.reason }))]
    branches.forEach((b, i) => {
      const elbow = i === branches.length - 1 ? '└─' : '├─'
      const mark = x.isPending ? (b.isChosen ? '▸' : ' ') : b.isChosen ? '●' : '○'
      const label = wrapped(b.label, 9, b.reason.length + 1)
      const color = b.isChosen ? C.bright : C.dim
      doc.text(
        [...spine, { t: `  ${elbow} `, c: C.dim }, { t: `${mark} `, c: b.isChosen ? (x.isPending ? C.accent : C.green) : C.dim }, { t: label[0] ?? '', c: color }],
        [{ t: `${b.reason} `, c: b.isChosen && !x.isPending ? C.green : C.dim }],
        C.track,
      )
      for (const l of label.slice(1)) under(9, { t: l, c: color })
    })
    if (x.rationale !== '') for (const l of wrapped(`"${x.rationale}"`, 9, 0)) under(9, { t: l, c: C.quote, i: true })
    if (x.evidence.length > 0) doc.text([...spine, { t: `     evidence  ${x.evidence.join('  ·  ')}`, c: C.dim }], [], C.track)
    if (x.outsidePlan !== undefined) {
      doc.text([...spine, { t: '     ', c: C.dim }, { t: 'observer', c: C.red }, { t: `  ${x.outsidePlan}  ·  `, c: C.dim }, { t: 'x', c: C.bright }, { t: ' revert', c: C.dim }], [], C.track)
    }
    if (!x.isPending) doc.text([...spine, { t: `     impact    ${x.files} file${x.files === 1 ? '' : 's'}  ·  ${x.isReversible ? 'reversible' : 'hard to undo'}`, c: C.dim }], [], C.track)
    else doc.text([...spine, { t: `     blocks    ${x.blocks ?? 'next step'}  ·  waiting `, c: C.dim }, { t: clock(d.now - x.at), c: C.bright }], [], C.track)
  }
}

function agentsSection(doc: Doc, d: SidebarData) {
  const running = d.agents.filter(a => a.status === 'running').length
  header(doc, 'Agents', [{ t: `${running} running `, c: C.dim }])
  for (const a of d.agents) {
    const isRun = a.status === 'running'
    const ms = (a.endedAt ?? (isRun ? d.now : a.startedAt)) - a.startedAt
    const doing = a.id === 'main' ? d.current : (a.currentTool ?? null)
    const state = isRun ? (doing !== null ? (doing.split(' ')[0]?.toLowerCase() ?? 'working') : 'thinking') : a.status
    const samples = d.agentRates[a.id] ?? []
    const peak = Math.round(Math.max(0, ...samples))
    doc.text(
      [
        { t: `${isRun ? '●' : '○'} `, c: isRun ? C.accent : a.status === 'error' ? C.red : C.dim },
        { t: a.id === 'main' ? 'main' : fit(a.type, 16), c: C.bright },
        { t: `  ${a.model.replace(/^claude-/, '')}  ·  `, c: C.dim },
        { t: state, c: isRun ? C.accent : C.dim },
        { t: `  ·  ${elapsed(ms)}  ·  ${tokens(a.tokens)}${a.isBackground ? '  bg' : ''}`, c: C.dim },
      ],
      [{ t: `peak ${peak} `, c: C.dim }],
      C.track,
    )
    // Its own small tok/s chart, one row tall, under the name.
    const width = SVG_COLS - 3
    const window = [...Array(Math.max(0, 20 - samples.length)).fill(0), ...samples.slice(-20)] as number[]
    const shown = Array.from({ length: width }, (_, j) => window[Math.floor((j * window.length) / width)] ?? 0)
    const scale = Math.max(1, peak)
    const chartH = LH - 4
    doc.text([], [], C.track)
    doc.y -= LH
    shown.forEach((v, j) => {
      const h = v <= 0 ? 0 : Math.max(2, Math.round((v / scale) * chartH))
      if (h > 0) doc.rect(3 + j, CH - 1, 2 + chartH - h, h, rateColor(v), 1)
    })
    doc.parts.push(`<line x1="${doc.x(3)}" y1="${doc.y + 2 + chartH}" x2="${doc.x(SVG_COLS)}" y2="${doc.y + 2 + chartH}" stroke="${C.track}" stroke-width="1"/>`)
    doc.y += LH
  }
  doc.text(
    [{ t: `  observer  ${d.observer.calls} calls  ·  ${tokens(d.observer.inputTokens)} in  /  ${tokens(d.observer.outputTokens)} out${d.isObserverOn ? '' : '  (off)'}`, c: C.dim }],
    [],
    C.track,
  )
}

function activitySection(doc: Doc, d: SidebarData) {
  header(doc, 'Activity')
  const past = d.feed.filter(f => f.state !== 'running')
  const running = d.feed.filter(f => f.state === 'running').at(-1)
  const tail = (f: FeedItem): Run => ({
    t: `${f.detail !== undefined ? `  ${f.state === 'running' ? '' : '·  '}${f.detail}` : ''}${(f.count ?? 1) > 1 ? `  ×${f.count}` : ''}`,
    c: f.state === 'error' ? C.red : C.dim,
  })
  if (running !== undefined || d.current !== null) {
    const runs: Run[] = [{ t: '▸ ', c: C.accent }, { t: running?.text ?? d.current ?? '', c: C.bright }]
    if (running !== undefined) runs.push({ t: `  ${elapsed(d.now - running.at)}`, c: C.dim }, tail(running))
    doc.text(runs, [], C.track)
  }
  for (const f of past.slice(-8).reverse()) {
    doc.text([{ t: `  ${f.state === 'error' ? '✖ ' : ''}${f.agentId !== undefined ? '↳ ' : ''}${f.text}`, c: f.state === 'error' ? C.red : C.dim }, tail(f)], [], C.track)
  }
  if (running === undefined && d.current === null && past.length === 0) doc.text([{ t: '  nothing yet', c: C.dim }], [], C.track)
  const c = d.confidence
  const mark = (v: boolean | null): Run => (v === true ? { t: '✔', c: C.green } : v === false ? { t: '✖', c: C.red } : { t: '–', c: C.dim })
  doc.text(
    [{ t: '  tests ', c: C.dim }, mark(c.testsPassed), { t: '  types ', c: C.dim }, mark(c.typecheckClean), { t: `  ${c.untestedEdits} untested edit${c.untestedEdits === 1 ? '' : 's'}`, c: C.dim }],
    [],
    C.track,
  )
}

function filesSection(doc: Doc, d: SidebarData) {
  const add = d.files.reduce((n, f) => n + f.added, 0)
  const rem = d.files.reduce((n, f) => n + f.removed, 0)
  header(doc, 'Files', [{ t: `${d.files.length} changed  ·  +${add} −${rem} `, c: C.dim }])
  for (const f of [...d.files].reverse().slice(0, 6)) {
    const isCovered = d.confidence.lastPassAt !== undefined && d.confidence.lastPassAt > f.at
    doc.text(
      [{ t: '  ', c: C.dim }, { t: 'M', c: C.accent }, { t: ' ', c: C.dim }, { t: relPath(f.path, d.projectRoot), c: C.bright }],
      [{ t: `+${f.added} −${f.removed}  `, c: C.dim }, { t: isCovered ? '✔' : '○', c: isCovered ? C.green : C.dim }],
      C.track,
    )
  }
}

function timelineSection(doc: Doc, d: SidebarData) {
  header(doc, 'Timeline', [{ t: `${d.timeline.length} `, c: C.dim }])
  const start = d.root?.startedAt ?? d.sessionStartedAt
  const cells = SVG_COLS - 3
  const doneAt = Math.max(start, ...d.steps.filter(s => s.status === 'done').map(s => s.updatedAt))
  const p = d.root?.progress ?? 0
  const elapsedMs = Math.max(1, d.now - start)
  const total = p > 0.05 && p < 1 ? elapsedMs / p : elapsedMs * (d.root?.status === 'done' ? 1 : 1.25)
  const runs: Run[] = [{ t: '  ' }]
  for (let i = 0; i < cells; i += 1) {
    const t = start + ((i + 0.5) / cells) * total
    runs.push({ t: '━', c: t <= doneAt ? C.green : t <= d.now ? C.accent : C.faint })
  }
  doc.text(runs, [], C.track)
  const marks: string[] = ['0:00 start']
  const seen = new Set<string>()
  for (const e of d.timeline.filter(x => x.kind === 'phase' && x.at >= start)) {
    const label = PHASE_LABEL[e.text]
    if (label === undefined || seen.has(label)) continue
    seen.add(label)
    marks.push(`${clock(e.at - start)} ${label}`)
  }
  doc.text([{ t: `  ${marks.join(' · ')}`, c: C.dim }], [], C.track)
}

function actionBar(doc: Doc) {
  doc.text([{ t: '─'.repeat(SVG_COLS), c: C.track }])
  const runs: Run[] = []
  const tools: [string, string, string, string][] = [
    ['■', C.red, '^C', 'stop'],
    ['⇆', C.accent, 'c', 'compact'],
    ['▶', C.green, 't', 'tests'],
    ['◆', C.purple, 'k', 'ckpt'],
    ['✎', C.cyan, 'n', 'note'],
    ['▦', C.dim, 's', 'stats'],
  ]
  // The bar wraps as the terminal's does: a tool that would not fit starts a row.
  let used = 0
  for (const [icon, color, key, label] of tools) {
    const w = 1 + 1 + key.length + 1 + label.length
    if (used > 0 && used + 2 + w > SVG_COLS) {
      doc.text(runs.splice(0, runs.length))
      used = 0
    }
    if (used > 0) {
      runs.push({ t: '  ' })
      used += 2
    }
    runs.push({ t: icon, c: color }, { t: ` ${key}`, c: C.bright }, { t: ` ${label}`, c: C.dim })
    used += w
  }
  doc.text(runs)
}

/** The whole sidebar as SVG markup, 4a by default and 4b when the detail view is on. */
export function drawSvg(d: SidebarData): string {
  const doc = new Doc()
  statusBlock(doc, d)
  doc.gap()
  if (d.view.isStats === true) {
    statsScreen(doc, d)
  } else if (d.view.isDetail === true) {
    decisionsDetail(doc, d)
  } else {
    contextSection(doc, d)
    doc.gap()
    usageSection(doc, d)
    doc.gap()
    decisionsCompact(doc, d)
    doc.gap()
    agentsSection(doc, d)
    doc.gap()
    activitySection(doc, d)
    doc.gap()
    filesSection(doc, d)
    doc.gap()
    timelineSection(doc, d)
  }
  doc.gap()
  actionBar(doc)
  const height = doc.y + PAD
  const body = doc.parts.join('')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="100%" font-family="${FONT}" font-size="13">` +
    `<rect width="${WIDTH}" height="${height}" rx="6" fill="#141210"/>` +
    body +
    '</svg>'
  )
}

/** What the drawing says, for a surface that cannot show it. */
export function svgAlt(d: SidebarData) {
  const state = d.isWorking ? 'working' : d.runningAgents > 0 ? `${d.runningAgents} agents working` : 'idle'
  const pct = d.usage?.percent

  return `Studiolo: ${state}; ${d.root?.title ?? 'no task'}; context ${pct === undefined ? '–' : `${pct}%`}`
}
