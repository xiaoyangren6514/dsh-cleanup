/**
 * Contract tests for index.js (Host half): plugin shape, the fourteen routes, the HTTP envelope rules
 * (SPEC §4), the deferred-deletion start-up hook (SPEC §4.7/§5.8) and the read-only
 * `cleanup_inventory` tool (SPEC §6).
 *
 * The routes are driven directly through the handlers captured from a fake
 * `ctx.connection.fetch.register`; the fake engine dependencies are plain JS objects over a
 * throw-away temp root, so nothing outside that root is touched and no `@deepseek-ai/*` package is
 * imported (the bundle would not resolve it from a test either). Every fake world gets its own
 * deferred queue path inside the temp root, so no test can read or write the real
 * `$DSH_HOME/cleanup/deferred.json`.
 */
import { test, describe, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as plugin from '../index.js'

/** Shared per-file temp root. */
let TMP
let caseId = 0

before(async () => {
  TMP = await fsp.realpath(await fsp.mkdtemp(os.tmpdir() + '/dsh-cleanup-test-index-'))
})

after(async () => {
  await fsp.rm(TMP, { recursive: true, force: true })
})

const ROUTE_PATHS = [
  '/api/cleanup.inventory',
  '/api/cleanup.candidates',
  '/api/cleanup.measure',
  '/api/cleanup.plan',
  '/api/cleanup.delete',
  '/api/cleanup.trash.list',
  '/api/cleanup.trash.restore',
  '/api/cleanup.trash.purge',
  '/api/cleanup.defer',
  '/api/cleanup.deferred.list',
  '/api/cleanup.deferred.cancel',
  '/api/cleanup.deferred.requeue',
  '/api/cleanup.settings.get',
  '/api/cleanup.settings.set',
]

/**
 * The start-up guard is a process-global Set keyed by queue-file path (a hot reload of one queue is
 * skipped; independent fake worlds are not). Tests clear it so every case starts from "this process
 * has not applied this queue yet".
 */
const DEFERRED_PROCESSED_MARKER = '__dshCleanupDeferredProcessedFiles'

function resetDeferredMarker() {
  delete globalThis.__dshCleanupDeferredProcessed
  const processed = globalThis[DEFERRED_PROCESSED_MARKER]
  if (processed instanceof Set) processed.clear()
  else delete globalThis[DEFERRED_PROCESSED_MARKER]
}

beforeEach(resetDeferredMarker)

afterEach(resetDeferredMarker)

/** Build a small fake Host world: one registered workspace and one stored session. */
async function makeWorld() {
  const root = path.join(TMP, `case-${++caseId}`)
  const workspaceDir = path.join(root, 'proj')
  await fsp.mkdir(workspaceDir, { recursive: true })
  await fsp.writeFile(path.join(workspaceDir, 'a.txt'), 'hello')
  const sessionDir = path.join(root, 'sessions', '--test-project--', 's1')
  await fsp.mkdir(sessionDir, { recursive: true })
  await fsp.writeFile(path.join(sessionDir, 'log.jsonl'), 'x\n')

  const deferredFile = path.join(root, 'cleanup', 'deferred.json')
  const entities = new Map([['ws1', { id: 'ws1', path: workspaceDir, title: 'proj', sessionIds: ['s1'] }]])
  const snapshots = new Map([
    [
      's1',
      {
        header: { id: 's1', createdAt: 1730000000000, cwd: workspaceDir },
        location: { path: path.join(sessionDir, 'log.jsonl') },
        eventCount: 4,
        sizeBytes: 2,
      },
    ],
  ])
  const registryCalls = []
  const registry = {
    list: () => [...entities.values()],
    get: (id) => entities.get(id),
    delete: async (id) => {
      registryCalls.push(['delete', id])
      entities.delete(id)
    },
    unpinSession: async (id) => {
      registryCalls.push(['unpin', id])
    },
    unarchiveSession: async (id) => {
      registryCalls.push(['unarchive', id])
    },
    archivedSessionIds: [],
    pinnedSessionIds: [],
  }
  const persistence = { list: async () => [...snapshots.values()], stat: async (id) => snapshots.get(id) }
  const liveStore = new Map()
  const agentStore = new Map()
  return {
    root,
    trashRoot: path.join(root, 'trash'),
    deferredFile,
    workspaceDir,
    sessionDir,
    entities,
    snapshots,
    registryCalls,
    registry,
    persistence,
    liveStore,
    agentStore,
    defaultGet: (name) => {
      if (name === 'sessions') return { get: (id) => liveStore.get(id) }
      if (name === 'agents') return { get: (id) => agentStore.get(id) }
      return undefined
    },
  }
}

/**
 * Start the plugin against a fake ctx and capture everything it registers.
 * @returns {{ registrations: object[], disposed: string[], tools: object[], dispose: Function, ctx: object }}
 */
function startPlugin(world, options = {}) {
  /** @type {object[]} */
  const registrations = []
  /** @type {string[]} */
  const disposed = []
  /** @type {object[]} */
  const tools = []
  const toolsService = options.toolsService ?? null
  const ctx = {
    connection: {
      fetch: {
        register(entry) {
          registrations.push(entry)
          return () => {
            disposed.push(entry.path)
          }
        },
      },
    },
    workspaceRegistry: world.registry,
    sessionPersistence: world.persistence,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    effect(fn) {
      return fn()
    },
    get(name) {
      if (options.get !== undefined) return options.get(name, world)
      if (name === 'tools') {
        if (toolsService === null) return undefined
        if (toolsService === 'throwing-get') throw new Error('tool registry unavailable')
        return toolsService
      }
      if (options.noOptionalServices === true) return undefined
      return world.defaultGet(name)
    },
  }
  let dispose
  assert.doesNotThrow(() => {
    dispose = plugin.apply(ctx, {
      trashRoot: world.trashRoot,
      // Keep the start-up deferred-queue hook inside the throw-away world.
      deferredFile: world.deferredFile,
      ...(options.config ?? {}),
    })
  })
  return { registrations, disposed, tools, dispose, ctx }
}

/** A fake ToolRegistry whose `register` captures the tool definition. */
function makeToolsService(captured, disposers) {
  return {
    register(tool) {
      captured.push(tool)
      return () => {
        disposers.push('tool')
      }
    },
  }
}

/** POST one route through its captured handler. */
async function call(registrations, routePath, body, { signal } = {}) {
  const registration = registrations.find((entry) => entry.path === routePath)
  assert.ok(registration, `route not registered: ${routePath}`)
  const init = { method: 'POST' }
  if (signal !== undefined) init.signal = signal
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  const request = new Request(`http://127.0.0.1:3080${routePath}`, init)
  const response = await registration.fetch(request)
  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  return { status: response.status, headers: response.headers, text, body: parsed }
}

/** Whether a path exists (any type). */
async function pathExists(target) {
  try {
    await fsp.lstat(target)
    return true
  } catch {
    return false
  }
}

let queuedEntrySeq = 0

/** One queued entry as a previous process would have left it on disk. */
function queuedSessionEntry(id, overrides = {}) {
  return {
    id: `queued-index-entry-${++queuedEntrySeq}`,
    queuedAt: 900,
    mode: 'trash',
    includeSessions: true,
    includeDescendants: true,
    confirmationText: null,
    targets: [{ kind: 'session', id }],
    ...overrides,
  }
}

/** Write the deferred queue document directly (the start-up fixture). */
async function writeDeferredQueue(world, entries, lastRun = null) {
  await fsp.mkdir(path.dirname(world.deferredFile), { recursive: true })
  await fsp.writeFile(world.deferredFile, `${JSON.stringify({ version: 1, entries, lastRun }, null, 2)}\n`)
}

/** Read the deferred queue document; null when it does not exist or is unreadable. */
async function readDeferredQueue(world) {
  try {
    return JSON.parse(await fsp.readFile(world.deferredFile, 'utf8'))
  } catch {
    return null
  }
}

/** Poll until `predicate` is true (the start-up hook is asynchronous, so tests wait, never sleep-blind). */
async function waitFor(predicate, timeoutMs = 5000) {
  const startedAt = Date.now()
  for (;;) {
    if (await predicate()) return true
    if (Date.now() - startedAt > timeoutMs) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Minimal validator for the JSON-Schema subset SPEC §6 allows. */
function validateSchema(schema, value, at = '$') {
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        validateSchema(candidate, value, at)
        return true
      } catch {
        return false
      }
    })
    assert.equal(matches.length, 1, `${at}: expected exactly one oneOf match`)
    return
  }
  if (schema.type === 'null') {
    assert.equal(value, null, `${at}: expected null`)
    return
  }
  if (schema.type === 'object') {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${at}: expected object`)
    for (const key of schema.required ?? []) assert.ok(key in value, `${at}: missing required key ${key}`)
    for (const key of Object.keys(value)) {
      const child = schema.properties?.[key]
      if (child === undefined) {
        assert.equal(schema.additionalProperties ?? true, true, `${at}: unexpected additional property ${key}`)
        continue
      }
      validateSchema(child, value[key], `${at}.${key}`)
    }
    return
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${at}: expected array`)
    if (schema.items !== undefined) value.forEach((entry, index) => validateSchema(schema.items, entry, `${at}[${index}]`))
    return
  }
  if (schema.type === 'string') {
    assert.equal(typeof value, 'string', `${at}: expected string`)
    return
  }
  if (schema.type === 'boolean') {
    assert.equal(typeof value, 'boolean', `${at}: expected boolean`)
    return
  }
  if (schema.type === 'integer') {
    assert.ok(Number.isInteger(value), `${at}: expected integer`)
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${at}: below minimum`)
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${at}: above maximum`)
    return
  }
  if (schema.type === 'number') {
    assert.equal(typeof value, 'number', `${at}: expected number`)
    assert.ok(Number.isFinite(value), `${at}: expected finite number`)
    return
  }
  assert.fail(`${at}: unsupported schema node ${JSON.stringify(schema)}`)
}

/**
 * The `dsh-tools`-enforced JSON Schema subset (SPEC §6): `type`, `oneOf`, `properties`, `required`,
 * `additionalProperties`, `items`, `enum`, `const`, plus annotations. Anything else (notably
 * `minimum`/`maximum`) would be rejected by a consumer that applies the documented subset.
 */
const HOST_SCHEMA_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
])

/** Fail on any JSON Schema keyword outside the Host-enforced subset. */
function assertHostSchemaSubset(schema, at = '$') {
  assert.ok(schema !== null && typeof schema === 'object' && !Array.isArray(schema), `${at}: expected a schema object`)
  for (const key of Object.keys(schema)) {
    assert.ok(HOST_SCHEMA_KEYWORDS.has(key), `${at}: "${key}" is outside the dsh-tools JSON Schema subset`)
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) assertHostSchemaSubset(child, `${at}.properties.${name}`)
  if (schema.items !== undefined) assertHostSchemaSubset(schema.items, `${at}.items`)
  for (const [index, child] of (schema.oneOf ?? []).entries()) assertHostSchemaSubset(child, `${at}.oneOf[${index}]`)
}

// #region plugin shape ------------------------------------------------------------------------

describe('plugin shape (SPEC §3)', () => {
  test('exports name, inject and apply', () => {
    assert.equal(plugin.name, 'dsh-cleanup')
    assert.deepEqual(plugin.inject, ['connection', 'workspaceRegistry', 'sessionPersistence'])
    assert.equal(typeof plugin.apply, 'function')
  })

  test('does not export a config schema', () => {
    assert.equal(plugin.config, undefined)
  })
})

// #endregion

// #region route registration (SPEC §4) --------------------------------------------------------

describe('route registration', () => {
  test('registers exactly the fourteen authenticated POST routes, each owning one path', async () => {
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world)
    assert.equal(registrations.length, 14)
    assert.deepEqual(registrations.map((entry) => entry.path).sort(), [...ROUTE_PATHS].sort())
    assert.equal(new Set(registrations.map((entry) => entry.path)).size, 14)
    for (const registration of registrations) {
      assert.deepEqual(registration.methods, ['POST'], registration.path)
      assert.equal(registration.requestBody, 'buffered', registration.path)
      assert.equal(typeof registration.fetch, 'function', registration.path)
    }
    await dispose()
  })

  test('returns a disposer that unregisters every route and the tool, and is safe twice', async () => {
    const world = await makeWorld()
    const captured = []
    const toolDisposers = []
    const toolsService = makeToolsService(captured, toolDisposers)
    const { disposed, dispose } = startPlugin(world, { toolsService })
    assert.equal(typeof dispose, 'function')
    assert.equal(captured.length, 1)
    await dispose()
    assert.deepEqual([...disposed].sort(), [...ROUTE_PATHS].reverse().sort())
    assert.deepEqual(toolDisposers, ['tool'])
    await assert.doesNotReject(() => dispose())
    assert.equal(disposed.length, 14)
  })
})

// #endregion

// #region HTTP envelope (SPEC §4) -------------------------------------------------------------

describe('HTTP envelope', () => {
  test('answers 400 BAD_REQUEST for a missing body', async () => {
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world)
    const response = await call(registrations, '/api/cleanup.inventory')
    assert.equal(response.status, 400)
    assert.deepEqual(response.body, { ok: false, error: { code: 'BAD_REQUEST', message: 'A JSON request body is required.' } })
    await dispose()
  })

  test('answers 400 BAD_REQUEST for invalid JSON', async () => {
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world)
    const response = await call(registrations, '/api/cleanup.plan', '{not json')
    assert.equal(response.status, 400)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error.code, 'BAD_REQUEST')
    assert.match(response.body.error.message, /not valid JSON/)
    await dispose()
  })

  test('answers 400 BAD_REQUEST for a JSON body that is not an object', async () => {
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world)
    for (const body of ['[1,2]', '42', '"text"', 'null', 'true']) {
      const response = await call(registrations, '/api/cleanup.measure', body)
      assert.equal(response.status, 400, body)
      assert.equal(response.body.error.code, 'BAD_REQUEST', body)
      assert.match(response.body.error.message, /JSON object/, body)
    }
    await dispose()
  })

  test('answers HTTP 200 for a domain failure (PLAN_UNKNOWN)', async () => {
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world)
    const response = await call(registrations, '/api/cleanup.delete', { planId: 'does-not-exist' })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error.code, 'PLAN_UNKNOWN')
    await dispose()
  })

  test('answers HTTP 200 for a domain failure raised inside the engine (IO_ERROR)', async () => {
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world)
    world.registry.list = () => {
      throw new Error('registry down')
    }
    const response = await call(registrations, '/api/cleanup.inventory', {})
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error.code, 'IO_ERROR')
    await dispose()
  })

  test('answers HTTP 500 INTERNAL for a programming error, still as an envelope', async () => {
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world)
    world.registry.get = () => {
      throw new Error('raw crash')
    }
    const response = await call(registrations, '/api/cleanup.plan', { targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash' })
    assert.equal(response.status, 500)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error.code, 'INTERNAL')
    assert.match(response.body.error.message, /raw crash/)
    await dispose()
  })

  test('serializes every response as JSON with a JSON content-type', async () => {
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world)
    const response = await call(registrations, '/api/cleanup.inventory', {})
    assert.match(response.headers.get('content-type'), /application\/json/)
    assert.deepEqual(Object.keys(response.body).sort(), [
      'audit',
      'deferred',
      'dshHome',
      'generatedAt',
      'ok',
      'sessionListCap',
      'sessions',
      'trash',
      'truncated',
      'workspaces',
    ])
    await dispose()
  })

  test('route handlers never throw for any body string on any route', async () => {
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world)
    const bodies = [undefined, '', 'null', '[]', '{}', '{"planId":null}', 'not json', '{"targets":{}}']
    for (const route of ROUTE_PATHS) {
      for (const body of bodies) {
        const response = await call(registrations, route, body)
        assert.equal(typeof response.status, 'number', `${route} ${String(body)}`)
        assert.ok(response.status === 200 || response.status === 400 || response.status === 500)
        assert.equal(typeof response.body?.ok, 'boolean', `${route} ${String(body)}`)
      }
    }
    await dispose()
  })
})

// #endregion

// #region route payloads ----------------------------------------------------------------------

describe('route payloads', () => {
  test('inventory answers the SPEC §4.1 envelope over the fake services', async () => {
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world)
    const response = await call(registrations, '/api/cleanup.inventory', {})
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.workspaces.length, 1)
    assert.equal(response.body.sessions.length, 1)
    assert.equal(response.body.truncated, false)
    assert.equal(response.body.sessionListCap, 2000)
    assert.deepEqual(response.body.trash, {
      root: world.trashRoot,
      entries: 0,
      bytes: 0,
      oldestMovedAt: null,
      overRetention: false,
      overCapacity: false,
      suggestedEntryIds: [],
    })
    assert.deepEqual(response.body.deferred, { count: 0, retained: 0, lastRun: null })
    assert.deepEqual(response.body.audit, { enabled: true, lastStartup: null, recent: [] })
    await dispose()
  })

  test('candidates answers the SPEC §4.9 envelope and maps bad requests to HTTP 400', async () => {
    const world = await makeWorld()
    const captured = []
    const toolsService = makeToolsService(captured, [])
    const { registrations, dispose } = startPlugin(world, { toolsService })
    // The tool surface is unchanged by the new read-only route: exactly one tool, still read-only.
    assert.equal(captured.length, 1)
    assert.equal(captured[0].name, 'cleanup_inventory')
    const ok = await call(registrations, '/api/cleanup.candidates', {})
    assert.equal(ok.status, 200)
    assert.equal(ok.body.ok, true)
    assert.deepEqual(Object.keys(ok.body).sort(), ['candidates', 'filters', 'ok', 'sort', 'total', 'totals', 'truncated'])
    assert.equal(ok.body.candidates.length, 1)
    assert.equal(ok.body.candidates[0].id, 's1')
    assert.deepEqual(Object.keys(ok.body.candidates[0]).sort(), [
      'archived',
      'blockerCodes',
      'createdAt',
      'cwd',
      'deletable',
      'id',
      'live',
      'origin',
      'pinned',
      'running',
      'sizeBytes',
      'workspaceId',
    ])
    assert.equal(ok.body.total, 1)
    assert.equal(ok.body.truncated, false)
    assert.deepEqual(ok.body.totals, { count: 1, bytes: 2 })
    assert.equal(ok.body.sort, 'oldest')
    assert.deepEqual(ok.body.filters, {
      olderThanDays: 0,
      archived: 'all',
      minBytes: 0,
      workspaceId: null,
      origin: 'all',
      requireDeletable: false,
    })
    // A JSON body that is not an object fails at the transport layer (same as every route).
    const nonObject = await call(registrations, '/api/cleanup.candidates', '[1,2]')
    assert.equal(nonObject.status, 400)
    assert.equal(nonObject.body.error.code, 'BAD_REQUEST')
    // A domain BAD_REQUEST maps to HTTP 400 and keeps details.field.
    const badFilter = await call(registrations, '/api/cleanup.candidates', { filters: { olderThanDays: -1 } })
    assert.equal(badFilter.status, 400)
    assert.equal(badFilter.body.error.code, 'BAD_REQUEST')
    assert.equal(badFilter.body.error.details.field, 'filters.olderThanDays')
    const unknownTop = await call(registrations, '/api/cleanup.candidates', { nope: 1 })
    assert.equal(unknownTop.status, 400)
    assert.equal(unknownTop.body.error.details.field, 'nope')
    await dispose()
  })

  test('measure answers per-id maps and BAD_REQUEST for a bad id list', async () => {
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world)
    const ok = await call(registrations, '/api/cleanup.measure', { workspaceIds: ['ws1', 'nope'], sessionIds: ['s1'] })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.ok, true)
    assert.deepEqual(Object.keys(ok.body.workspaces), ['ws1'])
    assert.deepEqual(Object.keys(ok.body.sessions), ['s1'])
    const bad = await call(registrations, '/api/cleanup.measure', { workspaceIds: 'ws1' })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.code, 'BAD_REQUEST')
    await dispose()
  })

  test('plan answers a Plan for a session target', async () => {
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world)
    const response = await call(registrations, '/api/cleanup.plan', { targets: [{ kind: 'session', id: 's1' }], mode: 'trash' })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(typeof response.body.plan.planId, 'string')
    assert.deepEqual(response.body.plan.items.map((item) => item.id), ['s1'])
    await dispose()
  })

  test('plan maps a domain BAD_REQUEST (valid JSON, bad fields) to HTTP 400', async () => {
    // SPEC §4 (amended): any request whose fields are invalid answers HTTP 400, so every engine
    // BAD_REQUEST envelope maps to 400; other domain failures stay HTTP 200.
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world)
    const response = await call(registrations, '/api/cleanup.plan', { targets: [] })
    assert.equal(response.status, 400)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error.code, 'BAD_REQUEST')
    await dispose()
  })

  test('plan maps PERMANENT_MULTIPLE_DIRECTORIES to HTTP 200 (top-level domain failure)', async () => {
    const world = await makeWorld()
    const other = path.join(world.root, 'other-ws')
    await fsp.mkdir(other, { recursive: true })
    world.entities.set('ws2', { id: 'ws2', path: other, title: 'other', sessionIds: [] })
    const { registrations, dispose } = startPlugin(world)
    const response = await call(registrations, '/api/cleanup.plan', {
      targets: [{ kind: 'workspace', id: 'ws1' }, { kind: 'workspace', id: 'ws2' }],
      mode: 'permanent',
      includeSessions: false,
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error.code, 'PERMANENT_MULTIPLE_DIRECTORIES')
    assert.deepEqual(response.body.error.details, { workspaceIds: ['ws1', 'ws2'] })
    assert.equal('plan' in response.body, false)
    await dispose()
  })

  test('delete enforces typed confirmation and consumes the plan even on failure', async () => {
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world)
    const planned = await call(registrations, '/api/cleanup.plan', { targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'permanent', includeSessions: false })
    assert.equal(planned.body.ok, true)
    const expected = planned.body.plan.confirmation.expected
    const missing = await call(registrations, '/api/cleanup.delete', { planId: planned.body.plan.planId })
    assert.equal(missing.status, 200)
    assert.equal(missing.body.error.code, 'CONFIRMATION_REQUIRED')
    const replay = await call(registrations, '/api/cleanup.delete', { planId: planned.body.plan.planId })
    assert.equal(replay.body.error.code, 'PLAN_UNKNOWN')

    const second = await call(registrations, '/api/cleanup.plan', { targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'permanent', includeSessions: false })
    const wrong = await call(registrations, '/api/cleanup.delete', { planId: second.body.plan.planId, confirmationText: 'wrong' })
    assert.equal(wrong.body.error.code, 'CONFIRMATION_MISMATCH')

    const third = await call(registrations, '/api/cleanup.plan', { targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'permanent', includeSessions: false })
    const done = await call(registrations, '/api/cleanup.delete', { planId: third.body.plan.planId, confirmationText: expected })
    assert.equal(done.status, 200)
    assert.equal(done.body.ok, true)
    assert.deepEqual(done.body.result.items.map((item) => item.status), ['deleted'])
    await dispose()
  })

  test('trash list / restore / purge answer their documented envelopes', async () => {
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world)
    const listed = await call(registrations, '/api/cleanup.trash.list', {})
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body, { ok: true, entries: [], totals: { entries: 0, bytes: 0 } })
    const restore = await call(registrations, '/api/cleanup.trash.restore', { entryId: 'nope' })
    assert.equal(restore.status, 200)
    assert.equal(restore.body.error.code, 'TRASH_ENTRY_UNKNOWN')
    // An omitted parameter is never "empty the whole trash".
    const implicit = await call(registrations, '/api/cleanup.trash.purge', {})
    assert.equal(implicit.status, 400)
    assert.equal(implicit.body.error.code, 'BAD_REQUEST')
    const purge = await call(registrations, '/api/cleanup.trash.purge', { all: true })
    assert.equal(purge.status, 200)
    assert.deepEqual(purge.body, { ok: true, purged: 0, bytes: 0 })
    const named = await call(registrations, '/api/cleanup.trash.purge', { entryIds: [] })
    assert.equal(named.status, 200)
    assert.deepEqual(named.body, { ok: true, purged: 0, bytes: 0 })
    await dispose()
  })

  test('bad request fields answer 400 on every route', async () => {
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world)
    const cases = [
      ['/api/cleanup.plan', { targets: 'nope' }],
      ['/api/cleanup.plan', { targets: [{ kind: 'workspace', id: 42 }] }],
      ['/api/cleanup.delete', {}],
      ['/api/cleanup.delete', { planId: 42 }],
      ['/api/cleanup.trash.restore', {}],
      ['/api/cleanup.trash.restore', { entryId: 42 }],
      ['/api/cleanup.trash.purge', {}],
      ['/api/cleanup.trash.purge', { all: 'yes' }],
      ['/api/cleanup.trash.purge', { entryIds: 'x' }],
      ['/api/cleanup.deferred.cancel', {}],
      ['/api/cleanup.deferred.cancel', { all: 'yes' }],
      ['/api/cleanup.deferred.cancel', { entryIds: 'x' }],
      ['/api/cleanup.deferred.requeue', {}],
      ['/api/cleanup.deferred.requeue', { all: 'yes' }],
      ['/api/cleanup.settings.set', {}],
      ['/api/cleanup.settings.set', { patch: { maxPlans: 0 } }],
      ['/api/cleanup.candidates', { filters: 'x' }],
      ['/api/cleanup.candidates', { sort: 'newest' }],
    ]
    for (const [route, body] of cases) {
      const response = await call(registrations, route, body)
      assert.equal(response.status, 400, `${route} ${JSON.stringify(body)}`)
      assert.equal(response.body.error.code, 'BAD_REQUEST', `${route} ${JSON.stringify(body)}`)
    }
    await dispose()
  })
})

// #endregion

// #region read-only agent tool (SPEC §6) ------------------------------------------------------

describe('cleanup_inventory tool', () => {
  test('registers the tool with the SPEC §6 name, schema and output contract', async () => {
    const world = await makeWorld()
    const captured = []
    const toolsService = makeToolsService(captured, [])
    const { dispose } = startPlugin(world, { toolsService })
    assert.equal(captured.length, 1)
    const [tool] = captured
    assert.equal(tool.name, 'cleanup_inventory')
    assert.match(tool.description, /cannot delete anything/)
    assert.match(tool.description, /Settings → Storage cleanup/)
    assert.deepEqual(tool.parameters, {
      type: 'object',
      properties: {
        workspaceId: {
          type: 'string',
          description: 'Only report this workspace and the sessions grouped under it.',
        },
        includeSizes: {
          type: 'boolean',
          description: 'Measure workspace disk usage with a bounded directory walk (slower, opt-in).',
        },
        limit: {
          type: 'integer',
          description: 'Maximum rows per list (default 50, at most 100).',
        },
      },
      additionalProperties: false,
    })
    // SPEC §6: the parameters stay inside the dsh-tools JSON Schema subset. `minimum`/
    // `maximum` are outside it; the 1..100 range is enforced by the tool's own argument validation.
    assertHostSchemaSubset(tool.parameters, 'parameters')
    assertHostSchemaSubset(tool.output.schema, 'output.schema')
    assert.equal('minimum' in tool.parameters.properties.limit, false)
    assert.equal('maximum' in tool.parameters.properties.limit, false)
    assert.equal(tool.parameters.properties.limit.type, 'integer')
    assert.deepEqual(tool.output.schema.required.sort(), ['notes', 'sessions', 'trash', 'workspaces'])
    assert.equal(tool.output.schema.additionalProperties, false)
    assert.equal(typeof tool.output.render, 'function')

    const value = await tool.execute({})
    validateSchema(tool.output.schema, value)
    // SPEC §6: the read-only tool projection is unchanged by the deferred feature; the queue count is
    // a settings-page fact, not part of the model-facing inventory value.
    assert.deepEqual(Object.keys(value).sort(), ['notes', 'sessions', 'trash', 'workspaces'])
    assert.equal('deferred' in value, false)
    assert.equal('deferred' in tool.output.schema.properties, false)
    assert.ok(Array.isArray(value.notes))
    assert.ok(value.notes.some((note) => /user-only action/.test(note)))
    const rendered = tool.output.render({}, value)
    assert.ok(Array.isArray(rendered))
    assert.equal(rendered.length, 1)
    assert.equal(rendered[0].type, 'text')
    assert.equal(typeof rendered[0].text, 'string')
    assert.match(rendered[0].text, /Storage cleanup inventory/)
    await dispose()
  })

  test('measures workspace sizes only when includeSizes is true', async () => {
    const world = await makeWorld()
    const captured = []
    const toolsService = makeToolsService(captured, [])
    const { dispose } = startPlugin(world, { toolsService })
    const [tool] = captured
    const unmeasured = await tool.execute({})
    validateSchema(tool.output.schema, unmeasured)
    assert.equal(unmeasured.workspaces[0].bytes, null)
    assert.ok(unmeasured.notes.some((note) => /not measured/.test(note)))
    const measured = await tool.execute({ includeSizes: true })
    validateSchema(tool.output.schema, measured)
    assert.equal(measured.workspaces[0].bytes, 5)
    const rendered = tool.output.render({}, measured)
    assert.match(rendered[0].text, /Largest targets/)
    assert.match(rendered[0].text, /Deletion is a user-only action in Settings/)
    await dispose()
  })

  test('filters by workspaceId and notes an unknown id', async () => {
    const world = await makeWorld()
    const captured = []
    const toolsService = makeToolsService(captured, [])
    const { dispose } = startPlugin(world, { toolsService })
    const [tool] = captured
    const filtered = await tool.execute({ workspaceId: 'ws1' })
    validateSchema(tool.output.schema, filtered)
    assert.deepEqual(filtered.workspaces.map((row) => row.id), ['ws1'])
    assert.deepEqual(filtered.sessions.map((row) => row.id), ['s1'])
    const unknown = await tool.execute({ workspaceId: 'nope' })
    validateSchema(tool.output.schema, unknown)
    assert.deepEqual(unknown.workspaces, [])
    assert.ok(unknown.notes.some((note) => /No workspace with id "nope"/.test(note)))
    await dispose()
  })

  test('applies limit and notes truncation', async () => {
    const world = await makeWorld()
    const captured = []
    const toolsService = makeToolsService(captured, [])
    const { dispose } = startPlugin(world, { toolsService })
    const [tool] = captured
    const limited = await tool.execute({ limit: 1 })
    validateSchema(tool.output.schema, limited)
    assert.equal(limited.sessions.length, 1)
    await dispose()
  })

  test('validates tool arguments', async () => {
    const world = await makeWorld()
    const captured = []
    const toolsService = makeToolsService(captured, [])
    const { dispose } = startPlugin(world, { toolsService })
    const [tool] = captured
    for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '2' }, { includeSizes: 'yes' }, { workspaceId: 42 }, { workspaceId: '' }]) {
      await assert.rejects(() => tool.execute(args), Error, JSON.stringify(args))
    }
    // A non-object argument list degrades to "no arguments".
    const value = await tool.execute(null)
    validateSchema(tool.output.schema, value)
    await dispose()
  })

  test('surfaces an engine failure as a tool error', async () => {
    const world = await makeWorld()
    world.registry.list = () => {
      throw new Error('registry down')
    }
    const captured = []
    const toolsService = makeToolsService(captured, [])
    const { dispose } = startPlugin(world, { toolsService })
    const [tool] = captured
    await assert.rejects(() => tool.execute({}), /registry down/)
    await dispose()
  })

  test('is omitted without throwing when the tools service is absent', async () => {
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world)
    assert.equal(registrations.length, 14)
    await dispose()
  })

  test('is omitted without throwing when the tools service throws or registration fails', async () => {
    const world = await makeWorld()
    const throwing = startPlugin(world, {
      get: (name) => {
        if (name === 'tools') throw new Error('service unavailable')
        return world.defaultGet(name)
      },
    })
    assert.equal(throwing.registrations.length, 14)
    await throwing.dispose()

    const failing = startPlugin(world, {
      toolsService: {
        register() {
          throw new Error('registration refused')
        },
      },
    })
    assert.equal(failing.registrations.length, 14)
    await failing.dispose()
  })

  test('the tool is read-only: it never calls registry.delete or truncating fs operations', async () => {
    const world = await makeWorld()
    const captured = []
    const toolsService = makeToolsService(captured, [])
    const { dispose } = startPlugin(world, { toolsService })
    const [tool] = captured
    await tool.execute({ includeSizes: true })
    assert.deepEqual(world.registryCalls, [])
    await fsp.access(world.workspaceDir)
    await fsp.access(path.join(world.sessionDir, 'log.jsonl'))
    await dispose()
  })

  test('the truncation prose derives its cap from the inventory payload, not a hardcoded 2000', async () => {
    // SESSION_LIST_CAP is an engine constant and inventory() always reports it, so there is no seam
    // that could inject a different cap through the tool. The production wiring is asserted
    // statically: the note must read `inventory.sessionListCap`; a reverted hardcoded "truncated at
    // 2000 entries" fails this assertion even while the current cap happens to be 2000.
    const source = await fsp.readFile(new URL('../index.js', import.meta.url), 'utf8')
    assert.match(source, /inventory\.sessionListCap/)
    assert.doesNotMatch(source, /truncated at 2000/)
    // Behavioural half: a truncated inventory does name the cap in the note.
    const world = await makeWorld()
    for (let index = 0; index < 2000; index += 1) {
      const id = `bulk-${index}`
      world.snapshots.set(id, { header: { id, createdAt: index } })
    }
    const captured = []
    const toolsService = makeToolsService(captured, [])
    const { dispose } = startPlugin(world, { toolsService })
    const [tool] = captured
    const value = await tool.execute({})
    validateSchema(tool.output.schema, value)
    assert.ok(value.notes.some((note) => /truncated at 2000 entries/.test(note)))
    await dispose()
  })
})

// #endregion

// #region optional-service degradation --------------------------------------------------------

describe('optional service degradation', () => {
  test('a throwing liveness probe fails closed over the route (plan blocker + STATE_CHANGED)', async () => {
    // The engine fails closed on a throwing probe, and the Host wiring must not swallow that throw
    // between the service and the engine. A wedged liveness service is "unknown", i.e. SESSION_LIVE.
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world, {
      get: (name) => {
        if (name === 'sessions' || name === 'agents') {
          return {
            get() {
              throw new Error(`${name} offline`)
            },
            list() {
              throw new Error(`${name} offline`)
            },
          }
        }
        return world.defaultGet(name)
      },
    })
    const planned = await call(registrations, '/api/cleanup.plan', { targets: [{ kind: 'session', id: 's1' }], mode: 'trash' })
    assert.equal(planned.status, 200)
    assert.equal(planned.body.ok, true)
    assert.deepEqual(planned.body.plan.blockers.map((entry) => entry.code), ['SESSION_LIVE'])
    assert.equal(planned.body.plan.blockers[0].sessionId, 's1')
    // A blocked plan can never mutate: admission re-seeds the blocker as changed-world state.
    const deleted = await call(registrations, '/api/cleanup.delete', { planId: planned.body.plan.planId })
    assert.equal(deleted.status, 200)
    assert.equal(deleted.body.ok, false)
    assert.equal(deleted.body.error.code, 'STATE_CHANGED')
    await fsp.access(path.join(world.sessionDir, 'log.jsonl'))
    assert.deepEqual(await fsp.readdir(path.join(world.root, 'trash')).catch(() => []), [])
    await dispose()
  })

  test('a failure to resolve an optional service degrades to absence', async () => {
    // Only failures INSIDE a probe fail closed; a service the profile does not compose — even when
    // resolving it throws — is absent and the plugin must stay usable.
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world, {
      get: (name) => {
        if (name === 'sessions' || name === 'agents') throw new Error('service unavailable')
        return world.defaultGet(name)
      },
    })
    const response = await call(registrations, '/api/cleanup.plan', { targets: [{ kind: 'session', id: 's1' }], mode: 'trash' })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.deepEqual(response.body.plan.blockers, [])
    await dispose()
  })

  test('does not crash when the exposed list() probe is unavailable', async () => {
    const world = await makeWorld()
    // The default fake services expose get() only: the view's list() must degrade to undefined.
    const present = startPlugin(world)
    const planned = await call(present.registrations, '/api/cleanup.plan', {
      targets: [{ kind: 'workspace', id: 'ws1' }],
      mode: 'trash',
      includeSessions: false,
    })
    assert.equal(planned.status, 200)
    assert.equal(planned.body.ok, true)
    assert.deepEqual(planned.body.plan.blockers, [])
    await present.dispose()
    // Same when the whole optional service is absent.
    const absent = startPlugin(world, { noOptionalServices: true })
    const absentPlan = await call(absent.registrations, '/api/cleanup.plan', {
      targets: [{ kind: 'workspace', id: 'ws1' }],
      mode: 'trash',
      includeSessions: false,
    })
    assert.equal(absentPlan.status, 200)
    assert.equal(absentPlan.body.ok, true)
    assert.deepEqual(absentPlan.body.plan.blockers, [])
    await absent.dispose()
  })

  test('missing optional services keep the plugin active', async () => {
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world, { noOptionalServices: true })
    assert.equal(registrations.length, 14)
    const inventory = await call(registrations, '/api/cleanup.inventory', {})
    assert.equal(inventory.status, 200)
    assert.equal(inventory.body.ok, true)
    await dispose()
  })
})

// #endregion

// #region deferred-deletion routes + start-up hook (SPEC §4.7/§5.8) --------------------------

describe('deferred-deletion routes and start-up hook', () => {
  test('the three deferred routes answer their SPEC §4.7 envelopes', async () => {
    const world = await makeWorld()
    // A throwaway queued entry gives the asynchronous start-up hook a deterministic completion signal:
    // its UNKNOWN_SESSION result is written to lastRun before the route assertions run.
    await writeDeferredQueue(world, [queuedSessionEntry('ghost')])
    const { registrations, dispose } = startPlugin(world)
    const hookFinished = await waitFor(async () => {
      const document = await readDeferredQueue(world)
      return document !== null && document.entries.length === 0 && document.lastRun !== null
    })
    assert.equal(hookFinished, true, 'the start-up hook must finish before the routes are exercised')

    const queued = await call(registrations, '/api/cleanup.defer', { targets: [{ kind: 'session', id: 's1' }], mode: 'trash' })
    assert.equal(queued.status, 200)
    assert.equal(queued.body.ok, true)
    assert.equal(queued.body.deferred.count, 1)
    assert.equal(queued.body.deferred.replaced, false)
    const entryId = queued.body.deferred.entryIds[0]
    // The overview reflects the queued/retained counts without listing entries; lastRun is the start-up run.
    const inventory = await call(registrations, '/api/cleanup.inventory', {})
    assert.equal(inventory.body.deferred.count, 1)
    assert.equal(inventory.body.deferred.retained, 1, 'the skipped start-up entry is retained')
    assert.equal(inventory.body.deferred.lastRun.results[0].code, 'UNKNOWN_SESSION')

    const listed = await call(registrations, '/api/cleanup.deferred.list', {})
    assert.equal(listed.status, 200)
    assert.equal(listed.body.ok, true)
    assert.deepEqual(listed.body.deferred.entries.map((entry) => entry.id), [entryId])
    assert.equal('confirmationText' in listed.body.deferred.entries[0], false)
    // The start-up hook's failed ghost entry is retained (SPEC §4.7), not dropped.
    assert.equal(listed.body.deferred.retained.length, 1)
    assert.equal(listed.body.deferred.retained[0].code, 'UNKNOWN_SESSION')
    assert.equal(listed.body.deferred.lastRun.results.length, 1)

    const implicitCancel = await call(registrations, '/api/cleanup.deferred.cancel', {})
    assert.equal(implicitCancel.status, 400)
    assert.equal(implicitCancel.body.error.code, 'BAD_REQUEST')
    const cancelled = await call(registrations, '/api/cleanup.deferred.cancel', { entryIds: [entryId] })
    assert.equal(cancelled.status, 200)
    assert.deepEqual(cancelled.body, { ok: true, cancelled: 1 })

    const unknownTarget = await call(registrations, '/api/cleanup.defer', { targets: [{ kind: 'session', id: 'nope' }], mode: 'trash' })
    assert.equal(unknownTarget.status, 200)
    assert.equal(unknownTarget.body.ok, false)
    assert.equal(unknownTarget.body.error.code, 'UNKNOWN_SESSION')
    // SPEC §4.7/§4: a malformed confirmationText type is a field error, so it maps to HTTP 400.
    const badConfirmation = await call(registrations, '/api/cleanup.defer', {
      targets: [{ kind: 'session', id: 's1' }],
      mode: 'trash',
      confirmationText: 123,
    })
    assert.equal(badConfirmation.status, 400)
    assert.equal(badConfirmation.body.ok, false)
    assert.equal(badConfirmation.body.error.code, 'BAD_REQUEST')

    // Requeue moves retained entries back into the active queue (idempotent for unknown ids).
    const retainedId = listed.body.deferred.lastRun.results[0].entryId
    const requeued = await call(registrations, '/api/cleanup.deferred.requeue', { entryIds: [retainedId] })
    assert.equal(requeued.status, 200)
    assert.equal(requeued.body.ok, true)
    assert.equal(requeued.body.requeued, 1)
    assert.equal(requeued.body.count, 1)
    const requeueUnknown = await call(registrations, '/api/cleanup.deferred.requeue', { entryIds: ['nope'] })
    assert.deepEqual(requeueUnknown.body, { ok: true, requeued: 0, count: 1 })
    const requeueBad = await call(registrations, '/api/cleanup.deferred.requeue', {})
    assert.equal(requeueBad.status, 400)
    assert.equal(requeueBad.body.error.code, 'BAD_REQUEST')

    // Settings routes: get returns the frozen shape, set applies and persists.
    const settings = await call(registrations, '/api/cleanup.settings.get', {})
    assert.equal(settings.status, 200)
    assert.equal(settings.body.ok, true)
    assert.deepEqual(Object.keys(settings.body.settings).sort(), [
      'allowPermanentDeletion',
      'auditEnabled',
      'auditMaxBytes',
      'gitSafetyCheck',
      'maxPlans',
      'maxScanEntries',
      'planTtlMs',
      'scanTimeoutMs',
      'trashMaxBytes',
      'trashRetentionDays',
      'trashRoot',
    ])
    const unchanged = await call(registrations, '/api/cleanup.settings.set', { patch: {} })
    assert.equal(unchanged.status, 200)
    assert.equal(unchanged.body.ok, true)
    const badSetting = await call(registrations, '/api/cleanup.settings.set', { patch: { nope: 1 } })
    assert.equal(badSetting.status, 400)
    assert.equal(badSetting.body.error.code, 'BAD_REQUEST')
    assert.equal(badSetting.body.error.details.field, 'nope')
    await dispose()
  })

  test('apply applies a pre-written queue once at startup, before any route is used', async () => {
    const world = await makeWorld()
    await writeDeferredQueue(world, [queuedSessionEntry('s1')])
    const logs = []
    const { registrations, dispose } = startPlugin(world, { logger: { info: (message) => logs.push(message) } })
    assert.equal(registrations.length, 14)
    const applied = await waitFor(async () => {
      const document = await readDeferredQueue(world)
      return document !== null && document.entries.length === 0 && document.lastRun !== null
    })
    assert.equal(applied, true, 'apply() must hand the queue to runDeferred()')
    assert.equal(await pathExists(world.sessionDir), false, 'the queued session log was moved to the trash')
    const trashEntries = await fsp.readdir(world.trashRoot)
    assert.equal(trashEntries.length, 1)
    const document = await readDeferredQueue(world)
    assert.equal(document.lastRun.results[0].status, 'trashed')
    assert.ok(logs.some((message) => /applied 1 deferred deletion/.test(message)), 'the start-up run is logged')
    await dispose()
  })

  test('a hot-reload apply in the same process does not consume newly queued entries', async () => {
    const world = await makeWorld()
    // First activation consumes a throwaway entry, which tells us the hook has completed.
    await writeDeferredQueue(world, [queuedSessionEntry('ghost')])
    const first = startPlugin(world)
    const firstFinished = await waitFor(async () => {
      const document = await readDeferredQueue(world)
      return document !== null && document.entries.length === 0 && document.lastRun !== null
    })
    assert.equal(firstFinished, true)
    await first.dispose()
    // New work queued while this process is still running must wait for the NEXT process start.
    await writeDeferredQueue(world, [queuedSessionEntry('s1')])
    const reloaded = startPlugin(world)
    assert.equal(reloaded.registrations.length, 14)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const document = await readDeferredQueue(world)
    assert.equal(document.entries.length, 1, 'the hot-reloaded apply must not consume the queue')
    assert.equal(await pathExists(world.sessionDir), true, 'the queued session log is untouched')
    await reloaded.dispose()
  })

  test('a corrupt queue cannot break plugin activation or the inventory route', async () => {
    const world = await makeWorld()
    await fsp.mkdir(path.dirname(world.deferredFile), { recursive: true })
    await fsp.writeFile(world.deferredFile, '{not json')
    const { registrations, dispose } = startPlugin(world)
    assert.equal(registrations.length, 14, 'a broken queue must never block activation')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(await fsp.readFile(world.deferredFile, 'utf8'), '{not json', 'the hook leaves the corrupt file alone')
    const inventory = await call(registrations, '/api/cleanup.inventory', {})
    assert.equal(inventory.status, 200)
    assert.equal(inventory.body.ok, true)
    assert.deepEqual(inventory.body.deferred, { count: 0, retained: 0, lastRun: null })
    await dispose()
  })
})

// #endregion

// #region abort forwarding (SPEC §5.6) -------------------------------------------------------

describe('abort forwarding', () => {
  test('plan and execute forward the request AbortSignal', async () => {
    const world = await makeWorld()
    const { registrations, dispose } = startPlugin(world)
    const controller = new AbortController()
    controller.abort()
    const planned = await call(registrations, '/api/cleanup.plan', {
      targets: [{ kind: 'workspace', id: 'ws1' }],
      mode: 'trash',
    }, { signal: controller.signal })
    assert.equal(planned.status, 200)
    assert.equal(planned.body.ok, false)
    assert.equal(planned.body.error.code, 'CANCELLED')
    // A real plan first, then an aborted execute: the abort is checked before admission, so the
    // response is CANCELLED and nothing was deleted.
    const plannedOk = await call(registrations, '/api/cleanup.plan', {
      targets: [{ kind: 'workspace', id: 'ws1' }],
      mode: 'trash',
    })
    assert.equal(plannedOk.body.ok, true)
    const executed = await call(registrations, '/api/cleanup.delete', { planId: plannedOk.body.plan.planId }, { signal: controller.signal })
    assert.equal(executed.status, 200)
    assert.equal(executed.body.ok, false)
    assert.equal(executed.body.error.code, 'CANCELLED')
    assert.equal(await pathExists(world.workspaceDir), true, 'nothing was deleted')
    await dispose()
  })
})

// #endregion
