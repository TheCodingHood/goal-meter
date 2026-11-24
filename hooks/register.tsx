import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Agent, Goal, HistoryEntry, MainTask, Mode, ModelInfo } from '../types'
import {
  estimate,
  etaFactor,
  formatClock,
  formatDuration,
  mergeTasks,
  newGoal,
  notePrediction,
  parseDeadline,
  progress,
  quotaLabel,
  setPaused,
  startActive,
  stopActive,
  toHistory,
  planTasks,
  toStatus,
} from './meter'
import type { PlanInput, TaskInput } from './meter'
import { addSamples, alertKind, alertThreshold, newAlerts } from './quota'
import { historyTable, report } from './report'
import { pressFinish, registerFertig, startFertig } from './fertig'
import { afterTurnPrs, refreshPrs, registerPrs, startPrs } from './pr'
import { registerTasks, startTasks } from './tasks'
import {
  MODES,
  STORE,
  MAX_HISTORY,
  costOf,
  hasPanel,
  hasStatus,
  GUIDE,
  MAX_SAVED_GOALS,
  PLAN_TOOL,
  WRAP_TOOL,
  TOOL,
  PANE,
  PANE_TITLE,
} from './state'
import { Pane } from './views'
import type { Actions, Els, View } from './views'

const goalAtom = atom({ plugin: 'goal-meter', key: 'goal' } as const, null)
const nowAtom = atom({ plugin: 'goal-meter', key: 'now' } as const, 0)
const isBandHiddenAtom = atom({ plugin: 'goal-meter', key: 'isBandHidden' } as const, false)
const modeAtom = atom({ plugin: 'goal-meter', key: 'mode' } as const, 'both')
// The same value tasks.ts keeps: the scan wants every atom written in the file that reads it.
const runsAtom = atom({ plugin: 'goal-meter', key: 'runs' } as const, [], { shape: 'runs-1' })
const isMutedAtom = atom({ plugin: 'goal-meter', key: 'isMuted' } as const, false)
const isTurnRunningAtom = atom({ plugin: 'goal-meter', key: 'isTurnRunning' } as const, false)
const agentsAtom = atom({ plugin: 'goal-meter', key: 'agents' } as const, [])
const quotaSamplesAtom = atom({ plugin: 'goal-meter', key: 'quotaSamples' } as const, [])
const alertedAtom = atom({ plugin: 'goal-meter', key: 'alerted' } as const, [])
const etaFactorAtom = atom({ plugin: 'goal-meter', key: 'etaFactor' } as const, 1)
const modelAtom = atom({ plugin: 'goal-meter', key: 'model' } as const, null)
const isDoneTasksCollapsedAtom = atom({ plugin: 'goal-meter', key: 'isDoneTasksCollapsed' } as const, false)
const isDoneRunsCollapsedAtom = atom({ plugin: 'goal-meter', key: 'isDoneRunsCollapsed' } as const, false)
// When the meter tool last ran (or the last reminder went out), and the tool calls since.
const nudgeAtom = atom({ plugin: 'goal-meter', key: 'nudge' } as const, { at: 0, calls: 0 })
// The main tasks last handed to the app's plan, so subtask-only changes send nothing.
const planSyncedAtom = atom({ plugin: 'goal-meter', key: 'planSynced' } as const, '')
// The same values pr.ts keeps (see runsAtom above).
const prsAtom = atom({ plugin: 'goal-meter', key: 'prs' } as const, [], { shape: 'prs-1' })
const prCheckedAtAtom = atom({ plugin: 'goal-meter', key: 'prCheckedAt' } as const, 0)
const prFocusAtom = atom({ plugin: 'goal-meter', key: 'prFocus' } as const, null)
const isDonePrsCollapsedAtom = atom({ plugin: 'goal-meter', key: 'isDonePrsCollapsed' } as const, true)
// The same values fertig.ts keeps.
const finishAtom = atom({ plugin: 'goal-meter', key: 'finish' } as const, null, { shape: 'finish-1' })
const finishConfirmAtom = atom({ plugin: 'goal-meter', key: 'finishConfirm' } as const, null)


const SOUND_DONE = 'sounds/done.wav'
const SOUND_ALERT = 'sounds/alert.wav'
const MAX_AGENTS = 8
// A subtask reminder after this long, or this many tool calls, without a meter call.
const NUDGE_MS = 3 * 60_000
const NUDGE_CALLS = 8
// The app's plan takes 1 to 12 steps.
const PLAN_MAX = 12
const MIRRORED_TITLE = 'Aufgaben dieser Session'

const STEP_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
  },
  required: ['title', 'status'],
}

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string', description: 'The big goal in one line. Omit to keep the current one.' },
    tasks: {
      type: 'array',
      description: 'The FULL list of main tasks, in order (it replaces the previous list).',
      items: {
        type: 'object',
        properties: { ...STEP_SCHEMA.properties, subtasks: { type: 'array', items: STEP_SCHEMA } },
        required: ['title', 'status'],
      },
    },
  },
}

const HELP = [
  '/goal-meter                 show the meter',
  '/goal-meter <goal>          set a goal',
  '/goal-meter pause | resume  stop or restart the active-time clock',
  '/goal-meter deadline 17:00  set a deadline (off to remove)',
  '/goal-meter report          summary of the goal as Markdown',
  '/goal-meter history         goals finished before',
  '/goal-meter mode status | panel | both',
  '/goal-meter sound on | off',
  '/goal-meter pane | clear',
].join('\n')

// --- engine helpers (functions given $ live in this file) --------------------

const usageOf = ($: EngineInterface): Promise<SessionUsage | null> => $.session.usage().catch(() => null)

type SavedGoals = Record<string, Goal>

const loadSavedGoals = async ($: EngineInterface): Promise<SavedGoals> => {
  const raw = await $.store.get(STORE.goals).catch(() => undefined)
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as SavedGoals) : {}
}

// Writes the goal for this session and keeps a copy under the session's id, so
// a resumed chat finds it again and no other chat picks it up.
const saveGoal = async ($: EngineInterface, goal: Goal | null): Promise<void> => {
  await update($, goalAtom, () => goal)
  const id = await $.session.id().catch(() => null)
  if (!id) return
  const saved = { ...(await loadSavedGoals($)) }
  if (goal === null) delete saved[id]
  else saved[id] = goal
  const kept = Object.entries(saved)
    .sort(([, a], [, b]) => b.startedAt - a.startedAt)
    .slice(0, MAX_SAVED_GOALS)
  await $.store.set(STORE.goals, Object.fromEntries(kept)).catch(() => undefined)
}

const loadHistory = async ($: EngineInterface): Promise<HistoryEntry[]> => {
  const raw = await $.store.get(STORE.history).catch(() => undefined)

  return Array.isArray(raw) ? (raw as HistoryEntry[]) : []
}

const appendHistory = async ($: EngineInterface, entry: HistoryEntry): Promise<HistoryEntry[]> => {
  const history = [...(await loadHistory($)), entry].slice(-MAX_HISTORY)
  await $.store.set(STORE.history, history).catch(() => undefined)

  return history
}

const playSound = async ($: EngineInterface, asset: string): Promise<void> => {
  if (await read($, isMutedAtom)) return
  await $.audio.play({ asset }).catch(() => undefined)
}

// --- status line ---------------------------------------------------------------

// This fork shows no status line: the pane carries the meter. Clearing it on every
// refresh also removes a line an earlier version left behind.
const refreshStatus = async ($: EngineInterface, _usage?: SessionUsage | null): Promise<void> => {
  $.ui.status(undefined)
}

// Opens the pane; when the surface does not seat it, says why in the transcript
// (a run with no surface at all stays quiet: the pane waits for one to attach).
const openPane = async ($: EngineInterface): Promise<void> => {
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE }).catch((err: unknown) => ({
    isPlaced: false as const,
    reason: err instanceof Error ? err.message : String(err),
  }))
  if (!opened.isPlaced && !opened.reason.startsWith('no-surface')) $.ui.log(`goal-meter: Pane wartet (${opened.reason})`)
}

// --- writing the goal -------------------------------------------------------------

// Every change of the goal goes through here: done detection, history, sound, status.
const commit = async ($: EngineInterface, prev: Goal | null, next: Goal, now: number, cost: number | null): Promise<Goal> => {
  const isDone = next.tasks.length > 0 && next.tasks.every(task => task.status === 'done')
  let goal: Goal = isDone ? stopActive({ ...next, doneAt: next.doneAt ?? now }, now) : { ...next, doneAt: null }
  goal = notePrediction(goal, now)
  await saveGoal($, goal)

  const isNew = prev === null || prev.startedAt !== goal.startedAt
  if (isNew) {
    await update($, isBandHiddenAtom, () => false)
    if (hasPanel(await read($, modeAtom))) void openPane($)
  }
  if (goal.doneAt !== null && (prev === null || prev.doneAt === null || isNew)) {
    const history = await appendHistory($, toHistory(goal, now, cost))
    await update($, etaFactorAtom, () => etaFactor(history))
    $.ui.toast(`Erreicht: ${goal.title} (${formatDuration(estimate(goal, now).activeMs || now - goal.startedAt)})`)
    void playSound($, SOUND_DONE)
  }
  await refreshStatus($)

  return goal
}

// The built-in task list drives the meter unless the meter's own tool is in use.
const mirror = async (
  $: EngineInterface,
  edit: (tasks: MainTask[], now: number, cost: number | null) => MainTask[],
  isPlan = false,
): Promise<void> => {
  const prev = await read($, goalAtom)
  // A goal the meter tool keeps wins over every mirrored list, the app's plan too.
  if (prev !== null && prev.source === 'meter' && prev.doneAt === null) return
  const now = await $.clock.now()
  const cost = costOf(await usageOf($))
  const base =
    prev === null || prev.doneAt !== null
      ? newGoal(MIRRORED_TITLE, 'tasks', now, cost, await read($, isTurnRunningAtom))
      : { ...prev, source: 'tasks' as const }
  const tasks = edit(base.tasks, now, cost)
  if (tasks.length === 0 && prev === null) return
  await commit($, prev, { ...base, tasks, ...(isPlan ? { fromPlan: true } : {}) }, now, cost)
}

// Claude keeps one list current, not two: the meter's main tasks become the app's
// plan under the message. Only a change of titles or statuses sends a call.
async function syncPlan($: EngineInterface, goal: Goal): Promise<void> {
  const items = goal.tasks.slice(0, PLAN_MAX).map(t => ({ content: t.title, status: t.status === 'done' ? 'completed' : t.status }))
  const key = JSON.stringify(items)
  if (items.length === 0 || key === (await read($, planSyncedAtom))) return
  await update($, planSyncedAtom, () => key)
  await $.tool.call({ tool: PLAN_TOOL, items, scope: 'continuation' } as never).catch(() => undefined)
}

const asInput = (task: MainTask): TaskInput => ({
  title: task.title,
  status: task.status,
  ...(task.id === undefined ? {} : { id: task.id }),
  subtasks: task.subtasks.map(s => ({ title: s.title, status: s.status })),
})

const view = async ($: EngineInterface, els: Els, cols: number): Promise<View> => ({
  els,
  goal: await read($, goalAtom),
  now: Math.max(await read($, nowAtom), await $.clock.now()),
  cols,
  usage: await usageOf($),
  samples: await read($, quotaSamplesAtom),
  agents: await read($, agentsAtom),
  factor: await read($, etaFactorAtom),
  model: await read($, modelAtom),
  runs: await read($, runsAtom),
  isDoneTasksCollapsed: await read($, isDoneTasksCollapsedAtom),
  isDoneRunsCollapsed: await read($, isDoneRunsCollapsedAtom),
  prs: await read($, prsAtom),
  prCheckedAt: await read($, prCheckedAtAtom),
  prFocus: await read($, prFocusAtom),
  isDonePrsCollapsed: await read($, isDonePrsCollapsedAtom),
  finish: await read($, finishAtom),
  finishConfirm: await read($, finishConfirmAtom),
})

const actions = ($: EngineInterface): Actions => ({
  continueTask: title => void $.prompt.submit({ text: `Mach mit "${title}" weiter` }).catch(() => undefined),
  togglePause: () =>
    void (async () => {
      const goal = await read($, goalAtom)
      if (goal === null) return
      await saveGoal($, setPaused(goal, !goal.isPaused, await $.clock.now(), await read($, isTurnRunningAtom)))
      await refreshStatus($)
    })(),
  setMode: mode =>
    void (async () => {
      await update($, modeAtom, () => mode)
      await $.store.set(STORE.mode, mode).catch(() => undefined)
      await refreshStatus($)
      if (!hasPanel(mode)) await $.ui.close({ id: PANE })
    })(),
  toggleMute: () =>
    void (async () => {
      const isMuted = !(await read($, isMutedAtom))
      await update($, isMutedAtom, () => isMuted)
      await $.store.set(STORE.muted, isMuted).catch(() => undefined)
    })(),
  toggleDoneTasks: () => void update($, isDoneTasksCollapsedAtom, prev => !prev),
  toggleDoneRuns: () => void update($, isDoneRunsCollapsedAtom, prev => !prev),
  refreshPrs: () => void refreshPrs($, { branch: true }).catch(() => undefined),
  focusPr: url => void update($, prFocusAtom, () => url),
  toggleDonePrs: () => void update($, isDonePrsCollapsedAtom, prev => !prev),
  pressFinish: pr => void pressFinish($, pr).catch(() => undefined),
})

// --- register ------------------------------------------------------------------

export const register: Register = (on, options) => {
  registerTasks(on)
  registerPrs(on)
  registerFertig(on, options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'goal-meter',
      description: 'Goal meter: show it, set a goal or deadline, pause, report, history, mode, sound',
      argumentHint: '[goal | pause | resume | deadline HH:MM | report | history | mode | sound | hide | pane | clear]',
    })
    await $.tool.register({
      name: 'update',
      description:
        'Update the goal meter the person watches: the big goal, main tasks and subtasks with their status (pending, in_progress, done). Send the full task list every call.',
      inputSchema: INPUT_SCHEMA,
      isDeferred: false,
    })
    const now = await $.clock.now()
    await update($, nowAtom, () => now)
    $.clock.every(500, () => {
      void $.clock.now().then(t => update($, nowAtom, () => t))
    })

    const mode = await $.store.get(STORE.mode).catch(() => undefined)
    await update($, modeAtom, () => (MODES.includes(mode as Mode) ? (mode as Mode) : 'both'))
    const isMuted = (await $.store.get(STORE.muted).catch(() => false)) === true
    await update($, isMutedAtom, () => isMuted)
    const factor = etaFactor(await loadHistory($))
    await update($, etaFactorAtom, () => factor)

    // The old shared key handed one chat's goal to every other chat: gone.
    await $.store.delete(STORE.goal).catch(() => undefined)
    // A goal of this same session (resumed) carries on, its clock stopped until a turn runs.
    if ((await read($, goalAtom)) === null) {
      const id = await $.session.id().catch(() => null)
      const saved = id ? (await loadSavedGoals($))[id] : undefined
      if (saved !== undefined && saved !== null && typeof saved === 'object' && saved.doneAt === null) {
        await update($, goalAtom, () => stopActive(saved, now))
      }
    }

    const usage = await usageOf($)
    await update($, quotaSamplesAtom, s => addSamples(s, usage?.rateLimits ?? [], now))
    await refreshStatus($, usage)
    // The pane starts with the session, as the Tasks pane did, goal or not.
    if (hasPanel(await read($, modeAtom))) void openPane($)
    await startTasks($)
    startPrs($)
    await startFertig($)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, isTurnRunningAtom, () => true)
    const goal = await read($, goalAtom)
    if (goal !== null) await saveGoal($, startActive(goal, await $.clock.now()))

    return next(e)
  })

  // Each main-loop request names the model it goes to (a /model switch or a fallback shows on the next one).
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const model: ModelInfo = { id: e.model, effort: e.effort === undefined ? null : String(e.effort) }
      const prev = await read($, modelAtom)
      if (prev?.id !== model.id || prev.effort !== model.effort) {
        await update($, modelAtom, () => model)
        await refreshStatus($)
      }
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId !== undefined) {
      await update($, agentsAtom, list => list.map(a => (a.id === e.agentId && a.doneAt === null ? { ...a, doneAt: now } : a)))
    } else {
      await update($, isTurnRunningAtom, () => false)
      const goal = await read($, goalAtom)
      if (goal !== null) await saveGoal($, stopActive(goal, now))
      afterTurnPrs($)
    }
    await refreshStatus($)

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId !== undefined) {
      const agent: Agent = {
        id: spawned.agentId,
        description: e.description,
        type: e.subagentType,
        startedAt: await $.clock.now(),
        doneAt: null,
      }
      await update($, agentsAtom, list => [...list, agent].slice(-MAX_AGENTS))
      await refreshStatus($)
    }

    return spawned
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, quotaSamplesAtom, s => addSamples(s, e.rateLimits, now))
    const fresh = newAlerts(await read($, alertedAtom), e.rateLimits)
    if (fresh.length > 0) {
      await update($, alertedAtom, list => [...list, ...fresh].slice(-50))
      const top = fresh.reduce((a, b) => (alertThreshold(b) > alertThreshold(a) ? b : a))
      $.ui.toast(`Kontingent ${quotaLabel(alertKind(top))}: ${alertThreshold(top)}% verbraucht`)
      void playSound($, SOUND_ALERT)
    }
    await refreshStatus($, { startedAt: 0, ...e })

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const goal = await read($, goalAtom)
    const current =
      goal === null ? '' : `\nCurrent goal: ${goal.title} (${progress(goal).done}/${progress(goal).total} done).`

    return {
      ...composed,
      sections: [...composed.sections, { id: 'goal-meter:guide', text: GUIDE + current, scope: 'session' }],
    }
  })

  on('tool.call', { tool: 'mcp__goal-meter__update' }, async ($, e) => {
    const input = e as unknown as { goal?: string; tasks?: TaskInput[] }
    const now = await $.clock.now()
    const cost = costOf(await usageOf($))
    const prev = await read($, goalAtom)
    const title = input.goal?.trim() || prev?.title || 'Ziel'
    // A title alone on a list mirrored from the app's plan names that list; it starts nothing new.
    const isPlanTitle = prev?.fromPlan === true && input.tasks === undefined
    const isNewGoal =
      prev === null ||
      prev.doneAt !== null ||
      (!isPlanTitle && input.goal !== undefined && input.goal.trim() !== prev.title && prev.source !== 'manual')
    const base: Goal = isNewGoal
      ? newGoal(title, 'meter', now, cost, await read($, isTurnRunningAtom))
      : { ...prev, title, source: isPlanTitle ? prev.source : 'meter' }
    const tasks = input.tasks === undefined ? base.tasks : mergeTasks(input.tasks, base.tasks, now, cost)
    const goal = await commit($, prev, { ...base, tasks }, now, cost)
    await update($, nudgeAtom, () => ({ at: now, calls: 0 }))
    await syncPlan($, goal)
    const { done, total } = progress(goal)

    return { result: `Goal meter updated: ${done}/${total} done.` }
  })

  // The desktop app's plan: a full list, or a step forward by index (1-based).
  on('tool.call', { tool: PLAN_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.isError !== true && ran.deny === undefined) {
      const input = e as unknown as PlanInput
      await mirror($, (tasks, now, cost) => mergeTasks(planTasks(input, tasks.map(asInput)), tasks, now, cost), true).catch(
        () => undefined,
      )
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Claude keeps main tasks current but forgets subtasks: after a while without a meter
  // call, one reminder rides on the next tool result (`context`: the model reads it,
  // the person does not, the output stays as it was).
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || e.agentId !== undefined || e.tool === TOOL) return ran
    const goal = await read($, goalAtom)
    const task = goal?.tasks.find(t => t.status === 'in_progress')
    const sub = task?.subtasks.find(s => s.status === 'in_progress') ?? task?.subtasks.find(s => s.status === 'pending')
    if (goal === null || goal.doneAt !== null || goal.isPaused || !task || !sub) return ran
    const now = await $.clock.now()
    const n = await update($, nudgeAtom, prev => ({ ...prev, calls: prev.calls + 1 }))
    if (now - n.at < NUDGE_MS && n.calls < NUDGE_CALLS) return ran
    await update($, nudgeAtom, () => ({ at: now, calls: 0 }))
    const since = n.at > 0 ? ` for ${formatDuration(now - n.at)}` : ''
    const reminder = `goal-meter: the pane still shows "${task.title}" → "${sub.title}" as ${sub.status === 'in_progress' ? 'running' : 'next'}${since}. If a subtask started or finished since, call ${TOOL} with the full list now; otherwise carry on.`

    return { ...ran, context: [...(ran.context ?? []), reminder] }
  }).catch(($, e, next) => next(e))

  // The app's wrap_up checks off its whole plan without another update_plan call.
  on('tool.call', { tool: WRAP_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    const goal = await read($, goalAtom)
    if (ran.isError !== true && ran.deny === undefined && goal?.fromPlan === true && goal.doneAt === null) {
      await mirror($, (tasks, now, cost) => mergeTasks(planTasks({ done: tasks.map((_, i) => i + 1) }, tasks.map(asInput)), tasks, now, cost), true).catch(
        () => undefined,
      )
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.isError !== true && ran.deny === undefined) {
      const todos = e.todos.map(t => ({ title: t.content, status: toStatus(t.status) }))
      await mirror($, (tasks, now, cost) => mergeTasks(todos, tasks, now, cost)).catch(() => undefined)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const id = (ran.result as { task?: { id?: string } } | undefined)?.task?.id
    if (ran.isError !== true && ran.deny === undefined && id !== undefined) {
      await mirror($, (tasks, now, cost) =>
        mergeTasks([...tasks.map(asInput), { title: e.subject, status: 'pending', id }], tasks, now, cost),
      ).catch(() => undefined)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.isError !== true && ran.deny === undefined) {
      await mirror($, (tasks, now, cost) => {
        const inputs = tasks.flatMap((task): TaskInput[] => {
          if (task.id !== e.taskId) return [asInput(task)]
          if (e.status === 'deleted') return []
          return [{ ...asInput(task), title: e.subject ?? task.title, status: e.status === undefined ? task.status : toStatus(e.status) }]
        })
        return mergeTasks(inputs, tasks, now, cost)
      }).catch(() => undefined)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'goal-meter' }, async ($, e) => {
    const args = e.args.trim()
    const [word = '', ...rest] = args.split(/\s+/)
    const value = rest.join(' ')
    const now = await $.clock.now()
    const goal = await read($, goalAtom)

    switch (word) {
      case 'help':
        return { text: HELP }
      case 'clear':
        await saveGoal($, null)
        await refreshStatus($)
        return { text: 'Goal meter cleared.' }
      case 'hide':
        return { text: 'This version has no band above the prompt; the pane is the meter.' }
      case 'pane':
        await $.ui.open({ id: PANE, title: 'Goal meter' })
        return { text: 'Goal meter pane opened.' }
      case 'pause':
      case 'resume': {
        if (goal === null) return { text: 'No goal to pause.' }
        await saveGoal($, setPaused(goal, word === 'pause', now, await read($, isTurnRunningAtom)))
        await refreshStatus($)
        return { text: word === 'pause' ? 'Active-time clock paused.' : 'Active-time clock running again.' }
      }
      case 'deadline': {
        if (goal === null) return { text: 'Set a goal first.' }
        if (value === 'off') {
          await saveGoal($, { ...goal, deadlineAt: null })
          return { text: 'Deadline removed.' }
        }
        const at = parseDeadline(value, now)
        if (at === null) return { text: 'Use /goal-meter deadline HH:MM (for example 17:00), or off.' }
        await saveGoal($, { ...goal, deadlineAt: at })
        await refreshStatus($)
        return { text: `Deadline set: ${formatClock(at)}` }
      }
      case 'report':
        if (goal === null) return { text: 'No goal yet.' }
        return { text: report(goal, now, costOf(await usageOf($)), await read($, etaFactorAtom)) }
      case 'history':
        return { text: historyTable(await loadHistory($)) }
      case 'sound': {
        const isMuted = value === 'off' ? true : value === 'on' ? false : !(await read($, isMutedAtom))
        await update($, isMutedAtom, () => isMuted)
        await $.store.set(STORE.muted, isMuted).catch(() => undefined)
        return { text: `Sound ${isMuted ? 'off' : 'on'}.` }
      }
      case 'mode': {
        if (!MODES.includes(value as Mode)) {
          return { text: `Mode: ${await read($, modeAtom)}. Use /goal-meter mode status | panel | both` }
        }
        const mode = value as Mode
        await update($, modeAtom, () => mode)
        await $.store.set(STORE.mode, mode).catch(() => undefined)
        await update($, isBandHiddenAtom, () => false)
        await refreshStatus($)
        if (hasPanel(mode)) await openPane($)
        else await $.ui.close({ id: PANE })
        return { text: `Goal meter mode: ${mode}` }
      }
      case '':
        break
      default: {
        const cost = costOf(await usageOf($))
        await commit($, goal, newGoal(args, 'manual', now, cost, await read($, isTurnRunningAtom)), now, cost)
      }
    }
    await update($, isBandHiddenAtom, () => false)
    const mode = await read($, modeAtom)
    if (hasPanel(mode)) await openPane($)

    return { text: args === '' ? `Goal meter shown (mode: ${mode}). /goal-meter help lists the commands.` : `Goal set: ${args}` }
  })

  on('ui.render', { component: 'Pane', requestId: 'goal-meter' }, async ($, e) => {
    const els = $.ui.resolve(e)
    // Only the desktop draws Svg; other surfaces get the text rows.
    const v = await view($, (e.surface === 'desktop' && 'Svg' in els ? els : { Box: els.Box, Text: els.Text, Button: els.Button }) as unknown as Els, e.props.bodyColumns || e.viewport?.columns || 50)

    return Pane(v, actions($))
  })
}
