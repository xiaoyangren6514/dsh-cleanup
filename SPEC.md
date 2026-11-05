# dsh-cleanup — implementation contract (frozen)

Read this file completely before writing code. Anything not stated here is an implementation
decision you own; anything stated here is frozen so the two halves and the tests agree.

## 1. What this plugin is

A persistent DSH bundle (`dsh-cleanup`) that deletes three things the shipped product
deliberately never deletes:

1. **A registered Workspace directory** — the real folder on disk (recursively).
2. **A Session** — its stored log and its subagent-descendant logs.
3. **Every Session log of a Workspace** — the logs only; the folder and its registration stay.

Four product rules drive every design decision:

- **Review before destruction.** Nothing is deleted on a single click. The user first sees a
  *plan*: exactly which directories and sessions, how many files, how many bytes, what will
  break, what is blocked.
- **Recoverable by default.** The default mode moves the target into a trash directory inside
  `$DSH_HOME`, with restore and permanent purge available from the same page. Permanent deletion
  is an explicit second mode, and for a Workspace directory it additionally requires typing the
  folder name.
- **Ownership, not paths.** Only a **registered Workspace** may have its directory deleted, and
  only at the registry's stored canonical path, re-canonicalized at delete time. There is no
  "delete any path" API.
- **Refuse rather than guess.** A live session, a symlink, a re-pointed path, a protected root, a
  cross-volume trash move, or a directory that contains `$DSH_HOME` blocks the deletion with a
  precise code and message. The plugin never works around a refusal.

The agent gets a **read-only** inventory tool. Deletion is user-only, performed from the UI.

The published bundle declares `dsh.bundle.platforms: ["darwin", "linux", "win32"]`: the destructive
path handling is written for both POSIX and Windows spellings — a drive or UNC root, a
case-insensitive comparison, and a depth counted below that root, so `C:\proj` is refused as a
top-level path just like `/proj` — and the plugin manager skips the layer only on the platforms the
manifest does not name.

## 2. Files and write scopes

| Path | Owner | Notes |
|---|---|---|
| `package.json`, `cordis.patch.yml`, `locale/*.json`, `icon.svg`, `README.md`, `docs/*` | Lead | Do not edit |
| `lib/paths.js` | Lead | Frozen; do not edit. Read it and use it |
| `lib/engine.js` | host-dev | Host domain logic (scan, plan, execute, trash) |
| `index.js` | host-dev | `apply(ctx, config)`: routes + read-only tool |
| `client.js` | client-dev | Browser half |
| `test/*.test.mjs` | qa-dev | `node --test 'test/**/*.test.mjs'` |
| `scripts/check-contract.mjs` | Lead | `npm run check`: SPEC ↔ routes ↔ emitted codes ↔ locale dictionary gate |

Only the runtime and user-facing documentation ship in the package: `index.js`, `client.js`,
`lib/*.js`, `cordis.patch.yml`, `locale/**`, `icon.svg`, `docs/{DETAIL,DETAIL.en,FAQ}.md`,
`README.md`, `README.zh.md`, `CHANGELOG.md`, `LICENSE`, and this SPEC (see `package.json` `files`).
`test/`, `scripts/`, and `docs/internal/` stay in the repository and are not published with the
bundle.

`index.js` and `lib/engine.js` must import **only Node builtins** (`node:fs/promises`,
`node:path`, `node:os`, `node:crypto`, `node:v8`?) and each other by relative path
(`./lib/paths.js`, `./lib/engine.js`). Never import an `@deepseek-ai/*` package: the bundle is
installed as a link into the profile, so a bare import would not resolve.

`client.js` may `require('react')` only; it must not require any `@deepseek-ai/*` package.
Inline its own styles with a `<style>` element it owns and removes on dispose.

ESM only (`"type": "module"`). `index.js` exports `name`, `inject`, and `apply`.

## 3. Host: lifecycle

```js
export const name = 'dsh-cleanup'
// Required: without these the plugin has nothing to operate on and must stay inactive.
export const inject = ['connection', 'workspaceRegistry', 'sessionPersistence']
// Optional members are read with ctx.get(...) and degrade, never throw:
//   ctx.get('sessions')      SessionStore      — live check
//   ctx.get('agents')        AgentRegistry     — live/running check
//   ctx.get('tools')         ToolRegistry      — read-only inventory tool
//   ctx.get('sessionQuery')  SessionQuery      — not required; do not use
export function apply(ctx, config) { /* ... */ }
```

`config` (plain object, no Schema export; read with defaults):

| Field | Default | Meaning |
|---|---|---|
| `trashRoot` | `$DSH_HOME/trash/dsh-cleanup` | Where trash entries are moved |
| `maxScanEntries` | `200000` | Walk budget per directory before reporting `truncated` |
| `scanTimeoutMs` | `4000` | Wall-clock budget per directory walk |
| `planTtlMs` | `300000` | Plan validity window |
| `allowPermanentDeletion` | `true` | When false, only trash mode is offered |
| `maxPlans` | `32` | Retained plan count; oldest evicted. Numeric knobs are clamped to at least 1 (`0` becomes `1`); `maxScanEntries`, `scanTimeoutMs`, and `planTtlMs` fall back to their defaults for non-positive values |
| `deferredFile` | `$DSH_HOME/cleanup/deferred.json` | Persistent deferred-deletion queue (see §4.7) |
| `settingsFile` | `<queue dir>/settings.json` (default `$DSH_HOME/cleanup/settings.json`) | User overrides edited from the Settings page (§4.8). Precedence: this file > the row `config` > the defaults above. Missing/corrupt file means "no overrides". Plugin state files are colocated: configuring `deferredFile` moves the default settings/audit files next to it |
| `auditFile` | `<queue dir>/audit.jsonl` (default `$DSH_HOME/cleanup/audit.jsonl`) | Append-only deletion audit log, rotated to `audit.jsonl.1` past `auditMaxBytes` (§5.9) |
| `auditEnabled` | `true` | Record deletions/skips/queue operations in the audit log |
| `auditMaxBytes` | `2097152` | Rotate the audit log past this size |
| `trashRetentionDays` | `0` | Warn when the oldest trash entry is older than this; `0` disables the warning. Never deletes automatically |
| `trashMaxBytes` | `0` | Warn when the trash exceeds this size; `0` disables the warning. Never deletes automatically |
| `gitSafetyCheck` | `true` | Before a workspace directory is deleted, run read-only `git status`/`git rev-list` probes and warn about uncommitted/unpushed work. Never blocks; a missing `git`, a non-repository folder, or a probe timeout is silently skipped |

Register every resource with `ctx.effect(...)` and return the disposer. All route registrations
go through `ctx.connection.fetch.register`. `apply` must never throw for an optional service.

## 4. Host: HTTP routes

All routes are on the authenticated shared channel: `path` starts with `/api/`, `methods: ['POST']`,
`requestBody: 'buffered'`. Exactly one route may own a path. Every route body is JSON; an invalid
or missing body — and any request whose fields are invalid — answers HTTP 400 with
`{ ok: false, error: { code: 'BAD_REQUEST', message } }`. Every other domain failure is HTTP 200
with `ok: false`, including one raised by a route before the engine is reached.

**Response envelope.** HTTP 200 for every handled request, success or domain failure:

```jsonc
{ "ok": true,  "...": "payload" }
{ "ok": false, "error": { "code": "SESSION_LIVE", "message": "…", "details": { } } }
```

`message` is English, model/log-facing. The UI translates from `code`; it falls back to
`message` only for codes it does not know. HTTP 500 is reserved for a programming error
(the client shows a generic failure); still answer with the envelope.

### 4.1 `POST /api/cleanup.inventory`

Request: `{}`.

```jsonc
{
  "ok": true,
  "generatedAt": 1730000000000,
  "dshHome": "/Users/x/.dsh",
  "trash": { "root": "/Users/x/.dsh/trash/dsh-cleanup", "entries": 2, "bytes": 4096,
             "oldestMovedAt": 1730000000000, "overRetention": false, "overCapacity": false,
             "suggestedEntryIds": [] },   // oldest entries whose purge gets under trashMaxBytes
  "workspaces": [{
    "id": "ws-…",
    "path": "/abs/dir",            // registry canonical path
    "title": "proj",               // registry title
    "state": "ok",                 // "ok" | "missing" | "unsafe"
    "stateCode": null,             // "WORKSPACE_MISSING" | "WORKSPACE_SYMLINK" | "PATH_PROTECTED" | …
    "sessionCount": 3,             // registry account size (entity.sessionIds.length)
    "sessionsInside": 5,           // stored sessions whose header.cwd is inside path
    "hasGit": true,
    "liveSessions": ["session-…"], // live or running sessions with cwd inside path
    "deletable": false,
    "blockerCodes": ["WORKSPACE_HAS_LIVE_SESSIONS"]
  }],
  "sessions": [{
    "id": "session-…",
    "workspaceId": "ws-…",         // registry membership, null when ungrouped
    "cwd": "/abs/dir",             // header.cwd, null when absent
    "createdAt": 1730000000000,    // header.createdAt (epoch ms)
    "eventCount": 42,              // snapshot.eventCount when present
    "sizeBytes": 12345,            // snapshot.sizeBytes when present
    "origin": "subagent",          // header.origin, else null
    "parentSessionId": "session-…",// header.parentSession, else null
    "live": false,
    "running": false,
    "archived": false,
    "pinned": false,
    "deletable": true,             // true exactly when blockerCodes is empty
    "blockerCodes": []
  }],
  "truncated": false,              // true when the session list hit an internal cap
  "sessionListCap": 2000,         // the cap named above, so consumers never hardcode it
  "deferred": { "count": 0, "retained": 0, "lastRun": null },   // queued deletions, see §4.7
  "audit": {
    "enabled": true,
    "lastStartup": { "at": 0, "applied": 0, "skipped": 0, "failed": 0 },   // or null
    "recent": [ { "at": 0, "source": "immediate", "action": "delete", "mode": "trash",
                  "targets": [ { "kind": "session", "id": "session-…" } ],
                  "status": "trashed", "code": null, "bytes": 0 } ]        // newest first, max 10
  }
}
```

`workspaces` comes from `ctx.workspaceRegistry.list()`; `sessions` from
`ctx.sessionPersistence.list()`. The response must be pure JSON (no `undefined`, no `Date`).

### 4.2 `POST /api/cleanup.measure`

Request: `{ "workspaceIds": ["ws-…"], "sessionIds": ["session-…"] }` (both optional).
Bounded node:fs walks, honoring `maxScanEntries`/`scanTimeoutMs`.

```jsonc
{
  "ok": true,
  "workspaces": { "ws-…": { "bytes": 10, "files": 12, "dirs": 3, "newestMtime": 1730000000000, "truncated": false } },
  "sessions":   { "session-…": { "bytes": 99, "files": 2 } }
}
```
A missing directory reports `{ "bytes": 0, "files": 0, "dirs": 0, "truncated": false, "missing": true }`.
Unknown ids are simply absent from the maps. Walk must not follow symlinks and must not throw on
`EACCES`/`ENOENT` (skip that subtree).

### 4.3 `POST /api/cleanup.plan`

Request:

```jsonc
{
  "targets": [ { "kind": "workspace", "id": "ws-…" }, { "kind": "session", "id": "session-…" } ],
  "mode": "trash",                 // "trash" | "permanent"
  "includeSessions": true,         // workspace targets: also delete stored sessions whose cwd is inside
  "includeDescendants": true       // session targets: also delete subagent descendants
}
```

Response `{ ok: true, plan: Plan }` where

```jsonc
{
  "planId": "b3f0…",               // opaque, single-use
  "createdAt": 1730000000000,
  "expiresAt": 1730000300000,
  "mode": "trash",
  "allowPermanentDeletion": true,
  "targets": [ { "kind": "workspace", "id": "ws-…", "title": "proj", "path": "/abs/dir" } ],
  "items": [
    { "kind": "workspace-dir", "id": "ws-…", "title": "proj", "path": "/abs/dir",
      "bytes": 1024, "files": 10, "dirs": 3, "truncated": false },
    { "kind": "session", "id": "session-…", "workspaceId": "ws-…", "title": null,
      "path": "/Users/x/.dsh/sessions/--…--/session-…", "bytes": 99, "files": 2,
      "parentSessionId": null, "isDescendant": true }
  ],
  "totals": { "workspaces": 1, "sessions": 2, "files": 12, "dirs": 3, "bytes": 1123 },
  "warnings": [ { "code": "WORKSPACE_HAS_GIT", "message": "…", "sessionId": null, "workspaceId": "ws-…" } ],
  "blockers": [ { "code": "SESSION_LIVE", "message": "…", "sessionId": "session-…", "workspaceId": null } ],
  "confirmation": { "kind": "typed-name", "expected": "proj", "label": "proj" } // or null
}
```

Blocking and warning decisions are in §5. `totals.dirs` sums the nested directories the size walk
finds inside each target (a target directory itself is not counted, by the same rule for session and
workspace items). `confirmation` is non-null exactly when the plan deletes one **workspace directory**
that still exists and `mode === "permanent"`; `expected` is that directory's final path segment;
`label` is the same directory's workspace title, falling back to `expected`, for the prompt.

This is deliberately **independent of `blockers`**: a blocked plan cannot execute now, but the user can
still choose the deferred route (§4.7), and the typed folder name is the same deliberation gate the
start-up run re-validates. The dialog keeps its destructive button disabled while blockers exist; the
typed input is what enables the deferred action. An **existing workspace directory** is a workspace target
the plan does not report `WORKSPACE_MISSING` for. A permanent plan naming more than one of them is
refused outright with `PERMANENT_MULTIPLE_DIRECTORIES` and creates no plan, so one typed name never
authorizes deleting several folders (the trash mode covers batch deletion); `PERMANENT_DISABLED` is
decided before this refusal, and a blocked target keeps its blockers on a plan that stays single.
The UI enables its destructive button only when `blockers` is empty and the typed text equals
`expected` (when required).

### 4.4 `POST /api/cleanup.delete`

Request: `{ "planId": "b3f0…", "confirmationText": "proj" }` (text omitted when not required).

The plan is consumed once this call looks it up, even when the call then fails: a second call answers
`PLAN_UNKNOWN`.
A plan older than `expiresAt` answers `PLAN_EXPIRED` and requires a fresh plan — expiry is classified
at execute time, so an expired plan is still found until the `maxPlans` bound evicts it. Only a plan that was actually looked up is consumed: a request rejected for its own invalid shape (`BAD_REQUEST`) leaves the plan
usable, including a valid `planId` with a non-string `confirmationText`.

```jsonc
{
  "ok": true,
  "result": {
    "items": [
      { "kind": "workspace-dir", "id": "ws-…", "status": "trashed",  // "trashed" | "deleted" | "failed"
        "error": null, "movedTo": "/Users/x/.dsh/trash/dsh-cleanup/…", "bytes": 1024 },
      { "kind": "session", "id": "session-…", "status": "trashed", "error": null, "movedTo": "…", "bytes": 99 }
    ],
    "totals": { "trashed": 2, "deleted": 0, "failed": 0, "bytes": 1123 }
  }
}
```

A plan is all-or-nothing at admission: before touching anything, re-check state (§5.6). If the
world changed, answer `{ ok: false, error: { code: "STATE_CHANGED", … } }` and change nothing.
After admission, each item succeeds or fails independently; one failure does not roll back the
others, and the result reports every item.

A workspace item can fail **after** its directory already moved: the trash move succeeded and only the
registration delete failed. That item is `failed` with `IO_ERROR` **and** still reports the trash entry
in `movedTo`, because the payload really is there and the user needs to know where. The trash entry is
fully prepared (ownership marker + `meta.json`, §5.7) **before** the payload moves, so a metadata
failure happens while the user's data is still in place: the item fails with `IO_ERROR` and
`movedTo: null`, nothing was moved, and no entry is left. A permanent deletion that failed after the
directory was removed keeps `movedTo: null` (nowhere to recover from).
`totals.bytes` counts only items whose status is `trashed` or `deleted`; a failed item contributes to
`totals.failed` only.

### 4.5 Trash routes

`POST /api/cleanup.trash.list` — request `{}`:

```jsonc
{
  "ok": true,
  "entries": [{
    "id": "20261104T101500Z-proj-8f3a",
    "kind": "workspace-dir",         // "workspace-dir" | "session"
    "title": "proj",
    "originalPath": "/abs/dir",
    "movedAt": 1730000000000,
    "bytes": 1024, "files": 10, "dirs": 3,
    "origin": null,                  // session header.origin when it was recorded ("subagent" marks a subagent log)
    "parentSessionId": null,         // session header.parentSession when it was recorded
    "restorable": true,
    "restorableCode": null           // "RESTORE_ORIGINAL_EXISTS" | "RESTORE_ORIGINAL_MISSING" | …
  }],
  "totals": { "entries": 1, "bytes": 1024 }
}
```
An unreadable trash entry is listed with `restorable: false` rather than omitted; such an entry
reports `kind: null`, `originalPath: null`, and its entry id as `title`; `bytes`/`files`/`dirs` fall
back to `0`, and `movedAt` falls back to the entry directory's mtime.

`origin` and `parentSessionId` are recorded from the Session header when the entry is created, so a
subagent log stays recognizable after its parent is gone (the trash UI marks it). Entries written by
older builds carry no such fields and report `null` for both; a hand-edited or legacy `meta.json`
that stores an empty string for either field also reports `null` (the client keeps its own
non-empty guard only as defense in depth).

`POST /api/cleanup.trash.restore` — request `{ "entryId": "…" }` → `{ ok: true, restoredTo: "/abs/dir" }`.

`restorableCode` is `null` when the entry can be restored, otherwise one of `RESTORE_ENTRY_UNREADABLE`,
`RESTORE_ORIGINAL_EXISTS`, `RESTORE_ORIGINAL_MISSING`, `RESTORE_PAYLOAD_INVALID`,
`RESTORE_PAYLOAD_MISSING`, `RESTORE_UNREADABLE` (the client localizes every one).
`POST /api/cleanup.trash.purge` — request `{ "entryIds": ["…"] }`, or `{ "all": true }` to empty the whole
trash → `{ ok: true, purged: 2, bytes: 1024 }`. Omitting both is a `BAD_REQUEST`: emptying the trash is an
explicit action, never the absence of a parameter. Restoring refuses a payload that is not a plain
directory (a symlink or a file), matching what the list reports as `restorable: false`.

### 4.7 Deferred deletions

DSH keeps every Session's Agent alive for the process lifetime and exposes no API to release one, so
a Session that was opened in this app run cannot have its log deleted now without corrupting it. The
plugin queues the reviewed deletion instead and applies it at the next Host start, before any Agent
exists.

`POST /api/cleanup.defer` — request:

```jsonc
{ "targets": [{ "kind": "session", "id": "session-…" }],
  "mode": "trash", "includeSessions": true, "includeDescendants": true,
  "confirmationText": "proj" }   // only for a permanent workspace-directory plan
```

→ `{ ok: true, deferred: { count, entryIds: ["…"], replaced: false } }`. `count` is the number of
queued **entries**, not the number of targets one entry deletes. Every target must exist now, a plan
may name at most 64 targets, and a malformed `confirmationText` type is `BAD_REQUEST`. The endpoint
fails with `DEFERRED_BUSY` while another process is applying or updating the queue.
A permanent workspace-directory deletion must carry the plan's typed name **even when the plan is
blocked** (that is the common case this feature exists for); the name is validated here with the same
plan rules and stored for the start-up run, which re-derives it. The start-up run skips the entry with
`CONFIRMATION_REQUIRED` when the re-derived expected name differs, with `PATH_CHANGED` when the
confirmed directory no longer exists (or was replaced), and fails it with
`PERMANENT_MULTIPLE_DIRECTORIES` when a second existing directory now makes the permanent plan invalid —
a changed expectation is never guessed.

Each entry also freezes the **reviewed item set** (`{kind,id}` of every planned item) and, for a
permanent workspace-directory deletion, the **confirmed directory identity** (workspace id + canonical
path + device + inode). The start-up run refuses to delete anything outside the reviewed set (it
answers `DEFERRED_TARGETS_CHANGED` and touches nothing) and requires the confirmed directory to still be
that same directory object — a replaced folder, or a different workspace whose name merely ends with the
confirmed segment, is `PATH_CHANGED`. Reviewed items that vanished meanwhile are simply absent from the
re-derived plan; that is not a change of the reviewed set.
Queueing the **same target set** again replaces its mode/options instead of duplicating it
(`replaced: true`, same entry id). The queue holds at most 100 entries; beyond that the request fails
with `DEFERRED_FULL`.

`POST /api/cleanup.deferred.list` — request `{}` →
`{ ok: true, deferred: { entries: [{ id, queuedAt, mode, targets, includeSessions, includeDescendants }], lastRun: { at, results } | null } }`.
`confirmationText` is never projected. One `lastRun` result is:

```jsonc
{ "entryId": "…", "mode": "trash" | "permanent",
  "targets": [{ "kind": "session", "id": "…" }],
  "status": "trashed" | "deleted" | "skipped" | "failed",
  "code": "SESSION_LIVE",        // present when skipped, failed, or executed with a failed item
  "reason": "…",                 // same conditions as `code`
  "items": [{ "kind": "session", "id": "…", "status": "trashed" | "deleted" | "failed" }] }
                               // `items` is present only when the entry executed
```

`status` describes what actually happened: any item moved to the trash is `trashed`, items that only
removed files/registrations are `deleted`, every item failing is `failed`.

`POST /api/cleanup.deferred.cancel` — request `{ "entryIds": ["…"] }` or `{ "all": true }` →
`{ ok: true, cancelled }`. Idempotent: unknown ids are simply not counted. Cancelling an id that
appears in the **retained** list forgets that retained record too (same control, no separate route).

`POST /api/cleanup.deferred.requeue` — request `{ "entryIds": ["…"] }` or `{ "all": true }` →
`{ ok: true, requeued, count }`. The start-up run keeps skipped/failed entries in a bounded **retained**
list (last 20) instead of dropping them; requeue moves them back into the active queue (replacing an
equivalent target set, exactly like `defer`). `deferred.list` projects them after `entries`:

```jsonc
"retained": [ { "id": "…", "at": 1730000000000, "status": "skipped" | "failed",
                "code": "SESSION_LIVE", "reason": "…",
                "mode": "trash", "targets": [ { "kind": "session", "id": "…" } ] } ]
```

### 4.9 Cleanup wizard candidates

`POST /api/cleanup.candidates` — request:

```jsonc
{ "filters": {
    "olderThanDays": 0,          // 0..3650; age measured from header.createdAt
    "archived": "all",           // "all" | "only" | "exclude"
    "minBytes": 0,               // keep sessions whose snapshot size is >= this; an unknown size never matches a positive bound
    "workspaceId": "ws-…",       // exact registry membership id
    "origin": "all",             // "all" | "root" | "subagent"
    "requireDeletable": false    // keep only sessions with no blockers
  },
  "sort": "oldest",              // "oldest" | "largest"
  "limit": 100 }                 // 1..500
```

→ `{ ok: true, candidates: [ { id, workspaceId, cwd, createdAt, sizeBytes, origin, live, running,
archived, pinned, deletable, blockerCodes } ], total, truncated, totals: { count, bytes },
filters: { …normalized… }, sort }`.

It is a read-only projection over the same single inventory snapshot as §4.1, so it never walks the
disk twice and never deletes. `limit` defaults to 100 (bounds 1..500), `sort` defaults to `oldest`, and
the ordering is deterministic: under `oldest` a session with an unknown `createdAt` sorts after every
known time, under `largest` a session with an unknown `sizeBytes` sorts after every known size, and ties
break by session id so the client's "first 64" selection is stable across refreshes. The client turns
the chosen candidates into an ordinary §4.3 plan (at most 64 targets, the plan cap). `total` counts
matches before `limit`; `truncated` says whether `limit` cut
the list; `totals.bytes` sums the known `sizeBytes` of **all** matches and is a lower bound when some
sizes are unknown. Out-of-range values are `BAD_REQUEST` with `details.field`.

### 4.8 Settings

`POST /api/cleanup.settings.get` — request `{}` →

```jsonc
{ "ok": true,
  "settings": { "trashRoot": "…", "allowPermanentDeletion": true, "maxScanEntries": 200000,
                "scanTimeoutMs": 4000, "planTtlMs": 300000, "maxPlans": 32,
                "auditEnabled": true, "auditMaxBytes": 2097152,
                "trashRetentionDays": 0, "trashMaxBytes": 0, "gitSafetyCheck": true },
  "defaults": { … }, "overrides": { … }, "persisted": true }
```

`POST /api/cleanup.settings.set` — request `{ "patch": { …subset of settings… } }` → validates, applies
to the running engine immediately, and persists the merged overrides atomically to `settingsFile` (best
effort: an unwritable location answers `ok:true` with `persisted:false` and a `persistError`). Invalid
values are `BAD_REQUEST` with `details.field`. `trashRoot` is accepted but answered with an
`EXISTING_DATA_STAYS` warning: existing trash stays at the old location. `deferredFile`/`auditFile`
are deployment-level paths and are **not** editable from the Settings page (they are not part of the
settings object). Bounds: `maxScanEntries`
1..5,000,000; `scanTimeoutMs` 1..600,000; `planTtlMs` 1,000..86,400,000; `maxPlans` 1..1,000;
`auditMaxBytes` 0..1,073,741,824; `trashRetentionDays` 0..3650; `trashMaxBytes` 0..1e15 (1,000,000,000,000,000); `gitSafetyCheck` boolean.

### 4.6 Error codes

`BAD_REQUEST`, `UNKNOWN_WORKSPACE`, `UNKNOWN_SESSION`, `PLAN_UNKNOWN`, `PLAN_EXPIRED`,
`STATE_CHANGED`, `CONFIRMATION_REQUIRED`, `CONFIRMATION_MISMATCH`, `PERMANENT_DISABLED`,
`PERMANENT_MULTIPLE_DIRECTORIES`, `WORKSPACE_CONTAINS_WORKSPACE`, `DEFERRED_FULL`, `DEFERRED_BUSY`,
`DEFERRED_TARGETS_CHANGED`, `PATH_NOT_ABSOLUTE`,
`PATH_NOT_DIRECTORY`, `PATH_NOT_SESSION_DIR`,
`TRASH_UNAVAILABLE`, `TRASH_CROSS_DEVICE`, `TRASH_ENTRY_UNKNOWN`, `RESTORE_ORIGINAL_EXISTS`,
`RESTORE_FAILED`, `SESSION_LIVE`, `SESSION_RUNNING`, `SESSION_NOT_DELETABLE`,
`WORKSPACE_MISSING`, `WORKSPACE_SYMLINK`, `WORKSPACE_HAS_LIVE_SESSIONS`, `PATH_PROTECTED`,
`PATH_SHALLOW`, `PATH_CHANGED`, `CONTAINS_DSH_HOME`, `IO_ERROR`, `INTERNAL`, `CANCELLED`.
The vocabulary splits three ways. `PATH_PROTECTED`, `PATH_SHALLOW`, and `CONTAINS_DSH_HOME` are
`lib/paths.js` codes emitted as-is (§5.3 passes the classification through). `PATH_NOT_ABSOLUTE` is
also emitted as-is, for a stored workspace path that is not absolute. `CANCELLED` reports a request
whose `AbortSignal` fired (before the first item, or before an individual item started). `PATH_NOT_DIRECTORY` and
`PATH_NOT_SESSION_DIR` exist in that module but never reach the wire: §5.3 maps not-a-directory to
`PATH_PROTECTED` and §5.1 maps an unrecognizable session layout to `IO_ERROR`.

## 5. Host: domain rules (the part that must be exactly right)

`lib/engine.js` exports one factory so tests inject fakes:

```js
export function createEngine(deps) // → { inventory, measure, plan, execute, trashList, trashRestore, trashPurge }
```

`deps` = `{ workspaceRegistry, sessionPersistence, sessions?, agents?, config, now?, fsOps? }`.
`now()` returns epoch ms; `fsOps` defaults to a thin wrapper over `node:fs/promises` so tests can
substitute a temp-dir implementation. Implement everything below against `deps`, not globals,
except `node:path`/`node:fs` reads that have no reason to be faked.

### 5.1 Resolution and the deletion set

- **Session targets.** Resolve `id` against `sessionPersistence.stat(id)`; a miss is
  `UNKNOWN_SESSION`. Its directory is `path.dirname(stat.location.path)`, and it is accepted only
  when that directory's parent (the project directory) is named `--…--` or `_no-cwd`
  (the JSONL layout) and the session directory itself is at least three segments deep; an
  unrecognizable or implausibly shallow layout is `IO_ERROR` — never delete a directory we do not
  recognize. The plan also records the directory's canonical spelling (`realpath` + `lstat`, symlink
  and non-directory refused) so admission and the pre-mutation check can prove the directory did not
  move or turn into a link.
  With `includeDescendants`, add every stored session whose `origin === 'subagent'` and whose
  `parentSession` chain leads to the target. **Ordinary forks are never included**: a fork with
  `isSeeded` and no `parentSession` (or a `parentSession` pointing elsewhere) is an independent
  session even when it inherits log history.
- **Workspace targets.** Resolve `id` with `workspaceRegistry.get(id)`; a miss is
  `UNKNOWN_WORKSPACE`. `path` is the stored canonical path. With `includeSessions`, add every
  stored session whose `header.cwd` lies inside that path (see `isInside`), recursively, plus
  their subagent descendants regardless of that predicate.
- De-duplicate across targets: one session or one directory appears at most once.
- **One-plan bound.** A plan may contain at most 1000 session items (explicit targets plus swept-in
  sessions). A larger deletion set answers `BAD_REQUEST` and tells the user to delete sessions in
  batches from the Sessions tab first, then delete the directory without `includeSessions`. This
  keeps a single reviewed execution's duration and risk bounded (the same bound is enforced for the
  deferred queue's re-plan).

### 5.2 When a session may be deleted

`live` = `deps.sessions?.get(id) !== undefined || deps.agents?.get(id) !== undefined`.
`running` = `deps.agents?.get(id)?.status === 'running'`.

- A liveness probe that **throws** is not "not live": it is treated as live/unknown and refused as
  `SESSION_LIVE`. Only a resolved absence counts as absent — the gate must fail closed.
- `running` → blocker `SESSION_RUNNING`.
- `live` → blocker `SESSION_LIVE`. DSH keeps a resumed Agent alive for the process lifetime and
  holds that Session's write handle, so deleting its files under a live Agent would corrupt the
  log. The message must say what to do: open the session list in another page / restart the app,
  or stop using that session, then retry. The UI will surface this verbatim (translated by code).
- A session whose stored snapshot has no `location` (never materialized) has no directory:
  deleting it means dropping it from the registry sets only; report it as `deleted` with
  `bytes: 0` and no filesystem work.

A live Agent's **effective** working directory (`ctx.workingDirectory.get(session)`, falling back to
the Session header's `cwd`) counts as "using the directory" for §5.3: a `working_directory` change can
move a session into a folder without touching its header.

**Cross-process writers.** The in-process `sessions`/`agents` services cannot see a Session opened by
another Host that shares `$DSH_HOME`, so when the persistence backend exposes `open(id, 'write')` the
single-writer claim is the cross-process authority (a claim held elsewhere raises
`SessionAlreadyOwnedError`, matched by name or message as "already owned").

- The **plan** probes explicit session targets and reports a `SESSION_LIVE` blocker for a held claim.
  Swept-in sessions are not probed during planning (that would be O(sessions × project directories)).
- **Execution** probes every session item immediately before that item's mutation, after the plan's
  admission. A held claim fails that item alone with `SESSION_LIVE`; nothing is mutated for it.
- The **deferred start-up run** probes the whole planned set once, before executing (§5.8).
- A backend without `open()` degrades to the in-process signal. A claim held elsewhere is
  `SESSION_LIVE`. A log that is already missing, corrupt, or written in a format this build cannot open is **not** a live writer (the
  backend claims its write lease before reading the log, so an ownership conflict is reported first):
  the probe is skipped, nothing blocks the deletion, and a directory that disappeared in the meantime
  is reported `deleted` with `bytes: 0` (§5.5). Any other probe error is `IO_ERROR` (fail closed).
- The probe releases its handle immediately. Note that a backend's write open may parse (and, for a
  legacy or torn log, migrate/repair) the log before handing out the handle; the plan therefore does
  not promise "no write touches the log during review". Races after the probe are inherent to the
  backend, not something a probe can close.

### 5.3 When a workspace directory may be deleted

Re-run at plan time and again at admission:

- `lstat(path)`: `ENOENT` → not a blocker; the plan deletes the registration only
  (`WORKSPACE_MISSING` warning). A missing directory takes that registration-only path and short-circuits
  the rest of this section: it has no directory whose state can change, so the canonical-path,
  classification, live-session, and cross-device checks do not apply and it is never blocked by them
  (its inventory row still reports the informational `sessionsInside`/`liveSessions`). It also sweeps
  **no** stored sessions: `includeSessions` only applies to a directory that still exists, so the plan
  really is registration-only. Anything that is
  not a directory → `PATH_PROTECTED` blocker. A symlink → `WORKSPACE_SYMLINK` blocker.
- `realpath(path)` must equal the registry's stored path (`PATH_CHANGED` blocker otherwise: the
  directory was moved or replaced).
- `lib/paths.js#classifyTargetPath` must accept it. Its codes are blockers as-is.
- Any **live** session with `header.cwd` inside the directory → `WORKSPACE_HAS_LIVE_SESSIONS`
  blocker, whether or not those sessions are in the deletion set ("a live session is using this
  folder").
- The target must not be one of `lib/paths.js#protectedRoots()` — the file-system root, the home
  directory and its parent, `$DSH_HOME`, the temporary directory, system directories, or the Harness
  process's own working directory and any directory that **contains** it (deleting the launch
  directory or one of its ancestors breaks the running process and the plugin's own checkout).
- The directory must not contain `$DSH_HOME`, and `$DSH_HOME` must not contain the directory
  unless it is inside the plugin's own trash root (never a legit target). Both spellings of every
  protected path are compared (lexical and `realpath`), so a symlinked home cannot hide it.
- The target must not contain the configured trash root: deleting it would destroy recoverable data.
- Another **registered** workspace nested inside the target is unreviewed collateral: the plan warns
  (`WORKSPACE_CONTAINS_WORKSPACE`) and permanent mode blocks with the same code.
- `mode === 'permanent'` with `config.allowPermanentDeletion === false` → the whole plan call fails
  top-level with `PERMANENT_DISABLED` (no plan object); it applies to session-only permanent plans too,
  because it is a deployment capability rather than a property of one target.
- `mode === 'permanent'` with more than one existing workspace directory → the whole plan call fails
  top-level with `PERMANENT_MULTIPLE_DIRECTORIES` (see §4.3).
- `mode === 'trash'` and the target and trash root are on different devices (`st_dev`) →
  `TRASH_CROSS_DEVICE` blocker suggesting permanent deletion. Determine this at plan time by
  `stat`-ing the target and the nearest existing ancestor of the trash root.

### 5.4 Warnings (never blocking)

`WORKSPACE_MISSING`, `WORKSPACE_HAS_GIT` (`.git` present — uncommitted work is lost),
`SCAN_TRUNCATED` (walk budget hit, or an unexpected read error made the size a lower bound),
`LARGE_TARGET` (> 1 GiB), `SESSIONS_FROM_DIR` (n sessions whose logs live elsewhere but whose cwd is
inside — deleting the folder leaves them ungrouped; never emitted for a missing directory),
`SESSION_HAS_DESCENDANTS` (informational count), `SESSION_NOT_DELETABLE` (an indirectly swept session
whose stored layout is unrecognizable; it is skipped instead of failing the whole plan),
`WORKSPACE_CONTAINS_WORKSPACE` (§5.3), `WORKSPACE_GIT_DIRTY` (n changed/untracked entries in the
repository), `WORKSPACE_GIT_UNPUSHED` (n commits not on any remote). The git warnings are produced only
when `gitSafetyCheck` is on: the probe is read-only and bounded (3 s, output cap), skips non-repositories
and a missing `git` binary silently, and never changes a blocker into an allow or vice versa.

### 5.5 Deletion execution order

1. Re-validate the whole plan (§5.6).
2. For each session item, immediately before that item's own file mutation: first probe the
   cross-process write claim (§5.2), then `unpinSession(id)` then `unarchiveSession(id)`, then the
   per-item pre-mutation re-check (§5.6). The shipped registry documents an absent id as an idempotent
   no-op that resolves, so no rejection is benign here: every rejection is surfaced as a real storage
   failure for that item. Dropping the sets before this item's files means a crash
   cannot leave a pinned id pointing at a deleted log; because the drop is per item, a later refused
   item keeps its own sets unless its re-check itself fails after the drop (the registry state is
   then already unpinned, which is harmless and files are untouched).
3. Sessions first, then workspace directories: trash-move (`rename`, falling back to
   `TRASH_CROSS_DEVICE` when `EXDEV`) or `rm -rf` (`fs.rm(dir, { recursive: true, force: true })` —
   but only after the tree was verified to be the intended directory).
4. After a workspace directory is gone (or was already missing), call
   `workspaceRegistry.delete(workspaceId)`. If that throws, the item is `failed` with `IO_ERROR`
   and the directory stays gone — report exactly that.
5. Immediately before each item's mutation, re-derive its safety (`§5.6` per item): a session that
   became live, a directory that vanished or became a symlink, or a live Agent whose effective working
   directory moved inside a workspace item fails that item alone. A vanished session directory is
   reported `deleted` with `bytes: 0`; a replaced one is `failed` with `PATH_CHANGED`.
6. The trash entry is prepared (marker + metadata, §5.7) **before** the payload moves. A prepare
   failure therefore happens with the user's data untouched: discard the empty allocation and fail the
   item with `IO_ERROR` and "nothing was moved". There is no rollback; the only copy of the data is
   never at risk.
7. Never throw out of `execute`: every item gets a status.

`rm -rf` must be implemented as a bounded recursive walk with `lstat` (never following
symlinks), the configured entry budget plus a fixed internal depth bound, and it must refuse to run on an empty or
one-segment path.

A plan that was created with `blockers` can never mutate anything: admission re-seeds every planned
blocker as a changed-world reason, so executing it answers `STATE_CHANGED` even when nothing about the
world actually changed. One refinement: when the plan also requires a typed name (a blocked permanent
workspace-directory plan, §4.3), `execute` validates the typed name **before** admission, so a call
without it answers `CONFIRMATION_REQUIRED` instead (and consumes the plan). The UI disables the
destructive action while blockers exist, so this path is defence in depth rather than a user flow.

Admission itself is expected to be cheap: it must locate every planned session from a **single**
persistence listing rather than one `stat()` per session (the JSONL backend's `stat` scans every
project directory, so a per-session loop can stall the destructive flow for tens of seconds).

### 5.6 Admission re-check

Immediately before the first mutation, redo §5.2/§5.3 for every item and compare each session's
`stat.location.path`. Any difference from the plan → `STATE_CHANGED` (HTTP 200, `ok: false`),
nothing mutated. This is what makes the plan a real safety barrier rather than a formality.

Executions are serialized **inside one Host process** (a second `execute` waits for the first): two
plans over one target used to race into a spurious `IO_ERROR`, and the second run now re-checks the
already-changed world and answers `STATE_CHANGED` instead. Across processes the per-item cross-process
probe (§5.2) is the authority; there is no cross-process deletion lock.

The plan and execute routes forward the request's `AbortSignal`. An abort before the first mutation
answers `CANCELLED` with nothing deleted; an abort between items stops before the next item, which is
reported failed with `CANCELLED` (items that already succeeded stand, and their results are returned).
A cancelled item never drops registry sets or touches files.

### 5.8 Deferred queue

`$DSH_HOME/cleanup/deferred.json` is one plugin-owned document (`version: 2`, `entries`, `retained`,
`lastRun`; a `version: 1` document is migrated on read and rewritten as 2), written atomically (temp
file + rename, owner-only). Queue mutations (queue, cancel, start-up run) are
serialized inside one Host process, so two tabs cannot lose each other's updates. Across two Host
processes sharing one `$DSH_HOME` a lock file serializes them as well: an overlapping mutation answers
`DEFERRED_BUSY` rather than being silently overwritten, and the atomic rename still guarantees a
never-torn file. The once-per-process "already applied" guard is keyed by the queue-file path, so a hot
reload of the same queue is skipped while independent homes do not block each other.

**Trust boundary.** The queue is user-writable state inside the profile home, like the trash itself.
The plugin's "deletion is a user action" rule is a property of its own surfaces (the UI performs it and
the agent tool is read-only), not a sandbox: any process running as the same user that can write
`$DSH_HOME` could also delete files directly, and a forged queue entry cannot be distinguished from a
reviewed one. The startup run therefore still applies every rule (§5.2 liveness, §5.3 path safety,
§5.6 admission), but it cannot re-authenticate the human. Keep the profile home owner-only (the Host
creates it `0700`); the audit log is diagnostic only, and a future iteration can add an out-of-band
confirmation for queued permanent deletions if the threat model requires it. A missing or corrupt document is an empty queue —
losing the queue can only cancel work, never cause an unexpected deletion. Entries are normalized when
read: an entry whose targets are not well-formed `{kind,id}` pairs is ignored rather than projected, so
a hand-edited document degrades to "nothing scheduled" on every route (never a partial 500). A document
whose `version` is neither 1 nor 2 is treated as empty (the queue is destructive state; an unknown
schema is never guessed at), and the 100-entry cap is enforced on read as well as on write, so a hand-written
document cannot make the boot run unbounded.

At plugin activation the plugin applies the queue **once per process**, which in a normal start is
before the browser can resume anything. The run first takes the queue's cross-process **run claim**
(`deferred.json.run.lock`, atomic create, owner-only). The claim records its pid and time: a claim whose
process no longer exists is removed immediately, a claim whose pid is still alive is kept regardless of
age (a legitimately long run owns the queue), and a claim without a usable pid is taken over after
10 minutes by its recorded time or, when that is missing too, by the claim file's mtime. The age-based
takeover inside `acquireDeferredLock` is deliberately disabled for this claim (`staleMs: Infinity`), so
a second Host never breaks a live run; only the pid-aware check above may take it over. Queue mutations
(queue, cancel, start-up run) use the separate `deferred.json.lock` with a 30 s stale takeover; a
second Host that finds a mutation lock held answers `DEFERRED_BUSY` instead of reporting success while
being overridden. A second Host that finds the run claim held applies nothing (the holder applies the
queue), so two processes sharing `$DSH_HOME` never double-delete. This is best-effort rather than a hard ordering guarantee: the
run is started asynchronously so plugin activation never blocks on it, and a page that reconnects
immediately could resume a Session while the run is in flight. Safety therefore does not rely on the
ordering — each entry runs through the ordinary `plan` → admission → `execute` pipeline **including
the per-item pre-mutation re-check**, so a Session that became live in the meantime is recorded as
`skipped`/`SESSION_LIVE` and its log is left alone. Because §5.2 liveness is process-local, the start-up
run additionally proves each planned Session is writable by opening the persistence write handle and
closing it again (the backend's single-writer claim is the cross-process authority); a Session held live
by another Host is `skipped` as `SESSION_LIVE` rather than deleted under a live writer. An entry that is still blocked is recorded as
`skipped` with the blocking code, one that vanished is `failed`, and a permanent directory entry whose
stored typed name no longer matches the plan is `skipped` with `CONFIRMATION_REQUIRED`. The queue is cleared only after
a successful write of the results; on a write failure the entries are kept for the next start. A
plugin hot-reload re-enters `apply` in the same process and must never consume the queue, so the
once-per-process guard is process-global rather than per-instance.

### 5.9 Audit log, retention warnings, and queue retention

Every destructive action appends one JSON line to `auditFile` when `auditEnabled`: deletion plans
(`action: "delete"`, source `immediate`), start-up entries (`action: "delete"`, source `startup`, with
`entryId`), skips (`action: "skip"` with `code`), trash restore/purge, and queue defer/cancel/requeue.
Records are owner-only; the log rotates to `audit.jsonl.1` past `auditMaxBytes` (one generation). A
write failure is ignored by design (auditing is diagnostic) and never fails the action. One action
writes exactly one record: the start-up run suppresses the interactive `immediate` record for the plans
it executes and writes the `startup` record itself.

`trashRetentionDays` / `trashMaxBytes` are **warnings only**: the inventory reports
`oldestMovedAt`/`overRetention`/`overCapacity` and `suggestedEntryIds` (oldest entries whose purge brings
the trash under `trashMaxBytes`, at most 50). The UI may offer one click to purge exactly those entries;
nothing is ever deleted automatically.

The start-up run claims one queue entry at a time (`inFlight` marker under the queue lock) so a long run
does not block `defer`/`cancel`; an entry whose claim is older than 10 minutes is retried.

`deferred.requeue` refuses with `DEFERRED_FULL` when putting the selected retained entries back would
exceed the 100-entry active-queue cap; it never evicts an already-queued deletion to make room. Only entries
queued **at or before the moment the run started** are applied: one queued while the run is in progress (a page
reconnecting) waits for the next start instead of being deleted by a run it was not reviewed for.
Skipped and failed entries move to the bounded `retained` list (20) with their `code`/`reason`, from
where the user can requeue or drop them.

### 5.10 Preview cache

Directory-size walks for the measure preview (`§4.2 workspace` sizes) are cached per workspace directory
for 30 s: the key is the canonical path plus the directory's device/inode, so a replaced directory is
never served from cache. Any mutation that changes the disk (delete, trash restore) clears the cache.
Sizes are advisory previews only — the deletion path never trusts a cached size — and a cache miss is
always a fresh bounded walk.

### 5.7 Trash layout

```
$trashRoot/<entryId>/                 entryId = <UTC yyyymmddThhmmssZ>-<slug>-<4 hex>
  .dsh-cleanup-entry                  ownership marker (new in 0.4.0), written before the payload moves
  meta.json                           { version: 1, kind, title, originalPath, movedAt, bytes, files, dirs,
                                        workspaceId?, sessionIds?, origin?, parentSessionId? }
  payload/                            the moved directory (session dir or workspace dir)
```

`origin` and `parentSessionId` (new in 0.5.0) are copied from the Session header when a `session`
entry is created and only when they are non-empty strings; other entries and entries written by
older builds omit them, and §4.5 reports `null` for both.

An entry is **prepared before the payload moves**: allocate the directory, write the ownership
marker, write `meta.json`, and only then `rename` the payload in. A failure while preparing discards
the empty plugin-owned allocation and reports `IO_ERROR` with "nothing was moved" — the user's data
is still in place, so there is no rollback and no entry to keep. A crash between the metadata write
and the rename leaves a listed entry whose payload is missing (`RESTORE_PAYLOAD_MISSING`); a crash
between the rename and nothing else cannot occur because the rename is the last step.

**Ownership.** Only a directory that carries the marker, or (for 0.3.0 entries) whose
`meta.json` has this plugin's exact shape (`version: 1`, `kind` in {`workspace-dir`, `session`},
absolute `originalPath`, finite `movedAt`), is a trash entry. A directory under `trashRoot` that
matches neither is **ignored** by list, restore and purge — never deleted — so a `trashRoot` that
was pointed at an existing data directory cannot turn "empty the trash" into `rm -rf` over unrelated
data. Restore answers `TRASH_ENTRY_UNKNOWN` for such a directory.

Restore moves `payload/` back to `originalPath` only if that path does not exist and its parent does;
it then removes the entry directory. Purge `rm -rf`es only owned entry directories. Trash entry
directories are created with mode `0o700`; the marker and `meta.json` are `0o600`.

Restore and purge are serialized with planned executions **inside one Host process** (the same
mutation lock as `execute`), so a purge cannot remove an entry while its payload is being moved. This
is not a cross-process lock: two Hosts sharing one `trashRoot` are not coordinated, and a `trashList`
concurrent with an execution may briefly show a prepared entry whose payload has not moved yet.

## 6. Host: read-only agent tool

Register with `ctx.tools.register` when `ctx.get('tools')` exists. Name `cleanup_inventory`.
Description states: lists workspaces and sessions with disk usage and deletion blockers; it
cannot delete anything; deletion is a user action in Settings → Storage cleanup, so tell the user
to open that page and describe what you found.

Parameters (JSON Schema object, `additionalProperties: false`):

```jsonc
{ "workspaceId": { "type": "string" }, "includeSizes": { "type": "boolean" }, "limit": { "type": "integer" } }
```

The parameters stay inside the `dsh-tools` enforced subset (`type`, `oneOf`, `properties`, `required`,
`additionalProperties`, `items`, `enum`, `const`, and annotations); `minimum`/`maximum` are outside it
and are enforced by the tool's own argument validation instead.

Output schema: object with `workspaces` (array), `sessions` (array), `trash` (object), `notes`
(array of strings), all required. `render` returns one text content block: a short Markdown
summary (counts, total bytes, the largest three targets, the note that deletion is user-only).

## 7. Client: module shape

`client.js` is a classic browser script:

```js
window.__ModuleLoader__.load({
  id: 'dsh-cleanup',
  factory(require) {
    const React = require('react')
    // ... everything else inline, no other require()
    return { inject: ['slots', 'locale', 'contextMenus'], apply(ctx) { /* ... */ } }
  },
})
```

`apply(ctx)` must register, each through `ctx.slots.inject(...)` where a slot is involved:

1. **Locale dictionaries** — `ctx.effect(() => ctx.locale.register('cleanup', { zh, en }))` then
   `const t = ctx.locale.bind('cleanup')`. Guard against a missing `ctx.locale` (skip UI if absent).
2. **`shell.overlay`** — one entry `id: 'dsh-cleanup-dialog'`, `order: 900`, the review dialog for a
   review opened from a context menu (a settings-page review renders inside that page instead, §9).
3. **`settings.section`** — one entry `id: 'cleanup'`, `order: 85`,
   `label: () => t('section.label')`, `locale: 'cleanup'`, the storage page.
4. **`contextMenu.icon`** — key `cleanup.trash`, a 16px trash glyph (inline SVG, `currentColor`).
5. **Context-menu contributions** via `ctx.contextMenus.register(...)`:
   - `target: 'session'`: one danger action `delete-session`, `label: t('menu.deleteSession')` (a
     resolved **string** — the host renders `MenuActionView.label` as a React child, so it must not be a
     function; resolve it when the menu opens), `icon: { key: 'cleanup.trash' }`, `separatorBefore: true`,
     `run()` opens the dialog for `{ kind: 'session', id: target.sessionId, title: target.displayTitle }`.
   - `target: 'workspace'`: one danger action `delete-workspace-dir`,
     `label: t('menu.deleteWorkspace')`, `icon: { key: 'cleanup.trash' }`,
     `run()` opens the dialog for `{ kind: 'workspace', id: target.workspaceId, title: target.displayTitle, path: target.path }`.
   - `target: 'workspace'`: one danger action `clear-workspace-sessions`, `order: 350` (above the
     folder deletion), `label: t('menu.clearWorkspaceSessions')`, `icon: { key: 'cleanup.trash' }`,
     `separatorBefore: true` (the folder deletion no longer carries one, so the two destructive rows
     share a single divider). `run()` pre-flights §4.9 with `filters: { workspaceId }` and hands the
     result to §9's workspace clear, which always opens: an empty or failed pre-flight renders inside
     the dialog (`done` with `没有可清理的会话` plus the in-use count, or the ordinary `failed` state
     with `重试`), never as a toast. Only a malformed menu target — the registry value missing its id
     — reports through `ctx.contextMenus.notify` (`无法识别该工作区的菜单目标，请刷新后重试。`).
   - Reading `target.value` twice is a bug: the registry passes the *value*, so implement
     `resolve(target)` against the plain `{ sessionId, displayTitle }` / `{ workspaceId, path, displayTitle }`.

All registrations are disposed by their owning slot/effect; the dialog and page must also cancel
in-flight fetches and clear timers on unmount.

## 8. Client: HTTP

```js
const ROUTE = {
  inventory: '/api/cleanup.inventory'.slice(1),
  measure:   '/api/cleanup.measure'.slice(1),
  plan:      '/api/cleanup.plan'.slice(1),
  delete:    '/api/cleanup.delete'.slice(1),
  trashList: '/api/cleanup.trash.list'.slice(1),
  trashRestore: '/api/cleanup.trash.restore'.slice(1),
  trashPurge: '/api/cleanup.trash.purge'.slice(1),
}
```
`fetch` is **document-relative** (no leading slash) exactly like the shipped session export. Send
`POST`, `content-type: application/json`, `body: JSON.stringify(payload)`, and pass an
`AbortSignal` from the modal/page lifetime. Treat a non-JSON body, a network failure, and
`{ ok: false }` as three distinct failures with distinct copy.

## 9. Client: the review dialog

A single review dialog driven by a module-level store (`getSnapshot`/`subscribe`, consumed with
`React.useSyncExternalStore`). It is mounted twice — once as the `shell.overlay` entry and once
inside the storage-cleanup settings page (§10) — and the store records which **surface** opened it
(`overlay` for the context menus, `settings` for that page). Only the copy matching the current
surface renders, so exactly one review is on screen. States:

| state | UI |
|---|---|
| `idle` | render `null` |
| `planning` | skeleton: "正在检查…" with a spinner |
| `review` | full review (below) |
| `deleting` | progress line, buttons disabled |
| `deferring` | the queued-deletion request is in flight; buttons and dismissal are disabled |
| `deferred` | queued result: distinct title, the number of **items this plan deletes** (from the reviewed plan, not the Host's entry count), mode, the current queue size as a separate sentence, a replaced note, and where to review/cancel; a live region, never auto-closed |
| `done` | result summary: counts and bytes, plus every distinct trash location when trashed. **Failure-aware**: when nothing succeeded and something failed it is presented as a failure (error title, failed count primary), and with any failed item it does not auto-close |
| `failed` | code → localized message, `message` as a fallback line, "重试" and "关闭" |

Review shows, in order: title (`删除会话` / `删除工作区目录`), the **target rows** (below), warning
list, blocker list (red, with the localized reason), mode
selector (two radio-like buttons; permanent disabled when `allowPermanentDeletion` is false or
the config forbids it), for a workspace target a checkbox "同时删除该目录内的会话记录"
(re-plans on toggle; `includeSessions`), typed confirmation input when `confirmation` is non-null,
and the footer: `取消` + `删除` (`danger`, disabled while blockers exist or typed text mismatches).
When the dialog was opened for more than one workspace target, the permanent mode option is disabled
with an explanation (one typed folder name must never authorize several folders); a session-only batch
keeps both modes. A selection change that grows the planned workspace targets past one while the mode
is permanent switches the mode back to trash and shows the reason next to the selector, instead of
sending a permanent plan the Host would refuse; the manual restriction above is unchanged. A top-level
`PERMANENT_MULTIPLE_DIRECTORIES` answer still renders as the localized `failed` state in case the two
halves disagree.
Escape and the backdrop dismiss it in `review`/`failed` but not while `deleting`. Focus starts on
the cancel button; the dialog is `role="dialog"` `aria-modal="true"` with an accessible title.

**Target rows and selection.** The list is grouped by *reviewed target*, never by plan item: one row
per target (checkbox, badge, title, path, size/files). Every reviewed row always carries a checkbox —
a single-target review included — and it starts checked. A Session row owns the plan item of the same
id plus every subagent descendant whose `parentSessionId` chain reaches it; a workspace row owns its
directory item plus the Sessions swept in by the folder predicate. Ride-along items are collapsed
under their row behind a `展开 · N 个子代理会话` toggle (or `N 个目录内会话` for a folder), so a
Session with 30 subagent logs still renders as one row; the toggle carries `aria-controls` pointing
at the list it expands. Items that belong to no row are listed last instead of disappearing.

Each row's checkbox narrows what is planned: un-checking re-plans with only the checked targets, and
`全选` re-checks every row while `反选` inverts the set. A checked parent never brings an un-checked
row back through its subagent closure: when a plan would contain one, the dialog re-plans with
`includeDescendants: false` so the checkbox wins, and explains why next to the switch (it stays off
until the user turns it back on). If a re-plan nevertheless returns a plan containing **any** un-checked target —
a workspace folder sweep can carry Sessions whose own row is un-checked even with
`includeDescendants: false` — the dialog fails closed with the client-only code
`UNCHECKED_TARGET_LEAK` and sends no delete request. `state.targets` keeps every reviewed row (the
plan carries the checked subset in `plan.targets`), so un-checking is reversible — including the last
row: an empty selection keeps every row on screen (dimmed with `已取消选择，不会删除`), drops the
plan, shows `请至少选择一个目标`, and keeps the destructive button disabled, so the Host is never
asked to plan an empty target set. While a re-plan is in flight (`refreshing`), a checked row whose
item is not in the new plan yet renders `重新规划中…` instead of `已取消选择，不会删除`, and the totals
area shows `正在重新计算复核结果…` instead of the previous plan's numbers, so a slow plan never
presents stale rows or totals as the current review. Inside a workspace clear the same checkboxes
narrow the current batch, and an un-checked row is recorded in `clear.excluded` so no later
candidates page brings it back. Subagent descendants follow a `同时删除子代理会话` switch
(`includeDescendants`), shown whenever a Session target is planned outside a workspace clear and
re-planning on toggle, so the collapsed group disappears and reappears with it; when the dialog
turned the switch off automatically, the reason from above is shown next to it.

A review opened from the settings page renders **inside** that page, not in `shell.overlay`: the host
paints the overlay seat at `z-index: 20` inside the app frame while the settings sheet is a fixed
layer at `z-index: 1000`, so an overlay dialog could only be shown by closing the sheet. The
sheet-hosted copy is fixed and stacked above the sheet's own panel, which keeps the user's place:
dismissing the review returns to the same tab with the sheet still open, Escape closes only the
dialog (never the sheet underneath, including while a delete is in flight), no new review may replace
one whose delete/queue request is still on the wire, and closing the sheet
closes the review — unless a delete or queued-deletion request is still in flight in that copy, in
which case only the copy unmounts: the request is not aborted and its state is kept, so reopening
Settings → Storage cleanup shows the progress or the result. A summary produced after such an unmount
is flagged to outlive the dwell timer, so even a clean result waits for the user. A context-menu
review keeps the overlay path and closes nothing else.

When the plan is blocked **only** by blockers that a restart clears — `SESSION_LIVE`,
`SESSION_RUNNING`, or `WORKSPACE_HAS_LIVE_SESSIONS` for a folder held by a live session — the review
footer offers `安排删除（本次启动结束后自动执行）` next to the disabled destructive button: it queues
the same reviewed targets through `/api/cleanup.defer` (forwarding the typed name when the plan
requires one) and switches to the `deferred` state. The request is derived from the reviewed plan's
`targets`: when the reviewed plan carries no targets at all, the dialog treats it as a malformed
response (`badResponse`) instead of falling back to rows the user un-checked. Any other blocker kind
withholds the offer and explains that it would not clear on a restart. The blocker copy explains the
cause (the session was opened in this app run; DSH holds its write handle until exit) instead of
telling the user to restart and retry blindly.

The `done`/`deferred`/`failed` result renders inside a `role="status"` `aria-live="polite"` region
associated with the dialog through `aria-describedby`, because the result of an irreversible action
must be announced and readable. Only a fully successful deletion auto-closes (after the dwell); a
result with failures, skipped rows, or a queued deletion waits for the user. Focus is moved only on phase entry, never when a re-plan replaces the
plan in place, and closing returns focus to the trigger when it still exists (otherwise to a stable
frame element) instead of dropping focus to `<body>`.

On success: refresh client data — call `ctx.get('sessions')?.refresh?.()` (guard the promise) — and
let the Workspace follow stream update by itself. The same refresh runs after a trash restore/purge,
so a restored session reappears in the sidebar.

### Workspace clear

`clear-workspace-sessions` (§7 item 5) deletes every Session log of one workspace and keeps the
folder and its registration. One plan holds at most 64 targets (§4.3), so the clear walks the
workspace in batches inside the same dialog:

- **Pre-flight.** §4.9 with `filters: { workspaceId, requireDeletable: false }`, `sort: 'oldest'`,
  `limit: 500`. Rows with `deletable: false` (open or running in this app run) are counted as
  skipped and never queued — a plan holding them could never execute. The skipped count is keyed by
  `kind:id`, so a refilled candidates page that repeats an in-use Session never counts it twice. The
  dialog always opens and stays; a second clear/pre-flight request while one is running is ignored
  because the running walk owns the dialog. A workspace whose logs all merely wait for a restart opens the
  review with their blockers and `安排删除` (Review); otherwise a pre-flight with nothing to queue
  lands in `done` with `没有可清理的会话` plus how many logs are skipped, when any, and a failed
  pre-flight lands in the ordinary `failed` state, where `重试` re-runs the pre-flight. Neither case
  is reported through `ctx.contextMenus.notify` (only a malformed menu target is).
- **Review.** The first batch of at most 64 targets becomes an ordinary plan. The title is
  `清空工作区会话`, the footer button reads `清空会话`, and a note states how many logs the workspace
  holds, that the review covers the first batch, and that only logs are deleted. When the plan covers
  more log items than the batch's checked root targets (subagent logs and folder-swept Sessions), an
  extra note reads `本次复核包含 N 条日志（含子代理会话）`; a deferred result derives its
  not-yet-included count from the batch's planned root targets. The review rows are checkboxes here too (`全选` /
  `反选` included): un-checking a row re-plans the batch without it and records the id in
  `clear.excluded`, so neither the drained queue nor a refilled page ever brings it back, and the
  result reports how many rows were left out. The mode selector still applies (trash by default).
  When every matched log merely waits for a restart (open or running in this app run), the same rows
  open in the review with their blockers and `安排删除` — queueing is withheld only while a batch can
  actually run.
- **Confirmed walk.** Each executed batch folds its totals into the running `clear.done` and
  immediately plans and executes the next batch without a second review. Progress reads
  `第 N 批 · 已清理 M 条`. After each batch, the ids that batch reports as `trashed`/`deleted` are
  removed from the remaining queue, so a log an earlier batch already removed as a subagent
  descendant cannot make the next plan fail wholesale with `UNKNOWN_SESSION`. If a batch plan still
  answers `UNKNOWN_SESSION` (a target deleted outside this app run), the client re-reads the
  candidates and rebuilds the queue while keeping `clear.excluded` and the folded totals, then
  continues; a batch rebuilds this way at most `CLEAR_RESYNC_MAX = 2` times in a row (the budget
  resets after a successful batch or an explicit retry), and a rebuild that yields no targets
  settles normally instead of failing. A batch plan that names a target the user un-checked in the
  reviewed batch first re-plans with `includeDescendants: false`; if the Host still plans the
  un-checked target, the walk fails closed with the client-only `UNCHECKED_TARGET_LEAK` code and
  never deletes it. That fallback keeps the un-checked log on disk but leaves the batch's other
  subagent logs un-expanded, so a later clear may still find them. When the queued targets drain, the next
  candidates page is fetched, bounded by `CLEAR_MAX_ROUNDS`. The walk stops early on a plan blocker,
  a failed request, or that bound; a fetched page that brings new undeletable rows ends the walk as
  `blocked` with the remaining count instead of claiming the workspace is clear, while a page that
  only repeats already-counted in-use Sessions is drained and settles normally. Retrying a failed
  walk resumes it: refetch when a page is pending, otherwise re-run the current batch — the folded
  totals are never dropped, and a walk with nothing left to try keeps the failure on screen.
- **Result.** `done` renders the folded totals, the reason the walk stopped, the skipped count and
  where the logs can be restored from. It auto-closes only when the walk is completely free of
  residue — `stop === null && failed === 0 && skipped === 0 && excluded === 0` — and otherwise stays
  until the user dismisses it. A failed request renders the ordinary `failed` state with the
  already-cleared total above the error.

## 10. Client: the settings page

A `settings.section` page titled "存储清理" with four tabs: **工作区**, **会话**, **回收站**, **清理设置**.

- Header row: section title, one-paragraph explanation, `刷新` button, and a size-measuring
  button when the active tab has unmeasured rows.
- Above the tabs, a **deferred notice** renders whenever `inventory.deferred.count > 0` or a
  `lastRun` exists: the notice counts queued **entries** (`N scheduled deletions · applied at the next
  DSH start`), an expandable list (fetched lazily through `/api/cleanup.deferred.list` on first
  expansion) with queued time, mode, the number of targets the entry covers, resolved target labels
  (workspace titles from the current inventory, otherwise the path basename or short id) and a two-step
  `取消` per entry plus `全部取消` (same 400 ms cooldown and disarm rules as the trash purge; an arm is
  cleared when the queue empties), and a **last-start summary** reporting entries processed, total
  targets, skipped and failed counts, with an optional expanded list of non-successful entries
  (localized status/code, Host reason for unknown codes). After a successful cancel focus moves to the
  banner toggle (or the page heading when the banner disappears) and the announcement lives in a
  persistent page-level live region.
- Workspaces tab: one row per workspace — title, canonical path (mono, middle-ellipsis),
  `n 个会话`, size (unmeasured → `测量`), state badge (`缺失`/`不安全`), and a `删除…` button that
  opens the dialog. Multi-select checkbox per row plus a batch bar "删除选中 (n)".
- Sessions tab: one row per session — title (fall back to `cwd` + short id), created date,
  size, badges for `运行中` / `已打开` / `归档` / `子代理` / `不可删除`, a coloured row checkbox, and a
  `删除…` button. Subagent logs whose parent is on the page collapse under that parent behind a
  `展开 · N 个子代理会话` toggle; a log whose parent was filtered out or is past the page limit stays a
  top-level row and keeps its `子代理` badge. Grouping is layout only: every row keeps its own
  checkbox, measure and delete controls; the expand toggle carries `aria-controls` pointing at the
  list it expands. A workspace selector comes first — `全部工作区`, `未分组`, and
  one entry per registered workspace — and narrows the list before the sort and archive filters
  apply; changing it restarts paging and clears the current batch selection, so rows that are
  filtered out can never be deleted by a batch the user cannot see. The archive filter clears the
  batch selection for the same reason. Membership is inherited: a subagent log takes its parent's
  workspace through `parentSessionId`, so it never shows up under `未分组` while its parent is
  registered (and it folds under that parent in the workspace view); only a log whose parent is gone
  stays ungrouped. A sort selector offers newest / oldest / largest (largest only among
  measured rows, unmeasured last), an archive filter offers all / only archived / hide archived, and a
  batch bar `删除选中 (n)` opens the review dialog with every selected session as a target. Pagination
  stays at 300 rows with `显示更多`, and its expanded limit survives switching tabs. Row controls carry
  the row title in their accessible name.
- Trash tab: one row per entry — title, original path, moved time, size, a `子代理` badge and a
  `父会话 …` line when the entry recorded a Session family (§4.5), `恢复` and
  `彻底删除`; the `父会话` line shows the short id but carries the full Session id in its `title`.
  A `清空回收站` action in the tab header, both permanent actions confirmed inline
  (a second click within the row, not a browser `confirm()`). When `inventory.trash` reports
  `overRetention`/`overCapacity`, a warning banner states the size/max and oldest-age/retention and
  offers `清理最旧条目 (n)` which purges exactly `inventory.trash.suggestedEntryIds` through the same
  two-step confirmation; it never deletes automatically.
- Sessions tab: a `按规则选择` (cleanup wizard) action opens an inline wizard — age/archived/size/
  workspace/origin/sort filters, a debounced `candidates` preview with match count, known bytes,
  truncation note and a "review at most 64" cap — then continues through the ordinary review flow;
  the wizard itself never deletes and the review dialog remains the only confirmation.
- Settings tab: `settings.get` form (permanent-deletion toggle, trash retention days/capacity,
  audit toggle/rotation, scan budgets, read-only trash root), client-side bound checks, changed-only
  patch on save, inline `persisted:false`/`persistError` and per-field `details.field` errors, reset
  to defaults; plus a **recent deletions** list from `inventory.audit.recent` and a last-start line
  from `inventory.audit.lastStartup`. A one-time page notice shows the last start-up result when it is
  within 24 h and not yet acknowledged (localStorage, guarded).
- The deferred notice also lists `retained` (skipped/failed) entries with status/code/reason and
  two-step `重新安排` (`deferred.requeue`) / `忽略` (`deferred.cancel`) actions, and its collapsed head
  reports the retained count.
- Empty/loading/error states for each tab; errors show the localized reason and a `重试`.
- Footer note: the recovery window is not time-limited — trash is manual — and permanent deletion
  cannot be undone.

Data: `inventory` on mount (and after every mutation), `measure` on demand from the page,
`trashList` for the trash tab. The review dialog never measures separately: its plan already carries
the per-item sizes computed at plan time, so the numbers it shows are exactly the numbers the Host
will act on. Keep one module-level store per mounted page; no
polling. Re-render from the store with `useSyncExternalStore`.

## 11. Styling and capability rules

- Only design tokens from the Theme inspection may carry color: `--dsw-alias-bg-base`,
  `--dsw-alias-bg-layer-1`, `--dsw-alias-bg-layer-2`, `--dsw-alias-bg-overlay`,
  `--dsw-alias-border-l1`, `--dsw-alias-border-l2`, `--dsw-alias-brand-primary`,
  `--dsw-alias-label-primary`, `--dsw-alias-label-secondary`,
  `--dsw-alias-state-error-primary`, `--dsw-alias-state-warn-primary`,
  `--dsw-alias-state-success-primary`, `--dsw-alias-state-idle-primary`,
  `--dsw-specific-sidebar-fill`. Literal colors only for artwork (the icon glyph).
- Inline styles are acceptable; a single injected `<style>` keyed by the package name is better
  for hover/focus states. Rename every class with a `dsh-cleanup-` prefix. Remove the style tag
  when the plugin unloads.
- No `@deepseek-ai/*` require, no DOM reads of host components, no `document.body` appends
  outside the overlay root, no `alert`/`confirm`/`prompt`.
- Every visible string goes through `t(...)`; no hard-coded Chinese or English in components.
- DSH 0.2.2-rc.1 ships **eight built-in UI languages** (`zh`, `en`, `ja`, `es`, `fr`, `de`, `ru`,
  `pt`): its locale plugin registers the six non-Chinese/English languages itself. This client plugin
  translates its visible strings into **zh and en only**; the other six built-in languages fall back
  through the locale chain to English for this plugin's pages. `EXTRA_LOCALE_DICTIONARIES` is the
  extension point for adding a language without touching the registration code. Plugin-manager
  metadata (`locale/*.json`) still ships all eight display languages, and the detail documents are
  bilingual (English/Chinese).
  Both `zh` and `en` dictionaries must have identical key sets (and identical `{param}` sets).
  `locale/ui/en.json` and `locale/ui/zh.json` are generated mirrors of those inline dictionaries
  (same keys and `{param}` sets); regenerate them with `npm run sync-locale`, and `npm run check`
  fails on drift.
  Count-bearing copy selects `_one`/`_other` variants through `Intl.PluralRules`; Chinese stores the
  same single form for both, English must not print "1 items".
- Sizes formatted with `Intl.NumberFormat` + KB/MB/GB thresholds; times with the browser locale.

## 12. Verification the owner of each half runs before reporting

- `node --check <file>` for every JS file.
- `node -e "JSON.parse(require('node:fs').readFileSync('package.json','utf8'))"` and the locale files.
- Contract: `npm run check` must pass — it compares the SPEC route list with the implemented route
  table, the codes the engine can emit with the SPEC vocabulary and the client dictionary, and the
  zh/en dictionary shapes. Treat a failure as a real drift, not a warning.
- Host: `node --test 'test/**/*.test.mjs'` (a bare positional directory is not expanded by this
  Node build) once the tests exist; until then at least a scratch script that
  imports `lib/engine.js` with fake deps and exercises plan → execute on a temp directory.
- Client: no automated test — prove the module parses, that the returned object shape is
  `{inject, apply}`, and that registration ids and slot names match §7 exactly (grep them).
- Report what you could not verify (no browser control in this environment).
