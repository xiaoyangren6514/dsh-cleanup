#!/usr/bin/env node
/**
 * Regenerate the shipped locale mirrors from the inline dictionaries.
 *
 * `client.js` registers its UI dictionaries inline (`const zh = { … }`, `const en = { … }`), and
 * `locale/ui/<lang>.json` mirrors them for language packs that read package resources. The mirrors
 * are generated files: editing them by hand drifts behind the runtime copy and `npm run check`
 * fails. Run this after changing the inline dictionaries.
 *
 * Usage: `npm run sync-locale` (writes `locale/ui/en.json` and `locale/ui/zh.json`).
 *
 * @module dsh-cleanup/scripts/sync-locale-mirrors
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'client.js')
const MIRRORS = { en: path.join(ROOT, 'locale/ui/en.json'), zh: path.join(ROOT, 'locale/ui/zh.json') }

/**
 * Extract one JS object literal by its `const <name> = {` opener, with string-aware brace matching.
 * The literal contains only string keys/values and `{param}` templates, so evaluating this
 * repository's own source is safe.
 * @param {string} source - client.js text.
 * @param {string} name - constant name.
 * @returns {Record<string, string>} the dictionary in source order.
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
  // eslint-disable-next-line no-new-func
  return new Function(`return (${source.slice(open, end)})`)()
}

const source = await readFile(CLIENT, 'utf8')
let wrote = 0
for (const [language, target] of Object.entries(MIRRORS)) {
  const dictionary = extractObjectLiteral(source, language)
  const keys = Object.keys(dictionary)
  if (keys.length === 0) throw new Error(`const ${language} in client.js has no keys`)
  await writeFile(target, JSON.stringify(dictionary, null, 2) + '\n', 'utf8')
  wrote += 1
  process.stdout.write(`wrote ${path.relative(ROOT, target)} (${keys.length} keys)\n`)
}
process.stdout.write(`locale mirrors synced from client.js (${wrote} files)\n`)
