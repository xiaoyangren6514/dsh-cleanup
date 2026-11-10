/**
 * Session usage folding for dsh-cleanup (SPEC §4.10 and §5.11).
 *
 * The plugin shows a user what a Session costs in tokens before they delete it. The numbers are
 * folded from the Session's own replay-validated event log as served by the Host's `sessionQuery`
 * seam, never by opening a log file: a stored log may be compressed and is only decodable through
 * the Host's persistence stack.
 *
 * This module is pure data handling: it imports nothing (not even a Node builtin), never touches the
 * disk, and never throws for one bad log. `createUsageReader` adds only a bounded in-memory cache of
 * already-folded Sessions, keyed by the persistence snapshot's `(eventCount, sizeBytes)` so a log
 * that changed is folded again and an unchanged one is answered from memory.
 *
 * @module dsh-cleanup/lib/usage
 */

/** How many folded Sessions one reader keeps in memory before evicting the oldest half. */
const DEFAULT_CACHE_LIMIT = 200

/** How many Session logs one reader folds at the same time, so a 200-id request stays bounded. */
const READ_CONCURRENCY = 4

/** English reason reported by a fold that saw a request without a usable assistant message id. */
const INCOMPLETE_NOTE =
  'Some model requests carried no usable assistant message id, so repeated requests could not be de-duplicated.'

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One token counter from a provider usage object. Anything that is not a finite positive number
 * counts as zero: a hostile or older provider payload must never poison the totals with `NaN`,
 * `Infinity`, or a negative count.
 * @param {unknown} value - candidate token count.
 * @returns {number} whole non-negative token count.
 */
function tokenCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

/**
 * Normalize the fork-inherited prefix length against the actual event array.
 * @param {unknown} value - `inheritedEventCount` from the session observation.
 * @param {number} eventCount - number of observed events.
 * @returns {number} how many leading events to skip.
 */
function inheritedPrefixLength(value, eventCount) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.min(Math.floor(value), Math.max(0, eventCount))
}

/**
 * Project one usage object onto the four frozen buckets (SPEC §5.11). The three-way share bar stays
 * addable to 100 %: `cacheMissInputTokens` includes cache writes, and `cacheWriteTokens` is reported
 * separately for display only.
 * @param {Record<string, any>} usage - `data.usage` of one assistant message.
 * @returns {{ cacheReadInputTokens: number, cacheMissInputTokens: number, cacheWriteTokens: number, outputTokens: number, totalTokens: number }}
 */
function bucketsOf(usage) {
  const cacheRead = tokenCount(usage.cacheReadTokens)
  const cacheWrite = tokenCount(usage.cacheWriteTokens)
  const input = tokenCount(usage.inputTokens)
  const output = tokenCount(usage.outputTokens)
  const miss = input + cacheWrite
  return {
    cacheReadInputTokens: cacheRead,
    cacheMissInputTokens: miss,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    totalTokens: miss + cacheRead + output,
  }
}

/**
 * The zero-usage projection: a Session (or a fork prefix) that made no model request of its own.
 *
 * @param {number} [inheritedEvents] - leading forked events skipped.
 * @returns {{ cacheReadInputTokens: number, cacheMissInputTokens: number, cacheWriteTokens: number, outputTokens: number, totalTokens: number, requestCount: number, complete: boolean, note: null, inheritedEvents: number, duplicateRequests: number }}
 */
export function emptyUsage(inheritedEvents = 0) {
  return {
    cacheReadInputTokens: 0,
    cacheMissInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requestCount: 0,
    complete: true,
    note: null,
    inheritedEvents:
      typeof inheritedEvents === 'number' && Number.isFinite(inheritedEvents) && inheritedEvents > 0
        ? Math.floor(inheritedEvents)
        : 0,
    duplicateRequests: 0,
  }
}

/**
 * Fold one Session's token usage from its raw event array (SPEC §5.11).
 *
 * Only `assistant/message` events carrying a `data.usage` object are model answers. A fork's copied
 * ancestor prefix (the first `inheritedEventCount` events) is skipped, so an ordinary fork never
 * re-counts its ancestor. Requests are de-duplicated by the assistant message id; a request without
 * a usable id is still counted and reported through `complete: false` plus a note, because it cannot
 * be de-duplicated.
 *
 * Pure and total: a malformed event array, hostile usage values, or an unreadable event object
 * degrades to zero/partial numbers instead of throwing.
 *
 * @param {unknown} events - raw session event array from `sessionQuery.readSession(id)`.
 * @param {number} [inheritedEventCount] - leading fork-inherited events to skip.
 * @returns {{ cacheReadInputTokens: number, cacheMissInputTokens: number, cacheWriteTokens: number, outputTokens: number, totalTokens: number, requestCount: number, complete: boolean, note: string | null, inheritedEvents: number, duplicateRequests: number }}
 */
export function foldUsage(events, inheritedEventCount = 0) {
  try {
    const list = Array.isArray(events) ? events : []
    const inherited = inheritedPrefixLength(inheritedEventCount, list.length)
    const used = emptyUsage(inherited)
    /** @type {Set<string>} */
    const seenIds = new Set()
    let incomplete = false
    for (let index = inherited; index < list.length; index += 1) {
      let event
      try {
        event = list[index]
      } catch {
        // An event array with a throwing accessor is treated as "no event here".
        continue
      }
      if (!isPlainObject(event) || event.type !== 'assistant/message') continue
      let data
      try {
        data = event.data
      } catch {
        continue
      }
      if (!isPlainObject(data) || !isPlainObject(data.usage)) continue
      let messageId = ''
      try {
        const candidate = isPlainObject(data.message) ? data.message.id : undefined
        messageId = typeof candidate === 'string' ? candidate : ''
      } catch {
        messageId = ''
      }
      if (messageId === '') {
        // Distinct by construction (it cannot be de-duplicated), so it is a counted request.
        incomplete = true
      } else if (seenIds.has(messageId)) {
        used.duplicateRequests += 1
        continue
      } else {
        seenIds.add(messageId)
      }
      used.requestCount += 1
      let buckets
      try {
        buckets = bucketsOf(data.usage)
      } catch {
        // A hostile usage object contributes no tokens; the request was still counted above.
        buckets = bucketsOf({})
      }
      used.cacheReadInputTokens += buckets.cacheReadInputTokens
      used.cacheMissInputTokens += buckets.cacheMissInputTokens
      used.cacheWriteTokens += buckets.cacheWriteTokens
      used.outputTokens += buckets.outputTokens
    }
    used.totalTokens = used.cacheMissInputTokens + used.cacheReadInputTokens + used.outputTokens
    if (incomplete) {
      used.complete = false
      used.note = INCOMPLETE_NOTE
    }
    return used
  } catch {
    // A log this build cannot walk still must not fail the whole batch.
    return { ...emptyUsage(0), complete: false, note: 'The session log could not be folded.' }
  }
}

/**
 * The cache key of one stored Session, or null when its snapshot cannot prove the log is unchanged.
 *
 * The shipped JSONL backend reports `{ header, formatStatus, revision, sizeBytes, location }` and no
 * `eventCount` (a cheap event count only exists behind versioned artifact metadata, which not every
 * backend writes). Its opaque `revision` string is the change token then, refined by `sizeBytes` when
 * the backend reports one, so a changed log re-folds and an unchanged one is answered from memory.
 * Snapshots that only report the `(eventCount, sizeBytes)` shape (fake or legacy backends) keep that
 * identity; a snapshot with neither cannot be trusted, so the Session is simply not cached.
 * @param {string} id - session id.
 * @param {unknown} snapshot - persistence snapshot.
 * @returns {string | null} cache key, or null when the Session must not be cached.
 */
function cacheKeyOf(id, snapshot) {
  if (!isPlainObject(snapshot)) return null
  const revision = snapshot.revision
  if (typeof revision === 'string' && revision !== '') {
    const sizeBytes =
      typeof snapshot.sizeBytes === 'number' && Number.isFinite(snapshot.sizeBytes) ? snapshot.sizeBytes : null
    return `${id}\u0000revision:${revision}\u0000size:${sizeBytes === null ? '' : sizeBytes}`
  }
  const eventCount = snapshot.eventCount
  const sizeBytes = snapshot.sizeBytes
  if (typeof eventCount !== 'number' || !Number.isFinite(eventCount)) return null
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes)) return null
  return `${id}\u0000eventCount:${eventCount}\u0000size:${sizeBytes}`
}

/**
 * Whether a read failure means "this Session does not exist" rather than "reading it failed".
 *
 * The shipped `sessionQuery` reports an unknown id as a `SessionQueryError` whose code is
 * `SESSION_QUERY_SESSION_NOT_FOUND`; a persistence backend may also reject with `ENOENT`. A resolved
 * observation without a session header is equally "not a Session we know".
 * @param {unknown} error - thrown read failure.
 * @returns {boolean}
 */
function isUnknownSessionFailure(error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return false
  const name = typeof error.name === 'string' ? error.name : ''
  if (/^Session.*NotFoundError$/.test(name)) return true
  const code = error.code
  return code === 'ENOENT' || code === 'SESSION_QUERY_SESSION_NOT_FOUND'
}

/**
 * Whether a resolved observation is missing the session header and therefore names no Session.
 * @param {unknown} observation - resolved `readSession` value.
 * @returns {boolean}
 */
function isMissingHeader(observation) {
  return !isPlainObject(observation) || !isPlainObject(observation.session)
}

/**
 * Create the bounded, read-through usage reader (SPEC §4.10/§5.11).
 *
 * The reader owns one `Map` of folded Sessions. A successful fold is cached under the persistence
 * snapshot key; a changed log (new revision/size snapshot) folds again, so the cache can never serve
 * numbers for a log that has moved on. The cache is memory-only, bounded, and holds no events after
 * folding; reads run with bounded concurrency and an AbortSignal can stop the batch.
 *
 * @param {object} [options] - reader dependencies.
 * @param {(id: string) => Promise<{ session: object, inheritedEventCount?: number, events?: unknown }>} [options.readSession] - the Host's usage seam.
 * @param {(id: string) => unknown} [options.snapshotOf] - optional persistence snapshot provider; absent means no caching.
 * @param {number} [options.limit] - maximum cached Sessions (default 200).
 * @returns {{ readMany: (ids: string[], options?: { snapshotOf?: (id: string) => unknown, signal?: { aborted?: boolean } }) => Promise<{ usage: Record<string, object>, failed: Record<string, 'UNKNOWN_SESSION' | 'READ_FAILED'> }> }}
 */
export function createUsageReader(options = {}) {
  const rawOptions = isPlainObject(options) ? options : {}
  const readSession = typeof rawOptions.readSession === 'function' ? rawOptions.readSession : null
  const baseSnapshotOf = typeof rawOptions.snapshotOf === 'function' ? rawOptions.snapshotOf : null
  const limit =
    typeof rawOptions.limit === 'number' && Number.isFinite(rawOptions.limit) && rawOptions.limit >= 1
      ? Math.floor(rawOptions.limit)
      : DEFAULT_CACHE_LIMIT
  /** @type {Map<string, object>} */
  const cache = new Map()

  /**
   * Store one folded Session, evicting the oldest half once the bound is exceeded.
   * @param {string} key - snapshot cache key.
   * @param {object} folded - §4.10 usage projection.
   * @returns {void}
   */
  function remember(key, folded) {
    cache.set(key, folded)
    if (cache.size <= limit) return
    const dropCount = Math.max(1, Math.ceil(cache.size / 2))
    let dropped = 0
    for (const cachedKey of cache.keys()) {
      if (dropped >= dropCount) break
      cache.delete(cachedKey)
      dropped += 1
    }
  }

  /**
   * Ask the (optional) snapshot provider, degrading to "no snapshot" when it is absent or throws.
   * @param {((id: string) => unknown) | null} snapshotOf - provider.
   * @param {string} id - session id.
   * @returns {Promise<unknown>}
   */
  async function readSnapshot(snapshotOf, id) {
    if (snapshotOf === null) return null
    try {
      return await snapshotOf(id)
    } catch {
      return null
    }
  }

  /**
   * Read and fold one Session, classifying a failure per id. Never throws.
   * @param {string} id - session id.
   * @param {((id: string) => unknown) | null} snapshotOf - snapshot provider for the cache key.
   * @param {{ aborted?: boolean } | null | undefined} signal - cancellation probe.
   * @returns {Promise<{ usage: object } | { failed: 'UNKNOWN_SESSION' | 'READ_FAILED' } | null>} the
   *   folded outcome, or null when the request was aborted before this read started.
   */
  async function foldOne(id, snapshotOf, signal) {
    try {
      if (readSession === null) throw new Error('The session query seam is unavailable.')
      const snapshot = await readSnapshot(snapshotOf, id)
      // Aborted while resolving the snapshot: do not start the expensive log read for this id.
      if (signal?.aborted === true) return null
      const key = cacheKeyOf(id, snapshot)
      if (key !== null) {
        const cached = cache.get(key)
        if (cached !== undefined) return { usage: { ...cached } }
      }
      const observation = await readSession(id)
      if (isMissingHeader(observation)) return { failed: 'UNKNOWN_SESSION' }
      const folded = foldUsage(observation.events, observation.inheritedEventCount)
      if (key !== null) remember(key, folded)
      return { usage: { ...folded } }
    } catch (error) {
      return { failed: isUnknownSessionFailure(error) ? 'UNKNOWN_SESSION' : 'READ_FAILED' }
    }
  }

  /**
   * Fold the requested ids with at most {@link READ_CONCURRENCY} Session reads in flight.
   *
   * One bad Session never rejects the batch: it becomes that id's `failed` entry (`UNKNOWN_SESSION`
   * for a missing id, `READ_FAILED` for anything else) while the rest fold. An optional AbortSignal
   * stops the batch from starting new reads and answers with whatever was already folded. Both maps
   * are null-prototype objects, so a Session id that happens to be a prototype key (`__proto__`,
   * `constructor`, …) is stored as ordinary data instead of mutating the map's prototype.
   *
   * @param {unknown} ids - session ids to fold.
   * @param {{ snapshotOf?: (id: string) => unknown, signal?: { aborted?: boolean } }} [callOptions] -
   *   per-call snapshot override and cancellation.
   * @returns {Promise<{ usage: Record<string, object>, failed: Record<string, 'UNKNOWN_SESSION' | 'READ_FAILED'> }>}
   */
  async function readMany(ids, callOptions = {}) {
    // Null-prototype maps: an id such as "__proto__" must be a normal row, never a prototype change.
    /** @type {Record<string, object>} */
    const usage = Object.create(null)
    /** @type {Record<string, 'UNKNOWN_SESSION' | 'READ_FAILED'>} */
    const failed = Object.create(null)
    const options = isPlainObject(callOptions) ? callOptions : {}
    const snapshotOf = typeof options.snapshotOf === 'function' ? options.snapshotOf : baseSnapshotOf
    const signal = options.signal
    if (!Array.isArray(ids)) return { usage, failed }
    /** @type {string[]} */
    const unique = []
    /** @type {Set<string>} */
    const seen = new Set()
    for (const rawId of ids) {
      if (typeof rawId !== 'string' || rawId === '' || seen.has(rawId)) continue
      seen.add(rawId)
      unique.push(rawId)
    }
    /** @type {Map<string, { usage?: object, failed?: 'UNKNOWN_SESSION' | 'READ_FAILED' }>} */
    const outcomes = new Map()
    let cursor = 0
    /**
     * Claim ids in request order until the list is drained or the request was aborted.
     * @returns {Promise<void>}
     */
    const worker = async () => {
      for (;;) {
        if (signal?.aborted === true) return
        const index = cursor
        if (index >= unique.length) return
        cursor += 1
        const id = unique[index]
        const outcome = await foldOne(id, snapshotOf, signal)
        if (outcome !== null) outcomes.set(id, outcome)
      }
    }
    const workerCount = Math.min(READ_CONCURRENCY, unique.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    // Assemble in request order so the wire map is deterministic even though reads finish out of order.
    for (const id of unique) {
      const outcome = outcomes.get(id)
      if (outcome === undefined) continue
      if (outcome.failed !== undefined) failed[id] = outcome.failed
      else if (outcome.usage !== undefined) usage[id] = outcome.usage
    }
    return { usage, failed }
  }

  return { readMany }
}
