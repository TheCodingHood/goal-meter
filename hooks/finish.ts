// /fertig's verdict, taken over from the pr-status mod: pure, so every rule has a test.

import type { PrCheck as Check } from '../types'
import { repoOf } from './pr'

// Registering checks takes GitHub a moment: all green right after the last one finished,
// or right after the PR was opened, may still miss a workflow that has not reported yet.
// A pull_request workflow was seen 29 s, CodeRabbit's comment 59 s after the opening.
const SETTLE_MS = 90_000
// A push reports its first checks within seconds. Past this, none are coming.
const NO_CHECKS_MS = 120_000
const MAX_WAIT_MS = 6 * 3_600_000
const BOT = /coderabbit/i
const BOT_FAILED = /^>?\s*##\s*Review failed/im
const BOT_SKIPPED = /^>?\s*##\s*Review skipped/im
const BOT_LIMITED = /^>?\s*##\s*(Rate limit exceeded|Review limit reached)/im
const BOT_BUSY = /currently processing new changes|review in progress/i
// Only what the ticket integration reads: a bot owns the rest of the PR body.
const TICKET_LINE = /^(Fixes|Closes|Part of)\s+[A-Z][A-Z0-9]*-\d+\b.*$/gm
const RELEASE_TITLE = /^chore\(.*\): release /
// A squash makes the title the changelog entry.
const CONVENTIONAL = /^[a-z]+(\([^)]+\))?!?: \S/
const RELEASE_LABEL = 'autorelease: pending'

export type Facts = {
  isDraft: boolean
  createdAt: number
  base: string
  defaultBranch: string
  title: string
  labels: string[]
  merge: string
  review: string
  headSha: string
  checks: Check[]
  children: number[]
  threads: number
  botComment: string | null
  // Only looked up when this PR has no sign of CodeRabbit: false for a repository without it.
  usesBot: boolean
  isDirty: boolean
  localHead: string
  // Only looked up when a head has no checks: false for a repository without any CI.
  hasWorkflows: boolean
}

export type Judging = { now: number; armedAt: number; isSquash: boolean; skipReview: boolean; skipChecks: boolean }

export type Verdict =
  | { kind: 'ready' }
  | { kind: 'wait'; why: string }
  | { kind: 'stop'; why: string[]; isReview?: true }

// CodeRabbit reports as a check, yet what it found is the review's business, not CI's.
export const isGate = (check: Check) => !BOT.test(check.name)
const isOpenCheck = (check: Check) => check.state === 'running' || check.state === 'pending'

function list(checks: Check[]): string {
  return checks.map(check => check.name).join(', ')
}

export function judge(facts: Facts, judging: Judging): Verdict {
  const { now, armedAt, isSquash, skipReview, skipChecks } = judging
  if (facts.labels.includes(RELEASE_LABEL) || RELEASE_TITLE.test(facts.title)) {
    return { kind: 'stop', why: ['Release-PR, mergt nur über task release-prod'] }
  }
  const gates = facts.checks.filter(isGate)
  const failed = gates.filter(check => check.state === 'fail')
  const stops = [
    ...(facts.isDraft ? ['Draft'] : []),
    ...(facts.base === facts.defaultBranch ? [] : [`Basis ist ${facts.base}, nicht ${facts.defaultBranch}`]),
    ...(isSquash && !CONVENTIONAL.test(facts.title) ? ['PR-Titel nicht Conventional, er wird zum Changelog-Eintrag'] : []),
    ...(facts.children.length > 0
      ? [`Folge-PR ${facts.children.map(number => `#${number}`).join(', ')} zeigt auf diesen Branch`]
      : []),
    ...(facts.isDirty ? ['nicht committete Änderungen im Worktree'] : []),
    ...(facts.localHead === facts.headSha ? [] : ['lokaler HEAD weicht vom PR ab']),
    ...(failed.length > 0 ? [`${list(failed)} fehlgeschlagen`] : []),
  ]
  if (stops.length > 0) {
    return { kind: 'stop', why: stops }
  }
  if (now - armedAt > MAX_WAIT_MS) {
    return { kind: 'stop', why: ['Wartezeit von 6 Stunden überschritten'] }
  }
  if (gates.some(isOpenCheck)) {
    return { kind: 'wait', why: 'Checks laufen' }
  }
  if (gates.length === 0 && !skipChecks && facts.hasWorkflows) {
    return now - armedAt < NO_CHECKS_MS
      ? { kind: 'wait', why: 'noch keine Checks für diesen Commit' }
      : { kind: 'stop', why: ['keine Checks für diesen Commit, --ohne-checks übergeht das'] }
  }
  if (!skipReview) {
    const review = reviewVerdict(facts, now - armedAt)
    if (review !== null) {
      return review
    }
  }
  const newest = Math.max(facts.createdAt, ...facts.checks.map(finishedAt))
  if (now - newest < SETTLE_MS) {
    return { kind: 'wait', why: 'letzter Check gerade fertig' }
  }
  if (facts.merge === 'UNKNOWN') {
    return { kind: 'wait', why: 'GitHub berechnet den Merge-Status' }
  }
  // UNSTABLE is what a failed optional check reports, and the checks are judged above.
  if (!['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(facts.merge)) {
    return { kind: 'stop', why: [`Merge-Status ${facts.merge}`] }
  }

  return { kind: 'ready' }
}

function reviewVerdict(facts: Facts, waited: number): Verdict | null {
  const runs = facts.checks.filter(check => BOT.test(check.name))
  if (runs.some(isOpenCheck)) {
    return { kind: 'wait', why: 'CodeRabbit läuft' }
  }
  const comment = facts.botComment ?? ''
  if (BOT_BUSY.test(comment)) {
    return { kind: 'wait', why: 'CodeRabbit läuft' }
  }
  const stops = [
    ...(facts.review === 'CHANGES_REQUESTED' ? ['Änderungen gewünscht'] : []),
    ...(facts.threads > 0 ? [`${facts.threads} ${facts.threads === 1 ? 'offener Review-Thread' : 'offene Review-Threads'}`] : []),
    ...botProblem(comment, runs),
  ]
  if (stops.length > 0) {
    return { kind: 'stop', why: stops, isReview: true }
  }
  if (facts.botComment === null && runs.length === 0 && facts.usesBot) {
    return waited < NO_CHECKS_MS
      ? { kind: 'wait', why: 'CodeRabbit hat sich noch nicht gemeldet' }
      : { kind: 'stop', why: ['CodeRabbit hat sich nicht gemeldet'], isReview: true }
  }

  return null
}

function botProblem(comment: string, runs: Check[]): string[] {
  if (BOT_FAILED.test(comment)) {
    return ['CodeRabbit-Review fehlgeschlagen']
  }
  if (BOT_SKIPPED.test(comment)) {
    return ['CodeRabbit-Review übersprungen']
  }
  if (BOT_LIMITED.test(comment)) {
    return ['CodeRabbit im Limit, kein Review']
  }

  return runs.some(run => run.state === 'fail') ? ['CodeRabbit-Check fehlgeschlagen'] : []
}

function finishedAt(check: Check): number {
  const at = Date.parse(check.completedAt ?? check.startedAt ?? '')

  return Number.isNaN(at) ? 0 : at
}

export function mergeArgs(
  pr: { number: number; title: string; url: string; body: string },
  sha: string,
  mergeCommitRepos: readonly string[],
): string[] {
  const repo = repoOf(pr.url)
  const head = ['pr', 'merge', String(pr.number), '--repo', repo]
  if (mergeCommitRepos.includes(repo)) {
    return [...head, '--merge', '--match-head-commit', sha]
  }
  const body = (pr.body.match(TICKET_LINE) ?? []).join('\n')

  return [...head, '--squash', '--match-head-commit', sha, '--subject', `${pr.title} (#${pr.number})`, '--body', body]
}
