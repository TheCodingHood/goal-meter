import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { PrCheck } from '../types'
import { judge, mergeArgs } from './finish'
import type { Facts, Judging } from './finish'

const NOW = Date.parse('2026-11-01T21:10:00Z')
const EARLIER = '2026-11-01T20:00:00Z'
const URL = 'https://github.com/octo-org/octo-app/pull/1305'
const ARCHIVE = 'mcp__ccd_session_mgmt__archive_session'
const BUTTON = 'pr-finish-octo-org/octo-app#1305'

const PANE = {
  plugin: 'goal-meter',
  component: 'Pane',
  requestId: 'goal-meter',
  props: { title: 'Goal meter', isFocused: false, bodyColumns: 60 },
} as const

// --- the verdict, rule by rule ---------------------------------------------------------

const check = (name: string, state: PrCheck['state'], completedAt: string | null = EARLIER): PrCheck => ({
  name,
  workflow: 'CI',
  state,
  startedAt: EARLIER,
  completedAt,
  url: null,
})

const facts = (extra: Partial<Facts> = {}): Facts => ({
  isDraft: false,
  createdAt: Date.parse(EARLIER),
  base: 'main',
  defaultBranch: 'main',
  title: 'feat(search): add filters',
  labels: [],
  merge: 'CLEAN',
  review: 'APPROVED',
  headSha: 'aaaaaaa1',
  checks: [check('test', 'pass')],
  children: [],
  threads: 0,
  botComment: null,
  usesBot: false,
  isDirty: false,
  localHead: 'aaaaaaa1',
  hasWorkflows: true,
  ...extra,
})

const at: Judging = { now: NOW, armedAt: NOW, isSquash: true, skipReview: false, skipChecks: false }

describe('fertig: the verdict', () => {
  test('green, reviewed, settled and clean: ready', () => {
    expect(judge(facts(), at)).toEqual({ kind: 'ready' })
  })

  test('every stop reason is named, all at once', () => {
    const v = judge(
      facts({ isDraft: true, base: 'develop', title: 'Add filters', children: [1306], isDirty: true, localHead: 'b', checks: [check('test', 'fail')] }),
      at,
    )
    expect(v).toEqual({
      kind: 'stop',
      why: [
        'Draft',
        'Basis ist develop, nicht main',
        'PR-Titel nicht Conventional, er wird zum Changelog-Eintrag',
        'Folge-PR #1306 zeigt auf diesen Branch',
        'nicht committete Änderungen im Worktree',
        'lokaler HEAD weicht vom PR ab',
        'test fehlgeschlagen',
      ],
    })
    // A merge commit keeps the title out of the changelog.
    expect(judge(facts({ title: 'Add filters' }), { ...at, isSquash: false })).toEqual({ kind: 'ready' })
  })

  test('a release PR merges only through the release task', () => {
    expect(judge(facts({ labels: ['autorelease: pending'] }), at)).toEqual({ kind: 'stop', why: ['Release-PR, mergt nur über task release-prod'] })
  })

  test('waits for running checks, for missing ones a while, and for the settle time', () => {
    expect(judge(facts({ checks: [check('test', 'running', null)] }), at)).toEqual({ kind: 'wait', why: 'Checks laufen' })
    expect(judge(facts({ checks: [] }), at)).toEqual({ kind: 'wait', why: 'noch keine Checks für diesen Commit' })
    expect(judge(facts({ checks: [] }), { ...at, now: NOW + 121_000 }).kind).toBe('stop')
    expect(judge(facts({ checks: [] }), { ...at, skipChecks: true })).toEqual({ kind: 'ready' })
    const justDone = new Date(NOW - 10_000).toISOString()
    expect(judge(facts({ checks: [check('test', 'pass', justDone)] }), at)).toEqual({ kind: 'wait', why: 'letzter Check gerade fertig' })
    expect(judge(facts({ merge: 'UNKNOWN' }), at)).toEqual({ kind: 'wait', why: 'GitHub berechnet den Merge-Status' })
    expect(judge(facts({ merge: 'BLOCKED' }), at)).toEqual({ kind: 'stop', why: ['Merge-Status BLOCKED'] })
  })

  test('the review stops apart, and --ohne-review passes it', () => {
    const v = judge(facts({ review: 'CHANGES_REQUESTED', threads: 2 }), at)
    expect(v).toEqual({ kind: 'stop', why: ['Änderungen gewünscht', '2 offene Review-Threads'], isReview: true })
    expect(judge(facts({ review: 'CHANGES_REQUESTED' }), { ...at, skipReview: true })).toEqual({ kind: 'ready' })
    expect(judge(facts({ checks: [check('test', 'pass'), check('CodeRabbit', 'running', null)] }), at)).toEqual({ kind: 'wait', why: 'CodeRabbit läuft' })
    expect(judge(facts({ botComment: '## Review skipped' }), at)).toEqual({ kind: 'stop', why: ['CodeRabbit-Review übersprungen'], isReview: true })
  })

  test('the merge command: squash with ticket lines, or a merge commit', () => {
    const pr = { number: 1305, title: 'feat(search): add filters', url: URL, body: 'Text\nFixes ABC-12 filters\nmore' }
    expect(mergeArgs(pr, 'aaaaaaa1', [])).toEqual([
      'pr', 'merge', '1305', '--repo', 'octo-org/octo-app', '--squash', '--match-head-commit', 'aaaaaaa1',
      '--subject', 'feat(search): add filters (#1305)', '--body', 'Fixes ABC-12 filters',
    ])
    expect(mergeArgs(pr, 'aaaaaaa1', ['octo-org/octo-app'])).toEqual([
      'pr', 'merge', '1305', '--repo', 'octo-org/octo-app', '--merge', '--match-head-commit', 'aaaaaaa1',
    ])
  })
})

// --- the job, against a GitHub and a git that answer as told ----------------------------

const pr = (sha: string, extra: Record<string, unknown> = {}, isRunning = false) => ({
  number: 1305,
  title: 'feat(search): add filters',
  url: URL,
  state: 'OPEN',
  isDraft: false,
  reviewDecision: 'APPROVED',
  mergeStateStatus: 'CLEAN',
  headRefOid: sha,
  headRefName: 'feat/filters',
  baseRefName: 'main',
  createdAt: EARLIER,
  labels: [],
  body: 'Fixes ABC-12',
  comments: [],
  statusCheckRollup: [
    {
      __typename: 'CheckRun',
      name: 'test',
      workflowName: 'CI',
      status: isRunning ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion: isRunning ? '' : 'SUCCESS',
      startedAt: EARLIER,
      completedAt: isRunning ? '0001-01-01T00:00:00Z' : EARLIER,
      detailsUrl: 'https://github.com/octo-org/octo-app/actions/runs/1',
    },
  ],
  ...extra,
})

function world(on: On) {
  const w = {
    pr: pr('aaaaaaa1') as Record<string, unknown> | null,
    localHead: 'aaaaaaa1',
    isDirty: false,
    merges: [] as string[][],
    archived: [] as unknown[],
    toasts: [] as string[],
    /** rev-parse's top level and common dir: a worktree when they differ. */
    tree: ['/repo', '/repo/.git'],
    sessions: [] as { cwd: string; isRunning: boolean }[] | string,
    hasTaskfile: false,
    runs: [] as { argv: string[]; cwd?: string }[],
  }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {})
  const ok = (stdout: unknown) => ({
    value: { exitCode: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  const fail = { value: { exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false } }
  on('process.run', (_, e) => {
    w.runs.push({ argv: [...e.argv], cwd: e.init?.cwd })
    const [bin = '', a = '', b = '', ...rest] = e.argv
    if (bin === 'grep') return w.hasTaskfile ? ok('') : fail
    if (bin === 'git') {
      if (a === 'status') return ok(w.isDirty ? ' M hooks/x.ts\n' : '')
      if (a === 'rev-parse' && b === 'HEAD') return ok(`${w.localHead}\n`)
      if (a === 'rev-parse') return ok(`${w.tree.join('\n')}\n`)
      return ok('')
    }
    if (a === 'pr' && b === 'view') return w.pr === null ? fail : ok(w.pr)
    if (a === 'pr' && b === 'list') return ok([])
    if (a === 'api' && b === 'graphql') return ok({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } })
    if (a === 'api' && b.endsWith('/actions/workflows')) return ok({ total_count: 1 })
    if (a === 'api') return ok({ default_branch: 'main' })
    if (a === 'pr' && b === 'merge') {
      w.merges.push([a, b, ...rest])
      if (w.pr !== null) w.pr = { ...w.pr, state: 'MERGED' }
      return ok('')
    }
    return ok('')
  })
  on('session.root', () => ({ value: '/repo' }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('mcp.call', () =>
    ({ value: { content: [{ type: 'text', text: typeof w.sessions === 'string' ? w.sessions : JSON.stringify(w.sessions) }] } }) as never)
  on('ui.toast', (_, e) => (w.toasts.push((e as { text: string }).text), { value: undefined }) as never)
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }) as never)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__goal-meter__${(e as { name: string }).name}` } }) as never)
  on('command.register', (_, e) => ({ value: { command: (e as { name: string }).name } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('tool.call', (_, e) => {
    if ((e as { tool: string }).tool === ARCHIVE) w.archived.push(e)
    const made = ((e as { command?: string }).command ?? '').includes('gh pr create') ? `Creating pull request\n${URL}\n` : 'ok'
    return { result: { stdout: made, stderr: '', interrupted: false }, text: made } as never
  })
  return { w, clock }
}

type T = Parameters<TestBody>[0]

const begin = async ($: T) => {
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' } as never)
}

const fertig = async ($: T, args = '', kind = 'composer') =>
  (await $.command.run({ command: 'fertig', args, origin: { kind } } as never)).text ?? ''

/** The pane's texts and the Fertig button's label. */
const look = async ($: T) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const buttons = (await ui.findAll({ type: 'Button' })).map(b => String(b.props.label))
  await ui.unmount()
  return { texts, buttons }
}

const press = async ($: T) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never)
  await ui.press({ key: BUTTON })
  await ui.unmount()
}

describe('fertig: in the session', () => {
  test('only the person starts it, and a typo merges nothing', async ($, on) => {
    const { w } = world(on)
    await begin($)
    expect(await fertig($, '', 'model')).toBe('/fertig startet nur auf deine Eingabe.')
    expect(await fertig($, 'jetzt')).toContain('Unbekannt: jetzt.')
    expect(await fertig($, 'stop')).toBe('Nichts abzubrechen.')
    expect(w.merges).toEqual([])
  })

  test('--dry-run says the verdict and the exact merge command, and changes nothing', async ($, on) => {
    const { w } = world(on)
    await begin($)
    const said = await fertig($, '--dry-run')
    expect(said).toContain('PR #1305 (OPEN, Probelauf, nichts wurde geändert): wird gemergt')
    expect(said).toContain('Merge: gh pr merge 1305 --repo octo-org/octo-app --squash --match-head-commit aaaaaaa1')
    expect(w.merges).toEqual([])
    expect((await look($)).buttons).toContain('Fertig')
  })

  test('a repository named in the settings gets a merge commit', { options: { mergeCommitRepos: 'octo-org/octo-app' } }, async ($, on) => {
    world(on)
    await begin($)
    expect(await fertig($, '--dry-run')).toContain('Merge: gh pr merge 1305 --repo octo-org/octo-app --merge --match-head-commit aaaaaaa1')
  })

  test('the button asks once, then merges, cleans up and archives the session', async ($, on) => {
    const { w, clock } = world(on)
    await begin($)
    expect((await look($)).buttons).toContain('Fertig')

    await press($)
    expect((await look($)).buttons).toContain('Wirklich mergen?')
    expect(w.merges).toEqual([])

    await press($)
    expect(w.toasts).toContain('PR #1305: /fertig wird gemergt')
    await clock.advance(1)
    await clock.advance(1)

    expect(w.merges).toEqual([
      ['pr', 'merge', '1305', '--repo', 'octo-org/octo-app', '--squash', '--match-head-commit', 'aaaaaaa1', '--subject', 'feat(search): add filters (#1305)', '--body', 'Fixes ABC-12'],
    ])
    expect(w.archived).toHaveLength(1)
    expect(w.toasts).toContain('PR #1305 · gemergt und aufgeräumt')
    const after = await look($)
    expect(after.texts).toContain('/fertig: gemergt und aufgeräumt')
    expect(after.buttons).not.toContain('Fertig')
  })

  test('a first press does not outlive a reload: one press after it only asks', async ($, on) => {
    const { w } = world(on)
    await begin($)
    await press($)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
    expect((await look($)).buttons).toContain('Fertig')
    await press($)
    expect((await look($)).buttons).toContain('Wirklich mergen?')
    expect(w.merges).toEqual([])
  })

  test('in a worktree another running session keeps it: merged, nothing torn down, not archived', async ($, on) => {
    const { w, clock } = world(on)
    w.tree = ['/wt', '/main/.git']
    w.sessions = [{ cwd: '/wt', isRunning: true }]
    w.hasTaskfile = true
    await begin($)
    await fertig($)
    await clock.advance(1)
    await clock.advance(1)
    expect(w.merges).toHaveLength(1)
    expect((await look($)).texts).toContain('/fertig gestoppt: gemergt, eine andere Sitzung arbeitet im Worktree, nichts aufgeräumt')
    expect(w.runs.some(r => r.argv[0]?.endsWith('task') && r.argv[1] === 'worktree-destroy')).toBe(false)
    expect(w.archived).toEqual([])
  })

  test('in a worktree an unreadable session list keeps it, as a busy one would', async ($, on) => {
    const { w, clock } = world(on)
    w.tree = ['/wt', '/main/.git']
    w.sessions = 'Error: result exceeds maximum allowed tokens'
    w.hasTaskfile = true
    await begin($)
    await fertig($)
    await clock.advance(1)
    await clock.advance(1)
    expect((await look($)).texts.some(t => t.startsWith('/fertig gestoppt: gemergt, Sitzungsliste nicht lesbar, nichts aufgeräumt'))).toBe(true)
    expect(w.runs.some(r => r.argv[1] === 'worktree-destroy')).toBe(false)
    expect(w.archived).toEqual([])
  })

  test('in a worktree alone it runs task worktree-destroy in the session root, then archives', async ($, on) => {
    const { w, clock } = world(on)
    w.tree = ['/wt', '/main/.git']
    w.hasTaskfile = true
    await begin($)
    await fertig($)
    await clock.advance(1)
    await clock.advance(1)
    const destroy = w.runs.find(r => r.argv[1] === 'worktree-destroy')
    expect(destroy?.argv[0]).toBe('task')
    expect(destroy?.cwd).toBe('/repo')
    expect(w.archived).toHaveLength(1)
    expect((await look($)).texts).toContain('/fertig: gemergt und aufgeräumt')
  })

  test('the first press expires after five seconds', async ($, on) => {
    const { w, clock } = world(on)
    await begin($)
    await press($)
    await clock.advance(5_000)
    expect((await look($)).buttons).toContain('Fertig')
    await press($)
    expect(w.merges).toEqual([])
  })

  test('armed while checks run it waits, Stopp calls it off', async ($, on) => {
    const { w, clock } = world(on)
    w.pr = pr('aaaaaaa1', {}, true)
    await begin($)
    expect(await fertig($)).toBe('PR #1305: /fertig wartet: Checks laufen')
    await clock.advance(1)
    const waiting = await look($)
    expect(waiting.texts).toContain('/fertig wartet: Checks laufen')
    expect(waiting.buttons).toContain('Stopp')

    await press($)
    expect(w.toasts).toContain('PR #1305: /fertig abgebrochen.')
    const off = await look($)
    expect(off.texts.some(t => t.startsWith('/fertig'))).toBe(false)
    expect(off.buttons).toContain('Fertig')
    expect(w.merges).toEqual([])
  })

  test('a new commit while it waits stops it', async ($, on) => {
    const { w, clock } = world(on)
    w.pr = pr('aaaaaaa1', {}, true)
    await begin($)
    await fertig($)
    await clock.advance(1)
    w.pr = pr('bbbbbbb2', {}, true)
    w.localHead = 'bbbbbbb2'
    await clock.advance(30_000)
    await clock.advance(1)
    expect((await look($)).texts).toContain('/fertig gestoppt: neuer Commit bbbbbbb')
    expect(w.toasts).toContain('PR #1305 · neuer Commit bbbbbbb, /fertig abgebrochen')
    expect(w.merges).toEqual([])
  })

  test('uncommitted changes stop it before the merge', async ($, on) => {
    const { w, clock } = world(on)
    w.isDirty = true
    await begin($)
    expect(await fertig($)).toBe('PR #1305: /fertig gestoppt: nicht committete Änderungen im Worktree')
    await clock.advance(1)
    expect((await look($)).texts).toContain('/fertig gestoppt: nicht committete Änderungen im Worktree')
    expect(w.merges).toEqual([])
  })
})
