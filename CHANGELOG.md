# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.7.0-de.17] - 2026-11-24

### Added
- `/fertig` in the goal meter, taken over from the pr-status mod (0.3.1, with its safer session-list check): merges the PR once it is green, takes the worktree down and archives the session. A Fertig button under each PR in the pane asks first ("Wirklich mergen?", 5 s) and turns into Stopp while the job waits; the job's stage shows under the PR. Same rules as before (release PR, draft, base, Conventional title, follow-up PR, dirty worktree, local HEAD, red check, review, settle time), now with tests. `mergeCommitRepos` setting for repositories that merge with a merge commit.
- Toasts and system notifications for a new commit, failed checks, all green, merged and closed.

### Changed
- Remove the pr-status mod: with both installed, `/fertig` is registered twice and every event is told twice.

## [0.7.0-de.16] - 2026-11-24

### Added
- PR block in the pane, taken over from the pr-status mod (read-only): the branch's GitHub PR with its checks, review and merge state, polled with `gh pr view` every 30 s while checks run and every 2 min after. Up to 5 PRs, most urgent first; only one shows its check lines, "▸ Checks" picks another; merged and closed PRs fold away. Toasts, the band and `/fertig` stay with pr-status for now, so both mods poll GitHub while both are installed.

## [0.6.0] - 2026-10-10

### Added
- The model the main loop runs on, with its reasoning effort (`Opus 5.5 · high`), in the band, the pane header and the status line. It shows after the first request and follows `/model` switches and fallbacks; subagents' models are left out.

### Changed
- The pane has a black background.

## [0.5.0] - 2026-10-10

### Added
- Follows Claude Code's own task list (`TodoWrite`, `TaskCreate`, `TaskUpdate`) when the meter's `update` tool is not in use.
- Active time: the clock runs only while a turn is working, shown next to wall time; `/goal-meter pause` and `resume`.
- ETA calibrated from history: the median of actual over predicted time of finished goals, kept between 0.5 and 2.
- `/goal-meter deadline HH:MM`, with on time or late shown in the band, the pane and the status line.
- Cost per goal and per task.
- Quota forecast (`5 ชม. หมดราว 15:40`), a red warning when a window would run out before the goal is done, and alerts with sound at 80% and 90%.
- Subagents in the pane while they run, and their count in the band and status line.
- `/goal-meter report` (Markdown summary) and `/goal-meter history` (finished goals).
- A goal in progress carries over to the next session.
- Pane buttons: press a task to ask Claude to continue it; pause, mode and sound buttons (`p`, `m`, `s`).
- Sounds when a goal is reached and on quota alerts; `/goal-meter sound on | off`.
- `/goal-meter help`.

### Changed
- The code is split into `views.tsx`, `quota.ts`, `report.ts` and `state.ts`.

## [0.4.0] - 2026-10-10

### Added
- A two-row band above the prompt: goal, stacked progress bar, ETA, the task in progress and the quota.
- `/goal-meter hide` hides the band; `/goal-meter pane` opens the full pane.
- `/goal-meter mode status | panel | both` picks where the meter shows, remembered across sessions (default `both`).
- The status line names the task in progress.

### Changed
- In `status` mode the pane no longer opens by itself.

## [0.3.0] - 2026-10-09

### Added
- Claude usage quota in the pane: the 5-hour and weekly windows side by side on one row, each with a bar, percent used and time until it resets, plus context fill and session cost below.
- Quota in the status line (`5 ชม. 47% · สัปดาห์ 24%`), kept current as the engine measures the session.

## [0.2.0] - 2026-10-09

### Added
- A color for each main task, used in its row, its subtasks and its stretch of the progress bar.
- A stacked progress bar across the full pane width: done work in the task's color, running work blinking, the rest gray.

### Changed
- The pane refreshes every 500 ms so running work can blink.
- Stats moved to their own line under the bar.

## [0.1.0] - 2026-10-09

### Added
- Goal meter pane with goal, main tasks and subtasks, colored status, elapsed time and ETA.
- `mcp__goal-meter__update` tool for Claude to keep the meter current.
- `/goal-meter` command to open the pane, set a goal or clear it.
- Status line summary and a toast when the goal is reached.

[0.6.0]: https://github.com/TheerasakPing/goal-meter/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/TheerasakPing/goal-meter/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/TheerasakPing/goal-meter/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/TheerasakPing/goal-meter/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/TheerasakPing/goal-meter/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/TheerasakPing/goal-meter/releases/tag/v0.1.0
