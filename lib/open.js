/**
 * Platform directory opener for dsh-cleanup (SPEC §4.11).
 *
 * The plugin can reveal a directory in the user's file manager. It may only ever open a path the
 * Host resolved itself from an id; this module is the last step and takes an already-resolved
 * absolute directory. It never builds a shell string: the path is passed as one argument vector
 * element, so a directory called `--foo` or one containing spaces can never be interpreted as a
 * command-line option.
 *
 * The call is fire-and-forget: the promise resolves as soon as the launcher process was started, so
 * a long-lived file manager cannot hang the route and a launcher that exits non-zero on a success
 * path (Windows `explorer.exe`) is not a failure. Only "this platform has no opener"
 * (`OPEN_UNAVAILABLE`) and "the opener could not be started" (`OPEN_FAILED`) are errors. On macOS a
 * directory whose name ends in an application-bundle suffix (`.app`, `.bundle`, `.workflow`, `.pkg`)
 * is revealed with `open -R` instead of launched, because `open` would start the application.
 *
 * @module dsh-cleanup/lib/open
 */
import { execFile } from 'node:child_process'

/** Platforms this plugin knows how to open a directory on (SPEC §4.11). */
const SUPPORTED_PLATFORMS = Object.freeze(['darwin', 'win32', 'linux'])

/**
 * macOS application-bundle suffixes: `open` LAUNCHES one of these instead of revealing it, which is
 * not what "open the folder" means. Such a path is revealed with `open -R` (a no-op-ish highlight in
 * Finder) so a directory named `Foo.app` never starts an application.
 */
const DARWIN_BUNDLE_SUFFIXES = Object.freeze(['.app', '.bundle', '.workflow', '.pkg'])

/**
 * Whether the plugin can open a directory on one platform. Defaults to the running platform.
 * @param {string} [platform] - platform name to test (`process.platform` spelling).
 * @returns {boolean} true for `darwin`, `win32` and `linux`.
 */
export function openSupported(platform = process.platform) {
  return SUPPORTED_PLATFORMS.includes(platform)
}

/**
 * Build an Error carrying one of the two §4.11 wire codes.
 * @param {'OPEN_UNAVAILABLE' | 'OPEN_FAILED'} code - wire code.
 * @param {string} message - English explanation.
 * @returns {Error & { code: string }}
 */
function openerError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Human-readable detail of an unknown thrown/reported value, for the `OPEN_FAILED` message.
 * @param {unknown} error - thrown value or child "error" event payload.
 * @returns {string}
 */
function errorText(error) {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/**
 * The platform's opener executable. The directory is always passed as one argv element, never
 * concatenated into a shell string.
 * @param {'darwin' | 'win32' | 'linux'} platform - supported platform.
 * @returns {string} executable name.
 */
function openerCommandOf(platform) {
  if (platform === 'darwin') return 'open'
  if (platform === 'win32') return 'explorer.exe'
  return 'xdg-open'
}

/**
 * The argument vector for one target. On macOS a path ending in an application-bundle suffix is
 * revealed with `open -R` instead of launched; every other path is handed to the opener as a single
 * argument. The suffix test is case-insensitive because the default macOS volume is.
 * @param {'darwin' | 'win32' | 'linux'} platform - supported platform.
 * @param {string} dirPath - already-resolved absolute directory.
 * @returns {string[]} argument vector (never a shell string).
 */
function openerArgsOf(platform, dirPath) {
  if (platform === 'darwin') {
    const lowered = dirPath.toLowerCase()
    for (const suffix of DARWIN_BUNDLE_SUFFIXES) {
      if (lowered.endsWith(suffix)) return ['-R', dirPath]
    }
  }
  return [dirPath]
}

/**
 * Open one already-resolved absolute directory in the platform file manager (SPEC §4.11).
 *
 * @param {string} dirPath - absolute directory the Host resolved from an id.
 * @param {object} [options] - opener dependencies (overridable for tests).
 * @param {string} [options.platform] - platform override; defaults to `process.platform`.
 * @param {(command: string, args: string[], spawnOptions: object) => any} [options.spawn] - child
 *   launcher; defaults to `node:child_process.execFile`. The returned child must expose `once` and
 *   `unref` (any `EventEmitter`-shaped object works). The promise resolves on its `spawn` event (the
 *   process was started) and never waits for the launcher to exit, so a long-lived file manager
 *   cannot hang the route; its `error` event (or a synchronous throw) rejects with `OPEN_FAILED`.
 * @returns {Promise<void>} resolves once the launcher process was started; the child is unref'd and
 *   no output or exit status is awaited.
 * @throws {Error & { code: 'OPEN_UNAVAILABLE' }} when the platform has no opener.
 * @throws {Error & { code: 'OPEN_FAILED' }} when the opener cannot be started.
 */
export async function openDirectory(dirPath, options = {}) {
  const platform = typeof options?.platform === 'string' ? options.platform : process.platform
  const spawn = typeof options?.spawn === 'function' ? options.spawn : execFile
  if (!openSupported(platform)) {
    throw openerError('OPEN_UNAVAILABLE', `Opening a folder is not supported on the "${platform}" platform.`)
  }
  if (typeof dirPath !== 'string' || dirPath === '') {
    throw openerError('OPEN_FAILED', 'There is no directory to open.')
  }
  const command = openerCommandOf(platform)
  const args = openerArgsOf(platform, dirPath)
  return await new Promise((resolve, reject) => {
    let settled = false
    /** @param {string} message - why the launcher could not be started. */
    const fail = (message) => {
      if (settled) return
      settled = true
      reject(openerError('OPEN_FAILED', message))
    }
    const succeed = () => {
      if (settled) return
      settled = true
      resolve()
    }
    /** @type {any} */
    let child
    try {
      child = spawn(command, args, { windowsHide: true })
    } catch (error) {
      // A launcher that cannot even be spawned (ENOENT/EACCES) is `OPEN_FAILED`; the directory path
      // itself is not the problem and must not be reported as bad input.
      fail(`The file manager could not be started: ${errorText(error)}`)
      return
    }
    try {
      if (child !== null && typeof child === 'object' && typeof child.once === 'function') {
        child.once('error', (error) => {
          fail(`The file manager could not be started: ${errorText(error)}`)
        })
        // Fire-and-forget: resolve as soon as the process was started. A launcher that stays alive
        // (a file manager window) must never hold the request open, and a non-zero exit on a success
        // path (Windows explorer.exe) is not observable here — by design.
        child.once('spawn', () => succeed())
      } else {
        // No observable child: the spawn call itself was the launch attempt.
        succeed()
      }
      if (typeof child?.unref === 'function') child.unref()
    } catch (error) {
      fail(`The file manager could not be started: ${errorText(error)}`)
    }
  })
}
