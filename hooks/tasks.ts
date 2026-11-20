import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RunStatus, RunStep, RunStepStatus, TaskRun } from '../types'
import { PANE, PANE_TITLE, hasPanel } from './state'

// Tasks: every long foreground Bash call and every gate gets a row in the goal-meter pane.
// Taken over from the task-progress mod; the history lives under its own store key so it
// never touches the goal history.

type On = Parameters<Register>[0]

export const GATE_TOOL = 'mcp__goal-meter__gate'
const RUN_HISTORY_KEY = 'runHistory'
/** A Bash call shorter than this never shows up and is not remembered. */
export const VISIBLE_MS = 3000
const KEEP_FINISHED = 12
const HIST_MAX = 300
const TAIL_LINES = 300

// Change the tag when TaskRun or RunStep change shape: an earlier value is declined.
export const runsAtom = atom({ plugin: 'goal-meter', key: 'runs' } as const, [], { shape: 'runs-1' })
// Read here to decide whether the pane may open by itself; register.tsx writes it.
const modeAtom = atom({ plugin: 'goal-meter', key: 'mode' } as const, 'both')
const autoOpenedAtom = atom({ plugin: 'goal-meter', key: 'runsAutoOpened' } as const, false)

// --- history of durations and test counts, across sessions

type HistEntry = { ms: number[]; tests?: number; at: number }
type Hist = Record<string, HistEntry>

/** The key a command's history is filed under: wrappers and a leading `cd … &&` dropped. */
export const keyOf = (command: string): string => {
  let c = command.trim()
  for (let i = 0; i < 4; i++) {
    const before = c
    c = c.replace(/^rtk\s+(proxy\s+)?/, '')
    c = c.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, '')
    c = c.replace(/^(env\s+)?([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+)+/, '')
    c = c.replace(/^set -o pipefail\s*(;|&&)\s*/, '')
    if (c === before) break
  }
  return c.replace(/\s+/g, ' ').slice(0, 240)
}

export const median = (xs: readonly number[] | undefined): number | undefined => {
  if (!xs || xs.length === 0) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2)
}

async function loadHist($: EngineInterface): Promise<Hist> {
  const v = await $.store.get(RUN_HISTORY_KEY).catch(() => undefined)
  return v && typeof v === 'object' ? (v as Hist) : {}
}

async function remember($: EngineInterface, key: string, ms: number, tests?: number): Promise<void> {
  const h = await loadHist($)
  const prev = h[key]
  const at = await $.clock.now()
  h[key] = {
    ms: [...(prev?.ms ?? []), Math.round(ms)].slice(-5),
    tests: tests && tests > 0 ? tests : prev?.tests,
    at,
  }
  const keys = Object.keys(h)
  if (keys.length > HIST_MAX) {
    keys
      .sort((a, b) => (h[a]?.at ?? 0) - (h[b]?.at ?? 0))
      .slice(0, keys.length - HIST_MAX)
      .forEach(k => delete h[k])
  }
  await $.store.set(RUN_HISTORY_KEY, h).catch(() => undefined)
}

// --- test lines: XCTest/xcodebuild, Swift Testing, cargo, go, pytest -v

const PASS = [
  /^\s*Test [Cc]ase '.+' passed\b/,
  /^\s*\S+\s+Test (?!run\b).+ passed after\b/,
  /^test .+ \.\.\. ok$/,
  /^\s*--- PASS: /,
  /\sPASSED(\s|$)/,
]
const FAIL = [
  /^\s*Test [Cc]ase '.+' failed\b/,
  /^\s*\S+\s+Test (?!run\b).+ failed after\b/,
  /^test .+ \.\.\. FAILED$/,
  /^\s*--- FAIL: /,
  /\sFAILED(\s|$)/,
]

export const classify = (line: string): 'pass' | 'fail' | undefined => {
  if (PASS.some(r => r.test(line))) return 'pass'
  if (FAIL.some(r => r.test(line))) return 'fail'
  return undefined
}

// --- progress arithmetic

export const stepFraction = (s: RunStep, at: number): number | undefined => {
  if (s.status === 'done' || s.status === 'failed') return 1
  if (s.status !== 'running') return 0
  const byTime = s.etaMs && s.startedAt !== undefined ? (at - s.startedAt) / s.etaMs : undefined
  const tests = s.passed + s.failed
  const byTests = s.expected && tests > 0 ? tests / s.expected : undefined
  if (byTime === undefined && byTests === undefined) return undefined
  return Math.min(0.99, Math.max(byTime ?? 0, byTests ?? 0))
}

export const runFraction = (r: TaskRun, at: number): number | undefined => {
  if (r.status !== 'running') return 1
  if (r.kind === 'bash') return r.steps[0] ? stepFraction(r.steps[0], at) : undefined
  const known = r.steps.map(s => s.etaMs).filter((x): x is number => !!x)
  const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1
  let sum = 0
  let total = 0
  for (const s of r.steps) {
    if (s.status === 'skipped') continue
    const w = s.etaMs ?? fallback
    total += w
    sum += w * (stepFraction(s, at) ?? 0)
  }
  return total ? Math.min(0.99, sum / total) : undefined
}

// The gate's report to Claude keeps the clock format task-progress used.
export const fmtDur = (ms: number): string => {
  const t = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

// --- run bookkeeping

export const isVisible = (r: TaskRun, at: number): boolean => {
  if (r.kind === 'gate') return true
  if (r.status === 'running') return at - r.startedAt >= VISIBLE_MS || (r.etaMs ?? 0) >= VISIBLE_MS
  return (r.endedAt ?? at) - r.startedAt >= VISIBLE_MS
}

async function addRun($: EngineInterface, run: TaskRun): Promise<void> {
  await update($, runsAtom, list => [...list.filter(r => r.id !== run.id), run])
}

async function patchRun($: EngineInterface, id: string, fn: (r: TaskRun) => TaskRun): Promise<void> {
  await update($, runsAtom, list => list.map(r => (r.id === id ? fn(r) : r)))
}

async function finishRun($: EngineInterface, id: string, status: RunStatus | 'drop'): Promise<void> {
  const at = await $.clock.now()
  await update($, runsAtom, list => {
    const out: TaskRun[] = []
    for (const r of list) {
      if (r.id !== id) {
        out.push(r)
        continue
      }
      if (status === 'drop') continue
      const done: TaskRun = { ...r, status, endedAt: at }
      if (isVisible(done, at)) out.push(done)
    }
    const running = out.filter(r => r.status === 'running')
    const finished = out.filter(r => r.status !== 'running').slice(-KEEP_FINISHED)
    return out.filter(r => running.includes(r) || finished.includes(r))
  })
}

// --- the gate tool

type GateStepInput = { name: string; command: string; cwd?: string }
type GateInput = { title?: string; steps: GateStepInput[]; stopOnFailure: boolean }

const parseGate = (e: unknown): GateInput | string => {
  const g = e as Partial<GateInput>
  if (!Array.isArray(g.steps) || g.steps.length === 0) return 'steps: at least one step is required'
  for (const [i, s] of g.steps.entries()) {
    if (!s || typeof s.command !== 'string' || !s.command.trim()) return `steps[${i}].command is required`
    if (typeof s.name !== 'string' || !s.name.trim()) return `steps[${i}].name is required`
  }
  return {
    title: typeof g.title === 'string' && g.title.trim() ? g.title.trim() : undefined,
    steps: g.steps.map(s => ({ name: s.name.trim(), command: s.command, cwd: s.cwd || undefined })),
    stopOnFailure: g.stopOnFailure !== false,
  }
}

export const RUN_GLYPH: Record<RunStepStatus | RunStatus, string> = {
  pending: '○',
  running: '◐',
  done: '✔',
  failed: '✗',
  skipped: '–',
  cancelled: '■',
}

const reportOf = (title: string, steps: RunStep[], tails: string[][], ms: number): string => {
  const ok = steps.every(s => s.status === 'done')
  const lines = [
    `Gate "${title}": ${ok ? 'PASSED' : 'FAILED'} (${steps.filter(s => s.status === 'done').length}/${steps.length} steps passed, ${fmtDur(ms)})`,
  ]
  steps.forEach((s, i) => {
    const dur = s.startedAt !== undefined && s.endedAt !== undefined ? `, ${fmtDur(s.endedAt - s.startedAt)}` : ''
    const tests = s.passed + s.failed > 0 ? `, tests: ${s.passed} passed, ${s.failed} failed` : ''
    const exit = s.exitCode !== undefined ? `exit ${s.exitCode ?? 'signal'}` : s.status
    lines.push(`${RUN_GLYPH[s.status]} ${s.name}: ${exit}${dur}${tests}`)
    lines.push(`  $ ${s.command}`)
    if (s.status === 'done' || s.status === 'failed' || s.status === 'cancelled') {
      const n = s.status === 'done' ? 10 : 80
      const tail = (tails[i] ?? []).slice(-n)
      if (tail.length) {
        lines.push(`  --- last ${tail.length} output lines ---`)
        for (const l of tail) lines.push(`  ${l}`)
      }
    }
  })
  return lines.join('\n')
}

async function runGate(
  $: EngineInterface,
  id: string,
  input: GateInput,
  agentId: string | undefined,
  signal: AbortSignal,
): Promise<{ text: string; ok: boolean }> {
  const hist = await loadHist($)
  const startedAt = await $.clock.now()
  const title = input.title ?? input.steps.map(s => s.name).join(' + ')
  const steps: RunStep[] = input.steps.map(s => {
    const h = hist[`step:${keyOf(s.command)}`]
    return { name: s.name, command: s.command, status: 'pending', etaMs: median(h?.ms), expected: h?.tests, passed: 0, failed: 0 }
  })
  const tails: string[][] = input.steps.map(() => [])
  const setStep = async (i: number, patch: Partial<RunStep>) => {
    steps[i] = { ...(steps[i] as RunStep), ...patch }
    const snapshot = steps.map(s => ({ ...s }))
    await patchRun($, id, r => ({ ...r, steps: snapshot }))
  }

  await addRun($, {
    id,
    kind: 'gate',
    title,
    status: 'running',
    startedAt,
    etaMs: steps.every(s => s.etaMs) ? steps.reduce((a, s) => a + (s.etaMs ?? 0), 0) : undefined,
    agentId,
    steps: steps.map(s => ({ ...s })),
  })
  await openForGate($)

  let isAborted = signal.aborted
  const abort = new Promise<'abort'>(resolve => {
    if (signal.aborted) resolve('abort')
    else signal.addEventListener('abort', () => resolve('abort'), { once: true })
  })
  let hasFailed = false

  for (let i = 0; i < input.steps.length; i++) {
    const spec = input.steps[i]
    if (!spec) continue
    if (isAborted) {
      await setStep(i, { status: 'cancelled' })
      continue
    }
    if (hasFailed && input.stopOnFailure) {
      await setStep(i, { status: 'skipped' })
      continue
    }
    const t0 = await $.clock.now()
    await setStep(i, { status: 'running', startedAt: t0 })

    const stream = $.process.spawn({
      argv: ['/bin/zsh', '-lc', `set -o pipefail\n${spec.command}`],
      cwd: spec.cwd,
    })
    const it = stream[Symbol.asyncIterator]()
    const partial = { stdout: '', stderr: '' }
    let passed = 0
    let failed = 0
    let note = ''
    let lastWrite = 0
    let code: number | null | undefined
    let startError: string | undefined
    const tail: string[] = []
    tails[i] = tail

    const take = (line: string) => {
      const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')
      tail.push(clean)
      if (tail.length > TAIL_LINES) tail.splice(0, tail.length - TAIL_LINES)
      const kind = classify(clean)
      if (kind === 'pass') passed++
      else if (kind === 'fail') failed++
      if (clean.trim()) note = clip(oneLine(clean), 120)
    }

    try {
      for (;;) {
        const r = await Promise.race([it.next(), abort])
        if (r === 'abort') {
          isAborted = true
          await it.return?.(undefined as never)
          break
        }
        if (r.done) {
          code = r.value?.code ?? null
          break
        }
        const { stream: pipe, text } = r.value
        const parts = (partial[pipe] + text).split('\n')
        partial[pipe] = parts.pop() ?? ''
        for (const line of parts) take(line)
        const at = await $.clock.now()
        if (at - lastWrite >= 400) {
          lastWrite = at
          await setStep(i, { passed, failed, note })
        }
      }
    } catch (err) {
      startError = err instanceof Error ? err.message : String(err)
    }
    for (const rest of [partial.stdout, partial.stderr]) if (rest) take(rest)
    if (startError) tail.push(`[goal-meter] could not run the step: ${startError}`)

    const t1 = await $.clock.now()
    const status: RunStepStatus = isAborted ? 'cancelled' : code === 0 ? 'done' : 'failed'
    await setStep(i, { status, endedAt: t1, exitCode: isAborted ? undefined : code ?? null, passed, failed, note })
    if (status === 'failed') hasFailed = true
    if (!isAborted && !startError) await remember($, `step:${keyOf(spec.command)}`, t1 - t0, passed + failed)
  }

  const endedAt = await $.clock.now()
  const ok = !isAborted && steps.every(s => s.status === 'done')
  await finishRun($, id, isAborted ? 'cancelled' : ok ? 'done' : 'failed')
  return { text: reportOf(title, steps, tails, endedAt - startedAt), ok }
}

const GATE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short name for the gate, e.g. "Gates vor dem PR".' },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A few words, e.g. "Domain tests".' },
          command: { type: 'string', description: 'The shell command, exactly as you would give it to Bash.' },
          cwd: { type: 'string', description: 'Working directory, absolute or relative to the session; optional.' },
        },
        required: ['name', 'command'],
      },
    },
    stopOnFailure: { type: 'boolean', description: 'Skip the remaining steps after a failure (default true).' },
  },
  required: ['steps'],
}

// --- the handlers

// The pane opens by itself once per session, as soon as a task is visible and the mode allows a pane.
async function openOnce($: EngineInterface): Promise<void> {
  if (await read($, autoOpenedAtom)) return
  if (!hasPanel(await read($, modeAtom))) return
  await update($, autoOpenedAtom, () => true)
  await $.ui.open({ id: PANE, title: PANE_TITLE }).catch(() => undefined)
}

// A gate opens the pane every time it starts, as task-progress did; Bash rows only once.
async function openForGate($: EngineInterface): Promise<void> {
  if (!hasPanel(await read($, modeAtom))) return
  await update($, autoOpenedAtom, () => true)
  await $.ui.open({ id: PANE, title: PANE_TITLE }).catch(() => undefined)
}

/** Called from the meter's session.start: one session.start hook per module. */
export async function startTasks($: EngineInterface): Promise<void> {
  // Rows a reload left running have lost their hook: close them.
  const at = await $.clock.now()
  await update($, runsAtom, list =>
    list.map(r => (r.status === 'running' ? { ...r, status: 'cancelled' as const, endedAt: at } : r)),
  )
  await $.tool.register({
    name: 'gate',
    description:
      'Run a quality gate (tests, builds, lint, checks) as named steps with live progress bars in the goal-meter pane. ' +
      'Prefer it over Bash whenever you run a long verification command (a test suite, xcodebuild, a full build) ' +
      'or several checks back to back, such as the gates before a commit or PR. ' +
      'Each step runs in zsh with pipefail, from the session working directory or the step cwd; ' +
      "no pipe to tail is needed, the result already holds each step's exit code, duration, test counts and the last output lines " +
      '(80 for a failed step). Steps run in order and stop at the first failure unless stopOnFailure is false. ' +
      'Commands go through the Bash permission rules first: a denied one fails the gate before anything runs.',
    inputSchema: GATE_SCHEMA,
    isDeferred: false,
  })
  $.clock.every(1000, () => {
    void (async () => {
      const list = await read($, runsAtom)
      if (!list.some(r => r.status === 'running')) return
      const t = await $.clock.now()
      if (list.some(r => r.status === 'running' && isVisible(r, t))) await openOnce($)
    })().catch(() => undefined)
  })
}

/** The tool hooks: passive Bash rows and the gate tool. */
export function registerTasks(on: On): void {
  // Passive: every foreground Bash call gets a row; ETA from earlier runs of the same command.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.run_in_background) return next(e)
    const command = e.command
    const key = keyOf(command)
    const etaMs = median((await loadHist($))[key]?.ms)
    const at = await $.clock.now()
    const id = e.tool_use_id ?? `bash-${at}-${Math.random().toString(36).slice(2, 8)}`
    const title = typeof e.description === 'string' && e.description.trim() ? e.description.trim() : key
    await addRun($, {
      id,
      kind: 'bash',
      title,
      status: 'running',
      startedAt: at,
      etaMs,
      agentId: e.agentId,
      steps: [{ name: title, command: key, status: 'running', startedAt: at, etaMs, passed: 0, failed: 0 }],
    })

    let status: RunStatus | 'drop' = 'cancelled'
    try {
      const ran = await next(e)
      if (ran.deny !== undefined) status = 'drop'
      else {
        const r = (ran.result ?? {}) as { interrupted?: boolean; backgroundTaskId?: string }
        status = r.backgroundTaskId ? 'drop' : r.interrupted ? 'cancelled' : ran.isError ? 'failed' : 'done'
      }
      return ran
    } finally {
      const end = await $.clock.now()
      if ((status === 'done' || status === 'failed') && end - at >= VISIBLE_MS) await remember($, key, end - at)
      await finishRun($, id, status)
    }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: GATE_TOOL }, async ($, e, next) => {
    const input = parseGate(e)
    if (typeof input === 'string') return { result: `Invalid gate input: ${input}`, isError: true }

    for (const s of input.steps) {
      const v = await $.tool.check({ tool: 'Bash', input: { command: s.command } })
      if (v.decision === 'deny') {
        return {
          result: `Refused: step "${s.name}" is denied by the Bash permission rules${v.reason ? `: ${v.reason}` : ''}. Nothing ran.`,
          isError: true,
        }
      }
    }

    const id = e.tool_use_id ?? `gate-${await $.clock.now()}`
    const { text, ok } = await runGate($, id, input, e.agentId, next.signal)
    return ok ? { result: text } : { result: text, isError: true }
  }).catch(($, e, next) => ({
    result: `goal-meter: the gate failed inside the mod (${String(next.error?.message ?? 'unknown error')}). Run the steps with Bash instead.`,
    isError: true,
  }))
}
