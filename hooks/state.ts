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
  `The person watches a goal meter pane. It mirrors your task list on its own: the app's plan tool (${PLAN_TOOL}), TodoWrite or TaskCreate/TaskUpdate. Keep that list current as the app asks, and always call that tool first; never call ${TOOL} in its place or before it.`,
  `For a task with more than one step, call ${TOOL} right after the first plan call of the task: \`goal\` (one line, e.g. the ticket and its topic) and the same main tasks with 2-5 subtasks each where a step has parts. Call it again, after the plan call, whenever a subtask starts or finishes. The meter keeps those subtasks while the plan moves on, and a step closed in the plan closes its subtasks.`,
  `Where no such task list exists, ${TOOL} alone keeps the meter.`,
].join('\n')
