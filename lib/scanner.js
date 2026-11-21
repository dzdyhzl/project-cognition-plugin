/**
 * Project scanner: enumerate candidate source files, hash them, and compare
 * against the cognition state to produce drift facts (missing/orphan/stale).
 * @module
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, sep, relative } from 'node:path'

/** Directory names always skipped regardless of ignore files. */
export const ALWAYS_SKIP = new Set(['node_modules', '.git', '.cognition', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', '.next', '.cache', 'target', 'vendor'])

/** Text file extensions treated as cognizable; anything else is ignored. */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.m', '.mm',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.hh', '.cs', '.php', '.pl', '.lua',
  '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env.example',
  '.md', '.mdx', '.txt', '.sql', '.css', '.scss', '.less', '.html', '.xml',
  '.proto', '.graphql', '.gql', '.tf', '.dockerfile', '.makefile', '.gradle',
])

/** Max bytes for one cognizable source file (default). */
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024

/** Load gitignore-style patterns from a file; returns line list (may be empty). */
async function loadIgnoreLines(dir, name) {
  try {
    const text = await readFile(join(dir, name), 'utf8')
    return text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('#'))
  } catch {
    return []
  }
}

/**
 * Gitignore mini-matcher: supports trailing `/` (dir-only), leading `/` (anchored),
 * `*` globs, `?`, and negation `!`. `prefix` scopes nested ignore files: patterns
 * from `<dir>/.gitignore` are compiled relative to that directory.
 */
function compileRule(line, prefix = '') {
  let negated = false
  let pattern = line
  if (pattern.startsWith('!')) {
    negated = true
    pattern = pattern.slice(1)
  }
  let dirOnly = false
  if (pattern.endsWith('/')) {
    dirOnly = true
    pattern = pattern.slice(0, -1)
  }
  const anchored = pattern.startsWith('/')
  if (anchored) pattern = pattern.slice(1)
  const escaped = pattern
    .split('*')
    .map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.'))
    .join('.*')
  // Anchored rules match from their own directory; unanchored rules match any depth.
  const head = anchored ? `^${prefix}` : '^(?:.*/)?'
  const regex = new RegExp(head + escaped + (dirOnly ? '($|/)' : '($|/)'))
  return { regex, negated, dirOnly }
}

/** Whether a relative posix path is ignored by compiled rules (last match wins). */
function isIgnored(rules, relPosix) {
  let ignored = false
  for (const rule of rules) {
    const candidate = rule.dirOnly ? `${relPosix}/` : relPosix
    if (rule.regex.test(candidate)) ignored = rule.negated ? false : true
  }
  return ignored
}

/** SHA-256 of file bytes. */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Walk a project directory and return the managed inventory.
 * @param root project root absolute path
 * @param options { maxFileBytes, include, exclude } (globs are simple prefixes/wildcards)
 * @returns { files: Map<posixRelPath, { sha256, bytes }>, skipped: string[] }
 */
export async function scanInventory(root, options = {}) {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const extraSkip = new Set(options.excludeDirs ?? [])
  const extraExtensions = new Set((options.include ?? []).map(ext => String(ext).toLowerCase()))
  const files = new Map()
  const skipped = []
  // Root-level rules first, then nested ones appended as the walk descends.
  const rules = [
    ...[...ALWAYS_SKIP].map(name => compileRule(name)),
    ...[...extraSkip].map(name => compileRule(name)),
    ...(await loadIgnoreLines(root, '.gitignore')).map(line => compileRule(line, '')),
    ...(await loadIgnoreLines(root, '.cognitionignore')).map(line => compileRule(line, '')),
  ]

  async function walk(dir, rel) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relPosix = rel === '' ? entry.name : `${rel}/${entry.name}`
      const abs = join(root, relPosix.replaceAll('/', sep))
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP.has(entry.name) || extraSkip.has(entry.name) || isIgnored(rules, `${relPosix}/`)) continue
        // Nested ignore files scope to their own subtree; unanchored patterns are prefixed.
        const prefix = `${relPosix}/`
        const nested = [
          ...(await loadIgnoreLines(abs, '.gitignore')).map(line => compileRule(line, prefix)),
          ...(await loadIgnoreLines(abs, '.cognitionignore')).map(line => compileRule(line, prefix)),
        ]
        const savedLength = rules.length
        rules.push(...nested)
        await walk(abs, relPosix)
        rules.length = savedLength
        continue
      }
      if (!entry.isFile()) continue
      if (isIgnored(rules, relPosix)) continue
      const dot = entry.name.lastIndexOf('.')
      const ext = dot === -1 ? '' : entry.name.slice(dot).toLowerCase()
      const knownText = TEXT_EXTENSIONS.has(ext)
        || extraExtensions.has(ext)
        || extraExtensions.has(entry.name.toLowerCase())
        || /^(dockerfile|makefile)$/i.test(entry.name)
      if (!knownText) {
        skipped.push(relPosix)
        continue
      }
      let info
      try {
        info = await stat(abs)
      } catch {
        continue
      }
      if (info.size > maxFileBytes) {
        skipped.push(`${relPosix} (over size limit ${maxFileBytes})`)
        continue
      }
      files.set(relPosix.replaceAll(sep, '/'), { bytes: info.size })
    }
  }

  await walk(root, '')
  // Fill hashes lazily in batches via hashFiles.
  return { files, skipped }
}

/** Read each file and fill its sha256 and line count. Mutates the inventory map values. */
export async function hashFiles(root, inventory) {
  for (const [relPosix, value] of inventory) {
    if (value.sha256 !== undefined && value.lines !== undefined) continue
    try {
      const abs = join(root, relPosix.replaceAll('/', sep))
      const text = await readFile(abs, 'utf8')
      value.sha256 = sha256(text)
      value.lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    } catch {
      inventory.delete(relPosix)
    }
  }
}

/**
 * Coverage facts of an index relative to the managed inventory (AOCI's
 * "how much code does the index cover" panel metric, simplified).
 * @param inventory current Map<path, {sha256, lines, bytes}>
 * @param state saved state with entries { path: { sha256 } }
 * @param stateFiles optional file hashes snapshot from state (defaults to state.files)
 * @returns { indexedFiles, totalFiles, indexedLines, totalLines, coverageFiles, coverageLines }
 */
export function coverageStats(inventory, state) {
  const entries = state.entries ?? {}
  const stateFiles = state.files ?? {}
  let indexedFiles = 0
  let indexedLines = 0
  let totalFiles = 0
  let totalLines = 0
  for (const [path, value] of inventory) {
    totalFiles++
    totalLines += value.lines ?? 0
    if (entries[path] !== undefined) {
      indexedFiles++
      indexedLines += value.lines ?? 0
    }
  }
  // Entries whose files have vanished still count as indexed knowledge drift;
  // they are reported separately by compareDrift as missing.
  const missing = Object.keys(stateFiles).filter(path => !inventory.has(path)).length
  return {
    indexedFiles,
    totalFiles,
    indexedLines,
    totalLines,
    coverageFiles: totalFiles === 0 ? 1 : indexedFiles / totalFiles,
    coverageLines: totalLines === 0 ? 1 : indexedLines / totalLines,
    missingEntries: missing,
  }
}

/**
 * Compare an inventory against saved state to produce drift facts.
 * @param inventory current Map<path, {sha256}>
 * @param state saved { files: { path: { sha256 } }, entries: { path: { sha256 } } }
 * @returns { missing: string[], orphan: string[], stale: string[], unchanged: string[] }
 */
export function compareDrift(inventory, state) {
  const stateFiles = state.files ?? {}
  const stateEntries = state.entries ?? {}
  const missing = []
  const stale = []
  const unchanged = []
  for (const [path, value] of Object.entries(stateFiles)) {
    const current = inventory.get(path)
    if (current === undefined) {
      missing.push(path)
      continue
    }
    if (current.sha256 !== value.sha256) stale.push(path)
    else unchanged.push(path)
  }
  const orphan = []
  for (const path of inventory.keys()) {
    if (stateFiles[path] === undefined) orphan.push(path)
  }
  return { missing, orphan, stale, unchanged }
}
