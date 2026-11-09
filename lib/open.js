/**
 * Platform directory opener for dsh-cleanup (SPEC §4.11).
 *
 * The plugin can reveal a directory in the user's file manager. It may only ever open a path the
 * Host resolved itself from an id; this module is the last step and takes an already-resolved
 * absolute directory. It never builds a shell string: the path is passed as one argument vector
 * element, so a directory called `--foo` or one containing spaces can never be interpreted as a
 * command-line option.
 *
 * The call is fire-and-forget: a launcher that exits non-zero on a success path (Windows
 * `explorer.exe`) is not a failure, and the route reports the resolved path whether or not a file
 * manager ends up focused. Only "this platform has no opener" (`OPEN_UNAVAILABLE`) and "the opener
 * could not be started" (`OPEN_FAILED`) are errors.
 *
 * @module dsh-cleanup/lib/open
 */
import { execFile } from 'node:child_process'

/** Platforms this plugin knows how to open a directory on (SPEC §4.11). */
const SUPPORTED_PLATFORMS = Object.freeze(['darwin', 'win32', 'linux'])

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
 * Open one already-resolved absolute directory in the platform file manager (SPEC §4.11).
 *
 * @param {string} dirPath - absolute directory the Host resolved from an id.
 * @param {object} [options] - opener dependencies (overridable for tests).
 * @param {string} [options.platform] - platform override; defaults to `process.platform`.
 * @param {(command: string, args: string[], spawnOptions: object) => any} [options.spawn] - child
 *   launcher; defaults to `node:child_process.execFile`. The returned child must expose `once` and
 *   `unref` (any `EventEmitter`-shaped object works); its `close`/`exit` event resolves the promise
 *   and its `error` event (or a synchronous throw) rejects with `OPEN_FAILED`.
 * @returns {Promise<void>} resolves once the launcher was started; the child is unref'd and never
 *   awaited for focus.
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
      child = spawn(command, [dirPath], { windowsHide: true })
    } catch (error) {
      // A launcher that cannot even be spawned (ENOENT/EACCES) is `OPEN_FAILED`; the directory path
      // itself is not the problem and must not be reported as bad input.
      fail(`The file manager could not be started: ${errorText(error)}`)
      return
    }
    try {
      if (child !== null && typeof child === 'object' && typeof child.once === 'function') {
        // Reject only when the process could not be started; a non-zero exit is fire-and-forget
        // (Windows explorer.exe exits non-zero on success paths).
        child.once('error', (error) => {
          fail(`The file manager could not be started: ${errorText(error)}`)
        })
        child.once('close', () => succeed())
        child.once('exit', () => succeed())
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
