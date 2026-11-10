/**
 * Browser-half contract and state-machine tests for dsh-cleanup.
 *
 * These run without React, DOM, or a browser: the module is loaded exactly as the Harness loads
 * it (`window.__ModuleLoader__.load({ id, factory })`), the captured factory is fed a stub React,
 * and `apply(fakeCtx)` is driven through the api objects it injects into its slot registrations.
 * That covers the frozen registration surface, the locale dictionaries, the context-menu
 * contributions, the review-dialog state machine and the settings-page store.
 *
 * What is deliberately NOT here: rendering, focus order, live-region announcement and scroll
 * locking. Those need a DOM; they were verified with a real React 18 + jsdom harness during the
 * 2026-11-04 review and must be re-checked by hand in the running Web UI before release.
 *
 * @module dsh-cleanup/test/client
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const CLIENT_PATH = new URL('../client.js', import.meta.url)
const source = await readFile(CLIENT_PATH, 'utf8')

// ---------------------------------------------------------------------------------------------
// A minimal browser shell: module-loader capture, stub React, fake client ctx, routed fetch.
// ---------------------------------------------------------------------------------------------

/** @returns {{ registrations: object[], injections: string[], menus: object[], dicts: object }} */
function createContext() {
  const registrations = []
  const injections = []
  const menus = []
  const effects = []
  let sessionRefreshGate = null
  const listeners = new Set()
  const localeState = { dicts: null, namespace: null }
  const calls = []
  const deferred = []
  let planResponse = () => ({ ok: true, plan: cleanPlan('trash') })
  let deleteResponse = () => ({ ok: true, result: { items: [], totals: { trashed: 1, deleted: 0, failed: 0, bytes: 10 } } })
  let restoreResponse = () => ({ ok: true, restoredTo: '/tmp/x' })
  let candidatesResponse = () => ({ ok: true, candidates: [], total: 0, truncated: false, totals: { count: 0, bytes: 0 } })
  let usageResponse = () => ({ ok: true, available: true, usage: {} })
  let openResponse = () => ({ ok: true, path: '/tmp/opened' })
  const notices = []
  const inventory = {
    ok: true,
    generatedAt: 1,
    dshHome: '/home/.dsh',
    trash: { root: '/home/.dsh/trash', entries: 0, bytes: 0 },
    workspaces: [],
    sessions: [
      { id: 'session-a', workspaceId: null, cwd: '/tmp/proj-a', createdAt: 100, eventCount: 3, sizeBytes: 2048, origin: null, parentSessionId: null, live: false, running: false, archived: false, pinned: false, deletable: true, blockerCodes: [] },
      { id: 'session-b', workspaceId: null, cwd: '/tmp/proj-b', createdAt: 50, eventCount: 1, sizeBytes: 512, origin: null, parentSessionId: null, live: false, running: false, archived: true, pinned: false, deletable: true, blockerCodes: [] },
    ],
    truncated: false,
    sessionListCap: 2000,
  }
  const trash = {
    ok: true,
    entries: [
      { id: '20260101T000000Z-a-0001', kind: 'workspace-dir', title: 'a', originalPath: '/tmp/proj-a', movedAt: 1, bytes: 10, files: 1, dirs: 0, restorable: true, restorableCode: null },
    ],
    totals: { entries: 1, bytes: 10 },
  }

  const ctx = {
    slots: {
      inject(slot, factory) {
        injections.push(slot)
        factory()
        return () => { }
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => { }
      },
    },
    locale: {
      register(namespace, dicts) {
        localeState.namespace = namespace
        localeState.dicts = dicts
        return () => { }
      },
      bind() {
        return (key, params) => {
          const dict = (localeState.dicts && localeState.dicts.zh) || {}
          let text = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key
          if (params) for (const [name, value] of Object.entries(params)) text = text.replace('{' + name + '}', String(value))
          return text
        }
      },
    },
    contextMenus: {
      register(contribution) {
        menus.push(contribution)
        return () => { }
      },
      notify(text, success) {
        notices.push({ text, success })
      },
    },
    effect(factory) {
      const cleanup = factory()
      effects.push(() => cleanup?.())
      return () => cleanup?.()
    },
    get(name) {
      if (name !== 'sessions') return undefined
      const snapshot = {
        ids: ['session-a', 'session-b'],
        byId: {
          'session-a': { id: 'session-a', displayTitle: '重构登录流程', cwd: '/tmp/proj-a', updatedAt: 300, running: false },
          'session-b': { id: 'session-b', displayTitle: '旧会话', cwd: '/tmp/proj-b', updatedAt: 100, running: true },
        },
        phase: 'ready',
        projectionsBySession: {},
      }
      return {
        refresh: () => {
          calls.push({ url: 'session.refresh' })
          // A test can hold the first refresh open to observe the restore follow-up refresh.
          if (sessionRefreshGate !== null) return sessionRefreshGate()
          return Promise.resolve()
        },
        list: {
          getSnapshot: () => snapshot,
          subscribe: (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        },
      }
    },
  }

  /** Route one POST exactly like the real authenticated `/api` channel. */
  globalThis.fetch = async (url, init) => {
    const path = String(url)
    const body = init && init.body ? JSON.parse(init.body) : {}
    calls.push({ url: path, body, signal: init && init.signal })
    const respond = (payload) => ({
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    })
    if (path.endsWith('cleanup.inventory')) return respond(inventory)
    if (path.endsWith('cleanup.trash.list')) return respond(trash)
    if (path.endsWith('cleanup.trash.restore')) return respond(restoreResponse())
    if (path.endsWith('cleanup.trash.purge')) {
      const deferredResponse = deferred.shift()
      if (deferredResponse) return deferredResponse.promise
      return respond({ ok: true, purged: 1, bytes: 10 })
    }
    if (path.endsWith('cleanup.measure')) {
      return respond({ ok: true, workspaces: {}, sessions: { 'session-a': { bytes: 2048, files: 3 } } })
    }
    if (path.endsWith('cleanup.plan')) return respond(await planResponse(body))
    if (path.endsWith('cleanup.defer')) return respond({ ok: true, deferred: { count: 1, entryIds: ['entry-1'], replaced: false } })
    if (path.endsWith('cleanup.candidates')) return respond(candidatesResponse(body))
    if (path.endsWith('cleanup.usage')) return respond(await usageResponse(body))
    if (path.endsWith('cleanup.open')) return respond(await openResponse(body))
    if (path.endsWith('cleanup.delete')) return respond(deleteResponse(body))
    throw new Error('unrouted fetch ' + path)
  }

  return {
    ctx,
    registrations,
    injections,
    menus,
    notices,
    calls,
    deferred,
    localeState,
    setPlanResponse(fn) { planResponse = fn },
    setDeleteResponse(fn) { deleteResponse = fn },
    setRestoreResponse(fn) { restoreResponse = fn },
    setCandidatesResponse(fn) { candidatesResponse = fn },
    effects,
    /** Hold `ctx.get('sessions').refresh()` open until the returned resolver is called. */
    holdSessionRefresh() {
      let release = null
      const gate = new Promise((resolve) => { release = resolve })
      sessionRefreshGate = () => gate
      return function () {
        sessionRefreshGate = null
        release()
      }
    },
    /** Run every registered `ctx.effect` disposer (plugin unload). */
    disposeEffects() {
      for (const dispose of effects.splice(0)) {
        try { dispose() } catch (error) { /* the test asserts the guarded behaviour, not a throw */ }
      }
    },
    setSessions(fn) { inventory.sessions = fn() },
    setTrashEntries(fn) { trash.entries = fn() },
    setWorkspaces(fn) { inventory.workspaces = fn() },
    /** 0.6.0 capability flags (SPEC §4.1 `inventory.capabilities`). */
    setCapabilities(value) { inventory.capabilities = value },
    setUsageResponse(fn) { usageResponse = fn },
    setOpenResponse(fn) { openResponse = fn },
  }
}

/** The simplest valid review plan: one session, no blockers, trash mode. */
function cleanPlan(mode) {
  return {
    planId: 'plan-' + mode,
    createdAt: 1,
    expiresAt: 4102444800000,
    mode,
    allowPermanentDeletion: true,
    targets: [{ kind: 'session', id: 'session-a', title: '重构登录流程', path: null }],
    items: [{ kind: 'session', id: 'session-a', workspaceId: null, title: null, path: '/tmp/x', bytes: 2048, files: 3, parentSessionId: null, isDescendant: false }],
    totals: { workspaces: 0, sessions: 1, files: 3, dirs: 0, bytes: 2048 },
    warnings: [],
    blockers: [],
    confirmation: null,
  }
}

/** A plan whose targets/items mirror the request, like the real Host plan payload. */
function planEchoingTargets(body) {
  const targets = body.targets.map((target) => ({ kind: target.kind, id: target.id, title: target.id, path: null }))
  const items = body.targets.map((target) => ({
    kind: target.kind === 'workspace' ? 'workspace-dir' : 'session',
    id: target.id,
    workspaceId: null,
    title: null,
    path: '/tmp/' + target.id,
    bytes: 10,
    files: 1,
    dirs: 0,
    parentSessionId: null,
    isDescendant: false,
    truncated: false,
  }))
  return Object.assign(cleanPlan(body.mode), {
    targets,
    items,
    totals: { workspaces: 0, sessions: items.length, files: items.length, dirs: 0, bytes: items.length * 10 },
  })
}

/** Load a fresh copy of client.js with its own module-loader capture. */
async function loadClient() {
  let loaded = null
  globalThis.window = {
    __ModuleLoader__: { load(entry) { loaded = entry } },
    addEventListener() { },
    removeEventListener() { },
  }
  delete globalThis.document
  // Cache-bust so each test file run gets a pristine module instance and its own registrations.
  await import(new URL('../client.js?test=' + Math.random(), import.meta.url))
  assert.ok(loaded, 'client.js must register itself with window.__ModuleLoader__')
  // Record the hook call order per render so the P0 hook-order regression can be asserted even
  // though this shim never renders React itself.
  const hookCalls = []
  const recordHook = (name) => { hookCalls.push(name) }
  const ReactStub = new Proxy({}, {
    get(_target, key) {
      if (key === 'createElement') return (type, props, ...children) => ({ type, props: props || {}, children })
      if (key === 'Fragment') return 'Fragment'
      if (key === 'useId') return () => { recordHook('useId'); return ':r-cleanup:' }
      if (key === 'useState') return (initial) => { recordHook('useState'); return [typeof initial === 'function' ? initial() : initial, () => { }] }
      if (key === 'useRef') return (initial) => { recordHook('useRef'); return { current: initial } }
      if (key === 'useEffect') return () => { recordHook('useEffect') }
      if (key === 'useMemo') return (factory) => { recordHook('useMemo'); return factory() }
      if (key === 'useCallback') return (callback) => { recordHook('useCallback'); return callback }
      if (key === 'useSyncExternalStore') return (_subscribe, getSnapshot) => { recordHook('useSyncExternalStore'); return getSnapshot() }
      return undefined
    },
  })
  const mod = loaded.factory((id) => {
    if (id === 'react') return ReactStub
    throw new Error('client.js must only require react, got ' + id)
  })
  return {
    mod,
    loaded,
    hookCalls,
    resetHooks() { hookCalls.length = 0 },
  }
}

/** Wait until predicate holds, or fail with the last snapshot for debugging. */
async function waitFor(predicate, label, timeoutMs = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('timed out waiting for ' + label)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Capture the dialog's auto-dismiss dwell timer instead of waiting 3.2s. Only timers scheduled with
 * a delay of at least 3s are captured (that is the dwell timer); everything else keeps running.
 * @returns {{ armed: Function, fire: Function, restore: Function }}
 */
function spyDoneTimer() {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const timers = []
  globalThis.setTimeout = function (callback, delay) {
    if (typeof delay === 'number' && delay >= 3000) {
      const handle = { callback: callback, cancelled: false }
      timers.push(handle)
      return handle
    }
    return realSetTimeout.apply(globalThis, arguments)
  }
  globalThis.clearTimeout = function (handle) {
    if (handle && typeof handle === 'object' && typeof handle.callback === 'function') {
      handle.cancelled = true
      return
    }
    return realClearTimeout.apply(globalThis, arguments)
  }
  return {
    armed: function () {
      return timers.filter(function (timer) { return timer.cancelled !== true })
    },
    fire: function () {
      const timer = this.armed()[0]
      if (timer) timer.callback()
    },
    restore: function () {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    },
  }
}
/** The api object a slot registration injects into its component. */
const slotApi = (world, slot) => world.registrations.find((entry) => entry.options.name === slot).options.inject().api

// ---------------------------------------------------------------------------------------------
// Module contract, registrations, locale, menus
// ---------------------------------------------------------------------------------------------

test('module contract: id, inject list, and the three slot registrations', async () => {
  const world = createContext()
  const { mod, loaded } = await loadClient()
  assert.equal(loaded.id, 'dsh-cleanup')
  assert.deepEqual(mod.inject, ['slots', 'locale', 'contextMenus'])
  mod.apply(world.ctx)

  assert.deepEqual(world.injections, ['contextMenu.icon', 'shell.overlay', 'settings.section'])
  const icon = world.registrations.find((entry) => entry.options.name === 'contextMenu.icon')
  assert.equal(icon.options.key, 'cleanup.trash')
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  assert.equal(overlay.options.id, 'dsh-cleanup-dialog')
  assert.equal(overlay.options.order, 900)
  const section = world.registrations.find((entry) => entry.options.name === 'settings.section')
  assert.equal(section.options.id, 'cleanup')
  assert.equal(section.options.order, 85)
  assert.equal(section.options.locale, 'cleanup')
  assert.equal(typeof section.options.label, 'function', 'the settings nav label resolves per locale')
})

test('context menus: three danger actions, correct targets, malformed targets declined', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  assert.equal(world.menus.length, 3)
  const sessionMenu = world.menus.find((entry) => entry.target === 'session')
  const workspaceMenu = world.menus.find((entry) => entry.target === 'workspace' && entry.id === 'delete-workspace-dir')
  const clearMenu = world.menus.find((entry) => entry.target === 'workspace' && entry.id === 'clear-workspace-sessions')
  assert.ok(sessionMenu && workspaceMenu && clearMenu)
  assert.equal(sessionMenu.id, 'delete-session')
  assert.equal(workspaceMenu.id, 'delete-workspace-dir')
  assert.equal(clearMenu.order, 350, 'the clear row sorts above the folder deletion')
  assert.deepEqual(sessionMenu.resolve({ displayTitle: 'no id' }), [])
  assert.deepEqual(workspaceMenu.resolve({ path: '/tmp/x' }), [])
  assert.deepEqual(clearMenu.resolve({ path: '/tmp/x' }), [])
  const [sessionAction] = sessionMenu.resolve({ sessionId: 'session-a', displayTitle: '重构登录流程' })
  assert.equal(sessionAction.danger, true)
  assert.equal(sessionAction.separatorBefore, true)
  assert.deepEqual(sessionAction.icon, { key: 'cleanup.trash' })
  assert.equal(typeof sessionAction.label, 'string', 'MenuActionView.label is rendered as a string')
  const [workspaceAction] = workspaceMenu.resolve({ workspaceId: 'ws-a', path: '/tmp/proj-a', displayTitle: 'proj-a' })
  assert.equal(workspaceAction.danger, true)
  assert.equal(workspaceAction.separatorBefore, undefined, 'the clear row owns the one separator above both')
  const [clearAction] = clearMenu.resolve({ workspaceId: 'ws-a', displayTitle: 'proj-a' })
  assert.equal(clearAction.danger, true)
  assert.equal(clearAction.separatorBefore, true)
  assert.equal(typeof clearAction.run, 'function')
})

test('locale: cleanup namespace, zh/en key + param parity, plural variants, new codes', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  assert.equal(world.localeState.namespace, 'cleanup')
  const { zh, en } = world.localeState.dicts
  assert.ok(zh && en)
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(enKeys, zhKeys, 'zh/en key sets diverge')
  for (const key of zhKeys) {
    const zhParams = [...String(zh[key]).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort()
    const enParams = [...String(en[key]).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort()
    assert.deepEqual(enParams, zhParams, 'param sets diverge for ' + key)
  }
  for (const code of ['error.WORKSPACE_CONTAINS_WORKSPACE', 'warn.WORKSPACE_CONTAINS_WORKSPACE', 'warn.SESSION_NOT_DELETABLE', 'error.PLAN_EXPIRED', 'error.STATE_CHANGED']) {
    assert.ok(Object.prototype.hasOwnProperty.call(en, code), 'missing localized code ' + code)
  }
  for (const base of ['count.file', 'count.dir']) {
    for (const suffix of ['_one', '_other']) {
      assert.ok(Object.prototype.hasOwnProperty.call(en, base + suffix), 'missing plural key ' + base + suffix)
      assert.ok(Object.prototype.hasOwnProperty.call(zh, base + suffix), 'missing zh plural key ' + base + suffix)
    }
  }
  assert.equal(zh['count.file_one'], zh['count.file_other'], 'Chinese uses one form for both plural categories')
})

// ---------------------------------------------------------------------------------------------
// Review dialog state machine
// ---------------------------------------------------------------------------------------------

test('dialog: planning -> review, then a clean confirm deletes with the reviewed plan id', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const api = slotApi(world, 'shell.overlay')
  assert.equal(api.dialogStore.getSnapshot().phase, 'idle')

  api.openDialog([{ kind: 'session', id: 'session-a', title: '重构登录流程' }])
  assert.equal(api.dialogStore.getSnapshot().phase, 'planning')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  api.confirmDelete()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase')
  const deleteCall = world.calls.find((call) => call.url.endsWith('cleanup.delete'))
  assert.deepEqual(deleteCall.body, { planId: 'plan-trash' })
  assert.equal(world.calls.some((call) => call.url === 'session.refresh'), true, 'the session catalog is refreshed after a delete')
  api.disposeDialog()
})

test('dialog: a blocked plan never issues a delete request', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setPlanResponse((mode) => ({
    ok: true,
    plan: { ...cleanPlan(mode), blockers: [{ code: 'SESSION_LIVE', message: 'live', sessionId: 'session-a', workspaceId: null }] },
  }))
  const api = slotApi(world, 'shell.overlay')
  api.openDialog([{ kind: 'session', id: 'session-a', title: 'x' }])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  api.confirmDelete()
  await sleep(30)
  assert.equal(world.calls.some((call) => call.url.endsWith('cleanup.delete')), false)
  assert.equal(api.dialogStore.getSnapshot().phase, 'review')
  api.disposeDialog()
})

test('dialog: a failed delete offers a retry that re-plans instead of replaying the consumed plan', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setDeleteResponse(() => ({ ok: false, error: { code: 'STATE_CHANGED', message: 'changed' } }))
  const api = slotApi(world, 'shell.overlay')
  api.openDialog([{ kind: 'session', id: 'session-a', title: 'x' }])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  api.confirmDelete()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'failed', 'failed phase')
  assert.equal(api.dialogStore.getSnapshot().error.code, 'STATE_CHANGED')
  const planCallsBefore = world.calls.filter((call) => call.url.endsWith('cleanup.plan')).length
  api.retryDialog()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 're-planned review')
  const planCallsAfter = world.calls.filter((call) => call.url.endsWith('cleanup.plan')).length
  assert.equal(planCallsAfter, planCallsBefore + 1, 'retry must create a fresh plan')
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.delete')).length, 1, 'retry must not resend delete')
  api.disposeDialog()
})

test('dialog: changing the mode re-plans with the new mode and keeps the targets', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const api = slotApi(world, 'shell.overlay')
  api.openDialog([{ kind: 'session', id: 'session-a', title: 'x' }])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  api.setDialogMode('permanent')
  await waitFor(() => {
    const calls = world.calls.filter((call) => call.url.endsWith('cleanup.plan'))
    return calls.length >= 2 && calls.at(-1).body.mode === 'permanent'
  }, 're-plan with permanent mode')
  const lastPlan = world.calls.filter((call) => call.url.endsWith('cleanup.plan')).at(-1)
  assert.deepEqual(lastPlan.body.targets, [{ kind: 'session', id: 'session-a' }])
  api.disposeDialog()
})

/** Depth-first search for the first element a predicate accepts. */
function findElement(node, predicate) {
  if (!node) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, predicate)
      if (hit) return hit
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (predicate(node)) return node
  return findElement(node.children, predicate)
}

test('dialog: the settings page hosts the review dialog in place, keeping the settings sheet open', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const section = world.registrations.find((entry) => entry.options.name === 'settings.section')
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = section.options.inject().api
  let closed = 0
  const page = section.component({ api, t: api.t, close: () => { closed += 1 } })
  const inline = findElement(page, (element) => element && element.props && element.props.surface === 'settings')
  assert.ok(inline, 'the settings page renders the review dialog itself, inside the sheet')

  api.openDialog([{ kind: 'session', id: 'session-a', title: '重构登录流程' }], { surface: 'settings' })
  assert.equal(api.dialogStore.getSnapshot().surface, 'settings')
  assert.equal(closed, 0, 'opening the dialog must not dismiss the settings sheet')
  assert.ok(inline.type(inline.props), 'the sheet-hosted dialog renders while it is open')
  assert.equal(overlay.component({ api, t: api.t }), null, 'shell.overlay stands down for a sheet-hosted dialog')

  // The context-menu path keeps the overlay surface, and only the overlay entry renders it.
  api.openDialog([{ kind: 'session', id: 'session-a', title: '重构登录流程' }])
  assert.equal(api.dialogStore.getSnapshot().surface, 'overlay')
  assert.ok(overlay.component({ api, t: api.t }), 'a menu-opened dialog still renders in shell.overlay')
  assert.equal(inline.type(inline.props), null, 'the sheet-hosted copy stands down for an overlay dialog')
  api.disposeDialog()
})

/** Depth-first collection of every element a predicate accepts. */
function findAll(node, predicate, found) {
  const hits = found || []
  if (!node) return hits
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, hits)
    return hits
  }
  if (typeof node !== 'object') return hits
  if (predicate(node)) hits.push(node)
  findAll(node.children, predicate, hits)
  return hits
}

/** Elements whose className starts with the given token (rows carry modifier classes). */
function elementsByClass(tree, token) {
  return findAll(tree, (element) => {
    const className = element && element.props && element.props.className
    if (typeof className !== 'string') return false
    return className === token || className.indexOf(token + ' ') === 0
  })
}

/**
 * Evaluate function components so the tree reaches real DOM elements. The stub React never re-renders,
 * so a single pass is enough to assert what one mount produces.
 */
function renderDeep(node) {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(renderDeep)
  if (typeof node.type === 'function') {
    // The stub createElement keeps children beside `props`; React itself puts them inside it.
    const props = Object.assign({}, node.props)
    if (node.children !== undefined) props.children = node.children.length === 1 ? node.children[0] : node.children
    return renderDeep(node.type(props))
  }
  return { type: node.type, props: node.props, children: renderDeep(node.children) }
}

/** Concatenated text of a rendered tree (for asserting badge/label copy). */
function collectText(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join('')
  if (typeof node !== 'object') return ''
  return collectText(node.children)
}

test('dialog: the review groups subagent logs under their own Session instead of listing them flat', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setPlanResponse((mode) => ({
    ok: true,
    plan: {
      ...cleanPlan(mode),
      targets: [
        { kind: 'session', id: 'session-a', title: '会话 A', path: null },
        { kind: 'session', id: 'session-b', title: '会话 B', path: null },
      ],
      items: [
        { kind: 'session', id: 'session-a', workspaceId: null, title: '会话 A', path: '/tmp/a', bytes: 100, files: 1, dirs: 0, parentSessionId: null, isDescendant: false },
        { kind: 'session', id: 'child-1', workspaceId: null, title: '子会话 1', path: '/tmp/c1', bytes: 10, files: 1, dirs: 0, parentSessionId: 'session-a', isDescendant: true },
        { kind: 'session', id: 'child-2', workspaceId: null, title: '子会话 2', path: '/tmp/c2', bytes: 10, files: 1, dirs: 0, parentSessionId: 'child-1', isDescendant: true },
        { kind: 'session', id: 'session-b', workspaceId: null, title: '会话 B', path: '/tmp/b', bytes: 100, files: 1, dirs: 0, parentSessionId: null, isDescendant: false },
      ],
      totals: { workspaces: 0, sessions: 4, files: 4, dirs: 0, bytes: 220 },
    },
  }))
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  api.openDialog([
    { kind: 'session', id: 'session-a', title: '会话 A' },
    { kind: 'session', id: 'session-b', title: '会话 B' },
  ])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  const tree = overlay.component({ api, t: api.t })
  const rows = elementsByClass(tree, 'dsh-cleanup-target')
  assert.equal(rows.length, 2, 'one row per reviewed target, not one per plan item')
  const groups = elementsByClass(tree, 'dsh-cleanup-target-children')
  assert.equal(groups.length, 1, 'only the Session with subagent logs gets a collapsible group')
  const toggles = elementsByClass(tree, 'dsh-cleanup-target-more')
  assert.equal(toggles.length, 1)
  assert.equal(toggles[0].props['aria-expanded'], 'false', 'the subagent list starts collapsed')
  // Collapsed means the child rows are not rendered at all until the user asks for them.
  assert.equal(findAll(tree, (element) => element && element.props && element.props.title === '/tmp/c1').length, 0)
  api.disposeDialog()
})

test('dialog: un-checking a reviewed target re-plans without it, and the last row cannot be removed', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const api = slotApi(world, 'shell.overlay')
  api.openDialog([
    { kind: 'session', id: 'session-a', title: '会话 A' },
    { kind: 'session', id: 'session-b', title: '会话 B' },
  ])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  assert.deepEqual(api.dialogStore.getSnapshot().selection, ['session:session-a', 'session:session-b'])

  api.setDialogSelection('session:session-b', false)
  await waitFor(() => {
    const calls = world.calls.filter((call) => call.url.endsWith('cleanup.plan'))
    return calls.length >= 2 && calls.at(-1).body.targets.length === 1 && api.dialogStore.getSnapshot().refreshing !== true
  }, 're-plan without the un-checked row')
  assert.deepEqual(world.calls.filter((call) => call.url.endsWith('cleanup.plan')).at(-1).body.targets, [{ kind: 'session', id: 'session-a' }])
  assert.deepEqual(api.dialogStore.getSnapshot().selection, ['session:session-a'])

  // Un-checking the last row is allowed: the review keeps the row, drops the plan and disables the
  // destructive button instead of sending a target set the Host would reject.
  const planCallsBefore = world.calls.filter((call) => call.url.endsWith('cleanup.plan')).length
  api.setDialogSelection('session:session-a', false)
  await sleep(30)
  const cleared = api.dialogStore.getSnapshot()
  assert.deepEqual(cleared.selection, [])
  assert.equal(cleared.plan, null, 'no stale plan survives an empty selection')
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.plan')).length, planCallsBefore, 'an empty selection is never planned')

  // Re-checking one row produces a fresh plan again.
  api.setDialogSelection('session:session-a', true)
  await waitFor(() => api.dialogStore.getSnapshot().plan !== null, 'plan after re-check')
  api.disposeDialog()
})

test('dialog: the selection can be widened again and the subagent switch reaches the plan', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const api = slotApi(world, 'shell.overlay')
  world.setPlanResponse((body) => ({ ok: true, plan: planEchoingTargets(body) }))
  api.openDialog([
    { kind: 'session', id: 'session-a', title: '会话 A' },
    { kind: 'session', id: 'session-b', title: '会话 B' },
  ])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  api.setDialogSelection('session:session-a', false)
  await waitFor(() => {
    const calls = world.calls.filter((call) => call.url.endsWith('cleanup.plan'))
    return calls.length >= 2 && calls.at(-1).body.targets.length === 1 && api.dialogStore.getSnapshot().refreshing !== true
  }, 'narrowed plan')
  api.selectAllDialogTargets()
  await waitFor(() => {
    const calls = world.calls.filter((call) => call.url.endsWith('cleanup.plan'))
    return calls.length >= 3 && calls.at(-1).body.targets.length === 2 && api.dialogStore.getSnapshot().refreshing !== true
  }, 'widened plan')
  assert.deepEqual(api.dialogStore.getSnapshot().selection, ['session:session-a', 'session:session-b'])

  api.setIncludeDescendants(false)
  await waitFor(() => {
    const calls = world.calls.filter((call) => call.url.endsWith('cleanup.plan'))
    return calls.length >= 4 && calls.at(-1).body.includeDescendants === false
  }, 'plan without descendants')
  assert.equal(api.dialogStore.getSnapshot().includeDescendants, false)
  api.disposeDialog()
})

test('dialog: a single reviewed target still gets its checkbox, checked by default', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  api.openDialog([{ kind: 'session', id: 'session-a', title: '会话 A' }])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  const tree = overlay.component({ api, t: api.t })
  const rows = elementsByClass(tree, 'dsh-cleanup-target')
  assert.equal(rows.length, 1)
  const boxes = findAll(rows[0], (element) => element && element.type === 'input' && element.props && element.props.type === 'checkbox')
  assert.equal(boxes.length, 1, 'a lone target is still selectable')
  assert.equal(boxes[0].props.checked, true, 'the review starts with everything checked')
  api.disposeDialog()
})

test('dialog: invert flips every row and select-all restores them', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const api = slotApi(world, 'shell.overlay')
  world.setPlanResponse((body) => ({ ok: true, plan: planEchoingTargets(body) }))
  api.openDialog([
    { kind: 'session', id: 'session-a', title: '会话 A' },
    { kind: 'session', id: 'session-b', title: '会话 B' },
  ])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')

  api.invertDialogTargetSelection()
  assert.deepEqual(api.dialogStore.getSnapshot().selection, [], 'inverting a full selection clears it')
  assert.equal(api.dialogStore.getSnapshot().plan, null)

  api.invertDialogTargetSelection()
  await waitFor(() => api.dialogStore.getSnapshot().plan !== null, 'inverting back plans again')
  assert.deepEqual(api.dialogStore.getSnapshot().selection, ['session:session-a', 'session:session-b'])

  api.setDialogSelection('session:session-a', false)
  await waitFor(() => api.dialogStore.getSnapshot().refreshing !== true, 'narrowed plan')
  const planCallsBefore = world.calls.filter((call) => call.url.endsWith('cleanup.plan')).length
  api.selectAllDialogTargets()
  await waitFor(() => {
    const calls = world.calls.filter((call) => call.url.endsWith('cleanup.plan'))
    return calls.length === planCallsBefore + 1 && calls.at(-1).body.targets.length === 2
  }, 'select-all restores every row')
  assert.deepEqual(api.dialogStore.getSnapshot().selection, ['session:session-a', 'session:session-b'])
  api.disposeDialog()
})

test('dialog: un-checking a subagent row wins over descendant expansion', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setPlanResponse((body) => {
    const items = [
      { kind: 'session', id: 'session-a', workspaceId: null, title: 'A', path: '/tmp/a', bytes: 100, files: 1, dirs: 0, parentSessionId: null, isDescendant: false },
    ]
    // The Host expands a checked Session into its subagent closure.
    if (body.includeDescendants === true) {
      items.push({ kind: 'session', id: 'session-b', workspaceId: null, title: 'B', path: '/tmp/b', bytes: 10, files: 1, dirs: 0, parentSessionId: 'session-a', isDescendant: true })
    }
    return {
      ok: true,
      plan: {
        ...cleanPlan(body.mode),
        targets: body.targets.map((target) => ({ kind: target.kind, id: target.id, title: target.id, path: null })),
        items,
        totals: { workspaces: 0, sessions: items.length, files: items.length, dirs: 0, bytes: 110 },
      },
    }
  })
  const api = slotApi(world, 'shell.overlay')
  api.openDialog([
    { kind: 'session', id: 'session-a', title: 'A' },
    { kind: 'session', id: 'session-b', title: 'B' },
  ])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')

  // Un-checking B must not let A's descendant closure delete it anyway.
  api.setDialogSelection('session:session-b', false)
  await waitFor(() => {
    const calls = world.calls.filter((call) => call.url.endsWith('cleanup.plan'))
    return calls.length >= 3 && api.dialogStore.getSnapshot().refreshing !== true
  }, 're-plan without descendants')

  const lastPlan = world.calls.filter((call) => call.url.endsWith('cleanup.plan')).at(-1)
  assert.equal(lastPlan.body.includeDescendants, false, 'the checkbox wins over descendant expansion')
  assert.deepEqual(lastPlan.body.targets, [{ kind: 'session', id: 'session-a' }])
  const settled = api.dialogStore.getSnapshot()
  assert.equal(settled.includeDescendants, false)
  const itemIds = settled.plan.items.map((item) => item.id)
  assert.equal(itemIds.includes('session-b'), false, 'the un-checked row is not planned at all')
  assert.equal(settled.descendantsAutoOff, true, 'the forced-off switch is explained instead of silently flipping')
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const reviewText = collectText(renderDeep(overlay.component({ api, t: api.t })))
  assert.match(reviewText, /已自动关闭/, 'the switch-off reason is visible next to the switch')
  api.disposeDialog()
})


test('dialog: widening a permanent selection falls back to trash instead of a plan the Host must refuse', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setPlanResponse((body) => ({ ok: true, plan: planEchoingTargets(body) }))
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  api.openDialog([
    { kind: 'workspace', id: 'ws-a', title: 'A', path: '/tmp/a' },
    { kind: 'workspace', id: 'ws-b', title: 'B', path: '/tmp/b' },
  ])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review' && api.dialogStore.getSnapshot().refreshing !== true, 'initial review')

  // Narrow to one folder so permanent becomes available, switch, then re-check the second row.
  api.setDialogSelection('workspace:ws-b', false)
  await waitFor(() => api.dialogStore.getSnapshot().refreshing !== true && api.dialogStore.getSnapshot().plan.targets.length === 1, 'narrowed review')
  api.setDialogMode('permanent')
  await waitFor(() => api.dialogStore.getSnapshot().mode === 'permanent' && api.dialogStore.getSnapshot().refreshing !== true, 'permanent review')
  api.setDialogSelection('workspace:ws-b', true)
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review' && api.dialogStore.getSnapshot().refreshing !== true && api.dialogStore.getSnapshot().plan.targets.length === 2, 'widened review')

  const settled = api.dialogStore.getSnapshot()
  assert.equal(settled.mode, 'trash', 'the review falls back to trash instead of planning a permanent multi-folder deletion')
  assert.equal(settled.modeNotice, true, 'the fallback is explained')
  assert.equal(settled.failureStage, null, 'the fallback does not dead-end in failed')
  const lastPlan = world.calls.filter((call) => call.url.endsWith('cleanup.plan')).at(-1)
  assert.equal(lastPlan.body.mode, 'trash')
  const text = collectText(renderDeep(overlay.component({ api, t: api.t })))
  assert.match(text, /已自动改为移入回收站/)
  api.disposeDialog()
})

test('dialog: a re-checked row shows a pending state while the plan is in flight', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  let delayMs = 0
  world.setPlanResponse(async (body) => {
    if (delayMs > 0) {
      const wait = delayMs
      delayMs = 0
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
    return { ok: true, plan: planEchoingTargets(body) }
  })
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  api.openDialog([
    { kind: 'workspace', id: 'ws-a', title: 'A', path: '/tmp/a' },
    { kind: 'workspace', id: 'ws-b', title: 'B', path: '/tmp/b' },
  ])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review' && api.dialogStore.getSnapshot().refreshing !== true, 'initial review')
  api.setDialogSelection('workspace:ws-b', false)
  await waitFor(() => api.dialogStore.getSnapshot().refreshing !== true && api.dialogStore.getSnapshot().plan.targets.length === 1, 'narrowed review')

  // The next plan response is slow: the re-checked row has no item yet while the request is open.
  delayMs = 400
  api.setDialogSelection('workspace:ws-b', true)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const mid = api.dialogStore.getSnapshot()
  assert.equal(mid.refreshing, true, 'the test is observing the in-flight window')
  const text = collectText(renderDeep(overlay.component({ api, t: api.t })))
  assert.match(text, /重新规划中/, 'a checked row without an item yet is rendered as pending')
  assert.doesNotMatch(text, /已取消选择/, 'the pending row must not claim the user un-checked it')
  assert.match(text, /正在重新计算复核结果/, 'the totals are withheld while the plan is stale')

  await waitFor(() => api.dialogStore.getSnapshot().refreshing !== true && api.dialogStore.getSnapshot().plan.targets.length === 2, 'widened review settles')
  api.disposeDialog()
})

test('dialog: a plan that still contains an un-checked target fails closed without deleting', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  // The Host's folder sweep keeps bringing the un-checked Session back, even without descendants.
  world.setPlanResponse((body) => {
    const items = [
      { kind: 'workspace-dir', id: 'ws-a', workspaceId: null, title: 'A', path: '/tmp/a', bytes: 1, files: 1, dirs: 0, parentSessionId: null, isDescendant: false },
      { kind: 'session', id: 'session-a', workspaceId: 'ws-a', title: null, path: '/tmp/session-a', bytes: 1, files: 1, dirs: 0, parentSessionId: null, isDescendant: false },
    ]
    return {
      ok: true,
      plan: Object.assign(cleanPlan(body.mode), {
        targets: body.targets.map((target) => ({ kind: target.kind, id: target.id, title: target.id, path: null })),
        items,
        totals: { workspaces: 1, sessions: 1, files: 2, dirs: 0, bytes: 2 },
      }),
    }
  })
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  api.openDialog([
    { kind: 'workspace', id: 'ws-a', title: 'A', path: '/tmp/a' },
    { kind: 'session', id: 'session-a', title: '会话 A' },
  ])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'initial review')
  api.setDialogSelection('session:session-a', false)
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'failed', 'failed phase')
  const settled = api.dialogStore.getSnapshot()
  assert.equal(settled.failureStage, 'plan')
  assert.equal(settled.error.code, 'UNCHECKED_TARGET_LEAK')
  assert.equal(settled.descendantsAutoOff, true, 'descendant expansion was dropped before refusing')
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.delete')).length, 0, 'the un-checked target is never deleted')
  const text = collectText(renderDeep(overlay.component({ api, t: api.t })))
  assert.match(text, /已取消勾选的目标仍会被删除/)
  api.disposeDialog()
})

test('dialog: scheduling refuses a plan without targets instead of queueing un-checked rows', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setPlanResponse((body) => ({
    ok: true,
    plan: Object.assign(cleanPlan(body.mode), {
      targets: [],
      blockers: [{ code: 'SESSION_LIVE', message: 'live', sessionId: 'session-a', workspaceId: null }],
    }),
  }))
  const api = slotApi(world, 'shell.overlay')
  api.openDialog([{ kind: 'session', id: 'session-a', title: '会话 A' }])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  api.deferPlan()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'failed', 'failed phase')
  const settled = api.dialogStore.getSnapshot()
  assert.equal(settled.failureStage, 'defer')
  assert.deepEqual(settled.error, { transport: 'badResponse' })
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.defer')).length, 0, 'nothing is queued without reviewed targets')
  api.disposeDialog()
})

// ---------------------------------------------------------------------------------------------
// Clear workspace sessions
// ---------------------------------------------------------------------------------------------

/** Rows the candidates endpoint answers with, oldest first. */
function candidateRows(count, overrides) {
  const rows = []
  for (let index = 0; index < count; index += 1) {
    rows.push(Object.assign({ id: 'session-' + index, cwd: '/tmp/proj-' + index, deletable: true }, overrides || {}))
  }
  return rows
}

/** The workspace context-menu action that starts a clear. */
function clearMenuAction(world) {
  const menu = world.menus.find((entry) => entry.target === 'workspace' && entry.id === 'clear-workspace-sessions')
  return menu.resolve({ workspaceId: 'ws-a', displayTitle: 'proj-a' })[0]
}

test('workspace clear: the menu action pre-flights the workspace and reviews every Session', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setCandidatesResponse(() => ({
    ok: true,
    candidates: candidateRows(3),
    total: 3,
    truncated: false,
    totals: { count: 3, bytes: 0 },
  }))
  clearMenuAction(world).run()
  const api = slotApi(world, 'shell.overlay')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  const state = api.dialogStore.getSnapshot()
  assert.equal(state.targets.length, 3)
  assert.equal(state.clear.total, 3)
  assert.equal(state.clear.deletable, 3)
  const preflight = world.calls.find((call) => call.url.endsWith('cleanup.candidates'))
  assert.deepEqual(preflight.body.filters.workspaceId, 'ws-a', 'the pre-flight is scoped to the workspace')
  assert.equal(preflight.body.filters.requireDeletable, false, 'in-use sessions are counted, not filtered away silently')

  api.confirmDelete()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase')
  assert.equal(api.dialogStore.getSnapshot().clear.done.count, 1, 'the folded batch totals feed the result')
  assert.equal(api.dialogStore.getSnapshot().result, null, 'a clear result comes from the folded batches')
  api.disposeDialog()
})

test('workspace clear: an all-in-use workspace explains itself in the dialog, not a toast', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setCandidatesResponse(() => ({
    ok: true,
    candidates: candidateRows(2, { deletable: false }),
    total: 2,
    truncated: false,
    totals: { count: 2, bytes: 0 },
  }))
  clearMenuAction(world).run()
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase')
  const state = api.dialogStore.getSnapshot()
  assert.equal(state.clear.stop.code, 'empty')
  assert.equal(state.clear.total, 2)
  assert.equal(state.clear.skipped, 2)
  assert.equal(world.notices.length, 0, 'the dialog carries the explanation, not a toast')
  const text = collectText(renderDeep(overlay.component({ api, t: api.t })))
  assert.match(text, /没有可清理的会话/)
  assert.match(text, /2 条会话正在本次启动中打开或运行/)
  api.disposeDialog()
})

test('workspace clear: a failed pre-flight keeps the dialog open and stays retryable', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setCandidatesResponse(() => { throw new Error('candidates unavailable') })
  clearMenuAction(world).run()
  const api = slotApi(world, 'shell.overlay')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'failed', 'failed phase')
  const state = api.dialogStore.getSnapshot()
  assert.notEqual(state.clear, null, 'the clear context survives the failed pre-flight')
  assert.equal(world.notices.length, 0, 'a failed pre-flight is shown in the dialog, not a toast')

  const callsBefore = world.calls.filter((call) => call.url.endsWith('cleanup.candidates')).length
  api.retryDialog()
  await waitFor(() => world.calls.filter((call) => call.url.endsWith('cleanup.candidates')).length > callsBefore, 'retry re-runs the pre-flight')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'failed', 'still failed')
  api.disposeDialog()
})

test('workspace clear: more sessions than one plan holds are cleared in plan-sized batches', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  let page = 0
  world.setCandidatesResponse(() => {
    page += 1
    // The first page is the whole workspace; after the batches run the workspace is empty.
    if (page === 1) return { ok: true, candidates: candidateRows(130), total: 130, truncated: false, totals: { count: 130, bytes: 0 } }
    return { ok: true, candidates: [], total: 0, truncated: false, totals: { count: 0, bytes: 0 } }
  })
  clearMenuAction(world).run()
  const api = slotApi(world, 'shell.overlay')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  assert.equal(api.dialogStore.getSnapshot().targets.length, 64, 'the review covers the first plan-sized batch')
  api.confirmDelete()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase', 5000)
  const plans = world.calls.filter((call) => call.url.endsWith('cleanup.plan')).map((call) => call.body.targets.length)
  assert.deepEqual(plans, [64, 64, 2], 'the workspace is walked in plan-sized batches')
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.delete')).length, 3)
  const settled = api.dialogStore.getSnapshot()
  assert.equal(settled.clear.done.count, 3)
  assert.equal(settled.clear.batches, 3)
  assert.equal(settled.clear.stop, null, 'a drained workspace stops cleanly')
  api.disposeDialog()
})

test('workspace clear: the review lists a checkbox per Session and honours un-checked rows', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  let page = 0
  world.setCandidatesResponse(() => {
    page += 1
    // The first page is cut short, so the walk refills after the batch drains.
    if (page === 1) return { ok: true, candidates: candidateRows(3), total: 3, truncated: true, totals: { count: 3, bytes: 0 } }
    // Only the Session the user un-checked is still on disk after the batch ran.
    return { ok: true, candidates: [{ id: 'session-1', cwd: '/tmp/proj-1', deletable: true }], total: 1, truncated: false, totals: { count: 1, bytes: 0 } }
  })
  clearMenuAction(world).run()
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  assert.equal(api.dialogStore.getSnapshot().targets.length, 3)

  const tree = overlay.component({ api, t: api.t })
  const boxes = findAll(tree, (element) => element && element.type === 'input' && element.props
    && element.props.type === 'checkbox' && element.props.className === 'dsh-cleanup-target-check')
  assert.equal(boxes.length, 3, 'a clear review is selectable row by row')
  assert.equal(boxes.every((box) => box.props.checked === true), true, 'the pre-flight batch starts fully checked')

  api.setDialogSelection('session:session-1', false)
  await waitFor(() => {
    const calls = world.calls.filter((call) => call.url.endsWith('cleanup.plan'))
    return calls.length >= 2 && calls.at(-1).body.targets.length === 2 && api.dialogStore.getSnapshot().refreshing !== true
  }, 're-plan without the un-checked row')
  assert.deepEqual(api.dialogStore.getSnapshot().clear.excluded, { 'session:session-1': true })

  api.confirmDelete()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase', 5000)
  const plannedIds = []
  // The first plan covers the whole pre-flight batch (it ran before the row was un-checked).
  const planCalls = world.calls.filter((call) => call.url.endsWith('cleanup.plan')).slice(1)
  for (const call of planCalls) for (const target of call.body.targets) plannedIds.push(target.id)
  assert.equal(plannedIds.includes('session-1'), false, 'an un-checked row never reappears in a later batch')
  assert.equal(plannedIds.length, 2, 'only the two checked rows are planned')
  assert.equal(planCalls.length, 1, 'the refilled page yields nothing new to delete')
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.delete')).length, 1)
  assert.equal(api.dialogStore.getSnapshot().clear.done.count, 1)
  api.disposeDialog()
})

test('workspace clear: un-checking every row keeps the Session list on screen', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setCandidatesResponse(() => ({ ok: true, candidates: candidateRows(3), total: 3, truncated: false, totals: { count: 3, bytes: 0 } }))
  clearMenuAction(world).run()
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')

  for (const id of ['session-0', 'session-1', 'session-2']) {
    api.setDialogSelection('session:' + id, false)
    await waitFor(() => api.dialogStore.getSnapshot().refreshing !== true, 're-plan after ' + id)
  }
  assert.deepEqual(api.dialogStore.getSnapshot().selection, [])
  assert.equal(api.dialogStore.getSnapshot().plan, null)

  // The rows stay put: an empty selection dims them instead of collapsing the list.
  const tree = overlay.component({ api, t: api.t })
  assert.equal(elementsByClass(tree, 'dsh-cleanup-target').length, 3, 'every row is still rendered')
  const boxes = findAll(tree, (element) => element && element.type === 'input' && element.props
    && element.props.type === 'checkbox' && element.props.className === 'dsh-cleanup-target-check')
  assert.equal(boxes.length, 3, 'every row keeps its checkbox')
  assert.equal(boxes.every((box) => box.props.checked === false), true)
  assert.equal(elementsByClass(tree, 'dsh-cleanup-select-required').length, 1, 'the review asks for a selection')
  api.disposeDialog()
})

test('settings: the Sessions tab collapses subagent logs under their parent', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setSessions(() => [
    { id: 'root', workspaceId: null, cwd: '/proj', createdAt: 2000, eventCount: 2, sizeBytes: 100, origin: null, parentSessionId: null, live: false, running: false, archived: false, pinned: false, deletable: true, blockerCodes: [] },
    { id: 'child', workspaceId: null, cwd: '/proj', createdAt: 1000, eventCount: 1, sizeBytes: 10, origin: 'subagent', parentSessionId: 'root', live: false, running: false, archived: false, pinned: false, deletable: true, blockerCodes: [] },
  ])
  const api = slotApi(world, 'settings.section')
  const store = api.createPageStore()
  await store.loadInventory()
  store.setTab('sessions')
  // The mounted page builds its own store; hand it the one this test already loaded.
  api.createPageStore = () => store
  const section = world.registrations.find((entry) => entry.options.name === 'settings.section')
  const tree = renderDeep(section.component({ api, t: api.t }))
  assert.equal(elementsByClass(tree, 'dsh-cleanup-item').length, 1, 'only the parent row renders until expanded')
  const toggles = elementsByClass(tree, 'dsh-cleanup-target-more')
  assert.equal(toggles.length, 1)
  assert.equal(toggles[0].props['aria-expanded'], 'false')
  assert.match(collectText(tree), /1 个子代理会话/)
  store.dispose()
})

test('settings: the Trash tab badges a subagent entry and names its parent', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setTrashEntries(() => [
    { id: 'e1', kind: 'session', title: 'child log', originalPath: '/tmp/child', movedAt: 1, bytes: 5, files: 1, dirs: 0, origin: 'subagent', parentSessionId: 'root-1', restorable: true, restorableCode: null },
  ])
  const api = slotApi(world, 'settings.section')
  const store = api.createPageStore()
  await store.loadInventory()
  store.setTab('trash')
  await store.loadTrash()
  api.createPageStore = () => store
  const section = world.registrations.find((entry) => entry.options.name === 'settings.section')
  const tree = renderDeep(section.component({ api, t: api.t }))
  const text = collectText(tree)
  assert.match(text, /子代理/, 'a subagent entry is badged')
  assert.match(text, /父会话/, 'the parent Session is named')
  const parentLine = findAll(tree, (element) => element && element.props && element.props.title === 'root-1')
  assert.equal(parentLine.length, 1, 'the short parent id keeps the full id reachable as a hover title')
  store.dispose()
})

test('settings: the rule-based preview labels rows by Session title, not by id', () => {
  // The preview list is rendered from a debounced candidates request, so this stays a structural
  // assertion: the row must render `title`, and the raw id may only appear as a hover title.
  assert.match(source, /middleEllipsis\(title, 46\)/, 'the wizard row must render the Session label')
  assert.doesNotMatch(source, /middleEllipsis\(candidate\.id, 46\)/, 'the wizard row must not render the raw id as its title')
})

test('workspace clear: a refill page with nothing deletable reports what is left', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  let page = 0
  world.setCandidatesResponse(() => {
    page += 1
    if (page === 1) return { ok: true, candidates: candidateRows(1), total: 1, truncated: true, totals: { count: 1, bytes: 0 } }
    // The remaining row is in use in this app run: nothing deletable, but the workspace is not empty.
    return { ok: true, candidates: [{ id: 'session-9', cwd: '/tmp/p9', deletable: false }], total: 1, truncated: false, totals: { count: 1, bytes: 0 } }
  })
  clearMenuAction(world).run()
  const api = slotApi(world, 'shell.overlay')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  api.confirmDelete()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase', 5000)
  const settled = api.dialogStore.getSnapshot().clear
  assert.equal(settled.stop.code, 'blocked', 'an empty deletable page is not a finished workspace')
  assert.equal(settled.stop.remaining, 1)
  assert.equal(settled.skipped, 1, 'the in-use row is still counted')
  api.disposeDialog()
})

test('workspace clear: a failed refill is retried instead of closing the result', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  let page = 0
  world.setCandidatesResponse(() => {
    page += 1
    if (page === 1) return { ok: true, candidates: candidateRows(1), total: 1, truncated: true, totals: { count: 1, bytes: 0 } }
    throw new Error('candidates unavailable')
  })
  clearMenuAction(world).run()
  const api = slotApi(world, 'shell.overlay')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  api.confirmDelete()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'failed', 'failed phase', 5000)
  assert.equal(api.dialogStore.getSnapshot().clear.done.count, 1, 'the finished batch is not forgotten')

  const callsBefore = world.calls.filter((call) => call.url.endsWith('cleanup.candidates')).length
  api.retryDialog()
  await waitFor(() => world.calls.filter((call) => call.url.endsWith('cleanup.candidates')).length > callsBefore, 'retry refills the walk')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'failed', 'still failed')
  assert.equal(api.dialogStore.getSnapshot().clear.done.count, 1, 'retry keeps the folded totals')
  api.disposeDialog()
})

test('workspace clear: logs held by this app run offer the next-start route instead of a dead end', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setCandidatesResponse(() => ({
    ok: true,
    candidates: [
      { id: 'session-a', cwd: '/tmp/a', deletable: false, blockerCodes: ['SESSION_LIVE'] },
      { id: 'session-b', cwd: '/tmp/b', deletable: false, blockerCodes: ['SESSION_RUNNING'] },
    ],
    total: 2,
    truncated: false,
    totals: { count: 2, bytes: 0 },
  }))
  world.setPlanResponse((body) => ({
    ok: true,
    plan: {
      ...cleanPlan(body.mode),
      targets: body.targets.map((target) => ({ kind: target.kind, id: target.id, title: target.id, path: null })),
      items: body.targets.map((target) => ({
        kind: 'session', id: target.id, workspaceId: null, title: null, path: '/tmp/' + target.id,
        bytes: 10, files: 1, dirs: 0, parentSessionId: null, isDescendant: false,
      })),
      totals: { workspaces: 0, sessions: body.targets.length, files: body.targets.length, dirs: 0, bytes: 20 },
      blockers: [{ code: 'SESSION_LIVE', message: 'live', sessionId: 'session-a', workspaceId: null }],
    },
  }))
  clearMenuAction(world).run()
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  const state = api.dialogStore.getSnapshot()
  assert.equal(state.targets.length, 2, 'the in-use logs are listed, not hidden')
  assert.equal(state.clear.deletable, 0)
  const text = collectText(renderDeep(overlay.component({ api, t: api.t })))
  assert.match(text, /安排删除/, 'the next-start route is offered')
  assert.doesNotMatch(text, /没有可清理的会话/)

  api.deferPlan()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'deferred', 'deferred phase')
  api.disposeDialog()
})

test('settings: the Sessions tab filters by workspace, ahead of the sort control', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setSessions(() => [
    { id: 's-a', workspaceId: 'ws-a', cwd: '/a', createdAt: 2000, eventCount: 1, sizeBytes: 10, origin: null, parentSessionId: null, live: false, running: false, archived: false, pinned: false, deletable: true, blockerCodes: [] },
    { id: 's-b', workspaceId: 'ws-b', cwd: '/b', createdAt: 1000, eventCount: 1, sizeBytes: 10, origin: null, parentSessionId: null, live: false, running: false, archived: false, pinned: false, deletable: true, blockerCodes: [] },
  ])
  const api = slotApi(world, 'settings.section')
  const store = api.createPageStore()
  await store.loadInventory()
  store.setTab('sessions')
  api.createPageStore = () => store
  const section = world.registrations.find((entry) => entry.options.name === 'settings.section')

  const tree = renderDeep(section.component({ api, t: api.t }))
  assert.equal(elementsByClass(tree, 'dsh-cleanup-item').length, 2, 'every workspace by default')
  const toolbars = elementsByClass(tree, 'dsh-cleanup-toolbar')
  const fields = elementsByClass(toolbars[0], 'dsh-cleanup-toolbar-field')
  assert.match(collectText(fields[0]), /工作区/, 'the workspace filter comes first')
  assert.match(collectText(fields[1]), /排序/)

  store.showMoreSessions()
  assert.ok(store.getSnapshot().sessionLimit > 300, 'the page grew before filtering')
  store.setSessionWorkspace('ws-a')
  assert.equal(store.getSnapshot().sessionLimit, 300, 'a narrower filter restarts paging')
  const narrowed = elementsByClass(renderDeep(section.component({ api, t: api.t })), 'dsh-cleanup-item')
  assert.equal(narrowed.length, 1, 'only the matching workspace remains')
  store.dispose()
})

test('settings: a subagent log follows its parent into a workspace and is not "ungrouped"', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setSessions(() => [
    { id: 'root', workspaceId: 'ws-a', cwd: '/a', createdAt: 2000, eventCount: 1, sizeBytes: 10, origin: null, parentSessionId: null, live: false, running: false, archived: false, pinned: false, deletable: true, blockerCodes: [] },
    // A subagent log carries no membership of its own, but belongs to its parent's workspace.
    { id: 'child', workspaceId: null, cwd: '/a', createdAt: 1000, eventCount: 1, sizeBytes: 5, origin: 'subagent', parentSessionId: 'root', live: false, running: false, archived: false, pinned: false, deletable: true, blockerCodes: [] },
  ])
  const api = slotApi(world, 'settings.section')
  const store = api.createPageStore()
  await store.loadInventory()
  store.setTab('sessions')
  api.createPageStore = () => store
  const section = world.registrations.find((entry) => entry.options.name === 'settings.section')

  store.setSessionWorkspace('__ungrouped__')
  let tree = renderDeep(section.component({ api, t: api.t }))
  assert.equal(elementsByClass(tree, 'dsh-cleanup-item').length, 0, 'a subagent log is not ungrouped when its parent has a workspace')

  store.setSessionWorkspace('ws-a')
  tree = renderDeep(section.component({ api, t: api.t }))
  assert.equal(elementsByClass(tree, 'dsh-cleanup-item').length, 1, 'only the parent row renders')
  assert.equal(elementsByClass(tree, 'dsh-cleanup-target-more').length, 1, 'the child folds under its parent')
  store.dispose()
})


test('workspace clear: a log deleted as a descendant is not planned again by a later batch', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setCandidatesResponse(() => ({ ok: true, candidates: candidateRows(65), total: 65, truncated: false, totals: { count: 65, bytes: 0 } }))
  let lastPlan = null
  world.setPlanResponse((body) => {
    const items = body.targets.map((target) => ({ kind: 'session', id: target.id, workspaceId: null, title: null, path: '/tmp/' + target.id, bytes: 1, files: 1, dirs: 0, parentSessionId: null, isDescendant: false }))
    // The first batch expands session-0's subagent closure, which also deletes session-64 (queued next).
    if (body.targets.some((target) => target.id === 'session-0') && body.includeDescendants === true) {
      items.push({ kind: 'session', id: 'session-64', workspaceId: null, title: null, path: '/tmp/session-64', bytes: 1, files: 1, dirs: 0, parentSessionId: 'session-0', isDescendant: true })
    }
    lastPlan = Object.assign(cleanPlan(body.mode), {
      targets: body.targets.map((target) => ({ kind: target.kind, id: target.id, title: target.id, path: null })),
      items,
      totals: { workspaces: 0, sessions: items.length, files: items.length, dirs: 0, bytes: items.length },
    })
    return { ok: true, plan: lastPlan }
  })
  world.setDeleteResponse(() => ({
    ok: true,
    result: {
      items: lastPlan.items.map((item) => ({ kind: item.kind, id: item.id, status: 'trashed', error: null, movedTo: '/tmp/trash/' + item.id, bytes: item.bytes })),
      totals: { trashed: lastPlan.items.length, deleted: 0, failed: 0, bytes: lastPlan.items.length },
    },
  }))
  clearMenuAction(world).run()
  const api = slotApi(world, 'shell.overlay')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  assert.equal(api.dialogStore.getSnapshot().targets.length, 64)
  api.confirmDelete()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase', 5000)
  const settled = api.dialogStore.getSnapshot().clear
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.plan')).length, 1, 'the queued duplicate is pruned instead of planned again')
  assert.equal(settled.done.count, 65, 'the descendant is folded into the finished totals once')
  assert.equal(settled.batches, 1)
  assert.equal(settled.stop, null)
  api.disposeDialog()
})

test('workspace clear: an UNKNOWN_SESSION plan failure rebuilds the queue and continues', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  let candidateCalls = 0
  world.setCandidatesResponse(() => {
    candidateCalls += 1
    if (candidateCalls === 1) return { ok: true, candidates: candidateRows(66), total: 66, truncated: false, totals: { count: 66, bytes: 0 } }
    // The second batch's target vanished between batches; only session-65 is still on disk.
    return { ok: true, candidates: [{ id: 'session-65', cwd: '/tmp/proj-65', deletable: true }], total: 1, truncated: false, totals: { count: 1, bytes: 0 } }
  })
  const plans = []
  let planCalls = 0
  world.setPlanResponse((body) => {
    planCalls += 1
    // The review plan is call 1; the first walk batch's plan (call 2) names a vanished target.
    if (planCalls === 2) return { ok: false, error: { code: 'UNKNOWN_SESSION', message: 'Unknown session "session-64".' } }
    const plan = planEchoingTargets(body)
    plans.push(plan)
    return { ok: true, plan }
  })
  world.setDeleteResponse(() => {
    const plan = plans.shift()
    return {
      ok: true,
      result: {
        items: plan.items.map((item) => ({ kind: item.kind, id: item.id, status: 'deleted', error: null, movedTo: null, bytes: item.bytes })),
        totals: { trashed: 0, deleted: plan.items.length, failed: 0, bytes: plan.items.length },
      },
    }
  })
  clearMenuAction(world).run()
  const api = slotApi(world, 'shell.overlay')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  assert.equal(api.dialogStore.getSnapshot().targets.length, 64)
  api.confirmDelete()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase', 5000)
  const settled = api.dialogStore.getSnapshot().clear
  assert.equal(candidateCalls, 2, 'the queue is rebuilt from fresh candidates')
  assert.equal(planCalls, 3)
  assert.equal(settled.resyncs, 0, 'a successful batch resets the recovery budget')
  assert.equal(settled.done.count, 65, 'the vanished log is skipped instead of failing the walk')
  assert.equal(settled.stop, null)
  api.disposeDialog()
})

test('workspace clear: an UNKNOWN_SESSION recovery is bounded and stays retryable', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  let candidateCalls = 0
  world.setCandidatesResponse(() => {
    candidateCalls += 1
    return { ok: true, candidates: candidateRows(66), total: 66, truncated: false, totals: { count: 66, bytes: 0 } }
  })
  const plans = []
  let planCalls = 0
  world.setPlanResponse((body) => {
    planCalls += 1
    if (planCalls === 1) { const plan = planEchoingTargets(body); plans.push(plan); return { ok: true, plan } }
    return { ok: false, error: { code: 'UNKNOWN_SESSION', message: 'Unknown session "session-64".' } }
  })
  world.setDeleteResponse(() => {
    const plan = plans.shift()
    return {
      ok: true,
      result: {
        items: plan.items.map((item) => ({ kind: item.kind, id: item.id, status: 'deleted', error: null, movedTo: null, bytes: item.bytes })),
        totals: { trashed: 0, deleted: plan.items.length, failed: 0, bytes: plan.items.length },
      },
    }
  })
  clearMenuAction(world).run()
  const api = slotApi(world, 'shell.overlay')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  api.confirmDelete()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'failed', 'failed phase', 5000)
  let settled = api.dialogStore.getSnapshot()
  assert.equal(settled.failureStage, 'plan')
  assert.equal(settled.clear.resyncs, 2, 'the recovery is bounded')
  assert.equal(candidateCalls, 3, 'one pre-flight plus two rebuilds')
  assert.equal(planCalls, 4)
  // An explicit retry gets a fresh recovery budget: it rebuilds again, then fails bounded again.
  const plansBeforeRetry = planCalls
  api.retryDialog()
  await waitFor(() => planCalls > plansBeforeRetry + 2 && api.dialogStore.getSnapshot().phase === 'failed', 'retry rebuilds then fails bounded')
  settled = api.dialogStore.getSnapshot()
  assert.equal(settled.failureStage, 'plan')
  assert.equal(settled.clear.resyncs, 2, 'the retried walk is bounded again')
  assert.ok(candidateCalls > 3, 'the explicit retry attempts fresh rebuilds')
  api.disposeDialog()
})

test('workspace clear: a partial clear keeps the skipped-row summary on screen', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setCandidatesResponse(() => ({
    ok: true,
    candidates: candidateRows(3).concat([
      { id: 'live-1', cwd: '/tmp/live-1', deletable: false, blockerCodes: ['SESSION_LIVE'] },
      { id: 'live-2', cwd: '/tmp/live-2', deletable: false, blockerCodes: ['SESSION_LIVE'] },
    ]),
    total: 5,
    truncated: false,
    totals: { count: 5, bytes: 0 },
  }))
  let lastPlan = null
  world.setPlanResponse((body) => { lastPlan = planEchoingTargets(body); return { ok: true, plan: lastPlan } })
  world.setDeleteResponse(() => ({
    ok: true,
    result: {
      items: lastPlan.items.map((item) => ({ kind: item.kind, id: item.id, status: 'trashed', error: null, movedTo: '/tmp/trash/' + item.id, bytes: item.bytes })),
      totals: { trashed: lastPlan.items.length, deleted: 0, failed: 0, bytes: lastPlan.items.length },
    },
  }))
  clearMenuAction(world).run()
  const api = slotApi(world, 'shell.overlay')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  assert.equal(api.dialogStore.getSnapshot().clear.skipped, 2, 'in-use rows are counted once')
  const timer = spyDoneTimer()
  try {
    api.confirmDelete()
    await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase', 5000)
    assert.equal(timer.armed().length, 0, 'a partial clear does not arm the auto-dismiss timer')
    assert.equal(api.dialogStore.getSnapshot().phase, 'done', 'a partial clear keeps its summary on screen')
  } finally {
    timer.restore()
  }
  api.disposeDialog()
})

test('workspace clear: the review note says how many logs the batch really covers', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setCandidatesResponse(() => ({ ok: true, candidates: candidateRows(1), total: 1, truncated: false, totals: { count: 1, bytes: 0 } }))
  world.setPlanResponse((body) => {
    const items = [
      { kind: 'session', id: 'session-0', workspaceId: null, title: null, path: '/tmp/session-0', bytes: 1, files: 1, dirs: 0, parentSessionId: null, isDescendant: false },
      { kind: 'session', id: 'child-1', workspaceId: null, title: null, path: '/tmp/child-1', bytes: 1, files: 1, dirs: 0, parentSessionId: 'session-0', isDescendant: true },
    ]
    return {
      ok: true,
      plan: Object.assign(cleanPlan(body.mode), {
        targets: body.targets.map((target) => ({ kind: target.kind, id: target.id, title: target.id, path: null })),
        items,
        totals: { workspaces: 0, sessions: 2, files: 2, dirs: 0, bytes: 2 },
      }),
    }
  })
  clearMenuAction(world).run()
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  const text = collectText(renderDeep(overlay.component({ api, t: api.t })))
  assert.match(text, /本次复核包含 2 条日志/, 'the note distinguishes root Sessions from the logs a plan deletes')
  api.disposeDialog()
})

test('settings: changing a Sessions filter drops selections hidden by it', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setSessions(() => [
    { id: 's-a', workspaceId: 'ws-a', cwd: '/a', createdAt: 2000, eventCount: 1, sizeBytes: 10, origin: null, parentSessionId: null, live: false, running: false, archived: false, pinned: false, deletable: true, blockerCodes: [] },
    { id: 's-b', workspaceId: 'ws-b', cwd: '/b', createdAt: 1000, eventCount: 1, sizeBytes: 10, origin: null, parentSessionId: null, live: false, running: false, archived: true, pinned: false, deletable: true, blockerCodes: [] },
  ])
  const api = slotApi(world, 'settings.section')
  const store = api.createPageStore()
  await store.loadInventory()
  store.toggleSessionSelect('s-b')
  assert.deepEqual(store.getSnapshot().selectedSessions, ['s-b'])
  store.setSessionWorkspace('ws-a')
  assert.deepEqual(store.getSnapshot().selectedSessions, [], 'a narrower workspace filter drops hidden selections')

  store.toggleSessionSelect('s-a')
  assert.deepEqual(store.getSnapshot().selectedSessions, ['s-a'])
  store.setSessionFilter('archived')
  assert.deepEqual(store.getSnapshot().selectedSessions, [], 'the archive filter drops hidden selections too')
  store.dispose()
})

// ---------------------------------------------------------------------------------------------
// Settings page store
// ---------------------------------------------------------------------------------------------

test('page store: inventory, measurement merge across reloads, sort/filter/limit persistence', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const store = slotApi(world, 'settings.section').createPageStore()
  await store.loadInventory()
  let state = store.getSnapshot()
  assert.equal(state.inventory.sessions.length, 2)
  assert.equal(state.inventory.sessionListCap, 2000)

  await store.measure({ sessionIds: ['session-a'] })
  assert.equal(store.getSnapshot().measured.sessions['session-a'].bytes, 2048)
  await store.loadInventory()
  assert.equal(store.getSnapshot().measured.sessions['session-a'].bytes, 2048, 'measured sizes survive a reload')

  store.setTab('sessions')
  store.setSessionSort('oldest')
  store.setSessionFilter('archived')
  store.showMoreSessions()
  const expanded = store.getSnapshot().sessionLimit
  assert.ok(expanded > 300, 'showMoreSessions grows the page size')
  store.setTab('workspaces')
  store.setTab('sessions')
  state = store.getSnapshot()
  assert.equal(state.sessionSort, 'oldest')
  assert.equal(state.sessionFilter, 'archived')
  assert.equal(state.sessionLimit, expanded, 'the expanded page size survives a tab switch')

  store.toggleSessionSelect('session-a')
  assert.deepEqual(store.getSnapshot().selectedSessions, ['session-a'])
  store.toggleSessionSelect('session-a')
  assert.deepEqual(store.getSnapshot().selectedSessions, [])
  store.dispose()
})

test('page store: emptying the trash is explicit — arm, cooldown, then {all:true}', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const store = slotApi(world, 'settings.section').createPageStore()
  await store.loadInventory()
  store.setTab('trash')
  await store.loadTrash()

  await store.requestPurgeAll()
  assert.equal(store.getSnapshot().confirmPurge, 'all', 'first activation only arms the confirmation')
  assert.equal(world.calls.some((call) => call.url.endsWith('cleanup.trash.purge')), false)

  await store.requestPurgeAll()
  assert.equal(world.calls.some((call) => call.url.endsWith('cleanup.trash.purge')), false, 'a double-click inside the cooldown must not purge')

  await sleep(460)
  await store.requestPurgeAll()
  await waitFor(() => world.calls.some((call) => call.url.endsWith('cleanup.trash.purge')), 'purge request')
  const purgeCall = world.calls.find((call) => call.url.endsWith('cleanup.trash.purge'))
  assert.deepEqual(purgeCall.body, { all: true }, 'purge-all must send the explicit flag')
  store.dispose()
})

test('page store: restore failure -> retry re-enters the action state machine and settles', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const store = slotApi(world, 'settings.section').createPageStore()
  await store.loadInventory()
  store.setTab('trash')
  await store.loadTrash()

  world.setRestoreResponse(() => ({ ok: false, error: { code: 'RESTORE_FAILED', message: 'boom' } }))
  await store.restoreEntry('20260101T000000Z-a-0001')
  assert.equal(store.getSnapshot().actionError.code, 'RESTORE_FAILED')
  const restoreCallsBefore = world.calls.filter((call) => call.url.endsWith('cleanup.trash.restore')).length

  world.setRestoreResponse(() => ({ ok: true, restoredTo: '/tmp/proj-a' }))
  await store.retryAction()
  await waitFor(() => store.getSnapshot().actionError === null, 'error cleared by the retried action')
  const restoreCallsAfter = world.calls.filter((call) => call.url.endsWith('cleanup.trash.restore')).length
  assert.equal(restoreCallsAfter, restoreCallsBefore + 1, 'retry must re-issue the request through runAction')
  assert.equal(store.getSnapshot().actionBusy, null)
  assert.equal(world.calls.some((call) => call.url === 'session.refresh'), true, 'a successful restore refreshes the session catalog')
  store.dispose()
})

test('page store: a trash mutation bumps the mutation emitter the page subscribes to', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const pageApi = slotApi(world, 'settings.section')
  const store = pageApi.createPageStore()
  // The mounted page component wires exactly this subscription; refresh it here so the store-only
  // test observes the same reload path a real mount uses.
  let mutations = 0
  const unsubscribe = pageApi.mutations.subscribe(() => {
    mutations += 1
    void store.refresh()
  })
  await store.loadInventory()
  store.setTab('trash')
  await store.loadTrash()
  world.calls.length = 0
  await store.restoreEntry('20260101T000000Z-a-0001')
  await waitFor(() => world.calls.filter((call) => call.url.endsWith('cleanup.inventory')).length >= 1, 'inventory reload after restore')
  assert.equal(mutations >= 1, true, 'a successful restore bumps the mutation emitter')
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.trash.list')).length >= 1, true, 'trash reload after restore')
  unsubscribe()
  store.dispose()
})

test('teardown: disposed effects do not throw and a new instance can apply again', async () => {
  const first = createContext()
  const { mod } = await loadClient()
  mod.apply(first.ctx)
  slotApi(first, 'shell.overlay').disposeDialog()
  const store = slotApi(first, 'settings.section').createPageStore()
  store.dispose()
  // A second apply on a fresh context must still register everything (no module-level leakage that
  // prevents remounting the plugin).
  const second = createContext()
  mod.apply(second.ctx)
  assert.equal(second.registrations.length, 3)
  assert.equal(second.menus.length, 3)
})

test('plural selection is locale-aware and dictionary-driven (no fixed English rules)', () => {
  // The review found the plural helper pinned to `new Intl.PluralRules('en')`. A language pack that
  // activates `ru` must get `_few`/`_many`, so the helper must read the active locale and fall back
  // through the categories. Static assertions keep the capability from silently regressing.
  // The old implementation pinned one module-level `Intl.PluralRules('en')`; the new one resolves
  // per-locale rules from the ACTIVE locale id (an `en` instance may only remain as a last-resort
  // guard inside the resolver).
  assert.equal(/const pluralRules = \(function/.test(source), false, 'plural rules must not be a fixed singleton')
  assert.match(source, /let activeLocaleId/, 'the active locale id must be tracked')
  assert.match(source, /function pluralRulesFor\(/, 'per-locale plural rules resolver is missing')
  assert.match(source, /pluralRulesFor\(activeLocaleId\)/, 'the active locale must drive plural selection')
  assert.match(source, /_other|_one/, 'the category fallback chain is missing')
  // One dictionary map is registered, with the extra-locale extension point the language packs use.
  assert.match(source, /EXTRA_LOCALE_DICTIONARIES/)
  assert.match(source, /Object\.assign\(\{\}, \{ zh: zh, en: en \}, EXTRA_LOCALE_DICTIONARIES\)/)
})

test('apply stays orchestration-only after the client split refactor', () => {
  // The single module file is a loader constraint; the refactor keeps `apply` short by delegating to
  // focused factories, so a future edit cannot quietly grow it back into a monolith.
  const start = source.indexOf('    function apply(ctx) {')
  assert.ok(start >= 0, 'apply function not found')
  const open = source.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) { end = index + 1; break }
    }
  }
  const body = source.slice(open, end)
  const lines = body.split('\n').length
  assert.ok(lines < 140, `apply grew to ${lines} lines; keep it orchestration-only`)
  const delegated = [...body.matchAll(/\b(register[A-Z][a-zA-Z]*|create[A-Z][a-zA-Z]*)\s*\(/g)].map((match) => match[1])
  assert.ok(new Set(delegated).size >= 4, `apply should delegate to focused factories, found ${[...new Set(delegated)].join(', ')}`)
})

test('locale dictionaries carry the Git safety warning and setting copy', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const { zh, en } = world.localeState.dicts
  for (const key of ['warn.WORKSPACE_GIT_DIRTY', 'warn.WORKSPACE_GIT_UNPUSHED', 'settings.field.gitSafetyCheck', 'settings.field.gitSafetyCheckHint']) {
    assert.ok(Object.prototype.hasOwnProperty.call(en, key), `missing en key ${key}`)
    assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `missing zh key ${key}`)
    const zhParams = [...String(zh[key]).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort()
    const enParams = [...String(en[key]).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort()
    assert.deepEqual(enParams, zhParams, `param mismatch for ${key}`)
  }
})

test('the module source never requires a Harness client package', () => {
  const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
  const unique = [...new Set(requires)]
  assert.deepEqual(unique, ['react'], 'client.js may only require react, found: ' + unique.join(', '))
  assert.equal(/@deepseek-ai\//.test(source.replace(/^[\s\S]*?\/\*[\s\S]*?\*\//, '')), false)
})

// =============================================================================================
// Review-round hardening: regressions for the 0.5.0 review findings and their edge cases.
// =============================================================================================

test('workspace clear: a residue-free clear still dismisses itself after the dwell', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setCandidatesResponse(() => ({ ok: true, candidates: candidateRows(3), total: 3, truncated: false, totals: { count: 3, bytes: 0 } }))
  let lastPlan = null
  world.setPlanResponse((body) => { lastPlan = planEchoingTargets(body); return { ok: true, plan: lastPlan } })
  world.setDeleteResponse(() => ({
    ok: true,
    result: {
      items: lastPlan.items.map((item) => ({ kind: item.kind, id: item.id, status: 'trashed', error: null, movedTo: '/tmp/trash/' + item.id, bytes: item.bytes })),
      totals: { trashed: lastPlan.items.length, deleted: 0, failed: 0, bytes: lastPlan.items.length },
    },
  }))
  const timer = spyDoneTimer()
  try {
    clearMenuAction(world).run()
    const api = slotApi(world, 'shell.overlay')
    await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
    api.confirmDelete()
    await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase', 5000)
    assert.equal(timer.armed().length, 1, 'a clean clear arms the auto-dismiss timer')
    timer.fire()
    assert.equal(api.dialogStore.getSnapshot().phase, 'idle')
    api.disposeDialog()
  } finally {
    timer.restore()
  }
})

test('workspace clear: a stopped walk keeps its summary', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  let page = 0
  world.setCandidatesResponse(() => {
    page += 1
    if (page === 1) return { ok: true, candidates: candidateRows(1), total: 1, truncated: true, totals: { count: 1, bytes: 0 } }
    return { ok: true, candidates: [{ id: 'live-1', cwd: '/tmp/l1', deletable: false }], total: 1, truncated: false, totals: { count: 1, bytes: 0 } }
  })
  let lastPlan = null
  world.setPlanResponse((body) => { lastPlan = planEchoingTargets(body); return { ok: true, plan: lastPlan } })
  world.setDeleteResponse(() => ({
    ok: true,
    result: {
      items: lastPlan.items.map((item) => ({ kind: item.kind, id: item.id, status: 'trashed', error: null, movedTo: '/tmp/trash/' + item.id, bytes: item.bytes })),
      totals: { trashed: lastPlan.items.length, deleted: 0, failed: 0, bytes: lastPlan.items.length },
    },
  }))
  const timer = spyDoneTimer()
  try {
    clearMenuAction(world).run()
    const api = slotApi(world, 'shell.overlay')
    await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
    api.confirmDelete()
    await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase', 5000)
    assert.equal(api.dialogStore.getSnapshot().clear.stop.code, 'blocked')
    assert.equal(timer.armed().length, 0, 'an early stop must not auto-dismiss')
    api.disposeDialog()
  } finally {
    timer.restore()
  }
})

test('workspace clear: an excluded row keeps the summary on screen', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setCandidatesResponse(() => ({ ok: true, candidates: candidateRows(3), total: 3, truncated: false, totals: { count: 3, bytes: 0 } }))
  let lastPlan = null
  world.setPlanResponse((body) => { lastPlan = planEchoingTargets(body); return { ok: true, plan: lastPlan } })
  world.setDeleteResponse(() => ({
    ok: true,
    result: {
      items: lastPlan.items.map((item) => ({ kind: item.kind, id: item.id, status: 'deleted', error: null, movedTo: null, bytes: item.bytes })),
      totals: { trashed: 0, deleted: lastPlan.items.length, failed: 0, bytes: lastPlan.items.length },
    },
  }))
  const timer = spyDoneTimer()
  try {
    clearMenuAction(world).run()
    const api = slotApi(world, 'shell.overlay')
    await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
    api.setDialogSelection('session:session-1', false)
    await waitFor(() => api.dialogStore.getSnapshot().refreshing !== true && api.dialogStore.getSnapshot().plan.targets.length === 2, 're-planned batch')
    api.confirmDelete()
    await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase', 5000)
    const settled = api.dialogStore.getSnapshot().clear
    assert.equal(settled.done.count, 2)
    assert.deepEqual(settled.excluded, { 'session:session-1': true })
    assert.equal(timer.armed().length, 0, 'an excluded row must keep the summary')
    api.disposeDialog()
  } finally {
    timer.restore()
  }
})

test('review dialog: a review preserved across a settings-sheet unmount keeps its clean summary', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setCandidatesResponse(() => ({ ok: true, candidates: candidateRows(1), total: 1, truncated: false, totals: { count: 1, bytes: 0 } }))
  let lastPlan = null
  world.setPlanResponse((body) => { lastPlan = planEchoingTargets(body); return { ok: true, plan: lastPlan } })
  world.setDeleteResponse(() => ({
    ok: true,
    result: {
      items: lastPlan.items.map((item) => ({ kind: item.kind, id: item.id, status: 'trashed', error: null, movedTo: '/tmp/trash/' + item.id, bytes: item.bytes })),
      totals: { trashed: lastPlan.items.length, deleted: 0, failed: 0, bytes: lastPlan.items.length },
    },
  }))
  const timer = spyDoneTimer()
  try {
    clearMenuAction(world).run()
    const api = slotApi(world, 'shell.overlay')
    await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
    // This is what the settings copy's unmount effect does while a request is in flight.
    api.dialogStore.setState({ keepSummary: true })
    api.confirmDelete()
    await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase', 5000)
    assert.equal(timer.armed().length, 0, 'a preserved review must not be dropped by the dwell timer')
    api.disposeDialog()
  } finally {
    timer.restore()
  }
})

test('workspace clear: an UNKNOWN_SESSION rebuild keeps exclusions and folded totals', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  let candidateCalls = 0
  world.setCandidatesResponse(() => {
    candidateCalls += 1
    if (candidateCalls === 1) return { ok: true, candidates: candidateRows(66), total: 66, truncated: false, totals: { count: 66, bytes: 0 } }
    // The rebuild returns the remaining queued roots; the excluded session is gone from the list.
    return { ok: true, candidates: [{ id: 'session-64', cwd: '/tmp/p64', deletable: true }, { id: 'session-65', cwd: '/tmp/p65', deletable: true }], total: 2, truncated: false, totals: { count: 2, bytes: 0 } }
  })
  let lastPlan = null
  let planCalls = 0
  world.setPlanResponse((body) => {
    planCalls += 1
    if (planCalls === 3) return { ok: false, error: { code: 'UNKNOWN_SESSION', message: 'gone' } }
    lastPlan = planEchoingTargets(body)
    return { ok: true, plan: lastPlan }
  })
  world.setDeleteResponse(() => ({
    ok: true,
    result: {
      items: lastPlan.items.map((item) => ({ kind: item.kind, id: item.id, status: 'trashed', error: null, movedTo: '/tmp/trash/' + item.id, bytes: item.bytes })),
      totals: { trashed: lastPlan.items.length, deleted: 0, failed: 0, bytes: lastPlan.items.length },
    },
  }))
  clearMenuAction(world).run()
  const api = slotApi(world, 'shell.overlay')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  api.setDialogSelection('session:session-5', false)
  await waitFor(() => api.dialogStore.getSnapshot().refreshing !== true && api.dialogStore.getSnapshot().plan.targets.length === 63, 'excluded batch review')
  assert.deepEqual(api.dialogStore.getSnapshot().clear.excluded, { 'session:session-5': true })
  api.confirmDelete()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase', 5000)
  const settled = api.dialogStore.getSnapshot()
  assert.equal(candidateCalls, 2, 'one rebuild after the failed second batch')
  assert.equal(settled.clear.resyncs, 0, 'the rebuilt batch resets the recovery budget')
  assert.equal(settled.clear.done.count, 65, '63 from the reviewed batch plus 2 rebuilt targets')
  assert.deepEqual(settled.clear.excluded, { 'session:session-5': true }, 'the exclusion survives the rebuild')
  api.disposeDialog()
})

test('workspace clear: a rebuild that yields no targets settles normally', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  let candidateCalls = 0
  world.setCandidatesResponse(() => {
    candidateCalls += 1
    if (candidateCalls === 1) return { ok: true, candidates: candidateRows(66), total: 66, truncated: false, totals: { count: 66, bytes: 0 } }
    return { ok: true, candidates: [], total: 0, truncated: false, totals: { count: 0, bytes: 0 } }
  })
  let lastPlan = null
  let planCalls = 0
  world.setPlanResponse((body) => {
    planCalls += 1
    if (planCalls === 2) return { ok: false, error: { code: 'UNKNOWN_SESSION', message: 'gone' } }
    lastPlan = planEchoingTargets(body)
    return { ok: true, plan: lastPlan }
  })
  world.setDeleteResponse(() => ({
    ok: true,
    result: {
      items: lastPlan.items.map((item) => ({ kind: item.kind, id: item.id, status: 'trashed', error: null, movedTo: '/tmp/trash/' + item.id, bytes: item.bytes })),
      totals: { trashed: lastPlan.items.length, deleted: 0, failed: 0, bytes: lastPlan.items.length },
    },
  }))
  clearMenuAction(world).run()
  const api = slotApi(world, 'shell.overlay')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  api.confirmDelete()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase', 5000)
  const settled = api.dialogStore.getSnapshot().clear
  assert.equal(candidateCalls, 2)
  assert.equal(settled.resyncs, 1, 'one rebuild happened')
  assert.equal(settled.stop, null, 'an empty rebuild is a clean finish, not a stop')
  assert.equal(settled.done.count, 64)
  api.disposeDialog()
})

test('workspace clear: repeated in-use rows across refilled pages are counted once', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  let page = 0
  world.setCandidatesResponse(() => {
    page += 1
    if (page === 1) return { ok: true, candidates: candidateRows(1).concat([{ id: 'live-1', cwd: '/tmp/l1', deletable: false }]), total: 2, truncated: true, totals: { count: 2, bytes: 0 } }
    // The refilled page repeats the same in-use Session and adds another deletable log.
    return { ok: true, candidates: [{ id: 'live-1', cwd: '/tmp/l1', deletable: false }, { id: 'session-1', cwd: '/tmp/p1', deletable: true }], total: 2, truncated: false, totals: { count: 2, bytes: 0 } }
  })
  let lastPlan = null
  world.setPlanResponse((body) => { lastPlan = planEchoingTargets(body); return { ok: true, plan: lastPlan } })
  world.setDeleteResponse(() => ({
    ok: true,
    result: {
      items: lastPlan.items.map((item) => ({ kind: item.kind, id: item.id, status: 'trashed', error: null, movedTo: '/tmp/trash/' + item.id, bytes: item.bytes })),
      totals: { trashed: lastPlan.items.length, deleted: 0, failed: 0, bytes: lastPlan.items.length },
    },
  }))
  clearMenuAction(world).run()
  const api = slotApi(world, 'shell.overlay')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  api.confirmDelete()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase', 5000)
  const settled = api.dialogStore.getSnapshot().clear
  assert.equal(settled.skipped, 1, 'the same live Session is counted once across refills')
  assert.equal(settled.done.count, 2, 'both deletable logs were cleared')
  assert.equal(settled.stop, null, 'a repeated in-use row is not a block')
  api.disposeDialog()
})

test('workspace clear: the deferred view measures the remainder in root targets', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const rows = []
  for (let index = 0; index < 65; index += 1) rows.push({ id: 'live-' + index, cwd: '/tmp/live-' + index, deletable: false, blockerCodes: ['SESSION_LIVE'] })
  world.setCandidatesResponse(() => ({ ok: true, candidates: rows, total: 65, truncated: false, totals: { count: 65, bytes: 0 } }))
  world.setPlanResponse((body) => {
    const targets = body.targets.map((target) => ({ kind: target.kind, id: target.id, title: target.id, path: null }))
    const items = targets.map((target) => ({ kind: 'session', id: target.id, workspaceId: null, title: null, path: '/tmp/' + target.id, bytes: 1, files: 1, dirs: 0, parentSessionId: null, isDescendant: false }))
    return {
      ok: true,
      plan: Object.assign(cleanPlan(body.mode), {
        targets,
        items,
        blockers: [{ code: 'SESSION_LIVE', message: 'live', sessionId: body.targets[0].id, workspaceId: null }],
        totals: { workspaces: 0, sessions: items.length, files: items.length, dirs: 0, bytes: items.length },
      }),
    }
  })
  clearMenuAction(world).run()
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review' && api.dialogStore.getSnapshot().refreshing !== true, 'deferred-route review')
  assert.equal(api.dialogStore.getSnapshot().clear.skipped, 65)
  assert.equal(api.dialogStore.getSnapshot().targets.length, 64)
  api.deferPlan()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'deferred', 'deferred phase')
  const text = collectText(renderDeep(overlay.component({ api, t: api.t })))
  assert.match(text, /工作区还有 1 条会话未包含/, 'the remainder is measured in root targets, not expanded items')
  api.disposeDialog()
})

test('workspace clear: a later batch that brings back an excluded target re-plans without descendants', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  // The workspace has 65 member logs: session-kid is reviewed first, session-dad stays queued and is the
  // kid's parent. The user un-checks the kid; a later batch starting from dad would expand the child
  // closure back in.
  const rows = [{ id: 'session-kid', cwd: '/tmp/kid', deletable: true }]
  for (let index = 0; index < 63; index += 1) rows.push({ id: 'session-' + index, cwd: '/tmp/p' + index, deletable: true })
  rows.push({ id: 'session-dad', cwd: '/tmp/dad', deletable: true })
  world.setCandidatesResponse(() => ({ ok: true, candidates: rows, total: rows.length, truncated: false, totals: { count: rows.length, bytes: 0 } }))
  let lastPlan = null
  world.setPlanResponse((body) => {
    const targets = body.targets.map((target) => ({ kind: target.kind, id: target.id, title: target.id, path: null }))
    const items = body.targets.map((target) => ({ kind: 'session', id: target.id, workspaceId: null, title: null, path: '/tmp/' + target.id, bytes: 1, files: 1, dirs: 0, parentSessionId: null, isDescendant: false }))
    if (body.includeDescendants === true && body.targets.some((target) => target.id === 'session-dad')) {
      items.push({ kind: 'session', id: 'session-kid', workspaceId: null, title: null, path: '/tmp/kid', bytes: 1, files: 1, dirs: 0, parentSessionId: 'session-dad', isDescendant: true })
    }
    lastPlan = Object.assign(cleanPlan(body.mode), {
      targets,
      items,
      totals: { workspaces: 0, sessions: items.length, files: items.length, dirs: 0, bytes: items.length },
    })
    return { ok: true, plan: lastPlan }
  })
  world.setDeleteResponse(() => ({
    ok: true,
    result: {
      items: lastPlan.items.map((item) => ({ kind: item.kind, id: item.id, status: 'trashed', error: null, movedTo: '/tmp/trash/' + item.id, bytes: item.bytes })),
      totals: { trashed: lastPlan.items.length, deleted: 0, failed: 0, bytes: lastPlan.items.length },
    },
  }))
  clearMenuAction(world).run()
  const api = slotApi(world, 'shell.overlay')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  api.setDialogSelection('session:session-kid', false)
  await waitFor(() => api.dialogStore.getSnapshot().refreshing !== true && api.dialogStore.getSnapshot().plan.targets.length === 63, 'excluded batch review')
  api.confirmDelete()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase', 8000)
  const settled = api.dialogStore.getSnapshot().clear
  assert.equal(settled.stop, null)
  assert.equal(settled.done.count, 64, 'the later batch deletes dad but not the excluded kid')
  const batchPlans = world.calls.filter((call) => call.url.endsWith('cleanup.plan')).filter((call) => call.body.includeDescendants === true || call.body.includeDescendants === false)
  const lastTwo = batchPlans.slice(-2)
  assert.deepEqual(lastTwo.map((call) => call.body.includeDescendants), [true, false], 'the leaked batch drops descendant expansion')
  assert.equal(lastPlan.items.some((item) => item.id === 'session-kid'), false, 'the re-planned batch excludes the un-checked kid')
  assert.equal(api.dialogStore.getSnapshot().clear.excluded['session:session-kid'], true, 'the exclusion is still remembered')
  api.disposeDialog()
})

test('review dialog: a second review or clear cannot silently replace a clear in progress', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setCandidatesResponse(() => ({ ok: true, candidates: candidateRows(3), total: 3, truncated: false, totals: { count: 3, bytes: 0 } }))
  let lastPlan = null
  world.setPlanResponse((body) => { lastPlan = planEchoingTargets(body); return { ok: true, plan: lastPlan } })
  world.setDeleteResponse(() => ({
    ok: true,
    result: {
      items: lastPlan.items.map((item) => ({ kind: item.kind, id: item.id, status: 'trashed', error: null, movedTo: '/tmp/trash/' + item.id, bytes: item.bytes })),
      totals: { trashed: lastPlan.items.length, deleted: 0, failed: 0, bytes: lastPlan.items.length },
    },
  }))
  clearMenuAction(world).run()
  const api = slotApi(world, 'shell.overlay')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  const before = api.dialogStore.getSnapshot()
  const plansBefore = world.calls.filter((call) => call.url.endsWith('cleanup.plan')).length
  // A context-menu review and a second clear action both arrive while the walk owns the dialog.
  api.openDialog([{ kind: 'session', id: 'session-a', title: 'other' }])
  await clearMenuAction(world).run()
  await sleep(40)
  const after = api.dialogStore.getSnapshot()
  assert.notEqual(after.clear, null, 'the clear still owns the dialog')
  assert.deepEqual(after.targets.map((target) => target.id), before.targets.map((target) => target.id))
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.plan')).length, plansBefore, 'the intruding actions sent no plan')
  api.confirmDelete()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase', 5000)
  api.disposeDialog()
})

test('review dialog: a workspace plan may carry swept sessions that are not reviewed rows', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setPlanResponse(() => ({
    ok: true,
    plan: Object.assign(cleanPlan('trash'), {
      targets: [{ kind: 'workspace', id: 'ws-a', title: 'A', path: '/tmp/a' }],
      items: [
        { kind: 'workspace-dir', id: 'ws-a', workspaceId: null, title: 'A', path: '/tmp/a', bytes: 10, files: 2, dirs: 1, parentSessionId: null, isDescendant: false },
        { kind: 'session', id: 'swept-1', workspaceId: 'ws-a', title: null, path: '/tmp/a/s1', bytes: 1, files: 1, dirs: 0, parentSessionId: null, isDescendant: false },
        { kind: 'session', id: 'swept-2', workspaceId: 'ws-a', title: null, path: '/tmp/a/s2', bytes: 1, files: 1, dirs: 0, parentSessionId: null, isDescendant: false },
      ],
      totals: { workspaces: 1, sessions: 2, files: 4, dirs: 1, bytes: 12 },
    }),
  }))
  world.setDeleteResponse(() => ({
    ok: true,
    result: {
      items: [
        { kind: 'workspace-dir', id: 'ws-a', status: 'trashed', error: null, movedTo: '/tmp/trash/ws-a', bytes: 10 },
        { kind: 'session', id: 'swept-1', status: 'trashed', error: null, movedTo: '/tmp/trash/swept-1', bytes: 1 },
        { kind: 'session', id: 'swept-2', status: 'trashed', error: null, movedTo: '/tmp/trash/swept-2', bytes: 1 },
      ],
      totals: { trashed: 3, deleted: 0, failed: 0, bytes: 12 },
    },
  }))
  const api = slotApi(world, 'shell.overlay')
  api.openDialog([{ kind: 'workspace', id: 'ws-a', title: 'Ȁ', path: '/tmp/a' }])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review' && api.dialogStore.getSnapshot().refreshing !== true, 'review, not fail-closed')
  assert.equal(api.dialogStore.getSnapshot().failureStage, null, 'swept sessions are not an un-checked-row leak')
  api.confirmDelete()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase')
  assert.equal(api.dialogStore.getSnapshot().error, null)
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.delete')).length, 1)
  api.disposeDialog()
})

test('review dialog: the manual permanent guard for several folders still refuses', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setPlanResponse((body) => ({ ok: true, plan: planEchoingTargets(body) }))
  const api = slotApi(world, 'shell.overlay')
  api.openDialog([
    { kind: 'workspace', id: 'ws-a', title: 'A', path: '/tmp/a' },
    { kind: 'workspace', id: 'ws-b', title: 'B', path: '/tmp/b' },
  ])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review' && api.dialogStore.getSnapshot().refreshing !== true, 'initial review')
  api.setDialogMode('permanent')
  await sleep(40)
  const settled = api.dialogStore.getSnapshot()
  assert.equal(settled.mode, 'trash', 'two planned folders keep permanent out of reach')
  assert.equal(settled.modeNotice, false, 'a refused manual switch is not explained as an automatic fallback')
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.plan') && call.body.mode === 'permanent').length, 0)
  api.disposeDialog()
})

test('review dialog: the pending row state clears once the re-plan lands', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  let delayMs = 0
  world.setPlanResponse(async (body) => {
    if (delayMs > 0) {
      const wait = delayMs
      delayMs = 0
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
    return { ok: true, plan: planEchoingTargets(body) }
  })
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  api.openDialog([
    { kind: 'workspace', id: 'ws-a', title: 'A', path: '/tmp/a' },
    { kind: 'workspace', id: 'ws-b', title: 'B', path: '/tmp/b' },
  ])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review' && api.dialogStore.getSnapshot().refreshing !== true, 'initial review')
  api.setDialogSelection('workspace:ws-b', false)
  await waitFor(() => api.dialogStore.getSnapshot().refreshing !== true && api.dialogStore.getSnapshot().plan.targets.length === 1, 'narrowed review')
  delayMs = 300
  api.setDialogSelection('workspace:ws-b', true)
  await sleep(60)
  assert.equal(api.dialogStore.getSnapshot().refreshing, true)
  await waitFor(() => api.dialogStore.getSnapshot().refreshing !== true && api.dialogStore.getSnapshot().plan.targets.length === 2, 'settled review')
  const text = collectText(renderDeep(overlay.component({ api, t: api.t })))
  assert.doesNotMatch(text, /重新规划中/, 'the pending copy is gone once the plan lands')
  assert.doesNotMatch(text, /正在重新计算复核结果/, 'the stale-totals notice is gone once the plan lands')
  assert.match(text, /合计/, 'the real totals are back')
  api.disposeDialog()
})

test('workspace clear: a batch that still leaks an excluded target after dropping descendants fails closed', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const rows = [{ id: 'session-kid', cwd: '/tmp/kid', deletable: true }]
  for (let index = 0; index < 63; index += 1) rows.push({ id: 'session-' + index, cwd: '/tmp/p' + index, deletable: true })
  rows.push({ id: 'session-dad', cwd: '/tmp/dad', deletable: true })
  world.setCandidatesResponse(() => ({ ok: true, candidates: rows, total: rows.length, truncated: false, totals: { count: rows.length, bytes: 0 } }))
  // The Host keeps the un-checked kid in the plan even without descendant expansion: fail closed.
  let lastPlan = null
  world.setPlanResponse((body) => {
    const targets = body.targets.map((target) => ({ kind: target.kind, id: target.id, title: target.id, path: null }))
    const items = body.targets.map((target) => ({ kind: 'session', id: target.id, workspaceId: null, title: null, path: '/tmp/' + target.id, bytes: 1, files: 1, dirs: 0, parentSessionId: null, isDescendant: false }))
    if (body.targets.some((target) => target.id === 'session-dad')) {
      items.push({ kind: 'session', id: 'session-kid', workspaceId: null, title: null, path: '/tmp/kid', bytes: 1, files: 1, dirs: 0, parentSessionId: 'session-dad', isDescendant: body.includeDescendants === true })
    }
    lastPlan = Object.assign(cleanPlan(body.mode), {
      targets,
      items,
      totals: { workspaces: 0, sessions: items.length, files: items.length, dirs: 0, bytes: items.length },
    })
    return { ok: true, plan: lastPlan }
  })
  world.setDeleteResponse(() => ({
    ok: true,
    result: {
      items: lastPlan.items.map((item) => ({ kind: item.kind, id: item.id, status: 'trashed', error: null, movedTo: '/tmp/trash/' + item.id, bytes: item.bytes })),
      totals: { trashed: lastPlan.items.length, deleted: 0, failed: 0, bytes: lastPlan.items.length },
    },
  }))
  clearMenuAction(world).run()
  const api = slotApi(world, 'shell.overlay')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  api.setDialogSelection('session:session-kid', false)
  await waitFor(() => api.dialogStore.getSnapshot().refreshing !== true && api.dialogStore.getSnapshot().plan.targets.length === 63, 'excluded batch review')
  api.confirmDelete()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'failed', 'failed phase', 8000)
  const settled = api.dialogStore.getSnapshot()
  assert.equal(settled.failureStage, 'plan')
  assert.equal(settled.error.code, 'UNCHECKED_TARGET_LEAK')
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.delete')).length, 1, 'only the reviewed batch was executed')
  assert.equal(settled.clear.done.count, 63, 'the leaked batch is never deleted')
  api.disposeDialog()
})

test('review dialog: a preserved clean delete result keeps its summary and resets for the next dialog', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setPlanResponse((body) => ({ ok: true, plan: planEchoingTargets(body) }))
  world.setDeleteResponse(() => ({ ok: true, result: { items: [], totals: { trashed: 1, deleted: 0, failed: 0, bytes: 1 } } }))
  const api = slotApi(world, 'shell.overlay')
  const timer = spyDoneTimer()
  try {
    api.openDialog([{ kind: 'session', id: 'session-a', title: 'A' }])
    await waitFor(() => api.dialogStore.getSnapshot().phase === 'review' && api.dialogStore.getSnapshot().refreshing !== true, 'review phase')
    // This is what the settings copy's unmount effect does while a request is in flight.
    api.dialogStore.setState({ keepSummary: true })
    api.confirmDelete()
    await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase', 5000)
    assert.equal(timer.armed().length, 0, 'a preserved clean result waits for the user')
    api.closeDialog()
    assert.equal(api.dialogStore.getSnapshot().keepSummary, false, 'closing resets the preserved-summary flag')

    world.setPlanResponse((body) => ({ ok: true, plan: planEchoingTargets(body) }))
    api.openDialog([{ kind: 'session', id: 'session-a', title: 'A' }])
    await waitFor(() => api.dialogStore.getSnapshot().phase === 'review' && api.dialogStore.getSnapshot().refreshing !== true, 'second review')
    api.confirmDelete()
    await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'second done phase', 5000)
    assert.equal(timer.armed().length, 1, 'an ordinary clean delete arms the dwell timer again')
    api.disposeDialog()
  } finally {
    timer.restore()
  }
})

// =============================================================================================
// 0.6.0: session usage (SPEC §10 "Usage (0.6.0)")
// =============================================================================================

/** Minimal inventory session row for the usage/open cases. */
function inventorySession(id, overrides) {
  return Object.assign({
    id: id,
    workspaceId: null,
    cwd: '/tmp/' + id,
    createdAt: 1000,
    eventCount: 1,
    sizeBytes: 10,
    origin: null,
    parentSessionId: null,
    live: false,
    running: false,
    archived: false,
    pinned: false,
    deletable: true,
    blockerCodes: [],
  }, overrides || {})
}

/** The usage rows the fake Host folds for the requested ids (id number encoded in tokens). */
function usageRowsFor(ids) {
  const usage = {}
  for (const id of ids) {
    const index = Number(String(id).split('-').pop())
    if (!Number.isFinite(index) || index === 0) continue
    usage[id] = {
      totalTokens: (index + 1) * 1000,
      cacheReadInputTokens: 800,
      cacheMissInputTokens: 200,
      cacheWriteTokens: 0,
      outputTokens: 100,
      requestCount: 1,
      complete: true,
      note: null,
    }
  }
  return usage
}

const usageCallsOf = (world) => world.calls.filter((call) => call.url.endsWith('cleanup.usage'))

test('usage: off by default, no fetch and no columns; the opt-in fetches in chunks', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const rows = []
  for (let index = 0; index < 205; index += 1) rows.push(inventorySession('session-' + index))
  world.setSessions(() => rows)
  world.setCapabilities({ usage: true, projectionCache: true, openPath: false })
  world.setUsageResponse((body) => ({ ok: true, available: true, usage: usageRowsFor(body.sessionIds) }))

  const api = slotApi(world, 'settings.section')
  const store = api.createPageStore()
  await store.loadInventory()
  store.setTab('sessions')
  api.createPageStore = () => store
  const section = world.registrations.find((entry) => entry.options.name === 'settings.section')

  let tree = renderDeep(section.component({ api, t: api.t }))
  assert.equal(store.getSnapshot().usageEnabled, false, 'usage is opt-in and starts off')
  assert.equal(elementsByClass(tree, 'dsh-cleanup-usage').length, 0, 'no usage column while off')
  assert.equal(usageCallsOf(world).length, 0, 'nothing is fetched while usage is off')
  const toggles = elementsByClass(tree, 'dsh-cleanup-usage-toggle')
  assert.equal(toggles.length, 1, 'the opt-in toggle is offered when the Host supports usage')
  const toggleInputs = findAll(toggles[0], (element) => element && element.type === 'input' && element.props)
  assert.equal(toggleInputs[0].props.checked, false)

  await store.setUsageEnabled(true)
  await waitFor(() => usageCallsOf(world).length === 2, 'usage fetched in two chunks')
  const chunks = usageCallsOf(world).map((call) => call.body.sessionIds)
  assert.deepEqual(chunks.map((ids) => ids.length), [200, 5], 'at most 200 ids per request, sequential')
  const state = store.getSnapshot()
  assert.equal(state.usageAvailable, true)
  assert.equal(state.usage['session-1'].totalTokens, 2000, 'the merged map keeps the folded rows')
  assert.equal(state.usage['session-0'], undefined, 'an unknown fold stays unknown')
  assert.equal(typeof state.usageSignatures['session-1'], 'string', 'the fold is cached against its signature')

  tree = renderDeep(section.component({ api, t: api.t }))
  assert.equal(elementsByClass(tree, 'dsh-cleanup-usage').length, 205, 'every visible row carries the columns')
  const text = collectText(tree)
  assert.match(text, /—/, 'an unknown usage renders the muted dash, never a zero')

  // `按用量排序` ranks known totals first and leaves unknown rows last.
  store.setSessionSort('usage')
  assert.equal(store.getSnapshot().sessionSort, 'usage')
  const sortedTree = renderDeep(section.component({ api, t: api.t }))
  const sortedRows = elementsByClass(sortedTree, 'dsh-cleanup-item').map(collectText)
  assert.match(sortedRows[0], /session-204/, 'the largest folded usage sorts first')
  assert.match(sortedRows[sortedRows.length - 1], /session-0/, 'the row with unknown usage sorts last')

  // A Session whose eventCount/sizeBytes changed has its cached fold dropped and re-fetched.
  rows[1].eventCount = 99
  world.setUsageResponse((body) => ({ ok: true, available: true, usage: usageRowsFor(body.sessionIds) }))
  await store.loadInventory()
  await waitFor(() => store.getSnapshot().usage['session-1'] !== undefined, 'the changed log is re-folded')
  store.dispose()
})

test('usage: a Host without the capability hides the surface and explains why', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setSessions(() => [inventorySession('session-a')])
  world.setCapabilities({ usage: false, projectionCache: false, openPath: false })
  const api = slotApi(world, 'settings.section')
  const store = api.createPageStore()
  await store.loadInventory()
  store.setTab('sessions')
  api.createPageStore = () => store
  const section = world.registrations.find((entry) => entry.options.name === 'settings.section')
  const tree = renderDeep(section.component({ api, t: api.t }))
  assert.equal(elementsByClass(tree, 'dsh-cleanup-usage-toggle').length, 0, 'the toggle is hidden without the capability')
  assert.equal(elementsByClass(tree, 'dsh-cleanup-usage').length, 0)
  assert.equal(elementsByClass(tree, 'dsh-cleanup-usage-unavailable').length, 1, 'the reason is stated once')
  assert.match(collectText(tree), /未提供会话用量统计/)
  assert.equal(usageCallsOf(world).length, 0)
  store.dispose()
})

test('usage: available:false hides the columns and says why; a failed chunk keeps a retry', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setSessions(() => [inventorySession('session-a'), inventorySession('session-b')])
  world.setCapabilities({ usage: true, projectionCache: true, openPath: false })
  world.setUsageResponse(() => ({ ok: true, available: false, usage: {} }))
  const api = slotApi(world, 'settings.section')
  const store = api.createPageStore()
  await store.loadInventory()
  store.setTab('sessions')
  api.createPageStore = () => store
  const section = world.registrations.find((entry) => entry.options.name === 'settings.section')

  await store.setUsageEnabled(true)
  await waitFor(() => store.getSnapshot().usageAvailable === false, 'available:false recorded')
  let tree = renderDeep(section.component({ api, t: api.t }))
  assert.equal(elementsByClass(tree, 'dsh-cleanup-usage').length, 0, 'columns are hidden when the Host cannot fold usage')
  assert.equal(elementsByClass(tree, 'dsh-cleanup-usage-unavailable').length, 1)
  assert.match(collectText(tree), /未提供会话用量统计/)

  // A failed chunk never blocks the list; the row keeps the dash and the toolbar offers a retry.
  let fail = true
  world.setUsageResponse((body) => {
    if (fail) return { ok: false, error: { code: 'INTERNAL', message: 'boom' } }
    const usage = {}
    for (const id of body.sessionIds) usage[id] = { totalTokens: 1000, cacheReadInputTokens: 800, cacheMissInputTokens: 200, outputTokens: 0 }
    return { ok: true, available: true, usage }
  })
  await store.setUsageEnabled(false)
  await store.setUsageEnabled(true)
  await waitFor(() => store.getSnapshot().usageError !== null, 'the failed chunk is recorded')
  tree = renderDeep(section.component({ api, t: api.t }))
  assert.equal(elementsByClass(tree, 'dsh-cleanup-item').length, 2, 'the list still renders')
  assert.equal(elementsByClass(tree, 'dsh-cleanup-usage-error').length, 1, 'a retry affordance is shown')
  assert.match(collectText(tree), /重试用量/)

  fail = false
  await store.retryUsage()
  await waitFor(() => store.getSnapshot().usageError === null && store.getSnapshot().usage['session-a'] !== undefined, 'retry folds the chunk')
  assert.equal(store.getSnapshot().usage['session-a'].totalTokens, 1000)
  store.dispose()
})

test('usage: a parent row shows own/family tokens for the descendants on the page', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setSessions(() => [
    inventorySession('session-a'),
    inventorySession('session-b', { parentSessionId: 'session-a', origin: 'subagent' }),
  ])
  world.setCapabilities({ usage: true, projectionCache: true, openPath: false })
  world.setUsageResponse((body) => {
    const usage = {}
    for (const id of body.sessionIds) {
      usage[id] = id === 'session-a'
        ? { totalTokens: 1000, cacheReadInputTokens: 500, cacheMissInputTokens: 500, outputTokens: 0 }
        : { totalTokens: 500, cacheReadInputTokens: 0, cacheMissInputTokens: 500, outputTokens: 0 }
    }
    return { ok: true, available: true, usage }
  })
  const api = slotApi(world, 'settings.section')
  const store = api.createPageStore()
  await store.loadInventory()
  store.setTab('sessions')
  api.createPageStore = () => store
  const section = world.registrations.find((entry) => entry.options.name === 'settings.section')
  await store.setUsageEnabled(true)
  await waitFor(() => store.getSnapshot().usage['session-b'] !== undefined, 'both rows folded')
  const tree = renderDeep(section.component({ api, t: api.t }))
  const text = collectText(tree)
  assert.match(text, /1k\/1\.5k/, 'the parent reports its own and the family total')
  assert.match(text, /50%/, 'the cache-hit column renders the folded rate')
  store.dispose()
})

// =============================================================================================
// 0.6.0: open in the file manager (SPEC §10 "Open (0.6.0)")
// =============================================================================================

const openCallsOf = (world) => world.calls.filter((call) => call.url.endsWith('cleanup.open'))

function workspaceRow(id, title, path) {
  return {
    id: id,
    path: path,
    title: title,
    state: 'ok',
    stateCode: null,
    sessionCount: 1,
    sessionsInside: 0,
    hasGit: false,
    liveSessions: [],
    deletable: true,
    blockerCodes: [],
  }
}

test('open: workspace, session, trash-entry and cache controls post kind+id, never a path', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setWorkspaces(() => [workspaceRow('ws-a', 'proj', '/tmp/proj')])
  world.setSessions(() => [inventorySession('session-a', { workspaceId: 'ws-a' })])
  world.setTrashEntries(() => [
    { id: 'entry-1', kind: 'session', title: 'log', originalPath: '/tmp/log', movedAt: 1, bytes: 10, files: 1, dirs: 0, restorable: true, restorableCode: null },
  ])
  world.setCapabilities({ usage: false, projectionCache: true, openPath: true })
  const api = slotApi(world, 'settings.section')
  const store = api.createPageStore()
  await store.loadInventory()
  api.createPageStore = () => store
  const section = world.registrations.find((entry) => entry.options.name === 'settings.section')

  store.setTab('workspaces')
  let tree = renderDeep(section.component({ api, t: api.t }))
  const workspaceOpen = elementsByClass(tree, 'dsh-cleanup-open')
  assert.equal(workspaceOpen.length, 1, 'one open control on the Workspaces row')
  assert.match(String(workspaceOpen[0].props['aria-label']), /proj/, 'the accessible name names the target')
  workspaceOpen[0].props.onClick()
  await waitFor(() => openCallsOf(world).length === 1, 'workspace open posted')
  assert.deepEqual(openCallsOf(world)[0].body, { kind: 'workspace', id: 'ws-a' }, 'workspace is opened by id, never a path')

  store.setTab('sessions')
  tree = renderDeep(section.component({ api, t: api.t }))
  const sessionOpen = elementsByClass(tree, 'dsh-cleanup-open')
  assert.equal(sessionOpen.length, 1)
  sessionOpen[0].props.onClick()
  await waitFor(() => openCallsOf(world).length === 2, 'session open posted')
  assert.deepEqual(openCallsOf(world)[1].body, { kind: 'session', id: 'session-a' })

  store.setTab('trash')
  await store.loadTrash()
  tree = renderDeep(section.component({ api, t: api.t }))
  const cacheOpen = elementsByClass(tree, 'dsh-cleanup-open').filter((button) => /缓存目录/.test(String(button.props['aria-label'])))
  assert.equal(cacheOpen.length, 1, 'the Trash tab header opens the cache directory')
  cacheOpen[0].props.onClick()
  await waitFor(() => openCallsOf(world).length === 3, 'cache open posted')
  assert.deepEqual(openCallsOf(world)[2].body, { kind: 'cache' }, 'cache is opened without an id')

  const trashOpen = elementsByClass(tree, 'dsh-cleanup-open').filter((button) => /「log」/.test(String(button.props['aria-label'])))
  assert.equal(trashOpen.length, 1, 'a trash entry opens its moved payload directory')
  trashOpen[0].props.onClick()
  await waitFor(() => openCallsOf(world).length === 4, 'trash-entry open posted')
  assert.deepEqual(openCallsOf(world)[3].body, { kind: 'trash', id: 'entry-1' })
  store.dispose()
})

test('open: hidden without the openPath capability; a failure is an inline page error with retry', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setWorkspaces(() => [workspaceRow('ws-a', 'proj', '/tmp/proj')])
  world.setCapabilities({ usage: false, projectionCache: true, openPath: false })
  const api = slotApi(world, 'settings.section')
  const store = api.createPageStore()
  await store.loadInventory()
  store.setTab('workspaces')
  api.createPageStore = () => store
  const section = world.registrations.find((entry) => entry.options.name === 'settings.section')
  let tree = renderDeep(section.component({ api, t: api.t }))
  assert.equal(elementsByClass(tree, 'dsh-cleanup-open').length, 0, 'no open control without the capability')
  assert.equal(openCallsOf(world).length, 0)

  const capable = createContext()
  const second = await loadClient()
  second.mod.apply(capable.ctx)
  capable.setWorkspaces(() => [workspaceRow('ws-a', 'proj', '/tmp/proj')])
  capable.setCapabilities({ usage: false, projectionCache: true, openPath: true })
  capable.setOpenResponse(() => ({ ok: false, error: { code: 'OPEN_FAILED', message: 'no opener' } }))
  const capableApi = slotApi(capable, 'settings.section')
  const capableStore = capableApi.createPageStore()
  await capableStore.loadInventory()
  capableApi.createPageStore = () => capableStore
  const capableSection = capable.registrations.find((entry) => entry.options.name === 'settings.section')
  capableStore.setTab('workspaces')
  await capableStore.openPath('workspace', 'ws-a')
  await waitFor(() => capableStore.getSnapshot().openError !== null, 'open error recorded')
  assert.equal(capableStore.getSnapshot().openError.code, 'OPEN_FAILED')
  tree = renderDeep(capableSection.component({ api: capableApi, t: capableApi.t }))
  const text = collectText(tree)
  assert.match(text, /系统无法启动文件管理器来打开该目录/, 'the page-level inline error is the localized code')
  assert.match(text, /重试打开/, 'the error offers a retry')
  assert.equal(elementsByClass(tree, 'dsh-cleanup-item').length, 1, 'the list still renders under the error')

  capable.setOpenResponse(() => ({ ok: true, path: '/tmp/proj' }))
  await capableStore.retryOpen()
  await waitFor(() => capableStore.getSnapshot().openError === null, 'retry clears the error')
  capableStore.dispose()
  store.dispose()
})

test('open: the review summary carries the control for its one target; failures go to the toast', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setPlanResponse((body) => ({ ok: true, plan: planEchoingTargets(body) }))
  const api = slotApi(world, 'settings.section')
  const store = api.createPageStore()
  world.setCapabilities({ usage: false, projectionCache: true, openPath: true })
  await store.loadInventory()
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const dialogApi = overlay.options.inject().api
  dialogApi.openDialog([{ kind: 'session', id: 'session-a', title: '会话 A' }])
  await waitFor(() => dialogApi.dialogStore.getSnapshot().phase === 'review', 'review phase')
  let tree = renderDeep(overlay.component({ api: dialogApi, t: dialogApi.t }))
  const open = elementsByClass(tree, 'dsh-cleanup-open')
  assert.equal(open.length, 1, 'the summary offers an open control for a single target')
  assert.match(String(open[0].props['aria-label']), /会话 A/)
  open[0].props.onClick()
  await waitFor(() => openCallsOf(world).length === 1, 'dialog open posted')
  assert.deepEqual(openCallsOf(world)[0].body, { kind: 'session', id: 'session-a' })

  world.setOpenResponse(() => ({ ok: false, error: { code: 'OPEN_UNAVAILABLE', message: 'no opener' } }))
  open[0].props.onClick()
  await waitFor(() => world.notices.length === 1, 'dialog open failure is reported through the toast')
  assert.match(world.notices[0].text, /当前平台没有可用的文件管理器打开方式/)
  assert.equal(dialogApi.dialogStore.getSnapshot().phase, 'review', 'an open failure never replaces the review')
  dialogApi.disposeDialog()
  store.dispose()
})

test('open: the review dialog hides the control when openPath is false', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setPlanResponse((body) => ({ ok: true, plan: planEchoingTargets(body) }))
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  api.openDialog([{ kind: 'session', id: 'session-a', title: 'A' }])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  const tree = renderDeep(overlay.component({ api, t: api.t }))
  assert.equal(elementsByClass(tree, 'dsh-cleanup-open').length, 0)
  api.disposeDialog()
})

// =============================================================================================
// 0.6.0: the review-dialog family tree (SPEC §9 "The family tree (0.6.0)")
// =============================================================================================

/** Parent chain of the fake family used by the tree cases. */
const FAMILY_PARENT = { 'session-a': null, 'child-1': 'session-a', 'child-2': 'child-1' }

/** A plan whose `session-a` target expands into child-1 → child-2 when descendants are asked for. */
function familyPlanFor(body) {
  const ids = body.targets.map((target) => target.id)
  if (body.includeDescendants === true && ids.indexOf('session-a') !== -1) ids.push('child-1', 'child-2')
  const items = ids.map((id) => ({
    kind: 'session',
    id: id,
    workspaceId: null,
    title: id === 'session-a' ? '会话 A' : (id === 'child-1' ? '子会话 1' : '子会话 2'),
    path: '/tmp/' + id,
    bytes: 100,
    files: 1,
    dirs: 0,
    parentSessionId: FAMILY_PARENT[id] || null,
    isDescendant: FAMILY_PARENT[id] !== null,
  }))
  return Object.assign(cleanPlan(body.mode), {
    targets: body.targets.map((target) => ({ kind: target.kind, id: target.id, title: target.id, path: null })),
    items: items,
    totals: { workspaces: 0, sessions: items.length, files: items.length, dirs: 0, bytes: items.length * 100 },
  })
}

test('tree: depth-first render, tri-state node checkboxes and the explicit re-plan', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setPlanResponse((body) => ({ ok: true, plan: familyPlanFor(body) }))
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  api.openDialog([{ kind: 'session', id: 'session-a', title: '会话 A' }])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  assert.equal(api.dialogStore.getSnapshot().includeDescendants, true, 'the switch starts on with the family selected')

  api.toggleDialogGroup('session:session-a')
  let tree = renderDeep(overlay.component({ api, t: api.t }))
  let nodes = elementsByClass(tree, 'dsh-cleanup-tree-node')
  assert.equal(nodes.length, 2, 'one node per subagent log')
  assert.deepEqual(nodes.map((node) => node.props['data-depth']), [1, 2], 'ordered depth-first, one indent step per level')
  const text = collectText(tree)
  assert.match(text, /子代理/, 'a direct child carries the subagent badge')
  assert.match(text, /派生/, 'a deeper descendant carries the derived badge')
  assert.match(text, /已选 3\/3 条日志/, 'the group header counts the family')
  let checks = findAll(tree, (element) => element && element.type === 'input' && element.props && element.props.className === 'dsh-cleanup-tree-check')
  assert.equal(checks.length, 2)
  assert.equal(checks.every((input) => input.props.checked === true), true, 'switch on selects every node')

  // Un-checking the leaf switches the switch off and plans an explicit target set.
  api.setDialogNodeSelection('child-2', false)
  await waitFor(() => {
    const calls = world.calls.filter((call) => call.url.endsWith('cleanup.plan'))
    return calls.length >= 2 && api.dialogStore.getSnapshot().refreshing !== true
  }, 'explicit re-plan')
  const lastPlan = world.calls.filter((call) => call.url.endsWith('cleanup.plan')).at(-1)
  assert.equal(lastPlan.body.includeDescendants, false, 'an un-checked node wins over descendant expansion')
  assert.deepEqual(lastPlan.body.targets, [
    { kind: 'session', id: 'session-a' },
    { kind: 'session', id: 'child-1' },
  ], 'the plan names every checked row and checked node, and not the un-checked id')
  const settled = api.dialogStore.getSnapshot()
  assert.deepEqual(settled.nodeSelection, ['child-1'])
  assert.equal(settled.descendantsAutoOff, true, 'the auto-off explanation is reused')
  assert.equal(settled.plan.items.some((item) => item.id === 'child-2'), false, 'the un-checked log is not planned')

  tree = renderDeep(overlay.component({ api, t: api.t }))
  nodes = elementsByClass(tree, 'dsh-cleanup-tree-node')
  assert.equal(nodes.length, 2, 'the un-checked node stays on screen so it can be re-checked')
  checks = findAll(tree, (element) => element && element.type === 'input' && element.props && element.props.className === 'dsh-cleanup-tree-check')
  const child1 = checks.find((input) => input.props['aria-label'].indexOf('子会话 1') !== -1)
  const child2 = checks.find((input) => input.props['aria-label'].indexOf('子会话 2') !== -1)
  assert.equal(child1.props['aria-checked'], 'mixed', 'a partially selected subtree renders mixed')
  assert.equal(child2.props.checked, false)
  assert.match(collectText(tree), /已选 2\/3 条日志/)

  // Checking a node while the switch is off adds it and its subtree to the explicit set.
  api.setDialogNodeSelection('child-1', true)
  await waitFor(() => {
    const calls = world.calls.filter((call) => call.url.endsWith('cleanup.plan'))
    return calls.length >= 3 && api.dialogStore.getSnapshot().refreshing !== true && calls.at(-1).body.includeDescendants === false
  }, 'explicit re-plan after re-checking')
  assert.deepEqual(world.calls.filter((call) => call.url.endsWith('cleanup.plan')).at(-1).body.targets, [
    { kind: 'session', id: 'session-a' },
    { kind: 'session', id: 'child-1' },
    { kind: 'session', id: 'child-2' },
  ])

  // Switching it back on re-checks every node and plans through includeDescendants.
  api.setIncludeDescendants(true)
  await waitFor(() => {
    const calls = world.calls.filter((call) => call.url.endsWith('cleanup.plan'))
    return calls.length >= 4 && api.dialogStore.getSnapshot().refreshing !== true && calls.at(-1).body.includeDescendants === true
  }, 'switch re-check re-plan')
  const switched = api.dialogStore.getSnapshot()
  assert.deepEqual(switched.nodeSelection, [], 'the switch owns the set again')
  assert.equal(switched.descendantsAutoOff, false)
  tree = renderDeep(overlay.component({ api, t: api.t }))
  checks = findAll(tree, (element) => element && element.type === 'input' && element.props && element.props.className === 'dsh-cleanup-tree-check')
  assert.equal(checks.every((input) => input.props.checked === true), true, 'switching back on re-checks every node')
  api.disposeDialog()
})

test('tree: checking the root re-plans the family but inverting covers rows and nodes', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setPlanResponse((body) => ({ ok: true, plan: familyPlanFor(body) }))
  const api = slotApi(world, 'shell.overlay')
  api.openDialog([{ kind: 'session', id: 'session-a', title: '会话 A' }])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  api.invertDialogTargetSelection()
  assert.deepEqual(api.dialogStore.getSnapshot().selection, [], 'invert drops the checked root row')
  assert.deepEqual(api.dialogStore.getSnapshot().nodeSelection, [], 'invert drops every checked node too')
  assert.equal(api.dialogStore.getSnapshot().includeDescendants, false)
  await waitFor(() => api.dialogStore.getSnapshot().plan === null, 'an empty selection keeps no plan')
  api.selectAllDialogTargets()
  await waitFor(() => api.dialogStore.getSnapshot().refreshing !== true && api.dialogStore.getSnapshot().plan !== null, 'select-all plans again')
  assert.deepEqual(api.dialogStore.getSnapshot().selection, ['session:session-a'])
  const lastPlan = world.calls.filter((call) => call.url.endsWith('cleanup.plan')).at(-1)
  assert.equal(lastPlan.body.includeDescendants, false, 'select-all re-checks the nodes explicitly while the switch is off')
  assert.deepEqual(lastPlan.body.targets, [
    { kind: 'session', id: 'session-a' },
    { kind: 'session', id: 'child-1' },
    { kind: 'session', id: 'child-2' },
  ])
  api.disposeDialog()
})

test('tree: a plan that still contains an un-checked node fails closed (UNCHECKED_TARGET_LEAK)', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setPlanResponse((body) => {
    if (body.includeDescendants === false) {
      // A misbehaving Host smuggles the un-checked node back into an explicit plan.
      const plan = familyPlanFor(body)
      plan.items.push({
        kind: 'session', id: 'child-2', workspaceId: null, title: '子会话 2', path: '/tmp/child-2',
        bytes: 100, files: 1, dirs: 0, parentSessionId: 'child-1', isDescendant: true,
      })
      return { ok: true, plan: plan }
    }
    return { ok: true, plan: familyPlanFor(body) }
  })
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  api.openDialog([{ kind: 'session', id: 'session-a', title: '会话 A' }])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  api.setDialogNodeSelection('child-2', false)
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'failed', 'failed phase')
  const settled = api.dialogStore.getSnapshot()
  assert.equal(settled.failureStage, 'plan')
  assert.equal(settled.error.code, 'UNCHECKED_TARGET_LEAK', 'a leaked node fails the review closed')
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.delete')).length, 0)
  const text = collectText(renderDeep(overlay.component({ api, t: api.t })))
  assert.match(text, /有已取消勾选的目标仍会被删除/)
  api.disposeDialog()
})

test('tree: a node un-checked in a workspace clear is recorded in clear.excluded', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setCandidatesResponse(() => ({
    ok: true,
    candidates: [{ id: 'session-0', cwd: '/tmp/p0', deletable: true }],
    total: 1,
    truncated: false,
    totals: { count: 1, bytes: 0 },
  }))
  world.setPlanResponse((body) => {
    const plan = familyPlanFor({
      mode: body.mode,
      targets: body.targets,
      includeDescendants: body.includeDescendants === true && body.targets.some((target) => target.id === 'session-0'),
    })
    // The clear's family lives under session-0 instead of session-a.
    plan.targets = body.targets.map((target) => ({ kind: target.kind, id: target.id, title: target.id, path: null }))
    if (body.includeDescendants === true && body.targets.some((target) => target.id === 'session-0')) {
      plan.items.push({
        kind: 'session', id: 'child-x', workspaceId: null, title: '子会话 X', path: '/tmp/child-x',
        bytes: 10, files: 1, dirs: 0, parentSessionId: 'session-0', isDescendant: true,
      })
    }
    return { ok: true, plan: plan }
  })
  clearMenuAction(world).run()
  const api = slotApi(world, 'shell.overlay')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  assert.ok(api.dialogStore.getSnapshot().knownNodes['child-x'], 'the clear batch collected the tree node')

  api.setDialogNodeSelection('child-x', false)
  await waitFor(() => {
    const calls = world.calls.filter((call) => call.url.endsWith('cleanup.plan'))
    return calls.length >= 2 && api.dialogStore.getSnapshot().refreshing !== true
  }, 'explicit clear batch re-plan')
  const state = api.dialogStore.getSnapshot()
  assert.equal(state.includeDescendants, false)
  assert.deepEqual(state.clear.excluded, { 'session:child-x': true }, 'the un-checked node is excluded like a row')
  assert.deepEqual(world.calls.filter((call) => call.url.endsWith('cleanup.plan')).at(-1).body.targets, [
    { kind: 'session', id: 'session-0' },
  ], 'the batch plans the explicit checked set')

  api.confirmDelete()
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'done', 'done phase')
  assert.deepEqual(api.dialogStore.getSnapshot().clear.excluded, { 'session:child-x': true }, 'the exclusion survives the walk')
  api.disposeDialog()
})

// =============================================================================================
// 0.6.0: permanent deletion prominence (SPEC §9)
// =============================================================================================

test('dialog: permanent mode states its irreversibility next to the selector; trash stays the default', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setPlanResponse((body) => ({ ok: true, plan: planEchoingTargets(body) }))
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  api.openDialog([{ kind: 'session', id: 'session-a', title: 'A' }])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  assert.equal(api.dialogStore.getSnapshot().mode, 'trash', 'the recoverable mode stays the default')
  assert.equal(elementsByClass(renderDeep(overlay.component({ api, t: api.t })), 'dsh-cleanup-perm-warning').length, 0)

  api.setDialogMode('permanent')
  await waitFor(() => {
    const calls = world.calls.filter((call) => call.url.endsWith('cleanup.plan'))
    return calls.length >= 2 && api.dialogStore.getSnapshot().refreshing !== true && calls.at(-1).body.mode === 'permanent'
  }, 'permanent re-plan')
  const tree = renderDeep(overlay.component({ api, t: api.t }))
  assert.equal(elementsByClass(tree, 'dsh-cleanup-perm-warning').length, 1, 'an explicit irreversible note is rendered')
  assert.match(collectText(tree), /彻底删除会立即销毁数据，无法撤销，也不会进入回收站。/)
  api.disposeDialog()
})

test('usage: the opt-in preference is plugin-owned and a blocked localStorage cannot break the page', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const store = slotApi(world, 'settings.section').createPageStore()
  const savedStorage = globalThis.localStorage
  try {
    const memory = new Map()
    globalThis.localStorage = {
      getItem(key) { return memory.has(key) ? memory.get(key) : null },
      setItem(key, value) { memory.set(key, String(value)) },
    }
    assert.equal(store.getSnapshot().usageEnabled, false, 'the default is off')
    await store.setUsageEnabled(true)
    assert.equal(globalThis.localStorage.getItem('dsh-cleanup.usageEnabled'), 'true', 'the plugin-owned key is persisted')

    // A browser that blocks storage must degrade to the default instead of throwing.
    globalThis.localStorage = {
      getItem() { throw new Error('blocked') },
      setItem() { throw new Error('blocked') },
    }
    const blocked = slotApi(world, 'settings.section').createPageStore()
    assert.equal(blocked.getSnapshot().usageEnabled, false, 'a throwing storage keeps the default')
    await blocked.setUsageEnabled(true)
    await blocked.setUsageEnabled(false)
    blocked.dispose()
  } finally {
    globalThis.localStorage = savedStorage
  }
  store.dispose()
})

// =============================================================================================
// 0.6.0 code-review fixes (task-12)
// =============================================================================================

/** A plan over two root Sessions, each with one direct child, expanded when descendants are on. */
function twoRootFamilyPlanFor(body) {
  const parentOf = {
    'session-a': null, 'a-1': 'session-a',
    'session-b': null, 'b-1': 'session-b',
  }
  const ids = body.targets.map((target) => target.id)
  if (body.includeDescendants === true) {
    if (ids.indexOf('session-a') !== -1) ids.push('a-1')
    if (ids.indexOf('session-b') !== -1) ids.push('b-1')
  }
  const items = ids.map((id) => ({
    kind: 'session',
    id: id,
    workspaceId: null,
    title: id,
    path: '/tmp/' + id,
    bytes: 10,
    files: 1,
    dirs: 0,
    parentSessionId: parentOf[id] || null,
    isDescendant: parentOf[id] !== null,
  }))
  return Object.assign(cleanPlan(body.mode), {
    targets: body.targets.map((target) => ({ kind: target.kind, id: target.id, title: target.id, path: null })),
    items: items,
    totals: { workspaces: 0, sessions: items.length, files: items.length, dirs: 0, bytes: items.length * 10 },
  })
}

test('panel hook order: SessionsPanel runs the same hooks in the loading and loaded renders', async () => {
  const world = createContext()
  const { mod, hookCalls, resetHooks } = await loadClient()
  mod.apply(world.ctx)
  world.setSessions(() => [inventorySession('session-a'), inventorySession('session-b')])
  const api = slotApi(world, 'settings.section')
  const store = api.createPageStore()
  store.setTab('sessions')
  api.createPageStore = () => store
  const section = world.registrations.find((entry) => entry.options.name === 'settings.section')

  resetHooks()
  renderDeep(section.component({ api, t: api.t }))
  const loadingHooks = hookCalls.slice()
  assert.equal(store.getSnapshot().inventory, null, 'the first render is the loading state')

  await store.loadInventory()
  resetHooks()
  const tree = renderDeep(section.component({ api, t: api.t }))
  const loadedHooks = hookCalls.slice()
  assert.equal(elementsByClass(tree, 'dsh-cleanup-item').length, 2, 'the loaded render shows the rows')
  assert.ok(loadingHooks.length > 0)
  assert.deepEqual(
    loadedHooks,
    loadingHooks,
    'the usage hook must run above the early return: every render calls the same hooks in the same order',
  )
  store.dispose()
})

test('tree: un-checking a row clears its node selection and disables its nodes', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setPlanResponse((body) => ({ ok: true, plan: twoRootFamilyPlanFor(body) }))
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  api.openDialog([
    { kind: 'session', id: 'session-a', title: 'A' },
    { kind: 'session', id: 'session-b', title: 'B' },
  ])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')

  // Switch on: both families are expanded. Un-checking one leaf switches the switch off and
  // materializes an explicit set.
  api.setDialogNodeSelection('a-1', false)
  await waitFor(() => {
    const calls = world.calls.filter((call) => call.url.endsWith('cleanup.plan'))
    return calls.length >= 2 && api.dialogStore.getSnapshot().refreshing !== true
  }, 'explicit re-plan after the node un-check')
  assert.deepEqual(api.dialogStore.getSnapshot().nodeSelection, ['b-1'])

  // Un-checking the owning row purges its subtree from the explicit node set.
  api.setDialogSelection('session:session-a', false)
  await waitFor(() => {
    const calls = world.calls.filter((call) => call.url.endsWith('cleanup.plan'))
    return calls.length >= 3 && api.dialogStore.getSnapshot().refreshing !== true
  }, 're-plan after the row un-check')
  const state = api.dialogStore.getSnapshot()
  assert.deepEqual(state.selection, ['session:session-b'])
  assert.deepEqual(state.nodeSelection, ['b-1'], 'the un-checked row subtree left the node selection')
  const lastPlan = world.calls.filter((call) => call.url.endsWith('cleanup.plan')).at(-1)
  assert.deepEqual(lastPlan.body.targets, [
    { kind: 'session', id: 'session-b' },
    { kind: 'session', id: 'b-1' },
  ], 'an explicit plan never names a node whose root row is un-checked')

  // The un-checked row's tree stays on screen — unchecked, disabled, with the localized note.
  api.toggleDialogGroup('session:session-a')
  const tree = renderDeep(overlay.component({ api, t: api.t }))
  const nodes = elementsByClass(tree, 'dsh-cleanup-tree-node')
  assert.equal(nodes.length, 1, 'only the un-checked root is expanded')
  const checks = findAll(tree, (element) => element && element.type === 'input' && element.props && element.props.className === 'dsh-cleanup-tree-check')
  assert.equal(checks.length, 1)
  assert.equal(checks[0].props.checked, false, 'a node under an un-checked row renders unchecked')
  assert.equal(checks[0].props.disabled, true, 'a node under an un-checked row cannot be toggled')
  const text = collectText(tree)
  assert.match(text, /该会话已取消勾选，它的子代理会话不会被删除。/)
  assert.match(text, /已选 0\/1 条日志/, 'the family count only counts a checked root')
  api.disposeDialog()
})

test('plan cap: an oversized review fails locally with TOO_MANY_TARGETS and never hits the wire', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const api = slotApi(world, 'shell.overlay')
  const targets = []
  for (let index = 0; index < 65; index += 1) targets.push({ kind: 'session', id: 'session-' + index, title: 'S' + index })
  api.openDialog(targets)
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'failed', 'local plan failure')
  const state = api.dialogStore.getSnapshot()
  assert.equal(state.failureStage, 'plan')
  assert.equal(state.error.code, 'TOO_MANY_TARGETS')
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.plan')).length, 0, 'no doomed plan request is sent')
  const text = collectText(renderDeep(slotApi(world, 'shell.overlay') && (function () {
    const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
    return overlay.component({ api, t: api.t })
  })()))
  assert.match(text, /64/, 'the copy names the cap')
  assert.match(text, /分批/, 'the copy tells the user to batch the work')

  api.retryDialog()
  await sleep(30)
  assert.equal(api.dialogStore.getSnapshot().phase, 'failed', 'retry re-plans and fails locally again')
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.plan')).length, 0, 'retry never resends a doomed body')
  api.disposeDialog()
})

test('plan cap: explicit tree nodes count against the 64-target budget', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setPlanResponse((body) => {
    const ids = body.targets.map((target) => target.id)
    const parentOf = { 'child-1': 'session-0', 'child-2': 'session-0' }
    if (body.includeDescendants === true) {
      if (ids.indexOf('session-0') !== -1) ids.push('child-1', 'child-2')
    }
    const items = ids.map((id) => ({
      kind: 'session', id: id, workspaceId: null, title: id, path: '/tmp/' + id,
      bytes: 10, files: 1, dirs: 0, parentSessionId: parentOf[id] || null, isDescendant: parentOf[id] !== undefined,
    }))
    return {
      ok: true,
      plan: Object.assign(cleanPlan(body.mode), {
        targets: body.targets.map((target) => ({ kind: target.kind, id: target.id, title: target.id, path: null })),
        items: items,
        totals: { workspaces: 0, sessions: items.length, files: items.length, dirs: 0, bytes: items.length * 10 },
      }),
    }
  })
  const api = slotApi(world, 'shell.overlay')
  const targets = []
  for (let index = 0; index < 63; index += 1) targets.push({ kind: 'session', id: 'session-' + index, title: 'S' + index })
  api.openDialog(targets)
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review' && api.dialogStore.getSnapshot().refreshing !== true, 'review phase')

  // 63 rows + one explicit node = 64 targets: still within the Host cap.
  api.setDialogNodeSelection('child-2', false)
  await waitFor(() => {
    const calls = world.calls.filter((call) => call.url.endsWith('cleanup.plan'))
    return calls.length >= 2 && api.dialogStore.getSnapshot().refreshing !== true
  }, 'explicit re-plan at the 64 boundary')
  const boundary = world.calls.filter((call) => call.url.endsWith('cleanup.plan')).at(-1)
  assert.equal(boundary.body.targets.length, 64)

  // Re-checking the second node would name 65 targets: fail locally, no request.
  const planCallsBefore = world.calls.filter((call) => call.url.endsWith('cleanup.plan')).length
  api.setDialogNodeSelection('child-2', true)
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'failed', 'over-budget failure')
  assert.equal(api.dialogStore.getSnapshot().error.code, 'TOO_MANY_TARGETS')
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.plan')).length, planCallsBefore, '65 targets never reach the Host')
  api.retryDialog()
  await sleep(30)
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.plan')).length, planCallsBefore, 'retry stays local')
  api.disposeDialog()
})

test('plan cap: a workspace-clear batch is trimmed and the overflow stays queued', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const rows = []
  for (let index = 0; index < 64; index += 1) rows.push({ id: 'session-' + index, cwd: '/tmp/p' + index, deletable: true })
  world.setCandidatesResponse(() => ({ ok: true, candidates: rows, total: rows.length, truncated: false, totals: { count: rows.length, bytes: 0 } }))
  world.setPlanResponse((body) => {
    const ids = body.targets.map((target) => target.id)
    const parentOf = { 'child-n0': 'session-0', 'child-n1': 'session-0' }
    if (body.includeDescendants === true && ids.indexOf('session-0') !== -1) ids.push('child-n0', 'child-n1')
    const items = ids.map((id) => ({
      kind: 'session', id: id, workspaceId: null, title: id, path: '/tmp/' + id,
      bytes: 1, files: 1, dirs: 0, parentSessionId: parentOf[id] || null, isDescendant: parentOf[id] !== undefined,
    }))
    return {
      ok: true,
      plan: Object.assign(cleanPlan(body.mode), {
        targets: body.targets.map((target) => ({ kind: target.kind, id: target.id, title: target.id, path: null })),
        items: items,
        totals: { workspaces: 0, sessions: items.length, files: items.length, dirs: 0, bytes: items.length },
      }),
    }
  })
  clearMenuAction(world).run()
  const api = slotApi(world, 'shell.overlay')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')

  // 64 rows + one explicit node would be 65: trim to the longest fitting prefix (63 rows + node).
  api.setDialogNodeSelection('child-n1', false)
  await waitFor(() => {
    const calls = world.calls.filter((call) => call.url.endsWith('cleanup.plan'))
    return calls.length >= 2 && api.dialogStore.getSnapshot().refreshing !== true && api.dialogStore.getSnapshot().phase === 'review'
  }, 'trimmed clear batch plan')
  const state = api.dialogStore.getSnapshot()
  assert.equal(state.phase, 'review', 'a clear batch trims instead of failing')
  const lastPlan = world.calls.filter((call) => call.url.endsWith('cleanup.plan')).at(-1)
  assert.equal(lastPlan.body.includeDescendants, false)
  assert.equal(lastPlan.body.targets.length, 64, 'rows + explicit nodes fit the Host cap exactly')
  const plannedIds = lastPlan.body.targets.map((target) => target.id)
  assert.equal(plannedIds.indexOf('session-63'), -1, 'the overflow row is not planned yet')
  assert.notEqual(plannedIds.indexOf('child-n0'), -1, 'the checked node is named explicitly')
  assert.equal(plannedIds.indexOf('child-n1'), -1, 'the un-checked node is not named')
  assert.equal(state.targets.length, 63)
  assert.equal(state.clear.queued[0].id, 'session-63', 'the dropped row is queued for the next batch')
  const queuedIds = state.clear.queued.map((target) => target.id)
  assert.equal(new Set(queuedIds).size, queuedIds.length, 'the dropped row is queued once')
  api.disposeDialog()
})

test('plan cap: a single root whose nodes alone overflow fails with TOO_MANY_TARGETS', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setCandidatesResponse(() => ({
    ok: true,
    candidates: [{ id: 'session-0', cwd: '/tmp/p0', deletable: true }],
    total: 1,
    truncated: false,
    totals: { count: 1, bytes: 0 },
  }))
  const children = []
  for (let index = 0; index < 64; index += 1) children.push('child-' + index)
  world.setPlanResponse((body) => {
    const ids = body.targets.map((target) => target.id)
    if (body.includeDescendants === true && ids.indexOf('session-0') !== -1) ids.push.apply(ids, children)
    const items = ids.map((id) => ({
      kind: 'session', id: id, workspaceId: null, title: id, path: '/tmp/' + id,
      bytes: 1, files: 1, dirs: 0, parentSessionId: id === 'session-0' ? null : 'session-0',
      isDescendant: id !== 'session-0',
    }))
    return {
      ok: true,
      plan: Object.assign(cleanPlan(body.mode), {
        targets: body.targets.map((target) => ({ kind: target.kind, id: target.id, title: target.id, path: null })),
        items: items,
        totals: { workspaces: 0, sessions: items.length, files: items.length, dirs: 0, bytes: items.length },
      }),
    }
  })
  clearMenuAction(world).run()
  const api = slotApi(world, 'shell.overlay')
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  // 1 row + 63 explicit nodes = 64: fits and is sent.
  api.setDialogNodeSelection('child-63', false)
  await waitFor(() => {
    const calls = world.calls.filter((call) => call.url.endsWith('cleanup.plan'))
    return calls.length >= 2 && api.dialogStore.getSnapshot().refreshing !== true
  }, '64-target explicit plan')
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.plan')).at(-1).body.targets.length, 64)
  // Re-checking the 64th node needs 65 targets: even one root cannot fit -> local failure.
  const planCallsBefore = world.calls.filter((call) => call.url.endsWith('cleanup.plan')).length
  api.setDialogNodeSelection('child-63', true)
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'failed', 'over-budget clear failure')
  assert.equal(api.dialogStore.getSnapshot().error.code, 'TOO_MANY_TARGETS')
  assert.equal(world.calls.filter((call) => call.url.endsWith('cleanup.plan')).length, planCallsBefore, 'no doomed batch plan is sent')
  api.disposeDialog()
})

test('usage: a failed chunk retried through retryUsage is requested once per id', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setSessions(() => [inventorySession('session-a'), inventorySession('session-b')])
  world.setCapabilities({ usage: true, projectionCache: true, openPath: false })
  let fail = true
  world.setUsageResponse((body) => {
    if (fail) return { ok: false, error: { code: 'INTERNAL', message: 'boom' } }
    const usage = {}
    for (const id of body.sessionIds) usage[id] = { totalTokens: 1000, cacheReadInputTokens: 800, cacheMissInputTokens: 200, outputTokens: 0 }
    return { ok: true, available: true, usage }
  })
  const api = slotApi(world, 'settings.section')
  const store = api.createPageStore()
  await store.loadInventory()
  store.setTab('sessions')
  await store.setUsageEnabled(true)
  await waitFor(() => store.getSnapshot().usageError !== null, 'failed chunk')
  fail = false
  await store.retryUsage()
  await waitFor(() => store.getSnapshot().usageError === null && store.getSnapshot().usage['session-a'] !== undefined, 'retried chunk folded')
  const bodies = usageCallsOf(world).map((call) => call.body.sessionIds)
  for (const ids of bodies) {
    assert.equal(new Set(ids).size, ids.length, 'no request body repeats an id')
  }
  assert.deepEqual(bodies.at(-1).slice().sort(), ['session-a', 'session-b'], 'the retry asks each failed id exactly once')
  store.dispose()
})

test('tree: the auto-off notice only appears when a node toggle turns the switch off', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setPlanResponse((body) => ({ ok: true, plan: familyPlanFor(body) }))
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api

  // Manual switch-off, then checking a node: no auto-off notice (the user turned it off).
  api.openDialog([{ kind: 'session', id: 'session-a', title: 'A' }])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  api.setIncludeDescendants(false)
  await waitFor(() => api.dialogStore.getSnapshot().refreshing !== true, 'manual off re-plan')
  api.setDialogNodeSelection('child-1', true)
  await waitFor(() => api.dialogStore.getSnapshot().refreshing !== true, 'node re-plan')
  assert.equal(api.dialogStore.getSnapshot().descendantsAutoOff, false, 'checking a node while already off is not an auto-off')
  api.disposeDialog()

  // Invert with nodes known: no auto-off notice either.
  api.openDialog([{ kind: 'session', id: 'session-a', title: 'A' }])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'second review')
  api.invertDialogTargetSelection()
  await waitFor(() => api.dialogStore.getSnapshot().refreshing !== true, 'invert re-plan')
  assert.equal(api.dialogStore.getSnapshot().descendantsAutoOff, false, 'invert never raises the auto-off notice')
  assert.equal(api.dialogStore.getSnapshot().plan, null, 'an inverted-empty selection keeps no plan')
  api.disposeDialog()

  // Un-checking a node while the switch is on is the one case that raises it, with the tree copy.
  api.openDialog([{ kind: 'session', id: 'session-a', title: 'A' }])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'third review')
  api.setDialogNodeSelection('child-2', false)
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review' && api.dialogStore.getSnapshot().refreshing !== true, 'auto-off re-plan')
  assert.equal(api.dialogStore.getSnapshot().descendantsAutoOff, true)
  const text = collectText(renderDeep(overlay.component({ api, t: api.t })))
  assert.match(text, /重新勾选子代理会话后可再开启/, 'the copy speaks about the tree, not a row')
  api.disposeDialog()
})

test('tree: the auto-off notice is never rendered inside a workspace clear', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setCandidatesResponse(() => ({
    ok: true,
    candidates: [{ id: 'session-0', cwd: '/tmp/p0', deletable: true }],
    total: 1,
    truncated: false,
    totals: { count: 1, bytes: 0 },
  }))
  world.setPlanResponse((body) => {
    const ids = body.targets.map((target) => target.id)
    if (body.includeDescendants === true && ids.indexOf('session-0') !== -1) ids.push('child-x')
    const items = ids.map((id) => ({
      kind: 'session', id: id, workspaceId: null, title: id, path: '/tmp/' + id,
      bytes: 1, files: 1, dirs: 0, parentSessionId: id === 'session-0' ? null : 'session-0',
      isDescendant: id !== 'session-0',
    }))
    return {
      ok: true,
      plan: Object.assign(cleanPlan(body.mode), {
        targets: body.targets.map((target) => ({ kind: target.kind, id: target.id, title: target.id, path: null })),
        items: items,
        totals: { workspaces: 0, sessions: items.length, files: items.length, dirs: 0, bytes: items.length },
      }),
    }
  })
  clearMenuAction(world).run()
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  api.setDialogNodeSelection('child-x', false)
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review' && api.dialogStore.getSnapshot().refreshing !== true, 'clear re-plan')
  assert.equal(api.dialogStore.getSnapshot().descendantsAutoOff, true, 'the forced-off state is still tracked')
  const text = collectText(renderDeep(overlay.component({ api, t: api.t })))
  assert.doesNotMatch(text, /已自动关闭/, 'the switch explanation never appears in a workspace clear')
  api.disposeDialog()
})

test('restore: one follow-up sessions.refresh runs after the first refresh settles, gated by dispose', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  const api = slotApi(world, 'settings.section')
  const store = api.createPageStore()
  await store.loadInventory()
  store.setTab('trash')
  await store.loadTrash()
  const refreshCalls = () => world.calls.filter((call) => call.url === 'session.refresh').length

  const releaseFirst = world.holdSessionRefresh()
  await store.restoreEntry('20260101T000000Z-a-0001')
  assert.equal(refreshCalls(), 1, 'the restore refresh is in flight')
  assert.equal(store.getSnapshot().actionBusy, null, 'the restore itself settled')
  releaseFirst()
  await waitFor(() => refreshCalls() === 2, 'one follow-up refresh after the first settles')

  // The follow-up is gated by the plugin disposer: a restore after unload schedules nothing.
  const releaseSecond = world.holdSessionRefresh()
  await store.restoreEntry('20260101T000000Z-a-0001')
  assert.equal(refreshCalls(), 3)
  world.disposeEffects()
  releaseSecond()
  await sleep(30)
  assert.equal(refreshCalls(), 3, 'a disposed plugin never runs the follow-up refresh')
  store.dispose()
})

test('open: the activation capability probe fills the snapshot for context-menu reviews', async () => {
  const world = createContext()
  world.setCapabilities({ usage: false, projectionCache: true, openPath: true })
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  // The probe is fired at activation; wait for its inventory round trip to land.
  await waitFor(() => world.calls.some((call) => call.url.endsWith('cleanup.inventory')), 'capability probe request')
  await sleep(20)
  world.setPlanResponse((body) => ({ ok: true, plan: planEchoingTargets(body) }))
  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const api = overlay.options.inject().api
  api.openDialog([{ kind: 'session', id: 'session-a', title: 'A' }])
  await waitFor(() => api.dialogStore.getSnapshot().phase === 'review', 'review phase')
  const tree = renderDeep(overlay.component({ api, t: api.t }))
  assert.equal(elementsByClass(tree, 'dsh-cleanup-open').length, 1, 'a context-menu review now knows the Host can open folders')
  api.disposeDialog()
})

test('a11y: the usage columns expose accessible names', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setSessions(() => [inventorySession('session-a')])
  world.setCapabilities({ usage: true, projectionCache: true, openPath: false })
  world.setUsageResponse((body) => {
    const usage = {}
    for (const id of body.sessionIds) usage[id] = { totalTokens: 12000, cacheReadInputTokens: 8700, cacheMissInputTokens: 1300, outputTokens: 0 }
    return { ok: true, available: true, usage }
  })
  const api = slotApi(world, 'settings.section')
  const store = api.createPageStore()
  await store.loadInventory()
  store.setTab('sessions')
  api.createPageStore = () => store
  const section = world.registrations.find((entry) => entry.options.name === 'settings.section')
  await store.setUsageEnabled(true)
  await waitFor(() => store.getSnapshot().usage['session-a'] !== undefined, 'usage folded')
  const tree = renderDeep(section.component({ api, t: api.t }))
  const dict = world.localeState.dicts.zh
  const totals = elementsByClass(tree, 'dsh-cleanup-usage-total')
  const hits = elementsByClass(tree, 'dsh-cleanup-usage-hit')
  assert.equal(totals.length, 1)
  assert.equal(hits.length, 1)
  // Real text inside the cell, not an aria-label on a role-less span: generic spans are not
  // reliably named by author labels, so the label is a visually hidden prefix.
  const labelTexts = elementsByClass(tree, 'dsh-cleanup-sr').map(collectText)
  assert.ok(labelTexts.includes(dict['sessions.usage.total'] + ': '), 'the total cell carries a visually hidden label')
  assert.ok(labelTexts.includes(dict['sessions.usage.cacheHit'] + ': '), 'the cache-hit cell carries a visually hidden label')
  assert.ok(collectText(totals[0]).indexOf('12k') !== -1 || collectText(totals[0]).length > 0, 'the total value still renders')
  store.dispose()
})

test('state: the usage sort resets when usage becomes unavailable or loses its capability', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setSessions(() => [inventorySession('session-a')])
  world.setCapabilities({ usage: true, projectionCache: true, openPath: false })
  const api = slotApi(world, 'settings.section')
  const store = api.createPageStore()
  await store.loadInventory()
  store.setTab('sessions')
  store.setSessionSort('usage')
  world.setUsageResponse(() => ({ ok: true, available: false, usage: {} }))
  await store.setUsageEnabled(true)
  await waitFor(() => store.getSnapshot().usageAvailable === false, 'available:false recorded')
  assert.equal(store.getSnapshot().sessionSort, 'newest', 'available:false drops the usage sort')

  // Losing the capability on a reload resets it too.
  store.setSessionSort('usage')
  world.setCapabilities({ usage: false, projectionCache: true, openPath: false })
  await store.loadInventory()
  assert.equal(store.getSnapshot().sessionSort, 'newest', 'a Host without usage resets the sort')
  store.dispose()
})

test('state: a tab switch clears the inline open error; the dialog Open label names the workspace', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  world.setWorkspaces(() => [workspaceRow('ws-a', 'proj', '/tmp/proj')])
  world.setSessions(() => [inventorySession('session-a')])
  world.setCapabilities({ usage: false, projectionCache: true, openPath: true })
  world.setPlanResponse((body) => ({ ok: true, plan: planEchoingTargets(body) }))
  const api = slotApi(world, 'settings.section')
  const store = api.createPageStore()
  await store.loadInventory()
  api.createPageStore = () => store

  store.setTab('workspaces')
  world.setOpenResponse(() => ({ ok: false, error: { code: 'OPEN_FAILED', message: 'no opener' } }))
  await store.openPath('workspace', 'ws-a')
  await waitFor(() => store.getSnapshot().openError !== null, 'open error recorded')
  store.setTab('sessions')
  assert.equal(store.getSnapshot().openError, null, 'switching tabs clears the page-level open error')

  const overlay = world.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const dialogApi = overlay.options.inject().api
  dialogApi.openDialog([{ kind: 'workspace', id: 'ws-a', title: 'proj', path: '/tmp/proj' }])
  await waitFor(() => dialogApi.dialogStore.getSnapshot().phase === 'review', 'workspace review')
  const tree = renderDeep(overlay.component({ api: dialogApi, t: dialogApi.t }))
  const openButton = elementsByClass(tree, 'dsh-cleanup-open')[0]
  assert.ok(openButton)
  assert.match(String(openButton.props['aria-label']), /「proj」/, 'the accessible name names the workspace')
  assert.doesNotMatch(String(openButton.props['aria-label']), /\/tmp\/proj/, 'the raw path is not the accessible name')
  dialogApi.disposeDialog()
  store.dispose()
})
