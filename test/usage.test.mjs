/**
 * Contract tests for lib/usage.js (SPEC §5.11, §4.10): the pure usage fold and the bounded cached
 * reader. No Host, no filesystem, no clock — every dependency is a plain fake, so these cases pin the
 * arithmetic and de-duplication rules the UI's "numbers a user decides with" are built on.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { foldUsage, emptyUsage, createUsageReader } from '../lib/usage.js'

/** The SPEC §4.10 wire shape of one per-Session usage row. */
const USAGE_KEYS = [
  'cacheMissInputTokens',
  'cacheReadInputTokens',
  'cacheWriteTokens',
  'complete',
  'duplicateRequests',
  'inheritedEvents',
  'note',
  'outputTokens',
  'requestCount',
  'totalTokens',
].sort()

/**
 * One `assistant/message` event carrying a usage report.
 * @param {object} usage - token fields.
 * @param {string | undefined} messageId - assistant message id (omitted when undefined).
 * @param {object} [extra] - extra event fields.
 * @returns {object}
 */
function assistantEvent(usage, messageId, extra = {}) {
  /** @type {object} */
  const data = { usage }
  if (messageId !== undefined) data.message = { id: messageId }
  return { type: 'assistant/message', data, ...extra }
}

/** A usage report that is easy to trace through the buckets. */
function usageOf(inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens) {
  return { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }
}

/** Assert the wire shape of a folded row and return it. */
function assertUsageShape(row, label = 'usage') {
  assert.deepEqual(Object.keys(row).sort(), USAGE_KEYS, `${label} keys`)
  assert.equal(typeof row.complete, 'boolean', `${label}.complete`)
  assert.equal(typeof row.note === 'string' || row.note === null, true, `${label}.note`)
  for (const field of ['cacheReadInputTokens', 'cacheMissInputTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens', 'requestCount', 'inheritedEvents', 'duplicateRequests']) {
    assert.ok(Number.isFinite(row[field]), `${label}.${field} must be a finite number`)
    assert.ok(row[field] >= 0, `${label}.${field} must be non-negative`)
  }
  assert.equal(row.totalTokens, row.cacheMissInputTokens + row.cacheReadInputTokens + row.outputTokens, `${label}: total = miss + read + output`)
  return row
}

describe('foldUsage: which events count (SPEC §5.11)', () => {
  test('counts only assistant/message events that carry a data.usage object', () => {
    const events = [
      // Other event types contribute nothing even when they happen to carry usage-shaped data.
      { type: 'user/message', data: { message: { id: 'u1' }, usage: usageOf(1000, 1000, 1000, 1000) } },
      { type: 'assistant/thinking', data: { usage: usageOf(1000, 1000, 1000, 1000) } },
      { type: 'session/metadata', data: { usage: usageOf(1000, 1000, 1000, 1000) } },
      // An assistant message without a usage object is not a model answer to bill.
      { type: 'assistant/message', data: { message: { id: 'no-usage' } } },
      { type: 'assistant/message', data: { message: { id: 'null-usage' }, usage: null } },
      { type: 'assistant/message', data: { message: { id: 'string-usage' }, usage: 'lots' } },
      // Junk entries never throw.
      null,
      42,
      {},
      // The one real answer.
      assistantEvent(usageOf(900, 50, 100, 20), 'm1'),
    ]
    const row = assertUsageShape(foldUsage(events, 0))
    assert.deepEqual(
      {
        cacheReadInputTokens: row.cacheReadInputTokens,
        cacheMissInputTokens: row.cacheMissInputTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.totalTokens,
        requestCount: row.requestCount,
      },
      {
        cacheReadInputTokens: 50,
        cacheMissInputTokens: 1000,
        cacheWriteTokens: 100,
        outputTokens: 20,
        totalTokens: 1070,
        requestCount: 1,
      },
    )
    assert.equal(row.complete, true)
    assert.equal(row.note, null)
    assert.equal(row.inheritedEvents, 0)
    assert.equal(row.duplicateRequests, 0)
  })

  test('starts folding only after the inherited prefix', () => {
    const inherited = [assistantEvent(usageOf(5000, 5000, 5000, 5000), 'ancestor-1'), assistantEvent(usageOf(5000, 5000, 5000, 5000), 'ancestor-2')]
    const own = [assistantEvent(usageOf(10, 1, 2, 3), 'own-1')]
    const row = assertUsageShape(foldUsage([...inherited, ...own], 2))
    assert.equal(row.requestCount, 1, 'the ancestor requests are not re-counted by the fork')
    assert.equal(row.totalTokens, 10 + 2 + 1 + 3)
    assert.equal(row.inheritedEvents, 2)
    assert.equal(row.complete, true)
  })

  test('a log fully covered by its inherited prefix reports zero usage and complete', () => {
    const events = [
      assistantEvent(usageOf(5000, 5000, 5000, 5000), 'ancestor-1'),
      assistantEvent(usageOf(5000, 5000, 5000, 5000), 'ancestor-2'),
      assistantEvent(usageOf(5000, 5000, 5000, 5000), 'ancestor-3'),
    ]
    for (const inheritedEventCount of [3, 4, 99]) {
      const row = assertUsageShape(foldUsage(events, inheritedEventCount))
      assert.deepEqual(
        [row.cacheReadInputTokens, row.cacheMissInputTokens, row.cacheWriteTokens, row.outputTokens, row.totalTokens, row.requestCount, row.duplicateRequests],
        [0, 0, 0, 0, 0, 0, 0],
        `inheritedEventCount ${inheritedEventCount}`,
      )
      assert.equal(row.complete, true, 'a fork that made no request of its own has nothing incomplete')
      assert.equal(row.note, null)
    }
  })

  test('an empty or absent event log folds to zero', () => {
    for (const events of [[], null, undefined]) {
      const row = assertUsageShape(foldUsage(events, 0))
      assert.equal(row.totalTokens, 0)
      assert.equal(row.requestCount, 0)
      assert.equal(row.complete, true)
    }
  })
})

describe('foldUsage: de-duplication and completeness (SPEC §5.11)', () => {
  test('counts a repeated message id once and reports duplicateRequests', () => {
    const events = [
      assistantEvent(usageOf(100, 10, 1, 5), 'm1'),
      assistantEvent(usageOf(100, 10, 1, 5), 'm1'),
      assistantEvent(usageOf(100, 10, 1, 5), 'm1'),
      assistantEvent(usageOf(7, 2, 0, 3), 'm2'),
    ]
    const row = assertUsageShape(foldUsage(events, 0))
    assert.equal(row.requestCount, 2, 'two distinct model requests')
    assert.equal(row.duplicateRequests, 2, 'two repeats of m1')
    assert.equal(row.totalTokens, 100 + 1 + 10 + 5 + 7 + 2 + 0 + 3, 'each distinct request counted exactly once')
    assert.equal(row.complete, true)
  })

  test('counts a request without a usable message id and reports incomplete with an English note', () => {
    const events = [
      assistantEvent(usageOf(100, 10, 1, 5), 'm1'),
      assistantEvent(usageOf(20, 2, 0, 1)),
      assistantEvent(usageOf(30, 3, 0, 2), ''),
    ]
    const row = assertUsageShape(foldUsage(events, 0))
    assert.equal(row.requestCount, 3, 'an unidentifiable request is still counted')
    assert.equal(row.totalTokens, 100 + 1 + 10 + 5 + 20 + 2 + 0 + 1 + 30 + 3 + 0 + 2)
    assert.equal(row.complete, false)
    assert.equal(typeof row.note, 'string')
    assert.ok(row.note.trim().length > 0, 'the note must explain why the numbers may be incomplete')
    assert.equal(row.duplicateRequests, 0, 'a missing id cannot be de-duplicated, not reported as a duplicate')
  })

  test('a malformed message container counts as an unusable id rather than throwing', () => {
    const row = assertUsageShape(foldUsage([
      assistantEvent(usageOf(10, 0, 0, 1), undefined),
      { type: 'assistant/message', data: { usage: usageOf(10, 0, 0, 1), message: null } },
      { type: 'assistant/message', data: { usage: usageOf(10, 0, 0, 1), message: 'm-string' } },
      { type: 'assistant/message', data: null },
    ], 0))
    assert.equal(row.requestCount, 3)
    assert.equal(row.complete, false)
  })
})

describe('foldUsage: the four buckets and token hygiene (SPEC §4.10)', () => {
  test('counts cacheWriteTokens in the miss bucket exactly once', () => {
    const row = assertUsageShape(foldUsage([assistantEvent(usageOf(900, 50, 100, 20), 'm1')], 0))
    assert.equal(row.cacheReadInputTokens, 50, 'cacheReadTokens -> read bucket')
    assert.equal(row.cacheMissInputTokens, 1000, 'inputTokens + cacheWriteTokens -> miss bucket')
    assert.equal(row.cacheWriteTokens, 100, 'cacheWriteTokens is reported alongside the miss bucket')
    assert.equal(row.outputTokens, 20)
    assert.equal(row.totalTokens, 1070, 'total is miss + read + output; the cache write is not added twice')
  })

  test('sums the buckets across requests and keeps the three-way share addable', () => {
    const row = assertUsageShape(foldUsage([
      assistantEvent(usageOf(100, 1000, 0, 10), 'm1'),
      assistantEvent(usageOf(0, 500, 50, 5), 'm2'),
      assistantEvent(usageOf(200, 0, 0, 0), 'm3'),
    ], 0))
    assert.equal(row.cacheReadInputTokens, 1500)
    assert.equal(row.cacheMissInputTokens, 350)
    assert.equal(row.cacheWriteTokens, 50)
    assert.equal(row.outputTokens, 15)
    assert.equal(row.requestCount, 3)
    // The Client renders a three-way share bar: miss + read + output must equal total exactly.
    const shareSum = row.cacheMissInputTokens + row.cacheReadInputTokens + row.outputTokens
    assert.equal(shareSum, row.totalTokens)
  })

  test('folds negative, non-numeric and non-finite token fields to zero', () => {
    const row = assertUsageShape(foldUsage([
      { type: 'assistant/message', data: { message: { id: 'bad' }, usage: { inputTokens: -5, cacheReadTokens: NaN, cacheWriteTokens: '100', outputTokens: Infinity } } },
      { type: 'assistant/message', data: { message: { id: 'missing' }, usage: {} } },
      { type: 'assistant/message', data: { message: { id: 'nulls' }, usage: { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null } } },
    ], 0))
    assert.deepEqual(
      [row.cacheReadInputTokens, row.cacheMissInputTokens, row.cacheWriteTokens, row.outputTokens, row.totalTokens],
      [0, 0, 0, 0, 0],
    )
    assert.equal(row.requestCount, 3, 'a malformed usage report is still a counted request')
    assert.equal(row.complete, true, 'the message ids were usable')
  })
})

describe('foldUsage: defensive input handling', () => {
  test('never throws for junk input and returns the zero row', () => {
    for (const events of [undefined, null, 0, 'not-an-array', {}, [null, undefined, [], true]]) {
      assert.doesNotThrow(() => foldUsage(events, 0))
      const row = foldUsage(events, 0)
      assert.equal(row.complete, true)
      assert.equal(row.totalTokens, 0)
    }
  })

  test('never throws for a junk inherited count', () => {
    const events = [assistantEvent(usageOf(10, 0, 0, 1), 'm1')]
    for (const inherited of [undefined, null, -1, NaN, 1.5, '2']) {
      assert.doesNotThrow(() => foldUsage(events, inherited), `inherited=${String(inherited)}`)
    }
  })
})

describe('emptyUsage helper', () => {
  test('is the zero row with the inherited count carried through', () => {
    const zero = assertUsageShape(emptyUsage())
    assert.equal(zero.totalTokens, 0)
    assert.equal(zero.complete, true)
    const inherited = emptyUsage(7)
    assert.equal(inherited.inheritedEvents, 7)
    assert.equal(inherited.totalTokens, 0)
  })
})

// #region cached reader (SPEC §5.11) ------------------------------------------------------------

/**
 * Build a reader world: a controllable `readSession` plus a per-id persistence snapshot map.
 * @param {object} [options] - `{ limit, snapshots }`.
 */
function makeReaderWorld(options = {}) {
  /** @type {string[]} */
  const calls = []
  /** @type {Map<string, object | Error>} */
  const sessions = new Map()
  /** @type {Map<string, object>} */
  const snapshots = new Map(options.snapshots ?? [])
  const readSession = async (id) => {
    calls.push(id)
    const value = sessions.get(id)
    if (value instanceof Error) throw value
    return value
  }
  const snapshotOf = options.snapshotOf === undefined
    ? async (id) => snapshots.get(id) ?? null
    : options.snapshotOf
  const reader = createUsageReader({
    readSession,
    ...(options.noSnapshotOf === true ? {} : { snapshotOf }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  })
  return { reader, calls, sessions, snapshots }
}

/** One readable session value for the fake `readSession`. */
function storedSession(id, events, inheritedEventCount = 0) {
  return { session: { id }, inheritedEventCount, events }
}

describe('createUsageReader: snapshot-keyed cache (SPEC §5.11)', () => {
  test('answers a cached Session from memory while its snapshot key is unchanged', async () => {
    const world = makeReaderWorld({ snapshots: [['s1', { eventCount: 1, sizeBytes: 2 }]] })
    world.sessions.set('s1', storedSession('s1', [assistantEvent(usageOf(10, 0, 0, 1), 'm1')]))
    const first = await world.reader.readMany(['s1'])
    const second = await world.reader.readMany(['s1'])
    assert.deepEqual(world.calls, ['s1'], 'one read per unchanged Session')
    assert.deepEqual(second, first)
    assert.equal(first.usage.s1.totalTokens, 11)
    assert.deepEqual(Object.keys(first.failed), [], 'no failed entries')
  })

  test('re-folds when the snapshot eventCount changes', async () => {
    const world = makeReaderWorld({ snapshots: [['s1', { eventCount: 1, sizeBytes: 2 }]] })
    world.sessions.set('s1', storedSession('s1', [assistantEvent(usageOf(10, 0, 0, 1), 'm1')]))
    await world.reader.readMany(['s1'])
    world.sessions.set('s1', storedSession('s1', [
      assistantEvent(usageOf(10, 0, 0, 1), 'm1'),
      assistantEvent(usageOf(5, 0, 0, 1), 'm2'),
    ]))
    world.snapshots.set('s1', { eventCount: 2, sizeBytes: 2 })
    const refreshed = await world.reader.readMany(['s1'])
    assert.deepEqual(world.calls, ['s1', 's1'], 'a changed log is re-read')
    assert.equal(refreshed.usage.s1.requestCount, 2)
    assert.equal(refreshed.usage.s1.totalTokens, 10 + 1 + 5 + 1)
  })

  test('re-folds when the snapshot sizeBytes changes even if eventCount did not', async () => {
    const world = makeReaderWorld({ snapshots: [['s1', { eventCount: 1, sizeBytes: 10 }]] })
    world.sessions.set('s1', storedSession('s1', [assistantEvent(usageOf(10, 0, 0, 1), 'm1')]))
    await world.reader.readMany(['s1'])
    world.snapshots.set('s1', { eventCount: 1, sizeBytes: 11 })
    await world.reader.readMany(['s1'])
    assert.deepEqual(world.calls, ['s1', 's1'])
  })

  test('does not cache a Session whose snapshot is absent or unusable', async () => {
    for (const snapshots of [[], [['s1', null]], [['s1', { eventCount: NaN, sizeBytes: 2 }]], [['s1', { eventCount: 1 }]]]) {
      const world = makeReaderWorld({ snapshots })
      world.sessions.set('s1', storedSession('s1', [assistantEvent(usageOf(10, 0, 0, 1), 'm1')]))
      await world.reader.readMany(['s1'])
      await world.reader.readMany(['s1'])
      assert.equal(world.calls.length, 2, `snapshot ${JSON.stringify(snapshots)} must disable the cache`)
    }
  })

  test('accepts a request-scoped snapshot source that overrides the reader default', async () => {
    const world = makeReaderWorld({ noSnapshotOf: true })
    world.sessions.set('s1', storedSession('s1', [assistantEvent(usageOf(10, 0, 0, 1), 'm1')]))
    const snapshotOf = async () => ({ eventCount: 1, sizeBytes: 2 })
    await world.reader.readMany(['s1'], { snapshotOf })
    await world.reader.readMany(['s1'], { snapshotOf })
    assert.deepEqual(world.calls, ['s1'], 'the engine passes one request-scoped listing and gets caching')
  })

  test('is bounded to limit and evicts the oldest entries', async () => {
    const world = makeReaderWorld({
      limit: 2,
      snapshots: [
        ['a', { eventCount: 1, sizeBytes: 1 }],
        ['b', { eventCount: 1, sizeBytes: 1 }],
        ['c', { eventCount: 1, sizeBytes: 1 }],
      ],
    })
    for (const id of ['a', 'b', 'c']) world.sessions.set(id, storedSession(id, [assistantEvent(usageOf(1, 0, 0, 1), `m-${id}`)]))
    await world.reader.readMany(['a'])
    await world.reader.readMany(['b'])
    await world.reader.readMany(['a']) // cache hit
    await world.reader.readMany(['c']) // pushes the cache past limit -> the oldest half is evicted
    await world.reader.readMany(['a'])
    assert.deepEqual(world.calls.filter((id) => id === 'a').length, 2, 'a was evicted by the bound and re-read')
    assert.deepEqual(world.calls.filter((id) => id === 'b').length, 1, 'b stayed cached until the bound pushed it out')
    assert.deepEqual(world.calls.filter((id) => id === 'c').length, 1)
  })

  test('an empty id list answers empty maps without reading anything', async () => {
    const world = makeReaderWorld()
    const result = await world.reader.readMany([])
    assert.deepEqual(Object.keys(result).sort(), ['failed', 'usage'])
    assert.deepEqual(Object.keys(result.usage), [])
    assert.deepEqual(Object.keys(result.failed), [])
    assert.equal(Object.getPrototypeOf(result.usage), null, 'the usage map is prototype-free')
    assert.equal(Object.getPrototypeOf(result.failed), null, 'the failed map is prototype-free')
    assert.deepEqual(world.calls, [])
  })
})

describe('createUsageReader: per-id failure classification (SPEC §4.10)', () => {
  test('classifies a missing Session as UNKNOWN_SESSION and a broken read as READ_FAILED', async () => {
    const world = makeReaderWorld({
      snapshots: [
        ['ok', { eventCount: 1, sizeBytes: 1 }],
        ['enoent', { eventCount: 1, sizeBytes: 1 }],
        ['named', { eventCount: 1, sizeBytes: 1 }],
        ['broken', { eventCount: 1, sizeBytes: 1 }],
        ['headerless', { eventCount: 1, sizeBytes: 1 }],
      ],
    })
    world.sessions.set('ok', storedSession('ok', [assistantEvent(usageOf(10, 0, 0, 1), 'm1')]))
    world.sessions.set('enoent', Object.assign(new Error('no such session'), { code: 'ENOENT' }))
    const named = new Error('session vanished')
    named.name = 'SessionPersistenceNotFoundError'
    world.sessions.set('named', named)
    world.sessions.set('broken', new Error('the log is corrupt'))
    world.sessions.set('headerless', { inheritedEventCount: 0, events: [] })

    const result = await world.reader.readMany(['ok', 'enoent', 'named', 'broken', 'headerless'])
    assert.deepEqual(Object.keys(result.usage), ['ok'], 'the healthy id still folds')
    assert.equal(result.usage.ok.totalTokens, 11)
    assert.deepEqual({ ...result.failed }, {
      enoent: 'UNKNOWN_SESSION',
      named: 'UNKNOWN_SESSION',
      broken: 'READ_FAILED',
      headerless: 'UNKNOWN_SESSION',
    })
  })

  test('always returns both maps, with plain string codes', async () => {
    const world = makeReaderWorld({ snapshots: [['broken', { eventCount: 1, sizeBytes: 1 }]] })
    world.sessions.set('broken', new Error('boom'))
    const result = await world.reader.readMany(['broken'])
    assert.deepEqual(Object.keys(result).sort(), ['failed', 'usage'])
    assert.deepEqual(Object.keys(result.usage), [])
    assert.deepEqual({ ...result.failed }, { broken: 'READ_FAILED' })
    for (const value of Object.values(result.failed)) assert.equal(typeof value, 'string')
  })

  test('folds the inherited prefix reported next to the header', async () => {
    const world = makeReaderWorld({ snapshots: [['fork', { eventCount: 3, sizeBytes: 3 }]] })
    world.sessions.set('fork', storedSession('fork', [
      assistantEvent(usageOf(5000, 5000, 5000, 5000), 'ancestor'),
      assistantEvent(usageOf(4, 1, 0, 2), 'own'),
    ], 1))
    const result = await world.reader.readMany(['fork'])
    assert.equal(result.usage.fork.requestCount, 1)
    assert.equal(result.usage.fork.inheritedEvents, 1)
    assert.equal(result.usage.fork.totalTokens, 4 + 0 + 1 + 2)
  })
})

describe('createUsageReader: real DSH JSONL snapshot identity (revision fallback)', () => {
  /** The shipped JSONL backend's snapshot shape: no eventCount, an opaque revision. */
  function realSnapshot(id, revision, sizeBytes = 128) {
    return {
      header: { id, createdAt: 1 },
      formatStatus: 'current',
      revision,
      sizeBytes,
      location: { path: `/sessions/--p--/${id}/log.jsonl` },
    }
  }

  test('caches by the revision when the snapshot has no eventCount and re-folds when it changes', async () => {
    const world = makeReaderWorld({ snapshots: [['s1', realSnapshot('s1', 'rev-1')]] })
    world.sessions.set('s1', storedSession('s1', [assistantEvent(usageOf(10, 0, 0, 1), 'm1')]))
    const first = await world.reader.readMany(['s1'])
    const second = await world.reader.readMany(['s1'])
    assert.deepEqual(world.calls, ['s1'], 'an unchanged revision is answered from memory')
    assert.deepEqual(second.usage.s1, first.usage.s1)
    assert.equal(first.usage.s1.totalTokens, 11)
    // A changed revision is a changed log: it must be read again.
    world.sessions.set('s1', storedSession('s1', [
      assistantEvent(usageOf(10, 0, 0, 1), 'm1'),
      assistantEvent(usageOf(5, 0, 0, 1), 'm2'),
    ]))
    world.snapshots.set('s1', realSnapshot('s1', 'rev-2'))
    const refreshed = await world.reader.readMany(['s1'])
    assert.deepEqual(world.calls, ['s1', 's1'], 'a changed revision re-reads the log')
    assert.equal(refreshed.usage.s1.requestCount, 2)
    assert.equal(refreshed.usage.s1.totalTokens, 10 + 1 + 5 + 1)
  })

  test('treats a size change under the same revision as a changed log too', async () => {
    const world = makeReaderWorld({ snapshots: [['s1', realSnapshot('s1', 'rev-1', 10)]] })
    world.sessions.set('s1', storedSession('s1', [assistantEvent(usageOf(10, 0, 0, 1), 'm1')]))
    await world.reader.readMany(['s1'])
    world.snapshots.set('s1', realSnapshot('s1', 'rev-1', 11))
    await world.reader.readMany(['s1'])
    assert.deepEqual(world.calls, ['s1', 's1'])
  })

  test('caches a revision-only snapshot and skips a snapshot with no change token', async () => {
    const revisionOnly = makeReaderWorld({ snapshots: [['s1', { revision: 'rev-1' }]] })
    revisionOnly.sessions.set('s1', storedSession('s1', [assistantEvent(usageOf(1, 0, 0, 1), 'm1')]))
    await revisionOnly.reader.readMany(['s1'])
    await revisionOnly.reader.readMany(['s1'])
    assert.deepEqual(revisionOnly.calls, ['s1'], 'a revision alone is a usable change token')

    const unusable = makeReaderWorld({ snapshots: [['s1', { header: { id: 's1' } }]] })
    unusable.sessions.set('s1', storedSession('s1', [assistantEvent(usageOf(1, 0, 0, 1), 'm1')]))
    await unusable.reader.readMany(['s1'])
    await unusable.reader.readMany(['s1'])
    assert.equal(unusable.calls.length, 2, 'no revision and no eventCount means no caching')
  })
})

describe('createUsageReader: prototype-safe ids', () => {
  test('keeps "__proto__" and "constructor" ids as ordinary data rows', async () => {
    const world = makeReaderWorld({
      snapshots: [
        ['__proto__', { revision: 'rev-proto' }],
        ['constructor', { revision: 'rev-ctor' }],
      ],
    })
    world.sessions.set('__proto__', storedSession('__proto__', [assistantEvent(usageOf(10, 2, 3, 1), 'm1')]))
    world.sessions.set('constructor', Object.assign(new Error('the log is corrupt')))
    const result = await world.reader.readMany(['__proto__', 'constructor'])
    assert.equal(Object.getPrototypeOf(result.usage), null, 'the usage map is null-prototype')
    assert.equal(Object.getPrototypeOf(result.failed), null, 'the failed map is null-prototype')
    assert.deepEqual(Object.keys(result.usage), ['__proto__'], 'the id is an own data property')
    assert.deepEqual(Object.keys(result.failed), ['constructor'])
    assert.equal(result.usage['__proto__'].totalTokens, 10 + 3 + 2 + 1)
    assert.equal(result.failed['constructor'], 'READ_FAILED')
    assert.equal(Object.prototype.polluted, undefined, 'nothing leaked onto Object.prototype')
  })
})

describe('createUsageReader: bounded concurrency + cancellation (SPEC §4.10/§5.11)', () => {
  test('reads at most four Sessions at once and assembles the maps in request order', async () => {
    let inFlight = 0
    let peak = 0
    const ids = Array.from({ length: 12 }, (_, index) => `s${index}`)
    const reader = createUsageReader({
      async readSession(id) {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return { session: { id }, events: [] }
      },
      snapshotOf: (id) => ({ revision: `rev-${id}` }),
    })
    const result = await reader.readMany(ids)
    assert.equal(result.usage.s0.totalTokens, 0)
    assert.equal(peak, 4, 'the batch never exceeds four concurrent log reads')
    assert.deepEqual(Object.keys(result.usage), ids, 'rows are assembled in request order')
  })

  test('stops starting new reads once the signal aborts and answers with what it has', async () => {
    const controller = new AbortController()
    const calls = []
    const reader = createUsageReader({
      async readSession(id) {
        calls.push(id)
        // Abort while the first (already started) read is in flight.
        controller.abort()
        return { session: { id }, events: [assistantEvent(usageOf(1, 0, 0, 1), `m-${id}`)] }
      },
      snapshotOf: (id) => ({ revision: `rev-${id}` }),
    })
    const result = await reader.readMany(['s1', 's2', 's3', 's4', 's5'], { signal: controller.signal })
    assert.deepEqual(Object.keys(result.usage), ['s1'], 'the read that already started is kept')
    assert.equal(result.usage.s1.totalTokens, 2)
    assert.ok(!calls.includes('s5'), 'no read starts after the abort')
    assert.ok(calls.length < 5)
  })

  test('an already-aborted signal starts no read at all', async () => {
    const controller = new AbortController()
    controller.abort()
    const world = makeReaderWorld()
    world.sessions.set('s1', storedSession('s1', [assistantEvent(usageOf(1, 0, 0, 1), 'm1')]))
    const result = await world.reader.readMany(['s1'], { signal: controller.signal })
    assert.deepEqual(Object.keys(result.usage), [])
    assert.deepEqual(Object.keys(result.failed), [])
    assert.deepEqual(world.calls, [])
  })
})

// #endregion

// #endregion
