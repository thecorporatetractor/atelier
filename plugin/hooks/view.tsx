// The sidebar's drawing, after the Turn 4 design: 4a (default) and 4b (the
// decisions screen, `d`). Pure: it takes the elements, the data and the
// actions, no `$`. The terminal draws the bars, chart and heatmap as Raster
// cells; the remote surfaces get the whole sidebar as one Svg with the
// controls as real Buttons beside it.
import type { BoxProps, ButtonProps, ElementConstructor, InputProps, RasterProps, RenderChildren, RenderElement, SvgProps, TextProps } from 'claude-code'

import type {
  AgentNode,
  Alerts,
  CacheView,
  Confidence,
  ContextView,
  Decision,
  FeedItem,
  FileStat,
  ObserverStats,
  PeerSession,
  RateView,
  SearchHit,
  SpendView,
  StatsView,
  Summary,
  Task,
  TimelineEntry,
  UsageView,
  ViewState,
} from '../types'
import { type AgentTaskRow, basename, cacheState, clock, elapsed, fit, heatCells, type HeatCategory, pips, planSegments, relPath, sparkline, tokens, turnsLeft } from './lib/model'
import { type Cell, chartCells, chartGlyph, DEFAULT, heatRows, raster, rgb, stripCells } from './lib/raster'
import { mergeRuns } from './lib/runs'
import { wrapLines } from './lib/wrap'
import { RANGE_LABEL, type RangeKey, type Run, statsRows } from './stats'
import { drawSvg, svgAlt } from './svg'

export const C = {
  fg: '#d8d0c0',
  bright: '#f0e8d8',
  dim: '#6b6258',
  track: '#2a2622',
  faint: '#3a342e',
  accent: '#e0a458',
  green: '#a3be8c',
  red: '#d08770',
  purple: '#b48ead',
  cyan: '#88c0d0',
  quote: '#a89a86',
  rateLow: '#9a7340',
  rateHigh: '#f0c070',
}

export const HEAT: Record<HeatCategory, string> = {
  system: '#5a4e40',
  tools: '#8a6a3a',
  chat: '#c08a40',
  files: '#e8b060',
  empty: '#221e1a',
}

/** The design's width in columns; the chart's window is 20 samples of 3s (60s). */
export const DESIGN_WIDTH = 52
const CHART_SAMPLES = 20
/** The tok/s chart's height in rows: eighth blocks give 8 levels a row. */
export const CHART_ROWS = 4

// The design's bars are low strips, not full blocks.
const STRIP = '▃'
const CELL = '▅'

export type Els = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Input?: ElementConstructor<InputProps>
  Raster?: ElementConstructor<RasterProps>
  Svg?: ElementConstructor<SvgProps>
}

export type SidebarData = {
  now: number
  cols: number
  rows: number
  isWorking: boolean
  turnStartedAt: number | null
  model: string
  root: Task | undefined
  steps: Task[]
  /** One row per subagent's task, running first (see lib/status). */
  agentTasks: AgentTaskRow[]
  /** Subagents running right now, main loop aside. */
  runningAgents: number
  lastFile: string | null
  sessionStartedAt: number
  projectRoot: string
  usage: UsageView | null
  context: ContextView | null
  rate: RateView
  /** tok/s samples per loop ('main' or an agent id), oldest first, 50 at most. */
  agentRates: Record<string, number[]>
  cache: CacheView
  spend: SpendView | null
  /** The Stats screen's figures; null until the first flush. */
  stats: StatsView | null
  /** The range the Stats screen's range-dependent rows show. */
  statsRange: RangeKey
  view: ViewState
  decisions: Decision[]
  alerts: Alerts
  agents: AgentNode[]
  observer: ObserverStats
  isObserverOn: boolean
  feed: FeedItem[]
  current: string | null
  confidence: Confidence
  files: FileStat[]
  timeline: TimelineEntry[]
  peers: PeerSession[]
  handoff: Summary | null
  search: { query: string; hits: SearchHit[] } | null
}

export type SidebarActions = {
  toggleUsageTab: () => void
  toggleDetail: () => void
  toggleStats: () => void
  cycleRange: () => void
  toggleCompact: () => void
  toggleNote: () => void
  stop: () => void
  compact: () => void
  tests: () => void
  checkpoint: () => void
  sendNote: (text: string) => void
  answer: (decisionId: string, option: string) => void
  revert: (decisionId: string) => void
  openDiff: (path: string) => void
  useHandoff: () => void
  dismissHandoff: () => void
  closeSearch: () => void
}

const PHASE_WORD: Record<string, string> = {
  exploring: 'reading',
  planning: 'planning',
  editing: 'editing',
  verifying: 'testing',
  done: 'done',
}

const PHASE_LABEL: Record<string, string> = {
  planning: 'plan',
  editing: 'edit',
  verifying: 'tests',
  done: 'done',
}

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

function shortModel(model: string) {
  return model.replace(/^claude-/, '')
}

/** The chart's columns: the 50-sample window stretched over `width`. */
export function chartColumns(samples: readonly number[], width: number) {
  const window = [...Array(Math.max(0, CHART_SAMPLES - samples.length)).fill(0), ...samples.slice(-CHART_SAMPLES)] as number[]

  return Array.from({ length: width }, (_, j) => window[Math.floor((j * window.length) / width)] ?? 0)
}

export function drawSidebar(els: Els, d: SidebarData, act: SidebarActions): RenderElement {
  const { Box, Text, Button, Input, Raster, Svg } = els
  // Fills the pane: the design's 52-column parts (heatmap, chart, bars)
  // stretch to whatever width the pane has.
  const W = Math.max(24, d.cols)
  // Column 1 is the gutter; the body is the rest.
  const B = W - 1
  const isDetail = d.view.isDetail === true
  const isStats = d.view.isStats === true
  const isAnyWorking = d.isWorking || d.runningAgents > 0
  let k = 0
  const key = (p: string) => `${p}-${(k += 1)}`
  const TRACK = rgb(C.track)

  /** A body row: the gutter, then the left part, the right part flush right. */
  const row = (left: RenderChildren, right?: RenderChildren, gutter: string = C.track) => (
    <Box key={key('r')} flexDirection="row" width={W}>
      <Text color={gutter}>▍</Text>
      <Box key={key('l')} flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">{left}</Text>
      </Box>
      {right !== undefined && (
        <Box key={key('rt')} flexShrink={0} flexDirection="row">
          {right}
        </Box>
      )}
    </Box>
  )
  /** A body row whose left part mixes Text, Buttons and Rasters. */
  const mixed = (parts: RenderChildren[], right?: RenderChildren, gutter: string = C.track) => (
    <Box key={key('m')} flexDirection="row" width={W}>
      <Text color={gutter}>▍</Text>
      <Box key={key('ml')} flexGrow={1} flexShrink={1} flexDirection="row" overflow="hidden">
        {parts}
      </Box>
      {right !== undefined && (
        <Box key={key('mr')} flexShrink={0} flexDirection="row">
          {right}
        </Box>
      )}
    </Box>
  )
  const header = (title: string, right?: RenderChildren) =>
    row(
      <Text bold color={C.bright}>
        {title}
      </Text>,
      right,
      C.accent,
    )
  const gap = () => <Text key={key('gap')}> </Text>
  const dimText = (t: string) => <Text color={C.dim}>{t}</Text>
  /** A thin bar: `filled` strips in `color`, the rest in the track color. */
  const strip = (filled: number, total: number, color: string, glyph = STRIP) => (
    <Text>
      <Text color={color}>{glyph.repeat(Math.max(0, Math.min(total, filled)))}</Text>
      <Text color={C.track}>{glyph.repeat(Math.max(0, total - Math.max(0, Math.min(total, filled))))}</Text>
    </Text>
  )
  /** Cells as a Raster where the terminal draws, else as Text strips. */
  const cellsOrText = (id: string, rows: Cell[][], fallback: () => RenderChildren) => {
    const columns = Math.max(1, ...rows.map(r => r.length))
    if (Raster === undefined || columns > 512 || rows.length === 0) return fallback()
    const r = raster(columns, rows)

    return <Raster key={id} columns={r.columns} rows={r.rows} cells={r.cells} />
  }
  /** A keyed control drawn plain: the painter adds the key before the label. */
  const hot = (id: string, hotkey: string, label: string, onPress: () => void) => (
    <Button key={id} plain dimColor label={label} hotkey={hotkey} onPress={onPress} />
  )
  /**
   * The plan bar: one segment per step (done green, the current one partly
   * in `color`, the rest track), a plain strip without steps, a faint stripe
   * while the plan is unsure.
   */
  const planBar = (id: string, steps: readonly Task[], percent: number, isUnsure: boolean, color: string, room: number): RenderChildren => {
    if (isUnsure) return <Text color={C.faint}>{Array.from({ length: room }, (_, i) => '▚▞'[i % 2]).join('')}</Text>
    if (steps.length === 0) {
      const filled = Math.round(percent * room)

      return cellsOrText(id, [stripCells(filled, room, rgb(color), TRACK)], () => strip(filled, room, color))
    }
    const plan = planSegments(steps)
    const each = Math.max(1, Math.min(8, Math.floor((room + 1) / steps.length) - 1))
    const segs = steps.map((s, i) => {
      const isDone = s.status === 'done'
      const filled = isDone ? each : i === plan.current ? Math.round(plan.frac * each) : 0

      return { filled, color: isDone ? C.green : color }
    })
    const cells: Cell[] = []
    segs.forEach((s, i) => {
      cells.push(...stripCells(s.filled, each, rgb(s.color), TRACK))
      if (i < segs.length - 1) cells.push({ ch: ' ', fg: DEFAULT })
    })

    return cellsOrText(id, [cells], () =>
      cellRuns(
        segs.flatMap((s, i) => [
          ...Array.from({ length: each }, (_, j) => ({ ch: STRIP, color: j < s.filled ? s.color : C.track })),
          ...(i < segs.length - 1 ? [{ ch: ' ', color: C.track }] : []),
        ]),
      ),
    )
  }

  // ---------- compact mode: one line ----------
  if (d.view.isCompact) {
    const p = d.root?.progress ?? 0
    const ring = ['○', '◔', '◑', '◕', '●'][Math.round(p * 4)]

    return (
      <Box key="compact" flexDirection="row" gap={1}>
        <Text color={d.root?.status === 'done' ? C.green : C.accent}>{ring}</Text>
        <Text color={isAnyWorking ? C.accent : C.green}>◉</Text>
        <Text color={C.dim}>ctx {d.usage?.percent ?? '–'}%</Text>
        <Box key="c-title" flexGrow={1} flexShrink={1}>
          <Text color={C.fg} wrap="truncate-end">
            {d.root?.title ?? 'awaiting prompt'}
          </Text>
        </Box>
        <Button key="expand" plain label="⤢" onPress={act.toggleCompact} />
      </Box>
    )
  }

  // ---------- the action bar, native on every surface ----------
  const tool = (icon: string, color: string, control: RenderChildren) => (
    <Box key={key('tb')} flexDirection="row">
      <Text color={color}>{icon} </Text>
      {control}
    </Box>
  )
  const toolbar = (
    <Box key="toolbar" flexDirection="row" flexWrap="wrap" columnGap={2}>
      {tool('■', C.red, [
        <Text key="stop-key" color={C.bright}>
          ^C{' '}
        </Text>,
        <Button key="stop" plain dimColor label="stop" onPress={act.stop} />,
      ])}
      {tool('⇆', C.accent, hot('compact', 'c', 'compact', act.compact))}
      {tool('▶', C.green, hot('tests', 't', 'tests', act.tests))}
      {tool('◆', C.purple, hot('ckpt', 'k', 'ckpt', act.checkpoint))}
      {tool('✎', C.cyan, hot('note', 'n', 'note', act.toggleNote))}
      {tool('▦', C.dim, hot('stats', 's', isStats ? 'back' : 'stats', act.toggleStats))}
    </Box>
  )
  const detailToggle = hot('d-toggle', 'd', isDetail ? 'compact' : 'detail', act.toggleDetail)
  /** A row of cells, consecutive same-coloured ones drawn as one Text. */
  const cellRuns = (cells: readonly { ch: string; color: string }[]) => (
    <Text>
      {mergeRuns(cells).map(r => (
        <Text key={key('cr')} color={r.color}>
          {r.text}
        </Text>
      ))}
    </Text>
  )
  /** Runs of coloured text, as the stats rows and the svg spell them. */
  const runsText = (runs: readonly Run[]) => (
    <Text>
      {runs.map(r => (
        <Text key={key('run')} color={r.c ?? C.fg} bold={r.b} italic={r.i}>
          {r.t}
        </Text>
      ))}
    </Text>
  )
  const noteInput = d.view.isNoteOpen && Input !== undefined && (
    <Input key="note-input" placeholder="Note to Claude" submitLabel="Send" autoFocus onSubmit={value => act.sendNote(value)} />
  )
  const decisionButtons = (list: Decision[]) =>
    list.flatMap(x => [
      ...(x.isPending ? [<Button key={`ans-${x.id}`} plain label={`⏎ answer: ${fit(x.title, 20)}`} onPress={() => act.answer(x.id, x.lean ?? x.options?.[0] ?? '')} />] : []),
      ...(x.outsidePlan !== undefined ? [hot(`rv-${x.id}`, 'x', `revert ${fit(x.title, 20)}`, () => act.revert(x.id))] : []),
    ])

  // ---------- remote surfaces: the design as one Svg, the controls beside ----------
  if (Svg !== undefined && Raster === undefined) {
    const live = d.decisions.filter(x => x.isReverted !== true)

    return (
      <Box key="atelier" flexDirection="column">
        <Svg key="svg" source={drawSvg(d)} alt={svgAlt(d)} isInteractive />
        <Box key="svg-controls" flexDirection="row" flexWrap="wrap" columnGap={2}>
          {detailToggle}
          {isStats && hot('range', 'r', `range ${RANGE_LABEL[d.statsRange]}`, act.cycleRange)}
          {decisionButtons(live)}
        </Box>
        {toolbar}
        {noteInput}
      </Box>
    )
  }

  // ---------- status + task ----------
  const status: RenderChildren[] = []
  const turnMs = d.turnStartedAt === null ? 0 : d.now - d.turnStartedAt
  status.push(
    <Box key="st1" flexDirection="row" width={W}>
      <Box key="st1l" flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">
          <Text color={isAnyWorking ? C.accent : C.green}>◉</Text>{' '}
          <Text bold color={C.bright}>
            {isAnyWorking ? 'Working' : 'Idle'}
          </Text>
          {d.isWorking && <Text color={C.dim}>  {mmss(turnMs)}</Text>}
          {!d.isWorking && d.runningAgents > 0 && (
            <Text color={C.dim}>
              {' '}· {d.runningAgents} agent{d.runningAgents === 1 ? '' : 's'}
            </Text>
          )}
        </Text>
      </Box>
      <Text color={C.dim}>
        main <Text color={C.faint}>/</Text> {shortModel(d.model)}
      </Text>
      <Button key="to-compact" plain label=" ⤡" dimColor onPress={act.toggleCompact} />
    </Box>,
  )
  const pctText = (percent: number, isUnsure: boolean) => (
    <Text color={C.bright}>{isUnsure ? '  ··' : `${String(Math.round(percent * 100)).padStart(4)}%`}</Text>
  )
  if (d.root === undefined) {
    status.push(
      <Text key="st2" color={C.dim}>
        {'  '}awaiting prompt
      </Text>,
    )
  } else {
    status.push(
      <Text key="st2" color={C.bright} wrap="truncate-end">
        {'  '}
        {d.root.title}
      </Text>,
    )
    const room = W - 2 - 5
    const segs = d.steps
    const plan = planSegments(segs)
    const isUnsure = d.root.confidence < 0.5 && d.root.status !== 'done'
    const percent = segs.length > 0 ? Math.max(plan.percent, d.root.progress) : d.root.progress
    status.push(
      <Box key="st3" flexDirection="row" width={W}>
        <Text>{'  '}</Text>
        <Box key="st3b" flexGrow={1} flexShrink={1}>
          {planBar('plan', segs, percent, isUnsure, d.root.status === 'done' ? C.green : C.accent, room)}
        </Box>
        {pctText(percent, isUnsure)}
      </Box>,
    )
    const step = plan.current >= 0 ? plan.current + 1 : segs.length
    const word = PHASE_WORD[d.root.phase] ?? d.root.phase
    const spentMs = d.now - d.root.startedAt
    const eta = percent > 0.05 && percent < 1 ? (spentMs / percent) * (1 - percent) : undefined
    status.push(
      <Text key="st4" color={C.dim} wrap="truncate-end">
        {'  '}observer{'  '}
        {segs.length > 0 && (
          <Text>
            step <Text color={C.bright}>{step}</Text>/{segs.length}
            {'  '}
          </Text>
        )}
        <Text color={C.accent}>{d.root.status === 'done' ? 'done' : d.root.status === 'waiting' ? 'waiting' : word}</Text>
        {d.lastFile !== null && d.root.status !== 'done' ? ` ${basename(d.lastFile)}` : ''}
        {eta !== undefined ? `  ·  ~${Math.max(1, Math.round(eta / 60_000))}m left` : ''}
      </Text>,
    )
  }
  // One compact row per subagent's task: `  └ type title` and its own bar.
  {
    const shown = d.agentTasks.slice(0, 3)
    const leftW = Math.floor(W / 2)
    for (const r of shown) {
      const plan = planSegments(r.steps)
      const percent = r.steps.length > 0 ? Math.max(plan.percent, r.progress) : r.progress
      const isUnsure = r.confidence < 0.5 && r.isRunning
      const color = r.status === 'blocked' ? C.red : r.isRunning ? C.accent : C.green
      const left = fit(`${r.type} ${r.title}`, Math.max(4, leftW - 4))
      status.push(
        <Box key={key('ag')} flexDirection="row" width={W}>
          <Box key={key('agl')} width={leftW} flexShrink={0}>
            <Text wrap="truncate-end">
              <Text color={C.dim}>{'  └ '}</Text>
              <Text color={C.dim}>{left.slice(0, r.type.length)}</Text>
              <Text color={C.fg}>{left.slice(r.type.length)}</Text>
            </Text>
          </Box>
          <Text> </Text>
          <Box key={key('agb')} flexGrow={1} flexShrink={1}>
            {planBar(`plan-${r.agentId}`, r.steps, percent, isUnsure, color, Math.max(4, W - leftW - 6))}
          </Box>
          {pctText(percent, isUnsure)}
        </Box>,
      )
    }
    if (d.agentTasks.length > shown.length) {
      status.push(
        <Text key="ag-more" color={C.dim}>
          {'    '}+{d.agentTasks.length - shown.length} more
        </Text>,
      )
    }
  }

  // ---------- banners ----------
  const banners: RenderChildren[] = []
  if (d.alerts.attention !== null) {
    banners.push(
      <Text key="attn" inverse color={C.accent} wrap="truncate-end">
        {' '}⚑ {d.alerts.attention}{' '}
      </Text>,
    )
  }
  for (const s of d.alerts.spins) {
    banners.push(
      <Text key={key('spin')} color={C.red} wrap="truncate-end">
        ↻ {s.text}
      </Text>,
    )
  }
  if (d.handoff !== null) {
    banners.push(
      <Box key="handoff" flexDirection="column">
        {header('Hand-off', dimText('last session'))}
        {row(
          <Text color={C.quote} italic>
            {d.handoff.text}
          </Text>,
        )}
        {mixed([
          <Button key="ho-use" plain label="put in prompt" onPress={act.useHandoff} />,
          <Text key="ho-gap">{'  '}</Text>,
          <Button key="ho-x" plain dimColor label="dismiss" role="dismiss" onPress={act.dismissHandoff} />,
        ])}
      </Box>,
    )
  }
  if (d.search !== null) {
    banners.push(
      <Box key="search" flexDirection="column">
        {header(`Search "${fit(d.search.query, 20)}"`, <Button key="s-x" plain dimColor label="✕" onPress={act.closeSearch} />)}
        {d.search.hits.length === 0 && row(dimText('no matches'))}
        {d.search.hits.slice(0, 8).map(hit =>
          row(
            <Text>
              <Text color={C.dim}>{new Date(hit.at).toISOString().slice(5, 10)} </Text>
              <Text color={C.fg}>{hit.text}</Text>
            </Text>,
          ),
        )}
      </Box>,
    )
  }

  // ---------- decisions: the header, the compact rows (4a), the tree (4b) ----------
  const decisions = d.decisions.filter(x => x.isReverted !== true)
  const pipsOf = (x: Decision) => {
    const n = pips(x.confidence)

    return (
      <Text>
        <Text color={C.accent}>{n.replace(/▱/g, '')}</Text>
        <Text color={C.faint}>{n.replace(/▰/g, '')}</Text>
      </Text>
    )
  }
  const decHeader = () => {
    const open = decisions.filter(x => x.isPending).length
    const drift = d.alerts.drift !== null ? 'high' : d.alerts.spins.length > 0 || decisions.some(x => x.outsidePlan !== undefined) ? 'medium' : 'low'
    const driftColor = drift === 'high' ? C.red : drift === 'medium' ? C.accent : C.green

    return header(
      'Decisions',
      <Box key="dec-h" flexDirection="row">
        <Text>
          <Text color={C.dim}>{decisions.length}  ·  </Text>
          <Text color={open > 0 ? C.accent : C.dim}>{open} open</Text>
          <Text color={C.dim}>  ·  drift </Text>
          <Text color={driftColor}>{drift}</Text>
          <Text color={C.dim}>  ·  </Text>
        </Text>
        {detailToggle}
        <Text> </Text>
      </Box>,
    )
  }
  const decAt = (x: Decision) => clock(x.at - d.sessionStartedAt)
  const decEmpty = () => row(dimText(d.isObserverOn ? 'none yet: the observer notes choices as they happen' : 'observer off'))
  /** The decisions' text runs to three lines, each continued under its own indent. */
  const WRAP = 3
  const wrapped = (text: string, indent: number, rightW: number) => wrapLines(text, Math.max(8, B - indent), WRAP, Math.max(8, B - indent - rightW))
  /** `title  ● chosen` with the marker coloured wherever the wrap put it. */
  const choiceLine = (line: string) => {
    const at = line.indexOf('●')
    if (at < 0) return <Text color={C.bright}>{line}</Text>

    return (
      <Text>
        <Text color={C.bright}>{line.slice(0, at)}</Text>
        <Text color={C.green}>●</Text>
        <Text color={C.bright}>{line.slice(at + 1)}</Text>
      </Text>
    )
  }
  const decCompactRows = (): RenderChildren[] => {
    const out: RenderChildren[] = [decHeader()]
    if (decisions.length === 0) out.push(decEmpty())
    const pad = (n: number) => <Text>{' '.repeat(n)}</Text>
    for (const x of decisions.slice(-4)) {
      if (x.isPending) {
        // ` 0:12 ◇ Pending  ▸ ` is 19 columns; the lean continues under it.
        const lean = wrapped(x.lean ?? x.options?.[0] ?? x.title, 19, 9)
        out.push(
          row(
            <Text>
              <Text color={C.dim}> {decAt(x)} </Text>
              <Text color={C.accent}>◇</Text>
              <Text color={C.bright}> Pending</Text>
              <Text color={C.dim}>  </Text>
              <Text color={C.accent}>▸</Text>
              <Text color={C.bright}> {lean[0]}</Text>
            </Text>,
            <Button key={key('ans')} plain label="⏎ answer " onPress={() => act.answer(x.id, x.lean ?? x.options?.[0] ?? '')} />,
          ),
        )
        for (const l of lean.slice(1)) out.push(row(<Text>{pad(19)}<Text color={C.bright}>{l}</Text></Text>))
        const others = (x.options ?? []).filter(o => o !== x.lean)
        if (others.length > 0) {
          for (const l of wrapped(others.map(o => `○ ${o}`).join('  '), 8, 0)) out.push(row(<Text>{pad(8)}<Text color={C.dim}>{l}</Text></Text>))
        }
        if (x.rationale !== '') {
          for (const l of wrapped(`"${x.rationale}"`, 8, 0)) {
            out.push(
              row(
                <Text>
                  {pad(8)}
                  <Text color={C.quote} italic>
                    {l}
                  </Text>
                </Text>,
              ),
            )
          }
        }
        continue
      }
      // ` 0:12 ◆ ` is 8 columns; the pips and the mark take 7 at the right.
      const lines = wrapped(`${x.title}  ● ${x.chosen}`, 8, 7)
      out.push(
        row(
          <Text>
            <Text color={C.dim}> {decAt(x)} </Text>
            <Text color={C.accent}>◆</Text>
            <Text> </Text>
            {choiceLine(lines[0] ?? '')}
          </Text>,
          <Text>
            {pipsOf(x)}
            <Text color={x.isReversible ? C.dim : C.red}> {x.isReversible ? '↺' : '⚠'} </Text>
          </Text>,
        ),
      )
      for (const l of lines.slice(1)) out.push(row(<Text>{pad(8)}{choiceLine(l)}</Text>))
      if (x.outsidePlan !== undefined) {
        out.push(
          mixed([
            <Text key={key('ob')} wrap="truncate-end">
              <Text color={C.dim}>{'        '}</Text>
              <Text color={C.red}>observer:</Text>
              <Text color={C.dim}>
                {' '}
                {x.outsidePlan} ·{' '}
              </Text>
            </Text>,
            hot(key('rv'), 'x', 'revert', () => act.revert(x.id)),
          ]),
        )
      } else if (x.rejected.length > 0) {
        for (const l of wrapped(x.rejected.map(r => `○ ${r.option}`).join('  '), 8, 0)) out.push(row(<Text>{pad(8)}<Text color={C.dim}>{l}</Text></Text>))
      }
    }

    return out
  }
  const decDetailRows = (): RenderChildren[] => {
    const out: RenderChildren[] = [decHeader()]
    if (decisions.length === 0) out.push(decEmpty())
    for (const x of decisions.slice(-6)) {
      const spine = x.isPending ? '┆' : '│'
      const sp = (s: RenderChildren, right?: RenderChildren) =>
        row(
          <Text>
            <Text color={C.dim}> </Text>
            <Text color={C.faint}>{spine}</Text>
            {s}
          </Text>,
          right,
        )
      // Continuation lines sit under the text's own column, past the spine.
      const under = (indent: number, node: RenderChildren) => sp(<Text>{' '.repeat(indent - 2)}{node}</Text>)
      out.push(
        row(
          <Text>
            {' '}
            <Text color={C.faint}>│</Text>
          </Text>,
        ),
      )
      // ` ◆ 0:12  ` is 9 columns.
      const title = wrapped(x.title, 9, x.isPending ? 9 + 11 : 18)
      out.push(
        row(
          <Text>
            <Text color={C.accent}> {x.isPending ? '◇' : '◆'}</Text>
            <Text color={C.dim}> {decAt(x)}  </Text>
            <Text color={C.bright}>{title[0]}</Text>
            {x.isPending && <Text color={C.dim}>  your call</Text>}
          </Text>,
          x.isPending ? (
            <Button key={key('ans')} plain label="⏎ answer " onPress={() => act.answer(x.id, x.lean ?? x.options?.[0] ?? '')} />
          ) : (
            <Text>
              <Text color={C.dim}>confidence </Text>
              {pipsOf(x)}
              <Text color={x.isReversible ? C.dim : C.red}> {x.isReversible ? '↺' : '⚠'} </Text>
            </Text>
          ),
        ),
      )
      for (const l of title.slice(1)) out.push(under(9, <Text color={C.bright}>{l}</Text>))
      const branches = x.isPending
        ? (x.options ?? []).map(o => ({ label: o, isChosen: o === x.lean, reason: o === x.lean ? 'agent lean' : '' }))
        : [{ label: x.chosen, isChosen: true, reason: 'chosen' }, ...x.rejected.map(r => ({ label: r.option, isChosen: false, reason: r.reason }))]
      branches.forEach((b, i) => {
        const elbow = i === branches.length - 1 ? '└─' : '├─'
        const mark = x.isPending ? (b.isChosen ? '▸' : ' ') : b.isChosen ? '●' : '○'
        // ` │  ├─ ● ` is 9 columns; a pending option is a Button, one line.
        const label = x.isPending ? [b.label] : wrapped(b.label, 9, b.reason.length + 1)
        const color = b.isChosen ? C.bright : C.dim
        out.push(
          mixed(
            [
              <Text key={key('br')}>
                <Text color={C.dim}> </Text>
                <Text color={C.faint}>{spine}</Text>
                <Text color={C.dim}>
                  {'  '}
                  {elbow}{' '}
                </Text>
              </Text>,
              <Text key={key('mk')} color={b.isChosen ? (x.isPending ? C.accent : C.green) : C.dim}>
                {mark}{' '}
              </Text>,
              x.isPending ? (
                <Button key={key('opt')} plain dimColor={!b.isChosen} label={b.label} onPress={() => act.answer(x.id, b.label)} />
              ) : (
                <Text key={key('lb')} color={color} wrap="truncate-end">
                  {label[0]}
                </Text>
              ),
            ],
            <Text color={b.isChosen && !x.isPending ? C.green : C.dim}>{b.reason} </Text>,
          ),
        )
        for (const l of label.slice(1)) out.push(under(9, <Text color={color}>{l}</Text>))
      })
      if (x.rationale !== '') {
        for (const l of wrapped(`"${x.rationale}"`, 9, 0)) {
          out.push(
            under(
              9,
              <Text color={C.quote} italic>
                {l}
              </Text>,
            ),
          )
        }
      }
      if (x.evidence.length > 0) out.push(sp(<Text color={C.dim}>     evidence  {x.evidence.join('  ·  ')}</Text>))
      if (x.outsidePlan !== undefined) {
        out.push(
          mixed([
            <Text key={key('ob')} wrap="truncate-end">
              <Text color={C.dim}> </Text>
              <Text color={C.faint}>{spine}</Text>
              <Text color={C.dim}>{'     '}</Text>
              <Text color={C.red}>observer</Text>
              <Text color={C.dim}>
                {'  '}
                {x.outsidePlan}
                {'  ·  '}
              </Text>
            </Text>,
            hot(key('rv'), 'x', 'revert', () => act.revert(x.id)),
          ]),
        )
      }
      if (!x.isPending) {
        out.push(
          sp(
            <Text color={C.dim}>
              {'     '}impact    {x.files} file{x.files === 1 ? '' : 's'}  ·  {x.isReversible ? 'reversible' : 'hard to undo'}
            </Text>,
          ),
        )
      } else {
        out.push(
          sp(
            <Text color={C.dim}>
              {'     '}blocks    {x.blocks ?? 'next step'}  ·  waiting <Text color={C.bright}>{clock(d.now - x.at)}</Text>
            </Text>,
          ),
        )
      }
    }

    return out
  }

  const rule = (
    <Text key="rule" color={C.track}>
      {'─'.repeat(W)}
    </Text>
  )

  // ---------- the stats screen alone ----------
  if (isStats) {
    const rows = statsRows(d.stats, d.statsRange, B)
    const drawn = rows.map((r, i) => {
      if (r.kind === 'gap') return gap()
      if (r.kind === 'header') {
        return header(
          r.title,
          <Box key={key('sh')} flexDirection="row">
            {runsText(r.right)}
            {i === 0 && hot('range', 'r', RANGE_LABEL[d.statsRange], act.cycleRange)}
            {i === 0 && <Text>{'  '}</Text>}
            {i === 0 && detailToggle}
            {i === 0 && <Text> </Text>}
          </Box>,
        )
      }
      if (r.kind === 'line') return row(runsText(r.runs), r.right === undefined ? undefined : runsText(r.right))

      return mixed(
        [
          <Text key={key('bl')}>{runsText(r.runs)}</Text>,
          cellsOrText(`stat-${i}`, [stripCells(r.filled, r.total, rgb(r.color), TRACK)], () => strip(r.filled, r.total, r.color)),
        ],
        r.right === undefined ? undefined : <Text> {runsText(r.right)}</Text>,
      )
    })

    return (
      <Box key="atelier" flexDirection="column" width={W} minHeight={d.rows}>
        {status}
        {gap()}
        {drawn}
        <Box key="spacer" flexGrow={1} />
        {rule}
        {toolbar}
        {noteInput}
      </Box>
    )
  }

  // ---------- 4b: the decisions screen alone ----------
  if (isDetail) {
    return (
      <Box key="atelier" flexDirection="column" width={W} minHeight={d.rows}>
        {status}
        {banners.length > 0 && gap()}
        {banners}
        {gap()}
        {decDetailRows()}
        <Box key="spacer" flexGrow={1} />
        {rule}
        {toolbar}
        {noteInput}
      </Box>
    )
  }

  // The compact decision rows, built once: counted for Activity's room, then drawn.
  const decCompact = decCompactRows()

  // ---------- context ----------
  const ctxRows: RenderChildren[] = []
  {
    const ctx = d.context
    const used = ctx?.used ?? d.usage?.contextTokens ?? 0
    const window = ctx?.window ?? d.usage?.window ?? 0
    const pct = window > 0 ? Math.round((used / window) * 100) : 0
    ctxRows.push(
      header(
        'Context',
        <Text>
          <Text color={C.bright}>{tokens(used)}</Text>
          <Text color={C.dim}>
            {' '}
            / {tokens(window)} <Text color={C.faint}>·</Text> {pct}%{' '}
          </Text>
        </Text>,
      ),
    )
    if (ctx !== null && window > 0) {
      const perRow = 25
      const cells = heatCells(ctx, perRow * 4)
      const colors = cells.map(c => rgb(HEAT[c]))
      const heat = heatRows(colors, perRow, B, 4)
      // Each tile is 1% of the window; tile widths spread the row across the body.
      const cellW = (i: number) => Math.max(1, Math.floor(((i + 1) * B) / perRow) - Math.floor((i * B) / perRow))
      const textRows = () =>
        heat.map((_, r) => row(cellRuns(cells.slice(r * perRow, (r + 1) * perRow).map((c, i) => ({ ch: CELL.repeat(cellW(i)), color: HEAT[c] })))))
      if (Raster !== undefined && B <= 512) {
        const r = raster(B, heat)
        ctxRows.push(mixed([<Raster key="heat" columns={r.columns} rows={r.rows} cells={r.cells} />]))
        // The gutter beside the raster's other rows.
        for (let i = 1; i < 4; i += 1) ctxRows.push(<Text key={key('hg')} color={C.track}>▍</Text>)
      } else {
        ctxRows.push(...textRows())
      }
      const legend = (['system', 'tools', 'chat', 'files'] as const).filter(c => !(ctx.isEstimate === true && ctx[c] === 0))
      ctxRows.push(
        row(
          <Text>
            {legend.map((c, i) => (
              <Text key={key('lg')}>
                <Text color={HEAT[c]}>■</Text>
                <Text color={C.dim}>
                  {' '}
                  {c} {tokens(ctx[c])}
                  {i < legend.length - 1 ? '  ' : ''}
                </Text>
              </Text>
            ))}
            {ctx.isEstimate === true && <Text color={C.faint}>  est.</Text>}
          </Text>,
        ),
      )
      const t = turnsLeft(ctx)
      ctxRows.push(
        row(
          <Text>
            <Text color={C.dim}>per turn </Text>
            <Text color={C.accent}>{sparkline(ctx.perTurn.slice(-12))}</Text>
            <Text color={C.dim}>
              {'  '}avg {tokens(Math.round(t.avg))}
              {'  '}
            </Text>
            {t.left !== undefined && (
              <Text>
                <Text color={t.left < 10 ? C.accent : C.bright}>~{t.left} turns</Text>
                <Text color={C.dim}> left</Text>
              </Text>
            )}
          </Text>,
        ),
      )
    } else {
      ctxRows.push(row(dimText('heatmap after the first turn')))
    }
  }

  // ---------- usage ----------
  const usageRows: RenderChildren[] = []
  {
    usageRows.push(header('Usage'))
    const samples = d.rate.samples
    const nowRate = Math.round(samples.at(-1) ?? 0)
    const avg = d.rate.count > 0 ? Math.round(d.rate.sum / d.rate.count) : 0
    const peak = Math.round(Math.max(0, ...samples))
    usageRows.push(
      row(
        <Text>
          <Text color={C.dim}>tok/s{'  '}</Text>
          <Text color={C.bright}>{nowRate}</Text>
          <Text color={C.dim}>  ·  avg {avg}</Text>
        </Text>,
        <Text color={C.dim}>
          peak <Text color={C.bright}>{peak}</Text>
          {'  '}60s{' '}
        </Text>,
      ),
    )
    const chartW = B - 1
    const shown = chartColumns(samples, chartW)
    if (Raster !== undefined && chartW <= 512) {
      const r = raster(chartW, chartCells(shown, CHART_ROWS, peak, v => rgb(rateColor(v)), TRACK))
      usageRows.push(mixed([<Raster key="chart" columns={r.columns} rows={r.rows} cells={r.cells} />]))
      for (let i = 1; i < CHART_ROWS; i += 1) usageRows.push(<Text key={key('cg')} color={C.track}>▍</Text>)
    } else {
      // Each column stands `level` eighths tall over CHART_ROWS rows, filled
      // from the bottom; an empty column keeps a track-coloured baseline.
      const scale = Math.max(1, peak)
      const levelOf = (v: number) => Math.round((Math.max(0, v) / scale) * CHART_ROWS * 8)
      for (let r = 0; r < CHART_ROWS; r += 1) {
        const isBase = r === CHART_ROWS - 1
        usageRows.push(
          <Box key={`chart-${r}`} flexDirection="row" width={W}>
            <Text color={C.track}>▍</Text>
            {cellRuns(
              shown.map(v => {
                const l = levelOf(v)
                const isEmpty = isBase && l === 0

                return { ch: isEmpty ? '▁' : chartGlyph(l, r, CHART_ROWS), color: isEmpty ? C.track : rateColor(v) }
              }),
            )}
          </Box>,
        )
      }
    }
    const hours = Math.max(1 / 60, (d.now - d.sessionStartedAt) / 3_600_000)
    const cost = d.usage?.costUsd
    usageRows.push(
      row(
        <Text color={C.dim}>
          burn{'  '}
          <Text color={C.bright}>{cost === undefined ? '$–' : `$${(cost / hours).toFixed(2)}/h`}</Text>
          {'  ·  '}
          <Text color={C.bright}>{tokens(Math.round(d.rate.tokens / (hours * 60)))}</Text> tok/min{'  ·  '}session{' '}
          <Text color={C.bright}>{usd(cost)}</Text>
        </Text>,
      ),
    )
    usageRows.push(gap())
    const cs = cacheState(d.cache.lastHitAt, d.cache.ttlMs, d.now)
    const ttlCells = Math.max(6, B - 31)
    const left = Math.round((cs.remainingMs / d.cache.ttlMs) * ttlCells)
    const cacheColor = cs.state === 'hot' ? C.green : cs.state === 'warm' ? C.accent : C.dim
    usageRows.push(
      row(
        <Text>
          <Text color={C.dim}>cache </Text>
          <Text color={cacheColor}>
            {cs.state === 'cold' ? '○' : '●'} {cs.state}
          </Text>
          {cs.state !== 'cold' && (
            <Text color={C.dim}>
              {'  '}
              <Text color={C.bright}>{clock(cs.remainingMs)}</Text> until cold
            </Text>
          )}
        </Text>,
        cellsOrText('ttl', [stripCells(left, ttlCells, rgb(cacheColor), TRACK)], () => strip(left, ttlCells, cacheColor)),
      ),
    )
    const totalIn = d.cache.readTokens + d.cache.inputTokens
    const readPct = totalIn > 0 ? Math.round((d.cache.readTokens / totalIn) * 100) : 0
    usageRows.push(
      row(
        <Text color={C.dim}>
          {'      '}last hit {d.cache.lastHitAt === null ? '–' : `${clock(d.now - d.cache.lastHitAt)} ago`} · read {readPct}% · saved{' '}
          <Text color={C.bright}>~{tokens(Math.round(d.cache.readTokens * 0.9))}</Text> tok
        </Text>,
      ),
    )
  }

  // ---------- agents ----------
  const agentRows: RenderChildren[] = []
  {
    const running = d.agents.filter(a => a.status === 'running').length
    agentRows.push(header('Agents', dimText(`${running} running `)))
    // A chart under main and the running subagents only, four at most.
    let charts = 0
    for (const a of d.agents) {
      const isRun = a.status === 'running'
      const ms = (a.endedAt ?? (isRun ? d.now : a.startedAt)) - a.startedAt
      const doing = a.id === 'main' ? d.current : (a.currentTool ?? null)
      const state = isRun ? (doing !== null ? (doing.split(' ')[0]?.toLowerCase() ?? 'working') : 'thinking') : a.status
      const samples = d.agentRates[a.id] ?? []
      const peak = Math.round(Math.max(0, ...samples))
      const hasChart = (a.id === 'main' || isRun) && charts < 4
      agentRows.push(
        row(
          <Text>
            <Text color={isRun ? C.accent : a.status === 'error' ? C.red : C.dim}>{isRun ? '●' : '○'} </Text>
            <Text color={C.bright}>{a.id === 'main' ? 'main' : fit(a.type, 16)}</Text>
            <Text color={C.dim}>  {shortModel(a.model)}  ·  </Text>
            <Text color={isRun ? C.accent : C.dim}>{state}</Text>
            <Text color={C.dim}>
              {'  ·  '}
              {elapsed(ms)}
              {'  ·  '}
              {tokens(a.tokens)}
              {a.isBackground ? '  bg' : ''}
            </Text>
          </Text>,
          <Text color={C.dim}>peak {peak} </Text>,
        ),
      )
      if (!hasChart) continue
      charts += 1
      // Its own tok/s chart, one row of eighths scaled to its own peak,
      // indented under the name and stretched over the body like the main one.
      const width = Math.max(4, B - 2)
      const shown = chartColumns(samples, width)
      const scale = Math.max(1, peak)
      agentRows.push(
        <Box key={`agent-chart-${a.id}`} flexDirection="row" width={W}>
          <Text color={C.track}>▍</Text>
          <Text>{'  '}</Text>
          {cellRuns(
            shown.map(v => {
              const l = Math.round((Math.max(0, v) / scale) * 8)

              return { ch: l === 0 ? '▁' : chartGlyph(l, 0, 1), color: l === 0 ? C.track : rateColor(v) }
            }),
          )}
        </Box>,
      )
    }
    agentRows.push(
      row(
        <Text color={C.dim}>
          {'  '}observer  {d.observer.calls} calls  ·  {tokens(d.observer.inputTokens)} in  /  {tokens(d.observer.outputTokens)} out
          {d.isObserverOn ? '' : '  (off)'}
        </Text>,
      ),
    )
    if (d.peers.length > 0) {
      agentRows.push(
        row(
          <Text color={C.dim}>
            {'  '}
            {d.peers.length} other session{d.peers.length === 1 ? '' : 's'}  ·  {d.peers.map(p => `${Math.round(p.progress * 100)}% ${p.title}`).join('  ·  ')}
          </Text>,
        ),
      )
    }
  }

  // ---------- files ----------
  const fileRows: RenderChildren[] = []
  {
    const add = d.files.reduce((n, f) => n + f.added, 0)
    const rem = d.files.reduce((n, f) => n + f.removed, 0)
    fileRows.push(header('Files', dimText(`${d.files.length} changed  ·  +${add} −${rem} `)))
    for (const f of [...d.files].reverse().slice(0, 6)) {
      const rel = relPath(f.path, d.projectRoot)
      const isCovered = d.confidence.lastPassAt !== undefined && d.confidence.lastPassAt > f.at
      fileRows.push(
        mixed(
          [
            <Text key={key('fm')}>
              <Text color={C.dim}>{'  '}</Text>
              <Text color={C.accent}>M</Text>
              <Text color={C.dim}> </Text>
            </Text>,
            <Button key={key('f')} plain label={fit(rel, Math.max(8, B - 18))} onPress={() => act.openDiff(f.path)} />,
          ],
          <Text color={C.dim}>
            {'  '}+{f.added} −{f.removed}
            {'  '}
            <Text color={isCovered ? C.green : C.dim}>{isCovered ? '✔' : '○'}</Text>
          </Text>,
        ),
      )
    }
  }

  // ---------- timeline ----------
  const tlRows: RenderChildren[] = []
  {
    tlRows.push(header('Timeline', dimText(`${d.timeline.length} `)))
    const start = d.root?.startedAt ?? d.sessionStartedAt
    const cells = B - 2
    const doneAt = Math.max(start, ...d.steps.filter(s => s.status === 'done').map(s => s.updatedAt))
    const p = d.root?.progress ?? 0
    const elapsedMs = Math.max(1, d.now - start)
    const total = p > 0.05 && p < 1 ? elapsedMs / p : elapsedMs * (d.root?.status === 'done' ? 1 : 1.25)
    const at = (cell: number) => start + (cell / cells) * total
    tlRows.push(
      row(
        <Text>
          {'  '}
          {cellRuns(
            Array.from({ length: cells }, (_, i) => {
              const t = at(i + 0.5)

              return { ch: '━', color: t <= doneAt ? C.green : t <= d.now ? C.accent : C.faint }
            }),
          )}
        </Text>,
      ),
    )
    const marks: string[] = ['0:00 start']
    const seen = new Set<string>()
    for (const e of d.timeline.filter(x => x.kind === 'phase' && x.at >= start)) {
      const label = PHASE_LABEL[e.text]
      if (label === undefined || seen.has(label)) continue
      seen.add(label)
      marks.push(`${clock(e.at - start)} ${label}`)
    }
    tlRows.push(row(<Text color={C.dim}>{fit(`  ${marks.join(' · ')}`, B)}</Text>))
  }

  // ---------- activity ----------
  const actRows: RenderChildren[] = [header('Activity')]
  {
    const past = d.feed.filter(f => f.state !== 'running')
    const running = d.feed.filter(f => f.state === 'running').at(-1)
    const tail = (f: FeedItem) => (
      <Text color={f.state === 'error' ? C.red : C.dim}>
        {f.detail !== undefined ? `  ${f.state === 'running' ? '' : '·  '}${f.detail}` : ''}
        {(f.count ?? 1) > 1 ? `  ×${f.count}` : ''}
      </Text>
    )
    if (running !== undefined || d.current !== null) {
      actRows.push(
        row(
          <Text>
            <Text color={C.accent}>▸ </Text>
            <Text color={C.bright}>{running?.text ?? d.current}</Text>
            {running !== undefined && (
              <Text color={C.dim}>
                {'  '}
                {elapsed(d.now - running.at)}
              </Text>
            )}
            {running !== undefined && tail(running)}
          </Text>,
        ),
      )
    }
    // At least 8 past items; on a tall pane the spare rows go to Activity,
    // up to the feed's 20, while Files and Timeline still fit above the bar.
    const fixed = status.length + banners.length + ctxRows.length + usageRows.length + decCompact.length + agentRows.length + fileRows.length + tlRows.length + 3 + 2 + 8
    const room = Math.max(8, Math.min(20, d.rows - fixed))
    for (const f of past.slice(-room).reverse()) {
      actRows.push(
        row(
          <Text>
            <Text color={f.state === 'error' ? C.red : C.dim}>
              {'  '}
              {f.state === 'error' ? '✖ ' : ''}
              {f.agentId !== undefined ? '↳ ' : ''}
              {f.text}
            </Text>
            {tail(f)}
          </Text>,
        ),
      )
    }
    if (running === undefined && d.current === null && past.length === 0) actRows.push(row(dimText('  nothing yet')))
    const c = d.confidence
    const mark = (v: boolean | null) =>
      v === true ? <Text color={C.green}>✔</Text> : v === false ? <Text color={C.red}>✖</Text> : <Text color={C.dim}>–</Text>
    actRows.push(
      row(
        <Text color={C.dim}>
          {'  '}tests {mark(c.testsPassed)}
          {'  '}types {mark(c.typecheckClean)}
          {'  '}
          {c.untestedEdits} untested edit{c.untestedEdits === 1 ? '' : 's'}
        </Text>,
      ),
    )
  }

  return (
    <Box key="atelier" flexDirection="column" width={W} minHeight={d.rows}>
      {status}
      {banners.length > 0 && gap()}
      {banners}
      {gap()}
      {ctxRows}
      {gap()}
      {usageRows}
      {gap()}
      {decCompact}
      {gap()}
      {agentRows}
      {gap()}
      {actRows}
      <Box key="spacer" flexGrow={1} />
      {gap()}
      {fileRows}
      {gap()}
      {tlRows}
      {rule}
      {toolbar}
      {noteInput}
    </Box>
  )
}
