---
description: "Delete registered workspace folders and Session logs behind an explicit review step, with a recoverable trash, a deferral queue for live Sessions, and a read-only storage overview page."
kind: "package-bundle"
---

# dsh-cleanup

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) bundle that adds the two deletions DSH deliberately leaves out: removing a **registered workspace's real folder** from disk, and **deleting a Session's event log** including its subagent Sessions. Every deletion goes through plan → review → confirm, defaults to a recoverable trash, and never happens on a single click.

DSH itself only unregisters a workspace (the folder and its Sessions stay on disk) and only archives Sessions. `dsh-cleanup` fills that gap without exposing `rm -rf`: you can only delete things DSH already knows about, by id, after seeing exactly what will disappear.

| | |
|---|---|
| Package | `dsh-cleanup` (imports no `@deepseek-ai/*` package, zero runtime dependencies) |
| Version | 0.4.0 |
| Repository | <https://github.com/xiaoyangren6514/dsh-cleanup> |
| Author | fly |
| License | [MIT](LICENSE) |
| Tested with | DSH 0.2.2-rc.1 |
| Host platforms | macOS (`darwin`), Linux, and Windows (`win32`) |

## Features

| Capability | Where |
|---|---|
| Delete a registered workspace's **real folder** (recursive) | Sidebar workspace right-click → **Delete workspace folder…** |
| Delete a **Session** (with its subagent Session logs) | Sidebar Session right-click → **Delete session…** |
| See how much every workspace and Session uses, delete in bulk | Settings → **Storage cleanup** |
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
2. **Trash by default.** Targets are moved to `<DSH_HOME>/trash/dsh-cleanup/<time>-<name>/` and can be restored or permanently purged later. Permanent deletion is an explicit second mode, and deleting a workspace folder permanently additionally requires typing the folder name.
3. **Only registered, canonical targets.** A workspace folder must be a workspace DSH has registered; before execution its path is re-resolved (`lstat` + `realpath`) and must still be the recorded canonical path. Symlinks are refused. The filesystem root, the home directory, `~/.dsh`, the Host process working directory **and its ancestors**, the trash itself, and shallow paths are protected.
4. **Never touch a live Session.** Immediate and deferred deletions probe the Session persistence write handle, including Sessions held by **another Host process**, and refuse running or open Sessions (`SESSION_RUNNING` / `SESSION_LIVE`). Opening a Session's log while the Session writes to it corrupts the log, so refusing is the only safe answer.

Two more guards apply to the bookkeeping:

- **Trash ownership.** Trash entries carry an ownership marker, a configured `trashRoot` may only point at a directory dedicated to this plugin, and foreign directories are never listed or deleted.
- **Self-owned state.** The plugin's queue, settings, and audit files live under `<DSH_HOME>/cleanup/` and are user-writable state, not a security boundary (see [Security note](#security-note)).

## Install

Install the bundle into a DSH profile, then refresh the Web page once. The Host half hot-applies, but the browser half is a client module that the page only picks up after a reload.

```sh
# From npm (after the package is published)
dsh plugin --profile web add dsh-cleanup@0.4.0

# From GitHub, pinned to a commit
dsh plugin --profile web add github:xiaoyangren6514/dsh-cleanup#<sha>

# From a local checkout
git clone https://github.com/xiaoyangren6514/dsh-cleanup.git
dsh plugin --profile web add ./dsh-cleanup
```

`web` is an example profile name; use whichever profile you run (`demo`, `headless`, …). `dsh plugin --profile <name> <pnpm args>` forwards to pnpm inside the profile, and DSH asks for any required approval itself.

Remove it with `dsh plugin --profile web remove dsh-cleanup`, or disable/remove the bundle in Settings → Plugins. Removing the bundle does **not** delete the trash or the plugin's state files under `<DSH_HOME>/cleanup/`.

A local checkout is installed as a linked directory: do not move or delete it while it is in use, or the profile may fail to start. npm and GitHub installs are regular profile dependencies.

### Discover

DSH 0.2.2-rc.1 ships **no official plugin market or index**. The Discover tab comes from the optional experimental plugin-market bundle (shipped profiles keep it off), and no index source is configured by default — you add an index URL yourself in Discover or Settings → Plugins. Community-run catalogs that publish DSH plugin indexes include:

- [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) — index at <https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json>
- [dshopen.org](https://dshopen.org)

Once `dsh-cleanup` is published and listed in one of those indexes, add that index URL, then install from Discover (it runs the same `dsh plugin add` step shown above) or from the CLI. Until then, use the npm/GitHub/local commands.

## Requirements and compatibility

- **DSH 0.2.2-rc.1** (tested). `package.json` declares `engines.dsh: ^0.2.2-alpha.3`; the plugin manager checks it before install/enable and refuses incompatible runtimes instead of running on a half-broken API.
- **Node.js ≥ 20** for the Host half.
- **Web GUI.** The browser half is a web client module, registered through `window.__ModuleLoader__` and the `shell.overlay` / `settings.section` / `contextMenu.*` slots.
- **macOS (`darwin`), Linux, and Windows (`win32`).** The bundle declares `dsh.bundle.platforms: ["darwin", "linux", "win32"]`. On Windows the plugin works with drive roots and backslash paths: drive roots, the system directories (`C:\Windows`, `Program Files`, `ProgramData`), and the home directory's parent are protected, path comparison is case-insensitive, and depth is counted below the drive root, so `C:\proj` is refused as a top-level path just like `/proj`. Junctions are refused like symlinks.
- **Local filesystem.** The plugin acts on paths the Host process can see; remote or non-local filesystem providers are not understood.

## UI language

Plugin surfaces (settings page, review dialog, menus, notifications) are written in **Simplified Chinese and English** only. DSH 0.2.2-rc.1 also ships Japanese, Spanish, French, German, Russian, and Brazilian Portuguese; on those DSH UI languages this plugin's pages **fall back to English** rather than showing machine-translated text. There is no translation of the plugin UI into those six languages.

The plugin-manager display metadata (`locale/*.json`) ships **eight languages**, so the plugin title and short description in Settings → Plugins render in the active language. The long-form detail document is Chinese by default: [docs/DETAIL.md](docs/DETAIL.md), with the English edition in [docs/DETAIL.en.md](docs/DETAIL.en.md). A Chinese UI reads the Chinese document, an English UI reads the English one, and the other built-in languages read the Chinese default.

## Docs

- [FAQ](docs/FAQ.md) — deletion, recovery, live Sessions, the queue, the trash, settings, audit, Git checks, languages, troubleshooting
- [Detail document](docs/DETAIL.md) — long-form capability and safety description, Chinese by default, also the market detail page ([English edition](docs/DETAIL.en.md))
- [Specification](SPEC.md) — the frozen Host ↔ browser contract
- [Changelog](CHANGELOG.md) — release notes

## License

[MIT](LICENSE) © 2026 fly.

## Security note

Deletion is a user action, not an agent action: the only agent-facing surface is the read-only `cleanup_inventory` tool. The plugin never writes into DSH's own configuration, never appends to `document.body`, and makes no outbound network requests — its only HTTP calls are same-origin requests to the local Host API, and everything runs against paths the Host already knows. The remaining trust boundary is OS-level: any process with the same permissions as the Host can read and write the plugin's state files and can delete files directly. Treat the profile directory as private.
