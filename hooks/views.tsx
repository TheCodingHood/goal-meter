import type { Elements, SessionUsage } from 'claude-code'

import type { Agent, Goal, Mode, ModelInfo, QuotaSample, RunStatus, RunStep, RunStepStatus, Step, TaskRun } from '../types'
import {
  deadlineState,
  displayWidth,
  estimate,
  formatClock,
  formatDuration,
  formatUsd,
  modelText,
  progress,
  quotaLabel,
  slices,
  truncate,
} from './meter'
import { PALETTE, STATUS_COLOR, gradientAt, icon, taskColor } from './palette'
import { exhaustAt } from './quota'
import { RUN_GLYPH, isVisible, runFraction, stepFraction } from './tasks'

// Box, Text and Button take the same props on every surface this mod draws on.
export type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

export type View = {
  els: Els
  goal: Goal | null
  now: number
  cols: number
  usage: SessionUsage | null
  samples: readonly QuotaSample[]
  agents: readonly Agent[]
  factor: number
  model: ModelInfo | null
  runs: readonly TaskRun[]
}

export type Actions = {
  continueTask: (title: string) => void
  togglePause: () => void
  setMode: (mode: Mode) => void
  toggleMute: () => void
}

const WARN = '#ef4444'

const blinkOn = (now: number) => Math.floor(now / 500) % 2 === 0

// The windows that would run out before the goal is done.
export const quotaWarnings = (v: View): { kind: string; at: number }[] => {
  if (v.goal === null || v.goal.doneAt !== null) return []
  const eta = estimate(v.goal, v.now, v.factor).etaAt
  if (eta === null) return []

  return (v.usage?.rateLimits ?? []).flatMap(limit => {
    const at = exhaustAt(v.samples, limit, v.now)
    return at !== null && at < eta ? [{ kind: limit.kind, at }] : []
  })
}

const StackedBar = (v: View, goal: Goal, width: number) => {
  const { Box, Text } = v.els
  const isOn = blinkOn(v.now)

  return slices(goal, width).map(slice => (
    <Box>
      <Text color={taskColor(slice.task)}>{'█'.repeat(slice.done)}</Text>
      <Text color={taskColor(slice.task)} dimColor={!isOn}>
        {(isOn ? '▓' : '░').repeat(slice.running)}
      </Text>
      <Text color="subtle">{'░'.repeat(slice.empty)}</Text>
    </Box>
  ))
}

const deadlineText = (v: View, goal: Goal): { text: string; color: string } | null => {
  const d = deadlineState(goal, v.now, v.factor)
  if (d.kind === 'none') return null
  if (d.kind === 'unknown') return { text: ` · Frist ${formatClock(d.at)}`, color: 'subtle' }
  if (d.kind === 'on-time') return { text: ` · Frist hält ${formatClock(d.at)}`, color: PALETTE.done }

  return { text: ` · Frist verfehlt um ~${formatDuration(d.byMs)}`, color: WARN }
}

const runningAgents = (v: View) => v.agents.filter(a => a.doneAt === null)

const ModelTag = (v: View, gap: string) => {
  const { Text } = v.els

  return v.model === null ? null : <Text color={PALETTE.header}>{`${gap}◆ ${modelText(v.model)}`}</Text>
}

// --- band above the prompt -------------------------------------------------

export const Band = (v: View) => {
  const { Box, Text } = v.els
  const limits = v.usage?.rateLimits ?? []
  const quotaParts = limits.map((limit, k) => {
    const used = Math.min(100, Math.max(0, limit.percentUsed))
    const width = 8
    const cells = Math.round((used / 100) * width)
    const color = gradientAt(1 - used / 100)
    return (
      <Box>
        <Text dimColor>{`${k > 0 ? '  ' : ''}${quotaLabel(limit.kind)} `}</Text>
        <Text color={color}>{'█'.repeat(cells)}</Text>
        <Text color="subtle">{'░'.repeat(width - cells)}</Text>
        <Text bold color={color}>{` ${Math.round(limit.percentUsed)}%`}</Text>
      </Box>
    )
  })
  const goal = v.goal
  if (goal === null) {
    return (
      <Box>
        {quotaParts}
        {ModelTag(v, quotaParts.length > 0 ? '  ' : '')}
      </Box>
    )
  }

  const { done, total, ratio } = progress(goal)
  const { remainingMs, etaAt } = estimate(goal, v.now, v.factor)
  const isGoalDone = goal.doneAt !== null
  const pctText = ` ${Math.round(ratio * 100)}%`
  const eta = isGoalDone
    ? ' erreicht ✔'
    : goal.isPaused
      ? ' Pause'
      : remainingMs === null || etaAt === null
        ? ' schätze…'
        : ` fertig ${formatClock(etaAt)}`
  const title = truncate(goal.title, Math.min(28, Math.max(8, Math.floor(v.cols / 4))))
  const barWidth = Math.max(10, v.cols - displayWidth(title) - pctText.length - displayWidth(eta) - 3)
  const runIndex = goal.tasks.findIndex(task => task.status === 'in_progress')
  const index = runIndex >= 0 ? runIndex : goal.tasks.findIndex(task => task.status === 'pending')
  const current = index >= 0 ? goal.tasks[index] : undefined
  const warnings = quotaWarnings(v)
  const agents = runningAgents(v)
  const deadline = deadlineText(v, goal)

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={isGoalDone ? PALETTE.done : 'claude'}>{`${title} `}</Text>
        {StackedBar(v, goal, barWidth)}
        <Text bold color={gradientAt(ratio)}>{pctText}</Text>
        <Text color={isGoalDone ? PALETTE.done : goal.isPaused ? 'subtle' : PALETTE.eta} bold>
          {eta}
        </Text>
      </Box>
      <Box justifyContent="space-between">
        <Box>
          {current !== undefined && (
            <Box>
              <Text color={STATUS_COLOR[current.status]} bold>{`${icon(current.status, v.now)} `}</Text>
              <Text color={taskColor(index)} bold>{`${index + 1}/${goal.tasks.length} `}</Text>
              <Text color={taskColor(index)} wrap="truncate-end">
                {current.title}
              </Text>
            </Box>
          )}
          {current === undefined && <Text dimColor>{`${done}/${total} Teilaufgaben erledigt`}</Text>}
          {agents.length > 0 && <Text color={PALETTE.remaining}>{` · ${agents.length} Agent(s) aktiv`}</Text>}
          {deadline !== null && <Text color={deadline.color}>{deadline.text}</Text>}
        </Box>
        <Box>
          {quotaParts}
          {ModelTag(v, '  ')}
        </Box>
      </Box>
      {warnings.map(w => (
        <Text color={WARN} bold>
          {`! Kontingent ${quotaLabel(w.kind)} evtl. leer um ${formatClock(w.at)}, vor dem Ziel`}
        </Text>
      ))}
    </Box>
  )
}

// --- pane --------------------------------------------------------------------

const Agents = (v: View) => {
  const { Box, Text } = v.els
  if (v.agents.length === 0) return null

  return (
    <Box flexDirection="column">
      <Text color={PALETTE.header} bold>
        Agents
      </Text>
      {v.agents.map(agent => {
        const status = agent.doneAt === null ? 'in_progress' : 'done'
        return (
          <Box justifyContent="space-between">
            <Box>
              <Text color={STATUS_COLOR[status]}>{`${icon(status, v.now)} `}</Text>
              <Text dimColor={status === 'done'} wrap="truncate-end">
                {agent.description}
              </Text>
              <Text dimColor>{` (${agent.type})`}</Text>
            </Box>
            <Text dimColor>{` ${formatDuration((agent.doneAt ?? v.now) - agent.startedAt)}`}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

// --- Tasks: long Bash calls and gates, in the meter's look -----------------------

const RUN_COLOR: Record<RunStepStatus | RunStatus, string> = {
  done: PALETTE.done,
  running: PALETTE.running,
  pending: PALETTE.pending,
  failed: WARN,
  skipped: 'subtle',
  cancelled: 'subtle',
}

const runGlyph = (status: RunStepStatus | RunStatus, now: number): string =>
  status === 'running' ? icon('in_progress', now) : RUN_GLYPH[status]

// Progress as a number only: block bars wrap on the desktop pane.
const RunBar = (v: View, frac: number | undefined, _width: number, key: string) => {
  const { Text } = v.els
  if (frac === undefined) return null
  return (
    <Text key={key} bold color={gradientAt(frac)}>
      {`${Math.floor(Math.min(1, Math.max(0, frac)) * 100)}%`}
    </Text>
  )
}

const runTime = (v: View, r: { startedAt?: number; endedAt?: number; etaMs?: number }, isLive: boolean): string => {
  if (r.startedAt === undefined) return ''
  const elapsed = formatDuration((r.endedAt ?? v.now) - r.startedAt)
  return isLive && r.etaMs ? `${elapsed} / ~${formatDuration(r.etaMs)}` : elapsed
}

const testsOf = (s: RunStep): string =>
  s.passed + s.failed > 0 ? ` · ${s.passed}${s.expected ? `/${s.expected}` : ''} ✔${s.failed ? ` ${s.failed} ✗` : ''}` : ''

const RunningRun = (v: View, r: TaskRun) => {
  const { Box, Text } = v.els
  const barW = Math.max(8, v.cols - 8)
  const who = r.agentId ? ' · Subagent' : ''
  const doneCount = r.steps.filter(s => s.status === 'done').length
  const meta =
    r.kind === 'gate'
      ? `${doneCount}/${r.steps.length} Schritte · ${runTime(v, r, true)}${who}`
      : `${runTime(v, r, true)}${who}${r.etaMs ? '' : ' · erster Lauf, keine ETA'}`
  const command = r.kind === 'bash' ? r.steps[0]?.command : undefined

  return (
    <Box key={r.id} flexDirection="column">
      <Box>
        <Text color={PALETTE.running}>{`${runGlyph('running', v.now)} `}</Text>
        <Text bold color="claude" wrap="truncate-end">
          {r.title}
        </Text>
      </Box>
      {RunBar(v, runFraction(r, v.now), barW, `${r.id}-bar`)}
      <Text dimColor wrap="truncate-end">
        {meta}
      </Text>
      {command !== undefined && command !== r.title && (
        <Text dimColor wrap="truncate-end">
          {`$ ${command}`}
        </Text>
      )}
      {r.kind === 'gate' &&
        r.steps.map((s, i) => {
          const isLive = s.status === 'running'
          const time = s.startedAt !== undefined ? ` · ${runTime(v, s, isLive)}` : ''
          return (
            <Box key={`${r.id}-${i}`} flexDirection="column">
              <Box>
                <Text color={RUN_COLOR[s.status]}>{`  ${runGlyph(s.status, v.now)} `}</Text>
                <Text
                  color={isLive ? undefined : RUN_COLOR[s.status]}
                  dimColor={s.status === 'pending' || s.status === 'skipped'}
                  wrap="truncate-end"
                >
                  {s.name}
                </Text>
                <Text dimColor>{`${time}${testsOf(s)}`}</Text>
              </Box>
              {isLive && (
                <Box>
                  <Text>{'    '}</Text>
                  {RunBar(v, stepFraction(s, v.now), Math.max(6, barW - 4), `${r.id}-${i}-bar`)}
                </Box>
              )}
              {isLive && s.note && (
                <Text dimColor wrap="truncate-end">
                  {`    ${s.note}`}
                </Text>
              )}
            </Box>
          )
        })}
    </Box>
  )
}

export const Tasks = (v: View) => {
  const { Box, Text } = v.els
  const shown = v.runs.filter(r => isVisible(r, v.now))
  if (shown.length === 0) return null
  const running = shown.filter(r => r.status === 'running')
  const finished = shown.filter(r => r.status !== 'running').reverse()
  const counts = [running.length > 0 ? `${running.length} läuft` : '', finished.length > 0 ? `${finished.length} fertig` : '']
    .filter(Boolean)
    .join(' · ')

  return (
    <Box flexDirection="column">
      <Box>
        <Text backgroundColor={PALETTE.header} color={PALETTE.onHeader} bold>
          {' TASKS '}
        </Text>
        <Text dimColor>{` ${counts}`}</Text>
      </Box>
      {running.map(r => RunningRun(v, r))}
      {finished.map(r => (
        <Box key={r.id}>
          <Text color={RUN_COLOR[r.status]}>{`${RUN_GLYPH[r.status]} `}</Text>
          <Text dimColor={r.status === 'done'} color={r.status === 'done' ? undefined : RUN_COLOR[r.status]} wrap="truncate-end">
            {r.title}
          </Text>
          <Text dimColor>
            {` · ${runTime(v, r, false)}${r.kind === 'gate' ? ` · ${r.steps.filter(s => s.status === 'done').length}/${r.steps.length}` : ''}${r.agentId ? ' · Subagent' : ''}`}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

export const Pane = (v: View, a: Actions) => {
  const { Box, Button, Text } = v.els
  const badge = (
    <Text backgroundColor={PALETTE.header} color={PALETTE.onHeader} bold>
      {' GOAL '}
    </Text>
  )
  const goal = v.goal

  if (goal === null) {
    if (v.runs.some(r => isVisible(r, v.now))) {
      return (
        <Box flexDirection="column" backgroundColor={PALETTE.paneBg} paddingX={1}>
          {Tasks(v)}
          <Text> </Text>
          {Agents(v)}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" backgroundColor={PALETTE.paneBg} paddingX={1}>
        <Box justifyContent="space-between">
          <Box>
            {badge}
            <Text dimColor> noch kein Ziel — /goal-meter &lt;Ziel&gt;</Text>
          </Box>
        </Box>
        <Text> </Text>
        {Agents(v)}
      </Box>
    )
  }

  const now = v.now
  const { done, total, ratio } = progress(goal)
  const { elapsedMs, activeMs, remainingMs, etaAt } = estimate(goal, now, v.factor)
  const isGoalDone = goal.doneAt !== null
  const pctText = ` ${Math.round(ratio * 100)}%`
  const isOn = blinkOn(now)
  const spent = v.usage?.cost !== undefined && goal.costStart !== null ? Math.max(0, v.usage.cost.usd - goal.costStart) : null
  const deadline = deadlineText(v, goal)
  const stepTime = (step: Step): string =>
    step.startedAt === null ? '' : formatDuration((step.doneAt ?? now) - step.startedAt)
  const dots = (subs: readonly Step[]) =>
    subs.map(sub => (
      <Text color={STATUS_COLOR[sub.status]}>{sub.status === 'done' ? '●' : sub.status === 'in_progress' ? '◉' : '·'}</Text>
    ))

  return (
    <Box flexDirection="column" backgroundColor={PALETTE.paneBg} paddingX={1}>
      <Box justifyContent="space-between">
        <Box>
          {badge}
          <Text bold color={isGoalDone ? PALETTE.done : 'claude'} wrap="truncate-end">
            {` ${goal.title}`}
          </Text>
          {goal.source === 'tasks' && <Text dimColor> (aus Task-Liste)</Text>}
        </Box>
      </Box>
      <Box>
        <Text bold color={gradientAt(ratio)}>{pctText.trim()}</Text>
      </Box>
      <Box>
        <Text dimColor>{`${done}/${total} · `}</Text>
        <Text color={PALETTE.elapsed}>{`Aktiv ${formatDuration(activeMs || elapsedMs)}`}</Text>
        <Text dimColor>{activeMs > 0 ? ` (gesamt ${formatDuration(elapsedMs)})` : ''}</Text>
        {isGoalDone ? (
          <Text bold color={PALETTE.done}> · erreicht ✔</Text>
        ) : goal.isPaused ? (
          <Text color="subtle"> · pausiert</Text>
        ) : remainingMs === null || etaAt === null ? (
          <Text color={PALETTE.remaining}> · schätze…</Text>
        ) : (
          <Box>
            <Text color={PALETTE.remaining}>{` · Rest ~${formatDuration(remainingMs)}`}</Text>
            <Text color={PALETTE.eta} bold>{` · fertig ${formatClock(etaAt)}`}</Text>
          </Box>
        )}
        {spent !== null && <Text color={PALETTE.header}>{` · ${formatUsd(spent)}`}</Text>}
        {deadline !== null && <Text color={deadline.color}>{deadline.text}</Text>}
      </Box>
      {v.factor !== 1 && <Text dimColor>{`ETA nach Verlauf korrigiert ×${v.factor.toFixed(2)}`}</Text>}
      {goal.tasks.map((task, i) => {
        const isOpen = task.status === 'in_progress' && task.subtasks.length > 0
        const title = (
          <Text
            color={task.status === 'pending' ? 'text' : taskColor(i)}
            bold={task.status === 'in_progress'}
            dimColor={task.status === 'pending'}
            wrap="truncate-end"
          >
            {` ${task.title}`}
          </Text>
        )
        return (
          <Box flexDirection="column">
            <Box justifyContent="space-between">
              <Box>
                <Text color={STATUS_COLOR[task.status]} bold>{`${icon(task.status, now)} `}</Text>
                <Text color={taskColor(i)} dimColor={task.status === 'in_progress' && !isOn}>
                  {task.status === 'pending' ? '░' : '█'}
                </Text>
                <Text color={taskColor(i)} bold>{` ${i + 1}.`}</Text>
                {task.status === 'done' ? (
                  title
                ) : (
                  <Button key={`task-${i}`} plain onPress={() => a.continueTask(task.title)}>
                    {title}
                  </Button>
                )}
              </Box>
              <Box>
                {!isOpen && dots(task.subtasks)}
                <Text color={STATUS_COLOR[task.status]} dimColor={task.status !== 'in_progress'}>
                  {stepTime(task) ? ` ${stepTime(task)}` : ''}
                </Text>
                <Text dimColor>{task.costUsd !== null ? ` ${formatUsd(task.costUsd)}` : ''}</Text>
              </Box>
            </Box>
            {isOpen &&
              task.subtasks.map((sub, j) => (
                <Box>
                  <Text color="subtle">{j === task.subtasks.length - 1 ? '  └ ' : '  ├ '}</Text>
                  <Text color={STATUS_COLOR[sub.status]}>{`${icon(sub.status, now)} `}</Text>
                  <Text
                    color={sub.status === 'pending' ? 'text' : taskColor(i)}
                    dimColor={sub.status !== 'in_progress'}
                    strikethrough={sub.status === 'done'}
                    wrap="truncate-end"
                  >
                    {sub.title}
                  </Text>
                </Box>
              ))}
          </Box>
        )
      })}
      {v.runs.some(r => isVisible(r, v.now)) && <Text> </Text>}
      {Tasks(v)}
      <Text> </Text>
      {Agents(v)}
    </Box>
  )
}
