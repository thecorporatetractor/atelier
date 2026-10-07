import { describe, expect, test } from 'claude-code/testing'

import type { Task } from '../types'
import {
  applyDiff,
  describeCall,
  mergeTasks,
  newTask,
  parseDiff,
  phaseOfTool,
  phaseProgress,
  recordAttempt,
  rescope,
  settle,
  type Attempts,
  answerPending,
  applyDecisions,
  cacheState,
  callDetail,
  feedLine,
  fit,
  heatCells,
  lineDelta,
  patchStats,
  pips,
  planSegments,
  pushFeedItem,
  turnsLeft,
} from '../hooks/lib/model'

const T0 = 1_000_000

function task(fields: Partial<Task> & Pick<Task, 'id'>): Task {
  return newTask({ title: fields.id, ...fields }, T0)
}

describe('observer JSON', () => {
  test('a fenced diff with prose around it parses', () => {
    const diff = parseDiff('Here you go:\n```json\n{"add":[{"title":"Write tests"}],"update":[],"complete":["a"],"merge":[]}\n```')
    expect(diff?.add[0]?.title).toBe('Write tests')
    expect(diff?.complete).toEqual(['a'])
  })

  test('malformed replies are dropped', () => {
    expect(parseDiff('not json at all')).toBeUndefined()
    expect(parseDiff('{"add": [ {"title": "x"} ')).toBeUndefined()
    expect(parseDiff('{"foo": 1}')).toBeUndefined()
    expect(parseDiff('{"add": "nope"}')).toBeUndefined()
    expect(parseDiff('[1,2,3]')).toBeUndefined()
  })

  test('invalid entries are filtered, valid ones kept', () => {
    const diff = parseDiff('{"add":[{"nope":1},{"title":"ok","phase":"bogus","progress":7}],"update":[{"status":"done"},{"id":"a","status":"weird","phase":"editing"}]}')
    expect(diff?.add).toHaveLength(1)
    expect(diff?.add[0]?.phase).toBeUndefined()
    expect(diff?.add[0]?.progress).toBe(1)
    expect(diff?.update).toEqual([{ id: 'a', status: undefined, phase: 'editing', progress: undefined, note: undefined, title: undefined }])
  })
})

describe('diff application', () => {
  test('adds under the root, resolves temp parent ids, completes inferred tasks', () => {
    const list = [task({ id: 'r', status: 'running' })]
    const diff = parseDiff('{"add":[{"id":"s1","title":"Step one"},{"id":"s2","title":"Sub","parentId":"s1"}],"update":[],"complete":[],"merge":[]}')!
    const next = applyDiff(list, diff, T0 + 1, 'r')
    const one = next.find(t => t.title === 'Step one')!
    const sub = next.find(t => t.title === 'Sub')!
    expect(one.parentId).toBe('r')
    expect(sub.parentId).toBe(one.id)
    const done = applyDiff(next, { add: [], update: [], complete: [sub.id], merge: [] }, T0 + 2, 'r')
    expect(done.find(t => t.id === sub.id)?.status).toBe('done')
  })

  test('declared tasks keep their status and title', () => {
    const list = [task({ id: 'd1', source: 'declared', status: 'running', title: 'Mine' })]
    const next = applyDiff(list, { add: [], update: [{ id: 'd1', status: 'done', title: 'Theirs', phase: 'editing' }], complete: ['d1'], merge: [] }, T0, null)
    expect(next[0]?.status).toBe('running')
    expect(next[0]?.title).toBe('Mine')
    expect(next[0]?.phase).toBe('editing')
  })
})

describe('phase mapping', () => {
  test('tools map to phases', () => {
    expect(phaseOfTool('Read')).toBe('exploring')
    expect(phaseOfTool('TaskCreate')).toBe('planning')
    expect(phaseOfTool('Edit')).toBe('editing')
    expect(phaseOfTool('Bash', 'npm test')).toBe('verifying')
    expect(phaseOfTool('Bash', 'npx tsc -p .')).toBe('verifying')
    expect(phaseOfTool('Bash', 'git status')).toBe('exploring')
    expect(phaseOfTool('Bash', 'mkdir x')).toBeUndefined()
  })

  test('phase progress stays inside its range', () => {
    expect(phaseProgress('exploring')).toBe(0)
    expect(phaseProgress('editing')).toBe(0.3)
    expect(phaseProgress('editing', 0.9)).toBe(0.75)
    expect(phaseProgress('verifying', 0.8)).toBe(0.8)
    expect(phaseProgress('done')).toBe(1)
  })

  test('activity reads as plain language', () => {
    expect(describeCall('Edit', { file_path: '/a/b/auth.ts' })).toBe('Editing auth.ts')
    expect(describeCall('Bash', { command: 'npm test' })).toBe('Running tests')
  })
})

describe('progress', () => {
  test('never decreases unless re-scoped', () => {
    let list = settle([task({ id: 'r', phase: 'verifying' })])
    expect(list[0]?.progress).toBe(0.75)
    list = settle(list.map(t => ({ ...t, phase: 'exploring' as const })))
    expect(list[0]?.progress).toBe(0.75)
    list = settle(rescope(list, 'r', 'new scope'))
    expect(list[0]?.progress).toBe(0)
    expect(list[0]?.note).toContain('new scope')
  })

  test('declared subtasks outrank inferred ones and phase', () => {
    const list = settle([
      task({ id: 'r', phase: 'verifying' }),
      task({ id: 'd1', parentId: 'r', source: 'declared', status: 'done' }),
      task({ id: 'd2', parentId: 'r', source: 'declared' }),
      task({ id: 'i1', parentId: 'r', status: 'done' }),
      task({ id: 'i2', parentId: 'r', status: 'done' }),
    ])
    // Declared 1/2 wins over inferred 2/2 and over the verifying phase.
    expect(list.find(t => t.id === 'r')?.progress).toBe(0.5)
    const inferredOnly = settle([task({ id: 'r', phase: 'verifying' }), task({ id: 'i1', parentId: 'r', status: 'done' }), task({ id: 'i2', parentId: 'r' })])
    expect(inferredOnly.find(t => t.id === 'r')?.progress).toBe(0.5)
  })

  test('a bar already ahead stays there when the source drops', () => {
    const list = settle([task({ id: 'r', progress: 0.75 }), task({ id: 'd1', parentId: 'r', source: 'declared' })])
    expect(list.find(t => t.id === 'r')?.progress).toBe(0.75)
  })
})

describe('merge', () => {
  test('folds an inferred task into its declared twin', () => {
    const list = [
      task({ id: 'i1', tokens: 100, progress: 0.4 }),
      task({ id: 'kid', parentId: 'i1' }),
      task({ id: 'd1', source: 'declared', tokens: 50 }),
    ]
    const next = mergeTasks(list, 'i1', 'd1')
    expect(next.find(t => t.id === 'i1')).toBeUndefined()
    expect(next.find(t => t.id === 'd1')?.tokens).toBe(150)
    expect(next.find(t => t.id === 'd1')?.progress).toBe(0.4)
    expect(next.find(t => t.id === 'kid')?.parentId).toBe('d1')
  })

  test('refuses to merge the wrong way round', () => {
    const list = [task({ id: 'i1' }), task({ id: 'd1', source: 'declared' })]
    expect(mergeTasks(list, 'd1', 'i1')).toHaveLength(2)
  })
})

describe('spin loops', () => {
  test('warns from the third failure and clears on success', () => {
    let a: Attempts = {}
    let r = recordAttempt(a, 'Bash:npm test', true)
    r = recordAttempt(r.attempts, 'Bash:npm test', true)
    expect(r.warning).toBeUndefined()
    r = recordAttempt(r.attempts, 'Bash:npm test', true)
    expect(r.warning).toBe('Claude has retried this 3 times')
    r = recordAttempt(r.attempts, 'Bash:npm test', true)
    expect(r.warning).toBe('Claude has retried this 4 times')
    r = recordAttempt(r.attempts, 'Bash:npm test', false)
    expect(r.warning).toBeUndefined()
    expect(r.attempts['Bash:npm test']).toBeUndefined()
    a = r.attempts
    expect(a).toEqual({})
  })

  test('the same edit repeated counts as a retry', () => {
    let r = recordAttempt({}, 'Edit:/x.ts:foo', false)
    r = recordAttempt(r.attempts, 'Edit:/x.ts:foo', false)
    r = recordAttempt(r.attempts, 'Edit:/x.ts:foo', false)
    expect(r.count).toBe(3)
  })
})

describe('decisions', () => {
  test('parse from the observer diff, then update by title', () => {
    const diff = parseDiff(
      '{"decisions":[{"title":"Approach","chosen":"patch handler","rejected":[{"option":"rewrite engine","reason":"too broad"}],"confidence":0.75,"reversible":true}]}',
    )!
    let list = applyDecisions([], diff.decisions ?? [], T0)
    expect(list).toHaveLength(1)
    expect(list[0]?.rejected[0]?.reason).toBe('too broad')
    list = applyDecisions(list, [{ title: 'approach', confidence: 1 }], T0 + 5)
    expect(list).toHaveLength(1)
    expect(list[0]?.confidence).toBe(1)
    expect(list[0]?.chosen).toBe('patch handler')
    expect(list[0]?.at).toBe(T0)
  })

  test('a decision without a title is dropped', () => {
    expect(parseDiff('{"decisions":[{"chosen":"x"}]}')?.decisions).toEqual([])
  })

  test('a prompt answers the pending ones', () => {
    const list = applyDecisions([], [{ title: 'Throttle', isPending: true, options: ['keep', 'drop'], lean: 'keep' }], T0)
    const answered = answerPending(list, 'drop it\nand more')
    expect(answered[0]?.isPending).toBe(false)
    expect(answered[0]?.chosen).toBe('you: drop it')
  })
})

describe('activity and diffs', () => {
  test('a structured patch counts first, then the git diff, then the strings', () => {
    expect(patchStats({ structuredPatch: [{ lines: ['-a', '+b', '+c', ' d'] }] })).toEqual({ added: 2, removed: 1 })
    expect(patchStats({ structuredPatch: [], gitDiff: { additions: 3, deletions: 1 } })).toEqual({ added: 3, removed: 1 })
    expect(patchStats({ structuredPatch: [] }, { old_string: 'keep\nold', new_string: 'keep\nnew\nmore' })).toEqual({ added: 2, removed: 1 })
    expect(patchStats({ structuredPatch: [], originalFile: 'a\nb', content: 'a\nc' })).toEqual({ added: 1, removed: 1 })
    expect(patchStats({ structuredPatch: [], originalFile: null }, { content: 'x\ny\nz' })).toEqual({ added: 3, removed: 0 })
    expect(lineDelta('', '')).toEqual({ added: 0, removed: 0 })
  })

  test('lines read as the design spells them', () => {
    expect(feedLine('Edit', { file_path: '/p/src/render/resize.ts' }, '/p')).toBe('Edit src/render/resize.ts')
    expect(feedLine('Grep', { pattern: 'onResize' })).toBe('Grep "onResize"')
    expect(feedLine('Bash', { command: 'npm test' })).toBe('Tests npm test')
    expect(feedLine('Bash', { command: 'ls  -la' })).toBe('$ ls -la')
    expect(callDetail('Grep', {}, undefined, 'Found 14 files\na\nb', false)).toBe('14 hits')
    expect(callDetail('Edit', { old_string: 'a', new_string: 'b\nc' }, { structuredPatch: [] }, undefined, false)).toBe('+2 −1')
    expect(callDetail('Read', {}, { file: { numLines: 40 } }, undefined, false)).toBe('40 lines')
    expect(callDetail('Bash', {}, undefined, 'boom', true)).toBe('failed')
  })

  test('a repeated line folds into the last one with a count', () => {
    type Line = { id: string; text: string; agentId?: string; count?: number }
    let list = pushFeedItem<Line>([], { id: '1', text: 'tsc -p .' }, 20)
    list = pushFeedItem(list, { id: '2', text: 'tsc -p .' }, 20)
    list = pushFeedItem(list, { id: '3', text: 'tsc -p .' }, 20)
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe('3')
    expect(list[0]?.count).toBe(3)
    list = pushFeedItem(list, { id: '4', text: 'tsc -p .', agentId: 'a' }, 20)
    expect(list).toHaveLength(2)
  })
})

describe('drawing math', () => {
  test('heatmap cells fill by category in order', () => {
    const cells = heatCells({ window: 100, system: 10, tools: 5, chat: 20, files: 5 }, 100)
    expect(cells.filter(c => c === 'system')).toHaveLength(10)
    expect(cells[10]).toBe('tools')
    expect(cells.filter(c => c === 'empty')).toHaveLength(60)
  })

  test('cache is hot, then warm under a minute, then cold', () => {
    expect(cacheState(0, 300_000, 100_000).state).toBe('hot')
    expect(cacheState(0, 300_000, 250_000).state).toBe('warm')
    expect(cacheState(0, 300_000, 300_000).state).toBe('cold')
    expect(cacheState(null, 300_000, 5).state).toBe('cold')
  })

  test('plan percent is done steps plus the current fraction', () => {
    const p = planSegments([
      { status: 'done', progress: 1 },
      { status: 'done', progress: 1 },
      { status: 'running', progress: 0.5 },
      { status: 'pending', progress: 0 },
    ])
    expect(p.current).toBe(2)
    expect(p.percent).toBe(0.625)
  })

  test('turns left divide the room before compaction by the average', () => {
    expect(turnsLeft({ used: 200_000, window: 1_000_000, threshold: 800_000, perTurn: [6000, 6000] }).left).toBe(100)
    expect(turnsLeft({ used: 0, window: 10, perTurn: [] }).left).toBeUndefined()
  })

  test('lines truncate with an ellipsis', () => {
    expect(fit('abcdef', 4)).toBe('abc…')
    expect(fit('abc', 4)).toBe('abc')
    expect(pips(0.75)).toBe('▰▰▰▱')
  })
})
