import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { classify, keyOf, median, runFraction } from './tasks'

const GATE = 'mcp__goal-meter__gate'
const PANE = {
  plugin: 'goal-meter',
  component: 'Pane',
  requestId: 'goal-meter',
  props: { title: 'Goal meter', isFocused: false, bodyColumns: 60 },
} as const

// The engine beneath the mod, as far as the tasks need it.
const engine = (on: On, now: number, stored: Record<string, unknown> = {}, ownStore = false) => {
  const clock = mock.clock(on, { now })
  if (!ownStore) mock.store(on, stored)
  const opened: string[] = []
  on('tool.register', (_, e) => ({ value: { tool: `mcp__goal-meter__${(e as { name: string }).name}` } }) as never)
  on('command.register', () => ({ value: { command: 'goal-meter' } }) as never)
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('session.usage', () => ({ value: { startedAt: now, context: { window: 200_000 }, rateLimits: [] } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  return { clock, opened }
}

const start = ($: { session: { start: (e: never) => Promise<unknown> } }) =>
  $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)

const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text)

describe('tasks: pure helpers', () => {
  test('keyOf, median, classify, runFraction', () => {
    expect(keyOf('rtk cd "/a b" && FOO=1 swift test   --package-path X')).toBe('swift test --package-path X')
    expect(median([5, 1, 3])).toBe(3)
    expect(median([])).toBe(undefined)
    expect(classify("Test Case '-[A b]' passed (0.1 seconds).")).toBe('pass')
    expect(classify("Test case 'S/t()' failed on 'iPhone 17' (0.1 seconds)")).toBe('fail')
    expect(classify('✔ Test foo() passed after 0.001 seconds.')).toBe('pass')
    expect(classify('✔ Test run with 3 tests passed after 0.1 seconds.')).toBe(undefined)
    expect(classify("Test Case '-[A b]' started.")).toBe(undefined)
    expect(
      runFraction(
        {
          id: 'x',
          kind: 'bash',
          title: 't',
          status: 'running',
          startedAt: 0,
          etaMs: 10_000,
          steps: [{ name: 't', command: 't', status: 'running', startedAt: 0, etaMs: 10_000, passed: 0, failed: 0 }],
        },
        5_000,
      ),
    ).toBe(0.5)
  })
})

describe('tasks: in the pane', () => {
  test('a long Bash call shows under TASKS, a short one does not', async ($, on) => {
    const { clock } = engine(on, 1_000_000)
    on('tool.call', async (_, e) => {
      await clock.advance((e as { command: string }).command.startsWith('sleep') ? 5_000 : 200)
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    await start($)
    await $.tool.call({ tool: 'Bash', command: 'sleep 5', description: 'Long wait' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface } as never)
      const all = await texts(ui)
      expect(all).toContain(' TASKS ')
      expect(all).toContain('✔ ')
      expect(all).toContain('Long wait')
      expect(all).toContain(' · 5s')
      expect(all.some(t => t === 'ls' || t.includes('$ ls'))).toBe(false)
      await ui.unmount()
    }
  })

  test('the gate runs its steps, counts tests, reports and shows ✗ for a failed step', async ($, on) => {
    const { clock } = engine(on, 2_000_000)
    on('tool.check', () => ({ decision: 'allow' }) as never)
    on('process.spawn', async function* (_, e) {
      const cmd = (e as { argv: string[] }).argv.join(' ')
      await clock.advance(4_000)
      if (cmd.includes('unit')) {
        yield { stream: 'stdout', text: "Test Case '-[A a]' passed (0.1 s)\nTest Case '-[A b]' pas" }
        yield { stream: 'stdout', text: 'sed (0.1 s)\nExecuted 2 tests\n' }
        return { value: { code: 0, signal: null } }
      }
      yield { stream: 'stderr', text: 'boom\n' }
      return { value: { code: 3, signal: null } }
    } as never)

    await start($)
    const ran = await $.tool.call({
      tool: GATE,
      title: 'PR',
      steps: [
        { name: 'Unit', command: 'run unit' },
        { name: 'Lint', command: 'run lint' },
        { name: 'Strings', command: 'run strings' },
      ],
    } as never)
    const text = String(ran.result)
    expect(ran.isError).toBe(true)
    expect(text).toContain('Gate "PR": FAILED (1/3 steps passed')
    expect(text).toContain('✔ Unit: exit 0, 0:04, tests: 2 passed, 0 failed')
    expect(text).toContain('✗ Lint: exit 3')
    expect(text).toContain('boom')
    expect(text).toContain('– Strings: skipped')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    const all = await texts(ui)
    expect(all).toContain('✗ ')
    expect(all).toContain('PR')
    expect(all).toContain(' · 8s · 1/3')
    expect(all.join('').includes('░')).toBe(false)
    await ui.unmount()
  })

  test('a step the Bash rules deny stops the gate before anything runs', async ($, on) => {
    engine(on, 3_000_000)
    let spawned = 0
    on('tool.check', () => ({ decision: 'deny', reason: 'rm is denied' }) as never)
    on('process.spawn', async function* () {
      spawned++
      return { value: { code: 0, signal: null } }
    } as never)

    await start($)
    const ran = await $.tool.call({ tool: GATE, steps: [{ name: 'Wipe', command: 'rm -rf x' }] } as never)
    expect(String(ran.result)).toContain('Refused: step "Wipe"')
    expect(spawned).toBe(0)
  })
})

describe('tasks: opening the pane', () => {
  test('a visible task opens the pane once, without a goal', async ($, on) => {
    const { clock, opened } = engine(on, 4_000_000)
    on('tool.call', async () => {
      await clock.advance(5_000)
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    await start($)
    expect(opened).toEqual(['goal-meter'])
    opened.length = 0
    const first = $.tool.call({ tool: 'Bash', command: 'sleep 5', description: 'Build' })
    await first
    await clock.advance(1_000)
    const second = $.tool.call({ tool: 'Bash', command: 'sleep 5', description: 'Build again' })
    await second
    await clock.advance(1_000)
    expect(opened.filter(id => id === 'goal-meter').length).toBe(1)
  })

  test('every gate opens the pane again, even after a Bash row opened it', async ($, on) => {
    const { clock, opened } = engine(on, 4_500_000)
    on('tool.call', async () => {
      await clock.advance(5_000)
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })
    on('tool.check', () => ({ decision: 'allow' }) as never)
    on('process.spawn', async function* () {
      await clock.advance(1_000)
      return { value: { code: 0, signal: null } }
    } as never)

    await start($)
    opened.length = 0
    await $.tool.call({ tool: 'Bash', command: 'sleep 5', description: 'Build' })
    await clock.advance(1_000)
    await $.tool.call({ tool: GATE, steps: [{ name: 'Unit', command: 'run unit' }] } as never)
    await $.tool.call({ tool: GATE, steps: [{ name: 'Unit', command: 'run unit' }] } as never)
    expect(opened.filter(id => id === 'goal-meter').length).toBe(3)
  })

  test('the pane opens with the session, without a goal', async ($, on) => {
    const { opened } = engine(on, 4_200_000)
    await start($)
    expect(opened).toEqual(['goal-meter'])
  })

  test('in status mode the pane stays closed', async ($, on) => {
    const { clock, opened } = engine(on, 5_000_000, { mode: 'status' })
    on('tool.check', () => ({ decision: 'allow' }) as never)
    on('process.spawn', async function* () {
      await clock.advance(1_000)
      return { value: { code: 0, signal: null } }
    } as never)

    await start($)
    await $.tool.call({ tool: GATE, steps: [{ name: 'Unit', command: 'run unit' }] } as never)
    expect(opened).toEqual([])
  })

  test('task durations live apart from the goal history', async ($, on) => {
    const goalHistory = [{ title: 'Old goal', startedAt: 1, doneAt: 2, activeMs: 1, costUsd: null, tasks: 1, predictedTotalMs: null }]
    const stored: Record<string, unknown> = { history: goalHistory }
    const { clock } = engine(on, 6_000_000, stored, true)
    // A store of our own, so the test sees which keys the mod writes.
    on('store.get', (_, e) => ({ value: stored[(e as { key: string }).key] }) as never)
    on('store.set', (_, e) => ((stored[(e as { key: string }).key] = (e as { value: unknown }).value), { value: undefined }) as never)
    on('store.delete', (_, e) => (delete stored[(e as { key: string }).key], { value: undefined }) as never)
    on('tool.call', async () => {
      await clock.advance(5_000)
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    await start($)
    await $.tool.call({ tool: 'Bash', command: 'sleep 5', description: 'Long wait' })
    expect(stored.history).toEqual(goalHistory)
    expect(Object.keys(stored.runHistory as object)).toEqual(['sleep 5'])
  })
})
