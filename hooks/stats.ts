// The Stats screen as rows, pure: the terminal drawing and the Svg both
// render these, so the two surfaces show the same figures the same way.
import type { StatsRange, StatsView } from '../types'
import { basename, fit, sparkline, tokens } from './lib/model'

export type Run = { t: string; c?: string; b?: boolean; i?: boolean }

export type StatRow =
  | { kind: 'header'; title: string; right: Run[] }
  | { kind: 'line'; runs: Run[]; right?: Run[] }
  | { kind: 'bar'; runs: Run[]; filled: number; total: number; color: string; right?: Run[] }
  | { kind: 'gap' }

export const RANGES = ['today', 'week', 'month', 'all'] as const
export type RangeKey = (typeof RANGES)[number]
export const RANGE_LABEL: Record<RangeKey, string> = { today: 'today', week: '7d', month: '30d', all: 'all' }

/** The design's palette, repeated here so the module stays free of the drawing. */
const P = {
  bright: '#f0e8d8',
  dim: '#6b6258',
  faint: '#3a342e',
  accent: '#e0a458',
  green: '#a3be8c',
  red: '#d08770',
  purple: '#b48ead',
  cyan: '#88c0d0',
  fg: '#d8d0c0',
}

const LABEL_W = 14

function usd(n: number) {
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`
}

function ms(n: number) {
  if (n < 1000) return `${Math.round(n)}ms`
  const s = n / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)

  return `${m}m${String(Math.round(s % 60)).padStart(2, '0')}s`
}

function pct(n: number) {
  return `${Math.round(n * 100)}%`
}

const dim = (t: string): Run => ({ t, c: P.dim })
const bright = (t: string): Run => ({ t, c: P.bright })
const label = (t: string): Run => ({ t: fit(t, LABEL_W).padEnd(LABEL_W), c: P.dim })

export function statsRows(s: StatsView | null, range: RangeKey, bodyCols: number): StatRow[] {
  const out: StatRow[] = []
  const header = (title: string, right: Run[] = []) => out.push({ kind: 'header', title, right })
  const line = (runs: Run[], right?: Run[]) => out.push({ kind: 'line', runs, right })
  const gap = () => out.push({ kind: 'gap' })
  // A bar row: the label, the strip, the figure; the strip takes what is left.
  const barW = Math.max(6, Math.min(28, bodyCols - LABEL_W - 16))
  const bar = (name: string, share: number, color: string, right: Run[]) =>
    out.push({ kind: 'bar', runs: [label(name)], filled: Math.round(Math.max(0, Math.min(1, share)) * barW), total: barW, color, right })
  const rangeTag = dim(RANGE_LABEL[range])

  if (s === null) {
    header('Stats')
    line([dim('collecting…')])

    return out
  }
  const r: StatsRange = s[range]

  // ---- spend ----
  header('Spend', [dim('active '), bright(String(s.activeDays)), dim(` day${s.activeDays === 1 ? '' : 's'}${s.since !== null ? ` · since ${s.since}` : ''} `)])
  line(
    RANGES.flatMap((k, i) => [
      { t: RANGE_LABEL[k], c: k === range ? P.bright : P.dim, b: k === range },
      { t: ` ${usd(s[k].cost)}`, c: k === range ? P.accent : P.fg },
      ...(i < RANGES.length - 1 ? [dim('  ·  ')] : []),
    ]),
  )
  const maxDay = Math.max(0, ...s.dailyCost)
  line([dim('30d '), { t: sparkline(s.dailyCost.slice(-30)), c: P.accent }, dim(`  peak ${usd(maxDay)}/day`)])
  gap()

  // ---- tokens ----
  const t = r.tokens
  const top = Math.max(1, t.input, t.output, t.cacheRead, t.cacheWrite)
  header('Tokens', [rangeTag, dim('  ·  '), bright(tokens(t.input + t.output + t.cacheRead + t.cacheWrite)), dim(' ')])
  bar('input', t.input / top, P.accent, [bright(tokens(t.input))])
  bar('output', t.output / top, P.accent, [bright(tokens(t.output))])
  bar('cache read', t.cacheRead / top, P.green, [bright(tokens(t.cacheRead))])
  bar('cache write', t.cacheWrite / top, P.purple, [bright(tokens(t.cacheWrite))])
  bar('cache hit', r.cacheHitRate, P.green, [bright(pct(r.cacheHitRate))])
  line([dim('30d '), { t: sparkline(s.dailyTokens.slice(-30)), c: P.accent }, dim(`  peak ${tokens(Math.max(0, ...s.dailyTokens))}/day`)])
  gap()

  // ---- models ----
  header('Models', [dim(`${s.models.length} `)])
  if (s.models.length === 0) line([dim('none yet')])
  for (const m of s.models) {
    bar(m.model.replace(/^claude-/, ''), m.share, P.accent, [bright(usd(m.cost)), dim(` · ${m.requests} req`)])
  }
  gap()

  // ---- projects ----
  header('Projects', [dim(`${s.projects.length} `)])
  if (s.projects.length === 0) line([dim('none yet')])
  const topProject = Math.max(0.01, ...s.projects.map(p => p.cost))
  for (const p of s.projects) {
    bar(basename(p.project), p.cost / topProject, P.cyan, [bright(usd(p.cost)), dim(` · ${p.turns} turn${p.turns === 1 ? '' : 's'}`)])
  }
  gap()

  // ---- tools ----
  header('Tools', [dim(`${s.tools.length} `)])
  if (s.tools.length === 0) line([dim('none yet')])
  const topTool = Math.max(1, ...s.tools.map(x => x.calls))
  for (const x of s.tools) {
    bar(x.tool, x.calls / topTool, P.fg, [bright(String(x.calls)), dim(' · '), { t: pct(x.failRate), c: x.failRate > 0.2 ? P.red : P.dim }, dim(` fail · ${ms(x.avgMs)}`)])
  }
  gap()

  // ---- agents ----
  header('Agents', [dim(`${s.agents.length} `)])
  if (s.agents.length === 0) line([dim('none yet')])
  const topAgent = Math.max(1, ...s.agents.map(a => a.tokens))
  for (const a of s.agents) {
    bar(a.type, a.tokens / topAgent, P.purple, [bright(`${a.spawns}×`), dim(` · ${tokens(a.tokens)} · ${ms(a.avgMs)} · `), { t: `${pct(a.failRate)} fail`, c: a.failRate > 0.2 ? P.red : P.dim }])
  }
  gap()

  // ---- activity ----
  header('Activity', [rangeTag, dim(' ')])
  line([dim('turns '), bright(String(r.turns)), dim('  ·  avg '), bright(ms(r.avgTurnMs)), dim('  ·  sessions '), bright(String(r.sessions)), dim('  ·  compactions '), bright(String(r.compactions))])
  line([dim('requests '), bright(String(r.requests)), dim('  ·  lines '), { t: `+${r.linesAdded}`, c: P.green }, dim(' '), { t: `−${r.linesRemoved}`, c: P.red }, dim('  ·  files '), bright(String(r.filesEdited))])
  line([dim('tests '), { t: `✔ ${r.testsPassed}`, c: P.green }, dim('  '), { t: `✖ ${r.testsFailed}`, c: r.testsFailed > 0 ? P.red : P.dim }])
  gap()

  // ---- observer ----
  header('Observer', [rangeTag, dim(' ')])
  bar('share', r.observerShare, P.cyan, [bright(pct(r.observerShare)), dim(' of tokens')])
  line([dim('calls '), bright(String(r.observer.calls)), dim('  ·  '), bright(tokens(r.observer.input)), dim(' in  /  '), bright(tokens(r.observer.output)), dim(' out')])

  return out
}
