// PRs: the session's GitHub PRs and their Actions checks, read with `gh pr view`,
// drawn as a block in the pane and told as toasts. Taken over from the pr-status mod;
// /fertig lives in fertig.ts and hooks into the polling here (prHooks).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Pr, PrCheck, PrCheckState, PrPhase } from '../types'

type On = Parameters<Register>[0]

export const FAST_MS = 30_000
// After the checks finished: a cheap look at the head commit, so a push from
// anywhere (terminal, another session) starts the fast polling again.
export const SLOW_MS = 120_000
// After a `git push` the PR may still name the old head for a moment.
const PUSH_GRACE_MS = 120_000
// A repository without CI never reports a check: stop waiting after this many polls.
const EMPTY_POLLS = 10
// gh may not find a PR it has only just made: ask again on the next polls.
const ASK_TRIES = 5
// More than this would crowd the pane: the oldest closed one goes first (mergePrs).
export const MAX_PRS = 5

const FIELDS = 'number,title,url,state,isDraft,reviewDecision,mergeStateStatus,headRefOid,headRefName,baseRefName,statusCheckRollup'
// What /fertig reads on top.
const DETAIL_FIELDS = 'createdAt,labels,body,comments'
const TITLE = 'GitHub PR'
const GH = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']
// `gh pr create` prints the new PR's URL on a line of its own, as its last. A command
// that only names it, as a grep of the rules does, prints a URL inside a line at most.
export const PR_LINE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/gm
const CREATE = /\bgh\s+pr\s+create\b/
const PUSH = /\bgit\s+(-C\s+\S+\s+)?push\b/

// Change the tag when Pr's fields change: it declines what an earlier version stored.
export const prsAtom = atom({ plugin: 'goal-meter', key: 'prs' } as const, [], { shape: 'prs-1' })
// Apart from the PRs: it changes on every poll, and only the pane reads it.
export const prCheckedAtAtom = atom({ plugin: 'goal-meter', key: 'prCheckedAt' } as const, 0)
// The same value register.tsx keeps: a PR that turns red takes the checks back from a fold.
const prFocusAtom = atom({ plugin: 'goal-meter', key: 'prFocus' } as const, null)

type RawCheck = {
  __typename: 'CheckRun' | 'StatusContext'
  name?: string
  workflowName?: string
  status?: string
  conclusion?: string
  startedAt?: string
  completedAt?: string
  detailsUrl?: string
  context?: string
  state?: string
  targetUrl?: string
}

export type RawPr = {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  reviewDecision: string
  mergeStateStatus: string
  headRefOid: string
  headRefName?: string
  baseRefName?: string
  statusCheckRollup: RawCheck[] | null
}

export type RawDetail = RawPr & {
  headRefName: string
  baseRefName: string
  createdAt: string
  labels: { name: string }[]
  body: string
  comments: { author: { login: string } | null; body: string }[]
}

/** Where /fertig hooks into the polling: run after each poll, and keep it fast while busy. Set at session start. */
export const prHooks: { afterPoll: () => Promise<void>; isBusy: () => Promise<boolean> } = {
  afterPoll: async () => undefined,
  isBusy: async () => false,
}

// --- polling state: the module's own, a reload starts it over ------------------

let timer: Timer | undefined
let period = 0
let isPolling = false
let isAskedAgain = false
let looksAtBranch = false
// PRs named to be watched, not found yet.
let asked: { url: string; tries: number }[] = []
let pushedAt: number | null = null
let pushed: { url: string; sha: string; at: number } | null = null
const empty = new Map<string, { sha: string; polls: number }>()
let gh: string | null = null

// --- pure helpers ----------------------------------------------------------------

export const repoOf = (url: string): string => url.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\//)?.[1] ?? ''

export function toPr(raw: RawPr, now: number): Pr {
  const checks = latest((raw.statusCheckRollup ?? []).map(toCheck))

  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    repo: repoOf(raw.url),
    state: raw.state,
    isDraft: raw.isDraft,
    review: raw.reviewDecision ?? '',
    merge: raw.mergeStateStatus ?? '',
    headSha: raw.headRefOid,
    head: raw.headRefName ?? '',
    base: raw.baseRefName ?? '',
    checks,
    phase: phaseOf(raw, checks, now),
  }
}

function phaseOf(raw: RawPr, checks: PrCheck[], now: number): PrPhase {
  if (raw.state !== 'OPEN') return 'closed'
  if (pushed?.url === raw.url) {
    if (raw.headRefOid === pushed.sha && now - pushed.at < PUSH_GRACE_MS) return 'waiting'
    pushed = null
  }
  if (checks.length === 0) {
    const seen = empty.get(raw.url)
    const polls = seen?.sha === raw.headRefOid ? seen.polls + 1 : 1
    empty.set(raw.url, { sha: raw.headRefOid, polls })
    return polls < EMPTY_POLLS ? 'waiting' : 'done'
  }

  return checks.some(c => c.state === 'running' || c.state === 'pending') ? 'running' : 'done'
}

export function toCheck(raw: RawCheck): PrCheck {
  if (raw.__typename === 'StatusContext') {
    return {
      name: raw.context ?? '?',
      workflow: '',
      state: raw.state === 'SUCCESS' ? 'pass' : raw.state === 'FAILURE' || raw.state === 'ERROR' ? 'fail' : 'pending',
      startedAt: time(raw.startedAt),
      completedAt: null,
      url: raw.targetUrl ?? null,
    }
  }

  return {
    name: raw.name ?? '?',
    workflow: raw.workflowName ?? '',
    state: runState(raw.status, raw.conclusion),
    startedAt: time(raw.startedAt),
    completedAt: time(raw.completedAt),
    url: raw.detailsUrl ?? null,
  }
}

function runState(status: string | undefined, conclusion: string | undefined): PrCheckState {
  if (status !== 'COMPLETED') return status === 'IN_PROGRESS' ? 'running' : 'pending'
  if (conclusion === 'SUCCESS') return 'pass'

  return conclusion === 'NEUTRAL' || conclusion === 'SKIPPED' ? 'neutral' : 'fail'
}

// GitHub writes 0001-01-01 for a time that has not come yet.
function time(value: string | undefined): string | null {
  return value === undefined || value === '' || value.startsWith('0001') ? null : value
}

// A re-run lists a check twice: keep the newest of each.
export function latest(checks: PrCheck[]): PrCheck[] {
  const byKey = new Map<string, PrCheck>()
  for (const check of checks) {
    const key = `${check.workflow}/${check.name}`
    const seen = byKey.get(key)
    // A queued re-run has no start yet, and it is what the check stands at.
    const isOpen = check.state === 'running' || check.state === 'pending'
    const wasOpen = seen?.state === 'running' || seen?.state === 'pending'
    if (seen === undefined || isOpen || (!wasOpen && (check.startedAt ?? '') >= (seen.startedAt ?? ''))) byKey.set(key, check)
  }

  return [...byKey.values()]
}

/** Known PRs updated by what a poll found; a new PR takes the place of the ones that are over. */
export function mergePrs(list: readonly Pr[], fresh: readonly Pr[]): Pr[] {
  const known = list.map(snap => fresh.find(one => one.url === snap.url) ?? snap)
  const added = fresh.filter(one => !list.some(snap => snap.url === one.url))
  const out = [...known, ...added]
  // Over the cap the oldest closed PR goes first, an open one only when none is closed.
  while (out.length > MAX_PRS) {
    const closed = out.findIndex(snap => snap.state !== 'OPEN')
    out.splice(closed === -1 ? 0 : closed, 1)
  }

  return out
}

export const countOf = (pr: Pr, state: PrCheckState): number => pr.checks.filter(c => c.state === state).length
export const isOpenCheck = (c: PrCheck): boolean => c.state === 'running' || c.state === 'pending'

/** Lower is more urgent: red, then running, then waiting, then green, then closed. */
export function urgency(pr: Pr): number {
  if (pr.state !== 'OPEN') return 5
  if (pr.checks.some(c => c.state === 'fail')) return 0
  if (pr.review === 'CHANGES_REQUESTED') return 1
  if (pr.phase === 'running') return 2
  if (pr.phase === 'waiting') return 3

  return 4
}

/** Open PRs, most urgent first (stable for equal urgency). */
export const openByUrgency = (list: readonly Pr[]): Pr[] =>
  list
    .map((pr, i) => ({ pr, i }))
    .filter(x => x.pr.state === 'OPEN')
    .sort((a, b) => urgency(a.pr) - urgency(b.pr) || a.i - b.i)
    .map(x => x.pr)

/**
 * The PR whose checks show: the one the person picked ('' when they folded it), else
 * the most urgent one still in motion or red. A pick of a PR that closed falls back.
 */
export function focusOf(list: readonly Pr[], picked: string | null): string | null {
  const open = openByUrgency(list)
  if (picked === '') return null
  if (picked !== null && open.some(pr => pr.url === picked)) return picked
  const first = open[0]

  return first !== undefined && urgency(first) <= 3 ? first.url : null
}

export function names(checks: readonly PrCheck[]): string {
  const shown = checks
    .slice(0, 2)
    .map(c => c.name)
    .join(', ')

  return checks.length > 2 ? `${shown} +${checks.length - 2}` : shown
}

export function interval(list: readonly Pr[]): number {
  const open = list.filter(snap => snap.state === 'OPEN')
  if (asked.length > 0 || open.some(snap => snap.phase !== 'done')) return FAST_MS

  return open.length > 0 ? SLOW_MS : 0
}

export function cadence(list: readonly Pr[]): string {
  const ms = interval(list)
  if (ms === 0) return 'gestoppt'

  return ms === SLOW_MS ? 'alle 2 min, bis zum nächsten Push' : 'alle 30 s'
}

// --- polling ---------------------------------------------------------------------

function schedule($: EngineInterface, ms: number): void {
  if (timer !== undefined && period === ms) return
  timer?.cancel()
  timer = ms > 0 ? $.clock.every(ms, () => void refreshPrs($).catch(() => undefined)) : undefined
  period = ms
}

// One poll at a time: one asked for while another runs goes round again, so what it
// came for is not lost and no older answer overwrites a newer one.
export async function refreshPrs($: EngineInterface, options: { branch?: boolean } = {}): Promise<void> {
  looksAtBranch ||= options.branch === true
  if (isPolling) {
    isAskedAgain = true
    return
  }
  isPolling = true
  try {
    do {
      isAskedAgain = false
      await pollAll($)
    } while (isAskedAgain)
  } finally {
    isPolling = false
  }
  void prHooks.afterPoll().catch(() => undefined)
}

/** Watch a PR no poll has found yet, and poll fast. */
export function watchPr($: EngineInterface, url: string): void {
  if (!asked.some(one => one.url === url)) asked.push({ url, tries: 0 })
  schedule($, FAST_MS)
}

/** Poll fast for a while, as /fertig does while it runs. */
export function pollFast($: EngineInterface): void {
  schedule($, FAST_MS)
}

async function pollAll($: EngineInterface): Promise<void> {
  const before = await read($, prsAtom)
  const watched = before.filter(snap => snap.state === 'OPEN').map(snap => snap.url)
  const found = new Map<string, RawPr>()
  if (looksAtBranch) {
    looksAtBranch = false
    const raw = await viewPr($, null)
    // An old merged PR of the branch is no news.
    if (raw !== null && (raw.state === 'OPEN' || watched.includes(raw.url))) {
      found.set(raw.url, raw)
      const prev = before.find(snap => snap.url === raw.url)
      if (pushedAt !== null && prev !== undefined) pushed = { url: raw.url, sha: prev.headSha, at: pushedAt }
    }
    pushedAt = null
  }
  const wanted = asked
  asked = []
  for (const url of watched) {
    // Not reachable this time (network, auth): the row stays, and the next poll tries again.
    if (!found.has(url)) {
      const raw = await viewPr($, url)
      if (raw !== null) found.set(raw.url, raw)
    }
  }
  for (const one of wanted) {
    if (found.has(one.url)) continue
    const raw = await viewPr($, one.url)
    if (raw !== null) found.set(raw.url, raw)
    else if (one.tries + 1 < ASK_TRIES) asked.push({ url: one.url, tries: one.tries + 1 })
  }
  const now = await $.clock.now()
  const fresh = [...found.values()].map(raw => toPr(raw, now))
  if (fresh.length > 0) await update($, prCheckedAtAtom, () => now)
  // A poll that finds nothing new writes nothing, so the pane is not drawn again.
  const current = await read($, prsAtom)
  const next = mergePrs(current, fresh)
  if (JSON.stringify(next) !== JSON.stringify(current)) await update($, prsAtom, () => next)
  for (const snap of fresh) {
    const prev = current.find(one => one.url === snap.url)
    if (prev !== undefined) await announce($, prev, snap).catch(() => undefined)
  }
  // A newly red PR shows its checks again, whatever the person folded before.
  const isRed = (pr: Pr) => pr.state === 'OPEN' && pr.checks.some(c => c.state === 'fail')
  const wasRed = new Set(current.filter(isRed).map(pr => `${pr.url}@${pr.headSha}`))
  if (next.some(pr => isRed(pr) && !wasRed.has(`${pr.url}@${pr.headSha}`))) await update($, prFocusAtom, () => null)
  schedule($, (await prHooks.isBusy()) ? FAST_MS : interval(next))
}

function viewPr($: EngineInterface, url: string | null): Promise<RawPr | null> {
  return view<RawPr>($, url, FIELDS)
}

/** The PR with what /fertig needs to judge it: labels, body, comments, when it opened. */
export function fetchDetail($: EngineInterface, url: string | null): Promise<RawDetail | null> {
  return view<RawDetail>($, url, `${FIELDS},${DETAIL_FIELDS}`)
}

async function view<T extends RawPr>($: EngineInterface, url: string | null, fields: string): Promise<T | null> {
  const args = ['pr', 'view', ...(url === null ? [] : [url]), '--json', fields]
  for (const bin of gh === null ? GH : [gh]) {
    try {
      const run = await $.process.run([bin, ...args], { timeoutMs: 20_000 })
      gh = bin
      if (run.exitCode !== 0) return null
      const raw = JSON.parse(run.stdout) as T
      return typeof raw?.url === 'string' && typeof raw.number === 'number' ? raw : null
    } catch {
      // gh is not on this path, it hung, or it printed no JSON: try the next one.
    }
  }

  return null
}

/** The gh binary the polls found, for /fertig's own calls. */
export const ghBin = (): string => gh ?? 'gh'

export async function ghJson<T>($: EngineInterface, args: string[]): Promise<T | null> {
  try {
    const run = await $.process.run([ghBin(), ...args], { timeoutMs: 20_000 })
    return run.exitCode === 0 ? (JSON.parse(run.stdout) as T) : null
  } catch {
    return null
  }
}

// --- toasts ------------------------------------------------------------------------

async function announce($: EngineInterface, prev: Pr, snap: Pr): Promise<void> {
  const tag = `PR #${snap.number}`
  if (prev.state === 'OPEN' && snap.state === 'MERGED') return tell($, `${tag} wurde gemergt`)
  if (prev.state === 'OPEN' && snap.state === 'CLOSED') return tell($, `${tag} wurde geschlossen`)
  const isNewHead = prev.headSha !== snap.headSha
  if (isNewHead) $.ui.toast(`${tag} · neuer Commit ${snap.headSha.slice(0, 7)}, Checks laufen wieder`)
  const before = new Map(isNewHead ? [] : prev.checks.map(c => [`${c.workflow}/${c.name}`, c.state]))
  const failed = snap.checks.filter(c => c.state === 'fail' && before.get(`${c.workflow}/${c.name}`) !== 'fail')
  if (failed.length > 0) await tell($, `${tag} · ${names(failed)} fehlgeschlagen`)
  if (prev.phase !== 'done' && snap.phase === 'done' && snap.checks.length > 0 && failed.length === 0) {
    const fails = countOf(snap, 'fail')
    await tell($, fails === 0 ? `${tag} · alle ${countOf(snap, 'pass')} Checks grün` : `${tag} · Checks fertig, ${fails} fehlgeschlagen`)
  }
}

/** A toast for the screen, a system notification for when nobody is looking at it. */
export async function tell($: EngineInterface, text: string): Promise<void> {
  $.ui.toast(text, { timeoutMs: 8000 })
  const sent = await $.ui.notify(text, { title: TITLE }).catch(() => null)
  // The desktop app and some terminals have no channel of their own: macOS draws it.
  if (sent !== null && !sent.isSent && (sent.reason === 'no-surface' || sent.reason === 'no-channel')) {
    await $.process
      .run(['osascript', '-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(TITLE)}`])
      .catch(() => undefined)
  }
}

// --- hooks -------------------------------------------------------------------------

/** Called from the meter's session.start: one session.start hook per module. */
export function startPrs($: EngineInterface): void {
  // Not awaited: the first prompt should not wait on GitHub.
  $.clock.after(1, () => void refreshPrs($, { branch: true }).catch(() => undefined))
}

/** The PR's own hook: a PR made or pushed in Bash. */
export function registerPrs(on: On): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    // Nothing after the command may fail it: the command ran, its result stands.
    try {
      if (ran.deny === undefined && ran.isError !== true) {
        const url = CREATE.test(e.command) ? ran.text?.match(PR_LINE)?.at(-1) : undefined
        if (url !== undefined) {
          asked.push({ url, tries: 0 })
          schedule($, FAST_MS)
          await refreshPrs($)
        } else if (PUSH.test(e.command)) {
          pushedAt = await $.clock.now()
          schedule($, FAST_MS)
          await refreshPrs($, { branch: true })
        }
      }
    } catch {
      // GitHub unreadable: the next poll tries again.
    }

    return ran
  }).catch(($, e, next) => {
    // Never run the command twice: only a hook that failed before it called next passes on.
    if (next.called) throw next.error
    return next(e)
  })

}

/**
 * Called from the meter's turn.complete (one hook per event without a matcher): a PR
 * no Bash output named (the app's button, a subagent) is the branch's, and the turn
 * that made it ends here.
 */
export function afterTurnPrs($: EngineInterface): void {
  $.clock.after(1, () => void refreshPrs($, { branch: true }).catch(() => undefined))
}
