/**
 * Project registry: a persistent per-machine pair of lists recording which
 * projects the user trusts with a cognition index (whitelist, "allowed") and
 * which declined one (blacklist, "declined"). Sessions consult the gate: a
 * whitelisted project gets an index created or maintained automatically, a
 * blacklisted one is never asked again, and an unlisted project triggers the
 * one-time overlay question whose answer lands on one of the two lists.
 * The two lists are mutually exclusive: adding to one removes the row from
 * the other.
 *
 * Modeled on the declined-workspace store of the github-workbench plugin
 * (~/.dsh/github-workbench.json): one JSON file under the DSH home directory,
 * canonical Windows-stable path keys, sanitize-on-read, atomic writes, and a
 * serialized read-modify-write window. Difference in scope: this registry is
 * per project directory only (no account dimension), because the cognition
 * plugin serves every session in a workspace identically.
 * @module
 */

import { open, stat, rm, mkdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, parse as parsePath, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** How long a writer waits for the store lock before failing (same spirit as the workbench's 5 s). */
const LOCK_WAIT_MS = 5_000
/** A lock file older than this is considered abandoned and is removed. */
const LOCK_STALE_MS = 15_000

/** The registry file location: ~/.dsh/project-cognition.json, or the path in PROJECT_COGNITION_REGISTRY (test isolation). */
export function registryPath() {
  const override = process.env.PROJECT_COGNITION_REGISTRY
  if (typeof override === 'string' && override.trim().length > 0) {
    return resolve(override.trim())
  }
  const home = safeHomedir()
  if (typeof home !== 'string' || home === '' || !isAbsolute(home)) {
    throw new Error('project-cognition: cannot resolve the user home directory')
  }
  return join(home, '.dsh', 'project-cognition.json')
}

function safeHomedir() {
  try { return homedir() } catch { return undefined }
}

// Resolve the sibling format.js against this file's real directory: the
// profile links the package checkout, and bare relative specifiers can
// mis-resolve through the link (same workaround as index.js / panel.js).
const here = dirname(fileURLToPath(import.meta.url))
const { atomicWriteText } = await import(String(pathToFileURL(join(here, 'format.js'))))

/**
 * Canonical compare key for a project path (stable across drive-letter case
 * and separators on Windows). Mirrors github-workbench's canonicalPath.
 */
export function canonicalPath(raw) {
  const value = resolve(String(raw))
  const parsed = parsePath(value)
  return process.platform === 'win32'
    ? parsed.root.toUpperCase() + value.slice(parsed.root.length).replace(/[\\/]+$/, '')
    : value.replace(/\/+$/, '')
}

/**
 * Whether one registry key covers a target. Mirrors the workbench rule:
 * declining a folder records exactly that path; a parent entry does not
 * silence its child directories.
 */
export function coversKey(key, targetKey) {
  return key === targetKey
}

/** Read the store; a missing file yields an empty store, a malformed one is reported. */
export function readStore() {
  const file = registryPath()
  if (!existsSync(file)) return { declined: {}, allowed: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { declined: {}, allowed: {} }
    const readList = (name) => parsed[name] !== null && typeof parsed[name] === 'object' && !Array.isArray(parsed[name])
      ? parsed[name]
      : {}
    // v1 stores carried only the declined list; allowed defaults to empty.
    return { declined: readList('declined'), allowed: readList('allowed') }
  } catch {
    // A malformed store must not erase user data; report it and refuse edits
    // until the user fixes or deletes the file (workbench semantics).
    return { declined: {}, allowed: {}, malformed: true }
  }
}

/** Whitelist-copy one row; unknown fields are dropped. */
function sanitizeRow(row) {
  return {
    ...(typeof row?.path === 'string' ? { path: row.path } : {}),
    ...(typeof row?.declinedAt === 'string' ? { declinedAt: row.declinedAt } : {}),
    ...(typeof row?.remark === 'string' ? { remark: row.remark } : {}),
  }
}

/** All declined rows, flattened across keys. */
export function listDeclined(store) {
  return Object.values(store.declined)
    .flatMap(rows => Array.isArray(rows) ? rows : [])
    .filter(row => row !== null && typeof row === 'object')
    .map(sanitizeRow)
}

/** Whether the declined list covers a directory (exact canonical path). */
export function isDeclined(store, cwd) {
  const target = canonicalPath(cwd)
  return listDeclined(store).some(row =>
    typeof row.path === 'string' && row.path !== '' && coversKey(canonicalPath(row.path), target))
}

/** Convenience lookup: the declined row covering a directory, or null. */
export function declinedFor(cwd) {
  let store
  try {
    store = readStore()
  } catch {
    return null
  }
  if (store.malformed === true) return null
  const target = canonicalPath(cwd)
  return listDeclined(store).find(row =>
    typeof row.path === 'string' && row.path !== '' && coversKey(canonicalPath(row.path), target)) ?? null
}

/**
 * Serialized read-modify-write on the shared JSON file: an in-process lock
 * plus a lockfile guard, then one atomic write.
 */
export async function mutateStore(change) {
  const file = registryPath()
  const lockFile = `${file}.lock`
  const deadline = Date.now() + LOCK_WAIT_MS
  let handle = null
  for (;;) {
    try {
      handle = await open(lockFile, 'wx')
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let stale = false
      try {
        const info = await stat(lockFile)
        stale = Date.now() - info.mtimeMs > LOCK_STALE_MS
      } catch { /* vanished; retry */ }
      if (stale) {
        await rm(lockFile, { force: true }).catch(() => {})
        continue
      }
      if (Date.now() > deadline) {
        throw new Error('project-cognition: the project registry is busy; retry shortly')
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
  }
  try {
    await handle.write(`${process.pid}`)
    const store = readStore()
    if (store.malformed) {
      throw new Error(`${file} is not valid JSON; fix or delete the file before editing the project registry`)
    }
    const next = change(store)
    await mkdir(dirname(file), { recursive: true })
    await atomicWriteText(file, `${JSON.stringify(next, null, 2)}\n`)
    return { storePath: file, store: next }
  } finally {
    await handle.close()
    await rm(lockFile, { force: true }).catch(() => {})
  }
}

/** Record one declined project (exact canonical path, deduplicated). */
export async function declinedAdd(cwd, remark = '') {
  const raw = String(cwd ?? '').trim()
  if (raw === '' || !isAbsolute(raw)) {
    throw new Error(`project-cognition: the project directory must be absolute: ${raw}`)
  }
  const target = canonicalPath(raw)
  let existed = false
  await mutateStore(store => {
    if (isDeclined(store, raw)) { existed = true; return store }
    store = dropAllowedInner(raw)(store)
    const declined = { ...store.declined, [target]: [{ path: raw, declinedAt: new Date().toISOString(), remark: String(remark ?? '') }] }
    return { ...store, declined }
  })
  return { path: raw, added: !existed }
}

/** Remove one declined record by project path. */
export async function declinedRemove(cwd) {
  const raw = String(cwd ?? '').trim()
  const target = canonicalPath(raw)
  let removed = false
  await mutateStore(store => {
    const declined = {}
    for (const [key, rows] of Object.entries(store.declined)) {
      const source = Array.isArray(rows) ? rows : []
      const kept = source.filter(row =>
        row === null || typeof row !== 'object' || typeof row.path !== 'string'
          ? true
          : !(coversKey(canonicalPath(row.path), target)))
      if (kept.length !== source.length) removed = true
      if (kept.length > 0) declined[key] = kept
    }
    return { ...store, declined }
  })
  return { path: raw, removed }
}

/** All allowed (whitelisted) rows, flattened across keys. */
export function listAllowed(store) {
  return Object.values(store.allowed)
    .flatMap(rows => Array.isArray(rows) ? rows : [])
    .filter(row => row !== null && typeof row === 'object')
    .map(sanitizeRow)
}

/** Whether the allowed list covers a directory (exact canonical path). */
export function isAllowed(store, cwd) {
  const target = canonicalPath(cwd)
  return listAllowed(store).some(row =>
    typeof row.path === 'string' && row.path !== '' && coversKey(canonicalPath(row.path), target))
}

/** Convenience lookup: the allowed row covering a directory, or null. */
export function allowedFor(cwd) {
  let store
  try {
    store = readStore()
  } catch {
    return null
  }
  if (store.malformed === true) return null
  const target = canonicalPath(cwd)
  return listAllowed(store).find(row =>
    typeof row.path === 'string' && row.path !== '' && coversKey(canonicalPath(row.path), target)) ?? null
}

/**
 * Record one whitelisted project (exact canonical path, deduplicated). The
 * two lists are mutually exclusive: any covering declined row is dropped.
 */
export async function allowedAdd(cwd, remark = '') {
  const raw = String(cwd ?? '').trim()
  if (raw === '' || !isAbsolute(raw)) {
    throw new Error(`project-cognition: the project directory must be absolute: ${raw}`)
  }
  let existed = false
  await mutateStore(store => {
    if (isAllowed(store, raw)) { existed = true; return store }
    store = dropDeclinedInner(raw)(store)
    const target = canonicalPath(raw)
    const allowed = { ...store.allowed, [target]: [{ path: raw, allowedAt: new Date().toISOString(), remark: String(remark ?? '') }] }
    return { ...store, allowed }
  })
  return { path: raw, added: !existed }
}

/** Remove one allowed record by project path. */
export async function allowedRemove(cwd) {
  const raw = String(cwd ?? '').trim()
  const target = canonicalPath(raw)
  let removed = false
  await mutateStore(store => {
    const allowed = {}
    for (const [key, rows] of Object.entries(store.allowed)) {
      const source = Array.isArray(rows) ? rows : []
      const kept = source.filter(row =>
        row === null || typeof row !== 'object' || typeof row.path !== 'string'
          ? true
          : !(coversKey(canonicalPath(row.path), target)))
      if (kept.length !== source.length) removed = true
      if (kept.length > 0) allowed[key] = kept
    }
    return { ...store, allowed }
  })
  return { path: raw, removed }
}

/** Inner drop of declined rows covering raw; runs inside an open mutateStore window. */
function dropDeclinedInner(raw) {
  const target = canonicalPath(raw)
  return (store) => {
    const declined = {}
    let removed = false
    for (const [key, rows] of Object.entries(store.declined)) {
      const source = Array.isArray(rows) ? rows : []
      const kept = source.filter(row =>
        row === null || typeof row !== 'object' || typeof row.path !== 'string'
          ? true
          : !(coversKey(canonicalPath(row.path), target)))
      if (kept.length !== source.length) removed = true
      if (kept.length > 0) declined[key] = kept
    }
    return { ...store, declined }
  }
}

/** Inner drop of allowed rows covering raw; runs inside an open mutateStore window. */
function dropAllowedInner(raw) {
  const target = canonicalPath(raw)
  return (store) => {
    const allowed = {}
    let removed = false
    for (const [key, rows] of Object.entries(store.allowed)) {
      const source = Array.isArray(rows) ? rows : []
      const kept = source.filter(row =>
        row === null || typeof row !== 'object' || typeof row.path !== 'string'
          ? true
          : !(coversKey(canonicalPath(row.path), target)))
      if (kept.length !== source.length) removed = true
      if (kept.length > 0) allowed[key] = kept
    }
    return { ...store, allowed }
  }
}
