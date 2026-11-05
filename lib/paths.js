/**
 * Path safety primitives for dsh-cleanup.
 *
 * This module is the only place that decides "may this path be destroyed". It is deliberately
 * small and pure (string logic plus read-only lstat/realpath). It carries no transport concerns; the
 * few workspace-specific codes it defines (`WORKSPACE_MISSING`, `WORKSPACE_SYMLINK`) are spelled
 * exactly as the wire vocabulary so the engine can pass them through instead of translating.
 *
 * The rules encode one product promise: a deletion may only ever target a directory that the
 * Harness itself created or a user explicitly registered, at a canonical path, and never one
 * that carries the process, the profile, or the file system with it.
 *
 * @module dsh-cleanup/lib/paths
 */
import os from 'node:os'
import path from 'node:path'
import { realpathSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'

/** Stable refusal codes shared by planning and execution. */
export const PATH_CODES = Object.freeze({
  NOT_ABSOLUTE: 'PATH_NOT_ABSOLUTE',
  PROTECTED: 'PATH_PROTECTED',
  SHALLOW: 'PATH_SHALLOW',
  CONTAINS_DSH_HOME: 'CONTAINS_DSH_HOME',
  MISSING: 'WORKSPACE_MISSING',
  SYMLINK: 'WORKSPACE_SYMLINK',
  NOT_DIRECTORY: 'PATH_NOT_DIRECTORY',
  CHANGED: 'PATH_CHANGED',
  NOT_SESSION_DIR: 'PATH_NOT_SESSION_DIR',
})

const WIN32 = process.platform === 'win32'

/**
 * Canonical spelling of an existing path, or null when it does not exist.
 *
 * The Workspace registry stores `fs.realpath` spellings, while the profile home and the protected
 * roots are configured lexically. A symlinked `$DSH_HOME` or `$HOME` therefore compares unequal to
 * its own canonical path unless both sides are canonicalized before the containment checks.
 * @param {string} value - absolute path to canonicalize.
 * @returns {string | null} canonical path, or null when it cannot be resolved.
 */
function canonicalSpelling(value) {
  try {
    return realpathSync(value)
  } catch {
    return null
  }
}

/**
 * Normalize a path spelling for comparison without touching the file system.
 * @param {string} value - path to normalize.
 * @returns {string} absolute-normalized path, or the input when it is not absolute.
 */
function normalizeForCompare(value) {
  const resolved = path.resolve(value)
  return WIN32 ? resolved.toLowerCase() : resolved
}

/**
 * How many segments a resolved path has below its root. The root is `/` on POSIX and a drive or UNC
 * root (`C:\`, `\\server\share\`) on Windows, so `C:\proj` is as shallow as `/proj`.
 * @param {string} value - absolute path.
 * @returns {number} number of segments below the root.
 */
export function pathDepth(value) {
  const root = path.parse(value).root
  const rest = value.startsWith(root) ? value.slice(root.length) : value
  return rest.split(/[\\/]+/u).filter((segment) => segment !== '').length
}

/**
 * The Harness profile home. Read from the environment first because a profile-launched
 * Harness always sets `DSH_HOME`, then fall back to the conventional location.
 * @returns {string} absolute DSH home path.
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '' && path.isAbsolute(fromEnv)) {
    return path.resolve(fromEnv)
  }
  return path.join(os.homedir(), '.dsh')
}

/**
 * Where this plugin moves deleted targets. Kept under `DSH_HOME` on purpose: the trash is part of
 * the profile, so it is backed up, inspected, and removed together with it.
 * @param {string} [configured] - `trashRoot` from the plugin config.
 * @returns {string} absolute trash root.
 */
export function resolveTrashRoot(configured) {
  if (typeof configured === 'string' && configured.trim() !== '' && path.isAbsolute(configured)) {
    return path.resolve(configured)
  }
  return path.join(dshHome(), 'trash', 'dsh-cleanup')
}

/**
 * Whether `child` is `parent` itself or lies inside it, by path segments. Both are resolved
 * lexically, so callers pass canonical spellings.
 * @param {string} parent - candidate ancestor.
 * @param {string} child - candidate descendant.
 * @returns {boolean} true when `child` is at or below `parent`.
 */
export function isInside(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string') return false
  const base = normalizeForCompare(parent)
  const target = normalizeForCompare(child)
  if (base === target) return true
  const relative = path.relative(base, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Compare two path spellings for identity.
 * @param {string} a - first path.
 * @param {string} b - second path.
 * @returns {boolean} true when both spell the same location.
 */
export function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  return normalizeForCompare(a) === normalizeForCompare(b)
}

/**
 * The final segment of a path, for display and typed-confirmation matching.
 * @param {string} value - path.
 * @returns {string} final segment, or the input when it has none.
 */
export function lastSegment(value) {
  const trimmed = value.replace(/[\\/]+$/u, '')
  const base = path.basename(trimmed)
  return base === '' ? trimmed : base
}

/**
 * Directories no deletion may target. Deliberately includes the process working directory and
 * the profile home: removing either breaks the running Harness, and neither is a plausible
 * cleanup target.
 * @returns {string[]} absolute protected paths.
 */
export function protectedRoots() {
  const home = os.homedir()
  const roots = new Set([
    '/',
    home,
    path.dirname(home),
    dshHome(),
    os.tmpdir(),
    process.cwd(),
    '/Applications',
    '/Library',
    '/System',
    '/Users',
    '/Volumes',
    '/bin',
    '/dev',
    '/etc',
    '/opt',
    '/private',
    '/sbin',
    '/tmp',
    '/usr',
    '/var',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
    'C:\\Users',
    'C:\\Windows',
  ])
  // Windows install roots come from the environment too, so a system on another drive or in a
  // non-default location stays protected; the literals above remain the fallback. Entries that are
  // not absolute on this platform (all of the Windows ones on POSIX) are filtered out below.
  for (const variable of ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    const value = process.env[variable]
    if (typeof value === 'string' && value.trim() !== '' && path.isAbsolute(value)) roots.add(value)
  }
  return [...roots].filter((entry) => typeof entry === 'string' && path.isAbsolute(entry))
}

/**
 * Static opinion about a path: is it even allowed to be a deletion target? Performs no I/O, so a
 * plan can refuse early. Only the first violation is reported; the caller shows one reason.
 * @param {string} target - absolute path the user selected.
 * @param {object} [options] - `{ trashRoot }`.
 * @returns {{ ok: true, path: string } | { ok: false, code: string, message: string }}
 */
export function classifyTargetPath(target, options = {}) {
  if (typeof target !== 'string' || target.trim() === '') {
    return { ok: false, code: PATH_CODES.NOT_ABSOLUTE, message: 'The target path is empty.' }
  }
  if (!path.isAbsolute(target)) {
    return { ok: false, code: PATH_CODES.NOT_ABSOLUTE, message: 'The target path is not absolute.' }
  }
  const resolved = path.resolve(target)
  const trashRoot = resolveTrashRoot(options.trashRoot)
  const home = dshHome()

  if (samePath(resolved, path.parse(resolved).root)) {
    return { ok: false, code: PATH_CODES.SHALLOW, message: 'A file-system root cannot be deleted.' }
  }
  if (pathDepth(resolved) < 2) {
    return { ok: false, code: PATH_CODES.SHALLOW, message: 'A top-level directory cannot be deleted.' }
  }

  // A caller that already canonicalized the target (the engine does, right before this call) passes
  // it in; otherwise canonicalize here. Both spellings are then compared against both spellings of
  // every protected root, so a symlinked home/profile cannot hide a protected location.
  const canonicalTarget = typeof options.canonicalTarget === 'string' && options.canonicalTarget !== ''
    ? options.canonicalTarget
    : canonicalSpelling(resolved)
  const targetSpellings = [resolved]
  if (canonicalTarget !== null && !samePath(canonicalTarget, resolved)) targetSpellings.push(canonicalTarget)
  /** @param {string} value @returns {string[]} */
  const bothSpellings = (value) => {
    const canonical = canonicalSpelling(value)
    return canonical === null || samePath(canonical, value) ? [value] : [value, canonical]
  }
  const homeSpellings = bothSpellings(home)
  const trashSpellings = bothSpellings(trashRoot)
  // The process working directory is itself protected by exact match above; its ancestors need the
  // containment direction as well. Deleting a folder that contains the running Harness' cwd tears
  // the process (and this plugin) out from under itself — the same class of accident as deleting
  // the profile home (SPEC §5.3).
  const cwdSpellings = bothSpellings(process.cwd())

  for (const root of protectedRoots()) {
    for (const rootSpelling of bothSpellings(root)) {
      if (targetSpellings.some((spelling) => samePath(rootSpelling, spelling))) {
        return {
          ok: false,
          code: PATH_CODES.PROTECTED,
          message: `"${resolved}" is a protected location and cannot be deleted.`,
        }
      }
    }
  }
  for (const spelling of targetSpellings) {
    if (cwdSpellings.some((cwdSpelling) => isInside(spelling, cwdSpelling))) {
      return {
        ok: false,
        code: PATH_CODES.PROTECTED,
        message: 'This directory contains the process working directory and cannot be deleted.',
      }
    }
    if (homeSpellings.some((homeSpelling) => isInside(spelling, homeSpelling))) {
      return {
        ok: false,
        code: PATH_CODES.CONTAINS_DSH_HOME,
        message: 'This directory contains the Harness profile home and cannot be deleted.',
      }
    }
    if (homeSpellings.some((homeSpelling) => isInside(homeSpelling, spelling))) {
      return {
        ok: false,
        code: PATH_CODES.PROTECTED,
        message: 'This directory is inside the Harness profile home and cannot be deleted.',
      }
    }
    // Trash must be protected in BOTH directions. "Target is inside the trash" alone let a
    // workspace that CONTAINS the configured trash root be deleted, taking every recoverable entry
    // with it.
    if (trashSpellings.some((trashSpelling) => isInside(trashSpelling, spelling))) {
      return {
        ok: false,
        code: PATH_CODES.PROTECTED,
        message: 'This directory is the cleanup trash and cannot be deleted.',
      }
    }
    if (trashSpellings.some((trashSpelling) => isInside(spelling, trashSpelling))) {
      return {
        ok: false,
        code: PATH_CODES.PROTECTED,
        message: 'This directory contains the cleanup trash and cannot be deleted without destroying recoverable data.',
      }
    }
  }
  return { ok: true, path: resolved }
}

/**
 * Resolve one existing directory to its canonical spelling, refusing anything that is not a real
 * directory. Read-only.
 * @param {string} target - absolute or relative path.
 * @returns {Promise<{ ok: true, path: string } | { ok: false, code: string, message: string, missing?: boolean }>}
 */
export async function canonicalizeDirectory(target) {
  if (typeof target !== 'string' || target.trim() === '' || !path.isAbsolute(target)) {
    return { ok: false, code: PATH_CODES.NOT_ABSOLUTE, message: 'The target path is not absolute.' }
  }
  const resolved = path.resolve(target)
  let entry
  try {
    entry = await lstat(resolved)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { ok: false, code: PATH_CODES.MISSING, message: `"${resolved}" no longer exists.`, missing: true }
    }
    return {
      ok: false,
      code: PATH_CODES.PROTECTED,
      message: `"${resolved}" cannot be inspected: ${String(error?.message ?? error)}`,
    }
  }
  if (entry.isSymbolicLink()) {
    return {
      ok: false,
      code: PATH_CODES.SYMLINK,
      message: `"${resolved}" is a symbolic link; delete its target explicitly instead.`,
    }
  }
  if (!entry.isDirectory()) {
    return { ok: false, code: PATH_CODES.NOT_DIRECTORY, message: `"${resolved}" is not a directory.` }
  }
  let canonical
  try {
    canonical = await realpath(resolved)
  } catch (error) {
    return {
      ok: false,
      code: PATH_CODES.PROTECTED,
      message: `"${resolved}" cannot be resolved: ${String(error?.message ?? error)}`,
    }
  }
  return { ok: true, path: canonical }
}

/**
 * Derive a stored session's directory from its persistence location, accepting it only when the
 * surrounding layout is the JSONL backend's (`<root>/--<cwd>--/<id>/<file>` or `_no-cwd`). This is
 * the ownership check for deleting a session log: an unexpected layout is refused rather than
 * guessed at.
 * @param {string | undefined} filePath - `location.path` from a persistence snapshot.
 * @returns {{ ok: true, sessionDir: string, projectDir: string } | { ok: false, code: string, message: string }}
 */
export function sessionDirectoryFromLocation(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '' || !path.isAbsolute(filePath)) {
    return { ok: false, code: PATH_CODES.NOT_SESSION_DIR, message: 'The session has no stored location.' }
  }
  const file = path.resolve(filePath)
  const sessionDir = path.dirname(file)
  const projectDir = path.dirname(sessionDir)
  if (samePath(sessionDir, projectDir) || samePath(projectDir, path.parse(projectDir).root)) {
    return { ok: false, code: PATH_CODES.NOT_SESSION_DIR, message: 'The session log is not in a session directory.' }
  }
  const projectName = path.basename(projectDir)
  const looksLikeProject = projectName === '_no-cwd' || (projectName.startsWith('--') && projectName.endsWith('--'))
  if (!looksLikeProject) {
    return {
      ok: false,
      code: PATH_CODES.NOT_SESSION_DIR,
      message: `"${sessionDir}" does not look like a stored session directory.`,
    }
  }
  if (pathDepth(sessionDir) < 3) {
    return { ok: false, code: PATH_CODES.NOT_SESSION_DIR, message: 'The session directory is too close to the root.' }
  }
  return { ok: true, sessionDir, projectDir }
}

/**
 * Build a human-recognizable, file-system-safe trash entry id.
 * @param {number} epochMs - move time.
 * @param {string} label - title or path segment used as the readable part.
 * @param {() => number} [random] - injectable randomness for tests (0..1).
 * @returns {string} entry id such as `20261104T101500Z-proj-8f3a`.
 */
export function trashEntryId(epochMs, label, random = Math.random) {
  const stamp = new Date(epochMs).toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
  const slug = String(label)
    .normalize('NFKD')
    .replace(/[^\w.-]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')
    .slice(0, 40)
  const suffix = Math.floor(random() * 0xffff)
    .toString(16)
    .padStart(4, '0')
  return `${stamp}-${slug === '' ? 'item' : slug}-${suffix}`
}
