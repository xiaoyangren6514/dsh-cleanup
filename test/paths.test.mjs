/**
 * Contract tests for lib/paths.js (frozen, Lead-owned).
 *
 * These tests import the module and exercise it against a throw-away temp root. They never touch
 * `$HOME`, `~/.dsh`, or anything outside the mkdtemp root created below. Only env var `DSH_HOME` is
 * mutated (and restored) because it is the documented override of `dshHome()`.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  PATH_CODES,
  canonicalizeDirectory,
  classifyTargetPath,
  dshHome,
  isInside,
  lastSegment,
  pathDepth,
  protectedRoots,
  resolveTrashRoot,
  samePath,
  sessionDirectoryFromLocation,
  trashEntryId,
} from '../lib/paths.js'

/** @type {string} */
let TMP
let caseId = 0

before(async () => {
  TMP = await fsp.realpath(await fsp.mkdtemp(os.tmpdir() + '/dsh-cleanup-test-paths-'))
})

after(async () => {
  await fsp.rm(TMP, { recursive: true, force: true })
})

/** Unique directory under the per-file temp root. */
async function caseDir() {
  const dir = path.join(TMP, `case-${++caseId}`)
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

/** Run `fn` with `process.env.DSH_HOME` temporarily set to `value` (or unset when undefined). */
async function withDshHome(value, fn) {
  const saved = process.env.DSH_HOME
  try {
    if (value === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = value
    return await fn()
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
}

describe('PATH_CODES', () => {
  test('exposes the wire codes the engine relies on', () => {
    assert.deepEqual(PATH_CODES, {
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
    assert.ok(Object.isFrozen(PATH_CODES))
  })
})

describe('pathDepth', () => {
  test('counts the segments below the file-system root', () => {
    const root = path.parse(TMP).root
    assert.equal(pathDepth(root), 0)
    assert.equal(pathDepth(path.join(root, 'top')), 1)
    assert.equal(pathDepth(path.join(root, 'a', 'b')), 2)
  })

  test('ignores a trailing separator', () => {
    const root = path.parse(TMP).root
    assert.equal(pathDepth(path.join(root, 'a', 'b') + path.sep), 2)
  })
})

describe('isInside', () => {
  test('is true for the same path', () => {
    assert.equal(isInside('/a/b', '/a/b'), true)
  })

  test('is true for a descendant', () => {
    assert.equal(isInside('/a/b', '/a/b/c'), true)
    assert.equal(isInside('/a/b', '/a/b/c/d.txt'), true)
  })

  test('is false for the ancestor direction', () => {
    assert.equal(isInside('/a/b/c', '/a/b'), false)
  })

  test('is segment-aware, not string-prefix aware', () => {
    assert.equal(isInside('/a/ws', '/a/ws-evil'), false)
    assert.equal(isInside('/a/ws', '/a/ws2'), false)
  })

  test('is false for siblings and unrelated paths', () => {
    assert.equal(isInside('/a/b', '/a/c'), false)
    assert.equal(isInside('/a/b', '/x/y'), false)
  })

  test('normalizes trailing slashes and dot segments', () => {
    assert.equal(isInside('/a/b/', '/a/b/c'), true)
    assert.equal(isInside('/a/b', '/a/b/./c'), true)
    assert.equal(isInside('/a/b', '/a/b/../b/c'), true)
    assert.equal(isInside('/a/b', '/a/b/../c'), false)
  })

  test('is false when either argument is not a string', () => {
    assert.equal(isInside(undefined, '/a'), false)
    assert.equal(isInside('/a', null), false)
    assert.equal(isInside(42, '/a'), false)
  })
})

describe('samePath', () => {
  test('compares normalized spellings', () => {
    assert.equal(samePath('/a/b', '/a/b/'), true)
    assert.equal(samePath('/a/b', '/a/./b'), true)
    assert.equal(samePath('/a/b', '/a/c'), false)
    assert.equal(samePath('/a/b', '/a/bc'), false)
  })

  test('is false for non-strings', () => {
    assert.equal(samePath('/a', undefined), false)
    assert.equal(samePath(null, null), false)
  })
})

describe('lastSegment', () => {
  test('returns the final segment', () => {
    assert.equal(lastSegment('/a/b'), 'b')
    assert.equal(lastSegment('/a/b/'), 'b')
    assert.equal(lastSegment('/a/b///'), 'b')
  })

  test('returns an empty string for root and empty input', () => {
    assert.equal(lastSegment('/'), '')
    assert.equal(lastSegment(''), '')
  })
})

describe('dshHome', () => {
  test('prefers an absolute DSH_HOME', async () => {
    const fake = path.join(TMP, 'profile-home')
    await withDshHome(fake, () => {
      assert.equal(dshHome(), fake)
    })
  })

  test('falls back to ~/.dsh when DSH_HOME is relative, empty or unset', async () => {
    const fallback = path.join(os.homedir(), '.dsh')
    await withDshHome('relative/profile', () => assert.equal(dshHome(), fallback))
    await withDshHome('   ', () => assert.equal(dshHome(), fallback))
    await withDshHome(undefined, () => assert.equal(dshHome(), fallback))
  })
})

describe('resolveTrashRoot', () => {
  test('uses an absolute configured trashRoot', async () => {
    const configured = path.join(TMP, 'custom-trash')
    assert.equal(resolveTrashRoot(configured), configured)
  })

  test('ignores a non-absolute configured trashRoot', async () => {
    const fakeHome = path.join(TMP, 'profile-home-2')
    await withDshHome(fakeHome, () => {
      assert.equal(resolveTrashRoot('relative/trash'), path.join(fakeHome, 'trash', 'dsh-cleanup'))
      assert.equal(resolveTrashRoot(''), path.join(fakeHome, 'trash', 'dsh-cleanup'))
      assert.equal(resolveTrashRoot(undefined), path.join(fakeHome, 'trash', 'dsh-cleanup'))
    })
  })
})

describe('protectedRoots', () => {
  test('contains the process, profile and file-system roots as absolute paths', async () => {
    const roots = protectedRoots()
    assert.ok(Array.isArray(roots))
    assert.ok(roots.length > 0)
    for (const root of roots) assert.ok(path.isAbsolute(root), `not absolute: ${root}`)
    assert.equal(new Set(roots).size, roots.length, 'roots must be unique')
    assert.ok(roots.includes(path.resolve(os.homedir())))
    assert.ok(roots.includes(path.resolve(process.cwd())))
    await withDshHome(path.join(TMP, 'profile-home-3'), () => {
      assert.ok(protectedRoots().includes(path.join(TMP, 'profile-home-3')))
    })
  })
})

describe('classifyTargetPath: refusal rules', () => {
  test('refuses empty and non-string input', () => {
    for (const value of ['', '   ', undefined, null, 42]) {
      const result = classifyTargetPath(value)
      assert.equal(result.ok, false)
      assert.equal(result.code, PATH_CODES.NOT_ABSOLUTE)
    }
  })

  test('refuses relative paths', () => {
    const result = classifyTargetPath('relative/dir')
    assert.equal(result.ok, false)
    assert.equal(result.code, PATH_CODES.NOT_ABSOLUTE)
  })

  test('refuses the file-system root as shallow', () => {
    const result = classifyTargetPath('/')
    assert.equal(result.ok, false)
    assert.equal(result.code, PATH_CODES.SHALLOW)
  })

  test('refuses a top-level directory as shallow', { skip: process.platform === 'win32' }, () => {
    const result = classifyTargetPath('/var')
    assert.equal(result.ok, false)
    assert.equal(result.code, PATH_CODES.SHALLOW)
  })

  test('refuses a protected root (process.cwd)', () => {
    const result = classifyTargetPath(process.cwd())
    assert.equal(result.ok, false)
    assert.equal(result.code, PATH_CODES.PROTECTED)
  })

  test('refuses a directory that contains DSH_HOME', async () => {
    const root = await caseDir()
    const ancestor = path.join(root, 'ancestor')
    await fsp.mkdir(ancestor)
    await withDshHome(path.join(ancestor, 'deep', 'dsh-home'), () => {
      const result = classifyTargetPath(ancestor)
      assert.equal(result.ok, false)
      assert.equal(result.code, PATH_CODES.CONTAINS_DSH_HOME)
    })
  })

  test('canonicalizes a symlinked DSH_HOME before the containment check', async () => {
    // The registry stores realpath spellings while the profile home is configured lexically, so
    // a symlinked DSH_HOME hid its own containment. The symlink lives outside the target below, so
    // only the canonical spelling reveals that the target contains the profile home.
    const root = await caseDir()
    const realHome = path.join(root, 'real-home')
    await fsp.mkdir(realHome, { recursive: true })
    const linkHome = path.join(TMP, `profile-link-${caseId}`)
    await fsp.symlink(realHome, linkHome, 'dir')
    await withDshHome(linkHome, () => {
      assert.equal(isInside(root, linkHome), false, 'the lexical DSH_HOME spelling is not inside the target')
      const result = classifyTargetPath(root)
      assert.equal(result.ok, false)
      assert.equal(result.code, PATH_CODES.CONTAINS_DSH_HOME)
    })
  })

  test('refuses DSH_HOME itself and anything inside it', async () => {
    const root = await caseDir()
    const fakeHome = path.join(root, 'dsh-home')
    await fsp.mkdir(path.join(fakeHome, 'sessions'), { recursive: true })
    await withDshHome(fakeHome, () => {
      const exact = classifyTargetPath(fakeHome)
      assert.equal(exact.ok, false)
      assert.equal(exact.code, PATH_CODES.PROTECTED)
      const inside = classifyTargetPath(path.join(fakeHome, 'sessions'))
      assert.equal(inside.ok, false)
      assert.equal(inside.code, PATH_CODES.PROTECTED)
    })
  })

  test('refuses the trash root and anything inside it', async () => {
    const root = await caseDir()
    const trashRoot = path.join(root, 'trash')
    await fsp.mkdir(path.join(trashRoot, 'entry-1'), { recursive: true })
    const exact = classifyTargetPath(trashRoot, { trashRoot })
    assert.equal(exact.ok, false)
    assert.equal(exact.code, PATH_CODES.PROTECTED)
    const inside = classifyTargetPath(path.join(trashRoot, 'entry-1'), { trashRoot })
    assert.equal(inside.ok, false)
    assert.equal(inside.code, PATH_CODES.PROTECTED)
  })

  test('accepts an ordinary directory and returns its resolved spelling', async () => {
    const root = await caseDir()
    const dir = path.join(root, 'project')
    await fsp.mkdir(dir)
    const result = classifyTargetPath(dir)
    assert.deepEqual(result, { ok: true, path: dir })
    const dotted = classifyTargetPath(path.join(root, 'project', '.', ''))
    assert.deepEqual(dotted, { ok: true, path: dir })
  })

  test('accepts a sibling of the trash root', async () => {
    const root = await caseDir()
    const dir = path.join(root, 'project')
    await fsp.mkdir(dir)
    const result = classifyTargetPath(dir, { trashRoot: path.join(root, 'trash') })
    assert.equal(result.ok, true)
  })
})

describe('canonicalizeDirectory', () => {
  test('refuses non-absolute input', async () => {
    for (const value of ['', 'relative', undefined, 42]) {
      const result = await canonicalizeDirectory(value)
      assert.equal(result.ok, false)
      assert.equal(result.code, PATH_CODES.NOT_ABSOLUTE)
    }
  })

  test('reports a missing directory as MISSING/missing', async () => {
    const root = await caseDir()
    const result = await canonicalizeDirectory(path.join(root, 'nope'))
    assert.equal(result.ok, false)
    assert.equal(result.code, PATH_CODES.MISSING)
    assert.equal(result.missing, true)
  })

  test('refuses a regular file', async () => {
    const root = await caseDir()
    const file = path.join(root, 'file.txt')
    await fsp.writeFile(file, 'x')
    const result = await canonicalizeDirectory(file)
    assert.equal(result.ok, false)
    assert.equal(result.code, PATH_CODES.NOT_DIRECTORY)
  })

  test('refuses a symlink even when it points at a directory', async () => {
    const root = await caseDir()
    const real = path.join(root, 'real')
    await fsp.mkdir(real)
    const link = path.join(root, 'link')
    await fsp.symlink(real, link, 'dir')
    const result = await canonicalizeDirectory(link)
    assert.equal(result.ok, false)
    assert.equal(result.code, PATH_CODES.SYMLINK)
  })

  test('returns the canonical realpath of a directory', async () => {
    const root = await caseDir()
    const dir = path.join(root, 'real')
    await fsp.mkdir(dir)
    const result = await canonicalizeDirectory(dir)
    assert.equal(result.ok, true)
    assert.equal(result.path, await fsp.realpath(dir))
    assert.equal(result.path, dir)
  })

  test('canonicalizes a path that reaches through a symlink ancestor', async () => {
    const root = await caseDir()
    const real = path.join(root, 'real')
    await fsp.mkdir(path.join(real, 'child'), { recursive: true })
    const link = path.join(root, 'link')
    await fsp.symlink(real, link, 'dir')
    const result = await canonicalizeDirectory(path.join(link, 'child'))
    assert.equal(result.ok, true)
    assert.equal(result.path, path.join(real, 'child'))
    assert.notEqual(result.path, path.join(link, 'child'))
  })
})

describe('sessionDirectoryFromLocation', () => {
  test('accepts the --cwd-- JSONL layout', () => {
    const file = path.join(TMP, 'sessions', '--Users-u-proj--', 'session-1', 'log.jsonl')
    const result = sessionDirectoryFromLocation(file)
    assert.deepEqual(result, {
      ok: true,
      sessionDir: path.join(TMP, 'sessions', '--Users-u-proj--', 'session-1'),
      projectDir: path.join(TMP, 'sessions', '--Users-u-proj--'),
    })
  })

  test('accepts the _no-cwd project directory', () => {
    const file = path.join(TMP, 'sessions', '_no-cwd', 'session-1', 'log.jsonl')
    const result = sessionDirectoryFromLocation(file)
    assert.equal(result.ok, true)
    assert.equal(result.projectDir, path.join(TMP, 'sessions', '_no-cwd'))
  })

  test('refuses a missing / empty / non-absolute / non-string location', () => {
    for (const value of [undefined, null, '', 'relative/log.jsonl', 42]) {
      const result = sessionDirectoryFromLocation(value)
      assert.equal(result.ok, false)
      assert.equal(result.code, PATH_CODES.NOT_SESSION_DIR)
    }
  })

  test('refuses a project directory that is not --…-- or _no-cwd', () => {
    const file = path.join(TMP, 'sessions', 'somestore', 'session-1', 'log.jsonl')
    const result = sessionDirectoryFromLocation(file)
    assert.equal(result.ok, false)
    assert.equal(result.code, PATH_CODES.NOT_SESSION_DIR)
  })

  test('refuses --…-- spellings that do not both start and end with --', () => {
    // NOTE: the frozen code accepts the bare '--' project name (both prefixes match); the SPEC
    // spelling `--…--` does not say whether the middle may be empty, so it is not asserted here.
    for (const project of ['-x--', '--x--y', 'x--', '-']) {
      const file = path.join(TMP, 'sessions', project, 'session-1', 'log.jsonl')
      const result = sessionDirectoryFromLocation(file)
      assert.equal(result.ok, false, project)
      assert.equal(result.code, PATH_CODES.NOT_SESSION_DIR, project)
    }
  })

  test('refuses a location whose project directory is the filesystem root', { skip: process.platform === 'win32' }, () => {
    const file = '/--proj--/session-1/log.jsonl'
    const result = sessionDirectoryFromLocation(file)
    assert.equal(result.ok, false)
    assert.equal(result.code, PATH_CODES.NOT_SESSION_DIR)
  })

  test('refuses a session directory that is too close to the root', { skip: process.platform === 'win32' }, () => {
    // Parent is a valid --proj-- name but the session dir has only two segments.
    const result = sessionDirectoryFromLocation('/--proj--/session-1/log.jsonl')
    assert.equal(result.ok, false)
    assert.equal(result.code, PATH_CODES.NOT_SESSION_DIR)
  })
})

describe('trashEntryId', () => {
  test('builds the documented readable id shape', () => {
    // SPEC §5.7 (amended) and the §4.5 example both spell the UTC stamp with the trailing Z:
    // entryId = <UTC yyyymmddThhmmssZ>-<slug>-<4 hex>. Ids are opaque.
    assert.equal(trashEntryId(Date.UTC(2026, 10, 4, 10, 15, 0), 'proj', () => 0), '20261104T101500Z-proj-0000')
  })

  test('is unique for distinct randomness', () => {
    const a = trashEntryId(1, 'proj', () => 0.25)
    const b = trashEntryId(1, 'proj', () => 0.75)
    assert.notEqual(a, b)
    assert.match(a, /^[0-9]{8}T[0-9]{6}Z-proj-[0-9a-f]{4}$/)
  })

  test('sanitizes unsafe slug characters and caps the slug length', () => {
    const id = trashEntryId(0, 'My Project!!/../ok', () => 0)
    assert.match(id, /^19700101T000000Z-[A-Za-z0-9._-]+-0000$/)
    assert.ok(!id.includes('/'))
    assert.equal(path.basename(id), id, 'the id must stay a single path segment')
    const long = trashEntryId(0, 'x'.repeat(200), () => 0)
    const slug = long.split('-').slice(1, -1).join('-')
    assert.ok(slug.length <= 40)
  })

  test('falls back to "item" for an empty slug', () => {
    assert.match(trashEntryId(0, '中文项目', () => 0), /^19700101T000000Z-item-0000$/)
    assert.match(trashEntryId(0, '', () => 0), /^19700101T000000Z-item-0000$/)
  })
})

describe('process working directory ancestors (release hardening)', () => {
  test('refuses a directory that contains the process working directory', async () => {
    const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-cleanup-cwd-')))
    const work = path.join(root, 'projects', 'work')
    await fsp.mkdir(work, { recursive: true })
    const saved = process.cwd()
    try {
      process.chdir(work)
      const ancestor = classifyTargetPath(path.join(root, 'projects'))
      assert.equal(ancestor.ok, false)
      assert.equal(ancestor.code, PATH_CODES.PROTECTED)
      assert.match(ancestor.message, /working directory/)
      // The cwd itself is already an exact protected root; a sibling stays allowed.
      const sibling = path.join(root, 'other')
      await fsp.mkdir(sibling, { recursive: true })
      assert.equal(classifyTargetPath(sibling).ok, true)
    } finally {
      process.chdir(saved)
      await fsp.rm(root, { recursive: true, force: true })
    }
  })
})
