export type Status = 'pending' | 'in_progress' | 'done'

export type Step = {
  title: string
  status: Status
  startedAt: number | null
  doneAt: number | null
  // Session cost (USD) when the step started, and what it cost once done.
  costStart: number | null
  costUsd: number | null
}

// `id` is the built-in task list's id when the task was mirrored from it.
export type MainTask = Step & { subtasks: Step[]; id?: string }

// Where the meter shows: the band above the prompt and the status line, the pane, or both.
export type Mode = 'status' | 'panel' | 'both'

// Who writes the task list: the meter's own tool, the built-in task tools, or the person.
export type Source = 'meter' | 'tasks' | 'manual'

export type Goal = {
  title: string
  source: Source
  startedAt: number
  doneAt: number | null
  tasks: MainTask[]
  // Time a turn was running while the meter was not paused.
  activeMs: number
  activeFrom: number | null
  isPaused: boolean
  deadlineAt: number | null
  costStart: number | null
  // Total active time predicted when the goal first passed half way, to calibrate later ETAs.
  predictedTotalMs: number | null
  /** The task list comes from the app's plan (update_plan), so wrap_up closes it. */
  fromPlan?: boolean
}

export type Agent = {
  id: string
  description: string
  type: string
  startedAt: number
  doneAt: number | null
}

export type QuotaSample = { kind: string; at: number; pct: number; resetsAt: string | null }

// The model the main loop last sent a request to, and its reasoning effort.
export type ModelInfo = { id: string; effort: string | null }

export type HistoryEntry = {
  title: string
  startedAt: number
  doneAt: number
  activeMs: number
  costUsd: number | null
  tasks: number
  predictedTotalMs: number | null
}

// --- Tasks: long Bash calls and gates, taken over from the task-progress mod

export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled'

export type RunStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled'

export type RunStep = {
  name: string
  command: string
  status: RunStepStatus
  startedAt?: number
  endedAt?: number
  /** Expected duration from earlier runs of the same command. */
  etaMs?: number
  passed: number
  failed: number
  /** Test count of the last run of the same command: the bar's denominator. */
  expected?: number
  exitCode?: number | null
  /** Last output line, shortened. */
  note?: string
}

export type TaskRun = {
  id: string
  kind: 'bash' | 'gate'
  title: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  etaMs?: number
  agentId?: string
  steps: RunStep[]
}

// --- PRs: the session's GitHub PRs and their checks, taken over from the pr-status mod

export type PrCheckState = 'pass' | 'fail' | 'running' | 'pending' | 'neutral'

export type PrCheck = {
  name: string
  /** Empty for a status context (an external check): drawn as "Extern". */
  workflow: string
  state: PrCheckState
  startedAt: string | null
  completedAt: string | null
  url: string | null
}

// waiting: pushed, GitHub has no checks for the new head yet
// running: at least one check runs or is queued
// done: every check finished, polled slowly for the next push
// closed: merged or closed, no more polling
export type PrPhase = 'waiting' | 'running' | 'done' | 'closed'

export type Pr = {
  number: number
  title: string
  url: string
  /** owner/name, from the URL. */
  repo: string
  state: string
  isDraft: boolean
  review: string
  merge: string
  headSha: string
  head: string
  base: string
  checks: PrCheck[]
  phase: PrPhase
}

// /fertig, taken over from the pr-status mod.
// waiting: armed, the checks decide
// merging: gh pr merge runs
// merged: the merge is through, the cleanup waits for the running turn
// cleaning: the worktree is being taken down
// done, stopped: over; note says why
export type FinishStage = 'waiting' | 'merging' | 'merged' | 'cleaning' | 'done' | 'stopped'

export type Finish = {
  url: string
  number: number
  sha: string
  stage: FinishStage
  note: string
  armedAt: number
  skipReview: boolean
  skipChecks: boolean
  /** Stopped on the review alone: the one stop the button offers a way past. */
  isReviewStop: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'goal-meter': {
      goal: Goal | null
      now: number
      isBandHidden: boolean
      mode: Mode
      isMuted: boolean
      isTurnRunning: boolean
      agents: Agent[]
      quotaSamples: QuotaSample[]
      alerted: string[]
      etaFactor: number
      model: ModelInfo | null
      runs: Shaped<TaskRun[]>
      runsAutoOpened: boolean
      isDoneTasksCollapsed: boolean
      isDoneRunsCollapsed: boolean
      nudge: { at: number; calls: number }
      planSynced: string
      prs: Shaped<Pr[]>
      prCheckedAt: number
      /** The PR whose checks show; null: the most urgent one. */
      prFocus: string | null
      isDonePrsCollapsed: boolean
      finish: Shaped<Finish | null>
      /** The PR whose Fertig button was pressed once: a second press within 5 s starts /fertig. */
      finishConfirm: string | null
      /** PRs hidden from the band with ×, as "url@headSha": a new commit brings them back. */
      prHidden: string[]
    }
  }
}
