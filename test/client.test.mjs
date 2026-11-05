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
  const listeners = new Set()
  const localeState = { dicts: null, namespace: null }
  const calls = []
  const deferred = []
  let planResponse = () => ({ ok: true, plan: cleanPlan('trash') })
  let deleteResponse = () => ({ ok: true, result: { items: [], totals: { trashed: 1, deleted: 0, failed: 0, bytes: 10 } } })
  let restoreResponse = () => ({ ok: true, restoredTo: '/tmp/x' })
  let candidatesResponse = () => ({ ok: true, candidates: [], total: 0, truncated: false, totals: { count: 0, bytes: 0 } })
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
        refresh: async () => {
          calls.push({ url: 'session.refresh' })
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
    if (path.endsWith('cleanup.plan')) return respond(planResponse(body))
    if (path.endsWith('cleanup.defer')) return respond({ ok: true, deferred: { count: 1, entryIds: ['entry-1'], replaced: false } })
    if (path.endsWith('cleanup.candidates')) return respond(candidatesResponse(body))
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
    setSessions(fn) { inventory.sessions = fn() },
    setTrashEntries(fn) { trash.entries = fn() },
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
  const ReactStub = new Proxy({}, {
    get(_target, key) {
      if (key === 'createElement') return (type, props, ...children) => ({ type, props: props || {}, children })
      if (key === 'Fragment') return 'Fragment'
      if (key === 'useId') return () => ':r-cleanup:'
      if (key === 'useState') return (initial) => [typeof initial === 'function' ? initial() : initial, () => { }]
      if (key === 'useRef') return (initial) => ({ current: initial })
      if (key === 'useEffect') return () => { }
      if (key === 'useMemo') return (factory) => factory()
      if (key === 'useCallback') return (callback) => callback
      if (key === 'useSyncExternalStore') return (_subscribe, getSnapshot) => getSnapshot()
      return undefined
    },
  })
  const mod = loaded.factory((id) => {
    if (id === 'react') return ReactStub
    throw new Error('client.js must only require react, got ' + id)
  })
  return { mod, loaded }
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
