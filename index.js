/**
 * dsh-cleanup — Host half.
 *
 * Registers the sixteen authenticated POST routes (SPEC §4, §4.7, §4.8, §4.10, §4.11) over the
 * shared `/api` connection channel
 * and, when the optional ToolRegistry is present, the **read-only** `cleanup_inventory` agent tool
 * (SPEC §6). All domain logic lives in `./lib/engine.js`; this module owns only the Cordis lifecycle,
 * config defaults, HTTP bodies/statuses and the tool projection.
 *
 * Deletion is a user-only action: no route here is reachable from an agent, and the agent tool cannot
 * delete anything.
 *
 * @module dsh-cleanup
 */
import { createEngine } from './lib/engine.js'
import path from 'node:path'
import { deferredFilePath } from './lib/deferred.js'
import { dshHome } from './lib/paths.js'
import { mergeSettings, readSettingsOverridesSync } from './lib/settings.js'

export const name = 'dsh-cleanup'

// Required: without these the plugin has nothing to operate on and must stay inactive.
export const inject = ['connection', 'workspaceRegistry', 'sessionPersistence']

/** Every route is an authenticated exact POST route on the shared API channel. */
const ROUTE_DEFINITIONS = Object.freeze([
  ['/api/cleanup.inventory', (engine) => engine.inventory()],
  ['/api/cleanup.measure', (engine, body) => engine.measure(body)],
  // Per-Session token usage folded through the optional sessionQuery seam (SPEC §4.10/§5.11).
  ['/api/cleanup.usage', (engine, body) => engine.usage(body)],
  // Read-only cleanup-wizard preview (SPEC §4.9): a projection of the inventory snapshot.
  ['/api/cleanup.candidates', (engine, body) => engine.candidates(body)],
  ['/api/cleanup.plan', (engine, body, request) => engine.plan(body, { signal: request?.signal })],
  ['/api/cleanup.delete', (engine, body, request) => engine.execute(body, { signal: request?.signal })],
  ['/api/cleanup.trash.list', (engine) => engine.trashList()],
  ['/api/cleanup.trash.restore', (engine, body) => engine.trashRestore(body)],
  ['/api/cleanup.trash.purge', (engine, body) => engine.trashPurge(body)],
  // Reveal a Host-resolved directory in the platform file manager (SPEC §4.11); never a caller path.
  ['/api/cleanup.open', (engine, body) => engine.open(body)],
  // Deferred deletions: the only safe way to delete a Session opened in this app run, applied at the
  // next Host start before any Agent exists.
  ['/api/cleanup.defer', (engine, body) => engine.defer(body)],
  ['/api/cleanup.deferred.list', (engine) => engine.deferredList()],
  ['/api/cleanup.deferred.cancel', (engine, body) => engine.deferredCancel(body)],
  ['/api/cleanup.deferred.requeue', (engine, body) => engine.deferredRequeue(body)],
  // Settings: plugin-owned overrides edited from the Settings page (never the profile patch layer).
  ['/api/cleanup.settings.get', (engine) => engine.settingsGet()],
  ['/api/cleanup.settings.set', (engine, body) => engine.settingsSet(body)],
])

const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json; charset=utf-8' })

const TOOL_NAME = 'cleanup_inventory'
const TOOL_DEFAULT_LIMIT = 50
const TOOL_MAX_LIMIT = 100

/**
 * Plugin entry point (SPEC §3).
 *
 * `config` is read with defaults by the engine; no schema export is used. Every registration goes
 * through `ctx.effect(...)` and the resulting disposer is returned so unloading removes every route,
 * the tool, and (implicitly) the retained plans with the plugin fiber.
 *
 * @param {object} ctx - plugin context with the required injects.
 * @param {object} [config] - plugin config table from SPEC §3.
 * @returns {() => Promise<void>} the plugin effect disposer.
 */
export function apply(ctx, config) {
  // User overrides live in a plugin-owned file under the profile home (SPEC §3 precedence), so the
  // Settings page can apply changes without rewriting the user's cordis.patch.yml or restarting.
  const rowConfig = config ?? {}
  const queueFile = typeof rowConfig.deferredFile === 'string' && path.isAbsolute(rowConfig.deferredFile)
    ? rowConfig.deferredFile
    : deferredFilePath(dshHome())
  const settingsPath = typeof rowConfig.settingsFile === 'string' && path.isAbsolute(rowConfig.settingsFile)
    ? rowConfig.settingsFile
    : path.join(path.dirname(queueFile), 'settings.json')
  let overrides = {}
  try {
    overrides = readSettingsOverridesSync(settingsPath)
  } catch {
    overrides = {}
  }
  const engine = createEngine({
    workspaceRegistry: ctx.workspaceRegistry,
    sessionPersistence: ctx.sessionPersistence,
    // The loader row (before overrides) is what the Settings page shows as "defaults".
    baseConfig: rowConfig,
    config: mergeSettings(rowConfig, overrides),
    // Optional liveness services resolve lazily per call: a service that loads after this plugin
    // must still harden the next plan/admission instead of being treated as permanently absent.
    sessions: lazyServiceView(ctx, 'sessions'),
    agents: lazyServiceView(ctx, 'agents'),
    // A live Agent's effective working directory can differ from the session header's creation cwd,
    // so the "is a live session using this folder" gate reads it through the optional service.
    workingDirectory: lazyServiceFacade(ctx, 'workingDirectory'),
    // Usage folding (SPEC §4.10/§5.11) reads the optional SessionQuery service per call, so a service
    // that loads after this plugin still folds usage on the next request.
    sessionQuery: lazySessionQueryView(ctx),
    // A deleted Session's projection-cache record goes with its files (SPEC §5.5 step 7). The view
    // resolves storageDomain → the session_projcache domain → its sessions table per call, so a
    // domain opened later still works and an absent one is only `cacheDropped: false`.
    projectionCache: lazyProjectionCacheView(ctx),
    // Deleting a Session emits the shipped event so every connected client drops the sidebar row
    // exactly as it does for a disposed Session (SPEC §3). Best effort: a minimal context may have no
    // emitter, and a throwing emitter must never change a deletion result.
    emitSessionRemoved: (sessionId) => {
      try {
        ctx.emit?.('api-session/removed', sessionId)
      } catch {
        /* the removal notice is advisory: the sidebar row can still be refreshed manually */
      }
    },
  })

  /** @type {Function[]} */
  const disposers = []
  for (const [routePath, invoke] of ROUTE_DEFINITIONS) {
    disposers.push(
      effectOf(ctx, () =>
        ctx.connection.fetch.register({
          path: routePath,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => handleRoute(engine, invoke, request),
        }),
      ),
    )
  }
  const toolDisposer = registerInventoryTool(ctx, engine)
  if (toolDisposer !== null) disposers.push(toolDisposer)

  // Apply the deferred-deletion queue once per process, right after activation: at Host start the
  // queue runs before any client can resume a Session, which is exactly why it is safe. A plugin
  // hot-reload re-enters apply() in the same process and must NOT consume the queue, so the engine
  // guards this with a process-global marker. Errors are never fatal for boot.
  void engine
    .runDeferred()
    .then((outcome) => {
      if (outcome.ran) {
        ctx.logger?.info?.(`dsh-cleanup: applied ${outcome.results.length} deferred deletion(s)`)
      }
    })
    .catch(() => {
      /* a deferred-run failure is reported through the next inventory's lastRun, never by blocking boot */
    })

  return async () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        await dispose?.()
      } catch {
        /* unloading is best-effort: one failed disposer must not strand the others */
      }
    }
  }
}

/**
 * Register one resource as a Cordis fiber effect and hand back its disposer. A minimal test context
 * without the lifecycle helper still executes the registration once; the real Host always has one.
 * @param {object} ctx - plugin context.
 * @param {() => Function} execute - registration body returning its disposer.
 * @returns {Function} disposer.
 */
function effectOf(ctx, execute) {
  if (typeof ctx.effect === 'function') return ctx.effect(execute)
  return execute()
}

/**
 * Read one optional service through a getter-shaped view so the engine can call `.get(id)` without
 * caring whether the service is absent now, present later, or throws while resolving.
 * @param {object} ctx - plugin context.
 * @param {string} serviceName - optional service name.
 * @returns {{ get: (id: string) => unknown }}
 */
function lazyServiceView(ctx, serviceName) {
  /**
   * Resolve the optional service, or undefined when the profile does not compose it. A failure to
   * *resolve* the service is absence; a failure *inside* a method must propagate (see below).
   * @returns {object | undefined}
   */
  function resolve() {
    if (typeof ctx.get !== 'function') return undefined
    try {
      const service = ctx.get(serviceName)
      return service === null ? undefined : service
    } catch {
      return undefined
    }
  }
  return {
    get(id) {
      const service = resolve()
      const read = service?.get
      if (typeof read !== 'function') return undefined
      // Deliberately NOT caught: the engine's liveness gate must fail closed when a probe throws.
      // Swallowing here would turn a wedged service into "not live" again.
      return read.call(service, id)
    },
    list() {
      const service = resolve()
      const list = service?.list
      if (typeof list !== 'function') return undefined
      // Same reasoning: a throwing enumeration must reach the engine, which refuses to delete.
      return list.call(service)
    },
  }
}

/**
 * Read one optional service as a getter-shaped facade for calls that take the service's own argument
 * (such as `workingDirectory.get(session)`), resolving it lazily on every call.
 * @param {object} ctx - plugin context.
 * @param {string} serviceName - optional service name.
 * @returns {{ get: (argument: unknown) => unknown }}
 */
function lazyServiceFacade(ctx, serviceName) {
  return {
    get(argument) {
      try {
        if (typeof ctx.get !== 'function') return undefined
        const service = ctx.get(serviceName)
        return typeof service?.get === 'function' ? service.get(argument) : undefined
      } catch {
        return undefined
      }
    },
  }
}

/**
 * Read the optional SessionQuery service as a lazily-resolved view (SPEC §3/§4.10).
 *
 * The service is optional and may load after this plugin, so it is resolved on every call. An absent
 * service is reported through `available()` and makes `readSession` reject, which the usage folder
 * surfaces as that id's `READ_FAILED` entry; it never breaks a request or activation.
 * @param {object} ctx - plugin context.
 * @returns {{ available: () => boolean, readSession: (id: string) => Promise<object> }}
 */
function lazySessionQueryView(ctx) {
  /**
   * Resolve the optional service, or undefined when the profile does not compose it.
   * @returns {object | undefined}
   */
  function resolve() {
    if (typeof ctx.get !== 'function') return undefined
    try {
      const service = ctx.get('sessionQuery')
      return service === null ? undefined : service
    } catch {
      return undefined
    }
  }
  return {
    available() {
      const service = resolve()
      return typeof service?.readSession === 'function'
    },
    readSession(id) {
      const service = resolve()
      const read = service?.readSession
      if (typeof read !== 'function') {
        // A resolver-side absence reaches the engine as a normal read failure, never a hang.
        return Promise.reject(new Error(`The session query service is unavailable, so session "${id}" cannot be read.`))
      }
      // Run the call asynchronously so a synchronous throw becomes a rejection the folder classifies.
      return Promise.resolve().then(() => read.call(service, id))
    },
  }
}

/**
 * Read the shipped projection-cache domain as a lazily-resolved view (SPEC §3/§5.5 step 7).
 *
 * The capability probe and the record drop both resolve `storageDomain` → the `session_projcache`
 * domain → its `sessions` table on every call, so a domain opened later still works and a service
 * that vanishes degrades to `cacheDropped: false` instead of failing a deletion.
 * @param {object} ctx - plugin context.
 * @returns {{ available: () => boolean, drop: (sessionId: string) => Promise<boolean> }}
 */
function lazyProjectionCacheView(ctx) {
  /**
   * Resolve the shipped `sessions` table, or null when the seam is absent/unusable right now.
   * @returns {object | null}
   */
  function resolveTable() {
    if (typeof ctx.get !== 'function') return null
    try {
      const storageDomain = ctx.get('storageDomain')
      if (storageDomain === null || storageDomain === undefined || typeof storageDomain.get !== 'function') return null
      const domain = storageDomain.get('session_projcache')
      if (domain === null || domain === undefined || typeof domain.table !== 'function') return null
      const table = domain.table('sessions')
      return table === null || table === undefined ? null : table
    } catch {
      return null
    }
  }
  return {
    available() {
      return typeof resolveTable()?.delete === 'function'
    },
    async drop(sessionId) {
      try {
        const table = resolveTable()
        if (typeof table?.delete !== 'function') return false
        return (await table.delete(sessionId)) === true
      } catch {
        // A closed domain or a throwing delete is a per-item `cacheDropped: false` (SPEC §5.5).
        return false
      }
    },
  }
}

/**
 * One route handler. Never throws: transport/JSON failures answer 400, unexpected programming
 * failures answer 500, and every domain failure is the engine's HTTP-200 envelope.
 * @param {object} engine - cleanup engine.
 * @param {(engine: object, body: object, request: Request) => Promise<object>} invoke - route implementation.
 * @param {Request} request - authenticated Fetch request.
 * @returns {Promise<Response>}
 */
async function handleRoute(engine, invoke, request) {
  let body
  try {
    body = await readJsonObject(request)
  } catch (error) {
    return respond(400, badRequest(errorMessage(error)))
  }
  let envelope
  try {
    envelope = await invoke(engine, body, request)
  } catch (error) {
    return respond(500, internalFailure(error))
  }
  if (!isPlainObject(envelope) || typeof envelope.ok !== 'boolean') {
    return respond(500, internalFailure(new Error('The cleanup engine returned an invalid envelope.')))
  }
  // `BAD_REQUEST` is the one envelope code that also maps to an HTTP status (SPEC §4): a malformed
  // or missing JSON body is a transport-level 400, while every domain failure stays HTTP 200.
  const status = envelope.ok === false && envelope.error?.code === 'BAD_REQUEST' ? 400 : 200
  return respond(status, envelope)
}

/**
 * Parse the buffered JSON body, requiring a JSON object.
 * @param {Request} request - incoming request.
 * @returns {Promise<object>}
 */
async function readJsonObject(request) {
  let text
  try {
    text = await request.text()
  } catch (error) {
    throw new Error(`The request body could not be read: ${errorMessage(error)}`)
  }
  if (typeof text !== 'string' || text.trim() === '') throw new Error('A JSON request body is required.')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('The request body is not valid JSON.')
  }
  if (!isPlainObject(parsed)) throw new Error('The request body must be a JSON object.')
  return parsed
}

/**
 * Serialize one envelope into a JSON Response. Serialization itself can never escape as a throw.
 * @param {number} status - HTTP status.
 * @param {object} payload - envelope body.
 * @returns {Response}
 */
function respond(status, payload) {
  let text
  try {
    text = JSON.stringify(payload)
    if (typeof text !== 'string') throw new Error('not serializable')
  } catch {
    return new Response(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: 'The cleanup response could not be serialized.' } }), {
      status: 500,
      headers: JSON_HEADERS,
    })
  }
  return new Response(text, { status, headers: JSON_HEADERS })
}

/** @param {string} message - client-facing explanation. */
function badRequest(message) {
  return { ok: false, error: { code: 'BAD_REQUEST', message } }
}

/** @param {unknown} error - unexpected exception. */
function internalFailure(error) {
  return { ok: false, error: { code: 'INTERNAL', message: `Unexpected cleanup failure: ${errorMessage(error)}` } }
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** @param {unknown} value @returns {boolean} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// #region read-only agent tool ----------------------------------------------------------------

/**
 * Register the read-only inventory tool when the optional ToolRegistry is available. The service is
 * optional (SPEC §3), so an absent registry — or a registration refusal — degrades the capability
 * instead of failing plugin activation.
 * @param {object} ctx - plugin context.
 * @param {object} engine - cleanup engine.
 * @returns {Function | null} registration disposer, or null when unavailable.
 */
function registerInventoryTool(ctx, engine) {
  let tools
  try {
    if (typeof ctx.get !== 'function') return null
    tools = ctx.get('tools')
  } catch {
    return null
  }
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return null
  try {
    const disposer = effectOf(ctx, () => tools.register(createInventoryTool(engine)))
    return typeof disposer === 'function' ? disposer : null
  } catch {
    return null
  }
}

/**
 * The read-only tool definition (SPEC §6). Plain object registration: no `defineTool` import is
 * needed, and the parameter schema is the raw JSON Schema the model sees.
 * @param {object} engine - cleanup engine.
 * @returns {object} registry-ready tool definition.
 */
function createInventoryTool(engine) {
  return {
    name: TOOL_NAME,
    description:
      'List workspaces and sessions with their disk usage and deletion blockers. This tool cannot delete anything: deletion is a user action in Settings → Storage cleanup, so tell the user to open that page and describe what you found.',
    parameters: {
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
        // The Host enforces a JSON-Schema subset (type/oneOf/properties/required/
        // additionalProperties/items/enum/const + annotations) for tool schemas; `minimum`/`maximum`
        // are outside it and would be rejected by any consumer that applies the documented subset.
        // The range is enforced by parseToolArguments below instead.
        limit: {
          type: 'integer',
          description: `Maximum rows per list (default ${TOOL_DEFAULT_LIMIT}, at most ${TOOL_MAX_LIMIT}).`,
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: inventoryOutputSchema(),
      render: (args, value) => [{ type: 'text', text: renderInventorySummary(value) }],
    },
    async execute(args) {
      const parsed = parseToolArguments(args)
      const inventory = await engine.inventory()
      if (isPlainObject(inventory) && inventory.ok === false) {
        throw new Error(inventory.error?.message ?? 'The cleanup inventory could not be read.')
      }
      /** @type {string[]} */
      const notes = [
        'Deletion is a user-only action: the user must open Settings → Storage cleanup to review and delete. This tool cannot delete anything.',
      ]
      let workspaces = Array.isArray(inventory.workspaces) ? inventory.workspaces : []
      let sessions = Array.isArray(inventory.sessions) ? inventory.sessions : []
      if (parsed.workspaceId !== undefined) {
        workspaces = workspaces.filter((row) => row.id === parsed.workspaceId)
        sessions = sessions.filter((row) => row.workspaceId === parsed.workspaceId)
        if (workspaces.length === 0) notes.push(`No workspace with id "${parsed.workspaceId}" was found.`)
      }
      const totalWorkspaces = workspaces.length
      const totalSessions = sessions.length

      let measured = false
      if (parsed.includeSizes) {
        measured = true
        const measurement = await engine.measure({ workspaceIds: workspaces.map((row) => row.id) })
        if (isPlainObject(measurement) && measurement.ok === true && isPlainObject(measurement.workspaces)) {
          const sizes = measurement.workspaces
          workspaces = workspaces.map((row) => {
            const size = sizes[row.id]
            return { ...row, bytes: isPlainObject(size) && typeof size.bytes === 'number' ? size.bytes : null }
          })
          if (workspaces.some((row) => row.bytes === null)) notes.push('Some workspace sizes could not be measured.')
        } else {
          notes.push(`Workspace sizes could not be measured: ${measurement?.error?.message ?? 'unknown failure'}`)
          measured = false
          workspaces = workspaces.map((row) => ({ ...row, bytes: null }))
        }
      } else {
        workspaces = workspaces.map((row) => ({ ...row, bytes: null }))
        notes.push('Sizes were not measured; pass includeSizes: true to measure workspace disk usage.')
      }
      if (inventory.truncated === true) {
        const cap = typeof inventory.sessionListCap === 'number' ? inventory.sessionListCap : null
        notes.push(
          cap === null
            ? 'The stored session list was truncated; some sessions may be missing.'
            : `The stored session list was truncated at ${cap} entries; some sessions may be missing.`,
        )
      }
      if (totalWorkspaces > parsed.limit) notes.push(`Only the first ${parsed.limit} of ${totalWorkspaces} workspaces are shown.`)
      if (totalSessions > parsed.limit) notes.push(`Only the first ${parsed.limit} of ${totalSessions} sessions are shown.`)

      return {
        workspaces: workspaces.slice(0, parsed.limit).map(projectWorkspaceRow),
        sessions: sessions.slice(0, parsed.limit).map(projectSessionRow),
        trash: {
          root: typeof inventory.trash?.root === 'string' ? inventory.trash.root : '',
          entries: typeof inventory.trash?.entries === 'number' ? inventory.trash.entries : 0,
          bytes: typeof inventory.trash?.bytes === 'number' ? inventory.trash.bytes : 0,
        },
        notes,
      }
    },
  }
}

/** @param {object} row - inventory workspace row. */
function projectWorkspaceRow(row) {
  return {
    id: String(row.id ?? ''),
    path: String(row.path ?? ''),
    title: String(row.title ?? ''),
    state: String(row.state ?? 'ok'),
    sessionCount: typeof row.sessionCount === 'number' ? row.sessionCount : 0,
    sessionsInside: typeof row.sessionsInside === 'number' ? row.sessionsInside : 0,
    bytes: typeof row.bytes === 'number' ? row.bytes : null,
    deletable: row.deletable === true,
    hasGit: row.hasGit === true,
    blockerCodes: Array.isArray(row.blockerCodes) ? row.blockerCodes.map(String) : [],
  }
}

/** @param {object} row - inventory session row. */
function projectSessionRow(row) {
  return {
    id: String(row.id ?? ''),
    workspaceId: typeof row.workspaceId === 'string' ? row.workspaceId : null,
    cwd: typeof row.cwd === 'string' ? row.cwd : null,
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
    eventCount: typeof row.eventCount === 'number' ? row.eventCount : null,
    sizeBytes: typeof row.sizeBytes === 'number' ? row.sizeBytes : null,
    origin: typeof row.origin === 'string' ? row.origin : null,
    parentSessionId: typeof row.parentSessionId === 'string' ? row.parentSessionId : null,
    live: row.live === true,
    running: row.running === true,
    archived: row.archived === true,
    pinned: row.pinned === true,
    deletable: row.deletable === true,
    blockerCodes: Array.isArray(row.blockerCodes) ? row.blockerCodes.map(String) : [],
  }
}

/**
 * Validate the tool arguments the raw registration does not validate for us.
 * @param {unknown} args - model arguments.
 * @returns {{ workspaceId?: string, includeSizes: boolean, limit: number }}
 */
function parseToolArguments(args) {
  const value = isPlainObject(args) ? args : {}
  /** @type {{ workspaceId?: string, includeSizes: boolean, limit: number }} */
  const parsed = { includeSizes: false, limit: TOOL_DEFAULT_LIMIT }
  if (value.workspaceId !== undefined && value.workspaceId !== null) {
    if (typeof value.workspaceId !== 'string' || value.workspaceId === '') {
      throw new Error(`${TOOL_NAME}: "workspaceId" must be a non-empty string.`)
    }
    parsed.workspaceId = value.workspaceId
  }
  if (value.includeSizes !== undefined) {
    if (typeof value.includeSizes !== 'boolean') throw new Error(`${TOOL_NAME}: "includeSizes" must be a boolean.`)
    parsed.includeSizes = value.includeSizes
  }
  if (value.limit !== undefined) {
    if (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > TOOL_MAX_LIMIT) {
      throw new Error(`${TOOL_NAME}: "limit" must be an integer between 1 and ${TOOL_MAX_LIMIT}.`)
    }
    parsed.limit = value.limit
  }
  return parsed
}

/** @param {unknown} schema - any non-null JSON Schema node. */
function nullable(schema) {
  return { oneOf: [schema, { type: 'null' }] }
}

/**
 * Canonical output schema (SPEC §6): object with `workspaces`, `sessions`, `trash`, `notes`, all
 * required. Only the `dsh-tools` JSON-Schema subset is used (`type`, `oneOf`, `properties`,
 * `required`, `additionalProperties`, `items`, `enum`, `const`, and annotations).
 * @returns {object}
 */
function inventoryOutputSchema() {
  const blockerCodes = { type: 'array', items: { type: 'string' } }
  return {
    type: 'object',
    properties: {
      workspaces: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            path: { type: 'string' },
            title: { type: 'string' },
            state: { type: 'string' },
            sessionCount: { type: 'integer' },
            sessionsInside: { type: 'integer' },
            bytes: nullable({ type: 'number' }),
            deletable: { type: 'boolean' },
            hasGit: { type: 'boolean' },
            blockerCodes,
          },
          required: ['id', 'path', 'title', 'state', 'sessionCount', 'sessionsInside', 'bytes', 'deletable', 'hasGit', 'blockerCodes'],
          additionalProperties: false,
        },
      },
      sessions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            workspaceId: nullable({ type: 'string' }),
            cwd: nullable({ type: 'string' }),
            createdAt: { type: 'number' },
            eventCount: nullable({ type: 'integer' }),
            sizeBytes: nullable({ type: 'number' }),
            origin: nullable({ type: 'string' }),
            parentSessionId: nullable({ type: 'string' }),
            live: { type: 'boolean' },
            running: { type: 'boolean' },
            archived: { type: 'boolean' },
            pinned: { type: 'boolean' },
            deletable: { type: 'boolean' },
            blockerCodes,
          },
          required: [
            'id',
            'workspaceId',
            'cwd',
            'createdAt',
            'eventCount',
            'sizeBytes',
            'origin',
            'parentSessionId',
            'live',
            'running',
            'archived',
            'pinned',
            'deletable',
            'blockerCodes',
          ],
          additionalProperties: false,
        },
      },
      trash: {
        type: 'object',
        properties: {
          root: { type: 'string' },
          entries: { type: 'integer' },
          bytes: { type: 'number' },
        },
        required: ['root', 'entries', 'bytes'],
        additionalProperties: false,
      },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['workspaces', 'sessions', 'trash', 'notes'],
    additionalProperties: false,
  }
}

/**
 * The single text content block rendered for the model. Pure and total: it must also be safe to call
 * during a replay with an older value.
 * @param {unknown} value - canonical tool value.
 * @returns {string} Markdown summary.
 */
function renderInventorySummary(value) {
  try {
    const row = isPlainObject(value) ? value : {}
    const workspaces = Array.isArray(row.workspaces) ? row.workspaces : []
    const sessions = Array.isArray(row.sessions) ? row.sessions : []
    const trash = isPlainObject(row.trash) ? row.trash : {}
    const notes = Array.isArray(row.notes) ? row.notes.filter((note) => typeof note === 'string') : []
    const liveCount = sessions.filter((session) => session.live === true || session.running === true).length
    const measuredBytes = workspaces.every((workspace) => typeof workspace.bytes === 'number')
      ? workspaces.reduce((sum, workspace) => sum + workspace.bytes, 0)
      : null
    /** @type {{ label: string, bytes: number, files: number | null }[]} */
    const sized = []
    for (const workspace of workspaces) {
      if (typeof workspace.bytes === 'number') sized.push({ label: workspace.title || workspace.path || workspace.id, bytes: workspace.bytes, files: null })
    }
    for (const session of sessions) {
      if (typeof session.sizeBytes === 'number') sized.push({ label: session.id, bytes: session.sizeBytes, files: null })
    }
    sized.sort((left, right) => right.bytes - left.bytes)
    const blocked = workspaces.filter((workspace) => workspace.deletable === false).length + sessions.filter((session) => session.deletable === false).length

    const lines = ['## Storage cleanup inventory', '']
    lines.push(`- Workspaces: ${workspaces.length}`)
    lines.push(`- Sessions: ${sessions.length}${liveCount > 0 ? ` (${liveCount} live or running)` : ''}`)
    if (measuredBytes !== null) lines.push(`- Measured workspace bytes: ${formatBytes(measuredBytes)}`)
    lines.push(`- Trash: ${typeof trash.entries === 'number' ? trash.entries : 0} entr${trash.entries === 1 ? 'y' : 'ies'}, ${formatBytes(typeof trash.bytes === 'number' ? trash.bytes : 0)}`)
    if (blocked > 0) lines.push(`- Targets with blockers: ${blocked}`)
    if (sized.length > 0) {
      lines.push('', 'Largest targets:')
      for (const [index, target] of sized.slice(0, 3).entries()) {
        lines.push(`${index + 1}. ${target.label} — ${formatBytes(target.bytes)}`)
      }
    }
    if (notes.length > 0) {
      lines.push('', ...notes.map((note) => `- ${note}`))
    }
    lines.push('', 'Deletion is a user-only action in Settings → Storage cleanup; tell the user what you found and let them review it there.')
    return lines.join('\n')
  } catch {
    return '## Storage cleanup inventory\n\nThe inventory is available, but its summary could not be rendered.'
  }
}

/**
 * Human-readable size, KB/MB/GB thresholds.
 * @param {number} bytes - byte count.
 * @returns {string}
 */
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

// #endregion
