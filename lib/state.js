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

/** Union paths into one pending list; returns [mergedList, addedCount]. */
function unionInto(list, paths) {
  const known = new Set(list)
  let added = 0
  for (const path of paths) {
    if (!known.has(path)) {
      known.add(path)
      added++
    }
  }
  return [[...known], added]
}

/** Drop paths from one pending list; returns [keptList, removedCount]. */
function dropFrom(list, paths) {
  const gone = new Set(paths)
  const kept = list.filter(path => !gone.has(path))
  return [kept, list.length - kept.length]
}

/** Union a list of paths into the pending work list. */
export function addPending(state, paths) {
  const [list, added] = unionInto(state.pending ?? [], paths)
  state.pending = list
  return added
}

/** Drop paths from the pending work list. */
export function removePending(state, paths) {
  const [list, removed] = dropFrom(state.pending ?? [], paths)
  state.pending = list
  return removed
}

/** Union table identities (`schema.table` or `table`) into the database pending list. */
export function addDatabasePending(state, tables) {
  const [list, added] = unionInto(state.database?.pending ?? [], tables)
  state.database.pending = list
  return added
}

/** Drop table identities from the database pending list. */
export function removeDatabasePending(state, tables) {
  const [list, removed] = dropFrom(state.database?.pending ?? [], tables)
  state.database.pending = list
  return removed
}


/** Read a file's exact text so a later write can detect concurrent edits (null when absent). */
export async function readSnapshot(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * Optimistic-concurrency guard for a read-modify-write window: throw when the
 * file's current bytes differ from the snapshot taken before the window opened.
 * Parallel sessions over the same workspace (e.g. the lead plus subagents) then
 * fail loudly with a retry hint instead of silently overwriting each other's
 * state or volume edits.
 */
export async function assertUnchanged(file, expectedRaw, what = file) {
  const current = await readSnapshot(file)
  if (current !== expectedRaw) {
    throw new Error(
      `project-cognition: ${what} changed concurrently since this call started `
      + '(another session is editing the index). Nothing further was written; '
      + 're-run the call to work from the current index.')
  }
}
