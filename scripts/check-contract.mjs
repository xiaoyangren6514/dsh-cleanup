#!/usr/bin/env node
/**
 * Contract checker for dsh-cleanup.
 *
 * The plugin has four surfaces that must agree: the frozen SPEC, the Host route table, the wire codes
 * the engine can emit, and the client locale dictionaries. Reviews keep finding drifts that no test
 * catches (a route added without SPEC text, a code emitted without a translation), so this script
 * compares them mechanically and fails CI on any disagreement.
 *
 * Usage: `npm run check` (exit code 1 on drift).
 *
 * Checks:
 *  1. SPEC route list == index.js route table (and every route is a POST under /api).
 *  2. Every error/warning code the engine can emit is listed in SPEC and localized by the client.
 *  3. Every SPEC §4.6/§5.4 code is either emitted, or documented as client/settings-only. The scan
 *     also covers the opener module's `openerError('CODE')` emitter, so a new Host module cannot slip
 *     an undocumented wire code past the check.
 *  4. The `files` allowlist in package.json actually matches shipped files: glob entries
 *     (`lib/*.js`, `locale/ui/*.json`) are expanded and every matched file must exist.
 *  5. Plugin-manager locale metadata (`locale/<lang>.json`) parses and carries a non-empty
 *     title/description/detail, and the detail document it names exists.
 *  6. The SPEC's open-kind vocabulary (`session`/`workspace`/`trash`/`cache`) and the inventory
 *     capability keys are present in the Host source rather than only in prose.
 *  7. Client locale: zh/en key parity, identical `{param}` sets, every literal `t()` key present,
 *     and every plural base has `_one`/`_other`. The published mirrors `locale/ui/en.json` and
 *     `locale/ui/zh.json` must be identical to the inline `en`/`zh` dictionaries (same key set,
 *     same values; key order is free). Any other `locale/ui/<lang>.json` must carry the en key set
 *     and matching `{param}` sets, with extra plural categories allowed for the language's
 *     fallback chain.
 *
 * @module dsh-cleanup/scripts/check-contract
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

/** @param {string} message */
function fail(message) {
  failures.push(message)
}

/** @param {string} file @returns {Promise<string>} */
const read = (file) => readFile(path.join(ROOT, file), 'utf8')

/** @param {string} file @returns {Promise<string>} */
async function readOptional(file) {
  try {
    return await read(file)
  } catch {
    return ''
  }
}

/** @param {string[]} values @returns {string[]} */
const unique = (values) => [...new Set(values)].sort()

/**
 * Extract one JS object literal by its `const <name> = {` opener, with string-aware brace matching.
 * @param {string} source - client.js text.
 * @param {string} name - constant name.
 * @returns {Record<string, string>} evaluated object.
 */
function extractObjectLiteral(source, name) {
  const opener = new RegExp(`(?:^|\\n)\\s*const ${name} = \\{`)
  const match = opener.exec(source)
  if (match === null) throw new Error(`cannot find const ${name} in client.js`)
  const open = source.indexOf('{', match.index + match[0].length - 1)
  let depth = 0
  let inString = false
  let quote = ''
  let end = -1
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]
    const previous = source[index - 1]
    if (inString) {
      if (character === quote && previous !== '\\') inString = false
      continue
    }
    if (character === "'" || character === '"') {
      inString = true
      quote = character
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        end = index + 1
        break
      }
    }
  }
  if (end < 0) throw new Error(`unterminated const ${name}`)
  // The literal contains only string keys/values and `{param}` templates; evaluating it is safe
  // because the input is this repository's own source file.
  // eslint-disable-next-line no-new-func
  return new Function(`return (${source.slice(open, end)})`)()
}

/** @param {string} text @param {string} heading @returns {string} section body up to the next heading */
function section(text, heading) {
  const start = text.indexOf(heading)
  if (start < 0) return ''
  const following = text.slice(start + heading.length)
  const boundary = /\n#{2,3} /u.exec(following)
  return boundary === null ? text.slice(start) : text.slice(start, start + heading.length + boundary.index)
}

/** @param {string} text @param {RegExp} pattern @returns {string[]} */
const matches = (text, pattern) => [...text.matchAll(pattern)].map((match) => match[1])

/** @param {string} template */
function paramsOf(template) {
  return unique(matches(String(template), /\{([a-zA-Z0-9_]+)\}/g))
}

async function main() {
  const [spec, engineSource, indexSource, clientSource, openSource] = await Promise.all([
    read('SPEC.md'),
    read('lib/engine.js'),
    read('index.js'),
    read('client.js'),
    readOptional('lib/open.js'),
  ])

  // ---- 1. routes -------------------------------------------------------------------------------
  const specRoutes = unique(matches(spec, /`[^`\n]*?(\/api\/cleanup\.[a-zA-Z.]+)[^`\n]*`/g))
  const indexRoutes = unique(matches(indexSource, /'(\/api\/cleanup\.[a-zA-Z.]+)'/g))
  const routeTable = unique(matches(indexSource, /\['(\/api\/cleanup\.[a-zA-Z.]+)'/g))
  for (const route of routeTable) {
    if (!indexRoutes.includes(route)) fail(`route ${route} is in the table but not registered by name`)
    if (!route.startsWith('/api/')) fail(`route ${route} is not under /api`)
  }
  for (const route of indexRoutes) {
    if (!routeTable.includes(route)) fail(`route ${route} is referenced but missing from the route table`)
    if (!specRoutes.includes(route)) fail(`route ${route} is implemented but not documented in SPEC`)
  }
  for (const route of specRoutes) {
    if (!indexRoutes.includes(route)) fail(`route ${route} is documented in SPEC but not implemented`)
  }
  notes.push(`routes: ${indexRoutes.length} implemented, ${specRoutes.length} documented`)
  const registeredMethods = new Set(matches(indexSource, /methods: \[([^\]]+)\]/g).flatMap((list) => matches(list, /'([A-Z]+)'/g)))
  if (registeredMethods.size !== 1 || !registeredMethods.has('POST')) fail(`expected every route to be POST, found ${[...registeredMethods].join(',')}`)

  // ---- 2. emitted codes -----------------------------------------------------------------------
  const pathsSource = await read('lib/paths.js')
  // Codes lib/paths.js defines are passed through by §5.3; the engine never spells them literally.
  const pathCodes = unique(matches(pathsSource, /: '([A-Z][A-Z0-9_]{2,})',?$/gm))
  const emitted = {
    error: unique([
      ...matches(engineSource, /\b(?:fail|blocker|DomainError)\(\s*'([A-Z][A-Z0-9_]{2,})'/g),
      ...matches(engineSource, /restorableCode: '([A-Z][A-Z0-9_]{2,})'/g),
      // The platform opener is its own module; its two wire codes are emitted through openerError().
      ...matches(openSource, /\bopenerError\(\s*'([A-Z][A-Z0-9_]{2,})'/g),
      ...pathCodes,
    ]),
    warning: unique([
      ...matches(engineSource, /\bwarning\(\s*'([A-Z][A-Z0-9_]{2,})'/g),
      // Codes carried by object literals (e.g. git findings, settings warnings, run-plan fallbacks).
      ...matches(engineSource, /\bcode: '([A-Z][A-Z0-9_]{2,})'/g),
    ]),
  }
  const specCodes = unique([
    ...matches(section(spec, '### 4.6 Error codes'), /`([A-Z][A-Z0-9_]{2,})`/g),
    ...matches(section(spec, '### 5.4 Warnings'), /`([A-Z][A-Z0-9_]{2,})`/g),
  ])
  // Codes the client/tests raise or handle without the engine emitting them (documented exceptions).
  const restoreVocabulary = new Set(matches(section(spec, '### 4.5 Trash routes'), /`([A-Z][A-Z0-9_]{2,})`/g))
  const settingsCodes = new Set(matches(section(spec, '### 4.8 Settings'), /`([A-Z][A-Z0-9_]{2,})`/g))
  const documentationOnly = new Set([
    'PATH_NOT_DIRECTORY', 'PATH_NOT_SESSION_DIR', // SPEC §4.6: defined by paths.js, never on the wire
    // Client-only plan guard (SPEC §9): the Host never emits it, so it is not part of the §4.6 wire
    // vocabulary; listed here so adding it to §4.6 later does not fail this check.
    'UNCHECKED_TARGET_LEAK',
  ])
  const documentedElsewhere = new Set([...restoreVocabulary, ...settingsCodes, ...documentationOnly])
  // Codes the SPEC explicitly says never reach the wire are not "emitted" for translation purposes.
  emitted.error = emitted.error.filter((code) => !documentationOnly.has(code))
  emitted.warning = emitted.warning.filter((code) => !documentationOnly.has(code))
  const emittedAll = new Set([...emitted.error, ...emitted.warning])
  for (const code of emittedAll) {
    if (!specCodes.includes(code) && !documentedElsewhere.has(code)) {
      fail(`engine can emit ${code} but it is missing from SPEC §4.6/§5.4 (or the §4.5/§4.8 vocabularies)`)
    }
  }
  for (const code of specCodes) {
    if (!emittedAll.has(code) && !documentedElsewhere.has(code)) {
      fail(`SPEC lists ${code} but the engine never emits it and it is not a documented client-only code`)
    }
  }
  notes.push(`codes: ${emitted.error.length} error + ${emitted.warning.length} warning emitted, ${specCodes.length} documented`)

  // ---- 3. client locale -----------------------------------------------------------------------
  const zh = extractObjectLiteral(clientSource, 'zh')
  const en = extractObjectLiteral(clientSource, 'en')
  const zhKeys = unique(Object.keys(zh))
  const enKeys = unique(Object.keys(en))
  for (const key of enKeys) if (!zhKeys.includes(key)) fail(`locale: zh is missing en key "${key}"`)
  for (const key of zhKeys) if (!enKeys.includes(key)) fail(`locale: en is missing zh key "${key}"`)
  for (const key of enKeys) {
    const zhParams = paramsOf(zh[key])
    const enParams = paramsOf(en[key])
    if (zhParams.join(',') !== enParams.join(',')) fail(`locale: param mismatch for "${key}" (zh ${zhParams}, en ${enParams})`)
  }
  const literalKeys = unique([
    ...matches(clientSource, /\bt\('([a-zA-Z0-9_.]+)'(?=\s*[,)])/g),
    ...matches(clientSource, /\bhasKey\('([a-zA-Z0-9_.]+)'(?=\s*[,)])/g),
  ])
  // Dynamic prefixes (`t('error.' + code)`) are intentionally not literal keys.
  for (const key of literalKeys) {
    if (!enKeys.includes(key)) fail(`locale: literal key "${key}" is used but not defined`)
  }
  const pluralBases = unique(enKeys.filter((key) => key.endsWith('_one')).map((key) => key.slice(0, -4)))
  for (const base of pluralBases) {
    if (!enKeys.includes(`${base}_other`)) fail(`locale: plural base "${base}" has no _other variant`)
  }
  // Only settings-response codes rendered from the Host message by design are exempt: every
  // envelope/warning code the engine can put in front of a user MUST have a translation.
  const translationExempt = new Set(['EXISTING_DATA_STAYS'])
  for (const code of emitted.error) {
    if (translationExempt.has(code)) continue
    if (!enKeys.includes(`error.${code}`)) fail(`locale: emitted error code ${code} has no error.${code} translation`)
  }
  for (const code of emitted.warning) {
    if (translationExempt.has(code)) continue
    if (!enKeys.includes(`warn.${code}`) && !enKeys.includes(`error.${code}`)) {
      fail(`locale: emitted code ${code} has neither warn.${code} nor error.${code} translation`)
    }
  }
  notes.push(`client locale: ${enKeys.length} keys, ${pluralBases.length} plural bases, ${literalKeys.length} literal keys`)

  // Published mirrors: `locale/ui/en.json` and `locale/ui/zh.json` are generated from the inline
  // dictionaries above and ship in the package, so a packaged copy must stay identical to the
  // runtime one (key set and every string value; key order is free). The inline `const zh`/`const en`
  // stay the source of truth – never hand-edit a mirror.
  const mirrorNotes = []
  for (const [language, inline] of [['en', en], ['zh', zh]]) {
    const file = `locale/ui/${language}.json`
    const hint = `regenerate it from the inline ${language} dictionary in client.js`
    let mirror
    try {
      mirror = JSON.parse(await read(file))
    } catch (error) {
      fail(`${file}: cannot be read as JSON (${error.message}); ${hint}`)
      continue
    }
    if (mirror === null || typeof mirror !== 'object' || Array.isArray(mirror)) {
      fail(`${file}: expected a JSON object mapping keys to strings; ${hint}`)
      continue
    }
    const inlineKeys = Object.keys(inline)
    const mirrorKeys = Object.keys(mirror)
    const missing = inlineKeys.filter((key) => !Object.hasOwn(mirror, key))
    const extra = mirrorKeys.filter((key) => !Object.hasOwn(inline, key))
    if (missing.length > 0) {
      fail(`${file}: missing ${missing.length} key(s) present in client.js: ${missing.map((key) => `"${key}"`).join(', ')}; ${hint}`)
    }
    if (extra.length > 0) {
      fail(`${file}: has ${extra.length} key(s) absent from client.js: ${extra.map((key) => `"${key}"`).join(', ')}; ${hint}`)
    }
    for (const key of inlineKeys) {
      if (!Object.hasOwn(mirror, key)) continue
      const value = mirror[key]
      if (typeof value !== 'string') {
        fail(`${file}: value for "${key}" must be a string, found ${JSON.stringify(value)}; ${hint}`)
        continue
      }
      if (value === inline[key]) continue
      const mirrorParams = paramsOf(value)
      const inlineParams = paramsOf(inline[key])
      if (mirrorParams.join(',') !== inlineParams.join(',')) {
        fail(`${file}: param mismatch for "${key}" (mirror ${mirrorParams}, client.js ${inlineParams}); ${hint}`)
      } else {
        fail(`${file}: value mismatch for "${key}" (mirror and client.js must be identical); ${hint}`)
      }
    }
    mirrorNotes.push(`${language}.json ${mirrorKeys.length} keys`)
  }
  if (mirrorNotes.length > 0) notes.push(`locale mirrors checked against client.js: ${mirrorNotes.join(', ')}`)

  // Optional per-language dictionaries: same keys as en, except additional plural categories.
  // en/zh are the exact mirrors above; this loop is for any future `locale/ui/<lang>.json`.
  let localeFiles = []
  try {
    localeFiles = (await readdir(path.join(ROOT, 'locale/ui'))).filter((name) => name.endsWith('.json'))
  } catch {
    localeFiles = []
  }
  for (const file of localeFiles) {
    const language = file.replace(/\.json$/u, '')
    if (language === 'en' || language === 'zh') continue
    let dictionary
    try {
      dictionary = JSON.parse(await readFile(path.join(ROOT, 'locale/ui', file), 'utf8'))
    } catch (error) {
      fail(`locale/ui/${file}: not valid JSON (${error.message})`)
      continue
    }
    for (const key of enKeys) {
      if (!(key in dictionary)) fail(`locale/ui/${file}: missing en key "${key}"`)
    }
    for (const key of Object.keys(dictionary)) {
      if (enKeys.includes(key)) continue
      const pluralCategory = /^(.+)_(zero|one|two|few|many|other)$/u.exec(key)
      if (pluralCategory === null || !pluralBases.includes(pluralCategory[1])) {
        fail(`locale/ui/${file}: unexpected key "${key}"`)
      }
    }
    for (const key of enKeys) {
      if (!(key in dictionary)) continue
      if (paramsOf(dictionary[key]).join(',') !== paramsOf(en[key]).join(',')) {
        fail(`locale/ui/${file}: param mismatch for "${key}"`)
      }
    }
    notes.push(`extra locale: ${language}`)
  }

  // ---- 4. manifest hooks ----------------------------------------------------------------------
  const pkg = JSON.parse(await read('package.json'))
  let shippedFiles = 0
  for (const entry of pkg.files ?? []) {
    const expanded = await expandFileEntry(entry)
    if (expanded === null) {
      fail(`package.json files: ${entry} matches no file (a shipped path silently disappeared)`)
      continue
    }
    for (const file of expanded) {
      if (await exists(file)) shippedFiles += 1
      else fail(`package.json files: missing ${file}`)
    }
  }
  notes.push(`package files: ${shippedFiles} shipped path(s) exist`)
  if (pkg.dsh?.bundle?.patch === undefined) fail('package.json: missing dsh.bundle.patch')
  if (pkg.dsh?.client?.platform !== 'web') fail('package.json: dsh.client.platform must be web')

  // ---- 5. plugin-manager locale metadata -----------------------------------------------------
  let metadataFiles = []
  try {
    metadataFiles = (await readdir(path.join(ROOT, 'locale'))).filter((name) => name.endsWith('.json')).sort()
  } catch {
    metadataFiles = []
  }
  if (metadataFiles.length === 0) fail('locale/: no plugin-manager metadata files found')
  for (const name of metadataFiles) {
    const relative = `locale/${name}`
    let parsed
    try {
      parsed = JSON.parse(await read(relative))
    } catch (error) {
      fail(`${relative}: not valid JSON (${error.message})`)
      continue
    }
    const meta = isPlainObject(parsed) && isPlainObject(parsed.meta) ? parsed.meta : null
    if (meta === null) {
      fail(`${relative}: missing "meta" object`)
      continue
    }
    for (const field of ['title', 'description', 'detail']) {
      if (typeof meta[field] !== 'string' || meta[field].trim() === '') fail(`${relative}: meta.${field} must be a non-empty string`)
    }
    if (typeof meta.detail === 'string' && meta.detail.trim() !== '') {
      if ((await readOptional(meta.detail)) === '') fail(`${relative}: meta.detail document "${meta.detail}" is missing`)
    }
  }
  notes.push(`locale metadata: ${metadataFiles.length} language file(s) parsed`)

  // ---- 6. SPEC vocabulary ↔ Host source ------------------------------------------------------
  const openSection = section(spec, '### 4.11')
  for (const kind of ['session', 'workspace', 'trash', 'cache']) {
    if (!new RegExp(`"${kind}"`).test(openSection)) fail(`SPEC §4.11 does not document the open kind "${kind}"`)
    if (!engineSource.includes(`'${kind}'`)) fail(`engine: open route does not handle the documented kind "${kind}"`)
  }
  for (const capability of ['usage', 'projectionCache', 'openPath']) {
    if (!new RegExp('\\b' + capability + '\\s*:').test(engineSource)) fail(`engine: inventory.capabilities.${capability} is missing from the Host source`)
  }

  // ---- report ---------------------------------------------------------------------------------
  for (const note of notes) process.stdout.write(`• ${note}\n`)
  if (failures.length > 0) {
    process.stdout.write(`\n✖ contract check failed (${failures.length}):\n`)
    for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write('\n✓ contract check passed\n')
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Expand one `package.json` `files` entry. A concrete path must exist; a single-segment glob
 * (`lib/*.js`, `locale/ui/*.json`) is expanded against the directory listing and must match at least
 * one file, so a renamed module cannot silently drop out of the published tarball.
 * @param {string} entry - manifest entry, relative to the repository root.
 * @returns {Promise<string[] | null>} matched relative paths, or null when nothing matches.
 */
async function expandFileEntry(entry) {
  if (typeof entry !== 'string' || entry === '') return null
  if (!entry.includes('*')) return (await exists(entry)) ? [entry] : null
  const slash = entry.lastIndexOf('/')
  const directory = slash < 0 ? '.' : entry.slice(0, slash)
  const pattern = slash < 0 ? entry : entry.slice(slash + 1)
  if (!pattern.includes('*') || pattern.includes('**')) return null
  const matcher = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`)
  let names
  try {
    names = await readdir(path.join(ROOT, directory))
  } catch {
    return null
  }
  const matched = names.filter((name) => !name.startsWith('.') && matcher.test(name)).sort()
  if (matched.length === 0) return null
  return matched.map((name) => (directory === '.' ? name : `${directory}/${name}`))
}

/** @param {string} file @returns {Promise<boolean>} */
async function exists(file) {
  try {
    await readFile(path.join(ROOT, file))
    return true
  } catch {
    return false
  }
}

main().catch((error) => {
  process.stderr.write(`contract check crashed: ${error?.stack ?? error}\n`)
  process.exitCode = 1
})
