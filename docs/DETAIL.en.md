---
description: "Long-form description of dsh-cleanup: workspace folder and Session deletion for DeepSeek Harness, its review-first safety model, opt-in usage insight and family tree, installation, compatibility, and privacy posture."
kind: "package-bundle"
---

# dsh-cleanup — delete workspace folders and Session logs safely

[中文](https://github.com/xiaoyangren6514/dsh-cleanup/blob/main/docs/DETAIL.md) | English

`dsh-cleanup` is a bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that adds the deletions DSH deliberately leaves out:

- **Deleting a registered workspace's real folder** from disk, recursively.
- **Deleting a Session's event log**, including its subagent Sessions.
- **Clearing every Session log of one workspace**, keeping its folder and registration.

DSH itself only unregisters a workspace — the folder, its files, and its Session history stay on disk — and Sessions can only be archived, never deleted. `dsh-cleanup` fills that gap while keeping the destructive surface narrow: targets are addressed by DSH identity, never by arbitrary path; every deletion is planned, reviewed, and confirmed; and the default outcome is a recoverable trash.

- Package: `dsh-cleanup` 0.6.1
- Repository: <https://github.com/xiaoyangren6514/dsh-cleanup>
- License: MIT © 2026 fly
- Tested with: DSH 0.2.2-rc.1

## What you get

| Capability | Where it lives |
|---|---|
| Delete a registered workspace folder (recursive) | Sidebar workspace right-click → **Delete workspace folder…** |
| Delete a Session (with its subagent Session logs) | Sidebar Session right-click → **Delete Session…** |
| Clear every Session log of a workspace (the folder and its registration stay) | Sidebar workspace right-click → **Clear workspace sessions…** |
| Filter the Sessions list by workspace; subagent logs fold under the Session they belong to | Settings → Storage cleanup → Sessions |
| Check individual review targets (a checkbox per target, plus **Select all** / **Invert**) | Review dialog |
| Pick the Session family per node: subagent logs render as a tree, one checkbox per node, tri-state parent states | Review dialog |
| Opt-in usage insight: total tokens and cache-hit rate per Session, own/family totals, sort by usage | Settings → Storage cleanup → Sessions → **Usage** toggle |
| Trash entries keep the subagent family: a `Subagent` badge and a `Parent` line | Settings → Storage cleanup → Trash |
| Storage overview with sizes, bulk selection, sorting and archived filtering | Settings → **Storage cleanup** |
| Open a workspace folder, a Session folder, a trash entry, or the projection-cache directory in the file manager | Workspaces / Sessions / Trash rows, review summary, Trash header |
| A deleted Session leaves the sidebar immediately, and its projection-cache record goes with the log | Automatic, after a Session deletion |
| Recoverable trash with restore and explicit purge | Settings → Storage cleanup → **Trash** |
| Deferral queue for Sessions open in the Host, executed at the next start | Review dialog → **Schedule deletion (runs automatically after this app exits)**; manage it in Settings |
| Cleanup policy: trash location/retention/capacity, audit log, scan budget, permanent-deletion switch, Git safety check | Settings → Storage cleanup → **Cleanup settings** |
| Audit trail of deletions, skips, restores and purges, plus the last start-up run | Settings → Storage cleanup → Cleanup settings → **Recent deletions** |
| Rule-based Session picking (age, archived state, size, workspace, origin) with preview before review | Settings → Storage cleanup → Sessions → **Select by rules** |
| Read-only agent inspection of cleanable Sessions and folders | Tool `cleanup_inventory` |

**Deletion is a user action.** The only agent-facing surface is a read-only inventory tool: the model can report what exists, how large it is, and why something is blocked, but it has no way to delete anything.

### The review dialog and per-row selection

The review dialog groups the plan by *reviewed target*: one row per Session or workspace, with its subagent logs (or the Sessions swept in by a folder) collapsed underneath. Every row always carries a checkbox — a single-target review included — and rows can be checked one by one or through **Select all** / **Invert**; only checked targets enter the plan, un-checking re-plans with the remaining targets, and an empty selection keeps every row on screen with "Select at least one target" and a disabled destructive button. While a re-plan is in flight, checked rows that are not in the new plan yet read "Re-planning…" and the totals area reads "Recalculating the review…", so the previous plan is never presented as current. Permanent deletion accepts one workspace folder per plan: a selection change that crosses that limit switches back to trash with an explanation instead of sending a plan the Host would refuse. If a re-plan still contains an un-checked target (for example one swept back in by a workspace folder), the client fails closed with `UNCHECKED_TARGET_LEAK` and sends no delete request.

### The Session family tree (0.6.0)

The subagent logs inside a review are no longer a flat list: they render as a **tree**, ordered depth-first by the `parentSessionId` chain and indented one step per level. Each node shows its title and size, a `Subagent`/`Fork` badge, and its own checkbox. The target row's checkbox still means "the root target itself"; the **Also delete its subagent sessions** switch and the tree are two views of one set — switch **on** means the whole family (`includeDescendants: true`), and un-checking any node turns the switch off and submits an **explicit target set** (checked rows plus checked node ids, `includeDescendants: false`), so the Host plans exactly the named logs. Checking a node checks its subtree and un-checking it un-checks its subtree; a partially selected node renders `aria-checked="mixed"`, the group header reports "n/m logs selected", and **Select all** / **Invert** apply to rows and nodes together.

A workspace-clear batch renders the same tree, and a node un-checked there is recorded in the batch's exclusion set so a refilled candidates page cannot bring it back. **Deleting a workspace folder** has no tree: its Sessions are swept in by the "path is inside the folder" predicate, not addressed by id, so their control stays the **Also delete session logs inside this folder** switch plus the row checkbox. If a plan ever contains an item that is neither a checked row nor a checked node, the review fails closed with the client-only `UNCHECKED_TARGET_LEAK` code and sends no delete request.

### Usage insight (0.6.0)

Settings → Storage cleanup → Sessions has an opt-in **Usage** toggle (a plugin-owned `localStorage` key, off by default). When it is on and the Host supports it, every row gains two columns — **Tokens** and **Cache hit** (the rate is in the tooltip) — plus a **Largest usage** sort option, and a parent row with descendants also shows its own and family totals: own counts only the requests that Session made itself, family adds its subagent Sessions. A row whose usage is not known yet (or cannot be read) shows a muted `—`, never a zero.

Usage is folded from each Session's **own** log through the Host's query seam (`sessionQuery.readSession(id)`), never by opening the log file directly (a stored log may be compressed and is only decodable through the Host's persistence stack). Folding rules:

- Only model answers count: `assistant/message` events with a `data.usage` object; every other event contributes nothing.
- **A fork never re-counts its ancestor.** The leading `inheritedEventCount` events are the copied ancestor prefix and are skipped; a log whose inherited count covers the whole array reports zero usage of its own.
- **A request is counted once**, de-duplicated by the model message id (a repeated id is reported through `duplicateRequests`). A request without a usable id is still counted, but the result is marked `complete: false` with a reason.
- **The four buckets:** cache read (`cacheReadTokens`), cache miss (`inputTokens + cacheWriteTokens`), cache write (`cacheWriteTokens`), and output (`outputTokens`). Total tokens = miss + read + output. A cache write stays in both the miss and the write bucket so the shares never double-count and still add up to 100%.
- **Cache-hit rate = read ÷ (read + miss).**
- The Host caches at most 200 folded Sessions keyed by `(eventCount, sizeBytes)` and re-folds only when the log changes; the cache is never written to disk.
- Folding is read-only: it never opens a write handle, never makes a Session live, and one unreadable log only appears in that request's `failed` map instead of failing the whole batch.

A Host with no query seam (`inventory.capabilities.usage` is `false`) hides the usage columns and explains why; the list itself keeps working.

### Open in the file manager and the cache directory (0.6.0)

When the Host platform has a directory opener (macOS, Windows, Linux; `inventory.capabilities.openPath`), an **Open folder** control appears on workspace rows, Session rows, trash entries, the review dialog summary, and the Trash tab header (**Open cache folder**).

The call carries only a `kind` — `workspace`, `session`, `trash`, or `cache` — and an `id`, **never a path**: the Host resolves the directory itself from the id (the workspace directory, the Session directory, the trash entry directory, or `<DSH_HOME>/storages/session_projcache`) and hands it to the platform opener. The UI therefore cannot ask to open an arbitrary path, and the Host never trusts a caller-supplied one. Failures use the ordinary error copy: no opener on this platform (`OPEN_UNAVAILABLE`), the opener cannot start (`OPEN_FAILED`), the target no longer exists or cannot be read (`IO_ERROR`), an unknown trash entry (`TRASH_ENTRY_UNKNOWN`), a workspace or Session that no longer exists (`UNKNOWN_WORKSPACE` / `UNKNOWN_SESSION`). The call is fire-and-forget: the Host answers as soon as the launcher process is **spawned** (it never waits for it to exit, so a launcher that stays alive cannot hold the request open), and a file manager that does not end up focused is not a failure. The review-summary control exists only for a **single-target** review (a multi-target summary names no one directory) and its accessible name uses the target title, not the raw path. On macOS a path ending in `.app`, `.bundle`, `.workflow` or `.pkg` is an application bundle that plain `open` would **launch**, so the Host reveals it with `open -R` instead.

### Target budget for one review

One plan carries at most 64 targets (the Host's safety budget). When the checked rows plus per-node Session logs exceed it, the dialog fails **before sending any request** with the client-only code `TOO_MANY_TARGETS` and asks the user to narrow the selection or clear in batches; a workspace-clear batch never fails this way — it shrinks itself (rows + nodes <= 64) and re-queues the dropped rows for later batches. A single family larger than the budget gets the same message.

### After a deletion (0.6.0)

- **No projection-cache residue.** Once a Session's log directory is gone, the plugin also drops that Session's `session_projcache` record when the Host exposes the storage-domain service (`inventory.capabilities.projectionCache`); the item then reports `cacheDropped: true`. A missing service, a closed domain, or a throwing delete is skipped silently (`cacheDropped: false`) and never fails the deletion — the record is a disposable fold cache rebuilt on demand, not user data, so it produces no plan warning. On a Host without the capability the Trash tab's **Open cache folder** control lets the user see the leftover.
- **The sidebar updates immediately.** Every successful Session item (`trashed` or `deleted`) makes the Host emit DSH's own `api-session/removed` event, so every connected browser drops the sidebar row exactly as it does for a released Session — no page refresh. Emitting is best-effort: a minimal Host or a test context without `emit` ignores it and the deletion result does not change.

### Clearing a workspace's Sessions

"Clear workspace sessions…" deletes only the Session logs of one workspace; the folder and its registration stay untouched. It pre-flights, lets the user review the first batch (at most 64 logs), and then continues automatically batch by batch: the pre-flight lists logs opened or running in this app run as skipped and says how many (the same Session is never counted twice across refilled pages), each executed batch prunes the ids it actually removed, and a target deleted by another process makes the client re-read the workspace and rebuild the queue instead of failing the whole walk. The result auto-closes only when nothing is left over (no failures, no skipped rows, no excluded rows, no early stop); otherwise it stays until the user dismisses it. When every remaining log can only be deleted after a restart, the review offers "Schedule deletion" and the queued result reports how many are not included.

## Safety model

Four gates stand between a click and a deleted byte.

### 1. Plan before execute

A delete request first asks the Host for a *plan*: the exact targets, the files and directories they contain, total bytes, warnings (for example uncommitted Git changes), blockers (for example a live Session), and — for permanent folder deletion — the typed-name confirmation requirement. The plan is one-time and expires after 5 minutes. Execution re-validates the world first: if a target moved, changed identity, or became blocked, the Host refuses with `STATE_CHANGED` and nothing is deleted.

### 2. Trash by default

Deletions move targets to the trash under `<DSH_HOME>/trash/dsh-cleanup/` instead of erasing them, so the common mistake is recoverable. Permanent deletion is an explicit second mode; the review dialog states plainly that it **cannot be undone**, while the default trash keeps the log on disk until the user purges it. Deleting a workspace folder permanently additionally requires typing the folder name, and one permanent plan can contain at most one existing workspace folder — a single typed name must never authorize deleting another directory. Batch permanent deletion is refused; delete directories one at a time or use trash mode.

A cross-device move cannot be expressed as a rename. The plugin refuses that case and asks you to choose permanent deletion instead of silently copying gigabytes.

### 3. Only registered, canonical targets

A workspace folder can only be deleted through a workspace id from DSH's registry. Before execution the path is re-resolved (`lstat` + `realpath`) and must still equal the recorded canonical path; a symlink or a replaced directory is refused. A static path policy also refuses the filesystem root, the home directory, `~/.dsh`, the Host process working directory **and its ancestors**, the trash itself, paths containing `~/.dsh`, and paths that are too shallow to be a project.

The set of deletable things is therefore the intersection of "DSH knows it" and "the filesystem still agrees", re-checked at execution time.

### 4. Never touch a live Session

DSH keeps an Agent — and its Session write handle — alive for the whole process lifetime, and it exposes no API to release it. Deleting a Session log while that handle exists corrupts the log. The plugin therefore probes the Session persistence write handle for immediate and deferred deletions, including Sessions held by another Host process, and refuses with `SESSION_RUNNING` (actively running) or `SESSION_LIVE` (open but idle). Deleting a workspace folder is likewise blocked while any live Session's working directory is inside it.

For Sessions opened in the current Host, the review dialog offers **Schedule deletion (runs automatically after this app exits)**: the reviewed targets and options are recorded under `<DSH_HOME>/cleanup/deferred.json` and applied as early as the next Host start allows (best-effort: before the browser can resume a Session) through the same plan → admission → execute pipeline. Blocked entries are recorded with their reason instead of failing the run, and the queue can be inspected and cancelled in Settings. Plugin hot-reload inside a running process deliberately does not consume the queue.

### Bookkeeping guards

- **Trash ownership.** Trash entries carry an ownership marker. A configured `trashRoot` may only point at a directory dedicated to this plugin, and foreign directories are never listed or deleted, so pointing the trash at an unrelated folder cannot destroy its contents.
- **Self-owned state.** The deferral queue, the settings override file, and the audit log live under `<DSH_HOME>/cleanup/`, are owner-only, and are written atomically. They are user-writable state, not a security boundary.

## Install

```sh
# From npm (after publication)
dsh plugin --profile web add dsh-cleanup@0.6.1

# From GitHub, pinned to the v0.6.1 tag (a fixed commit; swap in `git rev-parse v0.6.1` for the raw sha)
dsh plugin --profile web add github:xiaoyangren6514/dsh-cleanup#v0.6.1

# From a local checkout
git clone https://github.com/xiaoyangren6514/dsh-cleanup.git
dsh plugin --profile web add ./dsh-cleanup
```

Then refresh the browser page once: the Host half hot-applies, but the browser half is a client module the page must load again. Remove the bundle with `dsh plugin --profile web remove dsh-cleanup`; the trash and `<DSH_HOME>/cleanup/` state are left in place.

A locally linked checkout must stay in place while installed, or the profile may fail to start.

### Discover and community indexes

DSH 0.2.2-rc.1 ships **no official plugin market or index**. The Discover tab is provided by the optional experimental plugin-market bundle, and no index is configured by default — users add an index URL themselves. Community-run catalogs that publish DSH plugin indexes include [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) (index at <https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json>) and [dshopen.org](https://dshopen.org). Once this package is published and listed in such an index, add the index URL and install from Discover, or use the CLI commands above.

## Requirements and compatibility

- **DSH 0.2.2-rc.1** tested; `engines.dsh: ^0.2.2-alpha.3` is enforced before install/enable, and incompatible runtimes are refused rather than half-supported.
- **Node.js ≥ 20** (Host half).
- **Web GUI** — the browser half registers through the DSH client module loader and the `shell.overlay`, `settings.section`, and `contextMenu.*` extension points.
- **macOS (`darwin`), Linux, and Windows (`win32`)** — `dsh.bundle.platforms: ["darwin", "linux", "win32"]`. On Windows the plugin works with drive roots and backslash paths: drive roots (`C:\`), the system directories (`C:\Windows`, `Program Files`, `ProgramData`), and the home directory's parent are protected, path comparison is case-insensitive, and directory depth is counted in segments below the drive root, so `C:\proj` is refused as a top-level directory just like `/proj`. Junctions, which appear as symlinks, are refused like symlinks. POSIX-only permission cases are skipped on Windows. These Windows semantics are implemented and unit-tested, but this release was validated on macOS only — see [Known limits](#known-limits).
- **Local filesystem paths** — remote or non-local filesystem providers are not understood. The trash must be on the same volume as its targets; a cross-volume move is always refused in favor of permanent deletion.

## Languages

Plugin UI copy (settings page, review dialog, menus, notifications) is shipped in **Simplified Chinese and English** only. DSH 0.2.2-rc.1 also ships Japanese, Spanish, French, German, Russian, and Brazilian Portuguese; on those UI languages this plugin falls back to English rather than showing untranslated or machine-translated claims. Plugin-manager display metadata in `locale/*.json` ships **eight languages**.

The long-form detail document uses **Chinese as its default** ([DETAIL.md](https://github.com/xiaoyangren6514/dsh-cleanup/blob/main/docs/DETAIL.md)); this file is the English edition. A Chinese UI reads the Chinese document, an English UI reads this file, and languages without their own edition read the Chinese default.

## Privacy

The plugin is fully local:

- No outbound network requests, no telemetry, no analytics, no remote sync; the browser half only calls the local Host API on the same origin.
- It reads the paths the Host already manages (workspace folders, Session logs, its own trash and state files) and writes only under `<DSH_HOME>/trash/dsh-cleanup/` and `<DSH_HOME>/cleanup/`. Usage insight reads logs through the Host's query seam and folds them in memory; nothing is persisted or sent anywhere.
- It does not read or write DSH's own configuration, does not modify the profile's `cordis.patch.yml`, and does not send Session content anywhere.
- The Git safety check runs the local `git` executable read-only and only reports counts; it can be disabled in cleanup settings and silently skips when Git is absent, the directory is not a repository, or the probe times out.

## Known limits

These are properties of DSH or of this release, not bugs to report:

- **Open (live) Sessions cannot be deleted now.** DSH keeps a Session's Agent — and its log write handle — alive for the whole Host process and exposes no API to release it, so deleting the log would corrupt it. The review dialog offers **Schedule deletion**, applied at the next DSH start before any Session is restored; a Session opened by another Host process sharing the same `$DSH_HOME` is refused the same way.
- **Usage needs the Host's query seam.** The Usage view only appears when the Host exposes `sessionQuery.readSession(id)`; without it the columns are hidden (`inventory.capabilities.usage` is `false`). Usage is folded from replay-validated logs, so a fork's inherited history is excluded from its own counts and a repeated request is counted once.
- **Projection-cache cleanup needs the Host's storage-domain service.** A deleted Session's `session_projcache` record is dropped with its files only when the Host exposes that service; otherwise the drop is silently skipped (`inventory.capabilities.projectionCache` is `false`, `cacheDropped: false` on the result). The record is a disposable fold cache, never user data, and it is rebuilt on demand.
- **The trash never auto-cleans.** Retention days and capacity are warnings only, and the user purges. Trashed payloads keep occupying disk until purged — a trashed Session's log is still on disk, which is exactly what makes restore possible.
- **Permanent deletion cannot be undone.** Trash mode is the default and keeps the log on disk until you purge it; permanent mode removes it immediately. Permanent deletion of a workspace folder also requires typing the folder name.
- **Attachments are never cleaned, and the search index is the Host's.** The deletion set is the Session's stored log (plus its subagent logs). Attachment blobs a Session produced are outside that set and stay in place, and DSH reconciles its own search index.
- **Plugin state is not a security boundary.** The queue, settings overrides, audit log, and trash metadata are user-writable files under `<DSH_HOME>/cleanup/` (and the trash under `<DSH_HOME>/trash/dsh-cleanup/`). A process running as the same user could edit them or delete files directly; "deletion is a user action" is a rule of this plugin's own surfaces, not a sandbox.
- **Opening a folder is best-effort.** The controls exist only when the Host platform has an opener (macOS, Windows, Linux). The Host resolves the directory itself and asks the OS to open it; a file manager that does not end up focused is not reported as an error.
- **Windows semantics are implemented but not machine-tested.** Drive/UNC roots, case-insensitive comparison, depth below the root, and junction refusal are covered by unit tests, but this release was validated on macOS; no Windows machine ran the destructive path.
- **The test suite is unit-level.** Host and browser logic are covered by `node --test` with fake services and real temporary directories; there is no automated end-to-end run inside a real DSH GUI, so browser wiring and Host-version compatibility are verified by hand.

## See also

- [README](https://github.com/xiaoyangren6514/dsh-cleanup/blob/main/README.md)
- [FAQ](https://github.com/xiaoyangren6514/dsh-cleanup/blob/main/docs/FAQ.md)
- [Specification](https://github.com/xiaoyangren6514/dsh-cleanup/blob/main/SPEC.md)
- [Issues](https://github.com/xiaoyangren6514/dsh-cleanup/issues)

## License

MIT © 2026 fly. See [LICENSE](https://github.com/xiaoyangren6514/dsh-cleanup/blob/main/LICENSE).
