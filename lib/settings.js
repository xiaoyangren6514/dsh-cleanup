/**
 * User-editable settings for dsh-cleanup.
 *
 * The Settings page writes a small plugin-owned override file under the profile home; `apply` merges
 * it over the row `config` at activation, and `settings.set` applies it to the running engine
 * immediately. This deliberately does NOT rewrite the profile's `cordis.patch.yml`: that file belongs
 * to the user, holds other plugins' rows, and editing an ordinary field there restarts the plugin.
 *
 * @module dsh-cleanup/lib/settings
 */
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

/** Override-file schema version. */
export const SETTINGS_VERSION = 1

/**
 * Absolute path of the settings override file for one DSH home.
 * @param {string} dshHomePath - absolute DSH home.
 * @returns {string} file path.
 */
export function settingsFilePath(dshHomePath) {
  return path.join(dshHomePath, 'cleanup', 'settings.json')
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * One validated field: normalizer returns the canonical value or a message.
 * @type {Record<string, { normalize: (value: unknown) => { ok: true, value: any } | { ok: false, message: string } }>}
 */
export const SETTING_FIELDS = {
  trashRoot: {
    normalize(value) {
      if (typeof value !== 'string' || value.trim() === '') return { ok: false, message: 'trashRoot must be a non-empty string.' }
      if (!path.isAbsolute(value)) return { ok: false, message: 'trashRoot must be an absolute path.' }
      return { ok: true, value: path.resolve(value) }
    },
  },
  allowPermanentDeletion: { normalize: booleanField },
  maxScanEntries: { normalize: integerField(1, 5_000_000) },
  scanTimeoutMs: { normalize: integerField(1, 600_000) },
  planTtlMs: { normalize: integerField(1_000, 86_400_000) },
  maxPlans: { normalize: integerField(1, 1_000) },
  auditEnabled: { normalize: booleanField },
  auditMaxBytes: { normalize: integerField(0, 1_073_741_824) },
  trashRetentionDays: { normalize: integerField(0, 3_650) },
  trashMaxBytes: { normalize: integerField(0, 1e15) },
  gitSafetyCheck: { normalize: booleanField },
}

/** @param {unknown} value */
function booleanField(value) {
  if (typeof value !== 'boolean') return { ok: false, message: 'Expected a boolean.' }
  return { ok: true, value }
}

/** @param {number} minimum @param {number} maximum */
function integerField(minimum, maximum) {
  return (value) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, message: 'Expected an integer.' }
    if (value < minimum || value > maximum) return { ok: false, message: `Expected an integer between ${minimum} and ${maximum}.` }
    return { ok: true, value }
  }
}

/**
 * Validate one settings patch (unknown keys are rejected so a typo never silently does nothing).
 * @param {unknown} patch - candidate patch.
 * @returns {{ ok: true, value: Record<string, any> } | { ok: false, field: string, message: string }}
 */
export function validateSettingsPatch(patch) {
  if (!isRecord(patch)) return { ok: false, field: '', message: 'The patch must be an object.' }
  const value = {}
  for (const [field, candidate] of Object.entries(patch)) {
    const definition = SETTING_FIELDS[field]
    if (definition === undefined) return { ok: false, field, message: `"${field}" is not a known setting.` }
    const normalized = definition.normalize(candidate)
    if (!normalized.ok) return { ok: false, field, message: normalized.message }
    value[field] = normalized.value
  }
  return { ok: true, value }
}

/**
 * Read the override file. A missing or corrupt file is "no overrides" — user settings can only fall
 * back to the row config, never invent values.
 * @param {string} filePath - settings file path.
 * @returns {Promise<Record<string, any>>}
 */
export async function readSettingsOverrides(filePath) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (!isRecord(parsed) || parsed.version !== SETTINGS_VERSION || !isRecord(parsed.overrides)) return {}
  const validated = validateSettingsPatch(parsed.overrides)
  return validated.ok ? validated.value : {}
}

/**
 * Synchronous read used at plugin activation, where the effective configuration must exist before the
 * engine is constructed and the Loader expects `apply` to be synchronous. A missing/corrupt file is
 * "no overrides".
 * @param {string} filePath - settings file path.
 * @returns {Record<string, any>}
 */
export function readSettingsOverridesSync(filePath) {
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (!isRecord(parsed) || parsed.version !== SETTINGS_VERSION || !isRecord(parsed.overrides)) return {}
  const validated = validateSettingsPatch(parsed.overrides)
  return validated.ok ? validated.value : {}
}

/**
 * Atomically write the override file (owner-only).
 * @param {string} filePath - settings file path.
 * @param {Record<string, any>} overrides - validated overrides.
 * @returns {Promise<void>}
 */
export async function writeSettingsOverrides(filePath, overrides) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify({ version: SETTINGS_VERSION, overrides }, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, filePath)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch {
      /* best effort */
    }
    throw error
  }
}

/**
 * Project the effective configuration onto the wire settings object (SPEC §4.8).
 * @param {object} config - normalized engine config.
 * @returns {object} settings payload.
 */
export function settingsFromConfig(config) {
  const settings = {}
  for (const field of Object.keys(SETTING_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(config, field)) settings[field] = config[field]
  }
  return settings
}

/**
 * Merge settings overrides onto a base config.
 * @param {Record<string, any>} base - normalized config from the loader row.
 * @param {Record<string, any>} overrides - validated overrides.
 * @returns {Record<string, any>} merged config.
 */
export function mergeSettings(base, overrides) {
  return { ...base, ...overrides }
}
