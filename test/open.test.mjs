/**
 * Contract tests for lib/open.js (SPEC §4.11): the platform directory opener.
 *
 * The opener is the only place that shells out, so every case here injects a
 * `child_process.spawn`-shaped fake: no test launches a real file manager, starts a process, or
 * touches a path outside the assertions. The command/argv table is the contract under test —
 * SPEC §4.11 forbids a shell string, so the assertions pin the exactly-two-element argument vector.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { openSupported, openDirectory } from '../lib/open.js'

const SUPPORTED = ['darwin', 'win32', 'linux']
const UNSUPPORTED = ['freebsd', 'openbsd', 'netbsd', 'aix', 'sunos', 'android', 'cygwin']

/**
 * A `child_process.spawn`-shaped fake. It records every call and lets the test script the child's
 * event sequence: by default it reports a clean `spawn` followed by a `close`, unless the script says
 * otherwise.
 *
 * `neverExit: true` models a launcher that stays alive after starting (a file manager window): it
 * emits `spawn` and then nothing, which is exactly the case a fire-and-forget opener must resolve on.
 *
 * @param {object} [script] - `{ exitCode, error, throwSync, neverExit }`.
 * @returns {{ spawn: Function, calls: object[], children: EventEmitter[] }}
 */
function makeFakeSpawn(script = {}) {
  /** @type {object[]} */
  const calls = []
  /** @type {EventEmitter[]} */
  const children = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    if (script.throwSync !== undefined) throw script.throwSync
    const child = new EventEmitter()
    child.unrefCalled = false
    child.unref = () => {
      child.unrefCalled = true
    }
    children.push(child)
    // Emit asynchronously like a real child process, after the implementation attached its
    // listeners (a synchronous emit would make a resolve-on-spawn implementation look broken).
    process.nextTick(() => {
      if (script.error !== undefined) {
        child.emit('error', script.error)
        return
      }
      child.emit('spawn')
      if (script.neverExit !== true) child.emit('close', script.exitCode ?? 0, null)
    })
    return child
  }
  return { spawn, calls, children }
}

/**
 * Run `openDirectory` and return the rejection reason, so a synchronous throw and a rejected
 * promise are handled the same way.
 * @param {() => Promise<unknown>} invoke - call under test.
 * @returns {Promise<unknown>} the rejection value; the test fails when it resolves.
 */
async function rejectionOf(invoke) {
  try {
    await invoke()
  } catch (error) {
    return error
  }
  assert.fail('expected the opener to reject')
}

describe('openSupported (SPEC §3 capabilities / §4.11)', () => {
  test('is true exactly on the three supported platforms', () => {
    for (const platform of SUPPORTED) assert.equal(openSupported(platform), true, platform)
    for (const platform of UNSUPPORTED) assert.equal(openSupported(platform), false, platform)
  })

  test('defaults to the current process platform', () => {
    assert.equal(openSupported(), SUPPORTED.includes(process.platform))
  })

  test('treats an empty or non-string platform as unsupported', () => {
    for (const platform of ['', 'DARWIN', 'linux2', null, undefined, 42]) {
      // `undefined` means "use the default"; everything else must not be guessed into a platform.
      if (platform === undefined) continue
      assert.equal(openSupported(platform), false, JSON.stringify(platform))
    }
  })
})

describe('openDirectory command table (SPEC §4.11)', () => {
  const cases = [
    ['darwin', 'open'],
    ['linux', 'xdg-open'],
    ['win32', 'explorer.exe'],
  ]
  for (const [platform, command] of cases) {
    test(`${platform} launches "${command}" with an argument vector containing the directory`, async () => {
      const fake = makeFakeSpawn()
      const dir = pathFor(platform)
      await openDirectory(dir, { platform, spawn: fake.spawn })
      assert.equal(fake.calls.length, 1)
      assert.equal(fake.calls[0].command, command)
      // SPEC §4.11: an argument vector, never a shell string. Exactly one element, the directory.
      assert.ok(Array.isArray(fake.calls[0].args), 'args must be an array')
      assert.deepEqual(fake.calls[0].args, [dir])
      assert.equal(fake.calls[0].options?.windowsHide, true)
      assert.equal(fake.children[0].unrefCalled, true, 'the child is unref()ed so the Host is never held open')
    })
  }

  test('a non-zero launcher exit is not a failure (Windows explorer.exe exits 1 on success)', async () => {
    const fake = makeFakeSpawn({ exitCode: 1 })
    await openDirectory(pathFor('win32'), { platform: 'win32', spawn: fake.spawn })
    assert.equal(fake.calls.length, 1)
  })

  test('resolves without waiting for output and never reads a shell', async () => {
    const fake = makeFakeSpawn()
    const result = await openDirectory(pathFor('darwin'), { platform: 'darwin', spawn: fake.spawn })
    assert.equal(result, undefined)
    // No shell string anywhere: the second positional argument is the argv array, not a command line.
    assert.equal(typeof fake.calls[0].args, 'object')
  })

  test('resolves once the launcher spawned and never waits for it to exit', async () => {
    // A long-lived launcher (open file-manager window) must not hang POST /api/cleanup.open.
    const fake = makeFakeSpawn({ neverExit: true })
    const result = await openDirectory(pathFor('linux'), { platform: 'linux', spawn: fake.spawn })
    assert.equal(result, undefined)
    assert.equal(fake.calls.length, 1)
    assert.equal(fake.children[0].unrefCalled, true)
  })

  test('reveals macOS application bundles with "open -R" instead of launching them', async () => {
    for (const suffix of ['.app', '.bundle', '.workflow', '.pkg']) {
      const fake = makeFakeSpawn()
      const target = `/Applications/Some Tool${suffix}`
      await openDirectory(target, { platform: 'darwin', spawn: fake.spawn })
      assert.equal(fake.calls.length, 1)
      assert.equal(fake.calls[0].command, 'open')
      assert.deepEqual(fake.calls[0].args, ['-R', target], `${suffix} must be revealed, not launched`)
    }
  })

  test('keeps the plain argv for ordinary directories and for bundle-named paths off darwin', async () => {
    const darwin = makeFakeSpawn()
    await openDirectory('/Users/someone/.dsh', { platform: 'darwin', spawn: darwin.spawn })
    assert.deepEqual(darwin.calls[0].args, ['/Users/someone/.dsh'])

    for (const platform of ['linux', 'win32']) {
      const fake = makeFakeSpawn()
      const target = pathFor(platform) + '.app'
      await openDirectory(target, { platform, spawn: fake.spawn })
      assert.deepEqual(fake.calls[0].args, [target], `${platform} has no launchable-bundle special case`)
    }
  })
})

describe('openDirectory failure classification (SPEC §4.11/§4.6)', () => {
  test('rejects OPEN_UNAVAILABLE on an unsupported platform without spawning anything', async () => {
    for (const platform of UNSUPPORTED) {
      const fake = makeFakeSpawn()
      const error = await rejectionOf(() => openDirectory('/tmp/whatever', { platform, spawn: fake.spawn }))
      assert.equal(error?.code, 'OPEN_UNAVAILABLE', platform)
      assert.equal(fake.calls.length, 0, `no opener may be started on ${platform}`)
    }
  })

  test('rejects OPEN_FAILED when the opener cannot be started (ENOENT)', async () => {
    const enoent = Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' })
    const fake = makeFakeSpawn({ error: enoent })
    const error = await rejectionOf(() => openDirectory('/tmp/whatever', { platform: 'linux', spawn: fake.spawn }))
    assert.equal(error?.code, 'OPEN_FAILED')
    assert.match(String(error?.message), /ENOENT|start/i)
  })

  test('rejects OPEN_FAILED on EACCES as well', async () => {
    const eacces = Object.assign(new Error('spawn open EACCES'), { code: 'EACCES' })
    const fake = makeFakeSpawn({ error: eacces })
    const error = await rejectionOf(() => openDirectory('/tmp/whatever', { platform: 'darwin', spawn: fake.spawn }))
    assert.equal(error?.code, 'OPEN_FAILED')
  })

  test('rejects OPEN_FAILED when spawn itself throws', async () => {
    const boom = Object.assign(new Error('spawn exploded'), { code: 'EPERM' })
    const fake = makeFakeSpawn({ throwSync: boom })
    const error = await rejectionOf(() => openDirectory('/tmp/whatever', { platform: 'darwin', spawn: fake.spawn }))
    assert.equal(error?.code, 'OPEN_FAILED')
  })

  test('the default opener rejects OPEN_UNAVAILABLE before spawning on an unsupported platform', async () => {
    // No spawn injection needed: the platform check happens first, so no real launcher is started.
    const error = await rejectionOf(() => openDirectory('/tmp/whatever', { platform: 'freebsd' }))
    assert.equal(error?.code, 'OPEN_UNAVAILABLE')
  })
})

/** A platform-appropriate-but-harmless path for argv assertions. */
function pathFor(platform) {
  return platform === 'win32' ? 'C:\\Users\\someone\\.dsh' : '/tmp/dsh-cleanup-open-target'
}
