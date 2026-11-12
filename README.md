---
description: "Workspace folder and Session log deletion with a recoverable trash, an explicit review step, token-usage insight, a selectable Session family tree, projection-cache cleanup, and a storage overview page"
kind: "package-bundle"
---

# dsh-cleanup

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) bundle that adds the deletions DSH deliberately leaves out: removing a **registered workspace's real folder** from disk, **deleting a Session's event log** including its subagent Sessions, and **clearing every Session log of one workspace** while keeping its folder. Every deletion goes through plan → review → confirm, defaults to a recoverable trash, and never happens on a single click.

DSH itself only unregisters a workspace (the folder and its Sessions stay on disk) and only archives Sessions. `dsh-cleanup` fills that gap without exposing `rm -rf`: you can only delete things DSH already knows about, by id, after seeing exactly what will disappear.

Since 0.6.0 it also shows what it deletes: an opt-in **usage** view (per-Session total tokens and cache-hit rate, with own/family totals and a sort-by-usage option), the Session family rendered as a **tree** with one checkbox per node, an **Open folder** control on Workspaces, Sessions and Trash rows plus the review summary, and no projection-cache residue — a deleted Session also leaves the sidebar without a page refresh.

| | |
|---|---|
| Package | `dsh-cleanup` (imports no `@deepseek-ai/*` package, zero runtime dependencies) |
| Version | 0.6.2 |
| Repository | <https://github.com/xiaoyangren6514/dsh-cleanup> |
| Author | fly |
| License | [MIT](LICENSE) |
| Tested with | DSH 0.2.2-rc.1 / 0.2.2-rc.2 |
| Host platforms | macOS (`darwin`), Linux, and Windows (`win32`) |

## Features

| Capability | Where |
|---|---|
| Delete a registered workspace's **real folder** (recursive) | Sidebar workspace right-click → **Delete workspace folder…** |
| Delete a **Session** (with its subagent Session logs) | Sidebar Session right-click → **Delete session…** |
| Clear **every Session log** of a workspace in automatic batches after one review (the folder and its registration stay) | Sidebar workspace right-click → **Clear workspace sessions…** |
| Choose exactly what a review deletes — one checkbox per reviewed target, **Select all** / **Invert**, and a permanent mode that drops back to trash when the selection spans several folders | Review dialog |
| Pick the Session family **per node** — subagent descendants render as a tree, one checkbox per log, tri-state parent states, explicit selection | Review dialog |
| Filter the Sessions list by workspace; subagent logs fold under the Session they belong to | Settings → Storage cleanup → Sessions |
| Opt-in **Tokens** and **Cache hit** columns per Session (own and family totals, sort by usage) | Settings → Storage cleanup → Sessions → **Usage** toggle |
| See which trash entries were subagent logs and which Session they belong to | Settings → Storage cleanup → Trash (`Subagent` badge, `Parent` line) |
| See how much every workspace and Session uses, delete in bulk | Settings → **Storage cleanup** |
| **Open in the file manager**: a workspace folder, a Session folder, a trash entry, or the projection-cache directory | Workspaces / Sessions / Trash rows, single-target review summary, Trash header; on macOS an application bundle (`.app` etc.) is revealed in Finder instead of launched |
| A deleted Session leaves the sidebar immediately, without a page refresh | Any Session deletion |
| A deleted Session's `session_projcache` record goes with its files (skipped when the Host exposes no storage-domain service) | Automatic, after a Session deletion |
| Recover a mistake (deletions go to the trash by default) | Settings → Storage cleanup → **Trash** |
| Queue a Session that is open in the current Host for deletion at the next start | Review dialog → **Schedule deletion (runs automatically after this app exits)**; inspect/cancel it in Settings |
| Tune cleanup policy (trash location/retention/capacity, audit log, scan budget, permanent deletion) | Settings → Storage cleanup → **Cleanup settings** |
| Read an audit trail and the result of the last start-up run | Settings → Storage cleanup → Cleanup settings → **Recent deletions** |
| Get warned when the trash is too large or too old, and clean the oldest entries (never automatic) | Settings → Storage cleanup → Trash |
| Read-only Git safety check (uncommitted changes, unpushed commits) before deleting a workspace folder | Workspace review dialog; can be disabled in cleanup settings |
| Pick Sessions by rules (age, archived state, size, workspace, origin), preview matches, then review | Settings → Storage cleanup → Sessions → **Select by rules** |
| Let the agent see what could be cleaned and how much space it uses | Read-only tool `cleanup_inventory` |

**Only you can delete.** The agent-facing tool is read-only: it can report which Sessions and folders exist, how large they are, and why something cannot be deleted, but it has no delete entry point.

## Safety model

Four gates stand between a click and a deleted byte:

1. **Plan before execute.** A delete request first produces a *plan*: the exact targets, file/directory counts, bytes, warnings, and blockers. The plan is one-time and expires after 5 minutes; executing re-validates the world and refuses with `STATE_CHANGED` if anything moved.
2. **Trash by default.** Targets are moved to `<DSH_HOME>/trash/dsh-cleanup/<time>-<name>/` and can be restored or permanently purged later. Permanent deletion is an explicit second mode; the review dialog states plainly that it cannot be undone, while the default trash keeps the log on disk until you purge it. Deleting a workspace folder permanently additionally requires typing the folder name.
3. **Only registered, canonical targets.** A workspace folder must be a workspace DSH has registered; before execution its path is re-resolved (`lstat` + `realpath`) and must still be the recorded canonical path. Symlinks are refused. The filesystem root, the home directory, `~/.dsh`, the Host process working directory **and its ancestors**, the trash itself, and shallow paths are protected.
4. **Never touch a live Session.** Immediate and deferred deletions probe the Session persistence write handle, including Sessions held by **another Host process**, and refuse running or open Sessions (`SESSION_RUNNING` / `SESSION_LIVE`). Opening a Session's log while the Session writes to it corrupts the log, so refusing is the only safe answer.

Two more guards apply to the bookkeeping:

- **Trash ownership.** Trash entries carry an ownership marker, a configured `trashRoot` may only point at a directory dedicated to this plugin, and foreign directories are never listed or deleted.
- **Self-owned state.** The plugin's queue, settings, and audit files live under `<DSH_HOME>/cleanup/` and are user-writable state, not a security boundary (see [Security note](#security-note)).

## Known limits

These are properties of DSH or of this release, not bugs to report:

- **Open (live) Sessions cannot be deleted now.** DSH keeps a Session's Agent — and its log write handle — alive for the whole Host process and exposes no API to release it, so deleting the log would corrupt it. The review dialog offers **Schedule deletion**, applied at the next DSH start before any Session is restored; a Session opened by another Host process sharing the same `$DSH_HOME` is refused the same way.
- **Usage needs the Host's query seam.** The `Usage` view only appears when the Host exposes `sessionQuery.readSession(id)`; without it the columns are hidden (and `inventory.capabilities.usage` is `false`). Usage is folded from replay-validated logs, so a fork's inherited history is excluded from its own counts and a repeated request is counted once.
- **Projection-cache cleanup needs the Host's storage-domain service.** A deleted Session's `session_projcache` record is dropped with its files only when the Host exposes that service; otherwise the drop is silently skipped (`inventory.capabilities.projectionCache` is `false`, `cacheDropped: false` on the result). The record is a disposable fold cache, never user data, and it is rebuilt on demand.
- **The trash never auto-cleans.** Retention days and capacity are warnings only, and the user purges. Trashed payloads keep occupying disk until purged — a trashed Session's log is still on disk, which is exactly what makes restore possible.
- **Permanent deletion cannot be undone.** Trash mode is the default and keeps the log on disk until you purge it; permanent mode removes it immediately. Permanent deletion of a workspace folder also requires typing the folder name.
- **Attachments are never cleaned, and the search index is the Host's.** The deletion set is the Session's stored log (plus its subagent logs). Attachment blobs a Session produced are outside that set and stay in place, and DSH reconciles its own search index.
- **Plugin state is not a security boundary.** The queue, settings overrides, audit log, and trash metadata are user-writable files under `<DSH_HOME>/cleanup/` (and the trash under `<DSH_HOME>/trash/dsh-cleanup/`). A process running as the same user could edit them or delete files directly; "deletion is a user action" is a rule of this plugin's own surfaces, not a sandbox.
- **One review plans at most 64 targets.** The family tree can name Session logs one by one, but the Host's plan carries at most 64 targets. A selection that needs more fails before any request is sent (`TOO_MANY_TARGETS`) and asks you to narrow it or clear in batches; a workspace-clear batch shrinks itself to fit and continues with the rest in later batches.
- **Opening a folder is best-effort.** The controls exist only when the Host platform has an opener (macOS, Windows, Linux). The Host resolves the directory itself and answers once the opener is started; a file manager that does not end up focused is not reported as an error. On macOS a bundle-looking path (`.app`, `.bundle`, `.workflow`, `.pkg`) is revealed in Finder rather than executed.
- **Windows semantics are implemented but not machine-tested.** Drive/UNC roots, case-insensitive comparison, depth below the root, and junction refusal are covered by unit tests, but this release was validated on macOS; no Windows machine ran the destructive path.
- **The test suite is unit-level.** Host and browser logic are covered by `node --test` with fake services and real temporary directories; there is no automated end-to-end run inside a real DSH GUI, so browser wiring and Host-version compatibility are verified by hand.

## Install

Install the bundle into a DSH profile, then refresh the Web page once. The Host half hot-applies, but the browser half is a client module that the page only picks up after a reload.

```sh
# From npm (after the package is published)
dsh plugin --profile web add dsh-cleanup@0.6.2

# From GitHub, pinned to the v0.6.2 tag (a fixed commit; swap in `git rev-parse v0.6.2` for the raw sha)
dsh plugin --profile web add github:xiaoyangren6514/dsh-cleanup#v0.6.2

# From a local checkout
git clone https://github.com/xiaoyangren6514/dsh-cleanup.git
dsh plugin --profile web add ./dsh-cleanup
```

`web` is an example profile name; use whichever profile you run (`demo`, `headless`, …). `dsh plugin --profile <name> <pnpm args>` forwards to pnpm inside the profile, and DSH asks for any required approval itself.

Remove it with `dsh plugin --profile web remove dsh-cleanup`, or disable/remove the bundle in Settings → Plugins. Removing the bundle does **not** delete the trash or the plugin's state files under `<DSH_HOME>/cleanup/`.

A local checkout is installed as a linked directory: do not move or delete it while it is in use, or the profile may fail to start. npm and GitHub installs are regular profile dependencies.

### Discover

DSH 0.2.2 (rc.1 / rc.2) ships **no official plugin market or index**. The Discover tab comes from the optional experimental plugin-market bundle (shipped profiles keep it off), and no index source is configured by default — you add an index URL yourself in Discover or Settings → Plugins. Community-run catalogs that publish DSH plugin indexes include:

- [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) — index at <https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json>
- [dshopen.org](https://dshopen.org)

Once `dsh-cleanup` is published and listed in one of those indexes, add that index URL, then install from Discover (it runs the same `dsh plugin add` step shown above) or from the CLI. Until then, use the npm/GitHub/local commands.

## Requirements and compatibility

- **DSH 0.2.2-rc.1 and 0.2.2-rc.2** (tested). `package.json` declares `engines.dsh: >=0.2.2-alpha.3 <0.3.0`; the plugin manager checks it before install/enable and refuses incompatible runtimes instead of running on a half-broken API. rc.2 also added an exact-version plugin guard: it disables plugins that pin exact `@deepseek-ai/*` peer requirements, while this plugin declares only a semver range and therefore stays enabled.
- **Node.js ≥ 20** for the Host half.
- **Web GUI.** The browser half is a web client module, registered through `window.__ModuleLoader__` and the `shell.overlay` / `settings.section` / `contextMenu.*` slots.
- **macOS (`darwin`), Linux, and Windows (`win32`).** The bundle declares `dsh.bundle.platforms: ["darwin", "linux", "win32"]`. On Windows the plugin works with drive roots and backslash paths: drive roots, the system directories (`C:\Windows`, `Program Files`, `ProgramData`), and the home directory's parent are protected, path comparison is case-insensitive, and depth is counted below the drive root, so `C:\proj` is refused as a top-level path just like `/proj`. Junctions are refused like symlinks. These Windows semantics are implemented and unit-tested, but this release was validated on macOS only — see [Known limits](#known-limits).
- **Local filesystem.** The plugin acts on paths the Host process can see; remote or non-local filesystem providers are not understood.

## UI language

Plugin surfaces (settings page, review dialog, menus, notifications) are written in **Simplified Chinese and English** only. DSH 0.2.2 also ships Japanese, Spanish, French, German, Russian, and Brazilian Portuguese; on those DSH UI languages this plugin's pages **fall back to English** rather than showing machine-translated text. There is no translation of the plugin UI into those six languages.

The plugin-manager display metadata (`locale/*.json`) ships **eight languages**, so the plugin title and short description in Settings → Plugins render in the active language. The long-form detail document is Chinese by default: [docs/DETAIL.md](docs/DETAIL.md), with the English edition in [docs/DETAIL.en.md](docs/DETAIL.en.md). A Chinese UI reads the Chinese document, an English UI reads the English one, and the other built-in languages read the Chinese default.

## Docs

- [FAQ](docs/FAQ.md) — deletion, recovery, live Sessions, the queue, the trash, settings, audit, Git checks, usage, opening directories, languages, troubleshooting
- [Detail document](docs/DETAIL.md) — long-form capability and safety description, Chinese by default, also the market detail page ([English edition](docs/DETAIL.en.md))
- [Specification](SPEC.md) — the frozen Host ↔ browser contract
- [Changelog](CHANGELOG.md) — release notes

## License

[MIT](LICENSE) © 2026 fly.

## Security note

Deletion is a user action, not an agent action: the only agent-facing surface is the read-only `cleanup_inventory` tool. The plugin never writes into DSH's own configuration, never appends to `document.body`, and makes no outbound network requests — its only HTTP calls are same-origin requests to the local Host API, and everything runs against paths the Host already knows. The remaining trust boundary is OS-level: any process with the same permissions as the Host can read and write the plugin's state files and can delete files directly. Treat the profile directory as private.
