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

  return {
    enabled() {
      return enabled
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
     * user already confirmed, and the caller records the failure itself.
     * @param {object} draft - record draft.
     * @returns {Promise<boolean>} whether the record reached the file.
     */
    async append(draft) {
      if (!enabled) return false
      const record = normalizeRecord(draft, now())
      await load()
      recent.unshift(record)
      if (recent.length > AUDIT_RECENT_LIMIT) recent.length = AUDIT_RECENT_LIMIT
      try {
        await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
        if (maxBytes > 0) {
          const current = await stat(filePath).catch(() => null)
          const line = `${JSON.stringify(record)}\n`
          if (current !== null && current.size + Buffer.byteLength(line) > maxBytes) {
            await unlink(rotatedAuditPath(filePath)).catch(() => {})
            await rename(filePath, rotatedAuditPath(filePath)).catch(() => {})
          }
        }
        await appendFile(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
        return true
      } catch {
        return false
      }
    },
  }
}
