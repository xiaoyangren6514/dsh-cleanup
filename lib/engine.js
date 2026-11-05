/**
 * dsh-cleanup Host domain engine.
 *
 * One factory, one safety story: resolve only registry-owned targets, plan behind a review step,
 * re-check the whole world at admission, then move (or, explicitly, permanently delete) one item
 * at a time without ever rolling a success back into a lie.
 *
 * Everything that mutates the file system goes through `deps.fsOps` (defaults to
 * `node:fs/promises`) and every wall-clock decision goes through `deps.now` so the whole engine is
 * drivable from tests with a real temporary directory. `node:path` string logic is used directly:
 * it has no reason to be faked.
 *
 * Wire codes and payload shapes are frozen by SPEC.md §4-§6. This module returns the HTTP envelope
 * body (`{ ok: true, ...payload }` / `{ ok: false, error }`); `index.js` owns HTTP status codes.
 *
 * @module dsh-cleanup/lib/engine
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import * as nodeFs from 'node:fs/promises'
import { auditFilePath, createAuditLog } from './audit.js'
import {
  DEFERRED_CLAIM_STALE_MS,
  DEFERRED_MAX_ENTRIES,
  DEFERRED_RETAINED_MAX,
  acquireDeferredLock,
  breakDeadLock,
  deferredFilePath,
  deferredRunClaimPath,
  projectRetainedEntry,
  projectDeferredEntry,
  readDeferred,
  targetSetKey,
  writeDeferred,
} from './deferred.js'
import {
  SETTING_FIELDS,
  mergeSettings,
  readSettingsOverrides,
  settingsFilePath,
  settingsFromConfig,
  validateSettingsPatch,
  writeSettingsOverrides,
} from './settings.js'
import {
  PATH_CODES,
  canonicalizeDirectory,
  classifyTargetPath,
  dshHome,
  isInside,
  lastSegment,
  pathDepth,
  resolveTrashRoot,
  samePath,
  sessionDirectoryFromLocation,
  trashEntryId,
} from './paths.js'

/** Maximum targets one plan (or queued entry) may name; bounds per-request work (SPEC §4.3). */
const MAX_PLAN_TARGETS = 64

/** Stored-session list cap for one inventory response (SPEC §4.1 `truncated`). */
const SESSION_LIST_CAP = 2000
/** A target larger than this is worth a non-blocking warning. */
const LARGE_TARGET_BYTES = 1024 ** 3
/** Hard depth ceiling for read-only walks; deeper trees are reported truncated. */
const MAX_WALK_DEPTH = 128
/** Hard depth ceiling for destructive walks; deeper trees are refused, never half-deleted. */
const MAX_DELETE_DEPTH = 128
/** Parent-chain ceiling while collecting subagent descendants (cycles are also guarded). */
const MAX_DESCENDANT_CHAIN = 128
/** Trash metadata layout version written by this build. */
const TRASH_META_VERSION = 1
/**
 * Ownership marker every plugin-created trash entry carries. A directory under the configured
 * trash root is only listed, restored, or purged when it carries this marker (or, for entries
 * written by 0.3.0, a strictly shaped `meta.json`). Without it, pointing `trashRoot` at an existing
 * data directory would let "empty the trash" recursively delete unrelated directories.
 */
const TRASH_ENTRY_MARKER = '.dsh-cleanup-entry'
/** Trash entry ids are single path segments; anything longer is refused. */
const MAX_TRASH_ID_LENGTH = 200
/** How many random id attempts one trash entry creation may use before giving up. */
const TRASH_ID_ATTEMPTS = 8
/** Ceiling for finding an existing ancestor of the trash root during the st_dev probe. */
const MAX_DEVICE_PROBE_DEPTH = 64
/**
 * Ceiling on how many session logs one plan may sweep in (explicit targets included). A workspace
 * `includeSessions` deletion over a huge history is bounded so a single reviewed operation cannot
 * run for an unbounded time; the user deletes sessions in batches first, then the directory.
 */
const MAX_PLAN_SESSION_ITEMS = 1000

/** Filesystem operations the engine depends on; any subset may be overridden through `deps.fsOps`. */
const FS_METHODS = Object.freeze([
  'lstat',
  'stat',
  'realpath',
  'readdir',
  'rename',
  'mkdir',
  'rmdir',
  'unlink',
  'readFile',
  'writeFile',
])

/** Envelope helpers. Pure JSON only: never put `undefined` on the wire. */
function ok(payload) {
  return { ok: true, ...payload }
}

/**
 * Build a failure envelope.
 * @param {string} code - stable wire code from SPEC §4.6.
 * @param {string} message - English, model/log-facing explanation.
 * @param {Record<string, unknown>} [details] - optional structured context.
 * @returns {{ ok: false, error: { code: string, message: string, details?: object } }}
 */
function fail(code, message, details) {
  const error = { code, message }
  if (details !== undefined && details !== null) error.details = details
  return { ok: false, error }
}

/** A controlled domain failure: thrown inside the engine, converted to an envelope by the caller. */
class DomainError extends Error {
  /**
   * @param {string} code - wire code.
   * @param {string} message - English explanation.
   * @param {Record<string, unknown>} [details] - optional structured context.
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.details = details
  }
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** @param {unknown} error @returns {string | null} */
function errorCode(error) {
  const code = /** @type {{ code?: unknown }} */ (error)?.code
  return typeof code === 'string' ? code : null
}

/** @param {unknown} value @returns {boolean} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} error @returns {boolean} */
function isMissingError(error) {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** @param {unknown} error @returns {boolean} */
function isPermissionError(error) {
  const code = errorCode(error)
  return code === 'EACCES' || code === 'EPERM'
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function positiveInteger(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** Like {@link positiveInteger}, but `0` is a meaningful budget ("none"), not a missing value. */
function nonNegativeInteger(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

/**
 * Reference timestamp for one mutation/observation. Kept as numbers everywhere on the wire, and
 * clamped to a safe integer so a fake clock cannot poison `Date` arithmetic.
 * @param {unknown} value - candidate epoch-ms value.
 * @returns {number | null} safe integer epoch ms, or null.
 */
function epochMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

/**
 * Normalize the plugin config (SPEC §3) exactly once per engine instance.
 * @param {unknown} raw - `config` from `apply(ctx, config)`.
 * @returns {{ trashRoot: string, maxScanEntries: number, scanTimeoutMs: number, planTtlMs: number, allowPermanentDeletion: boolean, maxPlans: number }}
 */
function normalizeConfig(raw) {
  const config = isPlainObject(raw) ? raw : {}
  return {
    trashRoot: resolveTrashRoot(config.trashRoot),
    // A budget of 0 would make every plan immediately evicted (maxPlans), every scan report
    // truncated (maxScanEntries), or every plan expire instantly (planTtlMs). Clamp to at least 1 so
    // a bad config degrades into the default rather than into a feature that silently cannot work.
    maxScanEntries: positiveInteger(config.maxScanEntries, 200000),
    scanTimeoutMs: positiveInteger(config.scanTimeoutMs, 4000),
    planTtlMs: positiveInteger(config.planTtlMs, 300000),
    allowPermanentDeletion: config.allowPermanentDeletion !== false,
    maxPlans: Math.max(1, nonNegativeInteger(config.maxPlans, 32)),
    // Plugin-owned state (queue, settings overrides, audit log) lives together: by default next to
    // the queue file under `$DSH_HOME/cleanup`, and next to a configured queue file when a deployment
    // moves it (tests configure a throw-away queue file, so they never touch the real profile).
    ...(() => {
      const deferredFile = typeof config.deferredFile === 'string' && path.isAbsolute(config.deferredFile)
        ? path.resolve(config.deferredFile)
        : deferredFilePath(dshHome())
      const stateDirectory = path.dirname(deferredFile)
      return {
        deferredFile,
        settingsFile: typeof config.settingsFile === 'string' && path.isAbsolute(config.settingsFile)
          ? path.resolve(config.settingsFile)
          : path.join(stateDirectory, 'settings.json'),
        auditFile: typeof config.auditFile === 'string' && path.isAbsolute(config.auditFile)
          ? path.resolve(config.auditFile)
          : path.join(stateDirectory, 'audit.jsonl'),
      }
    })(),
    auditEnabled: config.auditEnabled !== false,
    auditMaxBytes: nonNegativeInteger(config.auditMaxBytes, 2097152),
    trashRetentionDays: nonNegativeInteger(config.trashRetentionDays, 0),
    trashMaxBytes: nonNegativeInteger(config.trashMaxBytes, 0),
    // Read-only Git probe before a workspace directory is planned for deletion (SPEC §5.4).
    gitSafetyCheck: config.gitSafetyCheck !== false,
  }
}

/**
 * Create the cleanup engine.
 *
 * @param {object} deps - injected services and knobs.
 * @param {object} deps.workspaceRegistry - `ctx.workspaceRegistry` (required).
 * @param {object} deps.sessionPersistence - `ctx.sessionPersistence` (required).
 * @param {object} [deps.sessions] - optional SessionStore; `get(id)` proves a session is live.
 * @param {object} [deps.agents] - optional AgentRegistry; `get(id).status === 'running'`.
 * @param {object} [deps.config] - plugin config (SPEC §3); defaults apply.
 * @param {() => number} [deps.now] - clock; defaults to `Date.now`.
 * @param {object} [deps.fsOps] - node:fs/promises-shaped overrides for tests.
 * @returns {{ inventory: Function, measure: Function, candidates: Function, plan: Function, execute: Function, trashList: Function, trashRestore: Function, trashPurge: Function, defer: Function, deferredList: Function, deferredCancel: Function, deferredRequeue: Function, runDeferred: Function, deferredState: Function, settingsGet: Function, settingsSet: Function }}
 */
export function createEngine(deps = {}) {
  if (!deps || typeof deps !== 'object' || deps.workspaceRegistry === undefined || deps.sessionPersistence === undefined) {
    throw new TypeError('createEngine needs { workspaceRegistry, sessionPersistence }.')
  }
  const config = normalizeConfig(deps.config)
  // The loader-row config (before settings.json overrides) is what Settings shows as "defaults".
  const baseConfig = normalizeConfig(deps.baseConfig)
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const fs = resolveFsOps(deps.fsOps)
  /** @type {Awaited<ReturnType<typeof createAuditLog>> | null} */
  let audit = null
  /** @returns {Promise<Awaited<ReturnType<typeof createAuditLog>>>} */
  async function auditLog() {
    if (audit === null) {
      audit = await createAuditLog({
        filePath: config.auditFile,
        maxBytes: config.auditMaxBytes,
        enabled: config.auditEnabled,
        now,
      })
    }
    return audit
  }
  /**
   * Append one audit record, never failing the caller.
   * @param {object} draft - record draft.
   * @returns {Promise<void>}
   */
  async function recordAudit(draft) {
    try {
      const log = await auditLog()
      await log.append(draft)
    } catch {
      /* auditing is diagnostic: never fail a deletion because its record could not be written */
    }
  }
  /** @type {Map<string, { plan: object, items: object[], mode: string, expiresAt: number, confirmation: object | null }>} */
  const plans = new Map()
  /**
   * Serializes destructive executions inside this Host process. Two plans over the same target used
   * to race: the first moved the directory into the trash and the second reported a spurious
   * `IO_ERROR` after losing the rename. The second execution now waits, re-checks the world, and
   * reports `STATE_CHANGED` when the first already deleted the item (SPEC §5.6).
   */
  let mutationChain = Promise.resolve()

  /**
   * Run one destructive task after every earlier destructive task in this process settled.
   * @template T
   * @param {() => Promise<T>} task - destructive operation.
   * @returns {Promise<T>} task result.
   */
  function withMutationLock(task) {
    const run = mutationChain.then(() => task())
    mutationChain = run.then(() => undefined, () => undefined)
    return run
  }

  // #region small shared helpers ---------------------------------------------------------------

  /** @returns {object} the workspace registry service. */
  function registry() {
    return deps.workspaceRegistry
  }

  /**
   * Load every stored session snapshot. A storage failure is a domain failure, never an empty list:
   * an empty list would silently turn "delete this workspace's sessions" into "delete nothing".
   * @returns {Promise<object[]>}
   */
  async function listStoredSessions() {
    try {
      const listed = await deps.sessionPersistence.list()
      return Array.isArray(listed) ? listed : []
    } catch (error) {
      throw new DomainError('IO_ERROR', `Failed to list stored sessions: ${errorMessage(error)}`)
    }
  }

  /**
   * Observe one stored session by id without reading its log.
   * @param {string} id - session id.
   * @returns {Promise<object | undefined>}
   */
  async function statStoredSession(id) {
    try {
      return await deps.sessionPersistence.stat(id)
    } catch (error) {
      throw new DomainError('IO_ERROR', `Failed to inspect session "${id}": ${errorMessage(error)}`)
    }
  }

  /**
   * Liveness as SPEC §5.2 defines it: a SessionStore entry OR an AgentRegistry entry means live; an
   * agent whose status is `running` is the stronger condition. Optional services degrade to "not
   * live" if they are absent **or throw**; we never let a missing optional service claim a target is
   * safe to delete silently in inventory it only means "unknown", and admission re-checks anyway.
   * @param {string} id - session id.
   * @returns {{ live: boolean, running: boolean }}
   */
  function livenessOf(id) {
    let live = false
    let running = false
    // A *throwing* probe is not "not live": the optional service exists but could not answer, and
    // treating that as absent would let a live session's log be deleted (SPEC §5.2 relies on this
    // gate). Only a resolved `undefined` means "no live entry"; a throw is treated as live-unknown.
    let unknown = false
    try {
      if (deps.sessions?.get?.(id) !== undefined) live = true
    } catch {
      unknown = true
    }
    try {
      const agent = deps.agents?.get?.(id)
      if (agent !== undefined) {
        live = true
        if (agent?.status === 'running') running = true
      }
    } catch {
      unknown = true
    }
    return { live: live || unknown, running, unknown }
  }

  /**
   * Every live Agent's session identity, running state, and effective working directory.
   *
   * The effective directory can differ from the Session header's creation `cwd` after a
   * `working_directory` change, so the "is a live session using this folder" gate must read the
   * effective path. A probe failure reports `probeFailed`; callers refuse rather than assume safe.
   * @returns {{ rows: { id: string, running: boolean, cwd: string | null }[], probeFailed: boolean }}
   */
  function liveSessionRows() {
    const rows = []
    let probeFailed = false
    let agents
    try {
      agents = deps.agents?.list?.()
    } catch {
      return { rows, probeFailed: true }
    }
    if (!Array.isArray(agents)) return { rows, probeFailed }
    for (const agent of agents) {
      try {
        const session = agent?.session
        const id = typeof session?.id === 'string' ? session.id : (typeof agent?.id === 'string' ? agent.id : null)
        if (id === null) continue
        let cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : null
        try {
          const effective = deps.workingDirectory?.get?.(session)
          if (typeof effective === 'string' && effective !== '') cwd = effective
        } catch {
          /* an effective-directory probe failure keeps the recorded cwd; liveness already failed closed */
        }
        rows.push({ id, running: agent?.status === 'running', cwd })
      } catch {
        probeFailed = true
      }
    }
    return { rows, probeFailed }
  }

  /**
   * Live sessions whose effective working directory lies inside one path.
   * @param {string} path - absolute directory.
   * @returns {{ ids: string[], probeFailed: boolean }}
   */
  function liveSessionsInside(path) {
    const { rows, probeFailed } = liveSessionRows()
    const ids = []
    for (const row of rows) {
      if (typeof row.cwd === 'string' && row.cwd !== '' && isInside(path, row.cwd)) ids.push(row.id)
    }
    return { ids, probeFailed }
  }

  /**
   * The definite blocker for one session, if any. `running` subsumes `live`: it is the more
   * actionable refusal, so the UI gets one precise reason instead of two.
   * @param {string} id - session id.
   * @returns {{ code: string, message: string, sessionId: string, workspaceId: null } | null}
   */
  function sessionBlockerFor(id) {
    const { live, running, unknown } = livenessOf(id)
    if (running) {
      return blocker(
        'SESSION_RUNNING',
        id,
        null,
        'This session is running. Stop its work, wait for the turn to finish, then create a new plan.',
      )
    }
    if (unknown) {
      return blocker(
        'SESSION_LIVE',
        id,
        null,
        'Whether this session is in use could not be verified, so it is treated as live and refused. Retry after the Harness reports the session list again.',
      )
    }
    if (live) {
      return blocker(
        'SESSION_LIVE',
        id,
        null,
        'This session is held open by a live agent for the lifetime of this process, so deleting its log now would corrupt it. Open the session list in another page or restart the app, stop using that session, then create a new plan and retry.',
      )
    }
    return null
  }

  /** @param {string} code @param {string | null} sessionId @param {string | null} workspaceId @param {string} message */
  function blocker(code, sessionId, workspaceId, message) {
    return { code, message, sessionId: sessionId ?? null, workspaceId: workspaceId ?? null }
  }

  /** @param {string} code @param {string | null} sessionId @param {string | null} workspaceId @param {string} message */
  function warning(code, sessionId, workspaceId, message) {
    return { code, message, sessionId: sessionId ?? null, workspaceId: workspaceId ?? null }
  }

  /**
   * Map a raw failure caught while mutating one item onto the per-item error shape.
   * @param {unknown} error - whatever the fs/registry threw.
   * @returns {{ code: string, message: string }}
   */
  function itemFailure(error) {
    if (error instanceof DomainError) {
      const failure = { code: error.code, message: error.message }
      // A failed item can still have moved a payload somewhere the user must be able to find: a
      // failed trash-metadata write keeps the entry, and the item result must report it (SPEC §4.4).
      if (isPlainObject(error.details) && typeof error.details.movedTo === 'string') {
        failure.movedTo = error.details.movedTo
      }
      return failure
    }
    return { code: 'IO_ERROR', message: errorMessage(error) }
  }

  // #endregion

  // #region bounded file-system walks ----------------------------------------------------------

  /**
   * Bounded, symlink-safe, read-only walk of one directory.
   *
   * Never throws for expected filesystem trouble: a missing root reports `missing`, an unreadable
   * subtree is skipped, a symlink is counted as a leaf and never followed, and the entry/time
   * budgets stop the walk with `truncated: true`. Sizes after truncation are a lower bound, which is
   * exactly what the `SCAN_TRUNCATED` warning says.
   *
   * @param {string} rootPath - absolute directory to measure.
   * @param {{ maxEntries?: number, timeoutMs?: number }} [options] - budget overrides.
   * @returns {Promise<{ bytes: number, files: number, dirs: number, newestMtime: number, truncated: boolean, missing: boolean }>}
   */
  async function walkTree(rootPath, options = {}) {
    const stats = { bytes: 0, files: 0, dirs: 0, newestMtime: 0, truncated: false, missing: false }
    const startedAt = now()
    const maxEntries = positiveInteger(options.maxEntries, config.maxScanEntries)
    const timeoutMs = options.timeoutMs === Infinity ? Infinity : positiveInteger(options.timeoutMs, config.scanTimeoutMs)

    let rootStat
    try {
      rootStat = await fs.lstat(rootPath)
    } catch (error) {
      if (isMissingError(error)) stats.missing = true
      return stats
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      // A replaced workspace path is refused at plan time; measuring must still be total and
      // must never follow the link.
      stats.files = 1
      stats.bytes = Number(rootStat.size) || 0
      stats.newestMtime = Math.floor(Number(rootStat.mtimeMs) || 0)
      return stats
    }

    /** @type {{ dir: string, depth: number }[]} */
    const stack = [{ dir: rootPath, depth: 0 }]
    let visited = 0
    walk: while (stack.length > 0) {
      const frame = stack.pop()
      let names
      try {
        names = await fs.readdir(frame.dir)
      } catch (error) {
        if (isMissingError(error) || isPermissionError(error)) continue
        // An unexpected error (EIO, ELOOP, ...) makes the measurement a lower bound; say so through
        // the `truncated` flag instead of silently under-reporting.
        stats.truncated = true
        continue
      }
      for (const name of names) {
        visited += 1
        if (visited > maxEntries) {
          stats.truncated = true
          break walk
        }
        if (timeoutMs !== Infinity && now() - startedAt > timeoutMs) {
          stats.truncated = true
          break walk
        }
        const child = path.join(frame.dir, name)
        let childStat
        try {
          childStat = await fs.lstat(child)
        } catch (error) {
          if (isMissingError(error) || isPermissionError(error)) continue
          stats.truncated = true
          continue
        }
        stats.newestMtime = Math.max(stats.newestMtime, Math.floor(Number(childStat.mtimeMs) || 0))
        if (childStat.isSymbolicLink()) {
          stats.files += 1
          stats.bytes += Number(childStat.size) || 0
          continue
        }
        if (childStat.isDirectory()) {
          stats.dirs += 1
          if (frame.depth + 1 > MAX_WALK_DEPTH) {
            stats.truncated = true
            continue
          }
          stack.push({ dir: child, depth: frame.depth + 1 })
          continue
        }
        stats.files += 1
        stats.bytes += Number(childStat.size) || 0
      }
    }
    return stats
  }

  /**
   * Bounded *inventory* of a tree, used only to prove a destructive walk fits its budget before any
   * mutation happens. Collecting every path first means a budget refusal leaves the tree intact;
   * deleting during the walk would leave a half-deleted directory (a partial-write surprise).
   * @param {string} rootPath - absolute directory.
   * @returns {Promise<{ files: string[], dirs: string[], truncated: boolean }>}
   */
  async function collectTree(rootPath) {
    /** @type {string[]} */
    const files = []
    /** @type {string[]} */
    const dirs = []
    /** @type {{ dir: string, depth: number }[]} */
    const stack = [{ dir: rootPath, depth: 0 }]
    let visited = 0
    while (stack.length > 0) {
      const frame = stack.pop()
      let names
      try {
        names = await fs.readdir(frame.dir)
      } catch (error) {
        if (isMissingError(error)) continue
        throw new DomainError('IO_ERROR', `Failed to read "${frame.dir}": ${errorMessage(error)}`)
      }
      for (const name of names) {
        visited += 1
        if (visited > config.maxScanEntries) return { files, dirs, truncated: true }
        const child = path.join(frame.dir, name)
        let childStat
        try {
          childStat = await fs.lstat(child)
        } catch (error) {
          if (isMissingError(error)) continue
          throw new DomainError('IO_ERROR', `Failed to inspect "${child}": ${errorMessage(error)}`)
        }
        if (childStat.isDirectory() && !childStat.isSymbolicLink()) {
          if (frame.depth + 1 > MAX_DELETE_DEPTH) return { files, dirs, truncated: true }
          dirs.push(child)
          stack.push({ dir: child, depth: frame.depth + 1 })
          continue
        }
        files.push(child)
      }
    }
    return { files, dirs, truncated: false }
  }

  /**
   * Permanently remove one directory tree.
   *
   * This is the `rm -rf` SPEC §5.5 asks for, except it is deliberately not `fs.rm`: it refuses
   * absolute-but-shallow paths (an empty path or a path directly under the root — `/Users` on POSIX,
   * `C:\Users` on Windows — must never be able to name a top-level directory), refuses
   * non-directories and symlink roots, and performs a bounded pre-scan so a budget refusal happens
   * before anything is unlinked.
   *
   * @param {string} targetPath - directory to remove; a missing target is already-gone and succeeds.
   * @returns {Promise<void>}
   */
  async function removeTree(targetPath) {
    if (typeof targetPath !== 'string' || targetPath.trim() === '' || !path.isAbsolute(targetPath)) {
      throw new DomainError('IO_ERROR', 'Refusing to delete a target that is not an absolute path.')
    }
    const resolved = path.resolve(targetPath)
    if (pathDepth(resolved) < 2) {
      throw new DomainError('IO_ERROR', `Refusing to delete "${resolved}": it is a top-level path.`)
    }
    let rootStat
    try {
      rootStat = await fs.lstat(resolved)
    } catch (error) {
      if (isMissingError(error)) return
      throw new DomainError('IO_ERROR', `Failed to inspect "${resolved}": ${errorMessage(error)}`)
    }
    if (rootStat.isSymbolicLink()) {
      throw new DomainError('IO_ERROR', `Refusing to delete "${resolved}": it is a symbolic link.`)
    }
    if (!rootStat.isDirectory()) {
      throw new DomainError('IO_ERROR', `Refusing to delete "${resolved}": it is not a directory.`)
    }
    const scan = await collectTree(resolved)
    if (scan.truncated) {
      throw new DomainError(
        'IO_ERROR',
        `Refusing to delete "${resolved}": the tree exceeds the configured scan budget (maxScanEntries=${config.maxScanEntries}), so it was left untouched.`,
      )
    }
    for (const filePath of scan.files) {
      try {
        await fs.unlink(filePath)
      } catch (error) {
        if (isMissingError(error)) continue
        throw new DomainError('IO_ERROR', `Failed to remove "${filePath}": ${errorMessage(error)}`)
      }
    }
    for (let index = scan.dirs.length - 1; index >= 0; index -= 1) {
      try {
        await fs.rmdir(scan.dirs[index])
      } catch (error) {
        if (isMissingError(error)) continue
        throw new DomainError('IO_ERROR', `Failed to remove "${scan.dirs[index]}": ${errorMessage(error)}`)
      }
    }
    try {
      await fs.rmdir(resolved)
    } catch (error) {
      if (isMissingError(error)) return
      throw new DomainError('IO_ERROR', `Failed to remove "${resolved}": ${errorMessage(error)}`)
    }
  }

  // #endregion

  // #region settings ---------------------------------------------------------------------------

  /**
   * Current effective settings, the loader-row defaults, and the persisted overrides
   * (`POST /api/cleanup.settings.get`, SPEC §4.8).
   * @returns {Promise<object>} envelope.
   */
  async function settingsGet() {
    let overrides = {}
    try {
      overrides = await readSettingsOverrides(config.settingsFile)
    } catch {
      overrides = {}
    }
    const persisted = await settingsWritable()
    return ok({
      settings: settingsFromConfig(config),
      defaults: settingsFromConfig(baseConfig),
      overrides,
      persisted,
    })
  }

  /**
   * Validate, apply to the running engine, and persist a settings patch (`POST /api/cleanup.settings.set`).
   * @param {object} request - `{ patch }`.
   * @returns {Promise<object>} envelope.
   */
  async function settingsSet(request) {
    if (!isPlainObject(request)) return fail('BAD_REQUEST', 'The request body must be a JSON object.')
    const validated = validateSettingsPatch(request.patch)
    if (!validated.ok) {
      return fail('BAD_REQUEST', validated.message, { field: validated.field })
    }
    const warnings = []
    for (const field of ['trashRoot', 'deferredFile', 'auditFile']) {
      if (Object.prototype.hasOwnProperty.call(validated.value, field) && validated.value[field] !== config[field]) {
        warnings.push({ field, code: 'EXISTING_DATA_STAYS', message: `Existing ${field} data stays at the old location.` })
      }
    }
    Object.assign(config, validated.value)
    if (Object.prototype.hasOwnProperty.call(validated.value, 'auditFile')) audit = null
    if (Object.prototype.hasOwnProperty.call(validated.value, 'auditEnabled') || Object.prototype.hasOwnProperty.call(validated.value, 'auditFile')) {
      try {
        const log = await auditLog()
        log.setEnabled(config.auditEnabled)
      } catch {
        /* the next record will recreate it */
      }
    }
    let persisted = false
    /** @type {object | null} */
    let persistError = null
    try {
      const overrides = { ...(await readSettingsOverrides(config.settingsFile)), ...validated.value }
      await writeSettingsOverrides(config.settingsFile, overrides)
      persisted = true
    } catch (error) {
      persistError = { code: 'IO_ERROR', message: errorMessage(error) }
    }
    return ok({
      settings: settingsFromConfig(config),
      persisted,
      ...(persistError === null ? {} : { persistError }),
      ...(warnings.length === 0 ? {} : { warnings }),
    })
  }

  /**
   * @returns {Promise<boolean>} whether the settings file location accepts a write right now.
   */
  async function settingsWritable() {
    try {
      await fs.mkdir(path.dirname(config.settingsFile), { recursive: true, mode: 0o700 })
      const probe = `${config.settingsFile}.writable-probe`
      await fs.writeFile(probe, '', { mode: 0o600 })
      await fs.unlink(probe)
      return true
    } catch {
      return false
    }
  }

  // #endregion

  // #region deferred deletions -----------------------------------------------------------------

  /**
   * Serialize the queue's read-modify-write operations inside this process. Two tabs queueing or
   * cancelling at the same instant would otherwise both read the old document and one update would be
   * lost (the file itself is written atomically, so the loser of a cross-process race is still just a
   * lost update, never a corrupt file).
   * @template T
   * @param {() => Promise<T>} operation - critical section.
   * @returns {Promise<T>} the section's result.
   */
  function withDeferredLock(operation) {
    const result = deferredChain.then(operation, operation)
    deferredChain = result.then(() => undefined, () => undefined)
    return result
  }
  /** @type {Promise<unknown>} */
  let deferredChain = Promise.resolve()
  /** Monotonic-enough queue timestamp: two mutations in the same millisecond must still order. */
  let queueTimestamp = 0

  /**
   * Next monotonic queue timestamp. `Date.now()` resolution is 1 ms, so a defer issued in the same
   * millisecond as a start-up run could otherwise be mistaken for a pre-run entry.
   * @returns {number} strictly increasing timestamp.
   */
  function nextQueueTimestamp() {
    queueTimestamp = Math.max(now(), queueTimestamp + 1)
    return queueTimestamp
  }

  /**
   * Project the queue for the wire: entries (no confirmation text), count, and the previous
   * startup run's results.
   * @returns {Promise<{ count: number, entries: object[], lastRun: object | null }>}
   */
  async function deferredState() {
    const document = await readDeferred(config.deferredFile)
    return {
      count: document.entries.length,
      retainedCount: document.retained.length,
      entries: document.entries.map(projectDeferredEntry),
      retained: document.retained.map(projectRetainedEntry),
      lastRun: document.lastRun,
    }
  }

  /**
   * Queue one reviewed deletion for the next Host start (`POST /api/cleanup.defer`).
   *
   * DSH cannot release a live Agent, so this is the only safe way to delete a Session that was
   * opened in this app run: the next start applies the queue before any Agent exists.
   * @param {object} request - `{ targets, mode?, includeSessions?, includeDescendants?, confirmationText? }`.
   * @returns {Promise<object>} envelope.
   */
  async function defer(request) {
    const validation = validatePlanRequest(request)
    if (!validation.ok) return validation.envelope
    const { targets, mode, includeSessions, includeDescendants } = validation.value
    if (request.confirmationText !== undefined && request.confirmationText !== null && typeof request.confirmationText !== 'string') {
      return fail('BAD_REQUEST', '"confirmationText" must be a string.')
    }
    let confirmationText = typeof request.confirmationText === 'string' ? request.confirmationText : null
    try {
      // Every queued target must exist now, otherwise the queue would be born stale.
      const normalized = []
      for (const target of targets) {
        if (target.kind === 'workspace') {
          const entity = registry().get(target.id)
          if (entity === undefined || entity === null) return fail('UNKNOWN_WORKSPACE', `Unknown workspace "${target.id}".`)
        } else {
          const snapshot = await statStoredSession(target.id)
          if (snapshot === undefined || snapshot === null) return fail('UNKNOWN_SESSION', `Unknown session "${target.id}".`)
        }
        normalized.push({ kind: target.kind, id: target.id })
      }
      // Validation-only planning (no retained record, so queueing can never evict the plan the user
      // is reviewing). It serves three purposes: the permanent-mode typed-name check, freezing the
      // reviewed item set, and capturing the identity of the confirmed directory.
      const planned = await plan({ targets: normalized, mode, includeSessions, includeDescendants }, { retain: false })
      if (!planned.ok) return planned
      const reviewedItems = planned.plan.items.map((item) => ({ kind: item.kind, id: item.id }))
      let confirmedDirectory = null
      if (mode === 'permanent') {
        const confirmation = planned.plan.confirmation
        if (confirmation !== null) {
          if (confirmationText === null || confirmationText === '') {
            return fail('CONFIRMATION_REQUIRED', `Type "${confirmation.expected}" to queue permanent deletion.`)
          }
          if (confirmationText !== confirmation.expected) {
            return fail('CONFIRMATION_MISMATCH', `The typed confirmation does not match "${confirmation.expected}".`)
          }
          confirmedDirectory = await confirmedDirectoryAnchor(normalized)
        } else {
          confirmationText = null
        }
      } else {
        confirmationText = null
      }

      return await withDeferredLock(async () => {
        let lock = null
        try {
          lock = await acquireDeferredLock(config.deferredFile, now())
        } catch {
          return fail('IO_ERROR', 'The deferred queue location is not writable.')
        }
        if (lock === null) return fail('DEFERRED_BUSY', 'Another process is updating the deferred queue; retry in a moment.')
        try {
          const document = await readDeferred(config.deferredFile)
          const key = targetSetKey(normalized)
          const existingIndex = document.entries.findIndex((entry) => targetSetKey(entry.targets) === key)
          const replaced = existingIndex >= 0
          if (!replaced && document.entries.length >= DEFERRED_MAX_ENTRIES) {
            return fail('DEFERRED_FULL', `The deferred-deletion queue is full (${DEFERRED_MAX_ENTRIES} entries); cancel one before queueing another.`)
          }
          const entry = {
            id: replaced ? document.entries[existingIndex].id : randomUUID(),
            queuedAt: nextQueueTimestamp(),
            mode,
            includeSessions,
            includeDescendants,
            confirmationText,
            // Drift guard: the startup run refuses to delete anything that was not on this reviewed set.
            reviewedItems,
            confirmedDirectory,
            targets: normalized,
          }
          const entries = replaced
            ? document.entries.map((current, index) => (index === existingIndex ? entry : current))
            : [...document.entries, entry]
          // Preserve the retained («上次未完成») list: queueing a new deletion must not forget the
          // skipped/failed entries the user still wants to review or requeue (SPEC §4.7).
          await writeDeferred(config.deferredFile, { entries, retained: document.retained, lastRun: document.lastRun })
          await recordAudit({ source: 'immediate', action: 'defer', mode, targets: normalized, status: 'queued' })
          return ok({ deferred: { count: entries.length, entryIds: [entry.id], replaced } })
        } finally {
          await lock()
        }
      })
    } catch (error) {
      if (error instanceof DomainError) return fail(error.code, error.message, error.details)
      return fail('IO_ERROR', `The deferred deletion could not be queued: ${errorMessage(error)}`)
    }
  }

  /**
   * Identity anchor for the one existing workspace directory whose typed name was confirmed.
   *
   * The typed name alone only proves a string ("app"); at startup a directory replaced in place, or a
   * different workspace that ends with the same segment, would satisfy it. Recording the canonical
   * path plus device/inode lets the startup run prove it is deleting the directory the user reviewed.
   * @param {{ kind: string, id: string }[]} targets - normalized queue targets.
   * @returns {Promise<{ workspaceId: string, path: string, device: number | null, inode: number | null } | null>}
   */
  async function confirmedDirectoryAnchor(targets) {
    const existing = []
    for (const target of targets) {
      if (target.kind !== 'workspace') continue
      const entity = registry().get(target.id)
      if (entity === undefined || entity === null || typeof entity.path !== 'string') continue
      const directory = await canonicalizeDirectory(entity.path)
      if (!directory.ok) continue
      const entry = await fs.lstat(directory.path).catch(() => null)
      existing.push({
        workspaceId: target.id,
        path: directory.path,
        device: entry !== null && typeof entry.dev === 'number' ? entry.dev : null,
        inode: entry !== null && typeof entry.ino === 'number' ? entry.ino : null,
      })
    }
    return existing.length === 1 ? existing[0] : null
  }

  /**
   * Move retained (skipped/failed) entries back into the active queue
   * (`POST /api/cleanup.deferred.requeue`). Replaces an equivalent target set, exactly like `defer`.
   * @param {object} request - `{ entryIds?: string[], all?: boolean }`.
   * @returns {Promise<object>} envelope.
   */
  async function deferredRequeue(request) {
    if (!isPlainObject(request)) return fail('BAD_REQUEST', 'The request body must be a JSON object.')
    const all = request.all === true
    if (request.all !== undefined && typeof request.all !== 'boolean') return fail('BAD_REQUEST', '"all" must be a boolean.')
    if (!all && !isStringArray(request.entryIds)) return fail('BAD_REQUEST', 'Requeueing requires "entryIds", or {"all": true}.')
    const wanted = all ? null : new Set(dedupeStrings(request.entryIds ?? []))
    const outcome = await withQueueMutation(async () => {
      const document = await readDeferred(config.deferredFile)
      const selected = []
      const kept = []
      for (const record of document.retained) {
        const id = String(record.entry?.id ?? '')
        if (wanted === null || wanted.has(id)) selected.push(record)
        else kept.push(record)
      }
      if (selected.length === 0) return { requeued: 0, entries: document.entries }
      // Requeueing must never evict an already-queued deletion: the active queue is a promise to
      // the user, so a full queue refuses the operation instead of silently dropping the oldest
      // entry (the old `.slice(-DEFERRED_MAX_ENTRIES)` behavior).
      const entryCountAfter = new Set(document.entries.map((entry) => targetSetKey(entry.targets ?? [])))
      let growth = 0
      for (const record of selected) {
        const key = targetSetKey(record.entry?.targets ?? [])
        if (entryCountAfter.has(key)) continue
        entryCountAfter.add(key)
        growth += 1
      }
      if (document.entries.length + growth > DEFERRED_MAX_ENTRIES) return { full: true }
      let entries = document.entries
      for (const record of selected) {
        const entry = { ...record.entry, inFlightAt: null, queuedAt: nextQueueTimestamp() }
        const key = targetSetKey(entry.targets ?? [])
        const existing = entries.findIndex((candidate) => targetSetKey(candidate.targets ?? []) === key)
        entries = existing >= 0
          ? entries.map((candidate, index) => (index === existing ? { ...entry, id: candidate.id } : candidate))
          : [...entries, entry]
      }
      await writeDeferred(config.deferredFile, { entries, retained: kept, lastRun: document.lastRun })
      return { requeued: selected.length, entries }
    })
    if (outcome === 'busy') return fail('DEFERRED_BUSY', 'Another process is applying the deferred queue right now; retry in a moment.')
    if (outcome.full === true) {
      return fail('DEFERRED_FULL', `The deferred-deletion queue is full (${String(DEFERRED_MAX_ENTRIES)} entries); cancel one before requeueing another.`)
    }
    await recordAudit({ source: 'immediate', action: 'requeue', status: 'requeued', targets: [] })
    return ok({ requeued: outcome.requeued, count: outcome.entries.length })
  }

  /** List the deferred queue (`POST /api/cleanup.deferred.list`). */
  async function deferredList() {
    try {
      const state = await deferredState()
      return ok({ deferred: { entries: state.entries, retained: state.retained, lastRun: state.lastRun } })
    } catch (error) {
      return fail('IO_ERROR', `The deferred queue could not be read: ${errorMessage(error)}`)
    }
  }

  /**
   * Cancel queued deletions (`POST /api/cleanup.deferred.cancel`). Idempotent: unknown ids are
   * simply not counted.
   * @param {object} request - `{ entryIds? , all? }`.
   * @returns {Promise<object>} envelope.
   */
  async function deferredCancel(request) {
    if (!isPlainObject(request)) return fail('BAD_REQUEST', 'The request body must be a JSON object.')
    const all = request.all === true
    if (request.all !== undefined && typeof request.all !== 'boolean') return fail('BAD_REQUEST', '"all" must be a boolean.')
    if (!all && !isStringArray(request.entryIds)) return fail('BAD_REQUEST', 'Cancelling requires "entryIds", or {"all": true}.')
    const wanted = all ? null : new Set(dedupeStrings(request.entryIds ?? []))
    try {
      return await withDeferredLock(async () => {
        let lock = null
        try {
          lock = await acquireDeferredLock(config.deferredFile, now())
        } catch {
          // An unusable queue location has nothing to cancel: degrade like every other read route
          // (SPEC §5.8) instead of reporting a misleading error for an idempotent no-op.
          return ok({ cancelled: 0 })
        }
        if (lock === null) {
          // Another process is applying or updating the queue; reporting "cancelled" here would be a lie
          // (it could already be executing the entry). The user retries when the run is over.
          return fail('DEFERRED_BUSY', 'Another process is applying the deferred queue right now; retry in a moment.')
        }
        try {
          const document = await readDeferred(config.deferredFile)
          const entries = wanted === null ? [] : document.entries.filter((entry) => !wanted.has(entry.id))
          // Cancelling a retained (skipped/failed) entry means "forget it": it is not in the active
          // queue, but the user must be able to clear the «上次未完成» list with the same control.
          const retained = wanted === null
            ? []
            : document.retained.filter((record) => !wanted.has(String(record.entry?.id ?? '')))
          const cancelled = (document.entries.length - entries.length) + (document.retained.length - retained.length)
          if (cancelled > 0) await writeDeferred(config.deferredFile, { entries, retained, lastRun: document.lastRun })
          if (cancelled > 0) await recordAudit({ source: 'immediate', action: 'cancel', status: 'cancelled', entryIds: wanted === null ? [] : [...wanted] })
          return ok({ cancelled })
        } finally {
          await lock()
        }
      })
    } catch (error) {
      return fail('IO_ERROR', `The deferred queue could not be updated: ${errorMessage(error)}`)
    }
  }

  /**
   * Apply the queued deletions, once per process, at Host start.
   *
   * The guard is process-global because a plugin hot-reload (which re-runs `apply` in the SAME
   * process, with live Agents) must never consume the queue: doing so would either skip the user's
   * queued deletions as blocked or, worse, delete them under a live writer.
   * @returns {Promise<{ ran: boolean, results: object[] }>}
   */
  /**
   * Queue files this process has already applied (or observed being applied elsewhere).
   * @returns {Set<string>}
   */
  function deferredMarker() {
    if (!(globalThis.__dshCleanupDeferredProcessedFiles instanceof Set)) {
      globalThis.__dshCleanupDeferredProcessedFiles = new Set()
    }
    return globalThis.__dshCleanupDeferredProcessedFiles
  }

  async function runDeferred() {
    // "Already applied in this process" is keyed by the queue file, not a bare boolean: a plugin
    // hot-reload shares the file (so it is skipped), while two independent deployments/homes do not
    // block each other. It also keeps concurrent runs for different temp roots independent in tests.
    if (deferredMarker().has(config.deferredFile)) return { ran: false, results: [] }
    // One runner per queue across processes; the claim is held for the run and taken over after a
    // crash (10 min). Mutation locks are only held per step, so a long run does not block defer/cancel.
    let runner = null
    try {
      // A crash between taking the run claim and releasing it would otherwise make this Host skip
      // the whole queue for the claim-stale window with nothing in the UI or the audit log. A claim
      // whose recorded process is gone is taken over immediately; the age fallback still bounds a
      // live-looking or corrupt claim (SPEC §5.8).
      await breakDeadLock(deferredRunClaimPath(config.deferredFile), now(), DEFERRED_CLAIM_STALE_MS)
      // The run claim is owned by liveness, not by age: a live process may run longer than the
      // stale window, so acquireDeferredLock must not do its mtime-based takeover here — the
      // pid-aware breakDeadLock above is the only place that decides a run claim is abandoned.
      runner = await acquireDeferredLock(`${config.deferredFile}.run`, now(), Number.POSITIVE_INFINITY)
    } catch {
      return { ran: false, results: [] }
    }
    if (runner === null) {
      deferredMarker().add(config.deferredFile)
      return { ran: false, busy: true, results: [] }
    }
    /** @type {object[]} */
    const results = []
    // Only entries that already existed when the run started are applied: an entry queued mid-run (a
    // page reconnecting and scheduling something) waits for the next start instead of being deleted
    // by a run it was not reviewed for.
    const runStartedAt = nextQueueTimestamp()
    try {
      for (; ;) {
        const claimed = await claimNextDeferredEntry(runStartedAt)
        if (claimed.busy === true) break
        if (claimed.entry === null) break
        const result = await runDeferredEntry(claimed.entry)
        results.push(result)
        await finalizeDeferredEntry(claimed.entry, result)
        await recordAudit({
          source: 'startup',
          action: result.status === 'skipped' ? 'skip' : 'delete',
          mode: claimed.entry.mode,
          targets: claimed.entry.targets,
          status: result.status,
          code: result.code ?? null,
          bytes: result.bytes ?? 0,
          entryId: claimed.entry.id,
        })
      }
    } finally {
      deferredMarker().add(config.deferredFile)
      await runner()
    }
    if (results.length === 0) return { ran: false, results }
    const applied = results.filter((result) => result.status === 'trashed' || result.status === 'deleted').length
    const skipped = results.filter((result) => result.status === 'skipped').length
    const failed = results.filter((result) => result.status === 'failed').length
    await recordAudit({ source: 'startup', action: 'startup-run', status: 'done', applied, skipped, failed, targets: [] })
    const finalize = await withQueueMutation(async () => {
      const document = await readDeferred(config.deferredFile)
      await writeDeferred(config.deferredFile, {
        entries: document.entries,
        retained: document.retained,
        lastRun: { at: now(), results },
      })
      return true
    })
    if (finalize !== true) return { ran: false, results }
    return { ran: true, results }
  }

  /**
   * Run one queue mutation under the cross-process file lock, retrying briefly when another process
   * holds it. Returns `"busy"` when the lock stayed held (the caller leaves the queue alone).
   * @template T
   * @param {() => Promise<T>} operation - critical section.
   * @returns {Promise<T | "busy">}
   */
  async function withQueueMutation(operation) {
    return await withDeferredLock(async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        let lock = null
        try {
          lock = await acquireDeferredLock(config.deferredFile, now())
        } catch {
          return 'busy'
        }
        if (lock === null) {
          await new Promise((resolve) => setTimeout(resolve, 25))
          continue
        }
        try {
          return await operation()
        } finally {
          await lock()
        }
      }
      return 'busy'
    })
  }

  /**
   * Claim the next runnable queue entry for the start-up run: mark it in-flight so a crash or a
   * second process cannot execute it twice, and ignore a claim older than the stale window.
   * @param {number} maxQueuedAt - only entries queued at or before this time are claimed.
   * @returns {Promise<{ entry: object | null, busy: boolean }>}
   */
  async function claimNextDeferredEntry(maxQueuedAt) {
    const outcome = await withQueueMutation(async () => {
      const document = await readDeferred(config.deferredFile)
      const entry = document.entries.find((candidate) => {
        const claimable = candidate.inFlightAt === null || candidate.inFlightAt === undefined || now() - candidate.inFlightAt > DEFERRED_CLAIM_STALE_MS
        if (!claimable) return false
        const queuedAt = typeof candidate.queuedAt === 'number' ? candidate.queuedAt : 0
        return queuedAt <= maxQueuedAt
      })
      if (entry === undefined) return { entry: null }
      const entries = document.entries.map((candidate) => (
        candidate.id === entry.id ? { ...candidate, inFlightAt: now() } : candidate
      ))
      await writeDeferred(config.deferredFile, { entries, retained: document.retained, lastRun: document.lastRun })
      return { entry: { ...entry, inFlightAt: now() } }
    })
    if (outcome === 'busy') return { entry: null, busy: true }
    return { entry: outcome.entry, busy: false }
  }

  /**
   * Remove one executed entry from the queue and retain it when it did not succeed, so the user can
   * requeue or drop it from «上次未完成».
   * @param {object} entry - claimed entry.
   * @param {object} result - start-up result for it.
   * @returns {Promise<boolean>} whether the finalization was persisted.
   */
  async function finalizeDeferredEntry(entry, result) {
    const outcome = await withQueueMutation(async () => {
      const document = await readDeferred(config.deferredFile)
      const entries = document.entries.filter((candidate) => candidate.id !== entry.id)
      let retained = document.retained
      if (result.status === 'skipped' || result.status === 'failed') {
        retained = [
          ...retained,
          {
            at: now(),
            status: result.status,
            code: result.code ?? null,
            reason: result.reason ?? '',
            entry: { ...entry, inFlightAt: null },
          },
        ].slice(-DEFERRED_RETAINED_MAX)
      }
      await writeDeferred(config.deferredFile, { entries, retained, lastRun: document.lastRun })
      return true
    })
    return outcome === true
  }

  /**
   * Apply one queued entry through the same plan/admission/execute pipeline a user-clicked deletion
   * uses, so every safety rule (blockers, liveness, path validation) still applies.
   * @param {object} entry - stored queue entry.
   * @returns {Promise<object>} one last-run result.
   */
  /**
   * Verify the plan still targets the exact directory whose typed name was confirmed (queue-time
   * identity anchor). A mismatch is a skip, never a guess.
   * @param {object} entry - queued entry.
   * @param {object} planPayload - freshly built plan.
   * @returns {Promise<{ code: string, message: string } | null>}
   */
  async function checkConfirmedDirectory(entry, planPayload) {
    const anchor = entry.confirmedDirectory
    if (anchor === null || anchor === undefined) return null
    const item = planPayload.items.find((candidate) => candidate.kind === 'workspace-dir' && candidate.id === anchor.workspaceId)
    if (item === undefined) {
      return { code: 'PATH_CHANGED', message: 'The directory whose deletion was confirmed is no longer part of the reviewed plan.' }
    }
    const directory = await canonicalizeDirectory(item.path)
    if (!directory.ok || !samePath(directory.path, anchor.path)) {
      return { code: 'PATH_CHANGED', message: 'The confirmed directory was replaced or moved since it was queued.' }
    }
    const stat = await fs.lstat(directory.path).catch(() => null)
    if (stat === null) {
      return { code: 'PATH_CHANGED', message: 'The confirmed directory disappeared before the queued deletion ran.' }
    }
    if (anchor.device !== null && typeof stat.dev === 'number' && stat.dev !== anchor.device) {
      return { code: 'PATH_CHANGED', message: 'The confirmed directory is on a different file-system device now.' }
    }
    if (anchor.inode !== null && typeof stat.ino === 'number' && stat.ino !== anchor.inode) {
      return { code: 'PATH_CHANGED', message: 'The confirmed directory was replaced by a different directory since it was queued.' }
    }
    return null
  }

  /**
   * Prove every named Session is currently writable, i.e. no live writer in another process holds
   * it. The persistence backend's single-writer claim is the authority (SPEC §5.2).
   *
   * This is the only cross-process liveness signal DSH exposes: the in-process `sessions`/`agents`
   * services cannot see a Session opened by a second Host sharing `$DSH_HOME`.
   * @param {string[]} ids - session ids to prove writable.
   * @returns {Promise<{ code: string, message: string, sessionId: string } | null>} the first refusal.
   */
  async function probeSessionWritability(ids) {
    if (typeof deps.sessionPersistence?.open !== 'function') return null
    for (const id of ids) {
      let handle
      try {
        handle = await deps.sessionPersistence.open(id, 'write')
      } catch (error) {
        const name = error instanceof Error ? error.name : ''
        const message = error instanceof Error ? error.message : String(error)
        const fingerprint = `${name} ${message}`
        if (/AlreadyOwned|ALREADY_OWNED|already owned/i.test(fingerprint)) {
          return { code: 'SESSION_LIVE', message: `Session "${id}" is held live by another process; its log is left untouched.`, sessionId: id }
        }
        // A log that is already missing, unreadable, or corrupt is not held by a live writer: the
        // backend claims its write lease before reading the log, and an ownership conflict would
        // have been reported first. There is nothing a live writer could corrupt, and a cleanup
        // plugin must still be able to remove such a log (SPEC §5.2). The per-item re-check below
        // handles a directory that vanished in the meantime (`dirGone` → `deleted` with bytes 0).
        if (/^Session.*(?:NotFound|Corrupt(?:ion)?|FormatUnsupported)Error$/.test(name) || error?.code === 'ENOENT') {
          continue
        }
        return { code: 'IO_ERROR', message: `Session "${id}" could not be verified as writable: ${message}`, sessionId: id }
      }
      try {
        if (typeof handle?.close === 'function') await handle.close()
      } catch {
        /* releasing the probe claim is best effort; a failed release only delays the next attempt */
      }
    }
    return null
  }

  /**
   * Probe every Session a retained plan is about to delete. Items whose log directory is already
   * gone have nothing to corrupt, so they are skipped (their deletion is registration-only).
   * @param {object} planPayload - freshly built plan.
   * @returns {Promise<{ code: string, message: string, sessionId: string } | null>}
   */
  async function probePlannedSessionWritability(planPayload) {
    const ids = planPayload.items
      .filter((item) => item.kind === 'session' && typeof item.path === 'string')
      .map((item) => item.id)
    return probeSessionWritability(ids)
  }

  async function runDeferredEntry(entry) {
    const base = { entryId: String(entry.id ?? ''), mode: entry.mode === 'permanent' ? 'permanent' : 'trash', targets: entry.targets }
    try {
      const planned = await plan({
        targets: entry.targets,
        mode: base.mode,
        includeSessions: entry.includeSessions !== false,
        includeDescendants: entry.includeDescendants !== false,
      }, { probeSessionWritability: false })
      if (!planned.ok) {
        return { ...base, status: 'failed', code: planned.error.code, reason: planned.error.message }
      }
      if (planned.plan.blockers.length > 0) {
        return { ...base, status: 'skipped', code: planned.plan.blockers[0].code, reason: planned.plan.blockers[0].message }
      }
      // The startup run re-derives the plan, which can drift from what the user reviewed (sessions created
      // after the review, tools/subagents). Refuse to delete anything that was not on the reviewed set;
      // a reviewed item that merely vanished is fine to skip (it is already gone).
      if (Array.isArray(entry.reviewedItems) && entry.reviewedItems.length > 0) {
        const reviewed = new Set(entry.reviewedItems.map((item) => `${item.kind}:${item.id}`))
        const unexpected = planned.plan.items.filter((item) => !reviewed.has(`${item.kind}:${item.id}`))
        if (unexpected.length > 0) {
          return {
            ...base,
            status: 'skipped',
            code: 'DEFERRED_TARGETS_CHANGED',
            reason: `The deletion set changed since it was queued (${unexpected.length} unreviewed item(s) would be deleted: ${unexpected.slice(0, 3).map((item) => item.id).join(', ')}). Review and queue it again.`,
          }
        }
      }
      // Permanent mode also proves it is deleting the directory whose typed name was confirmed: the
      // name alone would accept a directory replaced in place, or a different workspace with the same
      // final segment.
      const identityFailure = await checkConfirmedDirectory(entry, planned.plan)
      if (identityFailure !== null) return { ...base, status: 'skipped', code: identityFailure.code, reason: identityFailure.message }
      // Cross-process liveliness: another Host (a different profile sharing this $DSH_HOME) may hold a
      // queued session's write handle. Our own process's liveness checks cannot see it, so prove the
      // session is writable right now — the persistence backend's single-writer lock is the authority.
      const writabilityFailure = await probePlannedSessionWritability(planned.plan)
      if (writabilityFailure !== null) {
        return { ...base, status: 'skipped', code: writabilityFailure.code, reason: writabilityFailure.message }
      }
      const confirmation = planned.plan.confirmation
      const confirmationText = typeof entry.confirmationText === 'string' ? entry.confirmationText : ''
      if (confirmation !== null && confirmationText !== confirmation.expected) {
        return { ...base, status: 'skipped', code: 'CONFIRMATION_REQUIRED', reason: 'The typed confirmation recorded with this queued deletion no longer matches the plan.' }
      }
      const executed = await execute({
        planId: planned.plan.planId,
        ...(confirmation === null ? {} : { confirmationText }),
      }, { audit: false, skipSessionWritabilityProbe: true })
      if (!executed.ok) {
        return { ...base, status: 'failed', code: executed.error.code, reason: executed.error.message }
      }
      const items = executed.result.items
      const failed = items.filter((item) => item.status === 'failed')
      const succeeded = items.length - failed.length
      // The summary must describe what actually happened: a trash-mode plan whose only item was an
      // unmaterialized session is `deleted` (nothing was moved to the trash), not `trashed`.
      const trashed = items.filter((item) => item.status === 'trashed').length
      return {
        ...base,
        status: succeeded === 0 ? 'failed' : (trashed > 0 ? 'trashed' : 'deleted'),
        items: items.map((item) => ({ kind: item.kind, id: item.id, status: item.status })),
        ...(failed.length > 0 ? { code: failed[0].error?.code ?? 'IO_ERROR', reason: `${failed.length} of ${items.length} item(s) failed` } : {}),
      }
    } catch (error) {
      return { ...base, status: 'failed', code: error instanceof DomainError ? error.code : 'INTERNAL', reason: errorMessage(error) }
    }
  }

  // #endregion

  // #region trash ------------------------------------------------------------------------------

  /**
   * The nearest existing ancestor's device id, used to predict `EXDEV` at plan time. Walking up
   * stops at the filesystem root; an unreadable chain reports null (trash unusable, not safe).
   * @param {string} targetPath - absolute path to probe.
   * @returns {Promise<number | null>}
   */
  async function nearestExistingDevice(targetPath) {
    let current = path.resolve(targetPath)
    for (let depth = 0; depth < MAX_DEVICE_PROBE_DEPTH; depth += 1) {
      try {
        const stat = await fs.stat(current)
        return typeof stat.dev === 'number' ? stat.dev : null
      } catch {
        /* try the parent */
      }
      const parent = path.dirname(current)
      if (parent === current) return null
      current = parent
    }
    return null
  }

  /** @returns {Promise<void>} */
  async function ensureTrashRoot() {
    try {
      await fs.mkdir(config.trashRoot, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new DomainError('TRASH_UNAVAILABLE', `The cleanup trash root "${config.trashRoot}" is not usable: ${errorMessage(error)}`)
    }
  }

  /** @param {string} entryDir @returns {Promise<void>} */
  async function discardEntryDirQuietly(entryDir) {
    try {
      await removeTree(entryDir)
    } catch {
      /* a failed cleanup of an empty allocation must not mask the original failure */
    }
  }

  /**
   * `header.origin` of a planned Session item ('subagent' marks a subagent log), or null. The plan
   * item carries `parentSessionId`/`isDescendant` but not the origin, which lives in the snapshot.
   * @param {object} item - a planned session item.
   * @returns {string | null} the origin, or null when the header has none.
   */
  function sessionOriginOf(item) {
    const header = item && item.snapshot && item.snapshot.header ? item.snapshot.header : null
    const origin = header && typeof header.origin === 'string' ? header.origin : null
    return origin !== null && origin !== '' ? origin : null
  }

  /**
   * Move one target into a fresh trash entry and write its metadata.
   *
   * Ordering (SPEC §5.7): allocate the entry dir, `rename` the payload in, then write `meta.json`. A
   * crash between the move and the metadata write leaves a listed-but-unrestorable entry, which the
   * trash list is specified to surface; a *write error* is different, so we roll the payload back
   * when we can rather than leave an entry the user cannot restore.
   *
   * @param {{ kind: 'workspace-dir' | 'session', title: string | null, originalPath: string, workspaceId: string | null, sessionId: string | null, bytes: number, files: number, dirs: number, origin?: string | null, parentSessionId?: string | null }} input
   * @returns {Promise<{ entryId: string, entryDir: string }>}
   */
  async function moveIntoTrash(input) {
    await ensureTrashRoot()
    const label = input.kind === 'workspace-dir'
      ? input.title || lastSegment(input.originalPath)
      : input.title || input.sessionId || lastSegment(input.originalPath)

    /** @type {string | null} */
    let entryDir = null
    /** @type {string | null} */
    let entryId = null
    for (let attempt = 0; attempt < TRASH_ID_ATTEMPTS && entryDir === null; attempt += 1) {
      const candidateId = trashEntryId(now(), label)
      const candidateDir = path.join(config.trashRoot, candidateId)
      try {
        await fs.mkdir(candidateDir, { mode: 0o700 })
        entryId = candidateId
        entryDir = candidateDir
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
          throw new DomainError('TRASH_UNAVAILABLE', `Failed to allocate a trash entry: ${errorMessage(error)}`)
        }
      }
    }
    if (entryDir === null || entryId === null) {
      throw new DomainError('TRASH_UNAVAILABLE', 'Could not allocate a unique trash entry id; retry the deletion.')
    }

    const payloadPath = path.join(entryDir, 'payload')
    const movedAt = now()
    const meta = {
      version: TRASH_META_VERSION,
      kind: input.kind,
      title: input.title ?? null,
      originalPath: input.originalPath,
      movedAt,
      bytes: input.bytes,
      files: input.files,
      dirs: input.dirs,
    }
    if (input.workspaceId !== null) meta.workspaceId = input.workspaceId
    if (input.sessionId !== null) meta.sessionIds = [input.sessionId]
    // Session family bookkeeping: the trash list reports these so a subagent log stays recognizable
    // after its parent is gone (SPEC §4.5). Optional, so older entries simply omit them.
    if (typeof input.origin === 'string' && input.origin !== '') meta.origin = input.origin
    if (typeof input.parentSessionId === 'string' && input.parentSessionId !== '') meta.parentSessionId = input.parentSessionId

    // Prepare the entry before the payload moves: ownership marker first, then metadata. If either
    // write fails, nothing has moved yet and the empty plugin-owned allocation is safe to discard.
    // A crash between the metadata write and the rename leaves a listed entry whose payload is
    // missing (`RESTORE_PAYLOAD_MISSING`) — recoverable-as-a-listing, never a lost payload.
    try {
      await fs.writeFile(
        path.join(entryDir, TRASH_ENTRY_MARKER),
        `${JSON.stringify({ plugin: 'dsh-cleanup', version: TRASH_META_VERSION })}\n`,
        { mode: 0o600 },
      )
      await fs.writeFile(path.join(entryDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 })
    } catch (error) {
      await discardEntryDirQuietly(entryDir)
      throw new DomainError(
        'IO_ERROR',
        `The trash entry could not be prepared, so nothing was moved: ${errorMessage(error)}`,
      )
    }

    try {
      await fs.rename(input.originalPath, payloadPath)
    } catch (error) {
      // The entry contains only the marker and metadata; the payload never moved, so discarding it
      // loses no user data.
      await discardEntryDirQuietly(entryDir)
      if (errorCode(error) === 'EXDEV') {
        throw new DomainError(
          'TRASH_CROSS_DEVICE',
          'The trash is on a different volume, so the directory cannot be moved atomically. Use permanent deletion or configure trashRoot on the same volume.',
        )
      }
      throw new DomainError('IO_ERROR', `Failed to move "${input.originalPath}" into the trash: ${errorMessage(error)}`)
    }
    return { entryId, entryDir }
  }

  /**
   * Read and minimally validate one trash entry's `meta.json`.
   * @param {string} entryDir - entry directory.
   * @returns {Promise<Record<string, any> | null>}
   */
  async function readTrashMeta(entryDir) {
    let text
    try {
      text = await fs.readFile(path.join(entryDir, 'meta.json'), 'utf8')
    } catch {
      return null
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return null
    }
    if (!isPlainObject(parsed) || parsed.version !== TRASH_META_VERSION) return null
    return parsed
  }

  /**
   * Strict shape check for a metadata-only (pre-marker) entry written by 0.3.0. Only entries this
   * plugin could have written pass; an arbitrary directory that happens to sit under the configured
   * `trashRoot` does not. This keeps existing trash entries manageable after the marker upgrade
   * without adopting foreign directories.
   * @param {Record<string, any> | null} meta - parsed `meta.json`, or null.
   * @returns {boolean}
   */
  function isValidLegacyTrashMeta(meta) {
    return (
      isPlainObject(meta) &&
      meta.version === TRASH_META_VERSION &&
      (meta.kind === 'workspace-dir' || meta.kind === 'session') &&
      typeof meta.originalPath === 'string' &&
      path.isAbsolute(meta.originalPath) &&
      typeof meta.movedAt === 'number' &&
      Number.isFinite(meta.movedAt)
    )
  }

  /**
   * Whether one directory under the trash root was created by this plugin.
   *
   * Ownership is proven by the marker file every entry has carried since 0.4.0. Entries written by
   * 0.3.0 are accepted when their `meta.json` has the plugin's strict shape, so an upgrade does not
   * orphan the user's existing trash. A foreign directory is never listed, restored, or purged,
   * even if `trashRoot` was pointed at a directory that already held data (SPEC §5.7).
   * @param {string} entryDir - candidate entry directory.
   * @returns {Promise<boolean>}
   */
  async function isOwnedTrashEntry(entryDir) {
    try {
      const marker = await fs.lstat(path.join(entryDir, TRASH_ENTRY_MARKER))
      if (marker.isFile() && !marker.isSymbolicLink()) return true
    } catch {
      /* legacy entry, a foreign directory, or an unreadable marker */
    }
    return isValidLegacyTrashMeta(await readTrashMeta(entryDir))
  }

  /** @param {string} value @returns {boolean} */
  function isValidTrashEntryId(value) {
    return (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= MAX_TRASH_ID_LENGTH &&
      value !== '.' &&
      value !== '..' &&
      !value.includes('/') &&
      !value.includes('\\') &&
      path.basename(value) === value
    )
  }

  /**
   * Enumerate trash entries (directories only; symlinks are never followed).
   * @returns {Promise<{ names: string[], entryDirs: string[] }>}
   */
  async function listTrashDirectories() {
    let names
    try {
      names = await fs.readdir(config.trashRoot)
    } catch (error) {
      if (isMissingError(error)) return { names: [], entryDirs: [] }
      throw new DomainError('TRASH_UNAVAILABLE', `The cleanup trash root "${config.trashRoot}" cannot be read: ${errorMessage(error)}`)
    }
    const safeNames = []
    const entryDirs = []
    for (const name of names) {
      if (!isValidTrashEntryId(name)) continue
      const entryDir = path.join(config.trashRoot, name)
      let stat
      try {
        stat = await fs.lstat(entryDir)
      } catch {
        continue
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue
      // Only directories this plugin created are trash entries. A `trashRoot` pointed at an
      // existing data directory must never surface those directories as purgeable entries.
      if (!(await isOwnedTrashEntry(entryDir))) continue
      safeNames.push(name)
      entryDirs.push(entryDir)
    }
    return { names: safeNames, entryDirs }
  }

  /**
   * Restorability of one entry (SPEC §4.5): the payload must still exist, the original path must be
   * free, and its parent must still be a real directory.
   * @param {string} entryDir - entry directory.
   * @param {Record<string, any> | null} meta - parsed metadata.
   * @returns {Promise<{ restorable: boolean, restorableCode: string | null }>}
   */
  async function restorabilityOf(entryDir, meta) {
    if (meta === null) return { restorable: false, restorableCode: 'RESTORE_ENTRY_UNREADABLE' }
    const originalPath = meta.originalPath
    if (typeof originalPath !== 'string' || !path.isAbsolute(originalPath)) {
      return { restorable: false, restorableCode: 'RESTORE_ENTRY_UNREADABLE' }
    }
    try {
      const payloadStat = await fs.lstat(path.join(entryDir, 'payload'))
      // The list must agree with what restore actually accepts: restore refuses anything that is not a
      // plain directory (symlink or regular file), so the row must say so too.
      if (payloadStat.isSymbolicLink() || !payloadStat.isDirectory()) {
        return { restorable: false, restorableCode: 'RESTORE_PAYLOAD_INVALID' }
      }
    } catch {
      return { restorable: false, restorableCode: 'RESTORE_PAYLOAD_MISSING' }
    }
    try {
      await fs.lstat(originalPath)
      return { restorable: false, restorableCode: 'RESTORE_ORIGINAL_EXISTS' }
    } catch (error) {
      if (!isMissingError(error)) return { restorable: false, restorableCode: 'RESTORE_UNREADABLE' }
    }
    try {
      const parentStat = await fs.lstat(path.dirname(originalPath))
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
        return { restorable: false, restorableCode: 'RESTORE_ORIGINAL_MISSING' }
      }
    } catch {
      return { restorable: false, restorableCode: 'RESTORE_ORIGINAL_MISSING' }
    }
    return { restorable: true, restorableCode: null }
  }

  // #endregion

  // #region git safety probe -------------------------------------------------------------------

  /** Per-plan budget for all Git probes; past it the remaining probes are skipped silently. */
  const GIT_PLAN_BUDGET_MS = 5000

  /** One Git invocation may take at most this long. */
  const GIT_COMMAND_TIMEOUT_MS = 3000

  /**
   * Run one read-only Git command.
   *
   * The probe is strictly advisory: a missing binary, a non-repository folder, a timeout, or a
   * non-zero exit all resolve to `null`, so the plan degrades to what it was before the probe existed
   * instead of failing or blocking.
   * @param {string[]} args - arguments after the executable.
   * @returns {Promise<string | null>} trimmed stdout, or null.
   */
  function runGit(args) {
    return new Promise((resolve) => {
      try {
        execFile('git', args, {
          timeout: GIT_COMMAND_TIMEOUT_MS,
          maxBuffer: 512 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
          windowsHide: true,
        }, (error, stdout) => {
          if (error !== null && error !== undefined) {
            resolve(null)
            return
          }
          resolve(typeof stdout === 'string' ? stdout.trim() : null)
        })
      } catch {
        resolve(null)
      }
    })
  }

  /**
   * Read-only dirty/unpushed probe for one planned workspace directory (SPEC §5.4).
   *
   * Returns warnings only; it never blocks and never changes the plan's deletion set.
   * @param {string} workspacePath - canonical directory about to be deleted.
   * @param {string} workspaceId - owning workspace id.
   * @param {{ deadline: number, cache: Map<string, object[]>, now: () => number }} probe - plan budget/cache.
   * @returns {Promise<object[]>} warnings.
   */
  async function gitWarnings(workspacePath, workspaceId, probe) {
    if (config.gitSafetyCheck === false) return []
    if (probe.now() > probe.deadline) return []
    const topLevel = await runGit(['-C', workspacePath, 'rev-parse', '--show-toplevel'])
    if (topLevel === null || topLevel === '') return []
    const root = topLevel
    const cached = probe.cache.get(root)
    if (cached !== undefined) {
      return cached.map((entry) => warning(entry.code, null, workspaceId, entry.message))
    }
    /** @type {object[]} */
    const findings = []
    const status = await runGit(['-C', root, 'status', '--porcelain=v1', '--untracked-files=normal'])
    if (status !== null) {
      const changed = status === '' ? 0 : status.split('\n').filter((line) => line !== '').length
      if (changed > 0) {
        findings.push({
          code: 'WORKSPACE_GIT_DIRTY',
          message: `This repository has ${changed} uncommitted or untracked change(s); deleting the folder loses them.`,
        })
      }
    }
    if (probe.now() <= probe.deadline) {
      const remotes = await runGit(['-C', root, 'remote'])
      if (remotes !== null && remotes !== '') {
        const countText = await runGit(['-C', root, 'rev-list', '--count', 'HEAD', '--not', '--remotes'])
        const count = countText === null ? NaN : Number.parseInt(countText, 10)
        if (Number.isFinite(count) && count > 0) {
          findings.push({
            code: 'WORKSPACE_GIT_UNPUSHED',
            message: `This repository has ${count} commit(s) that are not on any remote.`,
          })
        }
      }
    }
    probe.cache.set(root, findings)
    return findings.map((entry) => warning(entry.code, null, workspaceId, entry.message))
  }

  // #endregion

  // #region workspace inspection ---------------------------------------------------------------

  /**
   * Re-runnable workspace-directory safety inspection shared by inventory, planning and admission.
   *
   * Order follows SPEC §5.3: existence first (a missing directory is a *warning* and a
   * registration-only plan, never a blocker), then symlink / non-directory / canonical-path, then
   * the pure classification codes as-is, then live sessions and cross-device. Every "we cannot prove
   * this is still the registered directory" answer is a blocker.
   *
   * @param {object} entity - workspace registry entity.
   * @param {{ mode?: 'trash' | 'permanent' | null, storedSessions?: object[] | null }} [options] - plan context.
   * @returns {Promise<{ path: string, missing: boolean, hasGit: boolean, insideSessionIds: string[], liveSessionIds: string[], blockers: object[], warnings: object[], state: 'ok' | 'missing' | 'unsafe', stateCode: string | null, device: number | null }>}
   */
  async function inspectWorkspace(entity, options = {}) {
    const mode = options.mode ?? null
    const storedSessions = options.storedSessions ?? []
    const workspacePath = typeof entity.path === 'string' ? entity.path : ''
    const workspaceId = typeof entity.id === 'string' ? entity.id : String(entity.id ?? '')
    /** @type {object[]} */
    const blockers = []
    /** @type {object[]} */
    const warnings = []
    const result = {
      path: workspacePath,
      missing: false,
      hasGit: false,
      insideSessionIds: [],
      liveSessionIds: [],
      blockers,
      warnings,
      state: 'ok',
      stateCode: null,
      device: null,
    }

    if (workspacePath === '' || !path.isAbsolute(workspacePath)) {
      blockers.push(blocker('PATH_NOT_ABSOLUTE', null, workspaceId, 'The workspace path is not absolute; refusing to delete it.'))
      result.state = 'unsafe'
      result.stateCode = 'PATH_NOT_ABSOLUTE'
      return result
    }

    // Which stored sessions reference this path, and which of them are live, is pure path logic
    // (SPEC §4.1 defines both fields for every workspace row). It runs before the existence checks so
    // a missing or unsafe directory still reports them: the settings page must never claim "0 sessions
    // inside" for a folder that vanished, and plan() computes the same set independently.
    const inside = Array.isArray(options.insideSessionIds)
      ? splitByLiveness(options.insideSessionIds)
      : scanInsideSessions(workspacePath, storedSessions)
    result.insideSessionIds = inside.insideSessionIds
    result.liveSessionIds = inside.liveSessionIds

    // Existence and canonical spelling come from the one shared directory validator; its
    // stable codes are mapped onto the §5.3 blocker vocabulary here. Existence first (SPEC §5.3): a
    // missing directory is not a blocker — the plan then deletes the registration only.
    const directory = await canonicalizeDirectory(workspacePath)
    if (!directory.ok) {
      if (directory.code === PATH_CODES.MISSING) {
        result.missing = true
        result.state = 'missing'
        result.stateCode = 'WORKSPACE_MISSING'
        warnings.push(warning('WORKSPACE_MISSING', null, workspaceId, 'The workspace directory no longer exists; only its registration will be removed.'))
        return result
      }
      if (directory.code === PATH_CODES.SYMLINK) {
        blockers.push(
          blocker('WORKSPACE_SYMLINK', null, workspaceId, 'The workspace path is now a symbolic link; refusing to follow or delete it. Re-register the workspace at the real directory.'),
        )
        result.state = 'unsafe'
        result.stateCode = 'WORKSPACE_SYMLINK'
        return result
      }
      if (directory.code === PATH_CODES.NOT_DIRECTORY) {
        blockers.push(
          blocker('PATH_PROTECTED', null, workspaceId, 'The workspace path is no longer a directory, so there is no directory to delete.'),
        )
        result.state = 'unsafe'
        result.stateCode = 'PATH_PROTECTED'
        return result
      }
      blockers.push(blocker('IO_ERROR', null, workspaceId, `The workspace directory cannot be inspected: ${directory.message}`))
      result.state = 'unsafe'
      result.stateCode = 'IO_ERROR'
      return result
    }
    // The cross-device heuristic needs the device id, which the validator does not report.
    const deviceEntry = await fs.lstat(workspacePath).catch(() => null)
    result.device = deviceEntry !== null && typeof deviceEntry.dev === 'number' ? deviceEntry.dev : null

    const canonical = directory.path
    if (!samePath(canonical, workspacePath)) {
      blockers.push(
        blocker('PATH_CHANGED', null, workspaceId, 'The directory no longer resolves to the registered canonical path; it was moved or replaced. Re-register the workspace before deleting it.'),
      )
      result.state = 'unsafe'
      result.stateCode = 'PATH_CHANGED'
      return result
    }

    // Pure rules last; their codes are blockers as-is (SPEC §5.3).
    const classification = classifyTargetPath(workspacePath, { trashRoot: config.trashRoot, canonicalTarget: canonical })
    if (!classification.ok) {
      blockers.push(blocker(classification.code, null, workspaceId, classification.message))
      result.state = 'unsafe'
      result.stateCode = classification.code
      return result
    }

    // Any live session *using* the directory blocks it, whether or not that session is in the
    // deletion set: the directory is in use by the running process right now. Besides the stored
    // header cwd checked above, this asks each live Agent for its EFFECTIVE working directory, which
    // a `working_directory` change can move inside this folder without touching the header.
    const liveInside = liveSessionsInside(workspacePath)
    if (liveInside.probeFailed) {
      blockers.push(
        blocker('IO_ERROR', null, workspaceId, 'Whether a live session is using this directory could not be verified; refusing to delete it.'),
      )
    }
    for (const liveId of liveInside.ids) {
      if (!result.liveSessionIds.includes(liveId)) result.liveSessionIds.push(liveId)
    }
    const liveSessionIds = result.liveSessionIds
    if (liveSessionIds.length > 0) {
      blockers.push(
        blocker(
          'WORKSPACE_HAS_LIVE_SESSIONS',
          null,
          workspaceId,
          `A live session is using this workspace directory (${liveSessionIds.join(', ')}); close it before deleting the folder.`,
        ),
      )
    }

    try {
      await fs.lstat(path.join(workspacePath, '.git'))
      result.hasGit = true
      warnings.push(warning('WORKSPACE_HAS_GIT', null, workspaceId, 'This directory contains a .git directory; uncommitted work will be lost.'))
    } catch {
      /* no .git — the common case */
    }

    // Read-only Git detail (dirty/unpushed counts) only when a plan asks for it: the inventory and
    // the admission re-check must stay cheap and side-effect free.
    if (options.probeGit === true && options.gitProbe !== undefined) {
      try {
        warnings.push(...(await gitWarnings(workspacePath, workspaceId, options.gitProbe)))
      } catch {
        /* the probe is advisory; never fail a plan because Git misbehaved */
      }
    }

    if (mode === 'trash') {
      const trashDevice = await nearestExistingDevice(config.trashRoot)
      if (trashDevice === null) {
        blockers.push(blocker('TRASH_UNAVAILABLE', null, workspaceId, 'The cleanup trash location cannot be inspected; the trash mode is unavailable.'))
      } else if (result.device !== null && trashDevice !== result.device) {
        blockers.push(
          blocker(
            'TRASH_CROSS_DEVICE',
            null,
            workspaceId,
            'The trash is on a different volume, so the directory cannot be moved atomically. Use permanent deletion (it requires typing the folder name) or configure trashRoot on the same volume.',
          ),
        )
      }
    }

    return result
  }

  /**
   * Stored sessions whose recorded cwd lies inside one workspace path, split by liveness.
   * @param {string} workspacePath - absolute canonical workspace path.
   * @param {object[]} storedSessions - persistence snapshots.
   * @returns {{ insideSessionIds: string[], liveSessionIds: string[] }}
   */
  function scanInsideSessions(workspacePath, storedSessions) {
    /** @type {Set<string>} */
    const ids = new Set()
    for (const snapshot of storedSessions) {
      const cwd = snapshot?.header?.cwd
      const sessionId = snapshot?.header?.id
      if (typeof cwd !== 'string' || typeof sessionId !== 'string') continue
      if (isInside(workspacePath, cwd)) ids.add(sessionId)
    }
    return splitByLiveness([...ids])
  }

  /**
   * Split session ids into inside/live sets.
   * @param {string[]} ids - session ids inside a workspace path.
   * @returns {{ insideSessionIds: string[], liveSessionIds: string[] }}
   */
  function splitByLiveness(ids) {
    /** @type {string[]} */
    const liveSessionIds = []
    for (const id of ids) {
      const { live, running } = livenessOf(id)
      if (live || running) liveSessionIds.push(id)
    }
    return { insideSessionIds: ids, liveSessionIds }
  }

  /**
   * One pass over the stored sessions that buckets each session under every registered workspace
   * path containing its cwd.
   *
   * The obvious implementation asks `isInside` for every workspace x session pair, which costs
   * ~0.8 s of pure path comparison at 200 workspaces x 5000 sessions and is recomputed on every
   * inventory refresh / read-only tool call. Walking one session's ancestors is O(path depth) and
   * yields the identical set because workspace paths are canonical and containment is transitive.
   * @param {string[]} workspacePaths - canonical workspace paths.
   * @param {object[]} storedSessions - persistence snapshots.
   * @returns {Map<string, string[]>} workspace path -> session ids inside it.
   */
  function buildInsideIndex(workspacePaths, storedSessions) {
    /** @type {Map<string, Set<string>>} */
    const buckets = new Map()
    /** @type {Map<string, string>} */
    const keyToPath = new Map()
    for (const workspacePath of workspacePaths) {
      if (typeof workspacePath !== 'string' || workspacePath === '') continue
      const key = path.resolve(workspacePath)
      buckets.set(key, new Set())
      keyToPath.set(key, workspacePath)
    }
    if (buckets.size === 0) return new Map()
    for (const snapshot of storedSessions) {
      const cwd = snapshot?.header?.cwd
      const sessionId = snapshot?.header?.id
      if (typeof cwd !== 'string' || cwd === '' || typeof sessionId !== 'string') continue
      let current = path.resolve(cwd)
      // Bounded: a path has finitely many ancestors; the guard only protects a pathological input.
      for (let depth = 0; depth < 256; depth += 1) {
        const bucket = buckets.get(current)
        if (bucket !== undefined) bucket.add(sessionId)
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
      }
    }
    const index = new Map()
    for (const [key, bucket] of buckets) index.set(keyToPath.get(key), [...bucket])
    return index
  }

  // #endregion

  // #region session resolution ----------------------------------------------------------------

  /**
   * Resolve one session id to its deletion identity (SPEC §5.1/§5.2).
   * @param {string} id - session id.
   * @param {object | undefined} [snapshotHint] - an already-loaded snapshot from `list()`.
   * @returns {Promise<{ ok: true, value: { id: string, snapshot: object, locationPath: string | null, dirPath: string | null } } | { ok: false, envelope: object }>}
   */
  async function resolveSession(id, snapshotHint) {
    const snapshot = snapshotHint ?? (await statStoredSession(id))
    if (snapshot === undefined || snapshot === null) {
      return { ok: false, envelope: fail('UNKNOWN_SESSION', `Unknown session "${id}".`) }
    }
    const locationPath = typeof snapshot.location?.path === 'string' ? snapshot.location.path : null
    let dirPath = null
    if (locationPath !== null) {
      const layout = sessionDirectoryFromLocation(locationPath)
      if (!layout.ok) {
        // Refuse to delete a directory we do not recognize as a stored-session directory. Never
        // guess, never fall back to "delete the file's parent anyway".
        return { ok: false, envelope: fail('IO_ERROR', layout.message) }
      }
      dirPath = layout.sessionDir
    }
    // A plan is a promise about a *directory*, not just about a persisted path string. Resolve
    // the directory now and record its canonical spelling; admission and the pre-mutation check
    // re-derive it, so swapping a parent directory for a symlink after review cannot redirect the
    // deletion to a different directory.
    let dirCanonical = null
    let dirMissing = false
    if (dirPath !== null) {
      const inspected = await inspectSessionDirectory(dirPath)
      if (inspected.state === 'unsafe') return { ok: false, envelope: fail('IO_ERROR', inspected.message) }
      if (inspected.state === 'ok') dirCanonical = inspected.canonical
      else dirMissing = true
    }
    return { ok: true, value: { id, snapshot, locationPath, dirPath, dirCanonical, dirMissing } }
  }

  /**
   * Read-only validation of one stored session's directory. Never follows a final symlink and
   * distinguishes "the directory is gone" from "the path is no longer the directory we planned".
   * @param {string} dirPath - absolute session directory.
   * @returns {Promise<{ state: 'ok', canonical: string } | { state: 'missing' } | { state: 'unsafe', message: string }>}
   */
  async function inspectSessionDirectory(dirPath) {
    let entry
    try {
      entry = await fs.lstat(dirPath)
    } catch (error) {
      if (isMissingError(error)) return { state: 'missing' }
      return { state: 'unsafe', message: `The session directory cannot be inspected: ${errorMessage(error)}` }
    }
    if (entry.isSymbolicLink()) {
      return { state: 'unsafe', message: 'The session directory is now a symbolic link; refusing to follow it.' }
    }
    if (!entry.isDirectory()) {
      return { state: 'unsafe', message: 'The session directory is no longer a directory.' }
    }
    let canonical
    try {
      canonical = await fs.realpath(dirPath)
    } catch (error) {
      return { state: 'unsafe', message: `The session directory cannot be resolved: ${errorMessage(error)}` }
    }
    return { state: 'ok', canonical }
  }

  /**
   * The human-facing label stored in trash metadata for a session entry.
   * @param {object} snapshot - persistence snapshot.
   * @param {string} id - session id.
   * @returns {string}
   */
  function sessionTrashTitle(snapshot, id) {
    const cwd = snapshot?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return lastSegment(cwd)
    return id
  }

  /**
   * Subagent-descendant closure. Only `origin === 'subagent'` sessions qualify, and the parent chain
   * must actually reach a root. Ordinary forks (seeded history without a parentSession, or a
   * parentSession pointing elsewhere) are independent sessions and are never swept in; the visited
   * set turns a malformed cycle into "not a descendant" instead of a hang.
   *
   * @param {object[]} storedSessions - every stored snapshot.
   * @param {Set<string>} roots - ids whose descendants are wanted.
   * @returns {Map<string, Set<string>>} root id → descendant ids.
   */
  function descendantClosure(storedSessions, roots) {
    /** @type {Map<string, object>} */
    const byId = new Map()
    for (const snapshot of storedSessions) {
      const id = snapshot?.header?.id
      if (typeof id === 'string') byId.set(id, snapshot)
    }
    /** @type {Map<string, Set<string>>} */
    const perRoot = new Map()
    for (const rootId of roots) perRoot.set(rootId, new Set())

    for (const snapshot of storedSessions) {
      const header = snapshot?.header
      if (!header || header.origin !== 'subagent') continue
      const childId = header.id
      if (typeof childId !== 'string' || roots.has(childId)) continue
      let cursor = header.parentSession
      const visited = new Set([childId])
      let depth = 0
      while (typeof cursor === 'string' && depth < MAX_DESCENDANT_CHAIN && !visited.has(cursor)) {
        if (roots.has(cursor)) {
          perRoot.get(cursor)?.add(childId)
          break
        }
        visited.add(cursor)
        const parent = byId.get(cursor)
        cursor = parent?.header?.parentSession
        depth += 1
      }
    }
    return perRoot
  }

  /**
   * Membership map session id → workspace id, from the durable registry (first registry occurrence
   * wins, which is the durable workspace order).
   * @returns {Map<string, string>}
   */
  function sessionWorkspaceMembership() {
    /** @type {Map<string, string>} */
    const membership = new Map()
    let entities
    try {
      entities = registry().list()
    } catch (error) {
      throw new DomainError('IO_ERROR', `Failed to list workspaces: ${errorMessage(error)}`)
    }
    for (const entity of Array.isArray(entities) ? entities : []) {
      const workspaceId = typeof entity?.id === 'string' ? entity.id : null
      const sessionIds = Array.isArray(entity?.sessionIds) ? entity.sessionIds : []
      if (workspaceId === null) continue
      for (const sessionId of sessionIds) {
        if (typeof sessionId === 'string' && !membership.has(sessionId)) membership.set(sessionId, workspaceId)
      }
    }
    return membership
  }

  // #endregion

  // #region cleanup wizard ---------------------------------------------------------------------

  /** Bounds for `POST /api/cleanup.candidates` (SPEC §4.9). */
  const CANDIDATE_FILTER_KEYS = Object.freeze(['olderThanDays', 'archived', 'minBytes', 'workspaceId', 'origin', 'requireDeletable'])
  const CANDIDATE_MAX_LIMIT = 500
  const CANDIDATE_SORTS = Object.freeze(['oldest', 'largest'])
  const CANDIDATE_ARCHIVED = Object.freeze(['all', 'only', 'exclude'])
  const CANDIDATE_ORIGINS = Object.freeze(['all', 'root', 'subagent'])

  /**
   * Read-only cleanup-wizard preview (`POST /api/cleanup.candidates`, SPEC §4.9).
   *
   * Projects the same single inventory snapshot the page uses, so it never walks the disk a second
   * time and never deletes; the client turns the chosen candidates into an ordinary plan.
   * @param {object} [request] - `{ filters?, sort?, limit? }`.
   * @returns {Promise<object>} envelope.
   */
  async function candidates(request) {
    const body = request === undefined || request === null ? {} : request
    if (!isPlainObject(body)) return fail('BAD_REQUEST', 'The request body must be a JSON object.')
    for (const key of Object.keys(body)) {
      if (key !== 'filters' && key !== 'sort' && key !== 'limit') {
        return fail('BAD_REQUEST', `Unknown request field "${key}".`, { field: key })
      }
    }
    const filters = body.filters === undefined ? {} : body.filters
    if (!isPlainObject(filters)) return fail('BAD_REQUEST', '"filters" must be a JSON object.')
    for (const key of Object.keys(filters)) {
      if (!CANDIDATE_FILTER_KEYS.includes(key)) {
        return fail('BAD_REQUEST', `Unknown filter "${key}".`, { field: `filters.${key}` })
      }
    }
    const olderThanDays = filters.olderThanDays === undefined ? 0 : filters.olderThanDays
    if (!Number.isInteger(olderThanDays) || olderThanDays < 0 || olderThanDays > 3650) {
      return fail('BAD_REQUEST', '"filters.olderThanDays" must be an integer between 0 and 3650.', { field: 'filters.olderThanDays' })
    }
    const archived = filters.archived === undefined ? 'all' : filters.archived
    if (!CANDIDATE_ARCHIVED.includes(archived)) {
      return fail('BAD_REQUEST', '"filters.archived" must be "all", "only" or "exclude".', { field: 'filters.archived' })
    }
    const minBytes = filters.minBytes === undefined ? 0 : filters.minBytes
    if (!Number.isInteger(minBytes) || minBytes < 0 || minBytes > Number.MAX_SAFE_INTEGER) {
      return fail('BAD_REQUEST', '"filters.minBytes" must be a non-negative integer.', { field: 'filters.minBytes' })
    }
    let workspaceId = null
    if (filters.workspaceId !== undefined && filters.workspaceId !== null) {
      if (typeof filters.workspaceId !== 'string' || filters.workspaceId === '') {
        return fail('BAD_REQUEST', '"filters.workspaceId" must be a non-empty string.', { field: 'filters.workspaceId' })
      }
      workspaceId = filters.workspaceId
    }
    const origin = filters.origin === undefined ? 'all' : filters.origin
    if (!CANDIDATE_ORIGINS.includes(origin)) {
      return fail('BAD_REQUEST', '"filters.origin" must be "all", "root" or "subagent".', { field: 'filters.origin' })
    }
    const requireDeletable = filters.requireDeletable === undefined ? false : filters.requireDeletable
    if (typeof requireDeletable !== 'boolean') {
      return fail('BAD_REQUEST', '"filters.requireDeletable" must be a boolean.', { field: 'filters.requireDeletable' })
    }
    const sort = body.sort === undefined ? 'oldest' : body.sort
    if (!CANDIDATE_SORTS.includes(sort)) {
      return fail('BAD_REQUEST', '"sort" must be "oldest" or "largest".', { field: 'sort' })
    }
    const limit = body.limit === undefined ? 100 : body.limit
    if (!Number.isInteger(limit) || limit < 1 || limit > CANDIDATE_MAX_LIMIT) {
      return fail('BAD_REQUEST', `"limit" must be an integer between 1 and ${CANDIDATE_MAX_LIMIT}.`, { field: 'limit' })
    }

    const overview = await inventory()
    if (overview.ok !== true) return overview
    const reference = now() - olderThanDays * 86_400_000
    const matched = overview.sessions.filter((session) => {
      if (olderThanDays > 0) {
        // Age is measured from creation; an unknown creation time (0) never matches an age filter.
        if (!(typeof session.createdAt === 'number') || session.createdAt <= 0 || session.createdAt > reference) return false
      }
      if (archived === 'only' && session.archived !== true) return false
      if (archived === 'exclude' && session.archived === true) return false
      if (minBytes > 0) {
        if (typeof session.sizeBytes !== 'number' || session.sizeBytes < minBytes) return false
      }
      if (workspaceId !== null && session.workspaceId !== workspaceId) return false
      if (origin === 'root' && session.origin === 'subagent') return false
      if (origin === 'subagent' && session.origin !== 'subagent') return false
      if (requireDeletable && session.deletable !== true) return false
      return true
    })
    const total = matched.length
    let knownBytes = 0
    for (const session of matched) {
      if (typeof session.sizeBytes === 'number' && Number.isFinite(session.sizeBytes)) knownBytes += session.sizeBytes
    }
    const ordered = matched.slice()
    if (sort === 'largest') {
      ordered.sort((left, right) => {
        const leftBytes = typeof left.sizeBytes === 'number' ? left.sizeBytes : -1
        const rightBytes = typeof right.sizeBytes === 'number' ? right.sizeBytes : -1
        if (rightBytes !== leftBytes) return rightBytes - leftBytes
        return left.id.localeCompare(right.id)
      })
    } else {
      ordered.sort((left, right) => {
        const leftKnown = typeof left.createdAt === 'number' && left.createdAt > 0
        const rightKnown = typeof right.createdAt === 'number' && right.createdAt > 0
        // Unknown creation times are never presented as the "oldest" candidates.
        if (leftKnown !== rightKnown) return leftKnown ? -1 : 1
        if (leftKnown && rightKnown && right.createdAt !== left.createdAt) return left.createdAt - right.createdAt
        return left.id.localeCompare(right.id)
      })
    }
    const candidates = ordered.slice(0, limit).map((session) => ({
      id: session.id,
      workspaceId: session.workspaceId ?? null,
      cwd: session.cwd ?? null,
      createdAt: session.createdAt ?? 0,
      sizeBytes: session.sizeBytes ?? null,
      origin: session.origin ?? null,
      live: session.live === true,
      running: session.running === true,
      archived: session.archived === true,
      pinned: session.pinned === true,
      deletable: session.deletable === true,
      blockerCodes: Array.isArray(session.blockerCodes) ? session.blockerCodes.slice() : [],
    }))
    return ok({
      candidates,
      total,
      truncated: total > candidates.length,
      totals: { count: total, bytes: knownBytes },
      filters: { olderThanDays, archived, minBytes, workspaceId, origin, requireDeletable },
      sort,
    })
  }

  // #endregion

  // #region inventory -------------------------------------------------------------------------

  /**
   * `POST /api/cleanup.inventory` payload (SPEC §4.1): a cheap, read-only overview. This does not
   * walk target sizes — that is `measure` — and every field is pure JSON.
   * @returns {Promise<object>} envelope.
   */
  async function inventory() {
    const generatedAt = now()
    let entities
    let storedSessions
    try {
      entities = registry().list()
      if (!Array.isArray(entities)) entities = []
    } catch (error) {
      return fail('IO_ERROR', `Failed to list workspaces: ${errorMessage(error)}`)
    }
    try {
      storedSessions = await listStoredSessions()
    } catch (error) {
      if (error instanceof DomainError) return fail(error.code, error.message)
      throw error
    }
    let archivedIds = []
    let pinnedIds = []
    try {
      archivedIds = Array.isArray(registry().archivedSessionIds) ? registry().archivedSessionIds : []
    } catch {
      /* older registry surface: degrade to "no archive information" */
    }
    try {
      pinnedIds = Array.isArray(registry().pinnedSessionIds) ? registry().pinnedSessionIds : []
    } catch {
      /* older registry surface: degrade to "no pin information" */
    }
    const archivedSet = new Set(archivedIds.filter((id) => typeof id === 'string'))
    const pinnedSet = new Set(pinnedIds.filter((id) => typeof id === 'string'))
    let membership
    try {
      membership = sessionWorkspaceMembership()
    } catch (error) {
      if (error instanceof DomainError) return fail(error.code, error.message)
      return fail('IO_ERROR', `Failed to list workspaces: ${errorMessage(error)}`)
    }
    const trash = await trashSummary()

    // One bucketing pass serves every workspace row instead of W x S containment checks.
    const insideIndex = buildInsideIndex(
      entities.map((entity) => (typeof entity?.path === 'string' ? entity.path : null)).filter((value) => value !== null),
      storedSessions,
    )
    /** @type {object[]} */
    const workspaces = []
    for (const entity of entities) {
      try {
        const workspacePath = typeof entity?.path === 'string' ? entity.path : null
        const inspected = await inspectWorkspace(entity, {
          storedSessions,
          insideSessionIds: workspacePath !== null ? insideIndex.get(workspacePath) : undefined,
        })
        const blockerCodes = inspected.blockers.map((entry) => entry.code)
        workspaces.push({
          id: typeof entity.id === 'string' ? entity.id : String(entity.id ?? ''),
          path: inspected.path,
          title: typeof entity.title === 'string' ? entity.title : lastSegment(inspected.path),
          state: inspected.state,
          stateCode: inspected.stateCode,
          sessionCount: Array.isArray(entity.sessionIds) ? entity.sessionIds.length : 0,
          sessionsInside: inspected.insideSessionIds.length,
          hasGit: inspected.hasGit,
          liveSessions: inspected.liveSessionIds,
          deletable: blockerCodes.length === 0,
          blockerCodes,
        })
      } catch (error) {
        // One broken workspace row must not blank the whole page.
        workspaces.push({
          id: typeof entity.id === 'string' ? entity.id : String(entity.id ?? ''),
          path: typeof entity.path === 'string' ? entity.path : '',
          title: typeof entity.title === 'string' ? entity.title : '',
          state: 'unsafe',
          stateCode: 'IO_ERROR',
          sessionCount: Array.isArray(entity.sessionIds) ? entity.sessionIds.length : 0,
          sessionsInside: 0,
          hasGit: false,
          liveSessions: [],
          deletable: false,
          blockerCodes: ['IO_ERROR'],
        })
      }
    }

    /** @type {object[]} */
    const sessions = []
    for (const snapshot of storedSessions.slice(0, SESSION_LIST_CAP)) {
      sessions.push(summarizeSession(snapshot, membership, archivedSet, pinnedSet))
    }

    let deferred = { count: 0, retained: 0, lastRun: null }
    try {
      const state = await deferredState()
      deferred = { count: state.count, retained: state.retainedCount, lastRun: state.lastRun }
    } catch {
      /* an unreadable queue only means "nothing is scheduled" for the overview */
    }
    let auditView = { enabled: config.auditEnabled, lastStartup: null, recent: [] }
    try {
      const log = await auditLog()
      const recent = await log.recentRecords(10)
      auditView = {
        enabled: log.enabled(),
        lastStartup: await log.lastStartup(),
        recent: recent.map((record) => ({
          at: typeof record.at === 'number' ? record.at : 0,
          source: record.source === 'startup' ? 'startup' : 'immediate',
          action: typeof record.action === 'string' ? record.action : 'unknown',
          mode: record.mode === 'permanent' ? 'permanent' : (record.mode === 'trash' ? 'trash' : null),
          targets: Array.isArray(record.targets) ? record.targets.map((target) => ({ kind: String(target.kind), id: String(target.id) })) : [],
          status: typeof record.status === 'string' ? record.status : 'unknown',
          code: typeof record.code === 'string' ? record.code : null,
          bytes: typeof record.bytes === 'number' ? record.bytes : 0,
        })),
      }
    } catch {
      /* auditing is diagnostic: an unreadable log must not break the overview */
    }
    return ok({
      generatedAt,
      dshHome: dshHome(),
      trash: {
        root: trash.root,
        entries: trash.entries,
        bytes: trash.bytes,
        oldestMovedAt: trash.oldestMovedAt,
        overRetention: trash.overRetention,
        overCapacity: trash.overCapacity,
        suggestedEntryIds: trash.suggestedEntryIds,
      },
      deferred,
      audit: auditView,
      workspaces,
      sessions,
      truncated: storedSessions.length > SESSION_LIST_CAP,
      sessionListCap: SESSION_LIST_CAP,
    })
  }

  /**
   * Project one persistence snapshot onto the inventory session row.
   * @param {object} snapshot - persistence snapshot.
   * @param {Map<string, string>} membership - session → workspace id.
   * @param {Set<string>} archivedSet - archived session ids.
   * @param {Set<string>} pinnedSet - pinned session ids.
   * @returns {object}
   */
  function summarizeSession(snapshot, membership, archivedSet, pinnedSet) {
    const header = isPlainObject(snapshot?.header) ? snapshot.header : {}
    const id = typeof header.id === 'string' ? header.id : ''
    const { live, running } = livenessOf(id)
    /** @type {object[]} */
    const blockers = []
    const liveBlocker = sessionBlockerFor(id)
    if (liveBlocker !== null) blockers.push(liveBlocker)
    const locationPath = typeof snapshot?.location?.path === 'string' ? snapshot.location.path : null
    if (locationPath !== null && !sessionDirectoryFromLocation(locationPath).ok) {
      blockers.push(
        blocker(
          'SESSION_NOT_DELETABLE',
          id,
          null,
          'The stored log is not in a recognizable session directory, so this plugin will not delete it.',
        ),
      )
    }
    return {
      id,
      workspaceId: membership.get(id) ?? null,
      cwd: typeof header.cwd === 'string' ? header.cwd : null,
      createdAt: epochMs(header.createdAt) ?? 0,
      eventCount: typeof snapshot?.eventCount === 'number' ? snapshot.eventCount : null,
      sizeBytes: typeof snapshot?.sizeBytes === 'number' ? snapshot.sizeBytes : null,
      origin: typeof header.origin === 'string' ? header.origin : null,
      parentSessionId: typeof header.parentSession === 'string' ? header.parentSession : null,
      live,
      running,
      archived: archivedSet.has(id),
      pinned: pinnedSet.has(id),
      deletable: blockers.length === 0,
      blockerCodes: blockers.map((entry) => entry.code),
    }
  }

  /**
   * Trash totals for the inventory header.
   * @returns {Promise<{ root: string, entries: number, bytes: number }>}
   */
  async function trashSummary() {
    const summary = {
      root: config.trashRoot,
      entries: 0,
      bytes: 0,
      oldestMovedAt: null,
      overRetention: false,
      overCapacity: false,
      suggestedEntryIds: [],
    }
    let listed
    try {
      listed = await listTrashDirectories()
    } catch {
      return summary
    }
    summary.entries = listed.entryDirs.length
    /** @type {Array<{ id: string, movedAt: number, bytes: number }>} */
    const sized = []
    for (let index = 0; index < listed.entryDirs.length; index += 1) {
      const meta = await readTrashMeta(listed.entryDirs[index])
      const bytes = meta !== null && typeof meta.bytes === 'number' && Number.isFinite(meta.bytes) ? meta.bytes : 0
      const movedAt = meta !== null && typeof meta.movedAt === 'number' && Number.isFinite(meta.movedAt)
        ? meta.movedAt
        : Math.floor(Number((await lstatOrNull(listed.entryDirs[index]))?.mtimeMs) || 0)
      summary.bytes += bytes
      sized.push({ id: listed.names[index], movedAt, bytes })
    }
    if (sized.length > 0) {
      sized.sort((left, right) => left.movedAt - right.movedAt)
      summary.oldestMovedAt = sized[0].movedAt
      if (config.trashRetentionDays > 0) {
        summary.overRetention = sized[0].movedAt > 0 && now() - sized[0].movedAt > config.trashRetentionDays * 86_400_000
      }
      if (config.trashMaxBytes > 0 && summary.bytes > config.trashMaxBytes) {
        summary.overCapacity = true
        // Oldest-first list whose purge would bring the trash under the configured cap (bounded).
        let remaining = summary.bytes
        for (const entry of sized) {
          if (remaining <= config.trashMaxBytes || summary.suggestedEntryIds.length >= 50) break
          summary.suggestedEntryIds.push(entry.id)
          remaining -= entry.bytes
        }
      }
    }
    return summary
  }

  // #endregion

  // #region measure ---------------------------------------------------------------------------

  /** Folder-size previews are advisory: cached briefly so re-planning does not re-walk the tree. */
  const PREVIEW_CACHE_TTL_MS = 30_000
  const PREVIEW_CACHE_MAX = 64
  /** @type {Map<string, { at: number, device: number | null, inode: number | null, stats: object }>} */
  const previewCache = new Map()

  /** @returns {void} */
  function clearPreviewCache() {
    previewCache.clear()
  }

  /**
   * Walk one workspace directory with a short-lived cache (SPEC §5.10). The cache key includes the
   * directory's device/inode, so a replaced folder is never answered from a stale walk; any mutation
   * clears the cache, and the deletion path never trusts a cached size.
   * @param {string} directoryPath - workspace path.
   * @returns {Promise<object>} `walkTree` stats.
   */
  async function previewWorkspaceStats(directoryPath) {
    let key = directoryPath
    let device = null
    let inode = null
    try {
      const canonical = await canonicalizeDirectory(directoryPath)
      if (canonical.ok) {
        key = canonical.path
        const stat = await fs.lstat(canonical.path)
        if (typeof stat.dev === 'number') device = stat.dev
        if (typeof stat.ino === 'number') inode = stat.ino
      }
    } catch {
      /* fall back to an uncached walk for a path that vanished mid-preview */
    }
    const cached = previewCache.get(key)
    if (cached !== undefined && cached.device === device && cached.inode === inode && now() - cached.at < PREVIEW_CACHE_TTL_MS) {
      return cached.stats
    }
    const stats = await walkTree(directoryPath)
    previewCache.set(key, { at: now(), device, inode, stats })
    if (previewCache.size > PREVIEW_CACHE_MAX) {
      const oldest = previewCache.keys().next().value
      if (oldest !== undefined) previewCache.delete(oldest)
    }
    return stats
  }

  /**
   * `POST /api/cleanup.measure` payload (SPEC §4.2). Unknown ids are simply absent; walks are bounded
   * per directory and never follow symlinks.
   * @param {object} request - `{ workspaceIds?, sessionIds? }`.
   * @returns {Promise<object>} envelope.
   */
  async function measure(request) {
    const validation = validateIdListRequest(request)
    if (!validation.ok) return validation.envelope
    const { workspaceIds, sessionIds } = validation.value
    /** @type {Record<string, object>} */
    const workspaces = {}
    /** @type {Record<string, object>} */
    const sessions = {}
    try {
      for (const id of workspaceIds) {
        const entity = registry().get(id)
        if (!entity || typeof entity.path !== 'string') continue
        const stats = await previewWorkspaceStats(entity.path)
        workspaces[id] = stats.missing
          ? { bytes: 0, files: 0, dirs: 0, truncated: false, missing: true }
          : {
            bytes: stats.bytes,
            files: stats.files,
            dirs: stats.dirs,
            newestMtime: stats.newestMtime,
            truncated: stats.truncated,
          }
      }
      // Locate every requested session from ONE persistence listing. The JSONL backend's
      // `stat(id)` scans all project directories, so a per-id loop costs seconds on a large history.
      let sessionById = null
      if (sessionIds.length > 0) {
        sessionById = new Map()
        for (const snapshot of await listStoredSessions()) {
          const snapshotId = snapshot?.header?.id
          if (typeof snapshotId === 'string') sessionById.set(snapshotId, snapshot)
        }
      }
      for (const id of sessionIds) {
        const snapshot = sessionById?.get(id)
        if (snapshot === undefined || snapshot === null) continue
        const locationPath = typeof snapshot.location?.path === 'string' ? snapshot.location.path : null
        if (locationPath === null) {
          sessions[id] = { bytes: 0, files: 0 }
          continue
        }
        const stats = await walkTree(path.dirname(locationPath))
        sessions[id] = { bytes: stats.bytes, files: stats.files }
      }
    } catch (error) {
      if (error instanceof DomainError) return fail(error.code, error.message)
      throw error
    }
    return ok({ workspaces, sessions })
  }

  /**
   * Validate the shared optional-id-list request used by `measure`.
   * @param {object} request - request body.
   * @returns {{ ok: true, value: { workspaceIds: string[], sessionIds: string[] } } | { ok: false, envelope: object }}
   */
  function validateIdListRequest(request) {
    if (!isPlainObject(request)) return { ok: false, envelope: fail('BAD_REQUEST', 'The request body must be a JSON object.') }
    const workspaceIds = request.workspaceIds
    const sessionIds = request.sessionIds
    if (workspaceIds !== undefined && !isStringArray(workspaceIds)) {
      return { ok: false, envelope: fail('BAD_REQUEST', '"workspaceIds" must be an array of strings.') }
    }
    if (sessionIds !== undefined && !isStringArray(sessionIds)) {
      return { ok: false, envelope: fail('BAD_REQUEST', '"sessionIds" must be an array of strings.') }
    }
    return {
      ok: true,
      value: {
        workspaceIds: dedupeStrings(workspaceIds ?? []),
        sessionIds: dedupeStrings(sessionIds ?? []),
      },
    }
  }

  // #endregion

  // #region plan ------------------------------------------------------------------------------

  /**
   * `POST /api/cleanup.plan` (SPEC §4.3 + §5). Resolution failures are `ok: false` domain failures;
   * everything resolvable produces a plan whose `blockers` gate execution.
   * @param {object} request - plan request.
   * @returns {Promise<object>} envelope.
   */
  async function plan(request, options = {}) {
    if (options.signal?.aborted === true) return fail('CANCELLED', 'The plan request was cancelled before it started.')
    const validation = validatePlanRequest(request)
    if (!validation.ok) return validation.envelope
    const { targets, mode, includeSessions, includeDescendants } = validation.value
    if (mode === 'permanent' && config.allowPermanentDeletion === false) {
      return fail('PERMANENT_DISABLED', 'Permanent deletion is disabled by configuration; only the trash mode is available.')
    }
    try {
      return await buildPlan({ targets, mode, includeSessions, includeDescendants }, options)
    } catch (error) {
      if (error instanceof DomainError) return fail(error.code, error.message, error.details)
      throw error
    }
  }

  /**
   * Validate and normalize a plan request body.
   * @param {object} request - request body.
   * @returns {{ ok: true, value: { targets: { kind: 'workspace' | 'session', id: string }[], mode: 'trash' | 'permanent', includeSessions: boolean, includeDescendants: boolean } } | { ok: false, envelope: object }}
   */
  function validatePlanRequest(request) {
    if (!isPlainObject(request)) return { ok: false, envelope: fail('BAD_REQUEST', 'The request body must be a JSON object.') }
    if (!Array.isArray(request.targets) || request.targets.length === 0) {
      return { ok: false, envelope: fail('BAD_REQUEST', '"targets" must be a non-empty array.') }
    }
    if (request.targets.length > MAX_PLAN_TARGETS) {
      return { ok: false, envelope: fail('BAD_REQUEST', `"targets" accepts at most ${MAX_PLAN_TARGETS} entries.`) }
    }
    /** @type {{ kind: 'workspace' | 'session', id: string }[]} */
    const targets = []
    for (const raw of request.targets) {
      if (!isPlainObject(raw)) return { ok: false, envelope: fail('BAD_REQUEST', 'Each target must be an object.') }
      if (raw.kind !== 'workspace' && raw.kind !== 'session') {
        return { ok: false, envelope: fail('BAD_REQUEST', 'Each target kind must be "workspace" or "session".') }
      }
      if (typeof raw.id !== 'string' || raw.id.trim() === '') {
        return { ok: false, envelope: fail('BAD_REQUEST', 'Each target needs a non-empty string id.') }
      }
      targets.push({ kind: raw.kind, id: raw.id })
    }
    let mode = 'trash'
    if (request.mode !== undefined) {
      if (request.mode !== 'trash' && request.mode !== 'permanent') {
        return { ok: false, envelope: fail('BAD_REQUEST', '"mode" must be "trash" or "permanent".') }
      }
      mode = request.mode
    }
    let includeSessions = true
    if (request.includeSessions !== undefined) {
      if (typeof request.includeSessions !== 'boolean') {
        return { ok: false, envelope: fail('BAD_REQUEST', '"includeSessions" must be a boolean.') }
      }
      includeSessions = request.includeSessions
    }
    let includeDescendants = true
    if (request.includeDescendants !== undefined) {
      if (typeof request.includeDescendants !== 'boolean') {
        return { ok: false, envelope: fail('BAD_REQUEST', '"includeDescendants" must be a boolean.') }
      }
      includeDescendants = request.includeDescendants
    }
    return { ok: true, value: { targets, mode, includeSessions, includeDescendants } }
  }

  /**
   * Resolve the plan's deletion set and decide every block/warning (SPEC §5.1-§5.4).
   * @param {{ targets: { kind: string, id: string }[], mode: 'trash' | 'permanent', includeSessions: boolean, includeDescendants: boolean }} input
   * @returns {Promise<object>} envelope.
   */
  async function buildPlan(input, options = {}) {
    const { targets, mode, includeSessions, includeDescendants } = input
    // `retain: false` is a validation-only build (used when queueing a permanent deletion so its
    // typed name can be checked): it must not insert a plan record, and must not prune — pruning with
    // a full plan table would evict the plan the user is actually reviewing.
    const retain = options.retain !== false

    /** @type {Map<string, object>} */
    const workspaceEntities = new Map()
    /** @type {Map<string, object>} */
    const sessionTargets = new Map()
    /** @type {object[]} */
    const requestedTargets = []

    for (const target of targets) {
      if (target.kind === 'workspace') {
        const entity = registry().get(target.id)
        if (entity === undefined || entity === null) return fail('UNKNOWN_WORKSPACE', `Unknown workspace "${target.id}".`)
        if (!workspaceEntities.has(target.id)) {
          workspaceEntities.set(target.id, entity)
          requestedTargets.push({ kind: 'workspace', id: target.id, title: typeof entity.title === 'string' ? entity.title : lastSegment(String(entity.path ?? '')), path: typeof entity.path === 'string' ? entity.path : null })
        }
      } else {
        if (sessionTargets.has(target.id)) continue
        const resolved = await resolveSession(target.id)
        if (!resolved.ok) return resolved.envelope
        sessionTargets.set(target.id, { ...resolved.value, isDescendant: false })
        requestedTargets.push({ kind: 'session', id: target.id, title: null, path: resolved.value.dirPath })
      }
    }

    const needsStoredList = workspaceEntities.size > 0 || (includeDescendants && sessionTargets.size > 0)
    /** @type {object[]} */
    const storedSessions = needsStoredList ? await listStoredSessions() : []
    const membership = sessionWorkspaceMembership()

    // Inspect the workspace directories first. A missing directory takes the registration-only
    // path (SPEC §5.3), so it must NOT sweep stored sessions whose recorded cwd merely spells that
    // path — the plan's warning and its item list used to disagree about that.
    // One bucketing pass for every targeted workspace.
    const planInsideIndex = buildInsideIndex(
      [...workspaceEntities.values()].map((entity) => (typeof entity?.path === 'string' ? entity.path : null)).filter((value) => value !== null),
      storedSessions,
    )
    /** @type {Map<string, object>} */
    const workspaceInspections = new Map()
    // One read-only Git probe budget/cache per plan (nested workspaces share a repository).
    const gitProbe = { deadline: now() + GIT_PLAN_BUDGET_MS, cache: new Map(), now }
    for (const [workspaceId, entity] of workspaceEntities) {
      const workspacePath = typeof entity?.path === 'string' ? entity.path : null
      workspaceInspections.set(
        workspaceId,
        await inspectWorkspace(entity, {
          mode,
          storedSessions,
          insideSessionIds: workspacePath !== null ? planInsideIndex.get(workspacePath) : undefined,
          probeGit: true,
          gitProbe,
        }),
      )
    }

    // Sessions pulled in by workspace targets (header.cwd inside an EXISTING workspace path).
    /** @type {Map<string, Set<string>>} */
    const workspaceInside = new Map()
    for (const [workspaceId, entity] of workspaceEntities) {
      const workspacePath = typeof entity.path === 'string' ? entity.path : null
      const inspection = workspaceInspections.get(workspaceId)
      const inside = new Set()
      if (workspacePath !== null && inspection.missing !== true) {
        for (const snapshot of storedSessions) {
          const cwd = snapshot?.header?.cwd
          const sessionId = snapshot?.header?.id
          if (typeof cwd !== 'string' || typeof sessionId !== 'string') continue
          if (isInside(workspacePath, cwd)) inside.add(sessionId)
        }
      }
      workspaceInside.set(workspaceId, inside)
    }

    // Descendant roots: explicitly targeted sessions only when `includeDescendants` is on, and the
    // sessions pulled in by `includeSessions` (their subagent children are part of the folder's
    // stored history and always included with it).
    /** @type {object[]} */
    const items = []
    /** @type {object[]} */
    const warnings = []
    /** @type {object[]} */
    const blockers = []

    // Deleting one registered workspace also deletes any other registered workspace nested
    // inside it. Warn always; refuse in permanent mode, where the collateral directory cannot be
    // recovered from the trash.
    let registeredWorkspaces = []
    try {
      registeredWorkspaces = registry().list().map((entity) => ({
        id: typeof entity?.id === 'string' ? entity.id : null,
        title: typeof entity?.title === 'string' ? entity.title : '',
        path: typeof entity?.path === 'string' ? entity.path : null,
      })).filter((entity) => entity.id !== null && entity.path !== null && entity.path !== '')
    } catch {
      registeredWorkspaces = []
    }
    for (const outer of requestedTargets) {
      if (outer.kind !== 'workspace' || typeof outer.path !== 'string' || outer.path === '') continue
      for (const inner of registeredWorkspaces) {
        if (inner.id === outer.id || !isInside(outer.path, inner.path)) continue
        warnings.push(
          warning(
            'WORKSPACE_CONTAINS_WORKSPACE',
            null,
            outer.id,
            `The reviewed workspace "${outer.title}" contains the separately registered workspace "${inner.title}" (${inner.path}); deleting it removes that directory too.`,
          ),
        )
        if (mode === 'permanent') {
          blockers.push(
            blocker(
              'WORKSPACE_CONTAINS_WORKSPACE',
              null,
              outer.id,
              `Permanent deletion would remove the separately registered workspace "${inner.title}" inside this directory. Delete that workspace first, or use the trash mode.`,
            ),
          )
        }
      }
    }

    const roots = new Set()
    if (includeDescendants) for (const id of sessionTargets.keys()) roots.add(id)
    if (includeSessions) for (const inside of workspaceInside.values()) for (const id of inside) roots.add(id)
    const perRootDescendants = roots.size > 0 ? descendantClosure(storedSessions, roots) : new Map()
    // Bound the work before the per-session resolve/scan loop below. The later, authoritative check
    // counts the items that actually made it into the plan; this one stops a huge sweep from doing
    // thousands of file-system reads only to be refused afterwards.
    const candidateSessionIds = new Set(sessionTargets.keys())
    if (includeSessions) for (const inside of workspaceInside.values()) for (const id of inside) candidateSessionIds.add(id)
    for (const descendantIds of perRootDescendants.values()) for (const id of descendantIds) candidateSessionIds.add(id)
    if (candidateSessionIds.size > MAX_PLAN_SESSION_ITEMS) {
      return sessionLimitFailure(candidateSessionIds.size)
    }
    /** @type {Map<string, { snapshot: object, locationPath: string | null, dirPath: string | null, isDescendant: boolean }>} */
    const sessionItemsById = new Map()

    // Explicit targets keep their freshly stat'ed snapshot.
    for (const [id, resolved] of sessionTargets) {
      sessionItemsById.set(id, {
        snapshot: resolved.snapshot,
        locationPath: resolved.locationPath,
        dirPath: resolved.dirPath,
        dirCanonical: resolved.dirCanonical,
        dirMissing: resolved.dirMissing,
        isDescendant: false,
      })
    }
    if (needsStoredList) {
      /** @type {Map<string, object>} */
      const storedById = new Map()
      for (const snapshot of storedSessions) {
        const id = snapshot?.header?.id
        if (typeof id === 'string') storedById.set(id, snapshot)
      }
      // Sessions reached through the workspace's `cwd` predicate are directly included; only the
      // subagent closure marks `isDescendant` (SPEC §4.3 item field).
      const insideIncluded = new Set()
      if (includeSessions) for (const inside of workspaceInside.values()) for (const id of inside) insideIncluded.add(id)
      const included = new Set(insideIncluded)
      for (const descendantIds of perRootDescendants.values()) for (const id of descendantIds) included.add(id)
      for (const id of included) {
        if (sessionItemsById.has(id)) continue
        const snapshot = storedById.get(id)
        if (snapshot === undefined) continue
        const resolved = await resolveSession(id, snapshot)
        if (!resolved.ok) {
          // An indirectly swept session (cwd predicate or subagent closure) with an
          // unrecognizable stored layout must not abort the whole workspace plan. Skip it and say so;
          // an explicitly targeted session still fails the plan.
          warnings.push(
            warning(
              'SESSION_NOT_DELETABLE',
              id,
              null,
              'This session log is not in a recognizable stored layout, so it is left untouched and skipped; its workspace record may keep the id.',
            ),
          )
          continue
        }
        sessionItemsById.set(id, {
          snapshot: resolved.value.snapshot,
          locationPath: resolved.value.locationPath,
          dirPath: resolved.value.dirPath,
          dirCanonical: resolved.value.dirCanonical,
          dirMissing: resolved.value.dirMissing,
          isDescendant: !insideIncluded.has(id),
        })
      }
    }


    // Workspace items first (they are what the user selected), then session items oldest-first.
    /** @type {{ kind: 'workspace-dir', id: string, title: string, path: string, bytes: number, files: number, dirs: number, truncated: boolean, missing: boolean, entity: object }[]} */
    const workspaceItems = []
    for (const [workspaceId, entity] of workspaceEntities) {
      const workspacePath = typeof entity.path === 'string' ? entity.path : ''
      const title = typeof entity.title === 'string' ? entity.title : lastSegment(workspacePath)
      const inspected = workspaceInspections.get(workspaceId) ?? (await inspectWorkspace(entity, { mode, storedSessions }))
      blockers.push(...inspected.blockers)
      warnings.push(...inspected.warnings)
      const stats = inspected.missing ? { bytes: 0, files: 0, dirs: 0, newestMtime: 0, truncated: false, missing: true } : await walkTree(workspacePath)
      if (stats.truncated) {
        warnings.push(warning('SCAN_TRUNCATED', null, workspaceId, 'The directory scan hit its budget; the reported size is a lower bound.'))
      }
      if (stats.bytes > LARGE_TARGET_BYTES) {
        warnings.push(warning('LARGE_TARGET', null, workspaceId, 'This workspace directory is larger than 1 GiB.'))
      }
      // Sessions that reference this folder but will survive the deletion end up ungrouped once the
      // registration is deleted; that is worth telling the user before they lose the grouping.
      const survivingInside = inspected.missing === true ? [] : [...inspected.insideSessionIds].filter((id) => !sessionItemsById.has(id))
      if (survivingInside.length > 0) {
        warnings.push(
          warning(
            'SESSIONS_FROM_DIR',
            null,
            workspaceId,
            `${survivingInside.length} stored session(s) reference this directory but their logs live elsewhere; deleting the folder leaves them ungrouped.`,
          ),
        )
      }
      workspaceItems.push({ kind: 'workspace-dir', id: workspaceId, title, path: workspacePath, bytes: stats.bytes, files: stats.files, dirs: stats.dirs, truncated: stats.truncated, missing: inspected.missing, entity })
    }
    // SPEC §4.3: one typed folder name must never authorize deleting several folders, so a permanent
    // plan may name at most one directory that still exists. Batch deletion belongs to the trash mode.
    if (mode === 'permanent') {
      const existingDirs = workspaceItems.filter((item) => !item.missing)
      if (existingDirs.length > 1) {
        return fail(
          'PERMANENT_MULTIPLE_DIRECTORIES',
          'Permanent deletion accepts one workspace directory per plan; delete them one at a time, or use the trash mode for a batch.',
          { workspaceIds: existingDirs.map((item) => item.id) },
        )
      }
    }
    for (const item of workspaceItems) {
      items.push({ kind: 'workspace-dir', id: item.id, title: item.title, path: item.path, bytes: item.bytes, files: item.files, dirs: item.dirs, truncated: item.truncated })
    }

    /** @type {{ kind: 'session', id: string, workspaceId: string | null, path: string | null, bytes: number, files: number, dirs: number, parentSessionId: string | null, isDescendant: boolean, locationPath: string | null, trashTitle: string, snapshot: object }[]} */
    const sessionItems = []
    const sortedSessionIds = [...sessionItemsById.entries()]
      .sort((left, right) => {
        const leftCreated = epochMs(left[1].snapshot?.header?.createdAt) ?? 0
        const rightCreated = epochMs(right[1].snapshot?.header?.createdAt) ?? 0
        if (leftCreated !== rightCreated) return leftCreated - rightCreated
        return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0
      })
    // Bound one reviewed operation. A workspace with thousands of sessions is deleted in batches:
    // the user clears sessions from the Sessions tab first, then removes the directory without
    // sweeping sessions. This keeps a single execute call's duration and risk bounded.
    if (sortedSessionIds.length > MAX_PLAN_SESSION_ITEMS) {
      return sessionLimitFailure(sortedSessionIds.length)
    }
    for (const [sessionId, entry] of sortedSessionIds) {
      const header = isPlainObject(entry.snapshot?.header) ? entry.snapshot.header : {}
      const liveBlocker = sessionBlockerFor(sessionId)
      if (liveBlocker !== null) blockers.push(liveBlocker)
      // Cross-process liveness for explicitly reviewed sessions: another Host sharing `$DSH_HOME`
      // can hold the persistence write claim even though this process' `sessions`/`agents` services
      // cannot see it. Swept-in sessions are probed one by one immediately before their mutation
      // instead; probing thousands during planning would be O(sessions x project dirs).
      if (
        liveBlocker === null &&
        options.probeSessionWritability !== false &&
        sessionTargets.has(sessionId) &&
        entry.dirPath !== null &&
        entry.dirMissing !== true
      ) {
        const writability = await probeSessionWritability([sessionId])
        if (writability !== null) blockers.push(blocker(writability.code, sessionId, null, writability.message))
      }
      const stats = entry.dirPath === null
        ? { bytes: 0, files: 0, dirs: 0, newestMtime: 0, truncated: false, missing: false }
        : await walkTree(entry.dirPath)
      if (stats.truncated) {
        warnings.push(warning('SCAN_TRUNCATED', sessionId, null, 'The session directory scan hit its budget; the reported size is a lower bound.'))
      }
      if (stats.bytes > LARGE_TARGET_BYTES) {
        warnings.push(warning('LARGE_TARGET', sessionId, null, 'This session log is larger than 1 GiB.'))
      }
      sessionItems.push({
        kind: 'session',
        id: sessionId,
        workspaceId: membership.get(sessionId) ?? null,
        path: entry.dirPath,
        bytes: stats.bytes,
        files: stats.files,
        dirs: stats.dirs,
        parentSessionId: typeof header.parentSession === 'string' ? header.parentSession : null,
        isDescendant: entry.isDescendant,
        locationPath: entry.locationPath,
        dirCanonical: entry.dirCanonical,
        dirMissing: entry.dirMissing === true,
        trashTitle: sessionTrashTitle(entry.snapshot, sessionId),
        snapshot: entry.snapshot,
      })
    }
    for (const item of sessionItems) {
      items.push({
        kind: 'session',
        id: item.id,
        workspaceId: item.workspaceId,
        title: null,
        path: item.path,
        bytes: item.bytes,
        files: item.files,
        parentSessionId: item.parentSessionId,
        isDescendant: item.isDescendant,
      })
    }

    // Informational descendant counts for explicitly requested session targets.
    for (const target of requestedTargets) {
      if (target.kind !== 'session') continue
      const descendants = perRootDescendants.get(target.id)
      if (descendants !== undefined && descendants.size > 0) {
        warnings.push(
          warning(
            'SESSION_HAS_DESCENDANTS',
            target.id,
            null,
            `${descendants.size} subagent session log(s) will also be deleted with this session.`,
          ),
        )
      }
    }

    const totals = {
      workspaces: workspaceItems.length,
      sessions: sessionItems.length,
      files: workspaceItems.reduce((sum, item) => sum + item.files, 0) + sessionItems.reduce((sum, item) => sum + item.files, 0),
      dirs: workspaceItems.reduce((sum, item) => sum + item.dirs, 0) + sessionItems.reduce((sum, item) => sum + (Number(item.dirs) || 0), 0),
      bytes: workspaceItems.reduce((sum, item) => sum + item.bytes, 0) + sessionItems.reduce((sum, item) => sum + item.bytes, 0),
    }

    const confirmation = buildConfirmation(mode, workspaceItems)
    const createdAt = now()
    const expiresAt = createdAt + config.planTtlMs
    const planId = randomUUID()
    const planPayload = {
      planId,
      createdAt,
      expiresAt,
      mode,
      allowPermanentDeletion: config.allowPermanentDeletion,
      targets: requestedTargets,
      items,
      totals,
      warnings,
      blockers,
      confirmation,
    }

    if (retain) {
      prunePlans()
      plans.set(planId, {
        plan: planPayload,
        // Internal records carry what execution needs and must never leak: location paths for the
        // admission compare, session dirs, and measured trash metadata.
        items: [
          ...workspaceItems.map((item) => ({
            kind: 'workspace-dir',
            id: item.id,
            title: item.title,
            path: item.path,
            bytes: item.bytes,
            files: item.files,
            dirs: item.dirs,
            missingDir: item.missing,
          })),
          ...sessionItems.map((item) => ({
            kind: 'session',
            id: item.id,
            workspaceId: item.workspaceId,
            path: item.path,
            locationPath: item.locationPath,
            dirPath: item.path,
            // The canonical directory captured at plan time is what admission and the
            // pre-mutation check compare against; without it a swapped parent symlink passes.
            dirCanonical: item.dirCanonical ?? null,
            dirMissing: item.dirMissing === true,
            bytes: item.bytes,
            files: item.files,
            dirs: item.dirs,
            trashTitle: item.trashTitle,
            // Session family bookkeeping travels with the plan so the executed trash entry can record
            // it (SPEC §4.5); it never reaches the wire plan payload.
            origin: sessionOriginOf(item),
            parentSessionId: typeof item.parentSessionId === 'string' ? item.parentSessionId : null,
          })),
        ],
        mode,
        expiresAt,
        confirmation,
      })
      prunePlans()
    }
    return ok({ plan: planPayload })
  }

  /**
   * The typed-name confirmation requirement (SPEC §4.3): non-null exactly when exactly one existing
   * workspace directory is deleted permanently. Deliberately independent of plan blockers — a blocked
   * plan cannot execute now, but the typed name is also the deliberation gate the deferred route and
   * its start-up run re-validate.
   * @param {'trash' | 'permanent'} mode - plan mode.
   * @param {{ path: string, missing: boolean, title: string }[]} workspaceItems - workspace items.
   * @returns {{ kind: 'typed-name', expected: string, label: string } | null}
   */
  function buildConfirmation(mode, workspaceItems) {
    if (mode !== 'permanent') return null
    // Deliberately independent of `blockers`: a blocked plan cannot execute now, but the user can
    // still choose the deferred route, and the typed folder name is exactly the deliberation gate that
    // the startup run re-validates. Suppressing it here made every blocked permanent directory
    // deletion queueable but unexecutable forever.
    const deletableDirs = workspaceItems.filter((item) => !item.missing && typeof item.path === 'string' && item.path !== '')
    if (deletableDirs.length === 0) return null
    // At most one existing directory is reachable here: buildPlan refuses a permanent plan over
    // several of them (PERMANENT_MULTIPLE_DIRECTORIES), so the typed name always names the one folder.
    const target = deletableDirs[0]
    const expected = lastSegment(target.path)
    return { kind: 'typed-name', expected, label: target.title || expected }
  }

  /**
   * Enforce `maxPlans` by evicting the oldest retained plan. Expiry is deliberately NOT handled here:
   * `execute` classifies an expired plan as `PLAN_EXPIRED` (SPEC §4.4), which it could not do if a
   * later `plan()` call had already dropped the record.
   */
  function prunePlans() {
    while (plans.size > config.maxPlans) {
      const oldest = plans.keys().next().value
      if (oldest === undefined) break
      plans.delete(oldest)
    }
  }

  // #endregion

  // #region execute ---------------------------------------------------------------------------

  /**
   * `POST /api/cleanup.delete` (SPEC §4.4 + §5.5 + §5.6).
   *
   * The plan is consumed by this call even when it fails, so a retry needs a fresh review. Admission
   * re-derives every session's `stat.location.path` and every workspace's §5.3 checks before the
   * first mutation; any difference returns `STATE_CHANGED` with nothing touched. After admission
   * each item succeeds or fails on its own — one failure never rolls back another item.
   *
   * @param {object} request - `{ planId, confirmationText? }`.
   * @returns {Promise<object>} envelope.
   */
  async function execute(request, options = {}) {
    if (!isPlainObject(request)) return fail('BAD_REQUEST', 'The request body must be a JSON object.')
    if (typeof request.planId !== 'string' || request.planId === '') {
      return fail('BAD_REQUEST', '"planId" must be a non-empty string.')
    }
    if (request.confirmationText !== undefined && request.confirmationText !== null && typeof request.confirmationText !== 'string') {
      return fail('BAD_REQUEST', '"confirmationText" must be a string.')
    }
    const record = plans.get(request.planId)
    if (record === undefined) return fail('PLAN_UNKNOWN', 'Unknown plan. Create a new plan and review it again.')
    // Single-use: consume before any check so a failed call cannot be replayed with a different body.
    plans.delete(request.planId)
    if (now() > record.expiresAt) {
      return fail('PLAN_EXPIRED', 'This plan has expired. Create a new plan and review it again.')
    }
    if (record.confirmation !== null) {
      const typed = typeof request.confirmationText === 'string' ? request.confirmationText : ''
      if (typed === '') {
        return fail('CONFIRMATION_REQUIRED', `Type "${record.confirmation.expected}" to confirm permanent deletion.`)
      }
      if (typed !== record.confirmation.expected) {
        return fail('CONFIRMATION_MISMATCH', `The typed confirmation does not match "${record.confirmation.expected}".`)
      }
    }
    if (options.signal?.aborted === true) {
      return fail('CANCELLED', 'The request was cancelled before any deletion started, so nothing was deleted.')
    }
    try {
      return await withMutationLock(async () => {
        const changed = await checkAdmission(record)
        if (changed !== null) {
          return fail('STATE_CHANGED', 'The state changed since the plan was created, so nothing was deleted. Create a new plan.', changed)
        }
        const executed = await runPlan(record, { signal: options.signal, skipSessionWritabilityProbe: options.skipSessionWritabilityProbe === true })
        clearPreviewCache()
        // The start-up run emits its own `source:"startup"` record for the same execution; auditing it
        // here as well would write two lines for one deletion (SPEC §5.9: one line per action).
        if (options.audit !== false) await recordExecutedPlan(record, executed)
        return executed
      })
    } catch (error) {
      if (error instanceof DomainError) return fail(error.code, error.message, error.details)
      throw error
    }
  }

  /**
   * Record one executed plan in the audit log (SPEC §5.9), aggregated per plan.
   * @param {object} record - retained plan record.
   * @param {object} executed - `{ ok: true, result }` envelope from `runPlan`.
   * @returns {Promise<void>}
   */
  async function recordExecutedPlan(record, executed) {
    if (!isPlainObject(executed) || executed.ok !== true || !isPlainObject(executed.result)) return
    const items = Array.isArray(executed.result.items) ? executed.result.items : []
    const failed = items.filter((item) => item.status === 'failed')
    const trashed = items.filter((item) => item.status === 'trashed').length
    await recordAudit({
      source: 'immediate',
      action: 'delete',
      mode: record.mode,
      targets: (record.plan.targets ?? []).map((target) => ({ kind: target.kind, id: target.id })),
      status: failed.length === items.length ? 'failed' : (trashed > 0 ? 'trashed' : 'deleted'),
      code: failed.length > 0 ? (failed[0].error?.code ?? 'IO_ERROR') : null,
      bytes: typeof executed.result.totals?.bytes === 'number' ? executed.result.totals.bytes : 0,
    })
  }

  /**
   * Admission re-check (SPEC §5.6). Returns the changed-world reasons, or null when the plan is still
   * exactly valid.
   * @param {{ items: object[], mode: string, plan: object }} record - retained plan record.
   * @returns {Promise<{ reasons: object[] } | null>}
   */
  async function checkAdmission(record) {
    /** @type {object[]} */
    const reasons = []
    /** @type {Set<string>} */
    const reasonKeys = new Set()
    const reasonKey = (code, sessionId, workspaceId) => `${code}:${sessionId ?? ''}:${workspaceId ?? ''}`
    /**
     * Record one changed-world reason. A reason the plan already reported is not repeated, and a new
     * one is always a change relative to the reviewed plan.
     * @param {string} code - wire code.
     * @param {string} message - explanation.
     * @param {string | null} sessionId - session attribution.
     * @param {string | null} workspaceId - workspace attribution.
     */
    const pushReason = (code, message, sessionId, workspaceId) => {
      const key = reasonKey(code, sessionId, workspaceId)
      if (reasonKeys.has(key)) return
      reasonKeys.add(key)
      reasons.push({ code, message, sessionId: sessionId ?? null, workspaceId: workspaceId ?? null })
    }
    for (const planned of record.plan.blockers) {
      reasonKeys.add(reasonKey(planned.code, planned.sessionId, planned.workspaceId))
      reasons.push({ code: planned.code, message: 'The plan still reports a blocker.', sessionId: planned.sessionId, workspaceId: planned.workspaceId })
    }
    let storedSessions = null
    let storedById = null
    /**
     * One persistence listing serves every session item: the JSONL backend locates a session by
     * scanning all project directories, so calling `stat()` per planned session makes admission
     * O(sessions x projects) — seconds to tens of seconds on a large history before anything happens.
     * @returns {Promise<Map<string, object>>}
     */
    const storedSessionMap = async () => {
      if (storedById === null) {
        storedSessions = await listStoredSessions()
        storedById = new Map()
        for (const snapshot of storedSessions) {
          const id = snapshot?.header?.id
          if (typeof id === 'string') storedById.set(id, snapshot)
        }
      }
      return storedById
    }
    for (const item of record.items) {
      if (item.kind === 'session') {
        const byId = await storedSessionMap()
        const snapshot = byId.get(item.id)
        if (snapshot === undefined || snapshot === null) {
          pushReason('UNKNOWN_SESSION', `Session "${item.id}" no longer exists.`, item.id, null)
          continue
        }
        const locationPath = typeof snapshot.location?.path === 'string' ? snapshot.location.path : null
        if (locationPath !== item.locationPath) {
          pushReason('PATH_CHANGED', `The stored log location of session "${item.id}" changed.`, item.id, null)
          continue
        }
        if (locationPath !== null) {
          const layout = sessionDirectoryFromLocation(locationPath)
          if (!layout.ok || layout.sessionDir !== item.dirPath) {
            pushReason('PATH_CHANGED', `The stored log directory of session "${item.id}" changed.`, item.id, null)
            continue
          }
          // The persisted path string is not enough — the directory itself must still be the
          // planned, canonical, non-symlink directory or the deletion could be redirected.
          const inspectedDir = await inspectSessionDirectory(item.dirPath)
          if (inspectedDir.state === 'unsafe') {
            pushReason('PATH_CHANGED', `The session directory of "${item.id}" changed: ${inspectedDir.message}`, item.id, null)
            continue
          }
          if (inspectedDir.state === 'missing') {
            pushReason('PATH_CHANGED', `The session directory of "${item.id}" disappeared after planning.`, item.id, null)
            continue
          }
          if (item.dirCanonical !== null && typeof item.dirCanonical === 'string' && inspectedDir.canonical !== item.dirCanonical) {
            pushReason('PATH_CHANGED', `The canonical session directory of "${item.id}" changed.`, item.id, null)
            continue
          }
        }
        const liveBlocker = sessionBlockerFor(item.id)
        if (liveBlocker !== null) {
          pushReason(liveBlocker.code, liveBlocker.message, item.id, null)
        }
        continue
      }
      // Workspace-directory admission: the registration must still exist and the directory must
      // still be exactly the planned one, or the plan stops here before any mutation.
      const entity = registry().get(item.id)
      if (entity === undefined || entity === null) {
        pushReason('UNKNOWN_WORKSPACE', `Workspace "${item.id}" no longer exists.`, null, item.id)
        continue
      }
      if (typeof entity.path !== 'string' || entity.path !== item.path) {
        pushReason('PATH_CHANGED', `The canonical path of workspace "${item.id}" changed.`, null, item.id)
        continue
      }
      if (storedSessions === null) storedSessions = await listStoredSessions()
      const inspected = await inspectWorkspace(entity, { mode: record.mode, storedSessions })
      if (item.missingDir) {
        // The plan said "registration only"; a directory that reappeared means the world changed.
        if (!inspected.missing) {
          pushReason('PATH_CHANGED', `The missing workspace directory of "${item.id}" reappeared.`, null, item.id)
        }
        continue
      }
      if (inspected.missing) {
        pushReason('WORKSPACE_MISSING', `The workspace directory of "${item.id}" disappeared after planning.`, null, item.id)
        continue
      }
      // Every blocker the re-inspection finds that the reviewed plan did not report is a
      // changed-world reason (a live session, a moved path, a vanished trash volume, ...).
      for (const entry of inspected.blockers) {
        pushReason(entry.code, `Workspace "${item.id}" is no longer in the planned state: ${entry.message}`, null, item.id)
      }
    }
    return reasons.length > 0 ? { reasons } : null
  }

  /**
   * Mutate one admitted plan. Sessions first, then workspace directories.
   *
   * Registry sets are dropped for every session **before any file is touched**: a crash must not
   * leave a pinned or archived id pointing at a deleted log (SPEC §5.5 step 2). A session whose set
   * drop fails keeps its files and is reported failed instead of being half-deleted.
   * @param {{ items: object[], mode: 'trash' | 'permanent', plan: object }} record - admitted plan.
   * @returns {Promise<object>} envelope.
   */
  async function runPlan(record, options = {}) {
    /** @type {Map<string, object>} */
    const results = new Map()
    const sessionItems = record.items.filter((item) => item.kind === 'session')
    const workspaceItems = record.items.filter((item) => item.kind === 'workspace-dir')
    const aborted = () => options.signal?.aborted === true
    const cancelledResult = (item) => ({
      kind: item.kind,
      id: item.id,
      status: 'failed',
      error: { code: 'CANCELLED', message: 'The request was cancelled; this item was not attempted.' },
      movedTo: null,
      bytes: 0,
    })

    // Admission validates the world once for the whole batch, but a large batch spends seconds
    // deleting, and a session can be resumed or a directory replaced inside that window. Re-check
    // each item immediately before its mutation; a changed item fails alone instead of being deleted.
    // The registry sets are dropped per item, immediately before its log is touched, so a crash can
    // never leave a pin/archive id pointing at a deleted log (SPEC §5.5). The cross-process probe runs
    // before the drop; a local re-check failure after the drop leaves the item unpinned but with its
    // files untouched (a harmless registry-only state change, documented in SPEC §5.5).
    for (const item of sessionItems) {
      if (aborted()) {
        results.set(resultKey(item), cancelledResult(item))
        continue
      }
      // Cross-process writer first, before any registry state changes for this item: a Session held
      // by another Host must fail with its pin/archive untouched (SPEC §5.2). The in-process path
      // re-check below cannot see another process' write handle; the persistence claim can.
      if (options.skipSessionWritabilityProbe !== true && item.dirPath !== null && item.dirMissing !== true) {
        const writability = await probeSessionWritability([item.id])
        if (writability !== null) {
          results.set(resultKey(item), failedItemResult(item, { code: writability.code, message: writability.message }))
          continue
        }
      }
      const registrySetFailure = await dropSessionRegistrySets(item.id)
      const recheck = await recheckBeforeMutation(item)
      if (!recheck.ok) {
        results.set(resultKey(item), failedItemResult(item, recheck.failure))
        continue
      }
      results.set(
        resultKey(item),
        await executeSessionItem(item, record.mode, registrySetFailure, recheck.dirGone === true),
      )
    }
    for (const item of workspaceItems) {
      if (aborted()) {
        results.set(resultKey(item), cancelledResult(item))
        continue
      }
      const recheck = await recheckBeforeMutation(item)
      if (!recheck.ok) {
        results.set(resultKey(item), failedItemResult(item, recheck.failure))
        continue
      }
      results.set(resultKey(item), await executeWorkspaceItem(item, record.mode, recheck.dirGone === true))
    }

    /** @type {object[]} */
    const itemResults = []
    const totals = { trashed: 0, deleted: 0, failed: 0, bytes: 0 }
    for (const item of record.items) {
      const result = results.get(resultKey(item)) ?? {
        kind: item.kind,
        id: item.id,
        status: 'failed',
        error: { code: 'INTERNAL', message: 'The item was not executed.' },
        movedTo: null,
        bytes: 0,
      }
      itemResults.push(result)
      if (result.status === 'trashed') totals.trashed += 1
      else if (result.status === 'deleted') totals.deleted += 1
      else totals.failed += 1
      if (result.status !== 'failed') totals.bytes += result.bytes
    }
    return ok({ result: { items: itemResults, totals } })
  }

  /**
   * One-plan session sweep limit refusal (SPEC §4.3/§5.1).
   * @param {number} sessionCount - how many session logs the plan would contain.
   * @returns {object} failure envelope.
   */
  function sessionLimitFailure(sessionCount) {
    return fail(
      'BAD_REQUEST',
      `This plan would delete ${String(sessionCount)} session logs, which exceeds the ${String(MAX_PLAN_SESSION_ITEMS)}-session limit of one plan. Delete the sessions in batches from the Sessions tab first, then delete the directory with "include sessions" unchecked.`,
      { sessionCount, maxSessions: MAX_PLAN_SESSION_ITEMS },
    )
  }

  /**
   * The wire result for an item refused by the pre-mutation re-check. Nothing was mutated for it, so
   * it contributes no bytes and reports the precise reason.
   * @param {object} item - planned item.
   * @param {{ code: string, message: string }} failure - refusal.
   * @returns {object} item result.
   */
  function failedItemResult(item, failure) {
    return {
      kind: item.kind,
      id: item.id,
      status: 'failed',
      error: { code: failure.code, message: failure.message },
      movedTo: null,
      bytes: 0,
    }
  }

  /**
   * Re-derive an item's safety immediately before its mutation.
   *
   * A plan is a review of a moment; this closes the window between that moment and the destructive
   * call for the cases a local change can create: a session becoming live, a session or workspace
   * directory being replaced (including by a symlink), a workspace directory losing its canonical
   * spelling, or a live Agent's effective working directory moving inside the target folder.
   * @param {object} item - planned session or workspace item.
   * @returns {Promise<{ ok: true, dirGone?: boolean } | { ok: false, failure: { code: string, message: string } }>}
   */
  async function recheckBeforeMutation(item) {
    if (item.kind === 'session') {
      const liveBlocker = sessionBlockerFor(item.id)
      if (liveBlocker !== null) return { ok: false, failure: { code: liveBlocker.code, message: liveBlocker.message } }
      if (item.dirPath === null) return { ok: true }
      const inspected = await inspectSessionDirectory(item.dirPath)
      if (inspected.state === 'unsafe') {
        return { ok: false, failure: { code: 'PATH_CHANGED', message: `The session directory changed before deletion: ${inspected.message}` } }
      }
      if (inspected.state === 'missing') return { ok: true, dirGone: true }
      if (item.dirCanonical !== null && typeof item.dirCanonical === 'string' && inspected.canonical !== item.dirCanonical) {
        return { ok: false, failure: { code: 'PATH_CHANGED', message: 'The canonical session directory changed before deletion.' } }
      }
      return { ok: true }
    }
    if (item.missingDir) return { ok: true, dirGone: true }
    if (typeof item.path !== 'string' || item.path === '') {
      return { ok: false, failure: { code: 'PATH_PROTECTED', message: 'The workspace has no directory to delete.' } }
    }
    let entry
    try {
      entry = await fs.lstat(item.path)
    } catch (error) {
      if (isMissingError(error)) return { ok: true, dirGone: true }
      return { ok: false, failure: { code: 'IO_ERROR', message: `The workspace directory cannot be inspected before deletion: ${errorMessage(error)}` } }
    }
    if (entry.isSymbolicLink()) {
      return { ok: false, failure: { code: 'PATH_CHANGED', message: 'The workspace path is a symbolic link now; refusing to follow or delete it.' } }
    }
    if (!entry.isDirectory()) {
      return { ok: false, failure: { code: 'PATH_CHANGED', message: 'The workspace path is no longer a directory.' } }
    }
    let canonical
    try {
      canonical = await fs.realpath(item.path)
    } catch (error) {
      return { ok: false, failure: { code: 'IO_ERROR', message: `The workspace directory cannot be resolved before deletion: ${errorMessage(error)}` } }
    }
    if (!samePath(canonical, item.path)) {
      return { ok: false, failure: { code: 'PATH_CHANGED', message: 'The workspace directory no longer resolves to the reviewed canonical path; it was moved or replaced.' } }
    }
    const liveInside = liveSessionsInside(item.path)
    if (liveInside.probeFailed) {
      return { ok: false, failure: { code: 'IO_ERROR', message: 'Whether a live session is using this directory could not be verified before deletion.' } }
    }
    if (liveInside.ids.length > 0) {
      return {
        ok: false,
        failure: {
          code: 'WORKSPACE_HAS_LIVE_SESSIONS',
          message: `A live session started using this workspace directory (${liveInside.ids.join(', ')}); close it and retry.`,
        },
      }
    }
    return { ok: true }
  }

  /** @param {object} item @returns {string} */
  function resultKey(item) {
    return `${item.kind}:${item.id}`
  }

  /**
   * Drop the pin/archive registry sets for one session before its files are deleted.
   * "Not found"/"not pinned"/"not archived" answers are the documented idempotent outcomes and are
   * ignored; anything else is a real storage failure the caller must surface.
   * @param {string} sessionId - session id.
   * @returns {Promise<unknown | null>} the first real failure, or null when both drops are clean.
   */
  async function dropSessionRegistrySets(sessionId) {
    let failure = null
    // The shipped registry documents unpin/unarchive of an absent id as an idempotent no-op that
    // RESOLVES, so any rejection here is a real storage failure. The previous substring matcher was
    // production-dead and could hide a genuine failure whose message contained "not found".
    try {
      await registry().unpinSession(sessionId)
    } catch (error) {
      if (failure === null) failure = error
    }
    try {
      await registry().unarchiveSession(sessionId)
    } catch (error) {
      if (failure === null) failure = error
    }
    return failure
  }

  /**
   * Execute one session item.
   * @param {object} item - internal session item.
   * @param {'trash' | 'permanent'} mode - deletion mode.
   * @param {unknown | null} registrySetFailure - set-drop failure that must keep the files in place.
   * @returns {Promise<object>} wire item result.
   */
  async function executeSessionItem(item, mode, registrySetFailure, dirGone) {
    const base = { kind: 'session', id: item.id, status: 'failed', error: null, movedTo: null, bytes: item.bytes }
    if (registrySetFailure !== null) {
      return {
        ...base,
        error: {
          code: 'IO_ERROR',
          message: `The session registry sets could not be updated, so its log was left untouched: ${errorMessage(registrySetFailure)}`,
        },
      }
    }
    try {
      if (item.locationPath === null || item.dirMissing === true || dirGone === true) {
        // Never materialized, planned as already-gone, or gone by the time we got here: the registry
        // sets were dropped above and no filesystem work remains. Report deleted with zero bytes so
        // the totals never claim data was removed that was already absent.
        return { ...base, status: 'deleted', bytes: 0 }
      }
      if (mode === 'trash') {
        const entry = await moveIntoTrash({
          kind: 'session',
          title: item.trashTitle,
          originalPath: item.dirPath,
          workspaceId: item.workspaceId,
          sessionId: item.id,
          bytes: item.bytes,
          files: item.files,
          dirs: item.dirs,
          origin: typeof item.origin === 'string' ? item.origin : null,
          parentSessionId: typeof item.parentSessionId === 'string' ? item.parentSessionId : null,
        })
        return { ...base, status: 'trashed', movedTo: entry.entryDir }
      }
      await removeTree(item.dirPath)
      return { ...base, status: 'deleted' }
    } catch (error) {
      const failure = itemFailure(error)
      return { ...base, movedTo: typeof failure.movedTo === 'string' ? failure.movedTo : null, error: failure }
    }
  }

  /**
   * Execute one workspace-directory item: directory first, registration second.
   * @param {object} item - internal workspace item.
   * @param {'trash' | 'permanent'} mode - deletion mode.
   * @returns {Promise<object>} wire item result.
   */
  async function executeWorkspaceItem(item, mode, dirGone) {
    const bytes = item.missingDir || dirGone === true ? 0 : item.bytes
    const base = { kind: 'workspace-dir', id: item.id, status: 'failed', error: null, movedTo: null, bytes }
    let status = 'deleted'
    let movedTo = null
    try {
      if (!item.missingDir && dirGone !== true) {
        if (mode === 'trash') {
          const entry = await moveIntoTrash({
            kind: 'workspace-dir',
            title: item.title,
            originalPath: item.path,
            workspaceId: item.id,
            sessionId: null,
            bytes: item.bytes,
            files: item.files,
            dirs: item.dirs,
          })
          status = 'trashed'
          movedTo = entry.entryDir
        } else {
          await removeTree(item.path)
        }
      }
    } catch (error) {
      // The directory may be untouched, or already inside a kept trash entry when only the metadata
      // write failed. Either way keep the registration so the user can retry, and report the location.
      const failure = itemFailure(error)
      return { ...base, movedTo: typeof failure.movedTo === 'string' ? failure.movedTo : null, error: failure }
    }
    try {
      await registry().delete(item.id)
    } catch (error) {
      // The directory is already gone or trashed; reporting a rollback would be a lie. Say exactly
      // what happened (SPEC §5.5 step 4).
      const where = status === 'trashed' ? 'moved to the trash' : 'deleted'
      return {
        ...base,
        // The payload really is in the trash; the failed item must still tell the user where it went
        // (SPEC §4.4 keeps `movedTo` meaningful on a failed item).
        movedTo,
        error: {
          code: 'IO_ERROR',
          message: `The workspace directory was ${where} but the workspace registration could not be removed: ${errorMessage(error)}`,
        },
      }
    }
    return { ...base, status, movedTo }
  }

  // #endregion

  // #region trash routes ----------------------------------------------------------------------

  /**
   * `POST /api/cleanup.trash.list` payload (SPEC §4.5). Unreadable entries are listed with
   * `restorable: false`, never omitted.
   * @returns {Promise<object>} envelope.
   */
  async function trashList() {
    try {
      const listed = await listTrashDirectories()
      /** @type {object[]} */
      const entries = []
      let totalBytes = 0
      for (let index = 0; index < listed.entryDirs.length; index += 1) {
        const entryDir = listed.entryDirs[index]
        const entryId = listed.names[index]
        const meta = await readTrashMeta(entryDir)
        const restorable = await restorabilityOf(entryDir, meta)
        const entryStat = await lstatOrNull(entryDir)
        const bytes = meta !== null && typeof meta.bytes === 'number' && Number.isFinite(meta.bytes) ? meta.bytes : 0
        totalBytes += bytes
        entries.push({
          id: entryId,
          kind: meta !== null && typeof meta.kind === 'string' ? meta.kind : null,
          title: meta !== null && typeof meta.title === 'string' ? meta.title : entryId,
          originalPath: meta !== null && typeof meta.originalPath === 'string' ? meta.originalPath : null,
          movedAt: meta !== null && epochMs(meta.movedAt) !== null ? epochMs(meta.movedAt) : entryStat !== null ? Math.floor(Number(entryStat.mtimeMs) || 0) : 0,
          bytes,
          files: meta !== null && typeof meta.files === 'number' ? meta.files : 0,
          dirs: meta !== null && typeof meta.dirs === 'number' ? meta.dirs : 0,
          origin: meta !== null && typeof meta.origin === 'string' ? meta.origin : null,
          parentSessionId: meta !== null && typeof meta.parentSessionId === 'string' ? meta.parentSessionId : null,
          restorable: restorable.restorable,
          restorableCode: restorable.restorableCode,
        })
      }
      entries.sort((left, right) => right.movedAt - left.movedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      return ok({ entries, totals: { entries: entries.length, bytes: totalBytes } })
    } catch (error) {
      if (error instanceof DomainError) return fail(error.code, error.message, error.details)
      throw error
    }
  }

  /**
   * @param {string} targetPath - path to lstat.
   * @returns {Promise<import('node:fs').Stats | null>}
   */
  async function lstatOrNull(targetPath) {
    try {
      return await fs.lstat(targetPath)
    } catch {
      return null
    }
  }

  /**
   * `POST /api/cleanup.trash.restore` (SPEC §4.5/§5.7), serialized with destructive executions so a
   * restore cannot race the payload move of an executing plan (which would leave an orphan payload).
   * @param {object} request - `{ entryId }`.
   * @returns {Promise<object>} envelope.
   */
  function trashRestore(request) {
    return withMutationLock(() => trashRestoreLocked(request))
  }

  /**
   * `POST /api/cleanup.trash.restore` (SPEC §4.5/§5.7): move `payload/` back to its original path
   * only when that path does not exist and its parent does, then remove the entry.
   * @param {object} request - `{ entryId }`.
   * @returns {Promise<object>} envelope.
   */
  async function trashRestoreLocked(request) {
    if (!isPlainObject(request)) return fail('BAD_REQUEST', 'The request body must be a JSON object.')
    if (typeof request.entryId !== 'string' || request.entryId === '') {
      return fail('BAD_REQUEST', '"entryId" must be a non-empty string.')
    }
    if (!isValidTrashEntryId(request.entryId)) {
      return fail('TRASH_ENTRY_UNKNOWN', 'Unknown trash entry.')
    }
    try {
      const entryDir = path.join(config.trashRoot, request.entryId)
      const entryStat = await lstatOrNull(entryDir)
      if (entryStat === null || entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
        return fail('TRASH_ENTRY_UNKNOWN', 'Unknown trash entry.')
      }
      // Ownership: a directory that merely lives under `trashRoot` is not a trash entry (SPEC §5.7).
      if (!(await isOwnedTrashEntry(entryDir))) {
        return fail('TRASH_ENTRY_UNKNOWN', 'Unknown trash entry.')
      }
      const meta = await readTrashMeta(entryDir)
      if (meta === null) return fail('RESTORE_FAILED', 'The trash entry metadata is missing or unreadable, so it cannot be restored automatically.')
      const originalPath = meta.originalPath
      if (typeof originalPath !== 'string' || !path.isAbsolute(originalPath) || samePath(originalPath, path.parse(originalPath).root)) {
        return fail('RESTORE_FAILED', 'The trash entry does not name a restorable original path.')
      }
      const payloadPath = path.join(entryDir, 'payload')
      const payloadStat = await lstatOrNull(payloadPath)
      if (payloadStat === null) return fail('RESTORE_FAILED', 'The trash entry payload is missing.')
      // The list reports a symlink payload as not restorable, so restore must refuse it too —
      // otherwise the API plants a link at the original path and disagrees with the UI.
      if (payloadStat.isSymbolicLink() || !payloadStat.isDirectory()) {
        return fail('RESTORE_FAILED', 'The trash entry payload is not a directory and cannot be restored automatically.')
      }
      const existing = await lstatOrNull(originalPath)
      if (existing !== null) return fail('RESTORE_ORIGINAL_EXISTS', `"${originalPath}" already exists; move or delete it before restoring.`)
      const parentStat = await lstatOrNull(path.dirname(originalPath))
      if (parentStat === null || parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
        return fail('RESTORE_FAILED', `The parent directory of "${originalPath}" no longer exists, so it cannot be restored.`)
      }
      try {
        await fs.rename(payloadPath, originalPath)
      } catch (error) {
        const code = errorCode(error)
        if (code === 'EEXIST' || code === 'ENOTEMPTY') {
          return fail('RESTORE_ORIGINAL_EXISTS', `"${originalPath}" already exists; move or delete it before restoring.`)
        }
        return fail('RESTORE_FAILED', `The restore move failed: ${errorMessage(error)}`)
      }
      try {
        await removeTree(entryDir)
      } catch {
        // The restore itself succeeded; a stale metadata-only entry is a lesser problem and must not
        // turn a successful restore into a reported failure.
      }
      clearPreviewCache()
      await recordAudit({ source: 'immediate', action: 'restore', status: 'restored', targets: [], entryIds: [request.entryId] })
      return ok({ restoredTo: originalPath })
    } catch (error) {
      if (error instanceof DomainError) return fail(error.code, error.message, error.details)
      throw error
    }
  }

  /**
   * `POST /api/cleanup.trash.purge` (SPEC §4.5), serialized with destructive executions so a purge
   * cannot delete a just-prepared entry (marker/metadata written, payload move pending).
   * @param {object} request - `{ entryIds?, all? }`.
   * @returns {Promise<object>} envelope.
   */
  function trashPurge(request) {
    return withMutationLock(() => trashPurgeLocked(request))
  }

  /**
   * `POST /api/cleanup.trash.purge` (SPEC §4.5): permanently remove the named entries, or every entry
   * when `entryIds` is absent. Unknown ids are skipped so a stale UI can retry safely.
   * @param {object} request - `{ entryIds? }`.
   * @returns {Promise<object>} envelope.
   */
  async function trashPurgeLocked(request) {
    if (!isPlainObject(request)) return fail('BAD_REQUEST', 'The request body must be a JSON object.')
    if (request.entryIds !== undefined && !isStringArray(request.entryIds)) {
      return fail('BAD_REQUEST', '"entryIds" must be an array of strings.')
    }
    // "no entryIds" used to mean "purge every entry", so a client bug or a stray {} could
    // irreversibly empty the trash. Purging everything is now an explicit `{ all: true }`.
    const purgeAll = request.all === true
    if (request.all !== undefined && typeof request.all !== 'boolean') {
      return fail('BAD_REQUEST', '"all" must be a boolean.')
    }
    if (!purgeAll && request.entryIds === undefined) {
      return fail('BAD_REQUEST', 'Purging requires "entryIds", or {"all": true} to empty the whole trash.')
    }
    /** @type {Set<string> | null} */
    const wanted = purgeAll ? null : new Set(dedupeStrings(request.entryIds ?? []))
    try {
      const listed = await listTrashDirectories()
      let purged = 0
      let bytes = 0
      for (let index = 0; index < listed.entryDirs.length; index += 1) {
        const entryId = listed.names[index]
        if (wanted !== null && !wanted.has(entryId)) continue
        const entryDir = listed.entryDirs[index]
        const meta = await readTrashMeta(entryDir)
        const payloadStat = await lstatOrNull(path.join(entryDir, 'payload'))
        const size = payloadStat !== null && meta !== null && typeof meta.bytes === 'number' && Number.isFinite(meta.bytes) ? meta.bytes : 0
        try {
          await removeTree(entryDir)
          purged += 1
          bytes += size
        } catch {
          // A single entry that cannot be removed must not abort the sweep; the caller sees the
          // remaining entries on the next list call.
        }
      }
      await recordAudit({ source: 'immediate', action: 'purge', status: 'purged', bytes, targets: [], entryIds: wanted === null ? [] : [...wanted] })
      return ok({ purged, bytes })
    } catch (error) {
      if (error instanceof DomainError) return fail(error.code, error.message, error.details)
      throw error
    }
  }

  // #endregion

  return {
    inventory,
    measure,
    plan,
    execute,
    trashList,
    trashRestore,
    trashPurge,
    defer,
    deferredList,
    deferredCancel,
    deferredRequeue,
    runDeferred,
    deferredState,
    settingsGet,
    settingsSet,
    candidates,
  }
}

/**
 * Bind the engine's filesystem surface to injected overrides, falling back per-method to
 * `node:fs/promises`.
 * @param {object | undefined} overrides - `deps.fsOps`.
 * @returns {Record<string, (...args: any[]) => Promise<any>>}
 */
function resolveFsOps(overrides) {
  /** @type {Record<string, (...args: any[]) => Promise<any>>} */
  const ops = {}
  for (const name of FS_METHODS) {
    const hasOverride = overrides !== undefined && overrides !== null && typeof overrides[name] === 'function'
    const source = hasOverride ? overrides : nodeFs
    ops[name] = (...args) => source[name](...args)
  }
  return ops
}

/** @param {unknown} value @returns {boolean} */
function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/**
 * De-duplicate a string array while preserving order.
 * @param {string[]} values - candidate ids.
 * @returns {string[]} unique ids.
 */
function dedupeStrings(values) {
  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {string[]} */
  const unique = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    unique.push(value)
  }
  return unique
}
