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
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    locale: {
      register(namespace, dicts) {
        localeState.namespace = namespace
        localeState.dicts = dicts
        return () => {}
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
        return () => {}
      },
      notify() {},
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
    if (path.endsWith('cleanup.delete')) return respond(deleteResponse(body))
    throw new Error('unrouted fetch ' + path)
  }

  return {
    ctx,
    registrations,
    injections,
    menus,
    calls,
    deferred,
    localeState,
    setPlanResponse(fn) { planResponse = fn },
    setDeleteResponse(fn) { deleteResponse = fn },
    setRestoreResponse(fn) { restoreResponse = fn },
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
    addEventListener() {},
    removeEventListener() {},
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
      if (key === 'useState') return (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
      if (key === 'useRef') return (initial) => ({ current: initial })
      if (key === 'useEffect') return () => {}
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

test('context menus: two danger actions, correct targets, malformed targets declined', async () => {
  const world = createContext()
  const { mod } = await loadClient()
  mod.apply(world.ctx)
  assert.equal(world.menus.length, 2)
  const sessionMenu = world.menus.find((entry) => entry.target === 'session')
  const workspaceMenu = world.menus.find((entry) => entry.target === 'workspace')
  assert.ok(sessionMenu && workspaceMenu)
  assert.equal(sessionMenu.id, 'delete-session')
  assert.equal(workspaceMenu.id, 'delete-workspace-dir')
  assert.deepEqual(sessionMenu.resolve({ displayTitle: 'no id' }), [])
  assert.deepEqual(workspaceMenu.resolve({ path: '/tmp/x' }), [])
  const [sessionAction] = sessionMenu.resolve({ sessionId: 'session-a', displayTitle: '重构登录流程' })
  assert.equal(sessionAction.danger, true)
  assert.equal(sessionAction.separatorBefore, true)
  assert.deepEqual(sessionAction.icon, { key: 'cleanup.trash' })
  assert.equal(typeof sessionAction.label, 'string', 'MenuActionView.label is rendered as a string')
  const [workspaceAction] = workspaceMenu.resolve({ workspaceId: 'ws-a', path: '/tmp/proj-a', displayTitle: 'proj-a' })
  assert.equal(workspaceAction.danger, true)
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
  assert.equal(second.menus.length, 2)
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
