/**
 * Append-only audit log for dsh-cleanup.
 *
 * Every destructive action (and every queue operation) appends one JSON line, so the user can answer
 * "who deleted what, when, and why did a scheduled entry skip". The log is plugin-owned state under
 * the profile home: one file, owner-only, one rotated generation. A write failure is never allowed to
 * fail the operation it records.
 *
 * @module dsh-cleanup/lib/audit
 */
import { appendFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

/** Record schema version. */
export const AUDIT_VERSION = 1

/** How many recent records are kept in memory for the overview payload. */
export const AUDIT_RECENT_LIMIT = 50

/** Per-record bounded detail: one executed plan's items. */
export const AUDIT_ITEMS_MAX = 64

/** Per-record bounded detail: one purge's removed entries. */
export const AUDIT_ENTRIES_MAX = 50

/** Absolute path of the audit log for one DSH home. */
export function auditFilePath(dshHomePath) {
  return path.join(dshHomePath, 'cleanup', 'audit.jsonl')
}

/**
 * Absolute path of the rotated generation.
 * @param {string} filePath - audit log path.
 * @returns {string} rotated path.
 */
export function rotatedAuditPath(filePath) {
  return `${filePath}.1`
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Normalize one record to the frozen wire-ish shape. Extra fields are dropped so a future/foreign
 * record can never confuse consumers.
 * @param {object} input - record draft.
 * @param {number} at - timestamp.
 * @returns {object} normalized record.
 */
function normalizeRecord(input, at) {
  const source = isRecord(input) ? input : {}
  const targets = Array.isArray(source.targets)
    ? source.targets
      .filter((target) => isRecord(target) && typeof target.kind === 'string' && typeof target.id === 'string')
      .map((target) => ({ kind: target.kind, id: target.id }))
    : []
  const record = {
    v: AUDIT_VERSION,
    at,
    source: source.source === 'startup' ? 'startup' : 'immediate',
    action: typeof source.action === 'string' ? source.action : 'unknown',
    mode: source.mode === 'permanent' ? 'permanent' : (source.mode === 'trash' ? 'trash' : null),
    targets,
    status: typeof source.status === 'string' ? source.status : 'unknown',
    code: typeof source.code === 'string' && source.code !== '' ? source.code : null,
    bytes: typeof source.bytes === 'number' && Number.isFinite(source.bytes) && source.bytes > 0 ? source.bytes : 0,
  }
  if (typeof source.entryId === 'string' && source.entryId !== '') record.entryId = source.entryId
  if (Array.isArray(source.entryIds)) {
    record.entryIds = source.entryIds.filter((id) => typeof id === 'string').slice(0, 200)
  }
  // Per-item detail (0.6.4): bounded so one enormous batch cannot bloat a log line. The record
  // remains diagnosable ("which of the 5 failed and why") without storing full plans.
  const items = Array.isArray(source.items)
    ? source.items
      .filter((item) => isRecord(item)
        && typeof item.kind === 'string'
        && typeof item.id === 'string'
        && typeof item.status === 'string')
      .map((item) => ({
        kind: item.kind,
        id: item.id,
        status: item.status,
        code: typeof item.code === 'string' && item.code !== '' ? item.code : null,
      }))
      .slice(0, AUDIT_ITEMS_MAX)
    : []
  if (items.length > 0) record.items = items
  // A purge destroys the metadata, so the record keeps what was actually removed (bounded). Without
  // this a `{ all: true }` purge left an empty entryIds list and "what did the trash contain?" was
  // unanswerable afterwards.
  const entries = Array.isArray(source.entries)
    ? source.entries
      .filter((entry) => isRecord(entry) && typeof entry.id === 'string' && entry.id !== '')
      .map((entry) => ({
        id: entry.id,
        kind: typeof entry.kind === 'string' ? entry.kind : null,
        title: typeof entry.title === 'string' ? entry.title : null,
        originalPath: typeof entry.originalPath === 'string' ? entry.originalPath : null,
      }))
      .slice(0, AUDIT_ENTRIES_MAX)
    : []
  if (entries.length > 0) record.entries = entries
  for (const counter of ['applied', 'skipped', 'failed']) {
    if (typeof source[counter] === 'number' && Number.isFinite(source[counter])) record[counter] = source[counter]
  }
  return record
}

/**
 * Create the audit log accessor for one engine instance.
 *
 * The recent ring is loaded once (bounded file read) and updated on every append, so the overview
 * never re-reads the file.
 * @param {object} options - `{ filePath, maxBytes, enabled, now }`.
 * @returns {Promise<{ append: Function, recent: Function, lastStartup: Function, enabled: () => boolean }>}
 */
export async function createAuditLog(options) {
  const filePath = options.filePath
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : 0
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  let enabled = options.enabled !== false
  /** @type {object[]} */
  let recent = []
  let loaded = false

  const load = async () => {
    if (loaded) return
    loaded = true
    let text
    try {
      text = await readFile(filePath, 'utf8')
    } catch {
      return
    }
    const lines = text.split('\n')
    const records = []
    for (let index = lines.length - 1; index >= 0 && records.length < AUDIT_RECENT_LIMIT; index -= 1) {
      const line = lines[index].trim()
      if (line === '') continue
      try {
        const parsed = JSON.parse(line)
        if (isRecord(parsed)) records.push(parsed)
      } catch {
        /* a torn tail is ignored: the log is diagnostic, never authoritative */
      }
    }
    recent = records
  }

  /** Serialized append chain: concurrent calls must not race the rotation (0.6.4). */
  let tail = Promise.resolve()
  let writeFailures = 0
  /** @type {number | null} */
  let lastWriteAt = null
  /** @type {string | null} */
  let lastError = null
  /** @type {string | null} */
  let lastRotationError = null

  /**
   * One append, run strictly after the previous one. Failure is reported through `health()`; the
   * caller still receives false so it can keep the operation non-blocking.
   * @param {object} draft - record draft.
   * @returns {Promise<boolean>}
   */
  async function appendNow(draft) {
    if (!enabled) return false
    const record = normalizeRecord(draft, now())
    await load()
    try {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
      if (maxBytes > 0) {
        const current = await stat(filePath).catch(() => null)
        const line = `${JSON.stringify(record)}\n`
        if (current !== null && current.size + Buffer.byteLength(line) > maxBytes) {
          try {
            // The previous generation may simply not exist; any other unlink trouble still leaves
            // the rename below as the authority.
            await unlink(rotatedAuditPath(filePath)).catch(() => {})
            // `rename` is NOT swallowed: a failure here means the ceiling could not be applied, and
            // that is exactly what `lastRotationError` exists to report.
            await rename(filePath, rotatedAuditPath(filePath))
            lastRotationError = null
          } catch (error) {
            // Rotation trouble must not stop the new record: the log grows past its ceiling and the
            // health block reports that the previous generation may not be intact.
            lastRotationError = error instanceof Error ? error.message : String(error)
          }
        }
      }
      await appendFile(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      recent.unshift(record)
      if (recent.length > AUDIT_RECENT_LIMIT) recent.length = AUDIT_RECENT_LIMIT
      lastWriteAt = now()
      lastError = null
      return true
    } catch (error) {
      writeFailures += 1
      lastError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  return {
    enabled() {
      return enabled
    },
    /** Write health of the running log (SPEC §4.1 audit health). */
    health() {
      return {
        // `healthy` is the CURRENT append state: a later successful write clears `lastError` and is
        // healthy again, while `writeFailures` keeps the historical count so the UI can still say
        // "3 failed writes since start" when it matters.
        healthy: lastError === null,
        writeFailures,
        lastWriteAt,
        lastError,
        lastRotationError,
      }
    },
    /** Read the recent records, newest first. */
    async recentRecords(limit = 10) {
      await load()
      const count = Math.max(0, Math.min(AUDIT_RECENT_LIMIT, Number.isFinite(limit) ? limit : 10))
      return recent.slice(0, count)
    },
    /** The newest `startup-run` summary, or null. */
    async lastStartup() {
      await load()
      for (const record of recent) {
        if (record.action === 'startup-run') {
          return {
            at: typeof record.at === 'number' ? record.at : 0,
            applied: typeof record.applied === 'number' ? record.applied : 0,
            skipped: typeof record.skipped === 'number' ? record.skipped : 0,
            failed: typeof record.failed === 'number' ? record.failed : 0,
          }
        }
      }
      return null
    },
    /** Enable/disable further writes (settings change). */
    setEnabled(value) {
      enabled = value !== false
    },
    /**
     * Append one record. Failures are swallowed by design: auditing must never block a deletion the
     * user already confirmed, and `health()` reports the failure instead.
     * @param {object} draft - record draft.
     * @returns {Promise<boolean>} whether the record reached the file.
     */
    async append(draft) {
      const run = tail.then(() => appendNow(draft), () => appendNow(draft))
      tail = run.then(() => undefined, () => undefined)
      return run
    },
  }
}
