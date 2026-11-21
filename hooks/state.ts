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
