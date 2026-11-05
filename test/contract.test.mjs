/**
 * Contract-script tests: `scripts/check-contract.mjs` is the mechanical SPEC/route/code/locale drift
 * gate the plugin runs as `npm run check`. The positive case runs the real script against this
 * checkout; the negative case proves the gate actually fires on drift without ever modifying the
 * checkout — it copies the minimal plugin surface to a throw-away temp root and removes one
 * `error.*` locale key there.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFile = promisify(execFileCallback)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Run the checker in `cwd`; resolves with stdout on success and rejects with `{ code, stdout, stderr }` on drift. */
async function runContractCheck(cwd) {
  return await execFile(process.execPath, ['scripts/check-contract.mjs'], { cwd, timeout: 120_000 })
}

/**
 * Copy the plugin into `destination` for the negative case. The whole checkout is copied (minus the
 * test suite and node_modules) so the checker's package.json/files and locale/ui checks see a complete
 * plugin and the only failure is the drift we inject.
 */
async function copyPluginSurface(destination) {
  await fsp.cp(ROOT, destination, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(ROOT, source)
      if (relative === '') return true
      const [first] = relative.split(path.sep)
      return first !== 'test' && first !== 'node_modules' && first !== '.git'
    },
  })
}

/** @returns {Promise<string>} sha256 of a file, for the "negative check never edits the checkout" proof. */
async function sha256Of(file) {
  return createHash('sha256').update(await fsp.readFile(file)).digest('hex')
}

test('the contract script passes on this checkout and prints its summaries', async () => {
  const { stdout } = await runContractCheck(ROOT)
  assert.match(stdout, /✓ contract check passed/)
  assert.match(stdout, /routes: 14 implemented, 14 documented/)
  assert.match(stdout, /error \+ \d+ warning emitted/)
  assert.match(stdout, /client locale: \d+ keys, \d+ plural bases/)
})

test('the contract script fails with a named drift on a throw-away copy and never touches the checkout', async () => {
  const checkoutBefore = await sha256Of(path.join(ROOT, 'client.js'))
  const tempRoot = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-cleanup-contract-')))
  try {
    const copyRoot = path.join(tempRoot, 'plugin')
    await copyPluginSurface(copyRoot)
    // Remove one `error.*` translation from BOTH dictionaries: key parity still holds, so the check
    // that must fire is the emitted-code translation gate (not a parity error).
    const copyClient = path.join(copyRoot, 'client.js')
    const clientSource = await fsp.readFile(copyClient, 'utf8')
    const drifted = clientSource.replace(/^[ \t]*'error\.SESSION_RUNNING':[^\n]*\n/gm, '')
    assert.notEqual(drifted, clientSource, 'the drift fixture must actually remove the key lines')
    await fsp.writeFile(copyClient, drifted)
    await assert.rejects(
      () => runContractCheck(copyRoot),
      (error) => {
        assert.notEqual(error.code, 0, 'drift must exit non-zero')
        const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
        assert.match(output, /contract check failed/)
        assert.match(output, /emitted error code SESSION_RUNNING has no error\.SESSION_RUNNING translation/, 'the failure names the drift')
        return true
      },
    )
    // The negative fixture lives in /tmp: the real checkout was never modified.
    assert.equal(await sha256Of(path.join(ROOT, 'client.js')), checkoutBefore, 'the checkout must stay untouched')
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true })
  }
})
