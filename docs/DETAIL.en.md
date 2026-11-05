---
description: "Long-form description of dsh-cleanup: workspace folder and Session deletion for DeepSeek Harness, its review-first safety model, installation, compatibility, and privacy posture."
kind: "package-bundle"
---

# dsh-cleanup — delete workspace folders and Session logs safely

[中文](https://github.com/xiaoyangren6514/dsh-cleanup/blob/main/docs/DETAIL.md) | English

`dsh-cleanup` is a bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that adds the deletions DSH deliberately leaves out:

- **Deleting a registered workspace's real folder** from disk, recursively.
- **Deleting a Session's event log**, including its subagent Sessions.
- **Clearing every Session log of one workspace**, keeping its folder and registration.

DSH itself only unregisters a workspace — the folder, its files, and its Session history stay on disk — and Sessions can only be archived, never deleted. `dsh-cleanup` fills that gap while keeping the destructive surface narrow: targets are addressed by DSH identity, never by arbitrary path; every deletion is planned, reviewed, and confirmed; and the default outcome is a recoverable trash.

- Package: `dsh-cleanup` 0.5.0
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
| Trash entries keep the subagent family: a `Subagent` badge and a `Parent` line | Settings → Storage cleanup → Trash |
| Storage overview with sizes, bulk selection, sorting and archived filtering | Settings → **Storage cleanup** |
| Recoverable trash with restore and explicit purge | Settings → Storage cleanup → **Trash** |
| Deferral queue for Sessions open in the Host, executed at the next start | Review dialog → **Schedule deletion (runs automatically after this app exits)**; manage it in Settings |
| Cleanup policy: trash location/retention/capacity, audit log, scan budget, permanent-deletion switch, Git safety check | Settings → Storage cleanup → **Cleanup settings** |
| Audit trail of deletions, skips, restores and purges, plus the last start-up run | Settings → Storage cleanup → Cleanup settings → **Recent deletions** |
| Rule-based Session picking (age, archived state, size, workspace, origin) with preview before review | Settings → Storage cleanup → Sessions → **Select by rules** |
| Read-only agent inspection of cleanable Sessions and folders | Tool `cleanup_inventory` |

**Deletion is a user action.** The only agent-facing surface is a read-only inventory tool: the model can report what exists, how large it is, and why something is blocked, but it has no way to delete anything.

### The review dialog and per-row selection

The review dialog groups the plan by *reviewed target*: one row per Session or workspace, with its subagent logs (or the Sessions swept in by a folder) collapsed underneath. Every row always carries a checkbox — a single-target review included — and rows can be checked one by one or through **Select all** / **Invert**; only checked targets enter the plan, un-checking re-plans with the remaining targets, and an empty selection keeps every row on screen with "Select at least one target" and a disabled destructive button. While a re-plan is in flight, checked rows that are not in the new plan yet read "Re-planning…" and the totals area reads "Recalculating the review…", so the previous plan is never presented as current. Permanent deletion accepts one workspace folder per plan: a selection change that crosses that limit switches back to trash with an explanation instead of sending a plan the Host would refuse. If a re-plan still contains an un-checked target (for example one swept back in by a workspace folder), the client fails closed with `UNCHECKED_TARGET_LEAK` and sends no delete request.

### Clearing a workspace's Sessions

"Clear workspace sessions…" deletes only the Session logs of one workspace; the folder and its registration stay untouched. It pre-flights, lets the user review the first batch (at most 64 logs), and then continues automatically batch by batch: the pre-flight lists logs opened or running in this app run as skipped and says how many (the same Session is never counted twice across refilled pages), each executed batch prunes the ids it actually removed, and a target deleted by another process makes the client re-read the workspace and rebuild the queue instead of failing the whole walk. The result auto-closes only when nothing is left over (no failures, no skipped rows, no excluded rows, no early stop); otherwise it stays until the user dismisses it. When every remaining log can only be deleted after a restart, the review offers "Schedule deletion" and the queued result reports how many are not included.

## Safety model

Four gates stand between a click and a deleted byte.

### 1. Plan before execute

A delete request first asks the Host for a *plan*: the exact targets, the files and directories they contain, total bytes, warnings (for example uncommitted Git changes), blockers (for example a live Session), and — for permanent folder deletion — the typed-name confirmation requirement. The plan is one-time and expires after 5 minutes. Execution re-validates the world first: if a target moved, changed identity, or became blocked, the Host refuses with `STATE_CHANGED` and nothing is deleted.

### 2. Trash by default

Deletions move targets to the trash under `<DSH_HOME>/trash/dsh-cleanup/` instead of erasing them, so the common mistake is recoverable. Permanent deletion is an explicit second mode. Deleting a workspace folder permanently additionally requires typing the folder name, and one permanent plan can contain at most one existing workspace folder — a single typed name must never authorize deleting another directory. Batch permanent deletion is refused; delete directories one at a time or use trash mode.

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
dsh plugin --profile web add dsh-cleanup@0.5.0

# From GitHub, pinned to a commit
dsh plugin --profile web add github:xiaoyangren6514/dsh-cleanup#<sha>

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
- **macOS (`darwin`), Linux, and Windows (`win32`)** — `dsh.bundle.platforms: ["darwin", "linux", "win32"]`. On Windows the plugin works with drive roots and backslash paths: drive roots (`C:\`), the system directories (`C:\Windows`, `Program Files`, `ProgramData`), and the home directory's parent are protected, path comparison is case-insensitive, and directory depth is counted in segments below the drive root, so `C:\proj` is refused as a top-level directory just like `/proj`. Junctions, which appear as symlinks, are refused like symlinks. POSIX-only permission cases are skipped on Windows.
- **Local filesystem paths** — remote or non-local filesystem providers are not understood. The trash must be on the same volume as its targets; a cross-volume move is always refused in favor of permanent deletion.

## Languages

Plugin UI copy (settings page, review dialog, menus, notifications) is shipped in **Simplified Chinese and English** only. DSH 0.2.2-rc.1 also ships Japanese, Spanish, French, German, Russian, and Brazilian Portuguese; on those UI languages this plugin falls back to English rather than showing untranslated or machine-translated claims. Plugin-manager display metadata in `locale/*.json` ships **eight languages**.

The long-form detail document uses **Chinese as its default** ([DETAIL.md](https://github.com/xiaoyangren6514/dsh-cleanup/blob/main/docs/DETAIL.md)); this file is the English edition. A Chinese UI reads the Chinese document, an English UI reads this file, and languages without their own edition read the Chinese default.

## Privacy

The plugin is fully local:

- No outbound network requests, no telemetry, no analytics, no remote sync; the browser half only calls the local Host API on the same origin.
- It reads the paths the Host already manages (workspace folders, Session logs, its own trash and state files) and writes only under `<DSH_HOME>/trash/dsh-cleanup/` and `<DSH_HOME>/cleanup/`.
- It does not read or write DSH's own configuration, does not modify the profile's `cordis.patch.yml`, and does not send Session content anywhere.
- The Git safety check runs the local `git` executable read-only and only reports counts; it can be disabled in cleanup settings and silently skips when Git is absent, the directory is not a repository, or the probe times out.

## See also

- [README](https://github.com/xiaoyangren6514/dsh-cleanup/blob/main/README.md)
- [FAQ](https://github.com/xiaoyangren6514/dsh-cleanup/blob/main/docs/FAQ.md)
- [Specification](https://github.com/xiaoyangren6514/dsh-cleanup/blob/main/SPEC.md)
- [Issues](https://github.com/xiaoyangren6514/dsh-cleanup/issues)

## License

MIT © 2026 fly. See [LICENSE](https://github.com/xiaoyangren6514/dsh-cleanup/blob/main/LICENSE).
