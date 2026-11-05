/**
 * Contract tests for lib/engine.js (Host domain half).
 *
 * The engine is always built through `createEngine(deps)` with injected fakes for
 * `workspaceRegistry`, `sessionPersistence`, `sessions`, `agents` and `now`; only `node:fs/promises`
 * touches a real disk, and that disk is a throw-away mkdtemp root created below. Nothing outside
 * that root is read or written and `$HOME`/`~/.dsh` are never touched (the only test that sets
 * `DSH_HOME` points it inside the temp root and restores it).
 */
import { test, describe, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import * as nodeFs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { createEngine } from '../lib/engine.js'

const execFile = promisify(execFileCallback)

/** Shared per-file temp root. */
let TMP
let caseId = 0

before(async () => {
  TMP = await fsp.realpath(await fsp.mkdtemp(os.tmpdir() + '/dsh-cleanup-test-engine-'))
})

after(async () => {
  await fsp.rm(TMP, { recursive: true, force: true })
})

// #region fixtures and helpers ----------------------------------------------------------------

/** A controllable clock: `now()` is a number, `advance`/`set` move it. */
function makeClock(start = 1_000_000) {
  let value = start
  return {
    now: () => value,
    advance(ms) {
      value += ms
      return value
    },
    set(next) {
      value = next
      return value
    },
  }
}

/** @returns {Promise<boolean>} whether a path exists (any type). */
async function exists(target) {
  try {
    await fsp.lstat(target)
    return true
  } catch {
    return false
  }
}

/** Fail unless `target` is gone. */
async function assertGone(target, label = target) {
  assert.equal(await exists(target), false, `expected ${label} to be gone`)
}

/** Fail unless `target` exists. */
async function assertExists(target, label = target) {
  assert.equal(await exists(target), true, `expected ${label} to exist`)
}

/** Collect and parse every trash entry under the world's trash root. */
async function trashEntries(world) {
  let names
  try {
    names = await fsp.readdir(world.trashRoot)
  } catch {
    return []
  }
  const entries = []
  for (const name of names) {
    const entryDir = path.join(world.trashRoot, name)
    const entry = { entryDir, entryId: name }
    try {
      entry.meta = JSON.parse(await fsp.readFile(path.join(entryDir, 'meta.json'), 'utf8'))
    } catch {
      entry.meta = null
    }
    entries.push(entry)
  }
  entries.sort((left, right) => String(left.entryId).localeCompare(String(right.entryId)))
  return entries
}

/** Deep-walk a value and fail on anything that is not pure JSON. */
function assertPureJson(value, at = '$') {
  if (value === undefined) assert.fail(`${at} is undefined`)
  if (value instanceof Date) assert.fail(`${at} is a Date`)
  if (typeof value === 'function') assert.fail(`${at} is a function`)
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `${at} is not a finite number`)
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPureJson(entry, `${at}[${index}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) assertPureJson(value[key], `${at}.${key}`)
  }
}

const WORKSPACE_ITEM_KEYS = ['bytes', 'dirs', 'files', 'id', 'kind', 'path', 'title', 'truncated']
const SESSION_ITEM_KEYS = ['bytes', 'files', 'id', 'isDescendant', 'kind', 'parentSessionId', 'path', 'title', 'workspaceId']
const PLAN_KEYS = [
  'allowPermanentDeletion',
  'blockers',
  'confirmation',
  'createdAt',
  'expiresAt',
  'items',
  'mode',
  'planId',
  'targets',
  'totals',
  'warnings',
]
const TARGET_KEYS = ['id', 'kind', 'path', 'title']
const TOTALS_KEYS = ['bytes', 'dirs', 'files', 'sessions', 'workspaces']
const MESSAGE_KEYS = ['code', 'message', 'sessionId', 'workspaceId']
const RESULT_ITEM_KEYS = ['bytes', 'error', 'id', 'kind', 'movedTo', 'status']
const RESULT_TOTALS_KEYS = ['bytes', 'deleted', 'failed', 'trashed']
const TRASH_ENTRY_KEYS = ['bytes', 'dirs', 'files', 'id', 'kind', 'movedAt', 'origin', 'originalPath', 'parentSessionId', 'restorable', 'restorableCode', 'title']

/** Assert a plan envelope is ok and return the plan. */
function planOf(response, label = 'plan') {
  assert.equal(response.ok, true, `${label} should be ok: ${JSON.stringify(response)}`)
  return response.plan
}

/** Assert an engine envelope is a domain failure with `code`. */
function assertFail(response, code, label = '') {
  assert.equal(response.ok, false, `${label} should fail: ${JSON.stringify(response)}`)
  assert.equal(response.error?.code, code, `${label} code: ${JSON.stringify(response)}`)
  return response.error
}

/**
 * Create one isolated case world under the per-file temp root.
 *
 * Workspaces and sessions are materialized on disk (unless disabled) and their registry/persistence
 * snapshots are exposed through fakes so the engine can run without any Harness package.
 */
async function makeWorld(spec = {}) {
  const root = path.join(TMP, `case-${++caseId}`)
  await fsp.mkdir(root, { recursive: true })
  const trashRoot = spec.trashRoot ?? path.join(root, 'trash')
  // Every engine gets its own deferred-deletion queue inside the case root, so no test (and no
  // start-up hook) can read or write the real $DSH_HOME/cleanup/deferred.json.
  const deferredFile = spec.deferredFile ?? path.join(root, 'cleanup', 'deferred.json')
  /** @type {Map<string, object>} */
  const entities = new Map()
  /** @type {Map<string, string>} */
  const workspaceDirs = new Map()

  for (const workspace of spec.workspaces ?? []) {
    const dir = workspace.dir ?? path.join(root, 'workspaces', workspace.id)
    if (workspace.create !== false) {
      await fsp.mkdir(dir, { recursive: true })
      for (const [relative, content] of Object.entries(workspace.files ?? {})) {
        const filePath = path.join(dir, relative)
        await fsp.mkdir(path.dirname(filePath), { recursive: true })
        await fsp.writeFile(filePath, content)
      }
      if (workspace.git === true) await fsp.mkdir(path.join(dir, '.git'), { recursive: true })
    }
    entities.set(workspace.id, {
      id: workspace.id,
      path: workspace.registryPath ?? dir,
      title: workspace.title ?? workspace.id,
      sessionIds: workspace.sessionIds ?? [],
    })
    workspaceDirs.set(workspace.id, dir)
  }

  /** @type {Map<string, object>} */
  const snapshots = new Map()
  /** @type {Map<string, string>} */
  const sessionDirs = new Map()
  for (const session of spec.sessions ?? []) {
    const project = session.project ?? '--test-project--'
    const dir = session.dir ?? path.join(root, 'sessions', project, session.id)
    /** @type {{ path: string } | undefined} */
    let location
    if (session.unborn !== true) {
      if (session.materialize !== false) {
        await fsp.mkdir(dir, { recursive: true })
        await fsp.writeFile(path.join(dir, session.fileName ?? 'log.jsonl'), session.content ?? 'x\n')
      }
      location = { path: session.locationPath ?? path.join(dir, session.fileName ?? 'log.jsonl') }
    }
    const header = { id: session.id, createdAt: session.createdAt ?? 1000 }
    if ('cwd' in session) header.cwd = session.cwd
    if ('origin' in session) header.origin = session.origin
    if ('parentSession' in session) header.parentSession = session.parentSession
    if (session.isSeeded === true) header.isSeeded = true
    const snapshot = { header }
    if (location !== undefined) snapshot.location = location
    if ('eventCount' in session) snapshot.eventCount = session.eventCount
    if ('sizeBytes' in session) snapshot.sizeBytes = session.sizeBytes
    snapshots.set(session.id, snapshot)
    sessionDirs.set(session.id, dir)
  }

  /** @type {Map<string, object>} */
  const liveStore = new Map()
  for (const id of spec.live ?? []) liveStore.set(id, { id })
  /** @type {Map<string, object>} */
  const agentStore = new Map()
  for (const id of spec.running ?? []) agentStore.set(id, { status: 'running' })
  for (const id of spec.idleAgents ?? []) agentStore.set(id, { status: 'idle' })

  /** @type {[string, string][]} */
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
    archivedSessionIds: [...(spec.archived ?? [])],
    pinnedSessionIds: [...(spec.pinned ?? [])],
  }
  const persistence = {
    list: async () => [...snapshots.values()],
    stat: async (id) => snapshots.get(id),
  }

  const stateDir = path.dirname(deferredFile)
  const world = {
    root,
    trashRoot,
    deferredFile,
    stateDir,
    settingsFile: path.join(stateDir, 'settings.json'),
    auditFile: path.join(stateDir, 'audit.jsonl'),
    entities,
    workspaceDirs,
    snapshots,
    sessionDirs,
    liveStore,
    agentStore,
    registry,
    persistence,
    registryCalls,
    clock: makeClock(spec.startClock ?? 1_000_000),
    entity(id) {
      return entities.get(id)
    },
    snapshot(id) {
      return snapshots.get(id)
    },
    dirOf(id) {
      return workspaceDirs.get(id)
    },
    dirOfSession(id) {
      return sessionDirs.get(id)
    },
    /** Build an engine bound to this world; every dep can be overridden. */
    engine(options = {}) {
      const config = { trashRoot, deferredFile, ...(options.config ?? {}) }
      const deps = {
        workspaceRegistry: options.workspaceRegistry ?? registry,
        sessionPersistence: options.sessionPersistence ?? persistence,
        // `baseConfig` is the loader-row config (Settings "defaults"); without overrides it is the
        // effective config, and tests may pass a different one.
        baseConfig: options.baseConfig ?? config,
        config,
        now: options.now ?? world.clock.now,
      }
      const sessions = 'sessions' in options ? options.sessions : { get: (id) => liveStore.get(id) }
      const agents = 'agents' in options ? options.agents : { get: (id) => agentStore.get(id) }
      if (sessions !== null) deps.sessions = sessions
      if (agents !== null) deps.agents = agents
      if (options.fsOps !== undefined) deps.fsOps = options.fsOps
      return createEngine(deps)
    },
  }
  return world
}

/** Wrap the mutating fs methods so a test can observe engine ordering. */
function loggingFsOps(log) {
  const wrap = (name) => async (...args) => {
    log.push({ type: 'fs', name, from: String(args[0]), to: args[1] === undefined ? undefined : String(args[1]) })
    return nodeFs[name](...args)
  }
  return {
    rename: wrap('rename'),
    mkdir: wrap('mkdir'),
    writeFile: wrap('writeFile'),
    unlink: wrap('unlink'),
    rmdir: wrap('rmdir'),
  }
}

/** Install registry fakes that push into a shared ordering log. */
function logRegistry(world, log) {
  world.registry.delete = async (id) => {
    log.push({ type: 'registry', name: 'delete', id })
    world.entities.delete(id)
  }
  world.registry.unpinSession = async (id) => {
    log.push({ type: 'registry', name: 'unpin', id })
  }
  world.registry.unarchiveSession = async (id) => {
    log.push({ type: 'registry', name: 'unarchive', id })
  }
}

// #endregion

// #region inventory (SPEC §4.1) ---------------------------------------------------------------

describe('inventory', () => {
  test('returns the SPEC §4.1 shape with workspace and session rows', async () => {
    const world = await makeWorld({
      workspaces: [{ id: 'ws1', title: 'proj', sessionIds: ['s1'], git: true }],
      sessions: [
        { id: 's1', cwd: undefined, eventCount: 7, sizeBytes: 123 },
        { id: 's2', cwd: '/somewhere', origin: 'subagent', parentSession: 's1' },
      ],
    })
    world.snapshot('s1').header.cwd = world.dirOf('ws1')
    world.snapshot('s1').header.createdAt = 1730000000000
    world.registry.archivedSessionIds = ['s2']
    world.registry.pinnedSessionIds = ['s1']
    const engine = world.engine()

    const response = await engine.inventory()
    assert.equal(response.ok, true)
    assertPureJson(response)
    assert.deepEqual(Object.keys(response).sort(), [
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
    assert.equal(response.generatedAt, world.clock.now())
    assert.equal(typeof response.dshHome, 'string')
    assert.ok(path.isAbsolute(response.dshHome))
    assert.deepEqual(response.trash, {
      root: world.trashRoot,
      entries: 0,
      bytes: 0,
      oldestMovedAt: null,
      overRetention: false,
      overCapacity: false,
      suggestedEntryIds: [],
    })
    assert.deepEqual(response.deferred, { count: 0, retained: 0, lastRun: null })
    assert.deepEqual(response.audit, { enabled: true, lastStartup: null, recent: [] })
    assert.equal(response.truncated, false)
    // SPEC §4.1: the cap is on the wire so consumers never hardcode it.
    assert.equal(response.sessionListCap, 2000)
    // SPEC §4.1/§4.7: the overview carries counts and the previous start-up results, not entries.
    assert.deepEqual(response.deferred.entries, undefined)
    assert.equal(response.deferred.retained, 0)

    const [workspace] = response.workspaces
    assert.deepEqual(Object.keys(workspace).sort(), [
      'blockerCodes',
      'deletable',
      'hasGit',
      'id',
      'liveSessions',
      'path',
      'sessionCount',
      'sessionsInside',
      'state',
      'stateCode',
      'title',
    ])
    assert.equal(workspace.id, 'ws1')
    assert.equal(workspace.path, world.dirOf('ws1'))
    assert.equal(workspace.title, 'proj')
    assert.equal(workspace.state, 'ok')
    assert.equal(workspace.stateCode, null)
    assert.equal(workspace.sessionCount, 1)
    assert.equal(workspace.hasGit, true)
    assert.equal(workspace.deletable, true)
    assert.deepEqual(workspace.blockerCodes, [])

    const byId = new Map(response.sessions.map((row) => [row.id, row]))
    assert.equal(byId.size, 2)
    assert.deepEqual(Object.keys(byId.get('s1')).sort(), [
      'archived',
      'blockerCodes',
      'createdAt',
      'cwd',
      'deletable',
      'eventCount',
      'id',
      'live',
      'origin',
      'parentSessionId',
      'pinned',
      'running',
      'sizeBytes',
      'workspaceId',
    ])
    assert.equal(byId.get('s1').workspaceId, 'ws1')
    assert.equal(byId.get('s1').cwd, world.dirOf('ws1'))
    assert.equal(byId.get('s1').createdAt, 1730000000000)
    assert.equal(byId.get('s1').eventCount, 7)
    assert.equal(byId.get('s1').sizeBytes, 123)
    assert.equal(byId.get('s1').origin, null)
    assert.equal(byId.get('s1').parentSessionId, null)
    assert.equal(byId.get('s1').live, false)
    assert.equal(byId.get('s1').running, false)
    assert.equal(byId.get('s1').archived, false)
    assert.equal(byId.get('s1').pinned, true)
    assert.equal(byId.get('s1').deletable, true)
    assert.equal(byId.get('s2').workspaceId, null)
    assert.equal(byId.get('s2').origin, 'subagent')
    assert.equal(byId.get('s2').parentSessionId, 's1')
    assert.equal(byId.get('s2').archived, true)
    assert.equal(byId.get('s2').pinned, false)
  })

  test('counts only sessions whose header.cwd is at or below the workspace path', async () => {
    const world = await makeWorld({
      workspaces: [{ id: 'ws1' }],
      sessions: [
        { id: 'equal', cwd: undefined },
        { id: 'inside', cwd: undefined },
        { id: 'sibling', cwd: undefined },
        { id: 'prefix', cwd: undefined },
        { id: 'no-cwd' },
      ],
    })
    const ws = world.dirOf('ws1')
    world.snapshot('equal').header.cwd = ws
    world.snapshot('inside').header.cwd = path.join(ws, 'deep', 'dir')
    world.snapshot('sibling').header.cwd = path.join(world.root, 'other')
    world.snapshot('prefix').header.cwd = `${ws}-evil`
    const engine = world.engine()
    const response = await engine.inventory()
    assert.equal(response.workspaces[0].sessionsInside, 2)
  })

  test('reports live and running sessions and the blockers they cause', async () => {
    const world = await makeWorld({
      workspaces: [{ id: 'ws1' }],
      sessions: [
        { id: 'open', cwd: undefined },
        { id: 'busy', cwd: undefined },
        { id: 'idle', cwd: undefined },
      ],
      live: ['open', 'idle'],
      running: ['busy'],
      idleAgents: ['idle'],
    })
    const ws = world.dirOf('ws1')
    world.snapshot('open').header.cwd = ws
    world.snapshot('busy').header.cwd = ws
    world.snapshot('idle').header.cwd = '/elsewhere'
    const engine = world.engine()
    const response = await engine.inventory()
    const workspace = response.workspaces[0]
    assert.equal(workspace.deletable, false)
    assert.ok(workspace.blockerCodes.includes('WORKSPACE_HAS_LIVE_SESSIONS'))
    assert.deepEqual([...workspace.liveSessions].sort(), ['busy', 'open'])
    const byId = new Map(response.sessions.map((row) => [row.id, row]))
    assert.equal(byId.get('open').live, true)
    assert.equal(byId.get('open').running, false)
    assert.deepEqual(byId.get('open').blockerCodes, ['SESSION_LIVE'])
    assert.equal(byId.get('busy').live, true)
    assert.equal(byId.get('busy').running, true)
    assert.deepEqual(byId.get('busy').blockerCodes, ['SESSION_RUNNING'])
    assert.equal(byId.get('idle').live, true)
    assert.equal(byId.get('idle').blockerCodes[0], 'SESSION_LIVE')
    assert.equal(byId.get('idle').deletable, false)
  })

  test('marks a missing workspace as state missing and stays deletable (registration-only)', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', create: false, title: 'gone' }] })
    const engine = world.engine()
    const response = await engine.inventory()
    const [workspace] = response.workspaces
    assert.equal(workspace.state, 'missing')
    assert.equal(workspace.stateCode, 'WORKSPACE_MISSING')
    assert.equal(workspace.deletable, true)
    assert.deepEqual(workspace.blockerCodes, [])
    assert.equal(workspace.sessionsInside, 0)
  })

  test('marks a symlinked workspace as unsafe and still populates the inside-session fields', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }], sessions: [{ id: 's-inside' }] })
    const link = path.join(world.root, 'link')
    await fsp.symlink(world.dirOf('ws1'), link, 'dir')
    world.entity('ws1').path = link
    world.snapshot('s-inside').header.cwd = link
    const engine = world.engine()
    const response = await engine.inventory()
    const [workspace] = response.workspaces
    assert.equal(workspace.state, 'unsafe')
    assert.equal(workspace.stateCode, 'WORKSPACE_SYMLINK')
    assert.equal(workspace.sessionsInside, 1)
    assert.deepEqual(workspace.liveSessions, [])
    assert.equal(workspace.deletable, false)
    assert.deepEqual(workspace.blockerCodes, ['WORKSPACE_SYMLINK'])
  })

  test('reports a session whose stored log is not in a session layout as not deletable', async () => {
    // `stat` resolves it, but the location is not a recognized JSONL session directory.
    const weirdRoot = path.join(TMP, 'weird-layout')
    await fsp.mkdir(weirdRoot, { recursive: true })
    await fsp.writeFile(path.join(weirdRoot, 'log.jsonl'), 'x\n')
    const world = await makeWorld({
      sessions: [{ id: 'weird', dir: weirdRoot, locationPath: path.join(weirdRoot, 'log.jsonl'), materialize: false }],
    })
    const engine = world.engine()
    const response = await engine.inventory()
    const row = response.sessions[0]
    assert.equal(row.id, 'weird')
    assert.equal(row.deletable, false)
    assert.deepEqual(row.blockerCodes, ['SESSION_NOT_DELETABLE'])
  })

  test('truncates the session list at 2000 and reports it', async () => {
    const sessions = []
    for (let index = 0; index < 2001; index += 1) sessions.push({ id: `s${String(index).padStart(4, '0')}`, unborn: true })
    const world = await makeWorld({ sessions })
    const engine = world.engine()
    const response = await engine.inventory()
    assert.equal(response.sessions.length, 2000)
    assert.equal(response.truncated, true)
    assert.equal(response.sessionListCap, 2000)
  })

  test('summarizes the trash root entries and bytes', async () => {
    const world = await makeWorld({})
    await fsp.mkdir(path.join(world.trashRoot, 'entry-a'), { recursive: true })
    await fsp.writeFile(
      path.join(world.trashRoot, 'entry-a', 'meta.json'),
      `${JSON.stringify({ version: 1, kind: 'session', title: 't', originalPath: path.join(world.root, 'gone'), movedAt: 5, bytes: 7, files: 1, dirs: 0 })}\n`,
    )
    await fsp.mkdir(path.join(world.trashRoot, 'entry-b'), { recursive: true })
    // entry-b is an owned but unreadable entry (marker without metadata): still listed and counted.
    await fsp.writeFile(path.join(world.trashRoot, 'entry-b', '.dsh-cleanup-entry'), '{}\n')
    const engine = world.engine()
    const response = await engine.inventory()
    assert.deepEqual(response.trash, {
      root: world.trashRoot,
      entries: 2,
      bytes: 7,
      // entry-a carries an explicit movedAt; entry-b falls back to its directory mtime (newer).
      oldestMovedAt: 5,
      overRetention: false,
      overCapacity: false,
      suggestedEntryIds: [],
    })
  })

  test('keeps the informational inside/live fields for a missing workspace, but its plan is registration-only', async () => {
    // SPEC §4.1 defines both fields as pure path facts with no existence qualifier; the scan runs
    // before the ENOENT early return. A missing directory deletes nothing, so a live session whose
    // cwd is inside it is reported but is not a blocker.
    const missing = path.join(TMP, 'missing-workspace-r10')
    const world = await makeWorld({
      workspaces: [{ id: 'ws1', create: false, dir: missing }],
      sessions: [{ id: 's-inside', cwd: missing }, { id: 's-live', cwd: missing }],
      live: ['s-live'],
    })
    const engine = world.engine()
    const inventory = await engine.inventory()
    const workspace = inventory.workspaces[0]
    assert.equal(workspace.state, 'missing')
    assert.equal(workspace.stateCode, 'WORKSPACE_MISSING')
    assert.equal(workspace.sessionsInside, 2)
    assert.deepEqual(workspace.liveSessions, ['s-live'])
    assert.deepEqual(workspace.blockerCodes, [])
    assert.equal(workspace.deletable, true)
    // SPEC §5.3: a missing directory short-circuits §5.3, so `includeSessions` sweeps no
    // stored sessions and the plan really is registration-only.
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash' }))
    assert.deepEqual(plan.items, [
      { kind: 'workspace-dir', id: 'ws1', title: 'ws1', path: missing, bytes: 0, files: 0, dirs: 0, truncated: false },
    ])
    assert.deepEqual(plan.totals, { workspaces: 1, sessions: 0, files: 0, dirs: 0, bytes: 0 })
    assert.deepEqual(plan.blockers, [])
    assert.deepEqual(plan.warnings.map((entry) => entry.code), ['WORKSPACE_MISSING'])
  })

  test('returns IO_ERROR when the workspace registry cannot list', async () => {
    const world = await makeWorld({})
    const engine = world.engine({
      workspaceRegistry: {
        list: () => {
          throw new Error('registry down')
        },
        get: () => undefined,
        delete: async () => { },
        unpinSession: async () => { },
        unarchiveSession: async () => { },
      },
    })
    const response = await engine.inventory()
    assertFail(response, 'IO_ERROR')
  })

  test('returns IO_ERROR when stored sessions cannot be listed', async () => {
    const world = await makeWorld({})
    const engine = world.engine({
      sessionPersistence: {
        list: async () => {
          throw new Error('storage down')
        },
        stat: async () => undefined,
      },
    })
    const response = await engine.inventory()
    assertFail(response, 'IO_ERROR')
  })
})

// #endregion

// #region measure (SPEC §4.2) -----------------------------------------------------------------

describe('measure', () => {
  test('measures workspaces and sessions with bounded walks', async () => {
    const world = await makeWorld({
      workspaces: [{ id: 'ws1', files: { 'a.txt': 'abc', 'sub/b.txt': 'defg' } }],
      sessions: [{ id: 's1' }],
    })
    const engine = world.engine()
    const response = await engine.measure({ workspaceIds: ['ws1'], sessionIds: ['s1'] })
    assert.equal(response.ok, true)
    assertPureJson(response)
    const workspace = response.workspaces.ws1
    assert.deepEqual(Object.keys(workspace).sort(), ['bytes', 'dirs', 'files', 'newestMtime', 'truncated'])
    assert.equal(workspace.bytes, 7)
    assert.equal(workspace.files, 2)
    assert.equal(workspace.dirs, 1)
    assert.ok(workspace.newestMtime > 0)
    assert.equal(workspace.truncated, false)
    assert.deepEqual(response.sessions.s1, { bytes: 2, files: 1 })
  })

  test('reports a missing workspace with the exact missing shape from SPEC §4.2', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', create: false }] })
    const engine = world.engine()
    const response = await engine.measure({ workspaceIds: ['ws1'] })
    assert.deepEqual(response.workspaces.ws1, { bytes: 0, files: 0, dirs: 0, truncated: false, missing: true })
  })

  test('omits unknown ids and a session without a location reports zeroes', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', unborn: true }] })
    const engine = world.engine()
    const response = await engine.measure({ workspaceIds: ['nope'], sessionIds: ['s1', 'nope'] })
    assert.deepEqual(response.workspaces, {})
    assert.deepEqual(response.sessions, { s1: { bytes: 0, files: 0 } })
  })

  test('does not follow symlinks while measuring', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'a.txt': 'abc' } }] })
    const outside = path.join(world.root, 'outside')
    await fsp.mkdir(outside)
    await fsp.writeFile(path.join(outside, 'huge.bin'), 'x'.repeat(4096))
    await fsp.symlink(outside, path.join(world.dirOf('ws1'), 'link'), 'dir')
    const engine = world.engine()
    const response = await engine.measure({ workspaceIds: ['ws1'] })
    const workspace = response.workspaces.ws1
    assert.equal(workspace.files, 2, 'the symlink itself is counted as a leaf file')
    assert.equal(workspace.dirs, 0)
    assert.ok(workspace.bytes < 4096, 'the symlink target contents must not be counted')
  })

  test('truncates a walk that exceeds maxScanEntries and reports it', async () => {
    const files = {}
    for (let index = 0; index < 6; index += 1) files[`f${index}.txt`] = 'x'
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files }] })
    const engine = world.engine({ config: { maxScanEntries: 2 } })
    const response = await engine.measure({ workspaceIds: ['ws1'] })
    const workspace = response.workspaces.ws1
    assert.equal(workspace.truncated, true)
    assert.ok(workspace.files <= 2)
  })

  test('rejects malformed id-list requests', async () => {
    const world = await makeWorld({})
    const engine = world.engine()
    for (const body of [null, 'x', 42, [], { workspaceIds: 'ws1' }, { sessionIds: [1] }]) {
      assertFail(await engine.measure(body), 'BAD_REQUEST')
    }
  })
})

// #endregion

// #region plan: session targets (SPEC §5.1/§5.2) ----------------------------------------------

describe('plan: session targets', () => {
  test('builds a plan with the documented top-level shape', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', cwd: '/proj', eventCount: 3, sizeBytes: 99 }] })
    world.registry.list = () => [{ id: 'ws1', path: world.root, title: 'root-ws', sessionIds: ['s1'] }]
    const engine = world.engine({ config: { planTtlMs: 5000 } })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))

    assert.deepEqual(Object.keys(plan).sort(), PLAN_KEYS)
    assert.equal(typeof plan.planId, 'string')
    assert.ok(plan.planId.length > 0)
    assert.equal(plan.createdAt, world.clock.now())
    assert.equal(plan.expiresAt, plan.createdAt + 5000)
    assert.equal(plan.mode, 'trash')
    assert.equal(plan.allowPermanentDeletion, true)
    assert.equal(plan.confirmation, null)
    assert.deepEqual(plan.targets, [{ kind: 'session', id: 's1', title: null, path: world.dirOfSession('s1') }])
    assert.deepEqual(Object.keys(plan.targets[0]).sort(), TARGET_KEYS)
    assert.deepEqual(Object.keys(plan.totals).sort(), TOTALS_KEYS)
    assert.deepEqual(plan.totals, { workspaces: 0, sessions: 1, files: 1, dirs: 0, bytes: 2 })
    assert.deepEqual(plan.warnings, [])
    assert.deepEqual(plan.blockers, [])

    const [item] = plan.items
    assert.deepEqual(Object.keys(item).sort(), SESSION_ITEM_KEYS)
    assert.deepEqual(item, {
      kind: 'session',
      id: 's1',
      workspaceId: 'ws1',
      title: null,
      path: world.dirOfSession('s1'),
      bytes: 2,
      files: 1,
      parentSessionId: null,
      isDescendant: false,
    })
  })

  test('applies the SPEC §3 defaults: trash mode, 5 minute TTL, permanent allowed', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }] }))
    assert.equal(plan.mode, 'trash')
    assert.equal(plan.expiresAt - plan.createdAt, 300000)
    assert.equal(plan.allowPermanentDeletion, true)
  })

  test('includeDescendants collects the subagent closure and never ordinary forks', async () => {
    const world = await makeWorld({
      sessions: [
        { id: 'root', cwd: '/proj' },
        { id: 'child', cwd: '/x', origin: 'subagent', parentSession: 'root', createdAt: 1001 },
        { id: 'grandchild', cwd: '/x', origin: 'subagent', parentSession: 'child', createdAt: 1002 },
        { id: 'fork', cwd: '/x', isSeeded: true, createdAt: 1003 },
        { id: 'elsewhere', cwd: '/x', origin: 'subagent', parentSession: 'other-root', createdAt: 1004 },
        { id: 'ordinary', cwd: '/x', createdAt: 1005 },
      ],
    })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 'root' }], mode: 'trash' }))
    assert.deepEqual(plan.items.map((item) => [item.id, item.isDescendant]), [
      ['root', false],
      ['child', true],
      ['grandchild', true],
    ])
    assert.equal(plan.totals.sessions, 3)
    assert.deepEqual(plan.items[1].parentSessionId, 'root')
    assert.equal(plan.items[2].parentSessionId, 'child')
    const warning = plan.warnings.find((entry) => entry.code === 'SESSION_HAS_DESCENDANTS')
    assert.ok(warning, 'expected a SESSION_HAS_DESCENDANTS warning')
    assert.equal(warning.sessionId, 'root')
    assert.match(warning.message, /2 subagent/)
    assert.deepEqual(Object.keys(warning).sort(), MESSAGE_KEYS)
  })

  test('includeDescendants: false keeps only the requested session', async () => {
    const world = await makeWorld({
      sessions: [
        { id: 'root', cwd: '/proj' },
        { id: 'child', cwd: '/x', origin: 'subagent', parentSession: 'root' },
      ],
    })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 'root' }], mode: 'trash', includeDescendants: false }))
    assert.deepEqual(plan.items.map((item) => item.id), ['root'])
    assert.deepEqual(plan.warnings, [])
  })

  test('a session with no stored location is a registration-only item', async () => {
    const world = await makeWorld({ sessions: [{ id: 'unborn', unborn: true }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 'unborn' }], mode: 'trash' }))
    assert.equal(plan.items[0].path, null)
    assert.equal(plan.items[0].bytes, 0)
    assert.equal(plan.items[0].files, 0)
    assert.deepEqual(plan.totals, { workspaces: 0, sessions: 1, files: 0, dirs: 0, bytes: 0 })
  })

  test('uses $DSH_HOME/trash/dsh-cleanup as the default trash root (SPEC §3)', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const fakeHome = path.join(world.root, 'profile-home')
    const saved = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = fakeHome
      const engine = createEngine({
        workspaceRegistry: world.registry,
        sessionPersistence: world.persistence,
        now: world.clock.now,
      })
      const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
      assert.equal((await engine.execute({ planId: plan.planId })).ok, true)
      const entries = await fsp.readdir(path.join(fakeHome, 'trash', 'dsh-cleanup'))
      assert.equal(entries.length, 1)
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  })

  test('refuses an unknown session', async () => {
    const world = await makeWorld({})
    const engine = world.engine()
    assertFail(await engine.plan({ targets: [{ kind: 'session', id: 'nope' }], mode: 'trash' }), 'UNKNOWN_SESSION')
  })

  test('refuses a stored log whose directory is not the recognized session layout', async () => {
    const world = await makeWorld({ sessions: [{ id: 'bad', dir: path.join(TMP, 'elsewhere-session'), project: 'elsewhere' }] })
    // Point the location into a directory whose parent is not --…--/_no-cwd.
    const weirdDir = path.join(world.root, 'random', 'dir')
    await fsp.mkdir(weirdDir, { recursive: true })
    await fsp.writeFile(path.join(weirdDir, 'log.jsonl'), 'x\n')
    world.snapshot('bad').location = { path: path.join(weirdDir, 'log.jsonl') }
    const engine = world.engine()
    assertFail(await engine.plan({ targets: [{ kind: 'session', id: 'bad' }], mode: 'trash' }), 'IO_ERROR')
  })

  test('blocks a live session with SESSION_LIVE and keeps it in the plan', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }], live: ['s1'] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.deepEqual(plan.items.map((item) => item.id), ['s1'])
    assert.deepEqual(plan.blockers.map((entry) => entry.code), ['SESSION_LIVE'])
    const [blocker] = plan.blockers
    assert.deepEqual(Object.keys(blocker).sort(), MESSAGE_KEYS)
    assert.equal(blocker.sessionId, 's1')
    assert.equal(blocker.workspaceId, null)
    assert.match(blocker.message, /another page|restart the app/)
  })

  test('reports SESSION_RUNNING (not SESSION_LIVE) for a running agent', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }], running: ['s1'] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.deepEqual(plan.blockers.map((entry) => entry.code), ['SESSION_RUNNING'])
  })

  test('an idle agent entry counts as live but not running', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }], idleAgents: ['s1'] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.deepEqual(plan.blockers.map((entry) => entry.code), ['SESSION_LIVE'])
  })

  test('degrades to "not live" when optional liveness services are absent', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    const engine = world.engine({ sessions: null, agents: null })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.deepEqual(plan.blockers, [])
  })

  test('a throwing optional liveness probe fails closed (SESSION_LIVE) at plan and at admission', async () => {
    // SPEC §5.2: only a resolved absence counts as absent. A probe that throws means "unknown", which
    // is refused as SESSION_LIVE instead of being deleted (the old fail-open behaviour).
    const throwingWorld = await makeWorld({ sessions: [{ id: 's1' }] })
    const throwing = {
      get() {
        throw new Error('agent registry offline')
      },
    }
    const planned = planOf(await throwingWorld.engine({ sessions: throwing, agents: throwing }).plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.deepEqual(planned.items.map((item) => item.id), ['s1'], 'the refused session stays reviewable in the plan')
    assert.deepEqual(planned.blockers.map((entry) => entry.code), ['SESSION_LIVE'])
    assert.equal(planned.blockers[0].sessionId, 's1')
    assert.match(planned.blockers[0].message, /could not be verified/)

    // The same gate runs at admission: plan while the probe answers, execute once it throws.
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    let wedged = false
    const flaky = {
      get() {
        if (wedged) throw new Error('agent registry offline')
        return undefined
      },
    }
    const engine = world.engine({ sessions: flaky, agents: flaky })
    const healthy = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.deepEqual(healthy.blockers, [])
    wedged = true
    const response = await engine.execute({ planId: healthy.planId })
    assertFail(response, 'STATE_CHANGED')
    assert.ok(response.error.details.reasons.some((reason) => reason.code === 'SESSION_LIVE' && reason.sessionId === 's1'))
    await assertExists(world.dirOfSession('s1'), 'the session log is left intact')
    assert.deepEqual(await trashEntries(world), [])
  })

  test('returns IO_ERROR when the stored-session list cannot be read', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    const engine = world.engine({
      sessionPersistence: {
        list: async () => {
          throw new Error('storage down')
        },
        stat: async (id) => world.snapshot(id),
      },
    })
    assertFail(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }), 'IO_ERROR')
  })
})

// #endregion

// #region plan: workspace targets (SPEC §5.1/§5.3/§5.4) ---------------------------------------

describe('plan: workspace targets', () => {
  test('includeSessions adds cwd-inside sessions plus their subagent descendants', async () => {
    const world = await makeWorld({
      workspaces: [{ id: 'ws1', title: 'proj', sessionIds: ['sEqual'], files: { 'a.txt': 'abc', 'sub/b.txt': 'de' } }],
      sessions: [
        { id: 'sEqual', cwd: undefined, createdAt: 10 },
        { id: 'sDeep', cwd: undefined, createdAt: 11 },
        { id: 'sSibling', cwd: undefined, createdAt: 12 },
        { id: 'sChild', cwd: '/x', origin: 'subagent', parentSession: 'sEqual', createdAt: 13 },
        { id: 'sGrandchild', cwd: '/x', origin: 'subagent', parentSession: 'sChild', createdAt: 14 },
        { id: 'sStray', cwd: '/x', origin: 'subagent', parentSession: 'other', createdAt: 15 },
      ],
    })
    const ws = world.dirOf('ws1')
    world.snapshot('sEqual').header.cwd = ws
    world.snapshot('sDeep').header.cwd = path.join(ws, 'sub', 'deep')
    world.snapshot('sSibling').header.cwd = `${ws}-sibling`
    const engine = world.engine()
    const plan = planOf(
      await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: true, includeDescendants: false }),
    )

    assert.deepEqual(plan.targets, [{ kind: 'workspace', id: 'ws1', title: 'proj', path: ws }])
    const workspaceItem = plan.items.find((item) => item.kind === 'workspace-dir')
    assert.deepEqual(Object.keys(workspaceItem).sort(), WORKSPACE_ITEM_KEYS)
    assert.deepEqual(workspaceItem, {
      kind: 'workspace-dir',
      id: 'ws1',
      title: 'proj',
      path: ws,
      bytes: 5,
      files: 2,
      dirs: 1,
      truncated: false,
    })
    const sessions = plan.items.filter((item) => item.kind === 'session')
    assert.deepEqual(sessions.map((item) => [item.id, item.isDescendant]), [
      ['sEqual', false],
      ['sDeep', false],
      ['sChild', true],
      ['sGrandchild', true],
    ])
    assert.equal(sessions[0].workspaceId, 'ws1')
    assert.equal(sessions[1].workspaceId, null)
    assert.deepEqual(plan.totals, { workspaces: 1, sessions: 4, files: 6, dirs: 1, bytes: 13 })
    assert.deepEqual(plan.warnings, [])
  })

  test('includeSessions: false leaves the sessions alone and warns SESSIONS_FROM_DIR', async () => {
    const world = await makeWorld({
      workspaces: [{ id: 'ws1' }],
      sessions: [
        { id: 's1', cwd: undefined },
        { id: 's2', cwd: undefined },
      ],
    })
    const ws = world.dirOf('ws1')
    world.snapshot('s1').header.cwd = ws
    world.snapshot('s2').header.cwd = path.join(ws, 'sub')
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.deepEqual(plan.items.map((item) => item.kind), ['workspace-dir'])
    const warning = plan.warnings.find((entry) => entry.code === 'SESSIONS_FROM_DIR')
    assert.ok(warning, 'expected SESSIONS_FROM_DIR')
    assert.equal(warning.workspaceId, 'ws1')
    assert.match(warning.message, /2 stored session/)
  })

  test('a missing workspace is a registration-only plan with a WORKSPACE_MISSING warning', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', create: false, title: 'gone' }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash' }))
    assert.deepEqual(plan.items.map((item) => item), [
      { kind: 'workspace-dir', id: 'ws1', title: 'gone', path: world.entity('ws1').path, bytes: 0, files: 0, dirs: 0, truncated: false },
    ])
    assert.deepEqual(plan.warnings.map((entry) => entry.code), ['WORKSPACE_MISSING'])
    assert.deepEqual(plan.blockers, [])
    assert.equal(plan.confirmation, null)
  })

  test('warns WORKSPACE_HAS_GIT when a .git directory is present', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', git: true }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.deepEqual(plan.warnings.map((entry) => entry.code), ['WORKSPACE_HAS_GIT'])
  })

  test('blocks a workspace that became a symlink', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const link = path.join(world.root, 'ws-link')
    await fsp.symlink(world.dirOf('ws1'), link, 'dir')
    world.entity('ws1').path = link
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash' }))
    assert.deepEqual(plan.blockers.map((entry) => entry.code), ['WORKSPACE_SYMLINK'])
    assert.equal(plan.blockers[0].workspaceId, 'ws1')
  })

  test('blocks a workspace path that is no longer a directory', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', create: false }] })
    const filePath = path.join(world.root, 'not-a-dir')
    await fsp.writeFile(filePath, 'x')
    world.entity('ws1').path = filePath
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash' }))
    assert.deepEqual(plan.blockers.map((entry) => entry.code), ['PATH_PROTECTED'])
  })

  test('blocks a path whose realpath differs from the registered canonical path (PATH_CHANGED)', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const real = world.dirOf('ws1')
    await fsp.mkdir(path.join(real, 'sub'), { recursive: true })
    const link = path.join(world.root, 'link-to-ws')
    await fsp.symlink(real, link, 'dir')
    world.entity('ws1').path = path.join(link, 'sub')
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash' }))
    assert.deepEqual(plan.blockers.map((entry) => entry.code), ['PATH_CHANGED'])
  })

  test('blocks a workspace containing the DSH profile home (CONTAINS_DSH_HOME)', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const ws = world.dirOf('ws1')
    const fakeHome = path.join(ws, 'dsh-home')
    await fsp.mkdir(fakeHome, { recursive: true })
    const saved = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = fakeHome
      const engine = world.engine()
      const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
      assert.deepEqual(plan.blockers.map((entry) => entry.code), ['CONTAINS_DSH_HOME'])
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  })

  test('blocks a workspace inside the DSH profile home (PATH_PROTECTED)', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const fakeHome = path.join(world.root, 'profile-home')
    const ws = path.join(fakeHome, 'work')
    await fsp.mkdir(ws, { recursive: true })
    world.entity('ws1').path = ws
    const saved = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = fakeHome
      const engine = world.engine()
      const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
      assert.deepEqual(plan.blockers.map((entry) => entry.code), ['PATH_PROTECTED'])
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  })

  test('blocks any live session whose cwd is inside the workspace, even when not in the deletion set', async () => {
    const world = await makeWorld({
      workspaces: [{ id: 'ws1' }],
      sessions: [{ id: 'open', cwd: undefined }],
      live: ['open'],
    })
    world.snapshot('open').header.cwd = world.dirOf('ws1')
    const engine = world.engine()
    const plan = planOf(
      await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }),
    )
    assert.deepEqual(plan.blockers.map((entry) => entry.code), ['WORKSPACE_HAS_LIVE_SESSIONS'])
    assert.match(plan.blockers[0].message, /open/)
  })

  test('blocks the trash mode when the trash volume differs (TRASH_CROSS_DEVICE)', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const fsOps = { stat: async () => ({ dev: -424242 }) }
    const engine = world.engine({ fsOps })
    const trashPlan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash' }))
    assert.deepEqual(trashPlan.blockers.map((entry) => entry.code), ['TRASH_CROSS_DEVICE'])
    assert.match(trashPlan.blockers[0].message, /different volume/)
    const permanentPlan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'permanent' }))
    assert.deepEqual(permanentPlan.blockers, [])
  })

  test('blocks the trash mode when the trash device cannot be determined (TRASH_UNAVAILABLE)', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const engine = world.engine({
      fsOps: {
        stat: async () => {
          throw new Error('cannot stat')
        },
      },
    })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash' }))
    assert.deepEqual(plan.blockers.map((entry) => entry.code), ['TRASH_UNAVAILABLE'])
  })

  test('refuses the permanent mode when allowPermanentDeletion is false', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const engine = world.engine({ config: { allowPermanentDeletion: false } })
    assertFail(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'permanent' }), 'PERMANENT_DISABLED')
    const trashPlan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash' }))
    assert.equal(trashPlan.allowPermanentDeletion, false)
  })

  test('requires typed confirmation for a present workspace directory in permanent mode', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', title: 'My Project' }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'permanent', includeSessions: false }))
    assert.deepEqual(plan.confirmation, {
      kind: 'typed-name',
      expected: path.basename(world.dirOf('ws1')),
      label: 'My Project',
    })
  })

  test('refuses a permanent plan over more than one existing workspace directory', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws-a', title: 'Alpha' }, { id: 'ws-b' }] })
    const engine = world.engine()
    const response = await engine.plan({
      targets: [{ kind: 'workspace', id: 'ws-a' }, { kind: 'workspace', id: 'ws-b' }],
      mode: 'permanent',
      includeSessions: false,
    })
    assertFail(response, 'PERMANENT_MULTIPLE_DIRECTORIES')
    assert.deepEqual(response.error.details, { workspaceIds: ['ws-a', 'ws-b'] })
    assert.equal('plan' in response, false, 'a refused permanent plan must not allocate a plan')
    assert.equal(response.error.details.planId, undefined)
    // Nothing mutated: directories, registrations, registry sets and trash are untouched.
    await assertExists(world.dirOf('ws-a'), 'ws-a directory')
    await assertExists(world.dirOf('ws-b'), 'ws-b directory')
    assert.equal(world.entities.has('ws-a'), true)
    assert.equal(world.entities.has('ws-b'), true)
    assert.deepEqual(world.registryCalls, [])
    assert.deepEqual(await trashEntries(world), [])
  })

  test('a symlink or file target counts as an existing directory for the multi-directory refusal', async () => {
    // SPEC §4.3: an "existing workspace directory" is a target the plan does not report
    // WORKSPACE_MISSING for, so unsafe targets (symlink, file) count toward the refusal too.
    const world = await makeWorld({ workspaces: [{ id: 'ws-real' }, { id: 'ws-link' }, { id: 'ws-file', create: false }] })
    const linkTarget = path.join(world.root, 'link-target')
    await fsp.mkdir(linkTarget)
    const link = path.join(world.root, 'ws-alias')
    await fsp.symlink(linkTarget, link, 'dir')
    world.entity('ws-link').path = link
    const plainFile = path.join(world.root, 'plain-file')
    await fsp.writeFile(plainFile, 'x')
    world.entity('ws-file').path = plainFile
    const engine = world.engine()
    const response = await engine.plan({
      targets: [{ kind: 'workspace', id: 'ws-real' }, { kind: 'workspace', id: 'ws-link' }, { kind: 'workspace', id: 'ws-file' }],
      mode: 'permanent',
      includeSessions: false,
    })
    assertFail(response, 'PERMANENT_MULTIPLE_DIRECTORIES')
    assert.deepEqual(response.error.details, { workspaceIds: ['ws-real', 'ws-link', 'ws-file'] })
    // A single blocked target keeps its blockers on a plan that stays single (SPEC §4.3).
    const single = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws-link' }], mode: 'permanent', includeSessions: false }))
    assert.deepEqual(single.blockers.map((entry) => entry.code), ['WORKSPACE_SYMLINK'])
    // SPEC §4.3: the typed name is the deliberation gate for the deferred route, so a blocked
    // (unsafe) target still carries it; only trash mode, session-only or a missing directory are null.
    assert.deepEqual(single.confirmation, {
      kind: 'typed-name',
      expected: path.basename(link),
      label: world.entity('ws-link').title,
    })
  })

  test('PERMANENT_DISABLED is decided before the multi-directory refusal', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws-a' }, { id: 'ws-b' }] })
    const engine = world.engine({ config: { allowPermanentDeletion: false } })
    assertFail(
      await engine.plan({ targets: [{ kind: 'workspace', id: 'ws-a' }, { kind: 'workspace', id: 'ws-b' }], mode: 'permanent' }),
      'PERMANENT_DISABLED',
    )
  })

  test('confirmation label falls back to the directory name when the workspace title is empty', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', title: '' }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'permanent', includeSessions: false }))
    assert.deepEqual(plan.confirmation, {
      kind: 'typed-name',
      expected: path.basename(world.dirOf('ws1')),
      label: path.basename(world.dirOf('ws1')),
    })
  })

  test('a permanent plan over one existing and one missing workspace directory is allowed', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws-a', title: 'Alpha' }, { id: 'ws-gone', create: false }] })
    const engine = world.engine()
    const plan = planOf(
      await engine.plan({
        targets: [{ kind: 'workspace', id: 'ws-a' }, { kind: 'workspace', id: 'ws-gone' }],
        mode: 'permanent',
        includeSessions: false,
      }),
    )
    assert.deepEqual(plan.confirmation, {
      kind: 'typed-name',
      expected: path.basename(world.dirOf('ws-a')),
      label: 'Alpha',
    })
    assert.equal(plan.items.filter((item) => item.kind === 'workspace-dir').length, 2)
  })

  test('no typed confirmation for trash mode, session-only or missing directories', async () => {
    const world = await makeWorld({
      workspaces: [{ id: 'ws1' }, { id: 'gone', create: false }],
      sessions: [{ id: 's1' }],
    })
    const engine = world.engine()
    const trash = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash' }))
    assert.equal(trash.confirmation, null)
    const sessionOnly = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'permanent' }))
    assert.equal(sessionOnly.confirmation, null)
    const missing = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'gone' }], mode: 'permanent', includeSessions: false }))
    assert.equal(missing.confirmation, null)
  })

  test('a blocked permanent plan still carries the typed confirmation', async () => {
    // SPEC §4.3 (amended): confirmation is deliberately independent of blockers — the typed folder
    // name is the deliberation gate for the deferred route, which is the only way a blocked deletion
    // can ever run. The blockers still prevent any in-process execution.
    const world = await makeWorld({
      workspaces: [{ id: 'ws1', title: 'proj' }],
      sessions: [{ id: 'open', cwd: undefined }],
      live: ['open'],
    })
    world.snapshot('open').header.cwd = world.dirOf('ws1')
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'permanent', includeSessions: false }))
    assert.ok(plan.blockers.length > 0)
    assert.deepEqual(plan.confirmation, {
      kind: 'typed-name',
      expected: path.basename(world.dirOf('ws1')),
      label: 'proj',
    })
    // The confirmation gate is checked before admission, but the blocked plan still mutates nothing.
    assertFail(await engine.execute({ planId: plan.planId, confirmationText: plan.confirmation.expected }), 'STATE_CHANGED')
    await assertExists(world.dirOf('ws1'), 'blocked workspace directory')
  })

  test('deduplicates targets and items', async () => {
    const world = await makeWorld({
      workspaces: [{ id: 'ws1', sessionIds: ['s1'] }],
      sessions: [{ id: 's1', cwd: undefined }],
    })
    world.snapshot('s1').header.cwd = world.dirOf('ws1')
    const engine = world.engine()
    const plan = planOf(
      await engine.plan({
        targets: [
          { kind: 'workspace', id: 'ws1' },
          { kind: 'workspace', id: 'ws1' },
          { kind: 'session', id: 's1' },
          { kind: 'session', id: 's1' },
        ],
        mode: 'trash',
      }),
    )
    assert.equal(plan.targets.length, 2)
    assert.equal(plan.items.filter((item) => item.kind === 'workspace-dir').length, 1)
    assert.equal(plan.items.filter((item) => item.kind === 'session').length, 1)
  })

  test('warns SCAN_TRUNCATED and marks the item truncated when the walk budget is hit', async () => {
    const files = {}
    for (let index = 0; index < 5; index += 1) files[`f${index}.txt`] = 'x'
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files }] })
    const engine = world.engine({ config: { maxScanEntries: 2 } })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.equal(plan.items[0].truncated, true)
    assert.ok(plan.warnings.some((entry) => entry.code === 'SCAN_TRUNCATED'))
  })

  test('warns LARGE_TARGET for a target larger than 1 GiB', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'big.bin': 'x' } }] })
    const fsOps = {
      lstat: async (target) => {
        const stats = await nodeFs.lstat(target)
        if (path.basename(String(target)) === 'big.bin') {
          return { size: 1024 ** 3 + 1, mtimeMs: stats.mtimeMs, dev: stats.dev, isSymbolicLink: () => false, isDirectory: () => false }
        }
        return stats
      },
    }
    const engine = world.engine({ fsOps })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.ok(plan.warnings.some((entry) => entry.code === 'LARGE_TARGET'))
  })

  test('emits the paths.js PATH_NOT_ABSOLUTE blocker code for a relative workspace path', async () => {
    // SPEC §4.6: of the newly listed lib/paths.js codes only PATH_NOT_ABSOLUTE is emitted; the engine
    // maps PATH_NOT_DIRECTORY to PATH_PROTECTED and PATH_NOT_SESSION_DIR to IO_ERROR. It emits this
    // one as-is for a registry entity whose stored path is relative.
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    world.entity('ws1').path = 'relative/workspace'
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.deepEqual(plan.blockers.map((entry) => entry.code), ['PATH_NOT_ABSOLUTE'])
  })

  test('marks the scan truncated when the wall-clock budget is exceeded (scanTimeoutMs)', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { a: '1', b: '2', c: '3' } }] })
    let tick = 1_000_000
    const engine = world.engine({ now: () => (tick += 50), config: { scanTimeoutMs: 1 } })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.equal(plan.items[0].truncated, true)
    assert.ok(plan.warnings.some((entry) => entry.code === 'SCAN_TRUNCATED'))
  })

  test('refuses an unknown workspace', async () => {
    const world = await makeWorld({})
    const engine = world.engine()
    assertFail(await engine.plan({ targets: [{ kind: 'workspace', id: 'nope' }], mode: 'trash' }), 'UNKNOWN_WORKSPACE')
  })

  test('rejects malformed plan requests', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const engine = world.engine()
    const bodies = [
      null,
      'x',
      {},
      { targets: 'ws1' },
      { targets: [] },
      { targets: [null] },
      { targets: [{ kind: 'nope', id: 'ws1' }] },
      { targets: [{ kind: 'workspace' }] },
      { targets: [{ kind: 'workspace', id: '' }] },
      { targets: [{ kind: 'workspace', id: 42 }] },
      { targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'delete' },
      { targets: [{ kind: 'workspace', id: 'ws1' }], includeSessions: 'yes' },
      { targets: [{ kind: 'workspace', id: 'ws1' }], includeDescendants: 1 },
    ]
    for (const body of bodies) {
      const response = await engine.plan(body)
      assert.equal(response.ok, false, JSON.stringify(body))
      assert.equal(response.error.code, 'BAD_REQUEST', JSON.stringify(body))
    }
  })
})

// #endregion

// #region execute: trash mode (SPEC §4.4/§5.5) -------------------------------------------------

describe('execute: trash mode', () => {
  test('moves a workspace and its inside sessions into the trash with metadata', async () => {
    const world = await makeWorld({
      workspaces: [{ id: 'ws1', title: 'proj', sessionIds: ['sIn'], files: { 'a.txt': 'hello', 'sub/b.txt': 'world!' } }],
      sessions: [
        { id: 'sIn', cwd: undefined, createdAt: 1 },
        { id: 'sChild', cwd: '/x', origin: 'subagent', parentSession: 'sIn', createdAt: 2 },
      ],
    })
    const ws = world.dirOf('ws1')
    world.snapshot('sIn').header.cwd = ws
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash' }))
    const planned = plan.items.length
    assert.equal(planned, 3)

    const response = await engine.execute({ planId: plan.planId })
    assert.equal(response.ok, true)
    assertPureJson(response)
    const result = response.result
    assert.deepEqual(result.items.map((item) => [item.id, item.status]), [
      ['ws1', 'trashed'],
      ['sIn', 'trashed'],
      ['sChild', 'trashed'],
    ])
    for (const item of result.items) {
      assert.deepEqual(Object.keys(item).sort(), RESULT_ITEM_KEYS)
      assert.equal(item.error, null)
      assert.ok(path.isAbsolute(item.movedTo))
    }
    assert.deepEqual(Object.keys(result.totals).sort(), RESULT_TOTALS_KEYS)
    assert.deepEqual(result.totals, { trashed: 3, deleted: 0, failed: 0, bytes: 15 })

    await assertGone(ws, 'workspace directory')
    await assertGone(world.dirOfSession('sIn'), 'session directory')
    await assertGone(world.dirOfSession('sChild'), 'session directory')

    const entries = await trashEntries(world)
    assert.equal(entries.length, 3)
    const byKind = new Map()
    for (const entry of entries) {
      assert.ok(entry.meta, `meta.json missing for ${entry.entryId}`)
      byKind.set(entry.meta.kind, entry)
      assert.equal(entry.meta.version, 1)
      assert.ok(path.isAbsolute(entry.meta.originalPath))
      assert.equal(typeof entry.meta.movedAt, 'number')
      await assertExists(path.join(entry.entryDir, 'payload'), 'payload directory')
    }
    const workspaceEntry = byKind.get('workspace-dir')
    assert.equal(workspaceEntry.meta.title, 'proj')
    assert.equal(workspaceEntry.meta.originalPath, ws)
    assert.equal(workspaceEntry.meta.workspaceId, 'ws1')
    assert.equal(workspaceEntry.meta.bytes, 11)
    assert.equal(workspaceEntry.meta.files, 2)
    assert.equal(workspaceEntry.meta.dirs, 1)
    await assertExists(path.join(workspaceEntry.entryDir, 'payload', 'sub', 'b.txt'), 'moved workspace file')
    const sessionEntry = entries.find((entry) => entry.meta.kind === 'session' && entry.meta.sessionIds?.[0] === 'sIn')
    assert.ok(sessionEntry, 'expected the sIn session entry')
    assert.equal(sessionEntry.meta.workspaceId, 'ws1')
    assert.equal(sessionEntry.meta.originalPath, world.dirOfSession('sIn'))

    const calls = world.registryCalls
    assert.deepEqual(calls.filter(([name]) => name !== 'delete').map(([name, id]) => `${name}:${id}`), [
      'unpin:sIn',
      'unarchive:sIn',
      'unpin:sChild',
      'unarchive:sChild',
    ])
    assert.deepEqual(calls.at(-1), ['delete', 'ws1'])
  })

  test('drops registry sets before touching files and deletes sessions before directories', async () => {
    const world = await makeWorld({
      workspaces: [{ id: 'ws1' }],
      sessions: [
        { id: 'sA', cwd: undefined, createdAt: 1 },
        { id: 'sB', cwd: undefined, createdAt: 2 },
      ],
    })
    const ws = world.dirOf('ws1')
    world.snapshot('sA').header.cwd = ws
    world.snapshot('sB').header.cwd = ws
    const log = []
    logRegistry(world, log)
    const engine = world.engine({ fsOps: loggingFsOps(log) })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash' }))
    log.length = 0
    const response = await engine.execute({ planId: plan.planId })
    assert.equal(response.ok, true)

    // Each Session's registry sets are dropped immediately before that Session's own log moves, so a
    // refused item never loses its pin and a crash cannot leave a set pointing at a deleted log.
    const renameIndex = (dir) => log.findIndex((entry) => entry.type === 'fs' && entry.name === 'rename' && entry.from === dir)
    const setIndex = (name, id) => log.findIndex((entry) => entry.type === 'registry' && entry.name === name && entry.id === id)
    const sessionRenames = new Map([
      ['sA', renameIndex(world.dirOfSession('sA'))],
      ['sB', renameIndex(world.dirOfSession('sB'))],
    ])
    for (const [id, rename] of sessionRenames) {
      assert.ok(rename > -1, `${id} log must be moved`)
      assert.ok(setIndex('unpin', id) > -1 && setIndex('unpin', id) < rename, `${id} unpin before its log moves`)
      assert.ok(setIndex('unarchive', id) > -1 && setIndex('unarchive', id) < rename, `${id} unarchive before its log moves`)
    }
    const workspaceRename = log.findIndex((entry) => entry.type === 'fs' && entry.name === 'rename' && entry.from === ws)
    assert.ok(workspaceRename > Math.max(...sessionRenames.values()), 'sessions must be moved before the workspace directory')
    // The still-earlier Session's log must not move before its own sets are dropped either: the order
    // is per item (drop, re-check, mutate), not "all sets, then all files".
    assert.ok(sessionRenames.get('sA') < setIndex('unpin', 'sB'), 'items are executed one at a time')
    const registryDelete = log.findIndex((entry) => entry.type === 'registry' && entry.name === 'delete')
    assert.ok(registryDelete > workspaceRename, 'workspaceRegistry.delete must run after the directory is gone')
  })

  test('a session without a location is reported deleted with no filesystem work', async () => {
    const world = await makeWorld({ sessions: [{ id: 'unborn', unborn: true }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 'unborn' }], mode: 'trash' }))
    const response = await engine.execute({ planId: plan.planId })
    assert.equal(response.ok, true)
    assert.deepEqual(response.result.items, [
      { kind: 'session', id: 'unborn', status: 'deleted', error: null, movedTo: null, bytes: 0 },
    ])
    assert.deepEqual(await trashEntries(world), [])
    assert.deepEqual(world.registryCalls, [
      ['unpin', 'unborn'],
      ['unarchive', 'unborn'],
    ])
  })

  test('a session directory that vanished between plan and execute answers STATE_CHANGED with nothing mutated', async () => {
    // SPEC §5.1/§5.6: admission now validates the planned session directory (lstat + realpath), so a
    // directory that disappeared after review stops the whole plan before any item mutates.
    const world = await makeWorld({ sessions: [{ id: 's1', createdAt: 1 }, { id: 's2', createdAt: 2 }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }, { kind: 'session', id: 's2' }], mode: 'trash' }))
    await fsp.rm(world.dirOfSession('s2'), { recursive: true })
    const response = await engine.execute({ planId: plan.planId })
    assertFail(response, 'STATE_CHANGED')
    assert.ok(response.error.details.reasons.some((reason) => reason.code === 'PATH_CHANGED' && reason.sessionId === 's2'))
    // Nothing at all was touched: the healthy session stays, no entry was created, no set dropped.
    await assertExists(path.join(world.dirOfSession('s1'), 'log.jsonl'), 'the healthy session log')
    assert.deepEqual(await trashEntries(world), [])
    assert.deepEqual(world.registryCalls, [])
    assertFail(await engine.execute({ planId: plan.planId }), 'PLAN_UNKNOWN')
  })

  test('rolls the payload back and leaves no entry when meta.json cannot be written', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'a.txt': 'hello' } }] })
    const fsOps = {
      writeFile: async (target, ...rest) => {
        if (String(target).endsWith('meta.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        return nodeFs.writeFile(target, ...rest)
      },
    }
    const engine = world.engine({ fsOps })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    const response = await engine.execute({ planId: plan.planId })
    const [item] = response.result.items
    assert.equal(item.status, 'failed')
    assert.equal(item.error.code, 'IO_ERROR')
    assert.match(item.error.message, /nothing was moved/)
    await assertExists(path.join(world.dirOf('ws1'), 'a.txt'), 'rolled-back workspace file')
    assert.deepEqual(await trashEntries(world), [])
  })

  test('maps an EXDEV rename failure to TRASH_CROSS_DEVICE for that item', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    const fsOps = {
      rename: async () => {
        const error = new Error('EXDEV: cross-device link not permitted')
        error.code = 'EXDEV'
        throw error
      },
    }
    const engine = world.engine({ fsOps })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    const response = await engine.execute({ planId: plan.planId })
    const [item] = response.result.items
    assert.equal(item.status, 'failed')
    assert.equal(item.error.code, 'TRASH_CROSS_DEVICE')
    assert.match(item.error.message, /different volume/)
    await assertExists(world.dirOfSession('s1'), 'session directory')
    assert.deepEqual(await trashEntries(world), [])
  })

  test('reports a workspace item as failed when registry.delete throws, and says the files are gone', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    world.registry.delete = async () => {
      throw new Error('registry boom')
    }
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash' }))
    const response = await engine.execute({ planId: plan.planId })
    const [item] = response.result.items
    assert.equal(item.status, 'failed')
    assert.equal(item.error.code, 'IO_ERROR')
    assert.match(item.error.message, /moved to the trash/)
    assert.match(item.error.message, /registry boom/)
    await assertGone(world.dirOf('ws1'), 'workspace directory')
    const entries = await trashEntries(world)
    assert.equal(entries.length, 1)
    // The directory really is in the trash, so the failed item must say where it went (SPEC §4.4).
    assert.equal(typeof item.movedTo, 'string')
    assert.ok(path.isAbsolute(item.movedTo))
    assert.equal(item.movedTo, entries[0].entryDir)
    await assertExists(path.join(item.movedTo, 'payload'), 'trash payload directory')
    assert.equal(entries[0].meta.originalPath, world.dirOf('ws1'))
    // SPEC §4.4: totals.bytes counts only trashed+deleted items.
    assert.deepEqual(response.result.totals, { trashed: 0, deleted: 0, failed: 1, bytes: 0 })
  })

  test('a permanent deletion that fails only at registry.delete keeps movedTo null', async () => {
    // SPEC §4.4: a permanent deletion that failed after the directory was removed has nowhere to
    // recover from, so movedTo stays null (unlike the trashed-then-registry-failure case).
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    world.registry.delete = async () => {
      throw new Error('registry boom')
    }
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'permanent', includeSessions: false }))
    const response = await engine.execute({ planId: plan.planId, confirmationText: plan.confirmation.expected })
    const [item] = response.result.items
    assert.equal(item.status, 'failed')
    assert.equal(item.error.code, 'IO_ERROR')
    assert.match(item.error.message, /deleted but/)
    assert.equal(item.movedTo, null)
    await assertGone(world.dirOf('ws1'), 'workspace directory')
    assert.deepEqual(response.result.totals, { trashed: 0, deleted: 0, failed: 1, bytes: 0 })
  })

  test('keeps session files in place when the registry sets cannot be dropped', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    world.registry.unpinSession = async () => {
      throw new Error('storage boom')
    }
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    const response = await engine.execute({ planId: plan.planId })
    const [item] = response.result.items
    assert.equal(item.status, 'failed')
    assert.equal(item.error.code, 'IO_ERROR')
    assert.match(item.error.message, /left untouched/)
    await assertExists(world.dirOfSession('s1'), 'session directory')
    assert.deepEqual(await trashEntries(world), [])
  })

  test('a rejected unpin/unarchive answer is a real failure now that the benign matcher is gone', async () => {
    // The shipped registry resolves unpin/unarchive of an absent id, so any rejection is a storage
    // failure. The removed substring matcher used to swallow a rejection whose message merely
    // contained "not pinned"/"not archived", hiding a genuine failure.
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    world.registry.unpinSession = async () => {
      throw new Error('not pinned')
    }
    world.registry.unarchiveSession = async () => {
      throw Object.assign(new Error('not archived'), { code: 'ENOENT' })
    }
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    const response = await engine.execute({ planId: plan.planId })
    const [item] = response.result.items
    assert.equal(item.status, 'failed')
    assert.equal(item.error.code, 'IO_ERROR')
    assert.match(item.error.message, /left untouched/)
    assert.match(item.error.message, /not pinned/)
    await assertExists(world.dirOfSession('s1'), 'the session log is kept in place')
    assert.deepEqual(await trashEntries(world), [])
    assert.deepEqual(response.result.totals, { trashed: 0, deleted: 0, failed: 1, bytes: 0 })
  })
})

// #endregion

// #region execute: permanent mode + typed confirmation ---------------------------------------

describe('execute: permanent mode and typed confirmation', () => {
  test('requires, validates and applies typed confirmation; every failure consumes the plan', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', title: 'proj' }] })
    const engine = world.engine()
    const expected = path.basename(world.dirOf('ws1'))

    const first = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'permanent', includeSessions: false }))
    assert.deepEqual(first.confirmation, { kind: 'typed-name', expected, label: 'proj' })
    const missing = await engine.execute({ planId: first.planId })
    assertFail(missing, 'CONFIRMATION_REQUIRED')
    assertFail(await engine.execute({ planId: first.planId }), 'PLAN_UNKNOWN')
    await assertExists(world.dirOf('ws1'), 'workspace directory')

    const second = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'permanent', includeSessions: false }))
    const empty = await engine.execute({ planId: second.planId, confirmationText: '' })
    assertFail(empty, 'CONFIRMATION_REQUIRED')
    const third = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'permanent', includeSessions: false }))
    const wrong = await engine.execute({ planId: third.planId, confirmationText: 'nope' })
    assertFail(wrong, 'CONFIRMATION_MISMATCH')
    await assertGone(world.dirOf('ws1') + '-wrong', 'nothing should be deleted')
    await assertExists(world.dirOf('ws1'), 'workspace directory')

    const fourth = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'permanent', includeSessions: false }))
    const okResponse = await engine.execute({ planId: fourth.planId, confirmationText: expected })
    assert.equal(okResponse.ok, true)
    assert.deepEqual(okResponse.result.items, [
      { kind: 'workspace-dir', id: 'ws1', status: 'deleted', error: null, movedTo: null, bytes: 0 },
    ])
    await assertGone(world.dirOf('ws1'), 'workspace directory')
    assert.equal(world.entities.has('ws1'), false)
    assert.deepEqual(await trashEntries(world), [])
  })

  test('permanently deletes session logs without typed confirmation', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', createdAt: 1 }, { id: 's2', createdAt: 2 }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }, { kind: 'session', id: 's2' }], mode: 'permanent' }))
    assert.equal(plan.confirmation, null)
    const response = await engine.execute({ planId: plan.planId })
    assert.deepEqual(response.result.items.map((item) => [item.id, item.status]), [
      ['s1', 'deleted'],
      ['s2', 'deleted'],
    ])
    assert.deepEqual(response.result.totals, { trashed: 0, deleted: 2, failed: 0, bytes: 4 })
    await assertGone(world.dirOfSession('s1'), 'session directory')
    await assertGone(world.dirOfSession('s2'), 'session directory')
    assert.deepEqual(await trashEntries(world), [])
  })

  test('refuses a permanently requested walk that exceeds the delete budget, leaving the tree intact', async () => {
    const files = {}
    for (let index = 0; index < 6; index += 1) files[`f${index}.txt`] = 'x'
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files }] })
    const engine = world.engine({ config: { maxScanEntries: 3 } })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'permanent', includeSessions: false }))
    const response = await engine.execute({ planId: plan.planId, confirmationText: path.basename(world.dirOf('ws1')) })
    const [item] = response.result.items
    assert.equal(item.status, 'failed')
    assert.equal(item.error.code, 'IO_ERROR')
    assert.match(item.error.message, /scan budget/)
    await assertExists(world.dirOf('ws1'), 'workspace directory')
    assert.equal(world.entities.has('ws1'), true)
  })
})

// #endregion

// #region admission re-check (SPEC §5.6) ------------------------------------------------------

describe('admission re-check', () => {
  test('STATE_CHANGED when a planned session becomes live; nothing is mutated and the plan is consumed', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    world.liveStore.set('s1', { id: 's1' })
    const response = await engine.execute({ planId: plan.planId })
    assertFail(response, 'STATE_CHANGED')
    await assertExists(world.dirOfSession('s1'), 'session directory')
    assert.deepEqual(await trashEntries(world), [])
    assertFail(await engine.execute({ planId: plan.planId }), 'PLAN_UNKNOWN')
  })

  test('STATE_CHANGED when a session log location changed after planning', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    world.snapshot('s1').location = {
      path: path.join(world.root, 'sessions', '--moved--', 's1', 'log.jsonl'),
    }
    const response = await engine.execute({ planId: plan.planId })
    assertFail(response, 'STATE_CHANGED')
    await assertExists(world.dirOfSession('s1'), 'session directory')
  })

  test('STATE_CHANGED when the workspace canonical path changed after planning', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    const other = path.join(world.root, 'other-dir')
    await fsp.mkdir(other)
    world.entity('ws1').path = other
    const response = await engine.execute({ planId: plan.planId })
    assertFail(response, 'STATE_CHANGED')
    await assertExists(world.dirOf('ws1'), 'workspace directory')
  })

  test('STATE_CHANGED when a planned-missing workspace directory reappears', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', create: false }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    await fsp.mkdir(world.entity('ws1').path, { recursive: true })
    const response = await engine.execute({ planId: plan.planId })
    assertFail(response, 'STATE_CHANGED')
    assert.equal(world.entities.has('ws1'), true, 'the registration must survive a rejected admission')
  })

  test('STATE_CHANGED when the workspace directory disappears after planning', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    await fsp.rm(world.dirOf('ws1'), { recursive: true })
    const response = await engine.execute({ planId: plan.planId })
    assertFail(response, 'STATE_CHANGED')
    assert.equal(world.entities.has('ws1'), true)
  })

  test('executing an already-blocked plan answers STATE_CHANGED', async () => {
    // SPEC §5.5 (amended): a plan created with blockers can never mutate; admission re-seeds every
    // planned blocker as a changed-world reason, so execute answers STATE_CHANGED even when nothing
    // in the world actually changed.
    const world = await makeWorld({
      workspaces: [{ id: 'ws1' }],
      sessions: [{ id: 'open', cwd: undefined }],
      live: ['open'],
    })
    world.snapshot('open').header.cwd = world.dirOf('ws1')
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.ok(plan.blockers.length > 0)
    const response = await engine.execute({ planId: plan.planId })
    assertFail(response, 'STATE_CHANGED')
    assert.ok(response.error.details.reasons.some((reason) => reason.code === 'WORKSPACE_HAS_LIVE_SESSIONS'))
    assert.ok(response.error.details.reasons.some((reason) => reason.message === 'The plan still reports a blocker.'))
    await assertExists(world.dirOf('ws1'), 'workspace directory')
  })
})

// #endregion

// #region plan lifetime (SPEC §4.4, config) ---------------------------------------------------

describe('plan lifetime', () => {
  test('a plan is single-use', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.equal((await engine.execute({ planId: plan.planId })).ok, true)
    assertFail(await engine.execute({ planId: plan.planId }), 'PLAN_UNKNOWN')
  })

  test('an expired plan answers PLAN_EXPIRED and is consumed', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const engine = world.engine({ config: { planTtlMs: 1000 } })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    world.clock.advance(1001)
    assertFail(await engine.execute({ planId: plan.planId }), 'PLAN_EXPIRED')
    assertFail(await engine.execute({ planId: plan.planId }), 'PLAN_UNKNOWN')
  })

  test('a plan is still valid at exactly expiresAt (the check is strictly greater)', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const engine = world.engine({ config: { planTtlMs: 1000 } })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    world.clock.set(plan.expiresAt)
    assert.equal((await engine.execute({ planId: plan.planId })).ok, true)
  })

  test('an expired plan survives a later plan creation and answers PLAN_EXPIRED', async () => {
    // SPEC §4.4: expiry is classified at execute time, so an expired plan is still found until the
    // maxPlans bound evicts it; creating another plan must not drop it.
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const engine = world.engine({ config: { planTtlMs: 1000 } })
    const stale = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    world.clock.advance(1001)
    planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assertFail(await engine.execute({ planId: stale.planId }), 'PLAN_EXPIRED')
    // Consumed even when it failed.
    assertFail(await engine.execute({ planId: stale.planId }), 'PLAN_UNKNOWN')
  })

  test('the maxPlans bound still evicts an expired plan (answers PLAN_UNKNOWN)', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }, { id: 'ws2' }] })
    const engine = world.engine({ config: { maxPlans: 2, planTtlMs: 1000 } })
    const requestFor = (id) => ({ targets: [{ kind: 'workspace', id }], mode: 'trash', includeSessions: false })
    const stale = planOf(await engine.plan(requestFor('ws1')))
    world.clock.advance(1001)
    planOf(await engine.plan(requestFor('ws2')))
    planOf(await engine.plan(requestFor('ws2'))) // evicts the oldest (expired) retained plan
    assertFail(await engine.execute({ planId: stale.planId }), 'PLAN_UNKNOWN')
  })

  test('maxPlans evicts the oldest retained plan', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }, { id: 'ws2' }, { id: 'ws3' }] })
    const engine = world.engine({ config: { maxPlans: 2 } })
    const requestFor = (id) => ({ targets: [{ kind: 'workspace', id }], mode: 'trash', includeSessions: false })
    const first = planOf(await engine.plan(requestFor('ws1')))
    const second = planOf(await engine.plan(requestFor('ws2')))
    const third = planOf(await engine.plan(requestFor('ws3')))
    assertFail(await engine.execute({ planId: first.planId }), 'PLAN_UNKNOWN')
    assert.equal((await engine.execute({ planId: second.planId })).ok, true)
    assert.equal((await engine.execute({ planId: third.planId })).ok, true)
  })

  test('a malformed execute request does not consume the plan', async () => {
    // SPEC §4.4 (amended): only a plan that was actually looked up is consumed; a BAD_REQUEST for an
    // invalid request shape (e.g. a non-string confirmationText) leaves the plan usable.
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'permanent', includeSessions: false }))
    assertFail(await engine.execute({ planId: plan.planId, confirmationText: 42 }), 'BAD_REQUEST')
    // Still retained: the same id now reaches the confirmation check instead of PLAN_UNKNOWN.
    assertFail(await engine.execute({ planId: plan.planId }), 'CONFIRMATION_REQUIRED')
  })

  test('rejects malformed execute requests', async () => {
    const world = await makeWorld({})
    const engine = world.engine()
    for (const body of [null, 'x', {}, { planId: '' }, { planId: 42 }, { planId: 'nope', confirmationText: 42 }]) {
      assertFail(await engine.execute(body), 'BAD_REQUEST')
    }
  })
})

// #endregion

// #region trash routes (SPEC §4.5/§5.7) -------------------------------------------------------

describe('trash routes', () => {
  test('lists a healthy entry with its metadata and restorability', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', title: 'proj', files: { 'a.txt': 'hello' } }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.equal((await engine.execute({ planId: plan.planId })).ok, true)
    const response = await engine.trashList()
    assert.equal(response.ok, true)
    assertPureJson(response)
    assert.deepEqual(Object.keys(response).sort(), ['entries', 'ok', 'totals'])
    assert.deepEqual(Object.keys(response.totals).sort(), ['bytes', 'entries'])
    assert.equal(response.entries.length, 1)
    const [entry] = response.entries
    assert.deepEqual(Object.keys(entry).sort(), TRASH_ENTRY_KEYS)
    assert.match(entry.id, /^[0-9]{8}T[0-9]{6}Z-proj-[0-9a-f]{4}$/)
    assert.equal(entry.kind, 'workspace-dir')
    assert.equal(entry.title, 'proj')
    assert.equal(entry.originalPath, world.dirOf('ws1'))
    assert.equal(entry.movedAt, world.clock.now())
    assert.equal(entry.bytes, 5)
    assert.equal(entry.files, 1)
    assert.equal(entry.dirs, 0)
    assert.equal(entry.restorable, true)
    assert.equal(entry.restorableCode, null)
    assert.equal(entry.origin, null, 'a folder entry has no session origin')
    assert.equal(entry.parentSessionId, null)
    assert.deepEqual(response.totals, { entries: 1, bytes: 5 })
    const entryStat = await fsp.stat(path.join(world.trashRoot, entry.id))
    assert.equal(entryStat.mode & 0o777, 0o700, 'trash entry directories are created with mode 0o700')
  })

  test('records the session family so a subagent log stays recognizable in the trash', async () => {
    const world = await makeWorld({
      sessions: [
        { id: 'root', cwd: '/proj', createdAt: 1000 },
        { id: 'child', cwd: '/proj', origin: 'subagent', parentSession: 'root', createdAt: 1001 },
      ],
    })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 'root' }], mode: 'trash', includeDescendants: true }))
    assert.equal((await engine.execute({ planId: plan.planId })).ok, true)
    const response = await engine.trashList()
    assert.equal(response.entries.length, 2)
    const child = response.entries.find((entry) => entry.origin === 'subagent')
    assert.ok(child, 'the subagent entry keeps its origin')
    assert.equal(child.parentSessionId, 'root')
    const root = response.entries.find((entry) => entry.origin === null)
    assert.ok(root, 'the root entry carries no origin')
    assert.equal(root.parentSessionId, null)
  })

  test('reports empty-string family fields from a hand-edited meta.json as null', async () => {
    const world = await makeWorld({ sessions: [{ id: 'solo', cwd: '/proj', createdAt: 1000 }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 'solo' }], mode: 'trash' }))
    assert.equal((await engine.execute({ planId: plan.planId })).ok, true)
    const [entry] = (await engine.trashList()).entries
    const metaPath = path.join(world.trashRoot, entry.id, 'meta.json')
    const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'))
    meta.origin = ''
    meta.parentSessionId = ''
    await fsp.writeFile(metaPath, JSON.stringify(meta))
    const [patched] = (await engine.trashList()).entries
    assert.equal(patched.origin, null, 'an empty origin string is reported as null')
    assert.equal(patched.parentSessionId, null, 'an empty parent id is reported as null')
    assert.equal(patched.restorable, true, 'the entry stays listable/restorable')
  })

  test('lists an unreadable entry instead of omitting it', async () => {
    const world = await makeWorld({})
    await fsp.mkdir(path.join(world.trashRoot, 'junk-entry', 'payload'), { recursive: true })
    await fsp.writeFile(path.join(world.trashRoot, 'junk-entry', '.dsh-cleanup-entry'), '{}\n')
    const engine = world.engine()
    const response = await engine.trashList()
    const [entry] = response.entries
    assert.equal(entry.id, 'junk-entry')
    assert.equal(entry.restorable, false)
    assert.equal(entry.restorableCode, 'RESTORE_ENTRY_UNREADABLE')
    assert.equal(entry.kind, null)
    assert.equal(entry.originalPath, null)
    assert.equal(entry.bytes, 0)
    const entryStat = await fsp.stat(path.join(world.trashRoot, 'junk-entry'))
    assert.equal(entry.movedAt, Math.floor(entryStat.mtimeMs), 'movedAt falls back to the entry directory mtime')
  })

  test('reports RESTORE_ORIGINAL_EXISTS for an entry whose original path came back', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.equal((await engine.execute({ planId: plan.planId })).ok, true)
    await fsp.mkdir(world.dirOf('ws1'))
    const list = await engine.trashList()
    assert.equal(list.entries[0].restorable, false)
    assert.equal(list.entries[0].restorableCode, 'RESTORE_ORIGINAL_EXISTS')
    const restore = await engine.trashRestore({ entryId: list.entries[0].id })
    assertFail(restore, 'RESTORE_ORIGINAL_EXISTS')
  })

  test('restores a trashed workspace directory and removes the entry', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'a.txt': 'hello', 'sub/b.txt': 'world!' } }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.equal((await engine.execute({ planId: plan.planId })).ok, true)
    const [entry] = (await engine.trashList()).entries
    const response = await engine.trashRestore({ entryId: entry.id })
    assert.equal(response.ok, true)
    assert.deepEqual(response, { ok: true, restoredTo: entry.originalPath })
    await assertExists(path.join(world.dirOf('ws1'), 'a.txt'), 'restored file')
    await assertExists(path.join(world.dirOf('ws1'), 'sub', 'b.txt'), 'restored nested file')
    assert.deepEqual(await trashEntries(world), [])
    assert.deepEqual((await engine.trashList()).entries, [])
  })

  test('refuses to restore when the original parent directory is gone', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.equal((await engine.execute({ planId: plan.planId })).ok, true)
    const [entry] = (await engine.trashList()).entries
    await fsp.rm(path.join(world.root, 'workspaces'), { recursive: true, force: true })
    const response = await engine.trashRestore({ entryId: entry.id })
    assertFail(response, 'RESTORE_FAILED')
    assert.match(response.error.message, /parent directory/)
  })

  test('rejects unknown and malformed trash entry ids', async () => {
    const world = await makeWorld({})
    const engine = world.engine()
    assertFail(await engine.trashRestore({ entryId: 'nope' }), 'TRASH_ENTRY_UNKNOWN')
    assertFail(await engine.trashRestore({ entryId: '..' }), 'TRASH_ENTRY_UNKNOWN')
    assertFail(await engine.trashRestore({ entryId: 'a/b' }), 'TRASH_ENTRY_UNKNOWN')
    assertFail(await engine.trashRestore({}), 'BAD_REQUEST')
    assertFail(await engine.trashRestore('x'), 'BAD_REQUEST')
    assertFail(await engine.trashRestore({ entryId: '' }), 'BAD_REQUEST')
  })

  test('an unreadable entry cannot be restored', async () => {
    const world = await makeWorld({})
    await fsp.mkdir(path.join(world.trashRoot, 'junk-entry', 'payload'), { recursive: true })
    await fsp.writeFile(path.join(world.trashRoot, 'junk-entry', '.dsh-cleanup-entry'), '{}\n')
    const engine = world.engine()
    assertFail(await engine.trashRestore({ entryId: 'junk-entry' }), 'RESTORE_FAILED')
  })

  test('purging requires an explicit entryIds list or { all: true }, never a bare body', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'a.txt': 'hello' } }, { id: 'ws2', files: { 'b.txt': 'world' } }] })
    const engine = world.engine()
    const plan1 = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.equal((await engine.execute({ planId: plan1.planId })).ok, true)
    const plan2 = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws2' }], mode: 'trash', includeSessions: false }))
    assert.equal((await engine.execute({ planId: plan2.planId })).ok, true)
    const entries = (await engine.trashList()).entries
    assert.equal(entries.length, 2)
    const [first, second] = entries
    // "no entryIds" used to mean "empty the whole trash"; it is now a BAD_REQUEST.
    assertFail(await engine.trashPurge({}), 'BAD_REQUEST')
    assert.equal((await engine.trashList()).entries.length, 2, 'an implicit purge must not remove anything')
    const partial = await engine.trashPurge({ entryIds: [first.id] })
    assert.deepEqual(partial, { ok: true, purged: 1, bytes: first.bytes })
    assert.deepEqual((await engine.trashList()).entries.map((entry) => entry.id), [second.id])
    const rest = await engine.trashPurge({ all: true })
    assert.deepEqual(rest, { ok: true, purged: 1, bytes: second.bytes })
    assert.deepEqual((await engine.trashList()).entries, [])
    assert.deepEqual(await trashEntries(world), [])
  })

  test('purge skips unknown ids and treats an empty list as "purge nothing"', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'a.txt': 'hello' } }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.equal((await engine.execute({ planId: plan.planId })).ok, true)
    assert.deepEqual(await engine.trashPurge({ entryIds: ['nope'] }), { ok: true, purged: 0, bytes: 0 })
    assert.equal((await engine.trashList()).entries.length, 1)
    assert.deepEqual(await engine.trashPurge({ entryIds: [] }), { ok: true, purged: 0, bytes: 0 })
    assert.equal((await engine.trashList()).entries.length, 1)
  })

  test('rejects malformed purge requests', async () => {
    const world = await makeWorld({})
    const engine = world.engine()
    for (const body of [null, 'x', {}, { all: 'yes' }, { entryIds: 'a' }, { entryIds: [1] }]) {
      assertFail(await engine.trashPurge(body), 'BAD_REQUEST')
    }
  })

  test('an absent trash root lists no entries and refuses an implicit purge', async () => {
    const world = await makeWorld({})
    const engine = world.engine()
    assert.deepEqual(await engine.trashList(), { ok: true, entries: [], totals: { entries: 0, bytes: 0 } })
    assert.deepEqual(await engine.trashPurge({ all: true }), { ok: true, purged: 0, bytes: 0 })
    assertFail(await engine.trashPurge({}), 'BAD_REQUEST')
  })
})

// #endregion

// #region hardening regressions ----------------------------------------------------------------

describe('hardening regressions (0.4.0)', () => {
  test('a trash-entry metadata write failure moves nothing and reports it (prepare before move)', async () => {
    // The entry is fully prepared (ownership marker + metadata) before the payload moves. A failed
    // metadata write therefore happens while the user's data is still in place: the allocation is
    // discarded and the error says nothing moved. This supersedes the old rollback design, whose
    // double-fault case could leave the only copy of the data in an unreadable entry.
    const world = await makeWorld({ workspaces: [{ id: 'ws1', title: 'proj', files: { 'a.txt': 'important' } }] })
    const fsOps = {
      writeFile: async (target, ...rest) => {
        if (String(target).endsWith('meta.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        return nodeFs.writeFile(target, ...rest)
      },
    }
    const engine = world.engine({ fsOps })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    const response = await engine.execute({ planId: plan.planId })
    const [item] = response.result.items
    assert.equal(item.status, 'failed')
    assert.equal(item.error.code, 'IO_ERROR')
    assert.match(item.error.message, /nothing was moved/)
    // The user's directory is untouched, no trash entry is left behind, and the registration stays.
    await assertExists(path.join(world.dirOf('ws1'), 'a.txt'), 'the workspace directory is untouched')
    assert.equal(await fsp.readFile(path.join(world.dirOf('ws1'), 'a.txt'), 'utf8'), 'important')
    assert.deepEqual(await trashEntries(world), [])
    assert.equal(world.entities.has('ws1'), true)
    assert.deepEqual(response.result.totals, { trashed: 0, deleted: 0, failed: 1, bytes: 0 })
  })

  test('a project directory swapped for a symlink after planning answers STATE_CHANGED and deletes nothing', async () => {
    // A plan is a promise about a directory. Moving the project directory away and replacing it with
    // a symlink to a victim tree must not redirect the deletion into the victim.
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'real-log\n' }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    const realSessionDir = world.dirOfSession('s1')
    const projectDir = path.dirname(realSessionDir)
    const movedDir = path.join(world.root, 'moved-project')
    await fsp.rename(projectDir, movedDir)
    const victim = path.join(world.root, 'victim')
    await fsp.mkdir(path.join(victim, 's1'), { recursive: true })
    await fsp.writeFile(path.join(victim, 's1', 'victim.txt'), 'keep me')
    await fsp.symlink(victim, projectDir, 'dir')
    const response = await engine.execute({ planId: plan.planId })
    assertFail(response, 'STATE_CHANGED')
    assert.ok(response.error.details.reasons.some((reason) => reason.code === 'PATH_CHANGED' && reason.sessionId === 's1'))
    assert.equal(await fsp.readFile(path.join(victim, 's1', 'victim.txt'), 'utf8'), 'keep me', 'the victim tree is untouched')
    assert.match(await fsp.readFile(path.join(movedDir, 's1', 'log.jsonl'), 'utf8'), /real-log/, 'the real log is intact')
    assert.deepEqual(await trashEntries(world), [])
  })

  test('a trashRoot inside a workspace blocks permanent deletion of that workspace and keeps the trash', async () => {
    // Deleting a workspace that CONTAINS the trash root would destroy every recoverable entry.
    const world = await makeWorld({ workspaces: [{ id: 'outer', files: { 'keep.txt': 'x' } }, { id: 'other', files: { 'o.txt': 'y' } }] })
    const trashRoot = path.join(world.dirOf('outer'), '.trash')
    const engine = world.engine({ config: { trashRoot } })
    const otherPlan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'other' }], mode: 'trash', includeSessions: false }))
    assert.equal((await engine.execute({ planId: otherPlan.planId })).ok, true)
    const entriesBefore = await fsp.readdir(trashRoot)
    assert.equal(entriesBefore.length, 1, 'a recoverable entry now lives inside the outer workspace')
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'outer' }], mode: 'permanent', includeSessions: false }))
    assert.deepEqual(plan.blockers.map((entry) => entry.code), ['PATH_PROTECTED'])
    assert.match(plan.blockers[0].message, /contains the cleanup trash/)
    // SPEC §4.3: a blocked permanent plan still carries the typed name (deferred-route gate).
    assert.deepEqual(plan.confirmation, {
      kind: 'typed-name',
      expected: path.basename(world.dirOf('outer')),
      label: 'outer',
    })
    // Defence in depth: even with the typed name, the blocked plan must mutate nothing.
    assertFail(await engine.execute({ planId: plan.planId, confirmationText: plan.confirmation.expected }), 'STATE_CHANGED')
    await assertExists(world.dirOf('outer'), 'workspace holding the trash')
    assert.deepEqual(await fsp.readdir(trashRoot), entriesBefore)
    const [entry] = (await engine.trashList()).entries
    await assertExists(path.join(trashRoot, entry.id, 'payload', 'o.txt'), 'trashed payload survives')
  })

  test('a session that becomes live after admission fails alone with SESSION_LIVE and keeps its log', async () => {
    // Admission is a snapshot; the session can be resumed while a batch is executing. The per-item
    // re-check immediately before the mutation must catch it.
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'log\n' }] })
    world.registry.unpinSession = async (id) => {
      world.liveStore.set(id, { id })
    }
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    const response = await engine.execute({ planId: plan.planId })
    assert.equal(response.ok, true, 'one item failing must not fail the whole batch')
    const [item] = response.result.items
    assert.equal(item.status, 'failed')
    assert.equal(item.error.code, 'SESSION_LIVE')
    await assertExists(world.dirOfSession('s1'), 'the live session log is left in place')
    assert.deepEqual(await trashEntries(world), [])
    assert.deepEqual(response.result.totals, { trashed: 0, deleted: 0, failed: 1, bytes: 0 })
  })

  test('admitting an 8-session plan costs one persistence listing and no per-session stat()', async () => {
    // The JSONL backend locates a session by scanning every project directory, so a stat() per
    // planned session stalls the destructive flow. Admission must build the id map from one list().
    const specs = []
    for (let index = 1; index <= 8; index += 1) specs.push({ id: `s${index}`, content: 'x', createdAt: index })
    const world = await makeWorld({ sessions: specs })
    const counters = { list: 0, stat: 0 }
    const persistence = {
      list: async () => {
        counters.list += 1
        return [...world.snapshots.values()]
      },
      stat: async (id) => {
        counters.stat += 1
        return world.snapshots.get(id)
      },
    }
    const engine = world.engine({ sessionPersistence: persistence })
    const plan = planOf(await engine.plan({ targets: specs.map((spec) => ({ kind: 'session', id: spec.id })), mode: 'trash' }))
    assert.equal(plan.items.length, 8)
    counters.list = 0
    counters.stat = 0
    const response = await engine.execute({ planId: plan.planId })
    assert.equal(response.ok, true)
    assert.equal(counters.stat, 0, 'admission must not stat() per planned session')
    assert.ok(counters.list <= 2, `admission used ${counters.list} persistence listings`)
    assert.ok(response.result.items.every((item) => item.status === 'trashed'))
  })

  test('nested registered workspaces warn on delete and block the permanent mode', async () => {
    // Deleting the outer workspace also deletes the separately registered inner one; that collateral
    // deletion must be reviewed, and is unrecoverable in permanent mode.
    const world = await makeWorld({ workspaces: [{ id: 'outer', title: 'Outer', files: { 'a.txt': 'x' } }] })
    const innerDir = path.join(world.dirOf('outer'), 'inner')
    await fsp.mkdir(innerDir, { recursive: true })
    world.entities.set('inner', { id: 'inner', path: innerDir, title: 'Inner', sessionIds: [] })
    const engine = world.engine()
    const trashPlan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'outer' }], mode: 'trash', includeSessions: false }))
    const nestedWarning = trashPlan.warnings.find((entry) => entry.code === 'WORKSPACE_CONTAINS_WORKSPACE')
    assert.ok(nestedWarning, 'the trash plan must warn about the nested registered workspace')
    assert.match(nestedWarning.message, /Inner/)
    assert.deepEqual(trashPlan.blockers, [])
    const permanentPlan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'outer' }], mode: 'permanent', includeSessions: false }))
    assert.deepEqual(permanentPlan.blockers.map((entry) => entry.code), ['WORKSPACE_CONTAINS_WORKSPACE'])
    assert.match(permanentPlan.blockers[0].message, /Inner/)
    assert.deepEqual(permanentPlan.confirmation, {
      kind: 'typed-name',
      expected: path.basename(world.dirOf('outer')),
      label: 'Outer',
    })
    assertFail(await engine.execute({ planId: permanentPlan.planId, confirmationText: permanentPlan.confirmation.expected }), 'STATE_CHANGED')
    await assertExists(innerDir, 'the nested workspace directory')
    assert.equal(world.entities.has('inner'), true)
  })

  test('a missing workspace with includeSessions:true plans only the registration', async () => {
    // SPEC §5.3: a missing directory short-circuits the section and sweeps no stored sessions, so the
    // warning ("only its registration will be removed") and the item list finally agree.
    const missing = path.join(TMP, 'missing-workspace-r10-plan')
    const world = await makeWorld({
      workspaces: [{ id: 'ws1', create: false, dir: missing, title: 'gone' }],
      sessions: [{ id: 's-inside', cwd: missing }, { id: 's-other', cwd: '/elsewhere' }],
    })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: true }))
    assert.deepEqual(plan.items.map((item) => item.kind), ['workspace-dir'])
    assert.deepEqual(plan.items[0], { kind: 'workspace-dir', id: 'ws1', title: 'gone', path: missing, bytes: 0, files: 0, dirs: 0, truncated: false })
    const warningCodes = plan.warnings.map((entry) => entry.code)
    assert.deepEqual(warningCodes, ['WORKSPACE_MISSING'])
    assert.ok(!warningCodes.includes('SESSIONS_FROM_DIR'), 'a missing directory has no surviving sessions to ungroup')
    assert.deepEqual(plan.blockers, [])
    assert.deepEqual(plan.totals, { workspaces: 1, sessions: 0, files: 0, dirs: 0, bytes: 0 })
  })

  test('maxPlans: 0 is clamped to at least 1 so fresh plans stay executable', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', createdAt: 1 }, { id: 's2', createdAt: 2 }] })
    const engine = world.engine({ config: { maxPlans: 0 } })
    const first = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    const firstRun = await engine.execute({ planId: first.planId })
    assert.equal(firstRun.ok, true, 'a zero maxPlans must not evict the plan that was just created')
    assert.deepEqual(firstRun.result.items.map((item) => item.status), ['trashed'])
    const second = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's2' }], mode: 'trash' }))
    assert.equal((await engine.execute({ planId: second.planId })).ok, true)
  })

  test('a session directory removed after admission is deleted with bytes 0, not the planned bytes', async () => {
    // The per-item re-check notices the directory is already gone; the totals must not claim bytes
    // were removed that never existed on disk at deletion time.
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x' }] })
    world.registry.unpinSession = async (id) => {
      await fsp.rm(world.dirOfSession(id), { recursive: true, force: true })
    }
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'permanent' }))
    assert.ok(plan.items[0].bytes > 0, 'the plan measured the log before it disappeared')
    const response = await engine.execute({ planId: plan.planId })
    assert.equal(response.ok, true)
    assert.deepEqual(response.result.items, [{ kind: 'session', id: 's1', status: 'deleted', error: null, movedTo: null, bytes: 0 }])
    assert.deepEqual(response.result.totals, { trashed: 0, deleted: 1, failed: 0, bytes: 0 })
    assert.deepEqual(await trashEntries(world), [])
    await assertGone(world.dirOfSession('s1'))
  })

  test('a symlink or file trash payload is listed as not restorable and restore refuses it', async () => {
    // The list already reported RESTORE_PAYLOAD_INVALID for a symlink; restore used to rename the
    // symlink over the original path anyway. A regular-file payload must agree on both sides too:
    // list says not restorable, restore refuses, and neither path is written.
    const world = await makeWorld({})
    const victim = path.join(world.root, 'victim')
    await fsp.mkdir(victim, { recursive: true })
    await fsp.writeFile(path.join(victim, 'keep.txt'), 'keep')
    const linkEntryId = '20261104T101500Z-link-entry-0000'
    const linkEntryDir = path.join(world.trashRoot, linkEntryId)
    await fsp.mkdir(linkEntryDir, { recursive: true })
    const linkOriginalPath = path.join(world.root, 'restore-here')
    await fsp.writeFile(
      path.join(linkEntryDir, 'meta.json'),
      JSON.stringify({ version: 1, kind: 'workspace-dir', title: 'link', originalPath: linkOriginalPath, movedAt: 5, bytes: 9, files: 1, dirs: 0 }),
    )
    await fsp.symlink(victim, path.join(linkEntryDir, 'payload'), 'dir')
    const fileEntryId = '20261104T101500Z-file-entry-0000'
    const fileEntryDir = path.join(world.trashRoot, fileEntryId)
    await fsp.mkdir(fileEntryDir, { recursive: true })
    const fileOriginalPath = path.join(world.root, 'restore-file-here')
    await fsp.writeFile(
      path.join(fileEntryDir, 'meta.json'),
      JSON.stringify({ version: 1, kind: 'session', title: 'file', originalPath: fileOriginalPath, movedAt: 4, bytes: 3, files: 1, dirs: 0 }),
    )
    await fsp.writeFile(path.join(fileEntryDir, 'payload'), 'not a directory')
    const engine = world.engine()
    const list = await engine.trashList()
    assert.equal(list.entries.length, 2)
    const byId = new Map(list.entries.map((entry) => [entry.id, entry]))
    assert.equal(byId.get(linkEntryId).restorable, false)
    assert.equal(byId.get(linkEntryId).restorableCode, 'RESTORE_PAYLOAD_INVALID')
    assert.equal(byId.get(fileEntryId).restorable, false, 'a file payload is not restorable either')
    assert.equal(byId.get(fileEntryId).restorableCode, 'RESTORE_PAYLOAD_INVALID')
    assertFail(await engine.trashRestore({ entryId: linkEntryId }), 'RESTORE_FAILED')
    assertFail(await engine.trashRestore({ entryId: fileEntryId }), 'RESTORE_FAILED')
    await assertGone(linkOriginalPath, 'no link is planted at the original path')
    await assertGone(fileOriginalPath, 'no file is planted at the original path')
    assert.equal(await fsp.readFile(path.join(victim, 'keep.txt'), 'utf8'), 'keep', 'the symlink target is untouched')
    assert.equal(await fsp.readFile(path.join(fileEntryDir, 'payload'), 'utf8'), 'not a directory', 'the file payload is untouched')
    assert.equal((await engine.trashList()).entries.length, 2, 'both refused entries survive')
  })

  test('the second registry.list() failure inside inventory is an IO_ERROR envelope, not a throw', async () => {
    // The membership map used a second registry listing; a failure there escaped as HTTP 500 before.
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    let calls = 0
    const registry = {
      ...world.registry,
      list: () => {
        calls += 1
        if (calls === 1) return [...world.entities.values()]
        throw new Error('registry flaked')
      },
    }
    const engine = world.engine({ workspaceRegistry: registry })
    const response = await engine.inventory()
    assertFail(response, 'IO_ERROR')
    assert.match(response.error.message, /registry flaked/)
    assert.ok(calls >= 2)
  })

  test('totals.dirs counts the nested directories found inside each deleted session directory', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    const sessionDir = world.dirOfSession('s1')
    await fsp.mkdir(path.join(sessionDir, 'sub'), { recursive: true })
    await fsp.writeFile(path.join(sessionDir, 'sub', 'child.jsonl'), 'x')
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.equal(plan.totals.sessions, 1)
    assert.equal(plan.totals.dirs, 1, 'the directory inside the session directory gets counted')
  })

  test('an unexpected readdir error during a walk is reported as truncated, not silently skipped', async () => {
    // EIO/ELOOP are neither ENOENT nor EACCES: the size becomes a lower bound and must say so.
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'a.txt': 'x', 'sub/b.txt': 'y' } }] })
    const fsOps = {
      readdir: async (target, ...rest) => {
        if (path.basename(String(target)) === 'sub') throw Object.assign(new Error('device io error'), { code: 'EIO' })
        return nodeFs.readdir(target, ...rest)
      },
    }
    const engine = world.engine({ fsOps })
    const response = await engine.measure({ workspaceIds: ['ws1'] })
    assert.equal(response.ok, true)
    assert.equal(response.workspaces.ws1.truncated, true)
    assert.ok(response.workspaces.ws1.files >= 1)
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.ok(plan.warnings.some((entry) => entry.code === 'SCAN_TRUNCATED'))
  })
})

// #endregion

// #region deferred deletions (SPEC §4.7/§5.8) -------------------------------------------------

const DEFERRED_PROCESSED_MARKER = '__dshCleanupDeferredProcessedFiles'
let deferredEntrySeq = 0

/**
 * The start-up guard is a process-global Set of queue-file paths (per-file semantics: a hot reload of
 * the same queue is skipped, independent homes are not). Tests clear it, and the legacy boolean, so
 * every case is independent.
 */
function resetDeferredMarker() {
  delete globalThis.__dshCleanupDeferredProcessed
  const processed = globalThis[DEFERRED_PROCESSED_MARKER]
  if (processed instanceof Set) processed.clear()
  else delete globalThis[DEFERRED_PROCESSED_MARKER]
}

/** One plausible queued entry (as a previous process would have left it on disk). */
function queueEntry(overrides = {}) {
  return {
    id: `queued-entry-${++deferredEntrySeq}`,
    queuedAt: 900,
    mode: 'trash',
    includeSessions: true,
    includeDescendants: true,
    confirmationText: null,
    targets: [{ kind: 'session', id: 's1' }],
    ...overrides,
  }
}

/** Write a queue document directly, bypassing defer() (fixture for "left by the last process"). */
async function writeQueueFile(filePath, entries, lastRun = null) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, `${JSON.stringify({ version: 1, entries, lastRun }, null, 2)}\n`)
}

/** Read the queue document. */
async function readQueueFile(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'))
}

describe('deferred deletions (SPEC §4.7/§5.8)', () => {
  beforeEach(resetDeferredMarker)
  afterEach(resetDeferredMarker)

  test('defer queues a session in trash mode with the reviewed options and no typed name', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    const engine = world.engine()
    const response = await engine.defer({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' })
    assert.equal(response.ok, true)
    assert.deepEqual(Object.keys(response.deferred).sort(), ['count', 'entryIds', 'replaced'])
    assert.equal(response.deferred.count, 1)
    assert.equal(response.deferred.replaced, false)
    assert.equal(response.deferred.entryIds.length, 1)
    assert.match(response.deferred.entryIds[0], /^[0-9a-f-]{36}$/)
    const document = await readQueueFile(world.deferredFile)
    assert.equal(document.version, 2)
    assert.equal(document.entries.length, 1)
    assert.deepEqual(document.retained, [])
    const [entry] = document.entries
    assert.equal(entry.id, response.deferred.entryIds[0])
    assert.equal(entry.queuedAt, world.clock.now())
    assert.equal(entry.mode, 'trash')
    assert.equal(entry.includeSessions, true)
    assert.equal(entry.includeDescendants, true)
    assert.equal(entry.confirmationText, null, 'trash mode stores no typed name')
    assert.deepEqual(entry.targets, [{ kind: 'session', id: 's1' }])
    // SPEC §5.8: the document is owner-only and written atomically (no temporary file left behind).
    assert.equal((await fsp.stat(world.deferredFile)).mode & 0o777, 0o600)
    assert.equal((await fsp.stat(path.dirname(world.deferredFile))).mode & 0o777, 0o700)
    assert.deepEqual((await fsp.readdir(path.dirname(world.deferredFile))).sort(), ['audit.jsonl', 'deferred.json'])
    // The list projection never exposes the internal typed-name field.
    const listed = await engine.deferredList()
    assert.equal(listed.ok, true)
    assert.deepEqual(Object.keys(listed.deferred).sort(), ['entries', 'lastRun', 'retained'])
    assert.deepEqual(listed.deferred.retained, [])
    assert.deepEqual(Object.keys(listed.deferred.entries[0]).sort(), [
      'id',
      'includeDescendants',
      'includeSessions',
      'mode',
      'queuedAt',
      'targets',
    ])
    // The overview carries the count (and the previous run), not the entries.
    const inventory = await engine.inventory()
    assert.deepEqual(inventory.deferred, { count: 1, retained: 0, lastRun: null })
  })

  test('the default queue document lives at $DSH_HOME/cleanup/deferred.json', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    const saved = process.env.DSH_HOME
    const fakeHome = path.join(world.root, 'profile-home')
    try {
      process.env.DSH_HOME = fakeHome
      // No `deferredFile` config: the documented default applies.
      const engine = createEngine({
        workspaceRegistry: world.registry,
        sessionPersistence: world.persistence,
        now: world.clock.now,
      })
      const response = await engine.defer({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' })
      assert.equal(response.ok, true)
      const document = await readQueueFile(path.join(fakeHome, 'cleanup', 'deferred.json'))
      assert.equal(document.version, 2)
      assert.equal(document.entries.length, 1)
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  })

  test('queueing the same target set again replaces its mode and options instead of duplicating it', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }, { id: 's2' }] })
    const engine = world.engine()
    const first = await engine.defer({
      targets: [{ kind: 'session', id: 's1' }, { kind: 'session', id: 's2' }],
      mode: 'trash',
    })
    assert.equal(first.deferred.replaced, false)
    const firstId = first.deferred.entryIds[0]
    // Same set, different order and different options: it is the same reviewed deletion.
    const second = await engine.defer({
      targets: [{ kind: 'session', id: 's2' }, { kind: 'session', id: 's1' }],
      mode: 'permanent',
      includeSessions: false,
      includeDescendants: false,
    })
    assert.equal(second.ok, true)
    assert.equal(second.deferred.replaced, true)
    assert.equal(second.deferred.count, 1)
    assert.deepEqual(second.deferred.entryIds, [firstId])
    const document = await readQueueFile(world.deferredFile)
    assert.equal(document.entries.length, 1, 'a repeated request must not stack up entries')
    assert.equal(document.entries[0].id, firstId)
    assert.equal(document.entries[0].mode, 'permanent')
    assert.equal(document.entries[0].includeSessions, false)
    assert.equal(document.entries[0].includeDescendants, false)
    assert.deepEqual(document.entries[0].targets.map((target) => `${target.kind}:${target.id}`), ['session:s2', 'session:s1'])
  })

  test('defer rejects unknown targets and malformed bodies without writing the queue', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }], sessions: [{ id: 's1' }] })
    const engine = world.engine()
    assertFail(await engine.defer({ targets: [{ kind: 'session', id: 'nope' }], mode: 'trash' }), 'UNKNOWN_SESSION')
    assertFail(await engine.defer({ targets: [{ kind: 'workspace', id: 'nope' }], mode: 'trash' }), 'UNKNOWN_WORKSPACE')
    const malformed = [
      null,
      'x',
      {},
      { targets: [] },
      { targets: [{ kind: 'session', id: 's1' }], mode: 'shred' },
      { targets: [{ kind: 'nope', id: 's1' }] },
      { targets: [{ kind: 'session', id: '' }] },
      { targets: [{ kind: 'session', id: 's1' }], includeSessions: 'yes' },
    ]
    for (const body of malformed) assertFail(await engine.defer(body), 'BAD_REQUEST', JSON.stringify(body))
    assert.equal(await exists(world.deferredFile), false, 'a rejected request must not create the queue')
  })

  test('defer refuses a full queue with DEFERRED_FULL but still allows replacing an entry', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }, { id: 's2' }] })
    /** @type {object[]} */
    const full = []
    for (let index = 0; index < 100; index += 1) full.push(queueEntry({ targets: [{ kind: 'session', id: `ghost-${index}` }] }))
    await writeQueueFile(world.deferredFile, full)
    const engine = world.engine()
    assertFail(await engine.defer({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }), 'DEFERRED_FULL')
    assert.equal((await readQueueFile(world.deferredFile)).entries.length, 100, 'a refused request must not touch the full queue')
    // Replacing an already-queued target set is still allowed at the cap.
    const withS2 = full.slice(0, 99).concat(queueEntry({ targets: [{ kind: 'session', id: 's2' }] }))
    await writeQueueFile(world.deferredFile, withS2)
    const replaced = await engine.defer({ targets: [{ kind: 'session', id: 's2' }], mode: 'trash', includeSessions: false })
    assert.equal(replaced.ok, true)
    assert.equal(replaced.deferred.replaced, true)
    assert.equal(replaced.deferred.count, 100)
  })

  test('queueing a permanent workspace directory requires the name validated at queue time', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const engine = world.engine()
    const targets = [{ kind: 'workspace', id: 'ws1' }]
    const expected = path.basename(world.dirOf('ws1'))
    const missing = await engine.defer({ targets, mode: 'permanent', includeSessions: false })
    assertFail(missing, 'CONFIRMATION_REQUIRED')
    assert.match(missing.error.message, new RegExp(expected))
    assert.equal(await exists(world.deferredFile), false, 'nothing is queued without the typed name')
    assertFail(
      await engine.defer({ targets, mode: 'permanent', includeSessions: false, confirmationText: 'nope' }),
      'CONFIRMATION_MISMATCH',
    )
    assert.equal(await exists(world.deferredFile), false, 'nothing is queued on a mismatch')
    const queued = await engine.defer({ targets, mode: 'permanent', includeSessions: false, confirmationText: expected })
    assert.equal(queued.ok, true)
    const document = await readQueueFile(world.deferredFile)
    assert.equal(document.entries[0].confirmationText, expected, 'the reviewed name is retained for the start-up run')
    const listed = await engine.deferredList()
    assert.equal('confirmationText' in listed.deferred.entries[0], false, 'the list never projects the typed name')
  })

  test('deferredList projects entries without internal fields and passes lastRun through', async () => {
    const world = await makeWorld({})
    const lastRun = { at: 555, results: [{ entryId: 'old', status: 'trashed' }] }
    await writeQueueFile(
      world.deferredFile,
      [queueEntry({ targets: [{ kind: 'session', id: 'ghost' }], mode: 'permanent', confirmationText: 'secret' })],
      lastRun,
    )
    const response = await world.engine().deferredList()
    assert.equal(response.ok, true)
    assert.deepEqual(Object.keys(response.deferred).sort(), ['entries', 'lastRun', 'retained'])
    assert.deepEqual(response.deferred.lastRun, lastRun)
    assert.deepEqual(response.deferred.retained, [])
    const [entry] = response.deferred.entries
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'includeDescendants', 'includeSessions', 'mode', 'queuedAt', 'targets'])
    assert.equal(entry.mode, 'permanent')
    assert.deepEqual(entry.targets, [{ kind: 'session', id: 'ghost' }])
    // The internal field is still on disk because the start-up run needs it.
    assert.equal((await readQueueFile(world.deferredFile)).entries[0].confirmationText, 'secret')
  })

  test('deferredCancel removes named or all entries and is idempotent for unknown ids', async () => {
    const world = await makeWorld({})
    const entries = [
      queueEntry({ targets: [{ kind: 'session', id: 'a' }] }),
      queueEntry({ targets: [{ kind: 'session', id: 'b' }] }),
      queueEntry({ targets: [{ kind: 'session', id: 'c' }] }),
    ]
    await writeQueueFile(world.deferredFile, entries)
    const engine = world.engine()
    const cancelledOne = await engine.deferredCancel({ entryIds: [entries[1].id] })
    assert.deepEqual(cancelledOne, { ok: true, cancelled: 1 })
    assert.deepEqual((await readQueueFile(world.deferredFile)).entries.map((entry) => entry.id), [entries[0].id, entries[2].id])
    const unknown = await engine.deferredCancel({ entryIds: ['no-such-entry'] })
    assert.deepEqual(unknown, { ok: true, cancelled: 0 })
    assert.deepEqual((await readQueueFile(world.deferredFile)).entries.map((entry) => entry.id), [entries[0].id, entries[2].id])
    const all = await engine.deferredCancel({ all: true })
    assert.deepEqual(all, { ok: true, cancelled: 2 })
    assert.deepEqual((await readQueueFile(world.deferredFile)).entries, [])
    for (const body of [null, 'x', {}, { entryIds: 'a' }, { entryIds: [1] }, { all: 'yes' }]) {
      assertFail(await engine.deferredCancel(body), 'BAD_REQUEST', JSON.stringify(body))
    }
    assert.deepEqual(await engine.deferredCancel({ entryIds: [] }), { ok: true, cancelled: 0 })
  })

  test('runDeferred applies a queued trash session at start and records lastRun', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    const entry = queueEntry({ targets: [{ kind: 'session', id: 's1' }] })
    await writeQueueFile(world.deferredFile, [entry])
    const engine = world.engine()
    const outcome = await engine.runDeferred()
    assert.equal(outcome.ran, true)
    assert.equal(outcome.results.length, 1)
    const [result] = outcome.results
    assert.equal(result.entryId, entry.id)
    assert.equal(result.mode, 'trash')
    assert.equal(result.status, 'trashed')
    assert.deepEqual(result.items, [{ kind: 'session', id: 's1', status: 'trashed' }])
    await assertGone(world.dirOfSession('s1'), 'the queued session directory')
    const trash = await trashEntries(world)
    assert.equal(trash.length, 1)
    assert.equal(trash[0].meta.kind, 'session')
    const document = await readQueueFile(world.deferredFile)
    assert.deepEqual(document.entries, [], 'the queue is cleared after a successful run')
    assert.equal(document.lastRun.at, world.clock.now())
    assert.deepEqual(document.lastRun.results, outcome.results)
    assert.deepEqual((await engine.inventory()).deferred, { count: 0, retained: 0, lastRun: document.lastRun })
  })

  test('runDeferred applies a queued permanent session deletion without a typed name', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    await writeQueueFile(world.deferredFile, [queueEntry({ mode: 'permanent', targets: [{ kind: 'session', id: 's1' }] })])
    const outcome = await world.engine().runDeferred()
    assert.equal(outcome.ran, true)
    assert.equal(outcome.results[0].status, 'deleted')
    await assertGone(world.dirOfSession('s1'))
    assert.deepEqual(await trashEntries(world), [])
    assert.deepEqual((await readQueueFile(world.deferredFile)).entries, [])
  })

  test('runDeferred skips a queued session that is still live and keeps its log', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }], live: ['s1'] })
    await writeQueueFile(world.deferredFile, [queueEntry({ targets: [{ kind: 'session', id: 's1' }] })])
    const engine = world.engine()
    const outcome = await engine.runDeferred()
    assert.equal(outcome.ran, true)
    assert.equal(outcome.results[0].status, 'skipped')
    assert.equal(outcome.results[0].code, 'SESSION_LIVE')
    await assertExists(world.dirOfSession('s1'), 'the still-live session log')
    assert.deepEqual(await trashEntries(world), [])
    // A skip cannot be retried later: the queue is cleared and the outcome recorded.
    const document = await readQueueFile(world.deferredFile)
    assert.deepEqual(document.entries, [])
    assert.equal(document.lastRun.results[0].code, 'SESSION_LIVE')
  })

  test('runDeferred skips an entry whose workspace is still blocked', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const link = path.join(world.root, 'ws-link')
    await fsp.symlink(world.dirOf('ws1'), link, 'dir')
    world.entity('ws1').path = link
    await writeQueueFile(world.deferredFile, [queueEntry({ targets: [{ kind: 'workspace', id: 'ws1' }] })])
    const outcome = await world.engine().runDeferred()
    assert.equal(outcome.ran, true)
    assert.equal(outcome.results[0].status, 'skipped')
    assert.equal(outcome.results[0].code, 'WORKSPACE_SYMLINK')
    await assertExists(world.dirOf('ws1'), 'the symlink target stays untouched')
    assert.equal(world.entities.has('ws1'), true)
  })

  test('runDeferred skips a permanent workspace entry whose stored typed name no longer matches', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    await writeQueueFile(world.deferredFile, [
      queueEntry({ mode: 'permanent', targets: [{ kind: 'workspace', id: 'ws1' }], confirmationText: 'not-the-name' }),
    ])
    const outcome = await world.engine().runDeferred()
    assert.equal(outcome.ran, true)
    assert.equal(outcome.results[0].status, 'skipped')
    assert.equal(outcome.results[0].code, 'CONFIRMATION_REQUIRED')
    await assertExists(world.dirOf('ws1'), 'the workspace directory survives the refusal')
    assert.equal(world.entities.has('ws1'), true)
    assert.deepEqual((await readQueueFile(world.deferredFile)).entries, [])
  })

  test('a queued permanent workspace deletion executes with the name validated at queue time', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'a.txt': 'keep' } }] })
    const expected = path.basename(world.dirOf('ws1'))
    const queuer = world.engine()
    const queued = await queuer.defer({
      targets: [{ kind: 'workspace', id: 'ws1' }],
      mode: 'permanent',
      includeSessions: false,
      confirmationText: expected,
    })
    assert.equal(queued.ok, true)
    // A fresh engine instance stands in for the next Host start.
    const outcome = await world.engine().runDeferred()
    assert.equal(outcome.ran, true)
    assert.equal(outcome.results[0].status, 'deleted')
    assert.equal(outcome.results[0].mode, 'permanent')
    await assertGone(world.dirOf('ws1'), 'the permanently deleted workspace directory')
    assert.equal(world.entities.has('ws1'), false, 'the registration is gone as well')
    assert.deepEqual(await trashEntries(world), [])
  })

  test('runDeferred records a vanished target as failed and still clears the queue', async () => {
    const world = await makeWorld({ sessions: [] })
    await writeQueueFile(world.deferredFile, [queueEntry({ targets: [{ kind: 'session', id: 'ghost' }] })])
    const outcome = await world.engine().runDeferred()
    assert.equal(outcome.ran, true)
    assert.equal(outcome.results[0].status, 'failed')
    assert.equal(outcome.results[0].code, 'UNKNOWN_SESSION')
    const document = await readQueueFile(world.deferredFile)
    assert.deepEqual(document.entries, [])
    assert.equal(document.lastRun.results[0].code, 'UNKNOWN_SESSION')
  })

  test('runDeferred applies only once per process; later queue additions stay queued', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }, { id: 's2' }] })
    await writeQueueFile(world.deferredFile, [queueEntry({ targets: [{ kind: 'session', id: 's1' }] })])
    const engine = world.engine()
    const first = await engine.runDeferred()
    assert.equal(first.ran, true)
    assert.equal(first.results[0].status, 'trashed')
    await writeQueueFile(world.deferredFile, [queueEntry({ targets: [{ kind: 'session', id: 's2' }] })])
    const second = await engine.runDeferred()
    assert.deepEqual(second, { ran: false, results: [] })
    assert.equal((await readQueueFile(world.deferredFile)).entries.length, 1, 'the second call must not touch the queue')
    await assertExists(world.dirOfSession('s2'), 'the late entry is not consumed in this process')
  })

  test('a second engine instance in the same process (hot reload) does not consume the queue', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }, { id: 's2' }] })
    await writeQueueFile(world.deferredFile, [queueEntry({ targets: [{ kind: 'session', id: 's1' }] })])
    assert.equal((await world.engine().runDeferred()).ran, true)
    await writeQueueFile(world.deferredFile, [queueEntry({ targets: [{ kind: 'session', id: 's2' }] })])
    // Re-entering apply() in the same process (hot reload) builds a fresh engine with live Agents.
    const reloaded = world.engine()
    assert.deepEqual(await reloaded.runDeferred(), { ran: false, results: [] })
    assert.equal((await readQueueFile(world.deferredFile)).entries.length, 1)
    await assertExists(world.dirOfSession('s2'))
    // The guard is a Set keyed by the queue file: the same queue is skipped, an independent one is not.
    const processed = globalThis[DEFERRED_PROCESSED_MARKER]
    assert.ok(processed instanceof Set, 'the once-per-process guard is a Set')
    assert.equal(processed.has(world.deferredFile), true, 'the guard records the applied queue file')
    assert.equal(processed.size, 1)
    // Proving the per-file marker is the cause: clearing it lets the same engine drain.
    resetDeferredMarker()
    assert.equal(globalThis[DEFERRED_PROCESSED_MARKER].has(world.deferredFile), false)
    const drained = await reloaded.runDeferred()
    assert.equal(drained.ran, true)
    await assertGone(world.dirOfSession('s2'))
  })

  test('an unwritable queue directory makes the start-up run back off before deleting anything', { skip: process.platform === 'win32' }, async () => {
    // The cross-process claim file cannot be created, so the run must not even attempt the deletions
    // (safer than deleting and then failing to persist the results).
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x' }] })
    await writeQueueFile(world.deferredFile, [queueEntry({ targets: [{ kind: 'session', id: 's1' }] })])
    const queueDir = path.dirname(world.deferredFile)
    const lockPath = `${world.deferredFile}.lock`
    await fsp.chmod(queueDir, 0o500)
    try {
      const outcome = await world.engine().runDeferred()
      assert.deepEqual(outcome, { ran: false, results: [] }, 'no claim means no deletion attempt')
      await assertExists(world.dirOfSession('s1'), 'the target is untouched when the queue cannot be claimed')
      const document = await readQueueFile(world.deferredFile)
      assert.equal(document.entries.length, 1, 'the queue is kept')
      assert.equal(document.lastRun, null)
      assert.equal(await exists(lockPath), false, 'no lock file may be left behind')
    } finally {
      await fsp.chmod(queueDir, 0o700)
    }
    // The next start can claim the queue and actually applies it.
    resetDeferredMarker()
    const retried = await world.engine().runDeferred()
    assert.equal(retried.ran, true)
    assert.equal(retried.results[0].status, 'trashed')
    await assertGone(world.dirOfSession('s1'))
    assert.deepEqual((await readQueueFile(world.deferredFile)).entries, [])
    assert.equal(await exists(lockPath), false, 'the claim is released after the run')
  })

  test('a corrupt queue document degrades to an empty deferred view instead of failing', async () => {
    const world = await makeWorld({})
    await fsp.mkdir(path.dirname(world.deferredFile), { recursive: true })
    await fsp.writeFile(world.deferredFile, '{not json')
    const engine = world.engine()
    assert.deepEqual((await engine.inventory()).deferred, { count: 0, retained: 0, lastRun: null })
    assert.deepEqual(await engine.deferredList(), { ok: true, deferred: { entries: [], retained: [], lastRun: null } })
    assert.deepEqual(await engine.deferredCancel({ all: true }), { ok: true, cancelled: 0 })
    assert.deepEqual(await engine.runDeferred(), { ran: false, results: [] })
    // Loss of the queue may cancel work but must never delete anything.
    assert.equal(await fsp.readFile(world.deferredFile, 'utf8'), '{not json')
  })

  test('an unreadable queue path degrades to an empty deferred view', async () => {
    const world = await makeWorld({})
    const notADirectory = path.join(world.root, 'cleanup-file')
    await fsp.writeFile(notADirectory, 'x')
    const engine = world.engine({ config: { deferredFile: path.join(notADirectory, 'deferred.json') } })
    assert.deepEqual((await engine.inventory()).deferred, { count: 0, retained: 0, lastRun: null })
    const listed = await engine.deferredList()
    assert.equal(listed.ok, true)
    assert.deepEqual(listed.deferred.entries, [])
    assert.deepEqual(listed.deferred.retained, [])
    assert.deepEqual(await engine.deferredCancel({ all: true }), { ok: true, cancelled: 0 })
    assert.deepEqual(await engine.runDeferred(), { ran: false, results: [] })
  })

  test('structurally corrupt queue entries are ignored on every route instead of failing', async () => {
    // SPEC §5.8: entries whose targets are not well-formed {kind,id} pairs are dropped at read time, so
    // a hand-edited document degrades to "nothing scheduled" — never a partial IO_ERROR/500.
    const world = await makeWorld({})
    await writeQueueFile(world.deferredFile, [{ targets: [null] }, { targets: 'x' }, {}])
    const engine = world.engine()
    assert.deepEqual(await engine.deferredList(), { ok: true, deferred: { entries: [], retained: [], lastRun: null } })
    assert.deepEqual((await engine.inventory()).deferred, { count: 0, retained: 0, lastRun: null })
    assert.deepEqual(await engine.runDeferred(), { ran: false, results: [] })
    // A usable target with no id is kept and given a deterministic recovered id, not dropped.
    await writeQueueFile(world.deferredFile, [{ targets: [{ kind: 'session', id: 's1' }] }])
    const listed = await world.engine().deferredList()
    assert.equal(listed.ok, true)
    assert.equal(listed.deferred.entries.length, 1)
    assert.equal(listed.deferred.entries[0].id, 'recovered-session:s1')
    assert.equal(listed.deferred.entries[0].mode, 'trash')
    assert.deepEqual(listed.deferred.entries[0].targets, [{ kind: 'session', id: 's1' }])
  })

  test('queueing a permanent deletion never evicts the plan under review (maxPlans: 1)', async () => {
    // Permanent-mode defer() only validates the typed name; it must not retain a plan record, because
    // retaining (and pruning) there evicted the plan the user was reviewing.
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const engine = world.engine({ config: { maxPlans: 1 } })
    const reviewed = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    const expected = path.basename(world.dirOf('ws1'))
    const queued = await engine.defer({
      targets: [{ kind: 'workspace', id: 'ws1' }],
      mode: 'permanent',
      includeSessions: false,
      confirmationText: expected,
    })
    assert.equal(queued.ok, true, 'queueing itself must succeed')
    assert.equal((await engine.deferredList()).deferred.entries.length, 1)
    const executed = await engine.execute({ planId: reviewed.planId })
    assert.equal(executed.ok, true, 'the reviewed plan must survive queueing')
    assert.deepEqual(executed.result.items.map((item) => item.status), ['trashed'])
  })

  test('lastRun status describes the outcome: an unmaterialized session is deleted, not trashed', async () => {
    // SPEC §4.7: status says what actually happened. A session without a stored location is deleted
    // with bytes 0 and no trash entry exists, so the entry summary must not claim "trashed".
    const world = await makeWorld({ sessions: [{ id: 'unborn', unborn: true }] })
    await writeQueueFile(world.deferredFile, [queueEntry({ targets: [{ kind: 'session', id: 'unborn' }] })])
    const outcome = await world.engine().runDeferred()
    assert.equal(outcome.ran, true)
    const [result] = outcome.results
    assert.deepEqual(result.items, [{ kind: 'session', id: 'unborn', status: 'deleted' }])
    assert.equal(result.status, 'deleted')
    assert.deepEqual(await trashEntries(world), [], 'nothing was moved to the trash')
    const document = await readQueueFile(world.deferredFile)
    assert.equal(document.lastRun.results[0].status, 'deleted')
  })

  test('a blocked permanent workspace deletion queues with the typed name and executes at next start', async () => {
    // A live session inside the workspace blocks the plan, but the typed name is
    // the deferred-route gate. It must be captured now and still match when the queue runs.
    const world = await makeWorld({
      workspaces: [{ id: 'ws1', title: 'proj', sessionIds: ['sIn'] }],
      sessions: [{ id: 'sIn', cwd: undefined, createdAt: 1 }],
      live: ['sIn'],
    })
    world.snapshot('sIn').header.cwd = world.dirOf('ws1')
    const engine = world.engine()
    const targets = [{ kind: 'workspace', id: 'ws1' }]
    const expected = path.basename(world.dirOf('ws1'))
    const blockedPlan = planOf(await engine.plan({ targets, mode: 'permanent' }))
    assert.ok(blockedPlan.blockers.length > 0)
    assert.deepEqual(blockedPlan.blockers.map((entry) => entry.code).sort(), ['SESSION_LIVE', 'WORKSPACE_HAS_LIVE_SESSIONS'])
    assert.deepEqual(blockedPlan.confirmation, { kind: 'typed-name', expected, label: 'proj' })
    // The name is required even though the plan is blocked.
    assertFail(await engine.defer({ targets, mode: 'permanent' }), 'CONFIRMATION_REQUIRED')
    assertFail(await engine.defer({ targets, mode: 'permanent', confirmationText: 'nope' }), 'CONFIRMATION_MISMATCH')
    assert.equal(await exists(world.deferredFile), false, 'a refused queueing attempt writes nothing')
    const queued = await engine.defer({ targets, mode: 'permanent', confirmationText: expected })
    assert.equal(queued.ok, true)
    const document = await readQueueFile(world.deferredFile)
    assert.equal(document.entries[0].confirmationText, expected, 'the reviewed name is captured for the start-up run')

    // Next Host start: the blocking session/agent does not exist yet, and the stored name matches the
    // re-derived confirmation, so the permanent deletion finally runs.
    resetDeferredMarker()
    const startup = world.engine({
      sessions: { get: () => undefined, list: () => [] },
      agents: { get: () => undefined, list: () => [] },
    })
    const outcome = await startup.runDeferred()
    assert.equal(outcome.ran, true)
    assert.equal(outcome.results[0].mode, 'permanent')
    assert.equal(outcome.results[0].status, 'deleted')
    await assertGone(world.dirOf('ws1'), 'workspace directory')
    await assertGone(world.dirOfSession('sIn'), 'swept session log')
    assert.deepEqual(world.registryCalls.filter(([name]) => name === 'delete'), [['delete', 'ws1']])
    assert.deepEqual(await trashEntries(world), [])
    assert.deepEqual((await readQueueFile(world.deferredFile)).entries, [])
  })

  test('concurrent queueing loses no updates', async () => {
    // Queue mutations are serialized in-process (SPEC §5.8); without the lock the concurrent
    // read-modify-write requests overwrite each other and entries disappear.
    const specs = []
    for (let index = 0; index < 12; index += 1) specs.push({ id: `c${index}`, createdAt: index })
    const world = await makeWorld({ sessions: specs })
    const engine = world.engine()
    const responses = await Promise.all(
      specs.map((spec) => engine.defer({ targets: [{ kind: 'session', id: spec.id }], mode: 'trash' })),
    )
    assert.equal(responses.length, 12)
    assert.ok(responses.every((response) => response.ok === true), 'every concurrent request must succeed')
    const document = await readQueueFile(world.deferredFile)
    assert.equal(document.entries.length, 12, 'no read-modify-write update may be lost')
    const persistedIds = document.entries.map((entry) => entry.id).sort()
    assert.deepEqual(persistedIds, responses.map((response) => response.deferred.entryIds[0]).sort())
    assert.equal(new Set(persistedIds).size, 12)
    assert.equal((await engine.deferredList()).deferred.entries.length, 12)

    // A concurrent replace + cancel must also settle to one consistent, parseable document.
    const [replaced, cancelled] = await Promise.all([
      engine.defer({ targets: [{ kind: 'session', id: 'c0' }], mode: 'trash', includeSessions: false }),
      engine.deferredCancel({ entryIds: [responses[1].deferred.entryIds[0]] }),
    ])
    assert.equal(replaced.ok, true)
    assert.equal(replaced.deferred.replaced, true)
    assert.equal(cancelled.ok, true)
    assert.equal(cancelled.cancelled, 1)
    const finalDocument = await readQueueFile(world.deferredFile)
    assert.equal(finalDocument.entries.length, 11, 'one replace (+0) and one cancel (-1) from 12')
    assert.equal(new Set(finalDocument.entries.map((entry) => entry.id)).size, 11, 'ids stay unique')
    const keys = finalDocument.entries.map((entry) => entry.targets.map((target) => `${target.kind}:${target.id}`).join('|'))
    assert.equal(keys.includes('session:c1'), false, 'the cancelled entry is gone')
    const kept = finalDocument.entries.find((entry) => entry.targets.map((target) => `${target.kind}:${target.id}`).join('|') === 'session:c0')
    assert.ok(kept)
    assert.equal(kept.includeSessions, false, 'the replacement options were persisted')
    assert.equal((await engine.deferredList()).deferred.entries.length, 11)
  })

  test('a permanent queued deletion of a directory replaced in place is skipped with PATH_CHANGED', async () => {
    // The typed name alone would accept a folder swapped in place; the stored device/inode identity
    // must stop the startup run.
    const world = await makeWorld({ workspaces: [{ id: 'ws1', title: 'proj', files: { 'reviewed.txt': 'keep' } }] })
    const expected = path.basename(world.dirOf('ws1'))
    const queuer = world.engine()
    const queued = await queuer.defer({
      targets: [{ kind: 'workspace', id: 'ws1' }],
      mode: 'permanent',
      includeSessions: false,
      confirmationText: expected,
    })
    assert.equal(queued.ok, true)
    const stored = (await readQueueFile(world.deferredFile)).entries[0]
    assert.equal(stored.confirmedDirectory.workspaceId, 'ws1')
    assert.equal(stored.confirmedDirectory.path, world.dirOf('ws1'))
    assert.equal(typeof stored.confirmedDirectory.inode, 'number', 'the review freezes the directory inode')

    // Replace the folder in place: the reviewed directory moves aside (so its inode stays alive and
    // cannot be reused) and a different directory is created at the same canonical path.
    const reviewedDir = world.dirOf('ws1')
    const movedAside = path.join(world.root, 'reviewed-moved-away')
    await fsp.rename(reviewedDir, movedAside)
    await fsp.mkdir(reviewedDir, { recursive: true })
    await fsp.writeFile(path.join(reviewedDir, 'replacement.txt'), 'different directory')
    resetDeferredMarker()
    const outcome = await world.engine().runDeferred()
    assert.equal(outcome.ran, true)
    const [result] = outcome.results
    assert.equal(result.status, 'skipped')
    assert.equal(result.code, 'PATH_CHANGED')
    assert.equal(await fsp.readFile(path.join(reviewedDir, 'replacement.txt'), 'utf8'), 'different directory')
    assert.equal(await fsp.readFile(path.join(movedAside, 'reviewed.txt'), 'utf8'), 'keep')
    assert.equal(world.entities.has('ws1'), true, 'a skip must not delete the registration')
    const document = await readQueueFile(world.deferredFile)
    assert.deepEqual(document.entries, [])
    assert.equal(document.lastRun.results[0].code, 'PATH_CHANGED')
  })

  test('a queued permanent deletion does not follow the typed name to another workspace with the same basename', async () => {
    // Only A exists when queued (B is a registration without a directory). At startup A has vanished
    // and B points at a directory whose final segment matches the confirmed name.
    const world = await makeWorld({ workspaces: [{ id: 'ws-a', title: 'Alpha' }] })
    const aDir = world.dirOf('ws-a')
    const bDir = path.join(world.root, 'elsewhere', path.basename(aDir))
    world.entities.set('ws-b', { id: 'ws-b', path: bDir, title: 'Beta', sessionIds: [] })
    const expected = path.basename(aDir)
    const queued = await world.engine().defer({
      targets: [{ kind: 'workspace', id: 'ws-a' }, { kind: 'workspace', id: 'ws-b' }],
      mode: 'permanent',
      includeSessions: false,
      confirmationText: expected,
    })
    assert.equal(queued.ok, true)
    // Startup world: A's directory is gone, B now has a real directory with the same segment.
    await fsp.rename(aDir, path.join(world.root, 'a-moved-away'))
    await fsp.mkdir(bDir, { recursive: true })
    await fsp.writeFile(path.join(bDir, 'b-marker.txt'), 'B content')
    resetDeferredMarker()
    const outcome = await world.engine().runDeferred()
    assert.equal(outcome.ran, true)
    const [result] = outcome.results
    assert.equal(result.status, 'skipped')
    assert.equal(result.code, 'PATH_CHANGED')
    assert.equal(await fsp.readFile(path.join(bDir, 'b-marker.txt'), 'utf8'), 'B content', 'the other workspace is untouched')
    assert.equal(world.entities.has('ws-a'), true)
    assert.equal(world.entities.has('ws-b'), true)
    assert.deepEqual((await readQueueFile(world.deferredFile)).entries, [])
  })

  test('a queued workspace deletion is skipped if an unreviewed session appeared inside it', async () => {
    // The reviewed item set is frozen at queue time: a session created afterwards is not covered.
    const world = await makeWorld({
      workspaces: [{ id: 'ws1', title: 'proj' }],
      sessions: [{ id: 'sOld', cwd: undefined, createdAt: 1 }],
    })
    world.snapshot('sOld').header.cwd = world.dirOf('ws1')
    const engine = world.engine()
    const queued = await engine.defer({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: true })
    assert.equal(queued.ok, true)
    const reviewed = (await readQueueFile(world.deferredFile)).entries[0].reviewedItems
      .map((item) => `${item.kind}:${item.id}`)
      .sort()
    assert.deepEqual(reviewed, ['session:sOld', 'workspace-dir:ws1'])
    // A session created after the review lives in the same directory.
    const newDir = path.join(world.root, 'sessions', '--test-project--', 'sNew')
    await fsp.mkdir(newDir, { recursive: true })
    await fsp.writeFile(path.join(newDir, 'log.jsonl'), 'new\n')
    world.snapshots.set('sNew', {
      header: { id: 'sNew', cwd: world.dirOf('ws1'), createdAt: 2 },
      location: { path: path.join(newDir, 'log.jsonl') },
    })
    resetDeferredMarker()
    const outcome = await world.engine().runDeferred()
    assert.equal(outcome.ran, true)
    const [result] = outcome.results
    assert.equal(result.status, 'skipped')
    assert.equal(result.code, 'DEFERRED_TARGETS_CHANGED')
    await assertExists(world.dirOf('ws1'), 'the workspace directory is untouched')
    await assertExists(world.dirOfSession('sOld'), 'the reviewed session is untouched')
    await assertExists(newDir, 'the unreviewed session is untouched')
    assert.deepEqual(await trashEntries(world), [])
    const document = await readQueueFile(world.deferredFile)
    assert.deepEqual(document.entries, [])
    assert.equal(document.lastRun.results[0].code, 'DEFERRED_TARGETS_CHANGED')
  })

  test('a reviewed item that vanished before the start-up run does not block the rest', async () => {
    // Guard against over-blocking: the drift check only refuses *unreviewed* items; an item deleted
    // meanwhile simply cannot be part of the re-derived plan.
    const world = await makeWorld({
      workspaces: [{ id: 'ws1', title: 'proj' }],
      sessions: [{ id: 'sOld', cwd: undefined, createdAt: 1 }],
    })
    world.snapshot('sOld').header.cwd = world.dirOf('ws1')
    const queued = await world.engine().defer({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: true })
    assert.equal(queued.ok, true)
    // Another process deleted the reviewed session before our start-up run.
    world.snapshots.delete('sOld')
    await fsp.rm(world.dirOfSession('sOld'), { recursive: true, force: true })
    resetDeferredMarker()
    const outcome = await world.engine().runDeferred()
    assert.equal(outcome.ran, true)
    assert.equal(outcome.results[0].status, 'trashed')
    const trash = await trashEntries(world)
    assert.equal(trash.length, 1, 'the remaining reviewed item is applied')
    assert.equal(trash[0].meta.kind, 'workspace-dir')
    await assertGone(world.dirOf('ws1'))
    assert.deepEqual((await readQueueFile(world.deferredFile)).entries, [])
  })

  test('queue claims: the run lock makes a run busy and the mutation lock makes queue edits DEFERRED_BUSY; a stale run claim is taken over', async () => {
    // SPEC §5.9: the start-up run holds a claim for the whole run (`<queue>.run.lock`); the queue
    // document itself is only locked per step (`<queue>.lock`), so a long run does not block edits.
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x' }] })
    await writeQueueFile(world.deferredFile, [queueEntry({ targets: [{ kind: 'session', id: 's1' }] })])
    const runLockPath = `${world.deferredFile}.run.lock`
    const mutationLockPath = `${world.deferredFile}.lock`
    // A live pid: a dead one is now taken over immediately (0.4.0), so the busy case must name a
    // process that actually exists.
    await fsp.writeFile(runLockPath, JSON.stringify({ pid: process.pid, at: Date.now() }))
    const engine = world.engine()
    resetDeferredMarker()
    const busy = await engine.runDeferred()
    assert.deepEqual(busy, { ran: false, busy: true, results: [] })
    await assertExists(world.dirOfSession('s1'), 'a busy queue is not applied')
    assert.equal((await readQueueFile(world.deferredFile)).entries.length, 1)
    // A concurrently held mutation lock makes edits answer DEFERRED_BUSY instead of overwriting.
    await fsp.writeFile(mutationLockPath, JSON.stringify({ pid: 424242, at: Date.now() }))
    assertFail(await engine.defer({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }), 'DEFERRED_BUSY')
    assertFail(await engine.deferredCancel({ all: true }), 'DEFERRED_BUSY')
    // A run claim whose recorded process no longer exists belongs to a crashed process: take it over.
    // A live claim is never taken over by age (see the dedicated live/aged cases below).
    await fsp.writeFile(runLockPath, JSON.stringify({ pid: 999999999, at: Date.now() }))
    await fsp.unlink(mutationLockPath)
    resetDeferredMarker()
    const outcome = await engine.runDeferred()
    assert.equal(outcome.ran, true)
    assert.equal(outcome.results[0].status, 'trashed')
    await assertGone(world.dirOfSession('s1'))
    assert.deepEqual((await readQueueFile(world.deferredFile)).entries, [])
    assert.equal(await exists(runLockPath), false, 'the stale run claim and the fresh one are released')
    assert.equal(await exists(mutationLockPath), false, 'the per-step mutation lock is released')
  })

  test('the start-up run probes cross-process session writability through sessionPersistence.open', async () => {
    // (a) another Host holds the session's write handle: skip SESSION_LIVE and keep the log.
    const busyWorld = await makeWorld({ sessions: [{ id: 's1', content: 'x' }] })
    await writeQueueFile(busyWorld.deferredFile, [queueEntry({ targets: [{ kind: 'session', id: 's1' }] })])
    const opened = []
    const ownershipError = new Error('session is already owned by another process')
    ownershipError.name = 'SessionAlreadyOwnedError'
    const busyEngine = busyWorld.engine({
      sessionPersistence: {
        list: async () => [...busyWorld.snapshots.values()],
        stat: async (id) => busyWorld.snapshots.get(id),
        open: async (id, mode) => {
          opened.push([id, mode])
          throw ownershipError
        },
      },
    })
    const busy = await busyEngine.runDeferred()
    assert.equal(busy.ran, true)
    assert.equal(busy.results[0].status, 'skipped')
    assert.equal(busy.results[0].code, 'SESSION_LIVE')
    assert.deepEqual(opened, [['s1', 'write']])
    await assertExists(busyWorld.dirOfSession('s1'), 'the log is left alone under another writer')
    assert.deepEqual(await trashEntries(busyWorld), [])

    // (b) a free session: the probe closes its handle and the deletion executes.
    const freeWorld = await makeWorld({ sessions: [{ id: 's1', content: 'x' }] })
    await writeQueueFile(freeWorld.deferredFile, [queueEntry({ targets: [{ kind: 'session', id: 's1' }] })])
    let closed = 0
    const freeEngine = freeWorld.engine({
      sessionPersistence: {
        list: async () => [...freeWorld.snapshots.values()],
        stat: async (id) => freeWorld.snapshots.get(id),
        open: async () => ({ close: async () => { closed += 1 } }),
      },
    })
    const free = await freeEngine.runDeferred()
    assert.equal(free.ran, true)
    assert.equal(free.results[0].status, 'trashed')
    assert.equal(closed, 1, 'the probe write claim is released')
    await assertGone(freeWorld.dirOfSession('s1'))

    // (c) a backend without open(): the probe is skipped and the deletion still executes.
    const plainWorld = await makeWorld({ sessions: [{ id: 's1', content: 'x' }] })
    await writeQueueFile(plainWorld.deferredFile, [queueEntry({ targets: [{ kind: 'session', id: 's1' }] })])
    const plain = await plainWorld.engine().runDeferred()
    assert.equal(plain.ran, true)
    assert.equal(plain.results[0].status, 'trashed')
    await assertGone(plainWorld.dirOfSession('s1'))
  })

  test('unknown queue schema versions are empty, while a v1 document migrates to v2', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    const document = {
      version: 99,
      entries: [{ id: 'future-entry', queuedAt: 1, mode: 'trash', targets: [{ kind: 'session', id: 's1' }] }],
      lastRun: null,
    }
    await fsp.mkdir(path.dirname(world.deferredFile), { recursive: true })
    await fsp.writeFile(world.deferredFile, JSON.stringify(document))
    const engine = world.engine()
    assert.deepEqual((await engine.inventory()).deferred, { count: 0, retained: 0, lastRun: null })
    assert.deepEqual(await engine.deferredList(), { ok: true, deferred: { entries: [], retained: [], lastRun: null } })
    resetDeferredMarker()
    assert.deepEqual(await engine.runDeferred(), { ran: false, results: [] })
    await assertExists(world.dirOfSession('s1'), 'an unknown schema never schedules a deletion')
    assert.deepEqual(JSON.parse(await fsp.readFile(world.deferredFile, 'utf8')), document, 'the document is left untouched')

    // A v1 document (no retained list / claims) reads as v2 with empty retained, and the next write
    // upgrades it in place.
    await writeQueueFile(world.deferredFile, [queueEntry({ targets: [{ kind: 'session', id: 's1' }] })])
    const migrated = await world.engine().deferredList()
    assert.equal(migrated.ok, true)
    assert.equal(migrated.deferred.entries.length, 1)
    assert.deepEqual(migrated.deferred.retained, [])
    await world.engine().deferredCancel({ entryIds: [migrated.deferred.entries[0].id] })
    const upgraded = await readQueueFile(world.deferredFile)
    assert.equal(upgraded.version, 2)
    assert.deepEqual(upgraded.retained, [])
  })

  test('a hand-written queue is capped at 100 entries on read and the boot run is bounded too', async () => {
    const world = await makeWorld({})
    /** @type {object[]} */
    const entries = []
    for (let index = 0; index < 150; index += 1) entries.push(queueEntry({ targets: [{ kind: 'session', id: `ghost-${index}` }] }))
    await writeQueueFile(world.deferredFile, entries)
    const engine = world.engine()
    assert.equal((await engine.deferredList()).deferred.entries.length, 100)
    assert.equal((await engine.inventory()).deferred.count, 100)
    resetDeferredMarker()
    const outcome = await engine.runDeferred()
    assert.equal(outcome.ran, true)
    assert.equal(outcome.results.length, 100, 'the boot run is bounded by the same cap')
    const document = await readQueueFile(world.deferredFile)
    assert.deepEqual(document.entries, [])
    assert.equal(document.lastRun.results.length, 100)
  })

  test('defer counts entries not targets, caps targets at 64 and rejects a non-string confirmationText', async () => {
    const specs = []
    for (let index = 0; index < 64; index += 1) specs.push({ id: `c${index}`, createdAt: index })
    const world = await makeWorld({ sessions: specs })
    const engine = world.engine()
    const all = specs.map((spec) => ({ kind: 'session', id: spec.id }))
    const accepted = await engine.defer({ targets: all, mode: 'trash' })
    assert.equal(accepted.ok, true)
    assert.equal(accepted.deferred.count, 1, 'count is queued entries, not the 64 targets')
    assert.equal((await readQueueFile(world.deferredFile)).entries.length, 1)
    assert.equal((await readQueueFile(world.deferredFile)).entries[0].reviewedItems.length, 64)
    const tooMany = [...all, { kind: 'session', id: 'c-extra' }]
    assertFail(await engine.defer({ targets: tooMany, mode: 'trash' }), 'BAD_REQUEST')
    assertFail(
      await engine.defer({ targets: [{ kind: 'session', id: 'c0' }], mode: 'trash', confirmationText: 123 }),
      'BAD_REQUEST',
    )
    assert.equal((await readQueueFile(world.deferredFile)).entries.length, 1, 'rejected requests write nothing')
  })

  test('defer on an unusable queue location degrades to an IO_ERROR envelope', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    const notADirectory = path.join(world.root, 'cleanup-file')
    await fsp.writeFile(notADirectory, 'x')
    const engine = world.engine({ config: { deferredFile: path.join(notADirectory, 'deferred.json') } })
    assertFail(await engine.defer({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }), 'IO_ERROR')
    await assertExists(world.dirOfSession('s1'), 'nothing is deleted when the queue cannot be located')
  })
})

// #endregion

// #region P1 feature regressions: audit + settings (SPEC §5.9/§4.8) ---------------------------

/** Read the audit log as parsed records (append order = oldest first). */
async function readAudit(world) {
  let text
  try {
    text = await fsp.readFile(world.auditFile, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

/** Write one trash entry directory with a metadata file (lifecycle/audit fixtures). */
async function writeTrashEntry(world, id, { bytes = 0, movedAt = 0, kind = 'session' } = {}) {
  const directory = path.join(world.trashRoot, id)
  await fsp.mkdir(directory, { recursive: true })
  await fsp.writeFile(
    path.join(directory, 'meta.json'),
    `${JSON.stringify({ version: 1, kind, title: id, originalPath: path.join(world.root, 'gone', id), movedAt, bytes, files: 1, dirs: 0 })}\n`,
  )
  return directory
}

/** Write a v2 queue document directly (claims/retained fixtures). */
async function writeQueueDocument(world, document) {
  await fsp.mkdir(path.dirname(world.deferredFile), { recursive: true })
  await fsp.writeFile(
    world.deferredFile,
    `${JSON.stringify({ version: 2, entries: [], retained: [], lastRun: null, ...document }, null, 2)}\n`,
  )
}

describe('audit log (SPEC §5.9)', () => {
  test('an immediate trash deletion appends one delete record and the inventory shows it newest-first', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }, { id: 's2' }] })
    const engine = world.engine()
    for (const id of ['s1', 's2']) {
      const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id }], mode: 'trash' }))
      assert.equal((await engine.execute({ planId: plan.planId })).ok, true)
    }
    const records = await readAudit(world)
    assert.equal(records.length, 2)
    assert.deepEqual(records.map((record) => record.action), ['delete', 'delete'])
    assert.deepEqual(records[0].targets, [{ kind: 'session', id: 's1' }])
    assert.equal(records[0].source, 'immediate')
    const inventory = await engine.inventory()
    assert.equal(inventory.audit.enabled, true)
    assert.equal(inventory.audit.recent.length, 2)
    assert.deepEqual(Object.keys(inventory.audit.recent[0]).sort(), ['action', 'at', 'bytes', 'code', 'mode', 'source', 'status', 'targets'])
    assert.deepEqual(inventory.audit.recent[0].targets, [{ kind: 'session', id: 's2' }], 'newest record first')
    assert.equal(inventory.audit.recent[0].action, 'delete')
    assert.equal(inventory.audit.recent[0].source, 'immediate')
    assert.equal(inventory.audit.recent[0].mode, 'trash')
    assert.equal(inventory.audit.recent[0].status, 'trashed')
    assert.ok(inventory.audit.recent[0].bytes > 0)
  })

  test('a start-up run records per-entry skip/delete records plus one startup-run summary', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x' }, { id: 's2', content: 'y' }], live: ['s2'] })
    await writeQueueDocument(world, {
      entries: [
        queueEntry({ targets: [{ kind: 'session', id: 's1' }] }),
        queueEntry({ targets: [{ kind: 'session', id: 's2' }] }),
        queueEntry({ targets: [{ kind: 'session', id: 'ghost' }] }),
      ],
    })
    resetDeferredMarker()
    const outcome = await world.engine().runDeferred()
    assert.equal(outcome.ran, true)
    assert.equal(outcome.results.length, 3)
    const records = await readAudit(world)
    const startupRecords = records.filter((record) => record.source === 'startup')
    assert.deepEqual(startupRecords.map((record) => record.action), ['delete', 'skip', 'delete', 'startup-run'])
    assert.equal(startupRecords[0].status, 'trashed')
    assert.equal(startupRecords[1].code, 'SESSION_LIVE')
    assert.equal(startupRecords[2].status, 'failed')
    assert.equal(startupRecords[3].applied, 1)
    assert.equal(startupRecords[3].skipped, 1)
    assert.equal(startupRecords[3].failed, 1)
    const inventory = await world.engine().inventory()
    assert.deepEqual(inventory.audit.lastStartup, { at: world.clock.now(), applied: 1, skipped: 1, failed: 1 })
    assert.deepEqual(inventory.deferred, { count: 0, retained: 2, lastRun: (await readQueueFile(world.deferredFile)).lastRun })
  })

  test('trash restore/purge and queue defer/cancel/requeue are all audited', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x' }, { id: 's2', content: 'y' }] })
    const engine = world.engine()
    // defer -> cancel (queue write paths)
    const queued = await engine.defer({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' })
    assert.equal(queued.ok, true)
    const queuedId = queued.deferred.entryIds[0]
    assert.deepEqual(await engine.deferredCancel({ entryIds: [queuedId] }), { ok: true, cancelled: 1 })
    // immediate delete -> restore
    const firstPlan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.equal((await engine.execute({ planId: firstPlan.planId })).ok, true)
    const [entry] = (await engine.trashList()).entries
    assert.equal((await engine.trashRestore({ entryId: entry.id })).ok, true)
    // immediate delete -> purge
    const secondPlan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's2' }], mode: 'trash' }))
    assert.equal((await engine.execute({ planId: secondPlan.planId })).ok, true)
    const [purgeEntry] = (await engine.trashList()).entries
    const purged = await engine.trashPurge({ entryIds: [purgeEntry.id] })
    assert.equal(purged.ok, true)
    assert.ok(purged.bytes > 0)
    // requeue (retained fixture)
    await writeQueueDocument(world, {
      retained: [{ at: 1, status: 'skipped', code: 'SESSION_LIVE', reason: 'busy', entry: queueEntry({ mode: 'trash', targets: [{ kind: 'session', id: 's1' }] }) }],
      entries: [],
    })
    const requeued = await engine.deferredRequeue({ all: true })
    assert.equal(requeued.ok, true)
    assert.equal(requeued.requeued, 1)
    const records = await readAudit(world)
    const actions = records.map((record) => record.action)
    for (const action of ['defer', 'cancel', 'delete', 'restore', 'purge', 'requeue']) {
      assert.ok(actions.includes(action), `expected an audit record for ${action}; got ${actions.join(',')}`)
    }
    assert.ok(records.some((record) => record.action === 'restore' && Array.isArray(record.entryIds)))
    assert.ok(records.some((record) => record.action === 'purge' && record.bytes > 0))
  })

  test('auditEnabled:false records nothing and the inventory reports enabled:false', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    const engine = world.engine({ config: { auditEnabled: false } })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.equal((await engine.execute({ planId: plan.planId })).ok, true)
    assert.equal(await exists(world.auditFile), false, 'a disabled audit writes no file')
    const inventory = await engine.inventory()
    assert.deepEqual(inventory.audit, { enabled: false, lastStartup: null, recent: [] })
  })

  test('the audit log rotates to one generation past auditMaxBytes', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    const engine = world.engine({ config: { auditMaxBytes: 250 } })
    for (let index = 0; index < 10; index += 1) {
      const queued = await engine.defer({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' })
      assert.equal(queued.ok, true)
    }
    const rotated = `${world.auditFile}.1`
    assert.equal(await exists(rotated), true, 'the previous generation exists')
    const current = await fsp.stat(world.auditFile)
    assert.ok(current.size > 0)
    const currentRecords = await readAudit(world)
    assert.ok(currentRecords.length >= 1)
    const rotatedText = await fsp.readFile(rotated, 'utf8')
    assert.ok(rotatedText.split('\n').filter((line) => line.trim() !== '').length >= 1)
    assert.ok((await engine.inventory()).audit.recent.length <= 10)
  })

  test('an unwritable audit directory never fails the deletion and the inventory still answers', { skip: process.platform === 'win32' }, async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x' }] })
    const engine = world.engine()
    await fsp.mkdir(world.stateDir, { recursive: true })
    await fsp.chmod(world.stateDir, 0o500)
    try {
      const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
      const executed = await engine.execute({ planId: plan.planId })
      assert.equal(executed.ok, true, 'auditing is diagnostic, never load-bearing')
      assert.deepEqual(executed.result.items.map((item) => item.status), ['trashed'])
      const inventory = await engine.inventory()
      assert.equal(inventory.ok, true)
      assert.equal(inventory.audit.enabled, true)
      assert.ok(Array.isArray(inventory.audit.recent), 'the overview stays total')
      // Nothing reached the unwritable file: the log is diagnostic and never persisted a torn state.
      assert.deepEqual(await readAudit(world), [])
    } finally {
      await fsp.chmod(world.stateDir, 0o700)
    }
  })
})

describe('settings (SPEC §4.8)', () => {
  const SETTING_KEYS = [
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
  ]

  test('settings.get reports effective settings, loader-row defaults, overrides and writability', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }] })
    await fsp.mkdir(path.dirname(world.settingsFile), { recursive: true })
    await fsp.writeFile(world.settingsFile, JSON.stringify({ version: 1, overrides: { maxPlans: 9, auditEnabled: false } }))
    const engine = world.engine({ config: { maxPlans: 7, auditEnabled: false }, baseConfig: { maxPlans: 5 } })
    const response = await engine.settingsGet()
    assert.equal(response.ok, true)
    assert.deepEqual(Object.keys(response).sort(), ['defaults', 'ok', 'overrides', 'persisted', 'settings'])
    assert.deepEqual(Object.keys(response.settings).sort(), SETTING_KEYS)
    assert.deepEqual(Object.keys(response.defaults).sort(), SETTING_KEYS)
    assert.equal(response.settings.maxPlans, 7)
    assert.equal(response.defaults.maxPlans, 5)
    assert.deepEqual(response.overrides, { auditEnabled: false, maxPlans: 9 })
    assert.equal(response.persisted, true)
  })

  test('settings.set applies at runtime and persists version-1 overrides next to the queue', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'a.txt': 'hello world' } }] })
    const engine = world.engine()
    const set = await engine.settingsSet({ patch: { trashMaxBytes: 1, auditEnabled: false } })
    assert.equal(set.ok, true)
    assert.equal(set.persisted, true)
    assert.equal(set.settings.trashMaxBytes, 1)
    assert.equal(set.settings.auditEnabled, false)
    assert.deepEqual(Object.keys(set.warnings ?? {}), [])
    const persisted = JSON.parse(await fsp.readFile(world.settingsFile, 'utf8'))
    assert.equal(persisted.version, 1)
    assert.deepEqual(persisted.overrides, { auditEnabled: false, trashMaxBytes: 1 })
    // The runtime change is effective, not just persisted.
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.equal((await engine.execute({ planId: plan.planId })).ok, true)
    const inventory = await engine.inventory()
    assert.equal(inventory.trash.overCapacity, true)
    assert.equal(inventory.audit.enabled, false)
    assert.deepEqual(await readAudit(world), [], 'turning auditing off stops writes immediately')
  })

  test('settings.set rejects unknown fields and every documented bound with details.field', async () => {
    const world = await makeWorld({})
    const engine = world.engine()
    const invalid = [
      { nope: 1 },
      { maxScanEntries: 0 },
      { maxScanEntries: 5_000_001 },
      { scanTimeoutMs: 0 },
      { scanTimeoutMs: 600_001 },
      { planTtlMs: 999 },
      { planTtlMs: 86_400_001 },
      { maxPlans: 0 },
      { maxPlans: 1_001 },
      { auditMaxBytes: -1 },
      { auditMaxBytes: 1_073_741_825 },
      { trashRetentionDays: 3651 },
      { trashMaxBytes: -1 },
      { allowPermanentDeletion: 'yes' },
      { trashRoot: 'relative/trash' },
    ]
    for (const patch of invalid) {
      const field = Object.keys(patch)[0]
      const response = await engine.settingsSet({ patch })
      assert.equal(response.ok, false, JSON.stringify(patch))
      assert.equal(response.error.code, 'BAD_REQUEST', JSON.stringify(patch))
      assert.equal(response.error.details.field, field, JSON.stringify(patch))
    }
    assertFail(await engine.settingsSet({}), 'BAD_REQUEST')
    assertFail(await engine.settingsSet(null), 'BAD_REQUEST')
    // The documented bounds are inclusive.
    const lower = await engine.settingsSet({
      patch: { maxScanEntries: 1, scanTimeoutMs: 1, planTtlMs: 1_000, maxPlans: 1, auditMaxBytes: 0, trashRetentionDays: 0, trashMaxBytes: 0 },
    })
    assert.equal(lower.ok, true)
    const upper = await engine.settingsSet({
      patch: { maxScanEntries: 5_000_000, scanTimeoutMs: 600_000, planTtlMs: 86_400_000, maxPlans: 1_000, auditMaxBytes: 1_073_741_824, trashRetentionDays: 3_650, trashMaxBytes: 1e15 },
    })
    assert.equal(upper.ok, true)
  })

  test('a trashRoot change is accepted with the EXISTING_DATA_STAYS warning', async () => {
    const world = await makeWorld({})
    const engine = world.engine()
    const newTrashRoot = path.join(world.root, 'new-trash')
    const response = await engine.settingsSet({ patch: { trashRoot: newTrashRoot } })
    assert.equal(response.ok, true)
    assert.equal(response.settings.trashRoot, newTrashRoot)
    assert.deepEqual(response.warnings.map((warning) => [warning.field, warning.code]), [['trashRoot', 'EXISTING_DATA_STAYS']])
    assert.match(response.warnings[0].message, /old location/)
  })

  test('an unwritable settings location answers persisted:false with persistError while applying at runtime', async () => {
    const world = await makeWorld({})
    const blocked = path.join(world.root, 'blocked-settings-parent')
    await fsp.writeFile(blocked, 'x')
    const engine = world.engine({ config: { settingsFile: path.join(blocked, 'settings.json') } })
    const before = await engine.settingsGet()
    assert.equal(before.persisted, false)
    const response = await engine.settingsSet({ patch: { maxPlans: 9 } })
    assert.equal(response.ok, true)
    assert.equal(response.persisted, false)
    assert.equal(response.persistError.code, 'IO_ERROR')
    assert.equal(response.settings.maxPlans, 9, 'the runtime change still applies')
  })
})

// #endregion

// #region P1 feature regressions: trash lifecycle + retained queue + claims (SPEC §5.9/§4.7) --

describe('trash lifecycle warnings (SPEC §5.9)', () => {
  test('trashMaxBytes reports overCapacity and oldest-first suggested purge ids (bounded at 50)', async () => {
    const world = await makeWorld({})
    const ids = []
    for (let index = 0; index < 52; index += 1) {
      const id = `entry-${String(index).padStart(2, '0')}`
      ids.push(id)
      await writeTrashEntry(world, id, { bytes: 1, movedAt: 100 + index })
    }
    const engine = world.engine({ config: { trashMaxBytes: 1 } })
    const inventory = await engine.inventory()
    assert.equal(inventory.trash.entries, 52)
    assert.equal(inventory.trash.bytes, 52)
    assert.equal(inventory.trash.oldestMovedAt, 100)
    assert.equal(inventory.trash.overCapacity, true)
    assert.equal(inventory.trash.overRetention, false)
    assert.equal(inventory.trash.suggestedEntryIds.length, 50, 'the suggestion list is bounded at 50')
    assert.deepEqual(inventory.trash.suggestedEntryIds, ids.slice(0, 50), 'oldest entries first')
    // Warnings only: nothing is ever deleted by the inventory.
    assert.equal((await engine.trashList()).entries.length, 52)
  })

  test('trashRetentionDays reports only what is past retention; zero disables both warnings', async () => {
    // Use a clock far enough in the epoch that whole-day offsets stay positive.
    const world = await makeWorld({ startClock: 10 * 86_400_000 })
    await writeTrashEntry(world, 'old-entry', { bytes: 5, movedAt: world.clock.now() - 2 * 86_400_000 })
    await writeTrashEntry(world, 'fresh-entry', { bytes: 5, movedAt: world.clock.now() })
    const aging = world.engine({ config: { trashRetentionDays: 1 } })
    const aged = await aging.inventory()
    assert.equal(aged.trash.oldestMovedAt, world.clock.now() - 2 * 86_400_000)
    assert.equal(aged.trash.overRetention, true)
    assert.equal(aged.trash.overCapacity, false)
    assert.deepEqual(aged.trash.suggestedEntryIds, [])
    const quiet = world.engine({ config: { trashRetentionDays: 0, trashMaxBytes: 0 } })
    assert.equal((await quiet.inventory()).trash.overRetention, false)
    assert.equal((await quiet.inventory()).trash.overCapacity, false)
    assert.equal((await quiet.trashList()).entries.length, 2)
  })
})

describe('retained queue (SPEC §4.7)', () => {
  test('skipped and failed entries are retained with code/reason and projected without internals', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x' }, { id: 's2', content: 'y' }], live: ['s2'] })
    await writeQueueDocument(world, {
      entries: [
        queueEntry({ queuedAt: 1, targets: [{ kind: 'session', id: 's1' }] }),
        queueEntry({ queuedAt: 2, targets: [{ kind: 'session', id: 's2' }] }),
        queueEntry({ queuedAt: 3, targets: [{ kind: 'session', id: 'ghost' }] }),
      ],
    })
    resetDeferredMarker()
    const outcome = await world.engine().runDeferred()
    assert.equal(outcome.ran, true)
    assert.equal(outcome.results.length, 3)
    const document = await readQueueFile(world.deferredFile)
    assert.deepEqual(document.entries, [])
    assert.equal(document.retained.length, 2)
    assert.deepEqual(document.retained.map((record) => record.status), ['skipped', 'failed'])
    assert.equal(document.retained[0].code, 'SESSION_LIVE')
    assert.equal(document.retained[1].code, 'UNKNOWN_SESSION')
    const listed = await world.engine().deferredList()
    const retained = listed.deferred.retained
    assert.equal(retained.length, 2)
    for (const record of retained) {
      assert.deepEqual(Object.keys(record).sort(), ['at', 'code', 'id', 'mode', 'reason', 'status', 'targets'])
      assert.equal('entry' in record, false)
      assert.equal('confirmationText' in record, false)
    }
    assert.deepEqual(retained.map((record) => record.id), document.retained.map((record) => record.entry.id))
    const inventory = await world.engine().inventory()
    assert.deepEqual(inventory.deferred, {
      count: 0,
      retained: 2,
      lastRun: (await readQueueFile(world.deferredFile)).lastRun,
    })
  })

  test('the retained list is bounded to the newest 20 skipped/failed entries', async () => {
    const world = await makeWorld({})
    const entries = []
    for (let index = 0; index < 21; index += 1) entries.push(queueEntry({ queuedAt: index + 1, targets: [{ kind: 'session', id: `ghost-${index}` }] }))
    await writeQueueDocument(world, { entries })
    resetDeferredMarker()
    const outcome = await world.engine().runDeferred()
    assert.equal(outcome.results.length, 21)
    const document = await readQueueFile(world.deferredFile)
    assert.equal(document.retained.length, 20)
    // Newest last: the oldest record was dropped.
    assert.deepEqual(document.retained.map((record) => record.entry.targets[0].id), entries.slice(1).map((entry) => entry.targets[0].id))
  })

  test('deferred.requeue moves retained entries back and replaces equivalent target sets', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1' }, { id: 's2' }] })
    const active = queueEntry({ id: 'active-entry', queuedAt: 5, targets: [{ kind: 'session', id: 's1' }] })
    const retainedOne = { at: 1, status: 'skipped', code: 'SESSION_LIVE', reason: 'busy', entry: queueEntry({ id: 'retained-one', targets: [{ kind: 'session', id: 's1' }] }) }
    const retainedTwo = { at: 2, status: 'failed', code: 'UNKNOWN_SESSION', reason: 'gone', entry: queueEntry({ id: 'retained-two', targets: [{ kind: 'session', id: 's2' }] }) }
    await writeQueueDocument(world, { entries: [active], retained: [retainedOne, retainedTwo] })
    const engine = world.engine()
    const requeued = await engine.deferredRequeue({ entryIds: ['retained-one'] })
    assert.equal(requeued.ok, true)
    assert.equal(requeued.requeued, 1)
    assert.equal(requeued.count, 1, 'an equivalent target set is replaced, not duplicated')
    let document = await readQueueFile(world.deferredFile)
    assert.equal(document.entries.length, 1)
    assert.equal(document.entries[0].id, 'active-entry', 'the active entry id is kept on replacement')
    assert.equal(document.entries[0].queuedAt, world.clock.now())
    assert.equal(document.retained.length, 1)
    assert.equal(document.retained[0].entry.id, 'retained-two')
    const all = await engine.deferredRequeue({ all: true })
    assert.equal(all.ok, true)
    assert.equal(all.requeued, 1)
    assert.equal(all.count, 2)
    document = await readQueueFile(world.deferredFile)
    assert.equal(document.retained.length, 0)
    assert.equal(document.entries.length, 2)
    assert.deepEqual(await engine.deferredRequeue({ entryIds: ['unknown'] }), { ok: true, requeued: 0, count: 2 })
    for (const body of [null, 'x', {}, { entryIds: 'a' }, { entryIds: [1] }, { all: 'yes' }]) {
      assertFail(await engine.deferredRequeue(body), 'BAD_REQUEST', JSON.stringify(body))
    }
  })

  test('deferred.cancel can forget retained entries with the same control', async () => {
    const world = await makeWorld({})
    const retainedOne = { at: 1, status: 'skipped', code: 'SESSION_LIVE', reason: 'busy', entry: queueEntry({ id: 'keep-me', targets: [{ kind: 'session', id: 'a' }] }) }
    const retainedTwo = { at: 2, status: 'failed', code: 'UNKNOWN_SESSION', reason: 'gone', entry: queueEntry({ id: 'forget-me', targets: [{ kind: 'session', id: 'b' }] }) }
    await writeQueueDocument(world, { entries: [queueEntry({ targets: [{ kind: 'session', id: 'c' }] })], retained: [retainedOne, retainedTwo] })
    const engine = world.engine()
    const cancelled = await engine.deferredCancel({ entryIds: ['forget-me'] })
    assert.deepEqual(cancelled, { ok: true, cancelled: 1 })
    let document = await readQueueFile(world.deferredFile)
    assert.deepEqual(document.retained.map((record) => record.entry.id), ['keep-me'])
    assert.equal(document.entries.length, 1, 'active entries are untouched by a retained-only cancel')
    const all = await engine.deferredCancel({ all: true })
    assert.deepEqual(all, { ok: true, cancelled: 2 })
    document = await readQueueFile(world.deferredFile)
    assert.deepEqual(document.entries, [])
    assert.deepEqual(document.retained, [])
  })

  test('a retained entry survives a defer, an unrelated cancel, and a later requeue (all write paths)', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x' }, { id: 's2', content: 'y' }] })
    const engine = world.engine()
    // 1. Retain a failed entry through a startup run.
    await writeQueueDocument(world, { entries: [queueEntry({ targets: [{ kind: 'session', id: 'ghost-1' }] })] })
    resetDeferredMarker()
    assert.equal((await engine.runDeferred()).results[0].status, 'failed')
    let document = await readQueueFile(world.deferredFile)
    assert.equal(document.retained.length, 1)
    const retainedId = document.retained[0].entry.id
    // 2. A new defer must not wipe the retained list.
    assert.equal((await engine.defer({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' })).ok, true)
    document = await readQueueFile(world.deferredFile)
    assert.equal(document.retained.length, 1)
    assert.equal(document.retained[0].entry.id, retainedId)
    // 3. Cancelling the (unrelated) active entry must not wipe it either.
    const activeId = document.entries[0].id
    assert.deepEqual(await engine.deferredCancel({ entryIds: [activeId] }), { ok: true, cancelled: 1 })
    document = await readQueueFile(world.deferredFile)
    assert.equal(document.retained.length, 1)
    assert.equal(document.retained[0].entry.id, retainedId)
    // 4. A second startup run appends another retained entry and keeps the first.
    await writeQueueDocument(world, { entries: [queueEntry({ targets: [{ kind: 'session', id: 'ghost-2' }] })], retained: document.retained })
    resetDeferredMarker()
    await engine.runDeferred()
    document = await readQueueFile(world.deferredFile)
    assert.deepEqual(document.retained.map((record) => record.entry.id), [retainedId, document.retained[1].entry.id])
    const secondRetainedId = document.retained[1].entry.id
    // 5. Requeueing the first entry moves it into the active queue and keeps the second retained.
    const requeued = await engine.deferredRequeue({ entryIds: [retainedId] })
    assert.equal(requeued.ok, true)
    assert.equal(requeued.requeued, 1)
    document = await readQueueFile(world.deferredFile)
    assert.equal(document.entries.length, 1)
    assert.deepEqual(document.retained.map((record) => record.entry.id), [secondRetainedId])
  })
})

describe('queue claims and the chunked start-up run (SPEC §5.9)', () => {
  test('a recently claimed entry is skipped by the run and the queue stays intact', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x' }] })
    await writeQueueDocument(world, {
      entries: [queueEntry({ id: 'claimed', queuedAt: 1, inFlightAt: world.clock.now(), targets: [{ kind: 'session', id: 's1' }] })],
    })
    resetDeferredMarker()
    const outcome = await world.engine().runDeferred()
    assert.deepEqual(outcome, { ran: false, results: [] })
    await assertExists(world.dirOfSession('s1'), 'a claimed entry is not executed twice')
    const document = await readQueueFile(world.deferredFile)
    assert.equal(document.entries.length, 1)
    assert.equal(document.entries[0].id, 'claimed')
    const listed = await world.engine().deferredList()
    assert.equal(listed.ok, true)
    assert.equal(listed.deferred.entries.length, 1)
    assert.deepEqual((await world.engine().inventory()).deferred.count, 1)
  })

  test('a stale in-flight claim (older than 10 minutes) is retried and applied', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x' }] })
    const staleAt = world.clock.now() - 11 * 60_000
    await writeQueueDocument(world, {
      entries: [queueEntry({ id: 'stale', queuedAt: 1, inFlightAt: staleAt, targets: [{ kind: 'session', id: 's1' }] })],
    })
    resetDeferredMarker()
    const outcome = await world.engine().runDeferred()
    assert.equal(outcome.ran, true)
    assert.equal(outcome.results[0].status, 'trashed')
    await assertGone(world.dirOfSession('s1'))
    const document = await readQueueFile(world.deferredFile)
    assert.deepEqual(document.entries, [])
    assert.deepEqual(document.retained, [])
  })

  test('an entry deferred while the start-up run is executing survives for the next start', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x' }, { id: 's2', content: 'y' }] })
    const clock = makeClock(1_000_000)
    let releaseGate
    const gate = new Promise((resolve) => {
      releaseGate = resolve
    })
    let signalGateReached
    const gateReached = new Promise((resolve) => {
      signalGateReached = resolve
    })
    let gated = false
    const fsOps = {
      rename: async (from, to) => {
        if (!gated && String(from) === world.dirOfSession('s1')) {
          gated = true
          signalGateReached()
          await gate
        }
        return nodeFs.rename(from, to)
      },
    }
    const engine = world.engine({ now: clock.now, fsOps })
    await writeQueueDocument(world, {
      entries: [queueEntry({ id: 'pre-run-entry', queuedAt: 100, targets: [{ kind: 'session', id: 's1' }] })],
    })
    resetDeferredMarker()
    const runPromise = engine.runDeferred()
    await gateReached
    // A page reconnects while the run is mid-flight and queues new work.
    clock.set(2_000_000)
    const midRun = await engine.defer({ targets: [{ kind: 'session', id: 's2' }], mode: 'trash' })
    assert.equal(midRun.ok, true)
    releaseGate()
    const outcome = await runPromise
    assert.equal(outcome.ran, true)
    assert.equal(outcome.results.length, 1, 'only entries that existed when the run started are applied')
    assert.equal(outcome.results[0].entryId, 'pre-run-entry')
    await assertGone(world.dirOfSession('s1'), 'the pre-run entry is applied')
    await assertExists(world.dirOfSession('s2'), 'the mid-run entry is not touched')
    const document = await readQueueFile(world.deferredFile)
    assert.equal(document.entries.length, 1)
    assert.deepEqual(document.entries[0].targets, [{ kind: 'session', id: 's2' }])
    assert.deepEqual(document.retained, [])
    assert.equal(document.lastRun.results.length, 1)
    const startupRecords = (await readAudit(world)).filter((record) => record.action === 'startup-run')
    assert.equal(startupRecords.length, 1)
    assert.equal(startupRecords[0].applied, 1)
    assert.equal(startupRecords[0].skipped, 0)
    assert.equal(startupRecords[0].failed, 0)
    assert.equal((await engine.inventory()).deferred.count, 1)
  })
})

describe('state-file colocation (SPEC §3)', () => {
  test('default settings and audit files live next to a configured queue file', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x' }] })
    assert.equal(world.settingsFile, path.join(world.stateDir, 'settings.json'))
    assert.equal(world.auditFile, path.join(world.stateDir, 'audit.jsonl'))
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.equal((await engine.execute({ planId: plan.planId })).ok, true)
    assert.equal(await exists(world.auditFile), true, 'the audit log is colocated with the queue')
    assert.equal(path.dirname(world.auditFile), world.stateDir)
    assert.equal((await engine.settingsSet({ patch: { maxPlans: 9 } })).persisted, true)
    assert.equal(await exists(world.settingsFile), true, 'settings.json is colocated with the queue')
    assert.equal(path.dirname(world.settingsFile), world.stateDir)
    assert.ok(world.auditFile.startsWith(`${world.root}${path.sep}`), 'never the real profile home')
    assert.ok(world.settingsFile.startsWith(`${world.root}${path.sep}`), 'never the real profile home')
    assert.deepEqual((await readAudit(world)).map((record) => record.action), ['delete'])
  })

  test('explicit settingsFile/auditFile configuration overrides the colocated defaults', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x' }] })
    const customAudit = path.join(world.root, 'custom', 'audit.jsonl')
    const customSettings = path.join(world.root, 'custom', 'settings.json')
    const engine = world.engine({ config: { auditFile: customAudit, settingsFile: customSettings } })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.equal((await engine.execute({ planId: plan.planId })).ok, true)
    assert.equal(await exists(customAudit), true)
    assert.equal(await exists(world.auditFile), false)
    const set = await engine.settingsSet({ patch: { maxPlans: 9 } })
    assert.equal(set.persisted, true)
    assert.equal(await exists(customSettings), true)
    assert.equal(await exists(world.settingsFile), false)
  })
})

// #endregion

// #region Git safety probe (SPEC §4.8 gitSafetyCheck / §5.4) ---------------------------------

/** Run one Git command in an isolated test repository (identity via env, no user config). */
async function git(dir, args) {
  const { stdout } = await execFile('git', ['-C', dir, ...args], {
    timeout: 15_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'dsh-cleanup-test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'dsh-cleanup-test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      GIT_TERMINAL_PROMPT: '0',
    },
  })
  return String(stdout).trim()
}

/** Whether a usable git binary is on PATH (tests skip gracefully when it is not). */
let gitAvailableCache = null
async function gitAvailable() {
  if (gitAvailableCache === null) {
    try {
      await execFile('git', ['--version'], { timeout: 10_000 })
      gitAvailableCache = true
    } catch {
      gitAvailableCache = false
    }
  }
  return gitAvailableCache
}

/** Initialise a repository in one workspace directory and make the first commit. */
async function makeGitRepository(world, workspaceId) {
  const dir = world.dirOf(workspaceId)
  await git(dir, ['init'])
  await fsp.writeFile(path.join(dir, 'tracked.txt'), 'one\n')
  await git(dir, ['add', '--', '.'])
  await git(dir, ['commit', '-m', 'initial'])
  return dir
}

describe('Git safety probe (SPEC §4.8/§5.4)', () => {
  test('a dirty repository warns WORKSPACE_GIT_DIRTY with the change count and never blocks', async (t) => {
    if (!(await gitAvailable())) return t.skip('git is not available')
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const repo = await makeGitRepository(world, 'ws1')
    // One uncommitted modification plus one untracked file.
    await fsp.writeFile(path.join(repo, 'tracked.txt'), 'modified\n')
    await fsp.writeFile(path.join(repo, 'untracked.txt'), 'new\n')
    const plan = planOf(await world.engine().plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    const codes = plan.warnings.map((entry) => entry.code)
    assert.ok(codes.includes('WORKSPACE_HAS_GIT'), 'the cheap .git presence warning stays')
    const dirty = plan.warnings.find((entry) => entry.code === 'WORKSPACE_GIT_DIRTY')
    assert.ok(dirty, 'the dirty-work warning is missing')
    assert.equal(dirty.workspaceId, 'ws1')
    assert.match(dirty.message, /\b2\b/, 'the message names the changed/untracked count')
    // Warnings only: the plan stays executable and the item list is normal.
    assert.deepEqual(plan.blockers, [])
    const item = plan.items.find((candidate) => candidate.kind === 'workspace-dir')
    assert.ok(item !== undefined)
    assert.ok(item.files >= 2)
    assert.equal(plan.totals.workspaces, 1)
    assert.equal(plan.totals.sessions, 0)
  })

  test('a clean repository has WORKSPACE_HAS_GIT but no dirty or unpushed warning', async (t) => {
    if (!(await gitAvailable())) return t.skip('git is not available')
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    await makeGitRepository(world, 'ws1')
    const plan = planOf(await world.engine().plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    const codes = plan.warnings.map((entry) => entry.code)
    assert.ok(codes.includes('WORKSPACE_HAS_GIT'))
    assert.equal(codes.includes('WORKSPACE_GIT_DIRTY'), false)
    assert.equal(codes.includes('WORKSPACE_GIT_UNPUSHED'), false, 'a repository without a remote has nothing to compare')
  })

  test('commits not on any remote warn WORKSPACE_GIT_UNPUSHED with the count', async (t) => {
    if (!(await gitAvailable())) return t.skip('git is not available')
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const repo = await makeGitRepository(world, 'ws1')
    // A bare remote elsewhere, with the first commit pushed.
    const bareRemote = path.join(world.root, 'origin.git')
    await fsp.mkdir(bareRemote, { recursive: true })
    await git(bareRemote, ['init', '--bare'])
    await git(repo, ['remote', 'add', 'origin', bareRemote])
    const branch = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    await git(repo, ['push', '-u', 'origin', branch])
    // One additional local-only commit.
    await fsp.writeFile(path.join(repo, 'second.txt'), 'two\n')
    await git(repo, ['add', '--', 'second.txt'])
    await git(repo, ['commit', '-m', 'second'])
    const plan = planOf(await world.engine().plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    const codes = plan.warnings.map((entry) => entry.code)
    assert.equal(codes.includes('WORKSPACE_GIT_DIRTY'), false, 'the working tree is clean')
    const unpushed = plan.warnings.find((entry) => entry.code === 'WORKSPACE_GIT_UNPUSHED')
    assert.ok(unpushed, 'the unpushed-commit warning is missing')
    assert.match(unpushed.message, /\b1\b/, 'the message names the unpushed commit count')
    assert.deepEqual(plan.blockers, [])
  })

  test('gitSafetyCheck:false keeps WORKSPACE_HAS_GIT but skips both detail probes', async (t) => {
    if (!(await gitAvailable())) return t.skip('git is not available')
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const repo = await makeGitRepository(world, 'ws1')
    await fsp.writeFile(path.join(repo, 'tracked.txt'), 'dirty\n')
    const enabledCodes = planOf(await world.engine().plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
      .warnings.map((entry) => entry.code)
    assert.ok(enabledCodes.includes('WORKSPACE_GIT_DIRTY'), 'the default is enabled')
    const mutedCodes = planOf(
      await world.engine({ config: { gitSafetyCheck: false } }).plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }),
    ).warnings.map((entry) => entry.code)
    assert.ok(mutedCodes.includes('WORKSPACE_HAS_GIT'), 'the cheap presence warning is independent of the setting')
    assert.equal(mutedCodes.includes('WORKSPACE_GIT_DIRTY'), false)
    assert.equal(mutedCodes.includes('WORKSPACE_GIT_UNPUSHED'), false)
  })

  test('a non-repository directory plans normally without any Git warning', async (t) => {
    if (!(await gitAvailable())) return t.skip('git is not available')
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'a.txt': 'x' } }] })
    const plan = planOf(await world.engine().plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.deepEqual(plan.warnings.map((entry) => entry.code).filter((code) => code.startsWith('WORKSPACE_GIT')), [])
    assert.deepEqual(plan.blockers, [])
    assert.equal(plan.items.filter((item) => item.kind === 'workspace-dir').length, 1)
  })

  test('inventory never spawns git; only plan() runs the read-only probe', { skip: process.platform === 'win32' }, async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'a.txt': 'x' } }] })
    // A .git marker makes hasGit true without needing a real repository, plus a fake git that records calls.
    await fsp.mkdir(path.join(world.dirOf('ws1'), '.git'), { recursive: true })
    const fakeBin = path.join(world.root, 'fake-bin')
    await fsp.mkdir(fakeBin, { recursive: true })
    const marker = path.join(world.root, 'git-invocations.txt')
    await fsp.writeFile(path.join(fakeBin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${marker}'\nexit 1\n`, { mode: 0o755 })
    const savedPath = process.env.PATH
    process.env.PATH = fakeBin
    try {
      const engine = world.engine()
      const inventory = await engine.inventory()
      assert.equal(inventory.workspaces[0].hasGit, true)
      assert.equal(await exists(marker), false, 'inventory must stay cheap and never run git')
      const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
      assert.equal(await exists(marker), true, 'plan() runs the advisory probe')
      assert.deepEqual(plan.warnings.map((entry) => entry.code).filter((code) => code.startsWith('WORKSPACE_GIT')), [], 'a failing/missing git is silently skipped')
      assert.deepEqual(plan.blockers, [])
    } finally {
      process.env.PATH = savedPath
    }
  })

  test('gitSafetyCheck is a live setting: set(false) mutes later plans and its type is validated', async (t) => {
    if (!(await gitAvailable())) return t.skip('git is not available')
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const repo = await makeGitRepository(world, 'ws1')
    await fsp.writeFile(path.join(repo, 'tracked.txt'), 'dirty\n')
    const engine = world.engine()
    const before = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.ok(before.warnings.some((entry) => entry.code === 'WORKSPACE_GIT_DIRTY'))
    const set = await engine.settingsSet({ patch: { gitSafetyCheck: false } })
    assert.equal(set.ok, true)
    assert.equal(set.settings.gitSafetyCheck, false)
    assert.equal((await engine.settingsGet()).settings.gitSafetyCheck, false)
    const after = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    const details = after.warnings.map((entry) => entry.code).filter((code) => code === 'WORKSPACE_GIT_DIRTY' || code === 'WORKSPACE_GIT_UNPUSHED')
    assert.deepEqual(details, [], 'the runtime setting disables the detail probes')
    assert.ok(after.warnings.some((entry) => entry.code === 'WORKSPACE_HAS_GIT'))
    for (const invalid of ['yes', 1, null]) {
      const response = await engine.settingsSet({ patch: { gitSafetyCheck: invalid } })
      assert.equal(response.ok, false, JSON.stringify(invalid))
      assert.equal(response.error.code, 'BAD_REQUEST')
      assert.equal(response.error.details.field, 'gitSafetyCheck')
    }
  })
})

// #endregion

// #region cleanup wizard candidates (SPEC §4.9) -----------------------------------------------

describe('cleanup wizard candidates (SPEC §4.9)', () => {
  /** Sessions used by most candidate tests: mixed ages, sizes, origins, archive/live state. */
  async function makeCandidateWorld(spec = {}) {
    const now = 40 * 86_400_000
    const world = await makeWorld({
      startClock: now,
      workspaces: [
        { id: 'ws1', sessionIds: ['sOld'] },
        { id: 'wsEmpty', sessionIds: [] },
      ],
      sessions: [
        { id: 'sOld', createdAt: now - 10 * 86_400_000, sizeBytes: 200 },
        { id: 'sRecent', createdAt: now - 2 * 86_400_000, sizeBytes: 50 },
        { id: 'sUnknown', createdAt: 0, sizeBytes: 100 },
        { id: 'sArchived', createdAt: now - 5 * 86_400_000, sizeBytes: 10 },
        { id: 'sSubagent', createdAt: now - 20 * 86_400_000, sizeBytes: 150, origin: 'subagent', parentSession: 'sOld' },
        { id: 'sImplicitRoot', createdAt: now - 30 * 86_400_000, sizeBytes: 25 },
        { id: 'sNoSize', createdAt: now - 40 * 86_400_000 },
      ],
      archived: ['sArchived'],
      live: ['sRecent'],
      ...spec,
    })
    const archivedSnapshot = world.snapshot('sArchived')
    if (archivedSnapshot !== undefined) archivedSnapshot.header.cwd = world.dirOf('wsEmpty')
    return { world, now }
  }

  test('defaults: all sessions, oldest-first with unknown createdAt last, exact shapes and totals', async () => {
    const world = await makeWorld({
      workspaces: [{ id: 'ws1', sessionIds: ['s1'] }],
      sessions: [
        { id: 's1', createdAt: 3000, sizeBytes: 100 },
        { id: 's2', createdAt: 1000, sizeBytes: 50 },
        { id: 's3', createdAt: 0 },
        { id: 's4', createdAt: 2000, sizeBytes: 25 },
      ],
      archived: ['s4'],
      pinned: ['s1'],
      live: ['s2'],
    })
    const response = await world.engine().candidates({})
    assert.equal(response.ok, true)
    assert.deepEqual(Object.keys(response).sort(), ['candidates', 'filters', 'ok', 'sort', 'total', 'totals', 'truncated'])
    assert.deepEqual(response.filters, {
      olderThanDays: 0,
      archived: 'all',
      minBytes: 0,
      workspaceId: null,
      origin: 'all',
      requireDeletable: false,
    })
    assert.equal(response.sort, 'oldest')
    assert.equal(response.total, 4)
    assert.equal(response.truncated, false)
    // Known sizes only: 100 + 50 + 25; the session with an unknown size contributes nothing.
    assert.deepEqual(response.totals, { count: 4, bytes: 175 })
    // createdAt 0 (unknown) must sort LAST, never as the oldest.
    assert.deepEqual(response.candidates.map((candidate) => candidate.id), ['s2', 's4', 's1', 's3'])
    for (const candidate of response.candidates) {
      assert.deepEqual(Object.keys(candidate).sort(), [
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
    }
    const byId = new Map(response.candidates.map((candidate) => [candidate.id, candidate]))
    assert.equal(byId.get('s1').workspaceId, 'ws1')
    assert.equal(byId.get('s1').pinned, true)
    assert.equal(byId.get('s2').live, true)
    assert.equal(byId.get('s2').deletable, false)
    assert.deepEqual(byId.get('s2').blockerCodes, ['SESSION_LIVE'])
    assert.equal(byId.get('s3').createdAt, 0)
    assert.equal(byId.get('s3').sizeBytes, null)
    assert.equal(byId.get('s4').archived, true)
  })

  test('olderThanDays: measured from createdAt; unknown/future creation times never match', async () => {
    const baseNow = 40 * 86_400_000
    const { world } = await makeCandidateWorld({
      sessions: [
        { id: 'sOld', createdAt: baseNow - 10 * 86_400_000, sizeBytes: 200 },
        { id: 'sRecent', createdAt: baseNow - 2 * 86_400_000, sizeBytes: 50 },
        { id: 'sUnknown', createdAt: 0, sizeBytes: 100 },
        { id: 'sFuture', createdAt: baseNow + 86_400_000, sizeBytes: 75 },
      ],
    })
    const response = await world.engine().candidates({ filters: { olderThanDays: 5 } })
    assert.deepEqual(response.candidates.map((candidate) => candidate.id), ['sOld'])
    assert.equal(response.total, 1)
    const boundary = await world.engine().candidates({ filters: { olderThanDays: 10 } })
    assert.deepEqual(boundary.candidates.map((candidate) => candidate.id), ['sOld'], 'the age bound is inclusive')
    const zero = await world.engine().candidates({ filters: { olderThanDays: 0 } })
    assert.equal(zero.total, 4, '0 disables the age filter')
  })

  test('archived all/only/exclude and minBytes (unknown size never matches a positive bound)', async () => {
    const { world } = await makeCandidateWorld()
    const engine = world.engine()
    assert.equal((await engine.candidates({ filters: { archived: 'all' } })).total, 7)
    assert.deepEqual(
      (await engine.candidates({ filters: { archived: 'only' } })).candidates.map((candidate) => candidate.id),
      ['sArchived'],
    )
    const excluded = await engine.candidates({ filters: { archived: 'exclude' } })
    assert.equal(excluded.total, 6)
    assert.equal(excluded.candidates.some((candidate) => candidate.id === 'sArchived'), false)
    const sized = await engine.candidates({ filters: { minBytes: 100 } })
    assert.deepEqual(sized.candidates.map((candidate) => candidate.id).sort(), ['sOld', 'sSubagent', 'sUnknown'])
    assert.equal(sized.candidates.some((candidate) => candidate.id === 'sNoSize'), false, 'an unknown size is not a match')
    const exact = await engine.candidates({ filters: { minBytes: 25 } })
    assert.ok(exact.candidates.some((candidate) => candidate.id === 'sImplicitRoot'), 'the bound is inclusive')
    assert.equal((await engine.candidates({ filters: { minBytes: 0 } })).total, 7)
  })

  test('workspaceId, origin and requireDeletable filters, plus combinations', async () => {
    const { world } = await makeCandidateWorld()
    const engine = world.engine()
    assert.deepEqual(
      (await engine.candidates({ filters: { workspaceId: 'ws1' } })).candidates.map((candidate) => candidate.id),
      ['sOld'],
    )
    const emptyWorkspace = await engine.candidates({ filters: { workspaceId: 'wsEmpty' } })
    assert.deepEqual(emptyWorkspace.candidates, [])
    assert.equal(emptyWorkspace.total, 0)
    assert.equal((await engine.candidates({ filters: { workspaceId: 'nope' } })).total, 0)
    assert.deepEqual(
      (await engine.candidates({ filters: { origin: 'subagent' } })).candidates.map((candidate) => candidate.id),
      ['sSubagent'],
    )
    const roots = await engine.candidates({ filters: { origin: 'root' } })
    assert.equal(roots.total, 6)
    assert.equal(roots.candidates.some((candidate) => candidate.id === 'sSubagent'), false)
    const deletable = await engine.candidates({ filters: { requireDeletable: true } })
    assert.equal(deletable.candidates.some((candidate) => candidate.id === 'sRecent'), false, 'a live session is not deletable')
    assert.equal(deletable.total, 6)
    const combined = await engine.candidates({
      filters: { olderThanDays: 5, archived: 'exclude', minBytes: 25, origin: 'root', requireDeletable: true },
    })
    assert.deepEqual(combined.candidates.map((candidate) => candidate.id), ['sImplicitRoot', 'sOld'])
    assert.equal(combined.total, 2)
    assert.deepEqual(combined.filters, {
      olderThanDays: 5,
      archived: 'exclude',
      minBytes: 25,
      workspaceId: null,
      origin: 'root',
      requireDeletable: true,
    })
  })

  test('sort:largest orders by known size (unknown last, id tie-break); limit truncates but totals cover all matches', async () => {
    const now = 40 * 86_400_000
    const world = await makeWorld({
      startClock: now,
      sessions: [
        { id: 'la', createdAt: now - 5 * 86_400_000, sizeBytes: 500 },
        { id: 'lb', createdAt: now - 4 * 86_400_000, sizeBytes: 100 },
        { id: 'lc', createdAt: now - 3 * 86_400_000 },
        { id: 'ld', createdAt: now - 2 * 86_400_000, sizeBytes: 100 },
        { id: 'le', createdAt: now - 86_400_000, sizeBytes: 300 },
      ],
    })
    const engine = world.engine()
    const largest = await engine.candidates({ sort: 'largest' })
    assert.deepEqual(largest.candidates.map((candidate) => candidate.id), ['la', 'le', 'lb', 'ld', 'lc'])
    assert.equal(largest.sort, 'largest')
    const limited = await engine.candidates({ sort: 'largest', limit: 2 })
    assert.deepEqual(limited.candidates.map((candidate) => candidate.id), ['la', 'le'])
    assert.equal(limited.truncated, true)
    assert.equal(limited.total, 5)
    assert.deepEqual(limited.totals, { count: 5, bytes: 1000 }, 'totals cover all matches, not just the page')
    const oldestLimited = await engine.candidates({ limit: 1 })
    assert.deepEqual(oldestLimited.candidates.map((candidate) => candidate.id), ['la'])
    assert.equal(oldestLimited.truncated, true)
    assert.deepEqual(oldestLimited.totals, { count: 5, bytes: 1000 })
  })

  test('validates every documented bound and reports details.field exactly', async () => {
    const world = await makeWorld({})
    const engine = world.engine()
    const cases = [
      [{ filters: { olderThanDays: -1 } }, 'filters.olderThanDays'],
      [{ filters: { olderThanDays: 3651 } }, 'filters.olderThanDays'],
      [{ filters: { olderThanDays: 1.5 } }, 'filters.olderThanDays'],
      [{ filters: { olderThanDays: '5' } }, 'filters.olderThanDays'],
      [{ filters: { archived: 'some' } }, 'filters.archived'],
      [{ filters: { minBytes: -1 } }, 'filters.minBytes'],
      [{ filters: { minBytes: 1.5 } }, 'filters.minBytes'],
      [{ filters: { workspaceId: '' } }, 'filters.workspaceId'],
      [{ filters: { workspaceId: 42 } }, 'filters.workspaceId'],
      [{ filters: { origin: 'x' } }, 'filters.origin'],
      [{ filters: { requireDeletable: 'yes' } }, 'filters.requireDeletable'],
      [{ sort: 'newest' }, 'sort'],
      [{ limit: 0 }, 'limit'],
      [{ limit: 501 }, 'limit'],
      [{ limit: 1.5 }, 'limit'],
      [{ filters: { nope: 1 } }, 'filters.nope'],
      [{ nope: 1 }, 'nope'],
    ]
    for (const [body, field] of cases) {
      const response = await engine.candidates(body)
      assert.equal(response.ok, false, JSON.stringify(body))
      assert.equal(response.error.code, 'BAD_REQUEST', JSON.stringify(body))
      assert.equal(response.error.details?.field, field, JSON.stringify(body))
    }
    for (const body of ['x', 42, [], true]) {
      const response = await engine.candidates(body)
      assert.equal(response.ok, false, JSON.stringify(body))
      assert.equal(response.error.code, 'BAD_REQUEST', JSON.stringify(body))
    }
    assert.equal((await engine.candidates({ filters: 'x' })).error.code, 'BAD_REQUEST')
    assert.equal((await engine.candidates(undefined)).ok, true, 'an absent body is the default preview')
    assert.equal((await engine.candidates(null)).ok, true)
  })

  test('is read-only, reads the persistence listing once, and reflects a session removed between calls', async () => {
    const world = await makeWorld({
      workspaces: [{ id: 'ws1', sessionIds: ['s1'] }],
      sessions: [{ id: 's1', createdAt: 1 }, { id: 's2', createdAt: 2 }, { id: 's3', createdAt: 3 }],
    })
    const counters = { list: 0 }
    const engine = world.engine({
      sessionPersistence: {
        list: async () => {
          counters.list += 1
          return [...world.snapshots.values()]
        },
        stat: async (id) => world.snapshots.get(id),
      },
    })
    const first = await engine.candidates({})
    assert.equal(first.total, 3)
    assert.equal(counters.list, 1, 'one inventory snapshot serves the whole preview')
    // No destructive or registry side effects.
    assert.deepEqual(world.registryCalls, [])
    assert.deepEqual(await trashEntries(world), [])
    assert.equal(await exists(world.deferredFile), false)
    await assertExists(world.dirOfSession('s2'), 'candidates never deletes logs')
    // A session removed between two calls disappears from the second preview.
    world.snapshots.delete('s2')
    const second = await engine.candidates({})
    assert.deepEqual(second.candidates.map((candidate) => candidate.id).sort(), ['s1', 's3'])
    assert.equal(second.total, 2)
    assert.equal(counters.list, 2, 'each preview reads one fresh listing')
  })

  test('an empty world answers the exact empty envelope', async () => {
    const world = await makeWorld({})
    const response = await world.engine().candidates({})
    assert.deepEqual(response, {
      ok: true,
      candidates: [],
      total: 0,
      truncated: false,
      totals: { count: 0, bytes: 0 },
      filters: {
        olderThanDays: 0,
        archived: 'all',
        minBytes: 0,
        workspaceId: null,
        origin: 'all',
        requireDeletable: false,
      },
      sort: 'oldest',
    })
  })
})

// #endregion

// #region preview cache (SPEC §5.10) -----------------------------------------------------------

describe('preview cache (SPEC §5.10)', () => {
  /** Wrap readdir so a test can count directory walks. */
  function countingFsOps(counter) {
    return {
      readdir: async (...args) => {
        counter.walks += 1
        return nodeFs.readdir(...args)
      },
    }
  }

  test('measure serves the same walk within 30 s and re-walks after the TTL', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'a.txt': 'abc', 'sub/b.txt': 'defg' } }] })
    const clock = makeClock(1_000_000)
    const counter = { walks: 0 }
    const engine = world.engine({ fsOps: countingFsOps(counter), now: clock.now })
    const first = await engine.measure({ workspaceIds: ['ws1'] })
    assert.equal(first.ok, true)
    const firstWalks = counter.walks
    assert.ok(firstWalks > 0)
    const second = await engine.measure({ workspaceIds: ['ws1'] })
    assert.deepEqual(second, first, 'the cached preview is byte-identical')
    assert.equal(counter.walks, firstWalks, 'no second walk inside the 30 s window')
    clock.advance(30_001)
    const third = await engine.measure({ workspaceIds: ['ws1'] })
    assert.deepEqual(third, first)
    assert.ok(counter.walks > firstWalks, 'the cache expires after 30 s')
  })

  test('a replaced directory (new device/inode) is never served from the cache', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'old.txt': '1234567' } }] })
    const counter = { walks: 0 }
    const engine = world.engine({ fsOps: countingFsOps(counter) })
    const warm = await engine.measure({ workspaceIds: ['ws1'] })
    assert.equal(warm.workspaces.ws1.bytes, 7)
    const walksAfterWarm = counter.walks
    // Replace the directory in place: move the reviewed one aside so its inode cannot be reused.
    const directory = world.dirOf('ws1')
    await fsp.rename(directory, path.join(world.root, 'old-moved-away'))
    await fsp.mkdir(directory, { recursive: true })
    await fsp.writeFile(path.join(directory, 'new.txt'), '1234')
    const refreshed = await engine.measure({ workspaceIds: ['ws1'] })
    assert.ok(counter.walks > walksAfterWarm, 'the replaced directory triggers a fresh walk')
    assert.equal(refreshed.workspaces.ws1.bytes, 4, 'the new directory is measured, not the cached old one')
    assert.equal(refreshed.workspaces.ws1.files, 1)
  })

  test('a deletion mutation clears the preview cache', async () => {
    const world = await makeWorld({
      workspaces: [{ id: 'ws1', files: { 'a.txt': 'abc' } }],
      sessions: [{ id: 's1', content: 'x' }],
    })
    const counter = { walks: 0 }
    const engine = world.engine({ fsOps: countingFsOps(counter) })
    const warm = await engine.measure({ workspaceIds: ['ws1'] })
    assert.equal(warm.workspaces.ws1.bytes, 3)
    const walksAfterWarm = counter.walks
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.equal((await engine.execute({ planId: plan.planId })).ok, true)
    // Count only the preview walk (the plan/execute above walk the session directory too).
    counter.walks = 0
    const after = await engine.measure({ workspaceIds: ['ws1'] })
    assert.ok(counter.walks > 0, 'execute() clears the cache, so the next preview walks again')
    assert.deepEqual(after, warm)
  })

  test('a warm preview never feeds the deletion path: real on-disk bytes win', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'a.txt': 'hello' } }] })
    const counter = { walks: 0 }
    const engine = world.engine({ fsOps: countingFsOps(counter) })
    const warm = await engine.measure({ workspaceIds: ['ws1'] })
    assert.equal(warm.workspaces.ws1.bytes, 5)
    // Grow the file after warming the preview: plan/execute must report the real size.
    await fsp.writeFile(path.join(world.dirOf('ws1'), 'a.txt'), 'hello world!!')
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    const item = plan.items.find((candidate) => candidate.kind === 'workspace-dir')
    assert.equal(item.bytes, 13, 'the plan measures the real files, not the cached preview')
    const executed = await engine.execute({ planId: plan.planId })
    assert.equal(executed.ok, true)
    assert.equal(executed.result.items[0].bytes, 13, 'the executed result reports the bytes really removed')
    assert.deepEqual(executed.result.totals, { trashed: 1, deleted: 0, failed: 0, bytes: 13 })
  })

  test('the cache is per engine instance and keys distinct workspace paths separately', async () => {
    const world = await makeWorld({
      workspaces: [
        { id: 'ws1', files: { 'a.txt': 'abc' } },
        { id: 'ws2', files: { 'b.txt': 'defg' } },
      ],
    })
    const counter = { walks: 0 }
    const firstEngine = world.engine({ fsOps: countingFsOps(counter) })
    const twoPaths = await firstEngine.measure({ workspaceIds: ['ws1', 'ws2'] })
    assert.ok(counter.walks >= 2, 'two distinct workspace paths are walked separately')
    const walksAfterBoth = counter.walks
    await firstEngine.measure({ workspaceIds: ['ws1'] })
    assert.equal(counter.walks, walksAfterBoth, 'the same engine reuses both cached entries')
    // A second engine instance has its own cache: a hot reload must re-walk rather than trust memory.
    const secondEngine = world.engine({ fsOps: countingFsOps(counter) })
    const fresh = await secondEngine.measure({ workspaceIds: ['ws1'] })
    assert.ok(counter.walks > walksAfterBoth, 'a new engine instance starts with an empty cache')
    assert.deepEqual(fresh, { ok: true, workspaces: { ws1: twoPaths.workspaces.ws1 }, sessions: {} })
  })
})

// #endregion

// #region release hardening (0.4.0) ---------------------------------------------------------

describe('release hardening: cross-process liveness (SPEC §5.2)', () => {
  /** A persistence fake whose write claim is held by "another process". */
  function heldPersistence(world, counters = { opens: 0 }) {
    const ownershipError = new Error('session is already owned by another process')
    ownershipError.name = 'SessionAlreadyOwnedError'
    return {
      list: async () => [...world.snapshots.values()],
      stat: async (id) => world.snapshots.get(id),
      open: async () => {
        counters.opens += 1
        throw ownershipError
      },
    }
  }

  test('an explicit target held by another process is a plan blocker and execute mutates nothing', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'log\n' }] })
    const counters = { opens: 0 }
    const engine = world.engine({ sessionPersistence: heldPersistence(world, counters) })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.deepEqual(plan.blockers.map((entry) => entry.code), ['SESSION_LIVE'])
    assert.equal(counters.opens, 1, 'the explicit plan target is probed once')
    const response = await engine.execute({ planId: plan.planId })
    assertFail(response, 'STATE_CHANGED')
    assert.equal(response.error.details.reasons.find((entry) => entry.code === 'SESSION_LIVE')?.sessionId, 's1')
    await assertExists(world.dirOfSession('s1'), 'the live log is left alone')
    assert.deepEqual(await trashEntries(world), [])
    assert.deepEqual(world.registryCalls, [], 'a blocked plan drops no registry sets')
  })

  test('a swept-in session held by another process fails alone at execution and its log survives', async () => {
    const world = await makeWorld({
      workspaces: [{ id: 'ws1', files: { 'a.txt': 'x' } }],
      sessions: [{ id: 's1', content: 'log\n' }],
    })
    world.snapshot('s1').header.cwd = world.dirOf('ws1')
    const counters = { opens: 0 }
    const engine = world.engine({ sessionPersistence: heldPersistence(world, counters) })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash' }))
    assert.deepEqual(plan.blockers, [], 'swept-in sessions are probed at execution, not at planning')
    const response = await engine.execute({ planId: plan.planId })
    assert.equal(response.ok, true)
    const byId = new Map(response.result.items.map((item) => [item.id, item]))
    assert.equal(byId.get('ws1').status, 'trashed')
    assert.equal(byId.get('s1').status, 'failed')
    assert.equal(byId.get('s1').error.code, 'SESSION_LIVE')
    assert.equal(counters.opens, 1, 'one probe for the one swept session item')
    await assertExists(world.dirOfSession('s1'), 'the log is left alone')
  })

  test('a probe error other than ownership fails closed as IO_ERROR', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'log\n' }] })
    const engine = world.engine({
      sessionPersistence: {
        list: async () => [...world.snapshots.values()],
        stat: async (id) => world.snapshots.get(id),
        open: async () => {
          throw new Error('the persistence store is wedged')
        },
      },
    })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.deepEqual(plan.blockers.map((entry) => entry.code), ['IO_ERROR'])
    assertFail(await engine.execute({ planId: plan.planId }), 'STATE_CHANGED')
    await assertExists(world.dirOfSession('s1'))
  })

  test('a backend without open() keeps the in-process behavior', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'log\n' }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.deepEqual(plan.blockers, [])
    const response = await engine.execute({ planId: plan.planId })
    assert.equal(response.ok, true)
    assert.equal(response.result.items[0].status, 'trashed')
  })
})

describe('release hardening: trash entry ownership (SPEC §5.7)', () => {
  test('a foreign directory under trashRoot is ignored and survives list/restore/purge-all', async () => {
    const world = await makeWorld({})
    const foreign = path.join(world.trashRoot, 'foreign', 'sub')
    await fsp.mkdir(foreign, { recursive: true })
    await fsp.writeFile(path.join(world.trashRoot, 'foreign', 'keep.txt'), 'keep me')
    const engine = world.engine()
    assert.deepEqual((await engine.trashList()).entries, [])
    assert.equal((await engine.inventory()).trash.entries, 0)
    assertFail(await engine.trashRestore({ entryId: 'foreign' }), 'TRASH_ENTRY_UNKNOWN')
    assert.deepEqual(await engine.trashPurge({ all: true }), { ok: true, purged: 0, bytes: 0 })
    assert.equal(await fsp.readFile(path.join(world.trashRoot, 'foreign', 'keep.txt'), 'utf8'), 'keep me')
  })

  test('a moved entry carries the ownership marker and is purgeable', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'a.txt': 'hello' } }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.equal((await engine.execute({ planId: plan.planId })).ok, true)
    const [entry] = await trashEntries(world)
    const markerStat = await fsp.stat(path.join(entry.entryDir, '.dsh-cleanup-entry'))
    assert.equal(markerStat.mode & 0o777, 0o600, 'the ownership marker is owner-only')
    assert.equal((await engine.trashList()).entries.length, 1)
    assert.deepEqual(await engine.trashPurge({ all: true }), { ok: true, purged: 1, bytes: 5 })
    await assertGone(entry.entryDir)
  })

  test('a legacy 0.3.0 metadata-only entry stays listed and purgeable', async () => {
    const world = await makeWorld({})
    const entryDir = await writeTrashEntry(world, 'legacy-entry', { bytes: 5 })
    await fsp.mkdir(path.join(entryDir, 'payload'), { recursive: true })
    await fsp.writeFile(path.join(entryDir, 'payload', 'a.txt'), 'hello')
    await assertGone(path.join(entryDir, '.dsh-cleanup-entry'))
    const engine = world.engine()
    const entries = (await engine.trashList()).entries
    assert.deepEqual(entries.map((entry) => entry.id), ['legacy-entry'])
    assert.deepEqual(await engine.trashPurge({ all: true }), { ok: true, purged: 1, bytes: 5 })
  })

  test('purge-all removes owned entries but leaves a foreign directory alone', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'a.txt': 'hello' } }] })
    await fsp.mkdir(path.join(world.trashRoot, 'not-ours'), { recursive: true })
    await fsp.writeFile(path.join(world.trashRoot, 'not-ours', 'keep.txt'), 'keep')
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    assert.equal((await engine.execute({ planId: plan.planId })).ok, true)
    assert.deepEqual(await engine.trashPurge({ all: true }), { ok: true, purged: 1, bytes: 5 })
    await assertExists(path.join(world.trashRoot, 'not-ours', 'keep.txt'), 'the foreign directory is untouched')
    assert.deepEqual((await engine.trashList()).entries, [])
  })
})

describe('release hardening: queue and execution bounds (SPEC §5.5/§5.6/§5.8)', () => {
  beforeEach(resetDeferredMarker)
  afterEach(resetDeferredMarker)

  test('requeue refuses to overflow the active queue instead of evicting the oldest entry', async () => {
    const world = await makeWorld({})
    const entries = []
    for (let index = 0; index < 100; index += 1) entries.push(queueEntry({ targets: [{ kind: 'session', id: `queued-${index}` }] }))
    const retained = [{
      at: 5,
      status: 'skipped',
      code: 'SESSION_LIVE',
      reason: 'held live',
      entry: queueEntry({ targets: [{ kind: 'session', id: 'retained-1' }] }),
    }]
    await writeQueueDocument(world, { entries, retained })
    const engine = world.engine()
    assertFail(await engine.deferredRequeue({ all: true }), 'DEFERRED_FULL')
    const document = await readQueueFile(world.deferredFile)
    assert.equal(document.entries.length, 100)
    assert.equal(document.entries[0].id, entries[0].id, 'no queued entry was evicted')
    assert.equal(document.retained.length, 1, 'the retained list is unchanged')
  })

  test('a dead start-up run claim is taken over instead of silently skipping the queue', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x' }] })
    await writeQueueFile(world.deferredFile, [queueEntry({ targets: [{ kind: 'session', id: 's1' }] })])
    // A crash leaves the claim behind; the pid no longer exists.
    await fsp.writeFile(`${world.deferredFile}.run.lock`, `${JSON.stringify({ pid: 999999999, at: world.clock.now() })}\n`)
    const engine = world.engine()
    const outcome = await engine.runDeferred()
    assert.equal(outcome.ran, true)
    assert.equal(outcome.results[0].status, 'trashed')
    await assertGone(`${world.deferredFile}.run.lock`)
    await assertGone(world.dirOfSession('s1'))
  })

  test('a live run claim keeps the queue for the other process', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x' }] })
    await writeQueueFile(world.deferredFile, [queueEntry({ targets: [{ kind: 'session', id: 's1' }] })])
    await fsp.writeFile(`${world.deferredFile}.run.lock`, `${JSON.stringify({ pid: process.pid, at: world.clock.now() })}\n`)
    const engine = world.engine()
    const outcome = await engine.runDeferred()
    assert.equal(outcome.ran, false)
    assert.equal(outcome.busy, true)
    await assertExists(world.dirOfSession('s1'), 'the other process still owns the run')
    await assertExists(`${world.deferredFile}.run.lock`, 'the live claim is kept')
  })

  test('an aged run claim held by a live process is still respected', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x' }] })
    await writeQueueFile(world.deferredFile, [queueEntry({ targets: [{ kind: 'session', id: 's1' }] })])
    const claimPath = `${world.deferredFile}.run.lock`
    const elevenMinutesAgo = Date.now() - 11 * 60_000
    await fsp.writeFile(claimPath, JSON.stringify({ pid: process.pid, at: elevenMinutesAgo }))
    const old = new Date(elevenMinutesAgo)
    await fsp.utimes(claimPath, old, old)
    const engine = world.engine()
    const outcome = await engine.runDeferred()
    assert.equal(outcome.ran, false)
    assert.equal(outcome.busy, true)
    await assertExists(world.dirOfSession('s1'), 'a live owner may run past the stale window')
    await assertExists(claimPath)
  })

  test('an aged claim without a usable pid is taken over', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x' }] })
    await writeQueueFile(world.deferredFile, [queueEntry({ targets: [{ kind: 'session', id: 's1' }] })])
    const claimPath = `${world.deferredFile}.run.lock`
    await fsp.writeFile(claimPath, '') // crash between create and write
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60_000)
    await fsp.utimes(claimPath, elevenMinutesAgo, elevenMinutesAgo)
    // Real wall clock, so the claim file's mtime age is comparable to `now()`.
    const engine = world.engine({ now: Date.now })
    const outcome = await engine.runDeferred()
    assert.equal(outcome.ran, true)
    assert.equal(outcome.results[0].status, 'trashed')
    await assertGone(claimPath)
  })

  test('one plan may sweep at most 1000 session logs', async () => {
    const sessions = []
    for (let index = 0; index < 1001; index += 1) sessions.push({ id: `s${index}`, unborn: true })
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }], sessions })
    const workspaceDir = world.dirOf('ws1')
    for (const snapshot of world.snapshots.values()) snapshot.header.cwd = workspaceDir
    const engine = world.engine()
    const response = await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash' })
    assertFail(response, 'BAD_REQUEST')
    assert.match(response.error.message, /1000-session limit/)
    assert.equal(response.error.details.sessionCount, 1001)
  })

  test('concurrent executions serialize and the loser reports STATE_CHANGED', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'a.txt': 'x' } }] })
    const engine = world.engine()
    const first = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    const second = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    const [left, right] = await Promise.all([
      engine.execute({ planId: first.planId }),
      engine.execute({ planId: second.planId }),
    ])
    const outcomes = [left, right].map((response) => (response.ok ? 'trashed' : response.error.code)).sort()
    assert.deepEqual(outcomes, ['STATE_CHANGED', 'trashed'])
    await assertGone(world.dirOf('ws1'))
    assert.equal((await trashEntries(world)).length, 1, 'the target is trashed exactly once')
  })

  test('an aborted execute deletes nothing and answers CANCELLED', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'a.txt': 'x' } }] })
    const engine = world.engine()
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    const controller = new AbortController()
    controller.abort()
    assertFail(await engine.execute({ planId: plan.planId }, { signal: controller.signal }), 'CANCELLED')
    await assertExists(world.dirOf('ws1'), 'nothing is deleted')
    assert.deepEqual(await trashEntries(world), [])
  })

  test('an aborted plan answers CANCELLED', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1' }] })
    const engine = world.engine()
    const controller = new AbortController()
    controller.abort()
    assertFail(
      await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash' }, { signal: controller.signal }),
      'CANCELLED',
    )
  })
})

// #endregion

// #region release hardening: probe classification and trash serialization (0.4.0 P2 fixes) -----

describe('release hardening: probe error classification (SPEC §5.2)', () => {
  test('a vanished log is not blocked, and a directory gone by execution reports deleted with bytes 0', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x\n' }] })
    let opens = 0
    const engine = world.engine({
      sessionPersistence: {
        list: async () => [...world.snapshots.values()],
        stat: async (id) => world.snapshots.get(id),
        open: async () => {
          opens += 1
          // The real JSONL backend fails `open('write')` when the stored log is gone. The plan-time
          // probe (first call) only refuses the claim; the directory disappears between admission and
          // the per-item probe (second call), which is the SPEC §5.5 "deleted with bytes 0" path.
          if (opens === 2) await fsp.rm(world.dirOfSession('s1'), { recursive: true, force: true })
          const error = new Error('no stored log for this session')
          error.name = 'SessionPersistenceNotFoundError'
          throw error
        },
      },
    })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.deepEqual(plan.blockers, [], 'a missing log is not a live writer and must not block')
    assert.ok(opens >= 1)
    const response = await engine.execute({ planId: plan.planId })
    assert.equal(response.ok, true)
    assert.deepEqual(response.result.items, [
      { kind: 'session', id: 's1', status: 'deleted', error: null, movedTo: null, bytes: 0 },
    ])
    assert.deepEqual(await trashEntries(world), [])
  })

  test('a corrupt log stays deletable instead of becoming permanently blocked', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'broken\n' }] })
    const engine = world.engine({
      sessionPersistence: {
        list: async () => [...world.snapshots.values()],
        stat: async (id) => world.snapshots.get(id),
        open: async () => {
          const error = new Error('the stored log is corrupt')
          error.name = 'SessionPersistenceCorruptionError'
          throw error
        },
      },
    })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.deepEqual(plan.blockers, [])
    const response = await engine.execute({ planId: plan.planId })
    assert.equal(response.ok, true)
    assert.equal(response.result.items[0].status, 'trashed')
    await assertGone(world.dirOfSession('s1'))
  })

  test('a log in a newer format stays deletable in trash mode', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'future\n' }] })
    const engine = world.engine({
      sessionPersistence: {
        list: async () => [...world.snapshots.values()],
        stat: async (id) => world.snapshots.get(id),
        open: async () => {
          const error = new Error('session "s1" uses log format v9, but this harness reads only v1')
          error.name = 'SessionFormatUnsupportedError'
          throw error
        },
      },
    })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.deepEqual(plan.blockers, [])
    const response = await engine.execute({ planId: plan.planId })
    assert.equal(response.ok, true)
    assert.equal(response.result.items[0].status, 'trashed')
  })

  test('an unreadable store (permission) still fails closed', async () => {
    const world = await makeWorld({ sessions: [{ id: 's1', content: 'x\n' }] })
    const engine = world.engine({
      sessionPersistence: {
        list: async () => [...world.snapshots.values()],
        stat: async (id) => world.snapshots.get(id),
        open: async () => {
          const error = new Error('permission denied while opening the store')
          error.name = 'SessionPersistenceError'
          throw error
        },
      },
    })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'session', id: 's1' }], mode: 'trash' }))
    assert.deepEqual(plan.blockers.map((entry) => entry.code), ['IO_ERROR'])
  })
})

describe('release hardening: trash operations are serialized with deletions', () => {
  test('purge waits for an in-flight deletion instead of orphaning the prepared entry', async () => {
    const world = await makeWorld({ workspaces: [{ id: 'ws1', files: { 'a.txt': 'x' } }] })
    let signalRename
    const renameStarted = new Promise((resolve) => { signalRename = resolve })
    let releaseRename
    const gate = new Promise((resolve) => { releaseRename = resolve })
    const engine = world.engine({
      fsOps: {
        rename: async (from, to) => {
          if (String(from) === world.dirOf('ws1')) {
            signalRename()
            await gate
          }
          return nodeFs.rename(from, to)
        },
      },
    })
    const plan = planOf(await engine.plan({ targets: [{ kind: 'workspace', id: 'ws1' }], mode: 'trash', includeSessions: false }))
    const execution = engine.execute({ planId: plan.planId })
    await renameStarted
    const purge = engine.trashPurge({ all: true })
    releaseRename()
    const [executed, purged] = await Promise.all([execution, purge])
    assert.equal(executed.ok, true)
    assert.equal(executed.result.items[0].status, 'trashed')
    assert.deepEqual(purged, { ok: true, purged: 1, bytes: 1 })
    assert.deepEqual(await fsp.readdir(world.trashRoot).catch(() => []), [], 'no orphan payload remains')
    await assertGone(world.dirOf('ws1'))
  })
})

// #endregion
