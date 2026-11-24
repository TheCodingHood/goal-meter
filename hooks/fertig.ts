// /fertig: merge the PR once it is green, take the worktree down and archive the session.
// Taken over from the pr-status mod. Only the person starts it: the command from the
// prompt, or the Fertig button in the pane pressed twice; never a tool of the model's.
// It holds no state of its own beyond the `finish` atom, so a reload or a crash between
// two steps carries on from what GitHub says.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Finish, FinishStage, Pr } from '../types'
import { isGate, judge, mergeArgs } from './finish'
import type { Facts, Judging, Verdict } from './finish'
import { PR_LINE, fetchDetail, ghBin, ghJson, latest, pollFast, prHooks, refreshPrs, repoOf, tell, toCheck, watchPr } from './pr'
import type { RawDetail } from './pr'

type On = Parameters<Register>[0]

const THREADS =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}'
const ARCHIVE = 'mcp__ccd_session_mgmt__archive_session'
export const CONFIRM_MS = 5000
// `task worktree-destroy` stays silent for minutes under parallel load.
const DESTROY_MS = 600_000
// Where the app's process may not look: `$.process.run` runs without a shell.
const BIN_DIRS = ['/opt/homebrew/bin/', '/usr/local/bin/']
const TOOL_PATH = `${BIN_DIRS.map(dir => dir.slice(0, -1)).join(':')}:/usr/bin:/bin:/usr/sbin:/sbin`
export const BUSY: readonly FinishStage[] = ['waiting', 'merging', 'merged', 'cleaning']
// Enter at the prompt, the phone, and the desktop app, which hosts the session as an SDK.
const THE_PERSON: readonly string[] = ['composer', 'bridge', 'sdk']
const FLAGS = ['stop', '--dry-run', '--ohne-review', '--ohne-checks']
const BOT_LOGIN = /coderabbit/i
const BUSY_AGENT: readonly string[] = ['pending', 'running', 'waiting']
// A poll of 30 s that cannot read GitHub this many times in a row gives up.
const UNREADABLE_POLLS = 10
// Newest first, so a session at work is near the top. 100 rows of a real account came back
// from the engine as "Error: result (51,494 characters…) exceeds maximum allowed tokens".
const SESSION_ROWS = 50

type SessionRow = { cwd: string; isRunning: boolean }

// Change the tag when Finish's fields change: it declines what an earlier version stored.
const finishAtom = atom({ plugin: 'goal-meter', key: 'finish' } as const, null as Finish | null, { shape: 'finish-1' })
const confirmAtom = atom({ plugin: 'goal-meter', key: 'finishConfirm' } as const, null as string | null)
// The same values pr.ts and register.tsx keep: the scan wants every atom in the file that reads it.
const prsAtom = atom({ plugin: 'goal-meter', key: 'prs' } as const, [], { shape: 'prs-1' })
const isTurnRunningAtom = atom({ plugin: 'goal-meter', key: 'isTurnRunning' } as const, false)

type Flags = { skipReview: boolean; skipChecks: boolean }

let isAdvancing = false
let unreadable = 0
let mergeCommitRepos: string[] = []

// --- what the pane shows -------------------------------------------------------------

/** The Fertig button's label for a PR, or null for none. */
export function finishLabel(job: Finish | null, asking: string | null, pr: Pr): string | null {
  if (job?.url === pr.url && BUSY.includes(job.stage)) return job.stage === 'waiting' ? 'Stopp' : null
  if (job?.url === pr.url && job.stage === 'done') return null
  if (job?.url === pr.url && job.stage === 'stopped' && job.isReviewStop) {
    return asking === pr.url ? 'Wirklich ohne Review?' : 'Ohne Review'
  }
  if (pr.state === 'OPEN') return asking === pr.url ? 'Wirklich mergen?' : 'Fertig'
  if (pr.state === 'MERGED') return asking === pr.url ? 'Wirklich aufräumen?' : 'Aufräumen'

  return null
}

/** The /fertig line under a PR, or null when no job is about it. */
export function finishNote(job: Finish | null, pr: Pr): { text: string; tone: 'warn' | 'error' | 'dim' } | null {
  if (job === null || job.url !== pr.url) return null
  switch (job.stage) {
    case 'waiting':
      return { text: `/fertig wartet: ${job.note === '' ? 'prüft' : job.note}`, tone: 'warn' }
    case 'merging':
      return { text: '/fertig mergt', tone: 'warn' }
    case 'merged':
      return { text: '/fertig: Aufräumen wartet auf das Ende des Turns', tone: 'warn' }
    case 'cleaning':
      return { text: '/fertig räumt auf', tone: 'warn' }
    case 'stopped':
      return { text: `/fertig gestoppt: ${job.note}`, tone: 'error' }
    case 'done':
      return { text: `/fertig: ${job.note}`, tone: 'dim' }
  }
}

// --- the person's hand: command and button --------------------------------------------

/** One press of the Fertig button: the first asks, a second within CONFIRM_MS acts; Stopp calls off. */
export async function pressFinish($: EngineInterface, pr: Pr): Promise<void> {
  const job = await read($, finishAtom)
  if (job?.url === pr.url && job.stage === 'waiting') {
    $.ui.toast(await callOff($), { timeoutMs: 8000 })
    return
  }
  if ((await read($, confirmAtom)) === pr.url) {
    await update($, confirmAtom, () => null)
    const skipReview = job?.url === pr.url && job.stage === 'stopped' && job.isReviewStop
    $.ui.toast(await start($, pr.url, { skipReview, skipChecks: false }), { timeoutMs: 8000 })
    return
  }
  await update($, confirmAtom, () => pr.url)
  $.clock.after(CONFIRM_MS, () => void update($, confirmAtom, asking => (asking === pr.url ? null : asking)))
}

function describe(verdict: Verdict): string {
  if (verdict.kind === 'wait') return `wartet: ${verdict.why}`

  return verdict.kind === 'stop' ? `gestoppt: ${verdict.why.join('; ')}` : 'wird gemergt'
}

function judging(url: string, job: Flags & { armedAt: number }, now: number): Judging {
  return { now, armedAt: job.armedAt, isSquash: !mergeCommitRepos.includes(repoOf(url)), skipReview: job.skipReview, skipChecks: job.skipChecks }
}

function isSameJob(one: Finish | null, other: Finish): boolean {
  return (
    one !== null &&
    one.url === other.url &&
    one.sha === other.sha &&
    one.armedAt === other.armedAt &&
    one.skipReview === other.skipReview &&
    one.skipChecks === other.skipChecks
  )
}

async function start($: EngineInterface, url: string | null, flags: Flags): Promise<string> {
  const raw = await fetchDetail($, url)
  if (raw === null) return 'Kein PR für diesen Branch.'
  const tag = `PR #${raw.number}`
  if (raw.state === 'CLOSED') return `${tag} ist geschlossen, nichts zu tun.`
  const running = await read($, finishAtom)
  if (running !== null && BUSY.includes(running.stage)) return `/fertig läuft schon für PR #${running.number}.`
  const now = await $.clock.now()
  // Read before anything is armed: what fails here must leave nothing running behind it.
  const facts = raw.state === 'MERGED' ? null : await factsOf($, raw)
  if (raw.state === 'OPEN' && facts === null) return `${tag}: GitHub nicht lesbar, /fertig läuft nicht.`
  await update($, finishAtom, () => ({
    url: raw.url,
    number: raw.number,
    sha: raw.headRefOid,
    stage: 'waiting' as const,
    note: '',
    armedAt: now,
    isReviewStop: false,
    ...flags,
  }))
  unreadable = 0
  if (!(await read($, prsAtom)).some(snap => snap.url === raw.url)) watchPr($, raw.url)
  pollFast($)
  // Off the command's hook: the prompt must not wait for a merge or a teardown.
  $.clock.after(1, () => void refreshPrs($).catch(() => undefined))
  if (facts === null) return `${tag} ist schon gemergt, räume auf.`

  return `${tag}: /fertig ${describe(judge(facts, judging(raw.url, { armedAt: now, ...flags }, now)))}`
}

async function callOff($: EngineInterface): Promise<string> {
  const job = await read($, finishAtom)
  if (job === null || !BUSY.includes(job.stage)) return 'Nichts abzubrechen.'
  if (job.stage !== 'waiting' && isAdvancing) return `PR #${job.number} wird gerade gemergt oder aufgeräumt, zu spät.`
  await update($, finishAtom, () => null)
  if (job.stage === 'waiting') return `PR #${job.number}: /fertig abgebrochen.`

  return job.stage === 'merged'
    ? `PR #${job.number}: gemergt, Aufräumen abgesagt.`
    : `PR #${job.number}: /fertig beendet, Stand bitte auf GitHub prüfen.`
}

async function dryRun($: EngineInterface, url: string | null, flags: Flags): Promise<string> {
  const raw = await fetchDetail($, url)
  if (raw === null) return 'Kein PR für diesen Branch.'
  const facts = await factsOf($, raw)
  const now = await $.clock.now()
  const verdict = facts === null ? 'GitHub nicht lesbar' : describe(judge(facts, judging(raw.url, { armedAt: now, ...flags }, now)))

  return [
    `PR #${raw.number} (${raw.state}, Probelauf, nichts wurde geändert): ${verdict}`,
    `Merge: gh ${mergeArgs(raw, raw.headRefOid, mergeCommitRepos).join(' ')}`,
    'Danach: tasks/ und audits/ sichern, task worktree-destroy, Session archivieren',
  ].join('\n')
}

// --- what GitHub and git say ------------------------------------------------------------

// In the session's root: a shell's `cd` must not point a teardown at a sibling worktree.
// A failure throws: an empty answer from a broken git must not read as a clean worktree.
async function git($: EngineInterface, ...args: string[]): Promise<string> {
  const run = await $.process.run(['git', ...args], { cwd: await $.session.root(), timeoutMs: 20_000 })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.trim().split('\n')[0]}`)

  return run.stdout
}

// Asked once up front, so a command that hangs is not started a second time elsewhere.
async function findBin($: EngineInterface, name: string): Promise<string | null> {
  for (const bin of [name, ...BIN_DIRS.map(dir => dir + name)]) {
    try {
      await $.process.run([bin, '--version'], { timeoutMs: 10_000 })
      return bin
    } catch {
      // Not on this path.
    }
  }

  return null
}

async function factsOf($: EngineInterface, raw: RawDetail): Promise<Facts | null> {
  const repo = repoOf(raw.url)
  const [owner = '', name = ''] = repo.split('/')
  const children = await ghJson<{ number: number }[]>($, ['pr', 'list', '--repo', repo, '--base', raw.headRefName, '--state', 'open', '--json', 'number'])
  const threads = await ghJson<{ data: { repository: { pullRequest: { reviewThreads: { nodes: { isResolved: boolean }[] } } } } }>($, [
    'api',
    'graphql',
    '-f',
    `query=${THREADS}`,
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-F',
    `number=${raw.number}`,
  ])
  const repository = await ghJson<{ default_branch: string }>($, ['api', `repos/${repo}`])
  if (children === null || threads === null || repository === null) return null
  const nodes = threads.data.repository.pullRequest.reviewThreads.nodes
  const checks = latest((raw.statusCheckRollup ?? []).map(toCheck))
  const workflows = checks.some(isGate) ? null : await ghJson<{ total_count: number }>($, ['api', `repos/${repo}/actions/workflows`])
  const botComment = raw.comments.filter(comment => BOT_LOGIN.test(comment.author?.login ?? '')).at(-1)?.body ?? null
  const isBotSilent = botComment === null && checks.every(isGate)

  return {
    isDraft: raw.isDraft,
    createdAt: Date.parse(raw.createdAt),
    base: raw.baseRefName,
    defaultBranch: repository.default_branch,
    title: raw.title,
    labels: raw.labels.map(label => label.name),
    merge: raw.mergeStateStatus,
    review: raw.reviewDecision,
    headSha: raw.headRefOid,
    checks,
    children: children.map(child => child.number),
    threads: nodes.filter(node => !node.isResolved).length,
    botComment,
    usesBot: isBotSilent ? await usesBot($, repo) : false,
    isDirty: (await git($, 'status', '--porcelain')).trim() !== '',
    localHead: (await git($, 'rev-parse', 'HEAD')).trim(),
    // A failed lookup counts as having CI: the cautious answer.
    hasWorkflows: workflows?.total_count !== 0,
  }
}

// Does CodeRabbit speak in this repository at all? A failed lookup says yes: the cautious answer.
async function usesBot($: EngineInterface, repo: string): Promise<boolean> {
  const recent = await ghJson<{ comments: { author: { login: string } | null }[] }[]>($, [
    'pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '5', '--json', 'comments',
  ])

  return recent === null || recent.some(pr => pr.comments.some(comment => BOT_LOGIN.test(comment.author?.login ?? '')))
}

// --- the job, one step after every poll --------------------------------------------------

async function setJob($: EngineInterface, stage: FinishStage, note: string, isReviewStop = false): Promise<void> {
  const job = await read($, finishAtom)
  // Every write draws the pane again: a poll that finds nothing new writes nothing.
  if (job !== null && (job.stage !== stage || job.note !== note || job.isReviewStop !== isReviewStop)) {
    await update($, finishAtom, current => (current === null ? null : { ...current, stage, note, isReviewStop }))
  }
}

async function advance($: EngineInterface): Promise<void> {
  if (isAdvancing) return
  isAdvancing = true
  try {
    await step($)
  } catch (error) {
    const job = await read($, finishAtom)
    if (job !== null) await halt($, job, String(error).slice(0, 200))
  } finally {
    isAdvancing = false
  }
}

async function step($: EngineInterface): Promise<void> {
  const job = await read($, finishAtom)
  if (job === null || !BUSY.includes(job.stage)) return
  const raw = await fetchDetail($, job.url)
  if (raw === null) {
    await cannotRead($, job)
    return
  }
  if (raw.state === 'MERGED') {
    unreadable = 0
    await cleanUp($, job, raw)
  } else if (raw.state === 'CLOSED') {
    await halt($, job, 'PR wurde geschlossen')
  } else if (raw.headRefOid !== job.sha) {
    await setJob($, 'stopped', `neuer Commit ${raw.headRefOid.slice(0, 7)}`)
    await tell($, `PR #${job.number} · neuer Commit ${raw.headRefOid.slice(0, 7)}, /fertig abgebrochen`)
  } else {
    const facts = await factsOf($, raw)
    if (facts === null) await cannotRead($, job)
    else {
      unreadable = 0
      await act($, job, raw, judge(facts, judging(job.url, job, await $.clock.now())))
    }
  }
}

async function cannotRead($: EngineInterface, job: Finish): Promise<void> {
  unreadable += 1
  if (unreadable >= UNREADABLE_POLLS) {
    unreadable = 0
    await halt($, job, 'GitHub seit 5 Minuten nicht lesbar, Stand bitte prüfen')
  }
}

async function act($: EngineInterface, job: Finish, raw: RawDetail, verdict: Verdict): Promise<void> {
  // Reading GitHub takes seconds: the person may have called it off, or armed anew.
  if (!isSameJob(await read($, finishAtom), job)) return
  if (verdict.kind === 'wait') await setJob($, 'waiting', verdict.why)
  else if (verdict.kind === 'stop') await halt($, job, verdict.why.join('; '), verdict.isReview === true)
  else await merge($, job, raw)
}

async function merge($: EngineInterface, job: Finish, raw: RawDetail): Promise<void> {
  await setJob($, 'merging', '')
  const run = await $.process
    .run([ghBin(), ...mergeArgs(raw, job.sha, mergeCommitRepos)], { timeoutMs: 120_000 })
    .catch((error: unknown) => ({ stderr: String(error) }))
  // gh's own verdict lies: the merge can be through with only its local aftermath failing.
  const after = await fetchDetail($, job.url)
  if (after?.state === 'MERGED') await cleanUp($, job, after)
  else await halt($, job, `Merge nicht durch: ${run.stderr.trim().split('\n')[0] || 'Stand unklar, bitte auf GitHub prüfen'}`)
}

async function halt($: EngineInterface, job: Finish, why: string, isReviewStop = false): Promise<void> {
  await setJob($, 'stopped', why, isReviewStop)
  await tell($, `PR #${job.number} · /fertig gestoppt: ${why}`)
}

async function conclude($: EngineInterface, job: Finish, note: string): Promise<void> {
  await setJob($, 'done', note)
  await tell($, `PR #${job.number} · ${note}`)
}

async function cleanUp($: EngineInterface, job: Finish, raw: RawDetail): Promise<void> {
  const agents = await $.agent.list()
  if ((await read($, isTurnRunningAtom)) || agents.some(agent => BUSY_AGENT.includes(agent.status))) {
    await setJob($, 'merged', '')
    return
  }
  await setJob($, 'cleaning', '')
  const others = (await read($, prsAtom)).filter(snap => snap.url !== job.url && snap.state === 'OPEN')
  if (others.length > 0) {
    await conclude($, job, `gemergt, Worktree bleibt: ${others.map(snap => `#${snap.number}`).join(', ')} noch offen`)
    return
  }
  if ((await git($, 'rev-parse', 'HEAD')).trim() !== raw.headRefOid) {
    await conclude($, job, 'gemergt, Worktree bleibt: er steht nicht auf dem Stand des PRs')
    return
  }
  if ((await git($, 'status', '--porcelain')).trim() !== '') {
    await halt($, job, 'gemergt, aber der Worktree hat nicht committete Änderungen, nichts aufgeräumt')
    return
  }
  const problem = await tearDown($)
  if (problem !== null) {
    await halt($, job, `gemergt, ${problem}`)
    return
  }
  await setJob($, 'done', 'gemergt und aufgeräumt')
  await tell($, `PR #${job.number} · gemergt und aufgeräumt`)
  await archive($, job)
}

function parseSessions(text: string): SessionRow[] | null {
  try {
    const rows: unknown = JSON.parse(text)
    return Array.isArray(rows) ? (rows as SessionRow[]) : null
  } catch {
    return null
  }
}

// null when no other session works in the worktree. Sessions list themselves through the
// app; where there is no app, there are none. Any other answer says nothing about them,
// and a teardown does not take that for a no.
async function otherSessionProblem($: EngineInterface, top: string): Promise<string | null> {
  const listed = await $.mcp.call('ccd_session_mgmt', 'list_sessions', { limit: SESSION_ROWS }).catch(() => null)
  if (listed === null) return null
  const first = listed.content[0]
  const text = first?.type === 'text' ? (first.text ?? '') : ''
  const sessions = listed.isError === true ? null : parseSessions(text)
  if (sessions === null) return `Sitzungsliste nicht lesbar, nichts aufgeräumt: ${text.slice(0, 100)}`

  return sessions.some(session => session.cwd === top && session.isRunning) ? 'eine andere Sitzung arbeitet im Worktree, nichts aufgeräumt' : null
}

// null when the worktree is gone or there never was one; otherwise what stands in the way.
async function tearDown($: EngineInterface): Promise<string | null> {
  const [top = '', common = ''] = (await git($, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir')).trim().split('\n')
  if (common === `${top}/.git` || !common.endsWith('/.git')) return null
  const occupied = await otherSessionProblem($, top)
  if (occupied !== null) return occupied
  const main = common.slice(0, -'/.git'.length)
  // Ignored, so gone with the worktree unless they move: the notes and raw data of the work.
  // Everything else ignored (vendor, node_modules, var, reports, .env.local) can be rebuilt.
  const kept = await git($, '-c', 'core.quotePath=false', 'ls-files', '--others', '--ignored', '--exclude-standard', '--', 'tasks', 'audits')
  for (const path of kept.split('\n').filter(Boolean)) {
    await $.process.run(['mkdir', '-p', `${main}/${path.split('/').slice(0, -1).join('/')}`])
    await $.process.run(['cp', '-n', `${top}/${path}`, `${main}/${path}`])
    if ((await $.process.run(['cmp', '-s', `${top}/${path}`, `${main}/${path}`])).exitCode !== 0) {
      return `${path} unterscheidet sich vom Hauptbaum, Worktree bleibt`
    }
  }
  const cwd = await $.session.root()
  const env = { PATH: TOOL_PATH }
  const hasTarget = await $.process.run(['grep', '-qsE', '^[[:space:]]*worktree-destroy:', 'Taskfile.yaml', 'Taskfile.yml'], { cwd })
  if (hasTarget.exitCode !== 0) return null
  const task = await findBin($, 'task')
  if (task === null) return 'task nicht gefunden, Worktree bleibt'
  const destroy = await $.process.run([task, 'worktree-destroy'], { cwd, env, timeoutMs: DESTROY_MS })
  if (destroy.exitCode !== 0) return `task worktree-destroy fehlgeschlagen: ${destroy.stderr.trim().split('\n').at(-1) ?? ''}`
  const docker = await findBin($, 'docker')
  if (docker === null) return null
  // Compose's label, not the name: the Taskfile sanitises the folder name for it.
  const label = `label=com.docker.compose.project.working_dir=${top}`
  const left = await $.process.run([docker, 'ps', '-a', '--filter', label, '--format', '{{.Names}}'], { cwd, env })
  const name = left.stdout.trim().split('\n')[0]

  return name === undefined || name === '' ? null : `Container ${name} läuft noch`
}

async function archive($: EngineInterface, job: Finish): Promise<void> {
  const refused = await $.tool
    .call({ tool: ARCHIVE, session_id: 'self', reason: `PR #${job.number} gemergt` } as never)
    .then(result => (result.deny !== undefined ? result.deny : result.isError === true ? (result.text ?? 'die App hat abgelehnt') : null))
    .catch((error: unknown) => String(error))
  if (refused !== null) {
    await setJob($, 'done', 'gemergt und aufgeräumt, Session bitte selbst archivieren')
    await tell($, `PR #${job.number} · Archivieren ging nicht: ${refused.slice(0, 160)}`)
  }
}

// --- hooks ---------------------------------------------------------------------------------

/** Called from the meter's session.start: one session.start hook per module. */
export async function startFertig($: EngineInterface): Promise<void> {
  // A first press outlives a reload in the state, its 5 s timer does not: without this,
  // one press after a reload would merge.
  await update($, confirmAtom, () => null)
  prHooks.afterPoll = () => advance($)
  prHooks.isBusy = async () => {
    const job = await read($, finishAtom)
    return job !== null && BUSY.includes(job.stage)
  }
  await $.command.register({
    name: 'fertig',
    description: 'PR mergen, sobald er grün ist, dann Worktree abbauen und Session archivieren',
    argumentHint: '[stop | --ohne-review | --ohne-checks | --dry-run] [PR-URL]',
    // `/fertig stop` must not queue behind the turn it is meant to beat.
    immediate: true,
  })
}

export function registerFertig(on: On, options: Record<string, unknown> | undefined): void {
  mergeCommitRepos = String(options?.mergeCommitRepos ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)

  // Only the person starts this: a command or a button, never a tool of the model's.
  on('command.run', { command: 'fertig' }, async ($, e) => {
    if (!THE_PERSON.includes(e.origin.kind)) return { text: '/fertig startet nur auf deine Eingabe.' }
    const words = e.args.split(/\s+/).filter(Boolean)
    // A typo must not fall through to a merge.
    const unknown = words.filter(word => !FLAGS.includes(word) && word.match(PR_LINE) === null)
    if (unknown.length > 0) return { text: `Unbekannt: ${unknown.join(' ')}. Erlaubt: ${FLAGS.join(', ')}, PR-URL.` }
    const url = words.find(word => word.match(PR_LINE) !== null) ?? null
    const flags = { skipReview: words.includes('--ohne-review'), skipChecks: words.includes('--ohne-checks') }
    if (words.includes('stop')) return { text: await callOff($) }
    if (words.includes('--dry-run')) return { text: `${await dryRun($, url, flags)}\nAuslöser: ${e.origin.kind}` }

    return { text: await start($, url, flags) }
  }).catch(($, e, next) => (next.called ? next(e) : { text: '/fertig ist fehlgeschlagen, nichts wurde gemergt.' }))
}
