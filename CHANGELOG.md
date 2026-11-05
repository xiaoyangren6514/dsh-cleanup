# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The Sessions tab has a workspace filter ahead of the sort control (`全部工作区` / `未分组` / one entry
  per registered workspace). It narrows the list before sorting and restarts paging when changed.
  Membership is inherited from `parentSessionId`, so a subagent log is listed under its parent's
  workspace (and folds under it) instead of flooding `未分组`.

- The Sessions tab groups subagent logs under the Session they belong to (`展开 · N 个子代理会话`),
  matching the review dialog; a log whose parent is filtered out or past the page limit stays a
  top-level row with its `子代理` badge. Grouping is layout only — every row keeps its own checkbox,
  measure and delete controls.

- The trash records a Session's `origin` and `parentSessionId` when it is deleted and reports them
  from `trash.list`, so a subagent log stays recognizable after its parent is gone: the Trash tab
  badges it `子代理` and names its `父会话`. Entries written by older builds report both as `null`.

- The review dialog groups the plan by reviewed target: one row per Session or workspace — always
  with a checkbox, checked by default, even when the review has a single target — and its subagent
  logs (or the Sessions swept in by a folder) collapsed underneath instead of flooding the list.
  `全选` and `反选` sit above the rows, un-checking re-plans with only the checked targets, and an
  empty selection keeps every row (with its checkbox) on screen, drops the plan, shows
  `请至少选择一个目标` and disables the destructive button. A `同时删除子代理会话` switch controls
  `includeDescendants`.

- **Clear workspace sessions…** in the workspace context menu: deletes every Session log of one
  workspace in one confirmed flow while keeping the folder and its registration. It pre-flights the
  workspace, skips logs that are open or running in this app run (and says how many), reviews the
  first plan-sized batch with the same per-Session checkboxes, then continues batch by batch with
  folded totals, per-batch progress, and a result that reports where the walk stopped. An un-checked
  Session is remembered and never swept up by a later batch. Empty and failed pre-flights answer in a
  toast instead of an empty dialog; `安排删除` is withheld because it would queue one batch, not the
  workspace.

### Fixed

- **“Schedule deletion” never worked**: `deferPlan` referenced an undeclared `mutationEmitter`, so a
  successful queue write was thrown away and reported as a network failure. It now bumps the real
  mutation emitter, and the deferred result survives.

- A workspace whose Session logs are all open or running no longer dead-ends on “没有可清理的会话”: those
  rows open in the review with their blockers and the `安排删除（本次启动结束后自动执行）` action, so the
  next start does the work instead of asking the user to remember it.

- “Clear workspace sessions…” always opens its review instead of answering with a toast: a workspace
  whose logs are all open or running (or that has none) shows `没有可清理的会话` in the dialog with the
  in-use count, and a failed pre-flight keeps the dialog in its `failed` state so `重试` re-runs the
  pre-flight. Only a malformed menu target still reports through a toast.

- Un-checking a subagent row no longer lets its parent's descendant expansion delete it anyway: when a
  plan would contain an un-checked reviewed row, the dialog re-plans with `includeDescendants: false`
  so the checkbox wins.
- A workspace clear that stops early reports what is left: a refilled page with matches but nothing
  deletable ends as `blocked` with the remaining count (and still counts in-use rows as skipped),
  retrying resumes the walk instead of closing the summary, and closing the settings sheet no longer
  tears down an overlay review opened while that sheet happened to be open.

- The “select by rules” preview listed every candidate by its raw Session id. It now renders the
  same label the sidebar shows (title → `cwd` basename → short id), keeping the full id in the
  hover title and the checkbox's accessible name.

- Deleting from the storage-cleanup settings page no longer closes the settings sheet. The review
  dialog opened from that page now renders inside it, stacked above the sheet's own panel, so
  dismissing the review returns to the same tab instead of dropping the user back to the app; Escape
  closes only the dialog, and closing the sheet closes the review. Context-menu deletions keep the
  `shell.overlay` path.

## [0.4.0] - 2026-11-05

First public release.

### Added

- Deleting a registered workspace's real folder, and a Session's event log together with its
  subagent Sessions, behind plan → review → confirm.
- A recoverable trash by default, with restore and an explicit purge; every entry carries an
  ownership marker, so a `trashRoot` that points at an unrelated directory is never listed, restored,
  or deleted.
- A deferral queue for Sessions open in the current Host, applied at the next start through the same
  plan → admission → execute pipeline.
- Storage overview, rule-based Session picking, an audit log, and the read-only `cleanup_inventory`
  tool. Deletion stays a user action: the agent has no delete entry point.
- A cross-process Session write-handle probe on the immediate and the deferred path, so a log owned
  by another Host process is refused (`SESSION_LIVE`) instead of being corrupted.
- Windows support: `dsh.bundle.platforms` names `win32`, path depth is counted below the drive or UNC
  root, comparison is case-insensitive there, and the system directories come from the environment.
- Chinese as the default long-form document (`docs/DETAIL.md`), with the English edition in
  `docs/DETAIL.en.md`.

### Changed

- `execute`, trash restore, and trash purge are serialized by one mutation lock; a cancelled request
  answers `CANCELLED`.
- One plan deletes at most 1,000 Session logs, and requeue at the queue limit answers
  `DEFERRED_FULL` instead of silently dropping the oldest entry.
- The published package contains only runtime files and user documentation: no tests or build/contract
  scripts.

### Fixed

- A blocked permanent workspace deletion keeps its typed folder name, so the queued run can validate
  it instead of refusing forever.
- A Session directory that disappears after admission is reported as deleted with 0 bytes rather than
  with the bytes planned earlier.
- A zero-valued budget setting clamps to at least 1 instead of making new plans expire instantly.
- A throw from the liveness probe fails closed (`SESSION_LIVE`) instead of treating the Session as
  deletable.
- A trash entry whose payload is a symlink or a regular file is refused by restore, matching what the
  trash list reports.
