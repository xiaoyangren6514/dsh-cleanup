/**
 * Persistent queue for deletions that cannot run now: the frequent `SESSION_LIVE` dead end.
 *
 * DSH keeps every Session's Agent alive for the lifetime of the process and exposes no API to
 * release it, so a Session opened in this app run genuinely cannot have its log deleted without
 * corrupting it. Rather than telling the user "restart and retry", the plugin records the reviewed
 * deletion here and applies it at the next Host start, before any Agent exists.
 *
 * The queue is one small JSON document owned by the plugin (never the profile's patch layer):
 *
 *   <DSH_HOME>/cleanup/deferred.json
 *   {
 *     "version": 1,
 *     "entries": [{ id, queuedAt, mode, includeSessions, includeDescendants,
 *                   confirmationText, targets: [{ kind, id }] }],
 *     "lastRun": { "at": <epoch ms>, "results": [...] } | null
 *   }
 *
 * Writes are atomic (temp file + rename) and owner-only, so a crash can never leave a half-written
 * queue that would delete something the user did not review.
 *
 * @module dsh-cleanup/lib/deferred
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Current queue document version (v2 adds retained entries, claims, and per-entry in-flight state). */
export const DEFERRED_VERSION = 2

/** Maximum queued entries; further requests are refused with `DEFERRED_FULL`. */
export const DEFERRED_MAX_ENTRIES = 100

/** How many skipped/failed entries are retained (for «上次未完成» and requeue). */
export const DEFERRED_RETAINED_MAX = 20

/** A start-up claim older than this is considered abandoned and the entry is retried. */
export const DEFERRED_CLAIM_STALE_MS = 10 * 60 * 1000

/**
 * Absolute path of the queue document for one DSH home.
 * @param {string} dshHomePath - absolute DSH home.
 * @returns {string} absolute file path.
 */
export function deferredFilePath(dshHomePath) {
  return path.join(dshHomePath, 'cleanup', 'deferred.json')
}

/**
 * Normalize one raw queue entry, or null when it cannot name anything deletable. A corrupt document
 * (hand-edited, truncated, written by a future version) must degrade to "nothing is scheduled" — it
 * must never make the queue API throw or fabricate a target.
 * @param {unknown} raw - stored entry.
 * @returns {object | null} normalized entry, or null when unusable.
 */
function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const targets = Array.isArray(raw.targets)
    ? raw.targets
      .filter((target) => target !== null && typeof target === 'object')
      .map((target) => ({ kind: target.kind, id: target.id }))
      .filter((target) => (target.kind === 'workspace' || target.kind === 'session') && typeof target.id === 'string' && target.id !== '')
    : []
  if (targets.length === 0) return null
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `recovered-${targetSetKey(targets)}`,
    queuedAt: typeof raw.queuedAt === 'number' && Number.isFinite(raw.queuedAt) ? raw.queuedAt : 0,
    mode: raw.mode === 'permanent' ? 'permanent' : 'trash',
    includeSessions: raw.includeSessions !== false,
    includeDescendants: raw.includeDescendants !== false,
    confirmationText: typeof raw.confirmationText === 'string' ? raw.confirmationText : null,
    // Reviewed item set and the confirmed-directory identity anchor (see engine defer/runDeferred).
    reviewedItems: Array.isArray(raw.reviewedItems)
      ? raw.reviewedItems
        .filter((item) => item !== null && typeof item === 'object')
        .map((item) => ({ kind: item.kind, id: item.id }))
        .filter((item) => typeof item.kind === 'string' && typeof item.id === 'string')
      : [],
    confirmedDirectory: normalizeConfirmedDirectory(raw.confirmedDirectory),
    // Set while a start-up run is executing this entry; a stale claim is retried (see DEFERRED_CLAIM_STALE_MS).
    inFlightAt: typeof raw.inFlightAt === 'number' && Number.isFinite(raw.inFlightAt) ? raw.inFlightAt : null,
    targets,
  }
}

/**
 * Normalize one retained (skipped/failed) entry. The original queue entry is kept so it can be
 * requeued verbatim; the wire projection flattens the interesting fields.
 * @param {unknown} raw - stored retained record.
 * @returns {object | null}
 */
function normalizeRetained(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const entry = normalizeEntry(raw.entry)
  if (entry === null) return null
  return {
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0,
    status: raw.status === 'failed' ? 'failed' : 'skipped',
    code: typeof raw.code === 'string' && raw.code !== '' ? raw.code : null,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    entry,
  }
}

/**
 * Wire projection of one retained record (SPEC §4.7).
 * @param {object} retained - stored retained record.
 * @returns {object}
 */
export function projectRetainedEntry(retained) {
  const entry = retained?.entry ?? {}
  const targets = Array.isArray(entry.targets) ? entry.targets : []
  return {
    id: String(entry.id ?? ''),
    at: typeof retained?.at === 'number' ? retained.at : 0,
    status: retained?.status === 'failed' ? 'failed' : 'skipped',
    code: typeof retained?.code === 'string' ? retained.code : null,
    reason: typeof retained?.reason === 'string' ? retained.reason : '',
    mode: entry.mode === 'permanent' ? 'permanent' : 'trash',
    targets: targets
      .filter((target) => target !== null && typeof target === 'object')
      .map((target) => ({ kind: String(target.kind ?? ''), id: String(target.id ?? '') })),
  }
}

/**
 * Normalize the identity anchor of the directory whose typed name was confirmed.
 * @param {unknown} raw - stored anchor.
 * @returns {{ workspaceId: string, path: string, device: number | null, inode: number | null } | null}
 */
function normalizeConfirmedDirectory(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.workspaceId !== 'string' || typeof raw.path !== 'string' || raw.path === '') return null
  return {
    workspaceId: raw.workspaceId,
    path: raw.path,
    device: typeof raw.device === 'number' && Number.isFinite(raw.device) ? raw.device : null,
    inode: typeof raw.inode === 'number' && Number.isFinite(raw.inode) ? raw.inode : null,
  }
}

/** @returns {{ version: number, entries: object[], retained: object[], lastRun: object | null }} */
function emptyDocument() {
  return { version: DEFERRED_VERSION, entries: [], retained: [], lastRun: null }
}

/**
 * Stable identity for one reviewed target set: the same sessions/workspaces queued twice replace
 * each other instead of stacking up (a user clicking the action twice must not delete twice).
 * @param {{ kind: string, id: string }[]} targets - normalized targets.
 * @returns {string} canonical key.
 */
export function targetSetKey(targets) {
  return [...new Set(targets.map((target) => `${target.kind}:${target.id}`))].sort().join('|')
}

/**
 * Read the queue document. A missing or unreadable document is an empty queue: loss of the queue can
 * only mean "nothing is scheduled", never an unexpected deletion.
 * @param {string} filePath - queue document path.
 * @returns {Promise<{ version: number, entries: object[], lastRun: object | null }>}
 */
export async function readDeferred(filePath) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return emptyDocument()
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyDocument()
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyDocument()
  // v1 documents (no retained list, no claims) migrate on read; anything else is unknown schemas and is
  // treated as empty, because the queue is destructive state and is never guessed at.
  if (parsed.version !== 1 && parsed.version !== DEFERRED_VERSION) return emptyDocument()
  const entries = Array.isArray(parsed.entries)
    ? parsed.entries
      .map(normalizeEntry)
      .filter((entry) => entry !== null)
      // The 100-entry cap is enforced on read too: a hand-written or future document must not make
      // the boot run unbounded.
      .slice(0, DEFERRED_MAX_ENTRIES)
    : []
  const retained = Array.isArray(parsed.retained)
    ? parsed.retained
      .map(normalizeRetained)
      .filter((entry) => entry !== null)
      .slice(-DEFERRED_RETAINED_MAX)
    : []
  const lastRun = parsed.lastRun !== null && typeof parsed.lastRun === 'object' && Array.isArray(parsed.lastRun.results)
    ? { at: typeof parsed.lastRun.at === 'number' ? parsed.lastRun.at : 0, results: parsed.lastRun.results }
    : null
  return { version: DEFERRED_VERSION, entries, retained, lastRun }
}

/**
 * Atomically replace the queue document.
 * @param {string} filePath - queue document path.
 * @param {{ entries?: object[], lastRun?: object | null }} document - next content.
 * @returns {Promise<void>}
 */
export async function writeDeferred(filePath, document) {
  const parent = path.dirname(filePath)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const payload = {
    version: DEFERRED_VERSION,
    entries: Array.isArray(document.entries) ? document.entries.slice(0, DEFERRED_MAX_ENTRIES) : [],
    retained: Array.isArray(document.retained) ? document.retained.slice(-DEFERRED_RETAINED_MAX) : [],
    lastRun: document.lastRun === undefined ? null : document.lastRun,
  }
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, filePath)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch {
      /* the temp file may not exist; the original failure is the one that matters */
    }
    throw error
  }
}

/**
 * Name of the cross-process lock file guarding the queue document.
 * @param {string} filePath - queue document path.
 * @returns {string} lock file path.
 */
export function deferredLockPath(filePath) {
  return `${filePath}.lock`
}

/**
 * Actual path of the start-up run claim file.
 * @param {string} filePath - queue document path.
 * @returns {string} run claim file path.
 */
export function deferredRunClaimPath(filePath) {
  return `${filePath}.run.lock`
}

/** A lock older than this is assumed to belong to a crashed process and is broken. */
const LOCK_STALE_MS = 30_000

/**
 * Acquire the queue's cross-process lock.
 *
 * The in-process promise chain cannot serialize two Host processes sharing one `$DSH_HOME`; without
 * this file lock a second process can double-apply the queue, lose a `defer`, or let a `cancel` report
 * success while the other process still executes the entry.
 * @param {string} filePath - queue document path.
 * @param {number} [nowMs] - current epoch ms.
 * @param {number} [staleMs] - claim age after which a crashed holder is assumed gone.
 * @returns {Promise<(() => Promise<void>) | null>} release function, or null when another process holds it.
 */
export async function acquireDeferredLock(filePath, nowMs = Date.now(), staleMs = LOCK_STALE_MS) {
  const lockPath = deferredLockPath(filePath)
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle
    try {
      handle = await open(lockPath, 'wx', 0o600)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // Break a stale lock left by a crashed process, then retry once.
      let existing = null
      try {
        existing = await stat(lockPath)
      } catch {
        existing = null
      }
      if (existing !== null && nowMs - existing.mtimeMs > staleMs) {
        try {
          await unlink(lockPath)
        } catch {
          /* another process may have removed it first */
        }
        continue
      }
      return null
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: nowMs }))
    } finally {
      await handle.close()
    }
    return async () => {
      try {
        await unlink(lockPath)
      } catch {
        /* the lock may already be gone (stale takeover); release is best-effort */
      }
    }
  }
  return null
}

/**
 * Remove a queue claim whose recorded process no longer exists.
 *
 * The age-based stale takeover below still bounds an unreadable claim, but a crash between taking
 * the start-up run claim and releasing it would otherwise make the next Host skip the whole queue
 * for the engine's claim-stale window with no visible reason. The claim records its pid, so a dead
 * pid is safe to take over immediately; a live or unknown pid keeps the claim until it ages out.
 * @param {string} lockPath - claim file path.
 * @param {number} [nowMs] - current epoch ms.
 * @param {number} [staleMs] - age after which a claim is taken over regardless of the pid.
 * @returns {Promise<boolean>} whether a claim file was removed.
 */
export async function breakDeadLock(lockPath, nowMs = Date.now(), staleMs = LOCK_STALE_MS) {
  let text
  let mtimeMs = null
  try {
    text = await readFile(lockPath, 'utf8')
    mtimeMs = (await stat(lockPath)).mtimeMs
  } catch {
    return false
  }
  let pid = null
  let at = null
  try {
    const parsed = JSON.parse(text)
    pid = Number.isInteger(parsed?.pid) ? parsed.pid : null
    at = typeof parsed?.at === 'number' && Number.isFinite(parsed.at) ? parsed.at : null
  } catch {
    /* an empty or corrupt claim: the age checks below still bound it */
  }
  if (pid !== null && pid > 0) {
    let dead = false
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') dead = true
      else if (error?.code === 'EPERM') dead = false
      else dead = true
    }
    // A confirmed live owner is authoritative: a long run may legitimately exceed the age bound.
    // A confirmed dead owner is taken over immediately.
    if (!dead) return false
  } else {
    // No usable pid (a crash between creating the claim and writing its body): age it out by the
    // recorded time or, when that is missing too, by the claim file's mtime.
    const agedByTime = at !== null && nowMs - at > staleMs
    const agedByFile = mtimeMs !== null && nowMs - mtimeMs > staleMs
    if (!agedByTime && !agedByFile) return false
  }
  try {
    await unlink(lockPath)
  } catch {
    /* another process may have removed it first */
  }
  return true
}

/**
 * Normalize one queued entry for the wire: no internal confirmation text, stable field order.
 * @param {object} entry - stored entry.
 * @returns {object} detached projection.
 */
export function projectDeferredEntry(entry) {
  const source = entry !== null && typeof entry === 'object' ? entry : {}
  const targets = Array.isArray(source.targets) ? source.targets : []
  return {
    id: String(source.id ?? ''),
    queuedAt: typeof source.queuedAt === 'number' ? source.queuedAt : 0,
    mode: source.mode === 'permanent' ? 'permanent' : 'trash',
    targets: targets
      .filter((target) => target !== null && typeof target === 'object')
      .map((target) => ({ kind: String(target.kind ?? ''), id: String(target.id ?? '') })),
    includeSessions: source.includeSessions !== false,
    includeDescendants: source.includeDescendants !== false,
  }
}
