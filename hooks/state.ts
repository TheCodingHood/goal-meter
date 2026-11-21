import type { SessionUsage } from 'claude-code'

import type { Mode } from '../types'


// The pane's id and title, shared by the meter and the tasks.
export const PANE = 'goal-meter'
export const PANE_TITLE = 'Goal meter'

export const MODES: readonly Mode[] = ['status', 'panel', 'both']
export const hasStatus = (mode: Mode) => mode !== 'panel'
export const hasPanel = (mode: Mode) => mode !== 'status'

// Keys in $.store, kept across sessions.
// `goal` is the old key, shared by every session; it is only read to be removed.
export const STORE = { mode: 'mode', muted: 'muted', goal: 'goal', goals: 'goals', history: 'history' } as const
// Open goals kept per session id, so a goal stays with the chat it was set in.
export const MAX_SAVED_GOALS = 20
export const MAX_HISTORY = 100

export const costOf = (usage: SessionUsage | null): number | null => usage?.cost?.usd ?? null

export const TOOL = 'mcp__goal-meter__update'
// The desktop app's task list under each message.
export const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
// Closes the turn and checks off the whole plan.
export const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'

// The system prompt section: the meter follows the task list Claude keeps anyway.
export const GUIDE = [
  '# Goal meter',
  `The person watches a goal meter. For any multi-step task, call ${TOOL} first with the big goal and the main tasks (each with subtasks where useful), all "pending" or "in_progress".`,
  'Call it again, with the full list, every time a task or subtask starts or finishes, so the colors, elapsed time and ETA stay true. Mark everything "done" when the goal is reached.',
  `The meter does not replace the app's own task list (${PLAN_TOOL}): keep that one current as well, as the app asks.`,
].join('\n')
