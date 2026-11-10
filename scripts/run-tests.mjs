#!/usr/bin/env node
/**
 * Cross-platform test runner for dsh-cleanup.
 *
 * `node --test 'test/**\/*.test.mjs'` relies on the Node test runner expanding the glob, which only
 * newer Node releases do: Node 20 treats the quoted pattern as a literal path. This script expands
 * the pattern itself (recursively, no dependencies) and spawns the same `node --test` invocation with
 * explicit file paths, so `npm test` behaves identically on every supported Node version.
 *
 * Usage: `npm test` (exit code 1 when any test fails).
 *
 * @module dsh-cleanup/scripts/run-tests
 */
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEST_ROOT = path.join(ROOT, 'test')

/**
 * Collect every `*.test.mjs` file under the test directory, sorted for a stable order.
 * @param {string} directory - absolute directory to walk.
 * @returns {Promise<string[]>} absolute test file paths.
 */
async function collect(directory) {
  /** @type {string[]} */
  const files = []
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collect(absolute)))
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.test.mjs')) continue
    // A directory symlink could point outside the repository; a symlinked file is followed by
    // `node --test` anyway, so keep the walk simple and only require the path to exist.
    try {
      await stat(absolute)
    } catch {
      continue
    }
    files.push(absolute)
  }
  return files.sort()
}

const files = await collect(TEST_ROOT)
if (files.length === 0) {
  process.stderr.write('dsh-cleanup: no test files found under test/\n')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: ROOT,
  stdio: 'inherit',
  // `node --test` exits non-zero on failure; forward the exact status so CI and shells agree.
})
if (result.error !== undefined && result.error !== null) {
  process.stderr.write(`dsh-cleanup: could not start the test runner: ${result.error.message}\n`)
  process.exit(1)
}
process.exit(typeof result.status === 'number' ? result.status : 1)
