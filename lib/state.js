/**
 * Cognition state (`state.json`): machine-side record of managed files, their
 * hashes at last authoring, entry hashes, database sources/evidence, and the
 * pending work list. v2 adds the `database` section; v1 files are upgraded on load.
 * @module
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText } from './format.js'

export const STATE_VERSION = 2

/** Absolute paths of the cognition assets under a project root. */
export function cognitionPaths(root) {
  const dir = join(root, '.cognition')
  return {
    dir,
    root: join(dir, 'cognition.txt'),
    meta: join(dir, 'cognition.meta.txt'),
    code: join(dir, 'cognition.code.txt'),
    database: join(dir, 'cognition.database.txt'),
    state: join(dir, 'state.json'),
    gitignore: join(dir, '.gitignore'),
    schemaDir: join(dir, 'schema'),
  }
}

/** Schema evidence file for one source id (sanitized). */
export function evidencePath(root, sourceId) {
  const safe = String(sourceId).replace(/[^\w.-]/g, '_')
  return join(cognitionPaths(root).schemaDir, `${safe}.json`)
}

/** Upgrade a v1 state document in place to v2 shape. */
function upgradeV1(state) {
  state.stateVersion = STATE_VERSION
  state.database = { sources: {}, tables: {}, pending: [] }
  return state
}

/** Load state.json, or null when absent/corrupt. v1 is upgraded to v2. */
export async function loadState(stateFile) {
  try {
    const text = await readFile(stateFile, 'utf8')
    const state = JSON.parse(text)
    if (state?.stateVersion === STATE_VERSION) {
      state.database ??= { sources: {}, tables: {}, pending: [] }
      return state
    }
    if (state?.stateVersion === 1) return upgradeV1(state)
    return null
  } catch {
    return null
  }
}

/** Create an empty state document. */
export function emptyState(project, locale) {
  return {
    stateVersion: STATE_VERSION,
    project,
    locale,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    files: {},
    entries: {},
    pending: [],
    database: { sources: {}, tables: {}, pending: [] },
  }
}

/** Persist state.json atomically. */
export async function saveState(stateFile, state) {
  state.updatedAt = new Date().toISOString()
  await atomicWriteText(stateFile, `${JSON.stringify(state, null, 2)}\n`)
}

/** Union a list of paths into the pending work list. */
export function addPending(state, paths) {
  const pending = new Set(state.pending ?? [])
  let added = 0
  for (const path of paths) {
    if (!pending.has(path)) {
      pending.add(path)
      added++
    }
  }
  state.pending = [...pending]
  return added
}

/** Drop paths from the pending work list. */
export function removePending(state, paths) {
  const drop = new Set(paths)
  const before = state.pending?.length ?? 0
  state.pending = (state.pending ?? []).filter(path => !drop.has(path))
  return before - state.pending.length
}

/** Union table identities (`schema.table` or `table`) into the database pending list. */
export function addDatabasePending(state, tables) {
  const pending = new Set(state.database?.pending ?? [])
  let added = 0
  for (const table of tables) {
    if (!pending.has(table)) {
      pending.add(table)
      added++
    }
  }
  state.database.pending = [...pending]
  return added
}

/** Drop table identities from the database pending list. */
export function removeDatabasePending(state, tables) {
  const drop = new Set(tables)
  const before = state.database?.pending?.length ?? 0
  state.database.pending = (state.database?.pending ?? []).filter(table => !drop.has(table))
  return before - state.database.pending.length
}
