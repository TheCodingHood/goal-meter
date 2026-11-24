import type { Elements, RenderChildren, SessionUsage } from 'claude-code'

import type { Agent, Finish, Goal, Mode, ModelInfo, Pr, PrCheck, PrCheckState, QuotaSample, RunStatus, RunStep, RunStepStatus, Step, TaskRun } from '../types'
import {
  deadlineState,
  estimate,
  formatClock,
  formatDuration,
  formatUsd,
  progress,
  truncate,
} from './meter'
import { PALETTE, STATUS_COLOR, gradientAt, icon, taskColor } from './palette'
import { ACCENT, BLUE, DONE, FAIL, GREY, OK, headerHeight, headerSvg, markOf, rowHeight, rowSvg } from './svg'
import type { Mark, Row, Tile } from './svg'
import { finishLabel, finishNote } from './fertig'
import { cadence, countOf, focusOf, isOpenCheck, names, openByUrgency, urgency } from './pr'
import { RUN_GLYPH, isVisible, runFraction, stepFraction } from './tasks'

// Box, Text and Button take the same props on every surface this mod draws on;
// the desktop adds Svg, which draws the rows in the savvy-progress look.
export type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link'> & { Svg?: Elements['desktop']['Svg'] }

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
  isDoneTasksCollapsed: boolean
  isDoneRunsCollapsed: boolean
  prs: readonly Pr[]
  prCheckedAt: number
  prFocus: string | null
  isDonePrsCollapsed: boolean
  finish: Finish | null
  finishConfirm: string | null
}

export type Actions = {
  continueTask: (title: string) => void
  togglePause: () => void
  setMode: (mode: Mode) => void
  toggleMute: () => void
  toggleDoneTasks: () => void
  toggleDoneRuns: () => void
  refreshPrs: () => void
  /** Show this PR's checks; '' shows none, null the most urgent PR's. */
  focusPr: (url: string | null) => void
  toggleDonePrs: () => void
  /** The Fertig button: the first press asks, the second starts /fertig; Stopp calls it off. */
  pressFinish: (pr: Pr) => void
}

const WARN = '#ef4444'

const blinkOn = (now: number) => Math.floor(now / 500) % 2 === 0

const deadlineText = (v: View, goal: Goal): { text: string; color: string } | null => {
  const d = deadlineState(goal, v.now, v.factor)
  if (d.kind === 'none') return null
  if (d.kind === 'unknown') return { text: ` · Frist ${formatClock(d.at)}`, color: 'subtle' }
  if (d.kind === 'on-time') return { text: ` · Frist hält ${formatClock(d.at)}`, color: PALETTE.done }

  return { text: ` · Frist verfehlt um ~${formatDuration(d.byMs)}`, color: WARN }
}

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

// "▾ Fertig · 3": folds the finished rows away and back.
const foldLabel = (word: string, n: number, isCollapsed: boolean): string => `${isCollapsed ? '▸' : '▾'} ${word} · ${n}`

export const Tasks = (v: View, a: Actions) => {
  const { Box, Button, Text } = v.els
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
      {finished.length > 0 && (
        <Button key="done-runs" plain label={foldLabel('Fertig', finished.length, v.isDoneRunsCollapsed)} onPress={a.toggleDoneRuns} />
      )}
      {!v.isDoneRunsCollapsed && finished.map(r => (
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


// --- Desktop: the same content as SVG rows, in the savvy-progress look ----------

const RUN_MARK: Record<RunStepStatus | RunStatus, Mark> = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  pending: 'pending',
  skipped: 'skipped',
  cancelled: 'skipped',
}

const runWord = (r: TaskRun): string => `${r.kind === 'gate' ? 'Gate' : 'Bash'}${r.agentId ? ' · Subagent' : ''}`

const runRow = (v: View, r: TaskRun): Row => {
  const isLive = r.status === 'running'
  const doneSteps = r.steps.filter(s => s.status === 'done').length
  const tests = r.steps.reduce((n, s) => ({ passed: n.passed + s.passed, failed: n.failed + s.failed }), { passed: 0, failed: 0 })
  const testText = tests.passed + tests.failed > 0 ? `${tests.passed} ✓ ${tests.failed} ✗` : ''
  const statusColor = r.status === 'done' ? OK : r.status === 'failed' ? FAIL : isLive ? BLUE : GREY
  const meta = [r.kind === 'gate' ? `${doneSteps}/${r.steps.length} Schritte` : '', testText, isLive ? '' : runTime(v, r, false)]
    .filter(Boolean)
    .join(' · ')
  if (!isLive) {
    return { icon: 'shell', color: GREY, title: r.title, word: runWord(r), wordColor: statusColor, meta, mark: RUN_MARK[r.status] }
  }
  const frac = runFraction(r, v.now)
  const command = r.kind === 'bash' ? r.steps[0]?.command : r.steps.find(s => s.status === 'running')?.command
  return {
    icon: 'shell',
    color: BLUE,
    title: r.title,
    word: runWord(r),
    wordColor: BLUE,
    meta: meta || (r.etaMs ? '' : 'erster Lauf, keine ETA'),
    mark: 'running',
    bar: { ratio: frac ?? 0, isGrey: frac === undefined },
    stats: runTime(v, r, true),
    note: command !== undefined && command !== r.title ? command : undefined,
    lines:
      r.kind === 'gate'
        ? r.steps.map(s => {
            const time = s.startedAt !== undefined ? ` · ${runTime(v, s, s.status === 'running')}` : ''
            return {
              mark: RUN_MARK[s.status],
              color: s.status === 'running' ? BLUE : GREY,
              text: `${s.name}${time}${testsOf(s)}`,
              isDim: s.status === 'pending' || s.status === 'skipped',
            }
          })
        : undefined,
  }
}

const taskRow = (v: View, task: Goal['tasks'][number], i: number): Row => {
  const color = task.status === 'pending' ? GREY : taskColor(i)
  const subsDone = task.subtasks.filter(s => s.status === 'done').length
  const ms = task.startedAt === null ? 0 : (task.doneAt ?? v.now) - task.startedAt
  // "0s" and "$0.00" say nothing: a task ticked off in one go has neither.
  const meta = [
    task.subtasks.length > 0 ? `${subsDone}/${task.subtasks.length} Teilaufgaben` : '',
    ms >= 1000 ? formatDuration(ms) : '',
    task.costUsd !== null && task.costUsd >= 0.005 ? formatUsd(task.costUsd) : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const isOpen = task.status === 'in_progress' && task.subtasks.length > 0
  return {
    icon: 'crab',
    color,
    title: `${i + 1}. ${task.title}`,
    word: task.status === 'done' ? 'erledigt' : task.status === 'in_progress' ? 'läuft' : 'offen',
    wordColor: task.status === 'done' ? OK : color,
    meta,
    mark: markOf(task.status),
    isDim: task.status === 'pending',
    isWalking: task.status === 'in_progress',
    bar: isOpen ? { ratio: subsDone / task.subtasks.length } : undefined,
    lines: isOpen
      ? task.subtasks.map(sub => ({ mark: markOf(sub.status), color, text: sub.title, isDim: sub.status !== 'in_progress' }))
      : undefined,
  }
}

const agentRow = (v: View, agent: Agent): Row => {
  const isLive = agent.doneAt === null
  return {
    icon: 'crab',
    color: isLive ? ACCENT : GREY,
    title: agent.description,
    word: agent.type,
    wordColor: isLive ? ACCENT : GREY,
    meta: formatDuration((agent.doneAt ?? v.now) - agent.startedAt),
    mark: isLive ? 'running' : 'done',
    isWalking: isLive,
  }
}

// --- PRs ---------------------------------------------------------------------------

const AMBER = '#d4900a'

const CHECK_MARK: Record<PrCheckState, Mark> = {
  pass: 'done',
  fail: 'failed',
  running: 'running',
  pending: 'pending',
  neutral: 'skipped',
}

/** "#142", or "evenstep#88" for a PR in another repository than the session's first. */
const prLabel = (v: View, pr: Pr): string => {
  const home = v.prs[0]?.repo ?? pr.repo
  return `${pr.repo !== home ? (pr.repo.split('/')[1] ?? pr.repo) : ''}#${pr.number}`
}

const reviewText = (pr: Pr): string =>
  pr.review === 'APPROVED'
    ? 'Review ok'
    : pr.review === 'CHANGES_REQUESTED'
      ? 'Änderungen gewünscht'
      : pr.review === 'REVIEW_REQUIRED'
        ? 'Review offen'
        : ''

/** The coloured word, the icon colour and the mark of a PR row. */
export const prState = (pr: Pr): { word: string; wordColor: string; color: string; mark: Mark } => {
  if (pr.state === 'MERGED') return { word: 'gemergt', wordColor: ACCENT, color: ACCENT, mark: 'done' }
  if (pr.state !== 'OPEN') return { word: 'geschlossen', wordColor: GREY, color: GREY, mark: 'skipped' }
  const failed = pr.checks.filter(c => c.state === 'fail')
  if (failed.length > 0) return { word: `${names(failed)} fehlgeschlagen`, wordColor: FAIL, color: FAIL, mark: 'failed' }
  if (pr.review === 'CHANGES_REQUESTED') return { word: 'Änderungen gewünscht', wordColor: FAIL, color: FAIL, mark: 'failed' }
  if (pr.phase === 'waiting') return { word: 'warte auf Checks', wordColor: AMBER, color: GREY, mark: 'pending' }
  if (pr.phase === 'running') return { word: 'Checks laufen', wordColor: BLUE, color: BLUE, mark: 'running' }
  if (pr.merge === 'CLEAN') return { word: 'bereit zum Merge', wordColor: OK, color: OK, mark: 'done' }
  if (pr.checks.length === 0) return { word: 'keine Checks', wordColor: GREY, color: GREY, mark: 'skipped' }

  return { word: 'grün', wordColor: OK, color: OK, mark: 'done' }
}

/** "2/5 Checks · Review offen", "alle 5 grün · Review ok", or the branches of a closed PR. */
export const prMeta = (pr: Pr): string => {
  if (pr.state !== 'OPEN') return pr.head && pr.base ? `${pr.head} → ${pr.base}` : ''
  const total = pr.checks.length
  const open = pr.checks.filter(isOpenCheck).length
  const pass = countOf(pr, 'pass')
  const neutral = countOf(pr, 'neutral')
  const failed = countOf(pr, 'fail')
  const checks =
    total === 0
      ? ''
      : open > 0
        ? `${total - open}/${total} Checks`
        : failed > 0
          ? `${pass}/${total} grün`
          : `alle ${pass} grün`

  return [pr.isDraft ? 'Draft' : '', checks, neutral > 0 && open === 0 ? `${neutral} neutral` : '', pr.review === 'CHANGES_REQUESTED' ? '' : reviewText(pr)]
    .filter(Boolean)
    .join(' · ')
}

const checkTime = (c: PrCheck, now: number): string => {
  const start = c.startedAt === null ? NaN : Date.parse(c.startedAt)
  if (Number.isNaN(start)) return c.state === 'pending' ? 'wartet' : ''
  if (c.completedAt === null) return isOpenCheck(c) ? `seit ${formatDuration(Math.max(0, now - start))}` : ''

  return formatDuration(Math.max(0, Date.parse(c.completedAt) - start))
}

const prRow = (v: View, pr: Pr, isExpanded: boolean): Row => {
  const s = prState(pr)
  const total = pr.checks.length
  const open = pr.checks.filter(isOpenCheck)
  const isMoving = pr.state === 'OPEN' && (pr.phase === 'waiting' || pr.phase === 'running')
  const starts = open.map(c => (c.startedAt === null ? NaN : Date.parse(c.startedAt))).filter(t => !Number.isNaN(t))
  const since = starts.length > 0 ? `seit ${formatDuration(Math.max(0, v.now - Math.min(...starts)))}` : undefined

  return {
    icon: 'pr',
    color: s.color,
    title: `${prLabel(v, pr)} ${pr.title}`,
    word: s.word,
    wordColor: s.wordColor,
    meta: prMeta(pr),
    mark: s.mark,
    isDim: pr.state !== 'OPEN',
    bar: isMoving ? { ratio: total === 0 ? 0 : (total - open.length) / total, isGrey: pr.phase === 'waiting' } : undefined,
    stats: isMoving ? since : undefined,
    note: isMoving && pr.head ? `${pr.head} → ${pr.base}` : undefined,
    lines: isExpanded
      ? pr.checks.map(c => ({
          mark: CHECK_MARK[c.state],
          color: c.state === 'running' ? BLUE : c.state === 'fail' ? FAIL : GREY,
          text: [c.workflow || 'Extern', c.name, checkTime(c, v.now)].filter(Boolean).join(' · '),
          isDim: c.state === 'pending' || c.state === 'neutral',
        }))
      : undefined,
  }
}

/** "PR", "PR · läuft", or "PRs · 3 offen · 1 rot · 1 läuft". */
const prHeading = (v: View): string => {
  const open = openByUrgency(v.prs)
  const red = open.filter(pr => urgency(pr) <= 1).length
  const moving = open.filter(pr => pr.phase === 'running' || pr.phase === 'waiting').length
  if (v.prs.length === 1) return `PR${moving > 0 ? ' · läuft' : ''}`

  return [`PRs · ${open.length} offen`, red > 0 ? `${red} rot` : '', moving > 0 ? `${moving} läuft` : ''].filter(Boolean).join(' · ')
}

const prFooter = (v: View): string =>
  [v.prCheckedAt > 0 ? `vor ${formatDuration(Math.max(0, v.now - v.prCheckedAt))}` : '', cadence(v.prs)].filter(Boolean).join(' · ')

const closedLabel = (closed: readonly Pr[]): string => (closed.every(pr => pr.state === 'MERGED') ? 'Gemergt' : 'Abgeschlossen')

const PrsDesktop = (v: View, a: Actions, row: (key: string, r: Row) => RenderChildren) => {
  if (v.prs.length === 0) return null
  const { Box, Button, Link, Text } = v.els
  const open = openByUrgency(v.prs)
  // The PR /fertig is about stays in view once merged: its outcome is the news.
  const jobPr = v.prs.find(pr => pr.state !== 'OPEN' && v.finish?.url === pr.url)
  const closed = v.prs.filter(pr => pr.state !== 'OPEN' && pr !== jobPr).reverse()
  const focus = focusOf(v.prs, v.prFocus)
  const key = (pr: Pr) => `${pr.repo}#${pr.number}`
  const note = (pr: Pr) => {
    const n = finishNote(v.finish, pr)
    return (
      n !== null && (
        <Text key={`pr-note-${key(pr)}`} color={n.tone === 'warn' ? AMBER : n.tone === 'error' ? FAIL : undefined} dimColor={n.tone === 'dim'}>
          {n.text}
        </Text>
      )
    )
  }
  const links = (pr: Pr, isExpanded: boolean) => {
    const label = finishLabel(v.finish, v.finishConfirm, pr)
    return (
    <Box key={`pr-links-${key(pr)}`} gap={2}>
      {label !== null && <Button key={`pr-finish-${key(pr)}`} label={label} onPress={() => a.pressFinish(pr)} />}
      {pr.checks.length > 0 && (
        <Button
          key={`pr-checks-${key(pr)}`}
          plain
          label={`${isExpanded ? '▾' : '▸'} Checks · ${pr.checks.length}`}
          onPress={() => a.focusPr(isExpanded ? '' : pr.url)}
        />
      )}
      <Link key={`pr-link-${key(pr)}`} href={pr.url} label={`${prLabel(v, pr)} auf GitHub`} />
    </Box>
    )
  }

  return (
    <Box key="prs" flexDirection="column">
      <Text key="h-prs" dimColor>
        {prHeading(v)}
      </Text>
      {open.map(pr => [row(`pr-${key(pr)}`, prRow(v, pr, pr.url === focus)), note(pr), links(pr, pr.url === focus)])}
      {jobPr !== undefined && [row(`pr-${key(jobPr)}`, prRow(v, jobPr, false)), note(jobPr), links(jobPr, false)]}
      {closed.length > 0 && (
        <Button key="done-prs" plain label={foldLabel(closedLabel(closed), closed.length, v.isDonePrsCollapsed)} onPress={a.toggleDonePrs} />
      )}
      {!v.isDonePrsCollapsed && closed.map(pr => [row(`pr-${key(pr)}`, prRow(v, pr, false)), note(pr), links(pr, false)])}
      <Box key="pr-footer" gap={2}>
        <Text dimColor>{prFooter(v)}</Text>
        <Button key="pr-refresh" plain label="Neu laden" onPress={a.refreshPrs} />
      </Box>
    </Box>
  )
}

/** Terminal and phone: one line per open PR, the closed ones counted. */
const PrsText = (v: View, a: Actions) => {
  if (v.prs.length === 0) return null
  const { Box, Button, Text } = v.els
  const jobPr = v.prs.find(pr => pr.state !== 'OPEN' && v.finish?.url === pr.url)
  const open = [...openByUrgency(v.prs), ...(jobPr === undefined ? [] : [jobPr])]
  const closed = v.prs.length - open.length

  return (
    <Box flexDirection="column">
      <Text color={PALETTE.header} bold>
        {prHeading(v)}
      </Text>
      {open.map(pr => {
        const s = prState(pr)
        const meta = prMeta(pr)
        const n = finishNote(v.finish, pr)
        const label = finishLabel(v.finish, v.finishConfirm, pr)
        return (
          <Box flexDirection="column">
            <Box>
              <Text bold>{`${prLabel(v, pr)} `}</Text>
              <Text color={s.wordColor}>{s.word}</Text>
              <Text dimColor wrap="truncate-end">
                {meta ? ` · ${meta}` : ''}
              </Text>
            </Box>
            {n !== null && (
              <Text color={n.tone === 'warn' ? AMBER : n.tone === 'error' ? FAIL : undefined} dimColor={n.tone === 'dim'}>
                {`  ${n.text}`}
              </Text>
            )}
            {label !== null && <Button key={`pr-finish-${pr.repo}#${pr.number}`} plain label={`  [${label}]`} onPress={() => a.pressFinish(pr)} />}
          </Box>
        )
      })}
      {closed > 0 && <Text dimColor>{`${closed} gemergt/geschlossen`}</Text>}
    </Box>
  )
}

const PaneDesktop = (v: View, a: Actions, Svg: NonNullable<Els['Svg']>) => {
  const { Box, Button, Text } = v.els
  const W = Math.max(240, Math.min(900, v.cols * 8 - 8))
  const row = (key: string, r: Row) => (
    <Svg key={key} source={rowSvg(W, r)} alt={`${r.title}: ${r.word}${r.meta ? `, ${r.meta}` : ''}`} width={W} height={rowHeight(r)} />
  )
  const section = (key: string, label: string) => (
    <Text key={key} dimColor>
      {label}
    </Text>
  )
  const shown = v.runs.filter(r => isVisible(r, v.now))
  const running = shown.filter(r => r.status === 'running')
  const finished = shown.filter(r => r.status !== 'running').reverse()
  const tasksBlock = shown.length > 0 && (
    <Box key="tasks" flexDirection="column">
      {section('h-tasks', `Tasks${running.length > 0 ? ` · ${running.length} läuft` : ''}`)}
      {running.map(r => row(r.id, runRow(v, r)))}
      {finished.length > 0 && (
        <Button key="done-runs" plain label={foldLabel('Fertig', finished.length, v.isDoneRunsCollapsed)} onPress={a.toggleDoneRuns} />
      )}
      {!v.isDoneRunsCollapsed && finished.map(r => row(r.id, runRow(v, r)))}
    </Box>
  )
  const agentsBlock = v.agents.length > 0 && (
    <Box key="agents" flexDirection="column">
      {section('h-agents', 'Agents')}
      {v.agents.map((ag, i) => row(`agent-${i}`, agentRow(v, ag)))}
    </Box>
  )
  const prsBlock = PrsDesktop(v, a, row)
  const goal = v.goal

  if (goal === null) {
    const header = (tiles: Tile[], alt: string) => (
      <Svg key="header" source={headerSvg(W, '', null, tiles)} alt={alt} width={W} height={headerHeight('', false)} />
    )
    const spent = shown.reduce((n, r) => n + ((r.endedAt ?? v.now) - r.startedAt), 0)
    return (
      <Box flexDirection="column" gap={1}>
        {shown.length > 0
          ? header(
              [
                { label: 'Laufend', value: String(running.length) },
                { label: 'Fertig', value: String(finished.length) },
                { label: 'Zeit', value: formatDuration(spent) },
              ],
              `${running.length} laufend, ${finished.length} fertig`,
            )
          : section('empty', 'Noch kein Ziel — /goal-meter <Ziel>')}
        {prsBlock}
        {tasksBlock}
        {agentsBlock}
      </Box>
    )
  }

  const { done, total, ratio } = progress(goal)
  const { elapsedMs, activeMs, remainingMs, etaAt } = estimate(goal, v.now, v.factor)
  const isGoalDone = goal.doneAt !== null
  const doneCount = goal.tasks.filter(t => t.status === 'done').length
  const pct = `${Math.round(ratio * 100)}%`
  const tiles: Tile[] = [
    { label: 'Aufgaben', value: `${done}/${total}` },
    { label: 'Aktiv', value: formatDuration(activeMs || elapsedMs) },
  ]
  if (isGoalDone) tiles.push({ label: 'Status', value: 'erreicht ✓' })
  else if (goal.isPaused) tiles.push({ label: 'Status', value: 'pausiert' })
  else if (remainingMs === null || etaAt === null) tiles.push({ label: 'Rest', value: 'schätze…' })
  else tiles.push({ label: 'Rest', value: `~${formatDuration(remainingMs)}` }, { label: 'Fertig um', value: formatClock(etaAt) })
  const spent = v.usage?.cost !== undefined && goal.costStart !== null ? Math.max(0, v.usage.cost.usd - goal.costStart) : null
  const deadline = deadlineText(v, goal)
  const extras = [
    goal.source === 'tasks' ? 'aus Task-Liste' : '',
    spent !== null && spent >= 0.005 ? formatUsd(spent) : '',
    deadline?.text.replace(/^ · /, '') ?? '',
    v.factor !== 1 ? `ETA nach Verlauf ×${v.factor.toFixed(2)}` : '',
  ].filter(Boolean)
  const title = goal.title
  const bar = { ratio, label: pct, color: isGoalDone ? DONE : ACCENT }

  return (
    <Box flexDirection="column" gap={1}>
      <Svg
        key="header"
        source={headerSvg(W, title, bar, tiles)}
        alt={`${title}: ${pct}, ${tiles.map(t => `${t.label} ${t.value}`).join(', ')}`}
        width={W}
        height={headerHeight(title, true)}
      />
      {extras.length > 0 && section('extras', extras.join(' · '))}
      {prsBlock}
      <Box key="goal-tasks" flexDirection="column">
        {doneCount > 0 && (
          <Button key="done-tasks" plain label={foldLabel('Erledigt', doneCount, v.isDoneTasksCollapsed)} onPress={a.toggleDoneTasks} />
        )}
        {goal.tasks.map((task, i) =>
          task.status === 'done' && v.isDoneTasksCollapsed ? null : row(`task-${i}`, taskRow(v, task, i)),
        )}
      </Box>
      {tasksBlock}
      {agentsBlock}
    </Box>
  )
}

export const Pane = (v: View, a: Actions) => {
  if (v.els.Svg) return PaneDesktop(v, a, v.els.Svg)
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
          {PrsText(v, a)}
          {Tasks(v, a)}
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
        {PrsText(v, a)}
        {Agents(v)}
      </Box>
    )
  }

  const now = v.now
  const { done, total, ratio } = progress(goal)
  const { elapsedMs, activeMs, remainingMs, etaAt } = estimate(goal, now, v.factor)
  const isGoalDone = goal.doneAt !== null
  const doneCount = goal.tasks.filter(t => t.status === 'done').length
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
      {PrsText(v, a)}
      {doneCount > 0 && (
        <Button key="done-tasks" plain label={foldLabel('Erledigt', doneCount, v.isDoneTasksCollapsed)} onPress={a.toggleDoneTasks} />
      )}
      {goal.tasks.map((task, i) => {
        if (task.status === 'done' && v.isDoneTasksCollapsed) return null
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
      {Tasks(v, a)}
      <Text> </Text>
      {Agents(v)}
    </Box>
  )
}
