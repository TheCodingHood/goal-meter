import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { Pr } from '../types'
import { focusOf, mergePrs, openByUrgency } from './pr'
import { prMeta, prState } from './views'

const NOW = Date.parse('2026-11-01T21:10:00Z')
const REPO = 'https://github.com/octo-org/octo-app/pull/'
const OTHER = 'https://github.com/octo-org/evenstep/pull/'
const RUN = 'https://github.com/octo-org/octo-app/actions/runs/1/job/'

const PANE = {
  plugin: 'goal-meter',
  component: 'Pane',
  requestId: 'goal-meter',
  props: { title: 'Goal meter', isFocused: false, bodyColumns: 60 },
} as const

type Run = { name: string; workflow: string; status: string; conclusion: string }
const run = (name: string, workflow = 'CI', status = 'COMPLETED', conclusion = 'SUCCESS'): Run => ({ name, workflow, status, conclusion })

const raw = (url: string, sha: string, runs: Run[], extra: Record<string, unknown> = {}) => ({
  number: Number(url.split('/').at(-1)),
  title: 'feat(search): add filters',
  url,
  state: 'OPEN',
  isDraft: false,
  reviewDecision: 'REVIEW_REQUIRED',
  mergeStateStatus: 'BLOCKED',
  headRefOid: sha,
  headRefName: 'feat/filters',
  baseRefName: 'main',
  statusCheckRollup: runs.map((r, i) => ({
    __typename: 'CheckRun',
    name: r.name,
    workflowName: r.workflow,
    status: r.status,
    conclusion: r.status === 'COMPLETED' ? r.conclusion : '',
    startedAt: '2026-11-01T21:08:00Z',
    completedAt: r.status === 'COMPLETED' ? '2026-11-01T21:09:05Z' : '0001-01-01T00:00:00Z',
    detailsUrl: `${RUN}${i}`,
  })),
  ...extra,
})

const RUNNING = (url = `${REPO}1305`) => raw(url, 'aaaaaaa1', [run('lint'), run('types'), run('test', 'CI', 'IN_PROGRESS'), run('build', 'CI', 'QUEUED')])
const RED = (url = `${REPO}1305`) => raw(url, 'aaaaaaa1', [run('lint'), run('types'), run('test', 'CI', 'COMPLETED', 'FAILURE'), run('build')])
const GREEN = (url = `${REPO}1305`) =>
  raw(url, 'aaaaaaa1', [run('lint'), run('types'), run('test'), run('build')], { reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' })

// GitHub as `gh pr view` answers it: `prs` by URL, `branch` the URL the branch's PR has.
function github(on: On) {
  const world: { prs: Record<string, unknown>; branch: string | null; views: number; hasGh: boolean } = {
    prs: {},
    branch: null,
    views: 0,
    hasGh: true,
  }
  mock.clock(on, { now: NOW })
  mock.store(on, {})
  on('process.run', (_, e) => {
    if (!world.hasGh) throw new Error('ENOENT')
    const isView = e.argv[1] === 'pr' && e.argv[2] === 'view'
    if (isView) world.views += 1
    const url = isView ? (e.argv[3] === '--json' ? world.branch : e.argv[3]) : null
    const found = url ? world.prs[url] : undefined
    return {
      value: {
        exitCode: !isView || found !== undefined ? 0 : 1,
        stdout: found !== undefined ? JSON.stringify(found) : '',
        stderr: found !== undefined || !isView ? '' : 'no pull requests found',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__goal-meter__${(e as { name: string }).name}` } }) as never)
  on('command.register', () => ({ value: { command: 'goal-meter' } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('tool.call', (_, e) => {
    const command = (e as { command?: string }).command ?? ''
    const made = command.includes('gh pr create') ? `Creating pull request\n${world.branch}\n` : 'ok'
    return { result: { stdout: made, stderr: '', interrupted: false }, text: made } as never
  })
  return world
}

const start = ($: Parameters<TestBody>[0]) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)

const desktop = async ($: Parameters<TestBody>[0]) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never)
  const svgs = await ui.findAll({ type: 'Svg' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  return { ui, alts: svgs.map(s => String(s.props.alt)), heights: svgs.map(s => Number(s.props.height)), texts }
}

const terminal = async ($: Parameters<TestBody>[0]) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  return texts
}

describe('prs: pure helpers', () => {
  const pr = (n: number, extra: Partial<Pr> = {}): Pr => ({
    number: n,
    title: 't',
    url: `${REPO}${n}`,
    repo: 'octo-org/octo-app',
    state: 'OPEN',
    isDraft: false,
    review: '',
    merge: '',
    headSha: 's',
    head: 'h',
    base: 'main',
    checks: [],
    phase: 'done',
    ...extra,
  })
  const fail = { name: 'test', workflow: 'CI', state: 'fail' as const, startedAt: null, completedAt: null, url: null }

  test('the most urgent open PR comes first, closed ones drop out', () => {
    const list = [pr(1), pr(2, { phase: 'running' }), pr(3, { checks: [fail] }), pr(4, { state: 'MERGED', phase: 'closed' })]
    expect(openByUrgency(list).map(p => p.number)).toEqual([3, 2, 1])
    expect(focusOf(list, null)).toBe(`${REPO}3`)
    expect(focusOf(list, `${REPO}1`)).toBe(`${REPO}1`)
    expect(focusOf(list, '')).toBe(null)
    // A pick of a PR that closed falls back to the most urgent one.
    expect(focusOf(list, `${REPO}4`)).toBe(`${REPO}3`)
    // All green: nothing opens by itself.
    expect(focusOf([pr(1), pr(2)], null)).toBe(null)
  })

  test('over five PRs the oldest closed one goes first', () => {
    const list = [pr(1, { state: 'OPEN' }), pr(2, { state: 'MERGED' }), pr(3), pr(4), pr(5)]
    expect(mergePrs(list, [pr(6)]).map(p => p.number)).toEqual([1, 3, 4, 5, 6])
    expect(mergePrs([pr(1), pr(2), pr(3), pr(4), pr(5)], [pr(6)]).map(p => p.number)).toEqual([2, 3, 4, 5, 6])
    // A poll updates a known PR in place.
    expect(mergePrs([pr(1), pr(2)], [pr(1, { title: 'new' })]).map(p => p.title)).toEqual(['new', 't'])
  })

  test('word and meta of a row', () => {
    expect(prState(pr(1)).word).toBe('keine Checks')
    // GitHub calls a PR without required checks CLEAN: that is no green.
    expect(prState(pr(1, { merge: 'CLEAN', review: 'APPROVED' })).word).toBe('keine Checks')
    const pass = { name: 'test', workflow: 'CI', state: 'pass' as const, startedAt: null, completedAt: null, url: null }
    expect(prState(pr(1, { merge: 'CLEAN', review: 'APPROVED', checks: [pass] })).word).toBe('bereit zum Merge')
    expect(prState(pr(1, { checks: [fail] })).word).toBe('test fehlgeschlagen')
    expect(prState(pr(1, { state: 'MERGED' })).word).toBe('gemergt')
    expect(prMeta(pr(1, { checks: [fail], review: 'APPROVED' }))).toBe('0/1 grün · Review ok')
    expect(prMeta(pr(1, { state: 'MERGED', head: 'feat/x' }))).toBe('feat/x → main')
  })
})

describe('prs: in the pane', () => {
  test('no PR on the branch, or no gh: no PR block at all', async ($, on) => {
    const world = github(on)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
    const { ui, texts } = await desktop($)
    expect(texts.some(t => t.startsWith('PR'))).toBe(false)
    await ui.unmount()

    world.hasGh = false
    await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
    expect((await terminal($)).some(t => t.startsWith('PR'))).toBe(false)
  })

  test('gh pr create shows the PR with its running checks, a red check is named', async ($, on) => {
    const world = github(on)
    world.branch = `${REPO}1305`
    world.prs[world.branch] = RUNNING()
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' } as never)

    const running = await desktop($)
    expect(running.texts).toContain('PR · läuft')
    expect(running.alts).toContain('#1305 feat(search): add filters: Checks laufen, 2/4 Checks · Review offen')
    expect(running.texts.some(t => t.startsWith('vor ') && t.endsWith('alle 30 s'))).toBe(true)
    await running.ui.unmount()

    expect(await terminal($)).toEqual(expect.arrayContaining(['PR · läuft', '#1305 ', 'Checks laufen']))

    world.prs[world.branch] = RED()
    await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
    const red = await desktop($)
    expect(red.alts.some(a => a.startsWith('#1305 feat(search): add filters: test fehlgeschlagen, 3/4 grün'))).toBe(true)
    await red.ui.unmount()
  })

  test('a push keeps the old head waiting, a merge folds the PR away', async ($, on) => {
    const world = github(on)
    world.branch = `${REPO}1305`
    world.prs[world.branch] = GREEN()
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' } as never)
    const green = await desktop($)
    expect(green.alts).toContain('#1305 feat(search): add filters: bereit zum Merge, alle 4 grün · Review ok')
    await green.ui.unmount()

    await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' } as never)
    const waiting = await desktop($)
    expect(waiting.alts.some(a => a.startsWith('#1305 feat(search): add filters: warte auf Checks'))).toBe(true)
    await waiting.ui.unmount()

    world.prs[world.branch] = { ...GREEN(), state: 'MERGED' }
    await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
    const merged = await desktop($)
    expect(merged.alts.some(a => a.startsWith('#1305'))).toBe(false)
    expect(merged.texts.some(t => t.endsWith('· gestoppt'))).toBe(true)
    const labels = (await merged.ui.findAll({ type: 'Button' })).map(b => String(b.props.label))
    expect(labels).toContain('▸ Gemergt · 1')
    await merged.ui.press({ key: 'done-prs' })
    await merged.ui.unmount()
    const unfolded = await desktop($)
    expect(unfolded.alts.some(a => a.startsWith('#1305 feat(search): add filters: gemergt'))).toBe(true)
    await unfolded.ui.unmount()
  })

  test('three PRs: sorted by urgency, only the red one shows its checks, a press moves them', async ($, on) => {
    const world = github(on)
    await start($)
    for (const [url, pr] of [
      [`${REPO}142`, GREEN(`${REPO}142`)],
      [`${REPO}143`, RUNNING(`${REPO}143`)],
      [`${OTHER}88`, RED(`${OTHER}88`)],
    ] as const) {
      world.branch = url
      world.prs[url] = pr
      await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' } as never)
    }

    const first = await desktop($)
    expect(first.texts).toContain('PRs · 3 offen · 1 rot · 1 läuft')
    const prAlts = first.alts.filter(a => a.includes('feat(search)'))
    expect(prAlts.map(a => a.split(' ')[0])).toEqual(['evenstep#88', '#143', '#142'])
    const height = (label: string, d: { alts: string[]; heights: number[] }) => d.heights[d.alts.findIndex(a => a.startsWith(label))]
    // The red one carries its four check lines; the running one only its bar.
    expect(height('evenstep#88', first)).toBeGreaterThan(height('#143', first) ?? 0)

    await first.ui.press({ key: 'pr-checks-octo-org/octo-app#143' })
    await first.ui.unmount()
    const moved = await desktop($)
    expect(height('#143', moved)).toBeGreaterThan(height('evenstep#88', moved) ?? 0)
    // Folding leaves no checks open...
    await moved.ui.press({ key: 'pr-checks-octo-org/octo-app#143' })
    await moved.ui.unmount()
    const folded = await desktop($)
    expect(folded.heights.every((h, i) => !folded.alts[i]?.includes('feat(search)') || h <= 72)).toBe(true)
    await folded.ui.unmount()
    // ...until a PR turns red: then its checks show again.
    world.prs[`${REPO}142`] = RED(`${REPO}142`)
    await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
    const red = await desktop($)
    expect(height('#142', red)).toBeGreaterThan(72)
    await red.ui.unmount()
  })
})

const BAND = {
  plugin: 'goal-meter',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

describe('prs: the band above the prompt', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`one row per open PR, the pane icon, and × hides it until the next commit, on ${surface}`, async ($, on) => {
      const world = github(on)
      // The engine beneath: its own band, which the mod keeps below its rows.
      on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
        const { Text } = $$.ui.resolve(e)
        return <Text>engine band</Text>
      })
      const band = async () => {
        const ui = await $.ui.mount({ ...BAND, surface } as never)
        const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
        const buttons = (await ui.findAll({ type: 'Button' })).map(b => String(b.props.label))
        return { ui, texts, buttons }
      }

      await start($)
      const none = await band()
      expect(none.texts).toEqual(['engine band'])
      await none.ui.unmount()

      world.branch = `${REPO}1305`
      world.prs[world.branch] = RUNNING()
      await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' } as never)
      const shown = await band()
      expect(shown.texts).toEqual(expect.arrayContaining(['Checks laufen', '2/4 Checks · Review offen', 'engine band']))
      expect(shown.buttons).toEqual(['Fertig', '◨', '×'])
      await shown.ui.press({ key: 'band-hide-octo-org/octo-app#1305' })
      await shown.ui.unmount()

      const hidden = await band()
      expect(hidden.texts).toEqual(['engine band'])
      await hidden.ui.unmount()

      // A new commit brings the row back.
      world.prs[world.branch] = { ...RUNNING(), headRefOid: 'bbbbbbb2' }
      await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
      const back = await band()
      expect(back.texts).toContain('engine band')
      expect(back.buttons).toContain('Fertig')
      await back.ui.unmount()
    })
  }
})
