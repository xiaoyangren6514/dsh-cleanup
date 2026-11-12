# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.3] - 2026-11-12

### Added

- **Undo after a deletion.** A fully successful trash-mode review result now offers `撤销删除`: the
  client restores each result item by its new `entryId` through `trash.restore`, replaces the summary
  with the per-entry undo result, and offers `打开回收站` on the settings surface. The result dwell
  grew from 3.2 s to 8 s and pauses while the pointer is over it or focus is inside it.
- **The Sessions list is searchable and activity-aware.** A search box filters by title, Session id
  and recorded `cwd`; the header reports `shown / total` plus matches; an empty result renders a
  localized no-match state with a clear action. A new **least recently active** sort orders by
  activity time ascending, and each row's time column is its most recent activity with the creation
  time in the `title`.
- **A summary line on the storage-cleanup page.** Workspace/session counts, trash entries and bytes,
  scheduled deletions, and `数据更新于 <generatedAt>`; the refresh button shows a spinner and
  `aria-busy` while reloading, and the Trash tab carries its entry count as a badge.
- **Trash restore now restores the DSH state.** Trash metadata moved to `version: 2` and records a
  workspace's display title and a Session's pin/archive set. `trash.restore` re-registers a restored
  workspace (`reRegistered`), puts a Session's recorded set back (`stateRestored`), and reports
  best-effort failures as `warnings` without failing the restore. A workspace entry whose original
  path came back can be restored as a copy (`restoreMode: "sibling"`, Host-generated `<name>
  (restored)`); a Session log directory still refuses that mode because renaming it breaks the DSH
  layout. Entries written by 0.6.2 and earlier (`version: 1`) remain listable, restorable and
  purgeable.
- **Deletion results carry `entryId`** for every trashed item, and the review dialog's failed state
  can trim a `TOO_MANY_TARGETS` selection to the first 64 planned targets and re-plan
  (`保留前 64 项并重新复核`) instead of dead-ending.
- **Selection is capped in the UI**: checking a 65th workspace/session is refused with an inline
  notice before a doomed plan is ever requested.

### Fixed

- **A workspace folder is no longer deleted while another Host process is writing inside it.** The
  workspace inspection now probes the persistence write lease of the stored Sessions inside the
  folder (bounded to the first 32 per pass) at plan time, at admission, and immediately before the
  mutation; a held lease is `WORKSPACE_HAS_LIVE_SESSIONS`. The inventory overview deliberately does
  not run this probe, so its rows stay cheap.
- **An effective-working-directory probe failure fails closed.** A live Agent whose
  `workingDirectory.get()` throws is no longer treated as if it still worked in its header `cwd`; the
  workspace inspection refuses instead of guessing.
- **The permanent-deletion switch is re-read at execute.** A plan produced while the switch was on
  answers `PERMANENT_DISABLED` if it is turned off before execution; the plan's stale copy is never
  trusted.
- **Settings changes have explicit effect boundaries.** A `trashRoot` change invalidates every
  retained plan (`PLAN_UNKNOWN`, a fresh review is required); `auditEnabled`/`auditMaxBytes` now
  rebuild the audit log so the new ceiling and switch apply to the next write (they previously only
  applied when `auditFile` changed); other fields leave a reviewed plan alive.
- **`plan` and `measure` observe the request signal.** The persistence listing, every directory walk
  and the per-target inspections check the caller's `AbortSignal` and answer `CANCELLED`, so closing
  a review or a settings page no longer leaves a long scan running. `measure` gained the same
  cancellation plumbing on its route.
- **A pathological Session log is refused instead of blocking the Host.** Usage folding now refuses
  a log over 50,000 events with `failed: "LOG_TOO_LARGE"` (rendered as an unknown `—`) instead of
  folding it synchronously.
- **Client requests have deadlines.** Read/view routes get 20 s, `plan`/`candidates`/`usage`/`defer`
  60 s, and `delete`/`measure` 600 s, composed with the caller's signal; a timeout is its own
  `transport: "timeout"` failure with distinct copy, and a timed-out delete tells the user it may
  still be running instead of retrying automatically.
- **Accessibility and localization polish.** One `:focus-visible` rule now covers tabs, inline row
  actions, tree/ride-along toggles and open controls; `prefers-reduced-motion` disables the spinner
  and skeleton animations; settings save warnings are localized by code (`warn.
  EXISTING_DATA_STAYS` with the localized field label) and fall back to the Host message only for an
  unknown code.

### Changed

- Docs, SPEC (§4.2–§4.5, §4.8, §4.10, §5.2, §5.3, §5.7, §8–§11), README (both languages), DETAIL
  (both languages) and the FAQ describe the new behavior, the explicit settings effect boundaries,
  the bounded cross-process workspace probe, and the best-effort restore contract.
- Test baseline grew from 489 to 515 passing tests (engine, client, usage, index); `npm run check`
  still passes (16 routes, 38 error + 28 warning codes, 507 locale keys, 29 shipped paths).

## [0.6.2] - 2026-11-12

### Changed

- **DSH 0.2.2-rc.2 verified.** The plugin was re-tested against DSH 0.2.2-rc.2 in an isolated
  `DSH_HOME`: every Host route behaved as on rc.1 (`inventory` capabilities, usage folding and
  the revision-keyed fold cache, plan -> trash -> restore, the open-folder error paths, and the
  64-target boundary), and the browser half loaded with no console errors or exceptions. No code
  change was needed: `engines.dsh: >=0.2.2-alpha.3 <0.3.0` already admits rc.2.
- README, DETAIL (both languages) and the FAQ now name DSH 0.2.2-rc.1 **and** 0.2.2-rc.2 as tested
  environments, and explain why rc.2's stricter exact-version plugin guard (which disables plugins
  pinning exact `@deepseek-ai/*` peer requirements) does not affect this plugin.
- `engines.dsh` is now written as the explicit range `>=0.2.2-alpha.3 <0.3.0` (semantically identical
  to the previous caret range, which already meant exactly that): the 0.2.2 line and future 0.2.x
  releases are accepted, while DSH 0.2.0/0.2.1 stay refused because the persistence snapshot's
  `location` field this plugin needs only exists from the 0.2.2 line.

## [0.6.1] - 2026-11-10

### Fixed

- **The Sessions tab no longer crashes while the inventory is loading.** The usage effect sat below
  an early return, so the first render (inventory still null) and the loaded render ran a different
  number of hooks; React threw and the storage-cleanup section blanked. All hooks now run
  unconditionally, with a regression test that renders both phases.
- **The usage fold cache actually works.** The reader required `eventCount` in the persistence
  snapshot, which the shipped JSONL backend never emits, so every request re-read every named log.
  The cache key now uses the snapshot's opaque `revision` (plus `sizeBytes` when present), falls back
  to `(eventCount, sizeBytes)`, and is skipped when neither exists.
- **Targets above 64 no longer dead-end a review.** Checked rows plus per-node tree logs are measured
  before the plan request; an over-budget ordinary review fails locally with `TOO_MANY_TARGETS`
  instead of sending a plan the Host would reject, and a workspace-clear batch shrinks itself and
  re-queues the rest.
- **Row and tree selection agree.** Un-checking a reviewed row clears its descendants from the
  explicit node selection, its tree renders unchecked and disabled with an explanation, and the
  family count covers only checked roots — the dialog can no longer delete logs under a row that
  says "not selected".
- **A restored Session reappears.** A trash restore schedules one follow-up session-list refresh so
  a refresh already in flight cannot swallow the restored row.
- **The opener cannot hang the route.** The Host answers once the launcher process is spawned
  instead of waiting for it to exit; on macOS `.app`/`.bundle`/`.workflow`/`.pkg` paths are revealed
  with `open -R` instead of being launched.
- **Usage retries no longer duplicate a chunk.** A failed chunk is drained from the queue before the
  retry re-enqueues it, so one retry means one request.
- **Projection-cache cleanup reports honestly.** An absent record (a Session never checkpointed)
  counts as dropped instead of reporting a failure it never had.
- **Usage requests carry the caller's abort signal** and fold at most four cold reads concurrently;
  `usage`/`failed` maps are prototype-less so an id such as `__proto__` appears as data.
- **Contract and release hygiene.** The contract check now expands the `files` globs (a renamed
  module can no longer silently drop out of the tarball), parses every plugin-manager locale file,
  scans the opener module for undocumented wire codes, and checks the documented open-kind and
  capability vocabulary. `npm test` runs `scripts/run-tests.mjs`, which expands the test glob itself
  so Node 20 and 22 behave identically; CI runs `npm test`, the contract check and
  `npm pack --dry-run`.

### Changed

- The review dialog's open-folder control is documented as single-target only and its accessible
  name uses the target title instead of a raw workspace path; usage columns gained accessible names
  and the usage sort falls back to newest-first when the Host cannot fold usage.

## [0.6.0] - 2026-11-09

### Added

- **Usage insight.** The Sessions tab gains an opt-in `用量` toggle that adds total-tokens and
  cache-hit-rate columns, an `按用量排序` option, and an own/family total for a row with
  descendants. Usage is folded from each Session's own log through the Host's `sessionQuery` seam:
  only `assistant/message` events count, the leading inherited fork prefix is excluded, and requests
  are de-duplicated by model message id. Cache read, cache miss (input + cache write), cache write,
  and output are reported, with total tokens = miss + read + output and hit rate = read / (read +
  miss). The surface is hidden with an explanation when the Host has no query seam, and an unknown
  row renders `—`, never 0.

- **The Session family as a tree.** The review dialog renders subagent descendants as a tree with
  one checkbox per node: depth-first by `parentSessionId`, indented, `子代理`/`派生` badges,
  tri-state parents (`aria-checked="mixed"`), subtree check/uncheck, `全选`/`反选`, and an explicit
  per-node target set (`includeDescendants: false`) once a node is un-checked. A workspace-clear
  batch records un-checked nodes in its exclusion set, and the `UNCHECKED_TARGET_LEAK` guard covers
  nodes. A workspace-folder sweep keeps its "also delete sessions in this folder" switch instead of
  a tree, because its Sessions are selected by path, not by id.

- **Projection-cache cleanup.** Deleting a Session now also drops its `session_projcache` record
  when the Host exposes the storage-domain service; a deleted item reports `cacheDropped: true` and
  a skipped or failed drop reports `false` without failing the deletion. `inventory` reports
  `capabilities.projectionCache`, so the missing capability is explained once instead of warning on
  every plan. The record is a disposable fold cache, never user data.

- **Instant sidebar removal.** Every successful Session deletion emits the shipped
  `api-session/removed` event, so connected Clients drop the sidebar row without a page refresh.
  Emitting is best-effort and never changes a deletion result.

- **Open in the file manager.** Workspaces rows, Sessions rows, Trash entries, the review dialog
  summary, and a Trash-header `打开缓存目录` ("Open cache folder") control call the Host's new
  `POST /api/cleanup.open` with a kind and an id — never a path. The Host resolves the directory
  itself (`workspace`, `session`, `trash`, or `cache`), answers `OPEN_UNAVAILABLE` / `OPEN_FAILED` /
  `IO_ERROR` / `TRASH_ENTRY_UNKNOWN` on failure, and the controls are hidden when the platform has no
  opener.

- **Permanent-delete prominence.** Choosing permanent mode states in the dialog that it cannot be
  undone, and that the default trash keeps the log on disk until purged.

### Changed

- Contract: two new routes, `POST /api/cleanup.usage` and `POST /api/cleanup.open`;
  `inventory.capabilities` gains `{ usage, projectionCache, openPath }`; session result items may
  carry `cacheDropped`; deleting a Session emits `api-session/removed`. SPEC §1, §3-§5, §9-§11
  document the additions.
- The READMEs and detail documents describe the new capabilities and carry a "Known limits" section;
  `docs/FAQ.md` gains usage, family-tree, cache-residue, live-deferral, and open-folder entries.
- Version 0.6.0.

### Fixed

- Deleting a Session no longer leaves its sidebar row stale until the next page refresh: the Host
  emits the shipped disposal event after the item succeeds.
- A deleted Session no longer leaves its projection-cache record behind on Hosts that expose the
  storage-domain service.

## [0.5.1] - 2026-11-09

First public release. Version `0.5.0` was consumed by the registry's staged-publishing bootstrap and
never became installable, so this release carries the same code under a fresh version.

## [0.5.0] - 2026-11-05

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
  workspace, skips logs that are open or running in this app run (counted once per Session and
  reported in the review), reviews the first plan-sized batch with the same per-Session checkboxes,
  then continues batch by batch with folded totals, per-batch progress, and a result that reports
  where the walk stopped. An un-checked Session is remembered and never swept up by a later batch.
  An empty or failed pre-flight renders inside the dialog — `没有可清理的会话`, or the ordinary
  `failed` state with `重试` — and only a malformed menu target answers with a toast. When no batch
  can run because every matched log merely waits for a restart (`clear.deletable === 0`), the rows
  open in the review with their blockers and `安排删除`, and the deferred view says how many
  Sessions are not yet included.

### Changed

- SPEC §1 now lists all three deletions, §7 documents the in-dialog pre-flight answer (only a
  malformed menu target notifies), §5.7 documents the optional `origin`/`parentSessionId` trash
  metadata, and §9/§10 document the final selection, re-plan, workspace-clear, Sessions-selection
  and Trash-id behavior.
- `locale/ui/en.json` and `locale/ui/zh.json` are regenerated as mirrors of the inline dictionaries
  (`npm run sync-locale`) and are covered by `npm run check`.
- Version 0.5.0.

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
- A workspace clear that stops early reports what is left: a refilled page that brings new
  undeletable rows ends as `blocked` with the remaining count, while a page that only repeats
  already-counted in-use Sessions drains normally; retrying resumes the walk instead of closing the
  summary, and closing the settings sheet no longer tears down an overlay review opened while that
  sheet happened to be open.

- The “select by rules” preview listed every candidate by its raw Session id. It now renders the
  same label the sidebar shows (title → `cwd` basename → short id), keeping the full id in the
  hover title and the checkbox's accessible name.

- Deleting from the storage-cleanup settings page no longer closes the settings sheet. The review
  dialog opened from that page now renders inside it, stacked above the sheet's own panel, so
  dismissing the review returns to the same tab instead of dropping the user back to the app; Escape
  closes only the dialog, and closing the sheet closes the review. Context-menu deletions keep the
  `shell.overlay` path.

- A workspace clear no longer dead-ends when a queued target has already vanished: every executed
  batch prunes the queued ids it reports as `trashed`/`deleted` (including logs an earlier batch
  removed as subagent descendants), and a batch plan that still answers `UNKNOWN_SESSION` re-reads
  the workspace and rebuilds the queue while keeping un-checked rows and folded totals; a failing
  batch rebuilds at most twice in a row (the budget resets after a successful batch or an explicit
  retry), and a rebuild that yields no targets ends normally.
- Workspace-clear skipped counts are de-duplicated per `kind:id`, so a refilled candidates page
  cannot report the same in-use Session twice or turn an already-counted page into `blocked`.
- A later clear batch whose plan brings back a Session the user un-checked re-plans without
  descendant expansion, and refuses with the client-only `UNCHECKED_TARGET_LEAK` code if the target
  still leaks; the un-checked log stays on disk, and that fallback may leave the batch's other
  subagent logs for a later clear.
- A partially completed clear no longer auto-closes: the result stays until the user closes it unless
  the walk ended with no stop reason, no failures, no skipped rows and no excluded rows.
- A permanent review whose selection grows past one workspace folder switches back to trash mode and
  explains why, instead of sending a plan the Host would reject with
  `PERMANENT_MULTIPLE_DIRECTORIES`.
- While a re-plan is in flight, a checked row that is not in the new plan yet shows `重新规划中…`
  instead of `已取消选择，不会删除`, and the totals area shows `正在重新计算复核结果…` instead of
  the previous plan's numbers.
- Un-checking a subagent row turns the descendant switch off with the reason shown next to it; if a
  re-plan still contains any un-checked target (for example one swept in by a workspace folder), the
  dialog fails closed with the client-only `UNCHECKED_TARGET_LEAK` code and sends no delete request.
- `安排删除` is built from the reviewed plan: when that plan carries no targets the dialog fails as a
  malformed Host response instead of falling back to rows the user un-checked.
- Switching the Sessions tab workspace or archive filter clears the current batch selection, so rows
  that are filtered out cannot be deleted by a batch the user cannot see.
- The Trash tab's `父会话` short id carries the full Session id in its `title`.
- `trash.list` reports `null` for an empty-string `origin`/`parentSessionId` written by a hand-edited
  or legacy `meta.json` instead of leaking `""` to API consumers.
- A review that is still deleting or queueing when the settings sheet unmounts is no longer aborted:
  the request finishes and its progress/result is shown when Settings → Storage cleanup is reopened,
  and a clean result produced during that window no longer disappears with the dwell timer; a review
  that is not in flight still closes with the sheet.
- The review dialog's and Sessions tab's group expand buttons expose `aria-controls` pointing at the
  list they expand.
- A "Clear workspace sessions…" action that receives a malformed menu target now reports
  `无法识别该工作区的菜单目标，请刷新后重试。` instead of a misleading "could not read the session
  list" toast.

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
