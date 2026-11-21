/**
 * Project Cognition — a DSH Host plugin that maintains a plain-text, Git-versioned
 * cognition index of a project inside its `.cognition/` directory, so an AI
 * session reads the whole map once instead of re-discovering the codebase.
 *
 * Simplified re-implementation of the core method of https://github.com/aoci-spec/aoci-code
 * (FRAS entries, Root/Meta/Code volumes, drift detection, incremental maintenance,
 * coverage stats, token-aware chunked overview delivery, doctor diagnostics),
 * without the governance state machine or MCP server.
 * @module
 */

import { readFile, mkdir, access } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, basename, resolve, isAbsolute, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { constants } from 'node:fs'

// Resolve lib modules against this file's real directory: the profile links the
// package checkout, and bare relative specifiers can mis-resolve through the link.
const here = dirname(fileURLToPath(import.meta.url))
const format = await import(`file://${here.replaceAll('\\', '/')}/lib/format.js`)
const scanner = await import(`file://${here.replaceAll('\\', '/')}/lib/scanner.js`)
const templates = await import(`file://${here.replaceAll('\\', '/')}/lib/templates.js`)
const state = await import(`file://${here.replaceAll('\\', '/')}/lib/state.js`)
const ddl = await import(`file://${here.replaceAll('\\', '/')}/lib/ddl.js`)
const registry = await import(`file://${here.replaceAll('\\', '/')}/lib/registry.js`)

/** Cordis plugin name. */
export const name = 'project-cognition'

/** Required capability, registry, and prompt services. */
export const inject = ['tools', 'systemPrompt', 'workingDirectory']

/** Plugin configuration, validated manually in apply() (no schemastery dependency). */
const DEFAULT_CONFIG = Object.freeze({
  maxFileBytes: 524288,
  locale: 'zh-CN',
  maxOverviewEntries: 400,
  overviewChunkTokens: 7000,
  refreshThreshold: 30,
  include: [],
  excludeDirs: [],
})

/** Merge user config over defaults with light validation. */
function resolveConfig(config = {}) {
  const merged = { ...DEFAULT_CONFIG }
  if (config.maxFileBytes !== undefined) {
    if (!Number.isFinite(config.maxFileBytes) || config.maxFileBytes < 1024) throw new Error('project-cognition: maxFileBytes must be a number >= 1024')
    merged.maxFileBytes = config.maxFileBytes
  }
  if (config.locale !== undefined) {
    if (!['zh-CN', 'en-US'].includes(config.locale)) throw new Error('project-cognition: locale must be zh-CN or en-US')
    merged.locale = config.locale
  }
  if (config.maxOverviewEntries !== undefined) {
    if (!Number.isInteger(config.maxOverviewEntries) || config.maxOverviewEntries < 1) throw new Error('project-cognition: maxOverviewEntries must be a positive integer')
    merged.maxOverviewEntries = config.maxOverviewEntries
  }
  if (config.overviewChunkTokens !== undefined) {
    if (!Number.isInteger(config.overviewChunkTokens) || config.overviewChunkTokens < 2000 || config.overviewChunkTokens > 30000) throw new Error('project-cognition: overviewChunkTokens must be an integer between 2000 and 30000')
    merged.overviewChunkTokens = config.overviewChunkTokens
  }
  if (config.refreshThreshold !== undefined) {
    if (!Number.isInteger(config.refreshThreshold) || config.refreshThreshold < 1) throw new Error('project-cognition: refreshThreshold must be a positive integer')
    merged.refreshThreshold = config.refreshThreshold
  }
  if (config.include !== undefined) {
    if (!Array.isArray(config.include)) throw new Error('project-cognition: include must be an array of strings')
    merged.include = config.include
  }
  if (config.excludeDirs !== undefined) {
    if (!Array.isArray(config.excludeDirs)) throw new Error('project-cognition: excludeDirs must be an array of strings')
    merged.excludeDirs = config.excludeDirs
  }
  return merged
}

const PROMPT_TEXT = [
  'Project cognition gate: at the start of every conversation (first turn working in a',
  'project, before other work), call cognition_gate once for the current project. It checks',
  'the per-machine whitelist/blacklist registry: a blacklisted project gets no cognition',
  'handling; a whitelisted one gets guided index creation or dynamic maintenance (after',
  'development, cognition_scan then cognition_update_entries / cognition_remove_entries so',
  'the index stays aligned with the code); an unlisted project requires asking the user',
  'through the user-question overlay, then answering the gate with user_response=accept',
  '(create the index and record the whitelist) or decline (record the blacklist). Track',
  'multi-step index work with the task planning tools. Write entry semantics from real',
  'source code; the tools validate structure, tags, and quotas only. Before changing an',
  'indexed object, cognition_search with relations=impact shows what may be affected;',
  'after code and tests are stable, cognition_scan then cognition_update_entries /',
  'cognition_remove_entries bring the index back to aligned.',
].join(' ')

const fmt = format
const estimateTokens = format.estimateTokens
const coverageStats = scanner.coverageStats
const cognitionPaths = state.cognitionPaths
const evidencePath = state.evidencePath
const loadState = state.loadState
const emptyState = state.emptyState
const saveState = state.saveState
const addPending = state.addPending
const removePending = state.removePending
const addDatabasePending = state.addDatabasePending
const removeDatabasePending = state.removeDatabasePending
const volumeTemplates = templates.volumeTemplates
const rootWithDatabaseVolume = templates.rootWithDatabaseVolume
const COGNITION_GITIGNORE = templates.COGNITION_GITIGNORE
const upsertAgentsBlock = templates.upsertAgentsBlock
const hasAgentsBlock = templates.hasAgentsBlock
const agentsBlock = templates.agentsBlock

/** Resolve the project root for a tool call: explicit arg, else the session working directory. */
async function resolveProjectRoot(ctx, agent, requested) {
  const base = await ctx.workingDirectory.ensure(agent)
  const target = requested === undefined || requested.length === 0 ? base : (isAbsolute(requested) ? requested : resolve(base, requested))
  const stat = await statSafe(target)
  if (stat === undefined || !stat.isDirectory()) throw new Error(`project root is not a directory: ${target}`)
  return target
}

async function statSafe(path) {
  try {
    return (await import('node:fs/promises')).stat(path)
  } catch {
    return undefined
  }
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Load the validation context: per-kind tag dictionaries + S quota from the Meta volume. */
async function loadRules(metaFile) {
  let metaText
  try {
    metaText = await readFile(metaFile, 'utf8')
  } catch {
    metaText = ''
  }
  const dictionary = fmt.parseTagDictionary(metaText, 'code')
  if (dictionary.size === 0) {
    const fallback = volumeTemplates('.', 'zh-CN')
    for (const [letter, codes] of fmt.parseTagDictionary(fallback.meta, 'code')) dictionary.set(letter, codes)
  }
  // The database dictionary only comes from an explicit #[Tag dictionary: database]
  // section; without it (older metas) fall back to the template dictionary rather
  // than misreading the code dictionary lines as database codes.
  let databaseDictionary
  if (fmt.hasDictionarySection(metaText, 'database')) {
    databaseDictionary = fmt.parseTagDictionary(metaText, 'database')
  } else {
    databaseDictionary = fmt.parseTagDictionary(volumeTemplates('.', 'zh-CN').meta, 'database')
  }
  return { dictionary, databaseDictionary, quota: fmt.parseSQuota(metaText) }
}

/** Append the database tag dictionary section to a Meta that predates it. */
async function upgradeMetaWithDatabaseDictionary(metaFile) {
  let metaText
  try {
    metaText = await readFile(metaFile, 'utf8')
  } catch {
    return false
  }
  if (fmt.hasDictionarySection(metaText, 'database')) return false
  const appended = volumeTemplates('.', 'zh-CN').meta
  const marker = '#[Tag dictionary: database]'
  const section = appended.slice(appended.indexOf(marker))
  await fmt.atomicWriteText(metaFile, `${metaText.trimEnd()}\n${section}`)
  return true
}

/** Load one database source's schema evidence, or null. */
async function loadEvidence(root, sourceId) {
  try {
    const text = await readFile(evidencePath(root, sourceId), 'utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Table lookup against schema evidence: accepts `table` or `schema.table`. */
function evidenceTableLookup(evidence) {
  const byName = new Map()
  for (const table of evidence?.tables ?? []) {
    byName.set(table.name, table)
    if (table.schema !== undefined) byName.set(`${table.schema}.${table.name}`, table)
  }
  return (ref) => byName.has(String(ref).replace(/^database:/, ''))
}

/** Load the first declared database source's evidence. */
async function loadPrimaryEvidence(root, state) {
  const sources = state.database?.sources ?? {}
  const sourceId = Object.keys(sources)[0]
  if (sourceId === undefined) return null
  return loadEvidence(root, sourceId)
}

/** Coerce a model-supplied argument that may arrive as a JSON string. */
function coerceValue(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        return JSON.parse(trimmed)
      } catch {
        return value
      }
    }
  }
  return value
}

/** Register one cognition tool with common plumbing. */
function tool(ctx, definition) {
  ctx.tools.register(definition)
}

/** Render the doctor report text from collected items. */
function renderDoctor(root, items) {
  const lines = [`# cognition_doctor — ${root}`]
  const fails = items.filter(item => item.level === 'FAIL').length
  const warns = items.filter(item => item.level === 'WARN').length
  lines.push(`verdict: ${fails > 0 ? 'NEEDS_ATTENTION' : warns > 0 ? 'USABLE_WITH_WARNINGS' : 'HEALTHY'} (${items.length} checks, ${fails} fail, ${warns} warn)`)
  for (const item of items) lines.push(`[${item.level}] ${item.check}: ${item.detail}`)
  return { text: lines.join('\n') }
}

/**
 * Plugin entry: register the six cognition tools and the prompt section.
 * @param ctx Cordis context
 * @param config validated Config
 */
export function apply(ctx, userConfig = {}) {
  const config = resolveConfig(userConfig)
  const maxFileBytes = config.maxFileBytes
  const localeDefault = config.locale
  const maxOverviewEntries = config.maxOverviewEntries
  const chunkTokenBudget = config.overviewChunkTokens
  const refreshThreshold = config.refreshThreshold
  const extraExtensions = config.include
  const extraExcludeDirs = new Set(config.excludeDirs ?? [])

  const renderText = (value) => [{ type: 'text', text: value.text ?? JSON.stringify(value) }]

  ctx.systemPrompt.section({
    name: 'tool:project-cognition',
    order: 1750,
    text: PROMPT_TEXT,
  })

  // ---------------------------------------------------------------- overview
  tool(ctx, {
    name: 'cognition_overview',
    description: 'Load the project cognition index: read the Root, Meta, and Code volumes and return the whole map. Call this once when you first work on a project, and whenever the index drifted after your edits. When no index exists, returns the guided workflow to build one. Large indexes are delivered in chunks: follow next_chunk until all chunks are delivered.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project root directory. Defaults to the session working directory.' },
        verify_drift: { type: 'boolean', description: 'Also re-scan the code tree to report drift (slower). Default false: only report pending items recorded in state.json.' },
        chunk: { type: 'integer', description: '1-based chunk index for chunked delivery of the Code volume. Omit for full delivery; if the index is over budget the result says to use chunk=1.' },
        chunk_entries: { type: 'integer', description: 'Entries per chunk when chunk is set. Default 100, minimum 2.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(value),
    },
    async execute(rawArgs, exec) {
      const args = {
        ...rawArgs,
        verify_drift: coerceValue(rawArgs.verify_drift) === true,
        chunk: rawArgs.chunk === undefined ? undefined : Number(coerceValue(rawArgs.chunk)),
        chunk_entries: rawArgs.chunk_entries === undefined ? undefined : Number(coerceValue(rawArgs.chunk_entries)),
      }
      const root = await resolveProjectRoot(ctx, exec.agent, args.project)
      const paths = cognitionPaths(root)
      if (!(await fileExists(paths.root))) {
        // Route through the registry gate: it owns the whitelist/blacklist
        // decision and the one-time user question, so this branch stays thin.
        return {
          text: [
            `No cognition index exists for ${root}, and this session has not answered the registry gate yet.`,
            'Call cognition_gate first: it reports blacklisted (do nothing), whitelisted (create the index now),',
            'or unlisted (ask the user through the user-question overlay, then answer the gate with user_response).',
          ].join('\n'),
        }
      }

      const rootText = await readFile(paths.root, 'utf8')
      const metaText = await readFile(paths.meta, 'utf8')
      let codeText = ''
      try {
        codeText = await readFile(paths.code, 'utf8')
      } catch {}
      const state = await loadState(paths.state)
      const parsed = fmt.parseCodeVolume(codeText)
      const entryCount = parsed.sections.reduce((sum, section) => sum + section.entries.length, 0)
      const header = fmt.parseRootManifest(rootText)
      const chunked = Number.isInteger(args.chunk) && args.chunk >= 1
      const chunkEntries = Math.max(2, Math.min(500, args.chunk_entries ?? 100))
      const lines = []
      lines.push(`# Project: ${header['Project'] ?? basename(root)} (index format ${header['Format-Version'] ?? '?'}, locale ${header['Locale'] ?? '?'})`)
      lines.push(`# Entries: ${entryCount} files across ${parsed.sections.filter(section => section.entries.length > 0).length} directories`)
      const indexTokens = fmt.estimateTokens(codeText) + fmt.estimateTokens(metaText) + fmt.estimateTokens(rootText)
      lines.push(`# Index size: ~${indexTokens} tokens`)
      if (parsed.parseErrors.length > 0) lines.push(`# Volume parse warnings: ${parsed.parseErrors.length} unrecognized lines (preserved verbatim)`)
      lines.push('')
      if (chunked) {
        // Chunked delivery: Root+Meta only in chunk 1, then a stable entry slice per chunk.
        const flat = []
        for (const section of parsed.sections) {
          for (const entry of section.entries) {
            const fullPath = `${section.dir === '.' ? '' : `${section.dir}/`}${entry.basename}`
            flat.push(fmt.serializeEntry({ path: fullPath, tags: entry.tags, f: entry.f, r: entry.r, a: entry.a, s: entry.s }))
          }
        }
        // Chunk boundaries: fixed entry count when chunk_entries is given,
        // otherwise sized by the estimated token budget (AOCI's chunk_tokens
        // model): dense entries pack fewer lines per chunk, small ones more.
        const entryTokens = flat.map(line => estimateTokens(line) + 1)
        let boundaries
        if (args.chunk_entries !== undefined) {
          boundaries = []
          for (let start = 0; start < flat.length; start += chunkEntries) boundaries.push([start, Math.min(start + chunkEntries, flat.length)])
        } else {
          const fixedOverhead = estimateTokens(rootText) + estimateTokens(metaText) + 40
          boundaries = []
          let start = 0
          while (start < flat.length) {
            let budget = chunkTokenBudget - (start === 0 ? fixedOverhead : 10)
            let end = start
            let used = 0
            while (end < flat.length && (end === start || used + entryTokens[end] <= budget)) {
              used += entryTokens[end]
              end++
            }
            boundaries.push([start, end])
            start = end
          }
        }
        const totalChunks = Math.max(1, boundaries.length)
        const chunkIndex = Math.min(args.chunk, totalChunks)
        const [from, to] = boundaries[chunkIndex - 1] ?? [0, 0]
        if (chunkIndex === 1) {
          lines.push('## Root manifest')
          lines.push(rootText.trimEnd())
          lines.push('')
          lines.push('## Meta rules (governs every entry)')
          lines.push(metaText.trimEnd())
          lines.push('')
        }
        lines.push(`## Code volume (chunk ${chunkIndex}/${totalChunks}, entries ${from + 1}-${to} of ${flat.length})`)
        lines.push(flat.slice(from, to).join('\n'))
        lines.push('')
        if (chunkIndex < totalChunks) {
          lines.push(`NEXT_CHUNK: ${chunkIndex + 1} — call cognition_overview again with chunk=${chunkIndex + 1} (of ${totalChunks}) before doing task work.`)
        } else {
          lines.push(`ALL_CHUNKS_DELIVERED: the whole index (${flat.length} entries) has been delivered. You may start task work.`)
        }
      } else if (entryCount > maxOverviewEntries || indexTokens > chunkTokenBudget) {
        lines.push(`The code volume holds ${entryCount} entries (~${indexTokens} tokens; over the ${entryCount > maxOverviewEntries ? `entry budget ${maxOverviewEntries}` : `token budget ${chunkTokenBudget}`}).`)
        lines.push('Call cognition_overview again with chunk=1 (optionally chunk_entries) to receive the whole index in chunks, or use cognition_search to narrow by tag or keyword.')
      } else {
        lines.push('## Root manifest')
        lines.push(rootText.trimEnd())
        lines.push('')
        lines.push('## Meta rules (governs every entry)')
        lines.push(metaText.trimEnd())
        lines.push('')
        lines.push('## Code volume')
        lines.push(codeText.trimEnd())
      }
      // Database volume, when the project declared one, follows the code volume.
      if (await fileExists(paths.database)) {
        const dbText = await readFile(paths.database, 'utf8')
        const dbParsed = fmt.parseCodeVolume(dbText)
        const dbCount = dbParsed.sections.reduce((sum, section) => sum + section.entries.length, 0)
        lines.push('')
        lines.push(`## Database volume (${dbCount} table entries)`)
        if (dbCount <= maxOverviewEntries) {
          lines.push(dbText.trimEnd())
        } else {
          lines.push(`The database volume holds ${dbCount} entries (over the budget ${maxOverviewEntries}).`)
          lines.push('Use cognition_search with volume="database" to query it, and cognition_database_scan for table drift.')
        }
      }
      // Coverage facts (AOCI panel metric, simplified): how much managed code the index describes.
      if (state !== null) {
        try {
          const walked = await scanner.scanInventory(root, { maxFileBytes, excludeDirs: [...extraExcludeDirs], include: extraExtensions })
          await scanner.hashFiles(root, walked.files)
          const coverage = scanner.coverageStats(walked.files, state)
          lines.push('')
          lines.push(`## Coverage: ${coverage.indexedFiles}/${coverage.totalFiles} files (${Math.round(coverage.coverageFiles * 100)}%), ${coverage.indexedLines}/${coverage.totalLines} lines (${Math.round(coverage.coverageLines * 100)}%)`)
          if (coverage.missingEntries > 0) lines.push(`Coverage excludes ${coverage.missingEntries} indexed files that no longer exist on disk (run cognition_scan for drift facts).`)
        } catch { /* coverage is best-effort */ }
      }
      const pending = state?.pending ?? []
      if (pending.length > 0) {
        lines.push('')
        lines.push(`## Pending authoring (${pending.length} files awaiting entries or updates)`)
        lines.push(pending.slice(0, 100).join('\n'))
        if (pending.length > 100) lines.push(`... and ${pending.length - 100} more; call cognition_scan for the full drift report`)
        if (pending.length >= refreshThreshold) lines.push(`REFRESH SUGGESTED: ${pending.length} pending paths exceed the refresh threshold (${refreshThreshold}) — run cognition_scan to reconcile with the current tree before relying on this picture (AOCI-style refresh threshold).`)
      }
      const dbPending = state?.database?.pending ?? []
      if (dbPending.length > 0) {
        lines.push('')
        lines.push(`## Pending database authoring (${dbPending.length} tables awaiting entries or updates)`)
        lines.push(dbPending.slice(0, 100).join('\n'))
      }
      if (args.verify_drift && state !== null) {
        const walked = await scanner.scanInventory(root, { maxFileBytes, excludeDirs: [...extraExcludeDirs], include: extraExtensions })
        await scanner.hashFiles(root, walked.files)
        const drift = scanner.compareDrift(walked.files, state)
        lines.push('')
        lines.push(`## Drift (verify_drift): missing=${drift.missing.length} orphan=${drift.orphan.length} stale=${drift.stale.length}`)
        if (drift.stale.length > 0) lines.push(`stale (code changed after authoring): ${drift.stale.slice(0, 50).join(', ')}`)
        if (drift.missing.length > 0) lines.push(`missing (deleted files still indexed): ${drift.missing.slice(0, 50).join(', ')}`)
        if (drift.orphan.length > 0) lines.push(`orphan (new files not yet indexed): ${drift.orphan.slice(0, 50).join(', ')}`)
      }
      return { text: lines.join('\n') }
    },
    presentCall: (args) => ({ card: 'generic', title: `Read cognition index${args?.project ? `: ${args.project}` : ''}`, kind: 'read' }),
  })

  // -------------------------------------------------------------------- init
  tool(ctx, {
    name: 'cognition_init',
    description: 'Create the cognition volume skeleton (.cognition/cognition.txt, cognition.meta.txt, cognition.code.txt, state.json) in a project. Contains rules and a tag dictionary only — never business semantics. Idempotent: an existing index is reported, not overwritten.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project root directory. Defaults to the session working directory.' },
        locale: { type: 'string', enum: ['zh-CN', 'en-US'], description: `Volume language. Default ${localeDefault}.` },
        agents_md: { type: 'boolean', description: 'Also write a managed project-cognition rules block into AGENTS.md at the project root, so other agent hosts (Codex, Claude Code, ...) follow the same workflow. Content outside the block is never touched. Default false.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const root = await resolveProjectRoot(ctx, exec.agent, args.project)
      const paths = cognitionPaths(root)
      if (await fileExists(paths.root)) {
        return { text: `Cognition index already exists at ${paths.dir}. Nothing was overwritten. Call cognition_overview to read it.` }
      }
      const locale = args.locale ?? localeDefault
      const templates = volumeTemplates(basename(root), locale)
      await mkdir(paths.dir, { recursive: true })
      await fmt.atomicWriteText(paths.root, templates.root)
      await fmt.atomicWriteText(paths.meta, templates.meta)
      await fmt.atomicWriteText(paths.code, templates.code)
      await fmt.atomicWriteText(paths.gitignore, COGNITION_GITIGNORE)
      const state = emptyState(basename(root), locale)
      await saveState(paths.state, state)
      // Optional AGENTS.md managed block for cross-host portability.
      let agentsNote = ''
      if (args.agents_md === true) {
        const agentsFile = join(root, 'AGENTS.md')
        const existing = await fileExists(agentsFile) ? await readFile(agentsFile, 'utf8') : null
        if (!hasAgentsBlock(existing)) {
          await fmt.atomicWriteText(agentsFile, upsertAgentsBlock(existing, locale))
          agentsNote = existing === null
            ? 'AGENTS.md created with the managed rules block.'
            : 'AGENTS.md updated: the managed rules block was appended (your existing content is untouched).'
        } else {
          agentsNote = 'AGENTS.md already carries the managed rules block; left as-is.'
        }
      }
      // An initialized index supersedes any earlier declined record.
      let lifted = false
      try {
        const removed = await registry.declinedRemove(root)
        lifted = removed.removed
      } catch { /* registry problems never block init */ }
      return {
        text: [
          `Initialized cognition index at ${paths.dir}.`,
          ...(agentsNote ? [agentsNote] : []),
          ...(lifted ? ['The declined-list record for this project was lifted.'] : []),
          'Next: call cognition_scan to list managed files, then author FRAS entries batch by batch with cognition_update_entries.',
          'Commit .cognition/ to Git (state.json is ignored by the generated .cognition/.gitignore).',
        ].join('\n'),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `Init cognition index${args?.project ? `: ${args.project}` : ''}`, kind: 'execute' }),
  })

  // -------------------------------------------------------------------- scan
  tool(ctx, {
    name: 'cognition_scan',
    description: 'Scan the project source tree (gitignore-aware, extension-filtered) and compare with the cognition state. Returns missing/orphan/stale drift facts and a pending authoring list in batches. Never writes the index.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project root directory. Defaults to the session working directory.' },
        batch_size: { type: 'number', description: 'Files per authoring batch in the returned plan. Default 25.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const root = await resolveProjectRoot(ctx, exec.agent, args.project)
      const paths = cognitionPaths(root)
      const state = await loadState(paths.state)
      if (state === null) {
        return { text: `No cognition state found under ${paths.dir}. Call cognition_init first.` }
      }
      const batchSize = Math.max(1, Math.min(200, args.batch_size ?? 25))
      const walked = await scanner.scanInventory(root, { maxFileBytes, excludeDirs: [...extraExcludeDirs], include: extraExtensions })
      await scanner.hashFiles(root, walked.files)
      const inventory = walked.files
      const drift = scanner.compareDrift(inventory, state)
      const work = [...new Set([...drift.orphan, ...drift.stale])]
      state.files = {}
      for (const [path, value] of inventory) state.files[path] = { sha256: value.sha256 }
      // Rebuild the pending list from the current drift facts: stale entries from
      // earlier crashes or malformed writes (e.g. "(empty)") are dropped here.
      state.pending = work
      await saveState(paths.state, state)
      const lines = []
      const coverage = scanner.coverageStats(inventory, state)
      lines.push(`# Scan of ${basename(root)}`)
      lines.push(`managed files: ${inventory.size} | skipped (non-text/over-size): ${walked.skipped.length}`)
      lines.push(`coverage: ${coverage.indexedFiles}/${coverage.totalFiles} files (${Math.round(coverage.coverageFiles * 100)}%), ${coverage.indexedLines}/${coverage.totalLines} lines (${Math.round(coverage.coverageLines * 100)}%)`)
      lines.push(`drift: missing=${drift.missing.length} orphan=${drift.orphan.length} stale=${drift.stale.length} unchanged=${drift.unchanged.length}`)
      if (drift.missing.length > 0) {
        lines.push('')
        lines.push(`## Missing — delete their entries with cognition_remove_entries:`)
        lines.push(drift.missing.join('\n'))
      }
      if (work.length > 0) {
        lines.push('')
        lines.push(`## Pending authoring plan (${work.length} files, batches of ${batchSize})`)
        for (let index = 0; index < Math.min(work.length, batchSize * 4); index += batchSize) {
          lines.push(`- batch ${index / batchSize + 1}: ${work.slice(index, index + batchSize).join(', ')}`)
        }
        if (work.length > batchSize * 4) lines.push(`... ${work.length - batchSize * 4} more; call cognition_scan again after updating these`)
        lines.push('')
        lines.push('Read each file, then call cognition_update_entries with { entries: [{ path, tags, f, r, a, s }] }.')
      } else {
        lines.push('')
        lines.push('All managed files are aligned. No authoring work pending.')
      }
      return { text: lines.join('\n') }
    },
    presentCall: (args) => ({ card: 'generic', title: `Scan cognition drift${args?.project ? `: ${args.project}` : ''}`, kind: 'read' }),
  })

  // ------------------------------------------------------------------ update
  tool(ctx, {
    name: 'cognition_update_entries',
    description: 'Author or update FRAS entries in the Code volume (default) or Database volume (volume="database", path=schema.table from the accepted schema evidence). Validates structure (FRAS fields present, tags in the kind\'s Meta dictionary, S within quota, paths/table references resolvable), then writes atomically. Code entries require existing project files; database entries require tables present in the schema evidence.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project root directory. Defaults to the session working directory.' },
        volume: { type: 'string', enum: ['code', 'database'], description: 'Which volume to write. Default code.' },
        entries: {
          type: 'array',
          description: 'One object per object: { path, tags, f, r, a, s }. path is a relative file path (code) or schema.table (database), forward slashes.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              tags: { type: 'string' },
              f: { type: 'string' },
              r: { type: 'string' },
              a: { type: 'string' },
              s: { type: 'string' },
            },
          },
        },
      },
      required: ['entries'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(value),
    },
    async execute(rawArgs, exec) {
      const args = { ...rawArgs, entries: coerceValue(rawArgs.entries), volume: rawArgs.volume === 'database' ? 'database' : 'code' }
      if (!Array.isArray(args.entries)) {
        return { text: 'cognition_update_entries: `entries` must be an array of { path, tags, f, r, a, s } objects. Pass them as a JSON array, not a string.' }
      }
      const root = await resolveProjectRoot(ctx, exec.agent, args.project)
      const paths = cognitionPaths(root)
      const state = await loadState(paths.state)
      if (state === null) {
        return { text: `No cognition state found under ${paths.dir}. Call cognition_init first.` }
      }
      const isDatabase = args.volume === 'database'
      const rules = await loadRules(paths.meta)
      const volumeFile = isDatabase ? paths.database : paths.code
      if (!(await fileExists(volumeFile))) {
        return { text: isDatabase
          ? `No Database volume at ${paths.database}. Call cognition_database_init first to declare a source and import a schema dump.`
          : `Code volume missing at ${paths.code}. Call cognition_init first.` }
      }
      // Code entries may carry cross-volume database: R references; load the
      // evidence for them too (null when no source is declared, which disables
      // the check rather than failing unrelated entries).
      const evidence = isDatabase || Object.keys(state.database?.sources ?? {}).length > 0
        ? await loadPrimaryEvidence(root, state)
        : null
      if (isDatabase && evidence === null) {
        return { text: 'No schema evidence found. Call cognition_database_init with a .sql DDL dump before authoring database entries.' }
      }
      const volumeText = await readFile(volumeFile, 'utf8')
      const parsed = fmt.parseCodeVolume(volumeText)
      // Resolve code: R references against the real file tree, tolerant of the
      // exact prefix the author chose (lib/x.js == ./lib/x.js).
      let projectFiles = null
      const codeRefExists = async (ref) => {
        if (projectFiles === null) {
          try {
            const walked = await scanner.scanInventory(root, { maxFileBytes, excludeDirs: [...extraExcludeDirs], include: extraExtensions })
            projectFiles = walked.files
          } catch {
            projectFiles = new Map()
          }
        }
        if (projectFiles.has(ref)) return true
        const bare = ref.replace(/^\.?\//, '')
        if (projectFiles.has(bare)) return true
        for (const path of projectFiles.keys()) {
          if (path.endsWith(`/${bare}`)) return true
        }
        return false
      }
      const entryExists = new Map()
      const accepted = []
      const rejected = []
      for (const entry of args.entries ?? []) {
        const posixPath = String(entry.path ?? '').replaceAll('\\', '/')
        if (posixPath.length === 0) {
          rejected.push({ path: '(empty)', errors: ['path is required'] })
          continue
        }
        if (isDatabase) {
          const errors = fmt.validateEntry({ path: posixPath, tags: entry.tags, f: entry.f, r: entry.r, a: entry.a, s: entry.s }, {
            dictionary: rules.databaseDictionary,
            quota: rules.quota,
            tableExists: evidenceTableLookup(evidence),
          })
          if (errors.length > 0) {
            rejected.push({ path: posixPath, errors })
            continue
          }
          accepted.push({ path: posixPath, tags: entry.tags, f: entry.f, r: entry.r, a: entry.a, s: entry.s })
          continue
        }
        if (!entryExists.has(posixPath)) {
          const abs = join(root, ...posixPath.split('/'))
          entryExists.set(posixPath, await fileExists(abs))
        }
        const selfPath = posixPath
        const errors = fmt.validateEntry({ path: posixPath, tags: entry.tags, f: entry.f, r: entry.r, a: entry.a, s: entry.s }, {
          dictionary: rules.dictionary,
          quota: rules.quota,
          // The entry's own path must exist; code: R references are resolved
          // per-reference against the real project tree.
          fileExists: (candidate) => candidate === selfPath ? entryExists.get(selfPath) : true,
          // database: R references validate against accepted schema evidence.
          tableExists: evidence !== null ? evidenceTableLookup(evidence) : undefined,
        })
        if (errors.length > 0) {
          rejected.push({ path: posixPath, errors })
          continue
        }
        // Validate each code: reference individually (async, sequential).
        if (entry.r && entry.r !== '-') {
          const refErrors = []
          for (const ref of entry.r.split(',').map(item => item.trim()).filter(item => item.startsWith('code:'))) {
            const target = ref.slice(5)
            if (!(await codeRefExists(target))) refErrors.push(`R reference target does not exist: ${ref}`)
          }
          if (refErrors.length > 0) {
            rejected.push({ path: posixPath, errors: refErrors })
            continue
          }
        }
        accepted.push({ path: posixPath, tags: entry.tags, f: entry.f, r: entry.r, a: entry.a, s: entry.s })
      }
      fmt.upsertEntries(parsed.sections, new Map(accepted.map(entry => [entry.path, entry])))
      await fmt.atomicWriteText(volumeFile, isDatabase ? fmt.serializeDatabaseVolume(parsed.sections) : fmt.serializeCodeVolume(parsed.sections))
      // Record entry hashes and clear pending for accepted paths.
      const acceptedPaths = new Set(accepted.map(entry => entry.path))
      if (isDatabase) {
        for (const entry of accepted) {
          state.database.tables[entry.path] = { sha256: fmt.entryHash(entry) }
        }
        removeDatabasePending(state, [...acceptedPaths, '(empty)'])
        addDatabasePending(state, rejected.filter(entry => entry.path !== '(empty)').map(entry => entry.path))
      } else {
        for (const entry of accepted) {
          const abs = join(root, ...entry.path.split('/'))
          state.entries[entry.path] = { sha256: fmt.entryHash(entry) }
          try {
            const text = await readFile(abs, 'utf8')
            const fileHash = scanner.sha256(text)
            if (state.files[entry.path] === undefined) state.files[entry.path] = { sha256: fileHash }
            else state.files[entry.path].sha256 = fileHash
          } catch {}
        }
        removePending(state, [...acceptedPaths, '(empty)'])
        addPending(state, rejected
          .filter(entry => entry.path !== '(empty)' && entry.errors.every(error => !error.includes('does not exist')))
          .map(entry => entry.path))
      }
      await saveState(paths.state, state)
      const lines = [`# cognition_update_entries (volume=${args.volume})`]
      lines.push(`accepted: ${accepted.length} | rejected: ${rejected.length}`)
      for (const entry of rejected.slice(0, 20)) lines.push(`REJECTED ${entry.path}: ${entry.errors.join('; ')}`)
      if (rejected.length > 20) lines.push(`... and ${rejected.length - 20} more rejections`)
      if (accepted.length > 0) lines.push(`${isDatabase ? 'Database' : 'Code'} volume updated atomically at ${volumeFile}.`)
      return { text: lines.join('\n') }
    },
    presentCall: (args) => ({ card: 'generic', title: `Update ${args?.entries?.length ?? '?'} cognition entries${args?.volume === 'database' ? ' (database)' : ''}`, kind: 'execute' }),
  })

  // ------------------------------------------------------------------ remove
  tool(ctx, {
    name: 'cognition_remove_entries',
    description: 'Remove FRAS entries whose source files were deleted, moved out of scope, or dropped from the schema evidence. Accepts relative paths (code volume) or schema.table identities (database volume); also clears their state records.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project root directory. Defaults to the session working directory.' },
        volume: { type: 'string', enum: ['code', 'database'], description: 'Which volume to remove from. Default code.' },
        paths: { type: 'array', description: 'Relative paths (code volume) or schema.table identities (database volume).', items: { type: 'string' } },
      },
      required: ['paths'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(value),
    },
    async execute(rawArgs, exec) {
      const args = { ...rawArgs, paths: coerceValue(rawArgs.paths), volume: rawArgs.volume === 'database' ? 'database' : 'code' }
      if (!Array.isArray(args.paths)) {
        return { text: 'cognition_remove_entries: `paths` must be an array of relative path strings. Pass them as a JSON array, not a string.' }
      }
      const root = await resolveProjectRoot(ctx, exec.agent, args.project)
      const paths = cognitionPaths(root)
      const state = await loadState(paths.state)
      if (state === null) return { text: `No cognition state found under ${paths.dir}. Call cognition_init first.` }
      const isDatabase = args.volume === 'database'
      const volumeFile = isDatabase ? paths.database : paths.code
      if (!(await fileExists(volumeFile))) {
        return { text: isDatabase ? `No Database volume at ${paths.database}.` : `No Code volume at ${paths.code}.` }
      }
      const volumeText = await readFile(volumeFile, 'utf8')
      const parsed = fmt.parseCodeVolume(volumeText)
      const wanted = (args.paths ?? []).map(path => String(path).replaceAll('\\', '/')).filter(Boolean)
      const removed = fmt.removeEntries(parsed.sections, wanted)
      await fmt.atomicWriteText(volumeFile, isDatabase ? fmt.serializeDatabaseVolume(parsed.sections) : fmt.serializeCodeVolume(parsed.sections))
      if (isDatabase) {
        for (const path of removed) delete state.database.tables[path]
        removeDatabasePending(state, wanted)
      } else {
        for (const path of removed) delete state.entries[path]
        removePending(state, wanted)
        for (const path of wanted) {
          if (state.files[path] !== undefined) delete state.files[path]
        }
      }
      await saveState(paths.state, state)
      return {
        text: [
          `# cognition_remove_entries (volume=${args.volume})`,
          `requested: ${wanted.length} | removed: ${removed.length}`,
          ...wanted.filter(path => !removed.includes(path)).map(path => `NOT FOUND in ${isDatabase ? 'Database' : 'Code'} volume: ${path}`),
        ].join('\n'),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `Remove ${args?.paths?.length ?? '?'} cognition entries${args?.volume === 'database' ? ' (database)' : ''}`, kind: 'delete' }),
  })

  // ------------------------------------------------------------------ search
  tool(ctx, {
    name: 'cognition_search',
    description: 'Search the Code or Database volume by tag codes (e.g. "P" persistence, "9" importance), path/table substring, free keyword in F/R/A/S text, or relation projection: relations=forward lists what a path/table depends on; relations=reverse lists every entry whose R references it. Useful for large indexes where the overview was chunked.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project root directory. Defaults to the session working directory.' },
        volume: { type: 'string', enum: ['code', 'database'], description: 'Which volume to search. Default code.' },
        tags: { type: 'string', description: 'Comma-separated tag codes that must all appear in the entry tags (e.g. "P,9").' },
        path: { type: 'string', description: 'Substring the entry path/table must contain. For relations, the exact or suffix identity (e.g. "lib/greet.js" or "public.orders").' },
        keyword: { type: 'string', description: 'Free keyword matched case-insensitively in F/R/A/S text.' },
        relations: { type: 'string', enum: ['forward', 'reverse', 'impact'], description: 'Relation projection mode. forward: for the exact path, list its R references. reverse: list every entry whose R references the path. impact: transitive reverse closure — every entry that may be reached from the target along formal R relationships, level by level (AOCI-style impact analysis; traverses only model-authored R edges). Requires `path`.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const root = await resolveProjectRoot(ctx, exec.agent, args.project)
      const paths = cognitionPaths(root)
      const isDatabase = args.volume === 'database'
      const volumeFile = isDatabase ? paths.database : paths.code
      let codeText = ''
      try {
        codeText = await readFile(volumeFile, 'utf8')
      } catch {
        return { text: isDatabase
          ? `No Database volume at ${paths.database}. Call cognition_database_init first.`
          : `No Code volume at ${paths.code}. Call cognition_init first.` }
      }
      const parsed = fmt.parseCodeVolume(codeText)
      const relMode = ['forward', 'reverse', 'impact'].includes(args.relations) ? args.relations : undefined
      if (relMode !== undefined) {
        const target = String(args.path ?? '').replaceAll('\\', '/').replace(/^(code|database):/, '').trim()
        if (target.length === 0) {
          return { text: `cognition_search relations=${relMode} requires \`path\` (a relative path like lib/greet.js, or a schema.table like public.orders).` }
        }
        const matches = (candidate) => candidate === target || candidate.endsWith(`/${target}`)
        const byPath = new Map()
        for (const section of parsed.sections) {
          for (const entry of section.entries) {
            const fullPath = `${section.dir === '.' ? '' : `${section.dir}/`}${entry.basename}`
            byPath.set(fullPath, entry)
          }
        }
        if (relMode === 'forward') {
          const entry = [...byPath.entries()].find(([fullPath]) => matches(fullPath))
          if (entry === undefined) {
            return { text: `# cognition_search relations=forward\nNo entry found for "${target}" in the ${isDatabase ? 'Database' : 'Code'} volume.` }
          }
          const refs = (entry[1].r === '-' ? [] : entry[1].r.split(',').map(item => item.trim()).filter(item => item !== '-'))
          const lines = [`# Relations forward from ${entry[0]}`, `depends on (${refs.length}):`]
          for (const ref of refs) {
            const refPath = ref.replace(/^(code|database):/, '')
            const refEntry = [...byPath.entries()].find(([fullPath]) => fullPath === refPath || fullPath.endsWith(`/${refPath}`))
            lines.push(`- ${ref}${refEntry ? ` [${refEntry[1].tags}] ${refEntry[1].f}` : ' (no indexed entry)'}`)
          }
          return { text: lines.join('\n') }
        }
      if (relMode === 'impact') {
        // Transitive reverse closure along formal R edges only (AOCI's impact
        // analysis, simplified): who depends on the target, directly or through
        // other indexed entries. Unresolvable references are counted, never guessed.
        const resolveRef = (ref) => {
          const refPath = ref.replace(/^(code|database):/, '')
          let found = byPath.get(refPath)
          if (found === undefined) {
            for (const [fullPath, entry] of byPath) {
              if (fullPath.endsWith(`/${refPath}`)) { found = entry; return [fullPath, entry] }
            }
          }
          return found === undefined ? null : [refPath, found]
        }
        // Seed with every entry directly referencing the target.
        const adjacency = new Map() // entryPath -> [{ refPath, ref }]
        for (const [fullPath, entry] of byPath) {
          if (entry.r === '-') continue
          const edges = []
          for (const ref of entry.r.split(',').map(item => item.trim()).filter(Boolean)) {
            const refPath = ref.replace(/^(code|database):/, '')
            if (refPath === target || refPath.endsWith(`/${target}`) || target.endsWith(`/${refPath}`)) edges.push({ refPath, ref })
          }
          adjacency.set(fullPath, edges)
        }
        // Reverse BFS from the target: level 0 = direct dependents.
        const levels = []
        const visited = new Set()
        let frontier = [...adjacency.entries()].filter(([, edges]) => edges.length > 0).map(([fullPath]) => fullPath)
        frontier = [...new Set(frontier)]
        let unresolvedRefs = 0
        while (frontier.length > 0 && levels.length < 10) {
          levels.push(frontier)
          for (const path of frontier) visited.add(path)
          const next = new Set()
          for (const [fullPath, entry] of byPath) {
            if (visited.has(fullPath)) continue
            if (entry.r === '-') continue
            for (const ref of entry.r.split(',').map(item => item.trim()).filter(Boolean)) {
              const resolved = resolveRef(ref)
              if (resolved === null) { unresolvedRefs++; continue }
              if (frontier.includes(resolved[0]) || visited.has(resolved[0])) {
                next.add(fullPath)
                break
              }
            }
          }
          frontier = [...next].filter(path => !visited.has(path))
        }
        const total = levels.reduce((sum, level) => sum + level.length, 0)
        const lines = [`# Impact of ${target} (${isDatabase ? 'database' : 'code'} volume)`, `derived=true — computed from model-authored R relations only; ${total} entr${total === 1 ? 'y' : 'ies'} may be reached transitively.`]
        if (total === 0) lines.push('No indexed entry references it along formal R edges.')
        levels.forEach((level, index) => {
          lines.push(`## Level ${index} (${level.length} — ${index === 0 ? 'direct dependents' : 'dependents at depth ' + (index + 1)})`)
          for (const fullPath of level) {
            const entry = byPath.get(fullPath)
            lines.push(`- ${fullPath}[${entry?.tags ?? '?'}]: F:${entry?.f ?? ''}`)
          }
        })
        if (unresolvedRefs > 0) lines.push(`${unresolvedRefs} R reference(s) did not resolve to an indexed entry and were not traversed.`)
        if (levels.length >= 10) lines.push('Depth capped at 10 levels; deeper chains were not traversed.')
        return { text: lines.join('\n') }
      }
        // reverse: every entry whose R references the target.
        const reverse = []
        for (const [fullPath, entry] of byPath) {
          if (entry.r === '-') continue
          for (const ref of entry.r.split(',').map(item => item.trim()).filter(Boolean)) {
            const refPath = ref.replace(/^(code|database):/, '')
            if (refPath === target || refPath.endsWith(`/${target}`) || target.endsWith(`/${refPath}`)) {
              reverse.push({ fullPath, entry, ref })
              break
            }
          }
        }
        const lines = [`# Relations reverse into ${target}: ${reverse.length} entr${reverse.length === 1 ? 'y' : 'ies'} depend on it`]
        for (const { fullPath, entry } of reverse) {
          lines.push(`- ${fullPath}[${entry.tags}]: F:${entry.f}`)
        }
        if (reverse.length === 0) lines.push('(no indexed entry references it — safe to change in isolation, per current R relations)')
        return { text: lines.join('\n') }
      }
      const tagFilter = (args.tags ?? '').split(',').map(tag => tag.trim().toUpperCase()).filter(Boolean)
      const pathMatch = (args.path ?? '').toLowerCase()
      const keyword = (args.keyword ?? '').toLowerCase()
      const results = []
      for (const section of parsed.sections) {
        for (const entry of section.entries) {
          const fullPath = `${section.dir === '.' ? '' : `${section.dir}/`}${entry.basename}`
          if (tagFilter.some(tag => !entry.tags.includes(tag))) continue
          if (pathMatch.length > 0 && !fullPath.toLowerCase().includes(pathMatch)) continue
          const haystack = `${entry.f} ${entry.r} ${entry.a} ${entry.s}`.toLowerCase()
          if (keyword.length > 0 && !haystack.includes(keyword)) continue
          results.push({ path: fullPath, entry })
        }
      }
      const lines = [`# cognition_search (volume=${isDatabase ? 'database' : 'code'}): ${results.length} matches`]
      for (const { path, entry } of results.slice(0, 200)) {
        lines.push(`${path}[${entry.tags}]: F:${entry.f} | R:${entry.r} | A:${entry.a} | S:${entry.s}`)
      }
      if (results.length > 200) lines.push(`... ${results.length - 200} more matches`)
      return { text: lines.join('\n') }
    },
    presentCall: (args) => ({ card: 'generic', title: `Search cognition entries${args?.relations ? ` (${args.relations})` : ''}${args?.volume === 'database' ? ' (database)' : ''}`, kind: 'read' }),
  })

  // ---------------------------------------------------------- database init
  tool(ctx, {
    name: 'cognition_database_init',
    description: 'Enable Database Cognition for a project: declare a read-only schema source and import its DDL dump (.sql file, mysqldump/pg_dump output) as accepted Schema Evidence. Writes .cognition/schema/<source>.json, appends the database Volume declaration to the Root manifest, and creates the empty Database volume. No network access — provide the dump file; never paste credentials.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project root directory. Defaults to the session working directory.' },
        source_id: { type: 'string', description: 'Stable source identity, e.g. "primary". Non-alphanumeric characters are sanitized.' },
        engine: { type: 'string', enum: ['mysql', 'postgresql', 'unknown'], description: 'Dialect of the dump. Informational; the parser accepts both styles.' },
        dump: { type: 'string', description: 'Path to the .sql DDL dump file, absolute or relative to the project root.' },
      },
      required: ['dump'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(value),
    },
    async execute(rawArgs, exec) {
      const args = { ...rawArgs, source_id: String(rawArgs.source_id ?? 'primary').trim() || 'primary', engine: rawArgs.engine ?? 'unknown' }
      const root = await resolveProjectRoot(ctx, exec.agent, args.project)
      const paths = cognitionPaths(root)
      const state = await loadState(paths.state)
      if (state === null) return { text: `No cognition state found under ${paths.dir}. Call cognition_init first.` }
      const dumpAbs = isAbsolute(args.dump) ? args.dump : resolve(root, args.dump)
      if (!(await fileExists(dumpAbs))) {
        return { text: `cognition_database_init: dump file not found: ${dumpAbs}` }
      }
      const dumpText = await readFile(dumpAbs, 'utf8')
      const evidence = ddl.parseDdl(dumpText, { sourceId: args.source_id, engine: args.engine })
      if (evidence.tables.length === 0) {
        return { text: [`cognition_database_init: no CREATE TABLE statements recognized in ${dumpAbs}.`, `Parser warnings: ${evidence.parseWarnings.join('; ')}`, 'Provide a plain-DDL dump (mysqldump/pg_dump output) and retry. Nothing was written.'].join('\n') }
      }
      // Persist evidence.
      await mkdir(paths.schemaDir, { recursive: true })
      await fmt.atomicWriteText(evidencePath(root, args.source_id), `${JSON.stringify(evidence, null, 2)}\n`)
      const previousSource = state.database.sources[args.source_id]
      state.database.sources[args.source_id] = {
        engine: evidence.engine,
        dump: args.dump,
        dumpSha256: evidence.dumpSha256,
        importedAt: evidence.importedAt,
        tables: evidence.tables.length,
      }
      // Evidence is machine fact; entry hashes survive re-imports. Pending work:
      // unchanged dump → only tables that never got an entry; changed dump → all
      // tables, because every entry may need re-checking against new evidence.
      const evidenceChanged = previousSource === undefined || previousSource.dumpSha256 !== evidence.dumpSha256
      const touchedTables = []
      for (const table of evidence.tables) {
        const identity = table.schema !== undefined ? `${table.schema}.${table.name}` : table.name
        touchedTables.push(identity)
        if (state.database.tables[identity] === undefined) state.database.tables[identity] = { evidence: true }
        else state.database.tables[identity].evidence = true
      }
      // Upgrade root manifest + create the Database volume (idempotent).
      const rootText = await readFile(paths.root, 'utf8')
      await fmt.atomicWriteText(paths.root, rootWithDatabaseVolume(rootText))
      if (!(await fileExists(paths.database))) {
        await fmt.atomicWriteText(paths.database, volumeTemplates(basename(root), state.locale ?? localeDefault).database)
      }
      // Older metas lack the database dictionary section; append it so table
      // entries validate against the intended dictionary.
      const metaUpgraded = await upgradeMetaWithDatabaseDictionary(paths.meta)
      const orphanedTables = Object.keys(state.database.tables).filter(identity => !touchedTables.includes(identity))
      for (const identity of orphanedTables) {
        if (state.database.tables[identity].evidence === true && state.database.tables[identity].sha256 === undefined) {
          delete state.database.tables[identity]
        }
      }
      const pendingTables = evidenceChanged
        ? touchedTables
        : touchedTables.filter(identity => state.database.tables[identity].sha256 === undefined)
      addDatabasePending(state, pendingTables)
      await saveState(paths.state, state)
      const lines = [
        `# cognition_database_init`,
        `source: ${args.source_id} (${evidence.engine}) | tables parsed: ${evidence.tables.length} | checks: ${evidence.tables.reduce((sum, table) => sum + (table.checks?.length ?? 0), 0)} | dump sha256: ${evidence.dumpSha256.slice(0, 12)}…`,
        `evidence ${previousSource === undefined ? 'imported' : evidenceChanged ? 'changed — all tables marked pending re-check' : 'unchanged — pending list only gained tables without entries'}`,
        ...(metaUpgraded ? ['Meta upgraded: appended the #[Tag dictionary: database] section.'] : []),
        ...(evidence.parseWarnings.length > 0 ? [`parse warnings: ${evidence.parseWarnings.join('; ')}`] : []),
        `tables: ${touchedTables.slice(0, 50).join(', ')}${touchedTables.length > 50 ? ` …and ${touchedTables.length - 50} more` : ''}`,
        '',
        'Next: read the evidence at ' + evidencePath(root, args.source_id) + ' (columns/PK/FK/uniques), then call cognition_update_entries with volume="database" and one FRAS entry per table (path=schema.table).',
        'Evidence is machine fact only; table responsibilities and constraints are authored by you from that evidence.',
      ]
      return { text: lines.join('\n') }
    },
    presentCall: (args) => ({ card: 'generic', title: `Import DB schema dump${args?.source_id ? `: ${args.source_id}` : ''}`, kind: 'execute' }),
  })

  // ---------------------------------------------------------- database scan
  tool(ctx, {
    name: 'cognition_database_scan',
    description: 'Compare the imported schema evidence against the Database volume and state: reports tables missing entries, orphan entries (table absent from evidence), stale entries (evidence hash changed at last import), and tables whose dump has not been re-imported. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project root directory. Defaults to the session working directory.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const root = await resolveProjectRoot(ctx, exec.agent, args.project)
      const paths = cognitionPaths(root)
      const state = await loadState(paths.state)
      if (state === null) return { text: `No cognition state found under ${paths.dir}. Call cognition_init first.` }
      const sources = state.database?.sources ?? {}
      if (Object.keys(sources).length === 0) {
        return { text: 'No database source declared. Call cognition_database_init with a .sql DDL dump first.' }
      }
      const evidence = await loadPrimaryEvidence(root, state)
      const evidenceTables = (evidence?.tables ?? []).map(table => table.schema !== undefined ? `${table.schema}.${table.name}` : table.name)
      const evidenceSet = new Set(evidenceTables)
      const dbPending = state.database?.pending ?? []
      const lines = [`# cognition_database_scan`]
      lines.push(`sources: ${Object.entries(sources).map(([id, source]) => `${id}(${source.engine}, ${source.tables} tables)`).join(', ')}`)
      if (!(await fileExists(paths.database))) {
        lines.push('Database volume does not exist yet.')
        return { text: lines.join('\n') }
      }
      const dbText = await readFile(paths.database, 'utf8')
      const parsed = fmt.parseCodeVolume(dbText)
      const indexed = []
      for (const section of parsed.sections) {
        for (const entry of section.entries) {
          indexed.push(`${section.dir === '.' ? '' : `${section.dir}/`}${entry.basename}`)
        }
      }
      const missingEntry = evidenceTables.filter(table => !indexed.includes(table))
      const orphanEntry = indexed.filter(table => !evidenceSet.has(table))
      lines.push(`evidence tables: ${evidenceTables.length} | indexed entries: ${indexed.length} | pending list: ${dbPending.length}`)
      lines.push(`missing entry (table in evidence, no entry): ${missingEntry.length}`)
      lines.push(`orphan entry (entry whose table is not in evidence): ${orphanEntry.length}`)
      if (missingEntry.length > 0) lines.push(`\nauthor entries for:\n${missingEntry.join('\n')}`)
      if (orphanEntry.length > 0) lines.push(`\nremove with cognition_remove_entries volume="database":\n${orphanEntry.join('\n')}`)
      if (missingEntry.length === 0 && orphanEntry.length === 0) lines.push('\nDatabase volume is aligned with the accepted schema evidence.')
      return { text: lines.join('\n') }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Scan database cognition drift', kind: 'read' }),
  })

  // ------------------------------------------------------------------ verify
  tool(ctx, {
    name: 'cognition_verify',
    description: 'Re-validate every entry in the Code and Database volumes against the current Meta rules and evidence: FRAS fields, tag dictionary membership, S quota, and resolvable R references (project files for code:; schema evidence tables for database:). Returns aligned=true or the full violation list. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project root directory. Defaults to the session working directory.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const root = await resolveProjectRoot(ctx, exec.agent, args.project)
      const paths = cognitionPaths(root)
      const state = await loadState(paths.state)
      if (state === null) return { text: `No cognition state found under ${paths.dir}. Call cognition_init first.` }
      const rules = await loadRules(paths.meta)
      const evidence = await loadPrimaryEvidence(root, state)
      // Inventory once; code: R references and code paths resolve against it.
      const filesCache = new Set()
      try {
        const walked = await scanner.scanInventory(root, { maxFileBytes, excludeDirs: [...extraExcludeDirs], include: extraExtensions })
        for (const path of walked.files.keys()) filesCache.add(path)
      } catch {}
      const violations = []
      let checked = 0
      for (const [volumeName, volumeFile, dictionary] of [
        ['code', paths.code, rules.dictionary],
        ['database', paths.database, rules.databaseDictionary],
      ]) {
        if (!(await fileExists(volumeFile))) continue
        const volumeText = await readFile(volumeFile, 'utf8')
        const parsed = fmt.parseCodeVolume(volumeText)
        for (const parseError of parsed.parseErrors) violations.push(`${volumeName} volume: ${parseError}`)
        for (const section of parsed.sections) {
          for (const entry of section.entries) {
            checked++
            const fullPath = `${section.dir === '.' ? '' : `${section.dir}/`}${entry.basename}`
            const errors = fmt.validateEntry({ path: fullPath, tags: entry.tags, f: entry.f, r: entry.r, a: entry.a, s: entry.s }, {
              dictionary,
              quota: rules.quota,
              fileExists: volumeName === 'code' ? (ref) => filesCache.has(ref) : undefined,
              // Cross-volume R references: code entries may point at database:
              // tables, validated against the accepted schema evidence.
              tableExists: evidence !== null ? evidenceTableLookup(evidence) : undefined,
            })
            for (const error of errors) violations.push(`${volumeName}: ${fullPath}: ${error}`)
          }
        }
      }
      const lines = [`# cognition_verify`]
      lines.push(`entries checked: ${checked} | violations: ${violations.length}`)
      if (violations.length === 0) {
        lines.push('aligned=true — every entry satisfies the Meta rules, quotas, and reference targets.')
      } else {
        lines.push('aligned=false')
        for (const violation of violations.slice(0, 50)) lines.push(`VIOLATION ${violation}`)
        if (violations.length > 50) lines.push(`... and ${violations.length - 50} more`)
      }
      return { text: lines.join('\n') }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Verify cognition index', kind: 'read' }),
  })

  // --------------------------------------------------------------- snapshot
  tool(ctx, {
    name: 'cognition_snapshot',
    description: 'Emit a deterministic read-only observation of the current cognition state (entry list with hashes, coverage, index tokens, drift pending counts). Save the returned JSON yourself and pass its path to cognition_evolution later to compare an earlier observation with now. Persists nothing; derived=true.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project root directory. Defaults to the session working directory.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const root = await resolveProjectRoot(ctx, exec.agent, args.project)
      const paths = cognitionPaths(root)
      const stateData = await loadState(paths.state)
      if (stateData === null) return { text: `No cognition state under ${paths.dir}. Call cognition_init first.` }
      const entryList = []
      for (const [volumeName, volumeFile] of [['code', paths.code], ['database', paths.database]]) {
        if (!(await fileExists(volumeFile))) continue
        const parsed = fmt.parseCodeVolume(await readFile(volumeFile, 'utf8'))
        for (const section of parsed.sections) {
          for (const entry of section.entries) {
            const fullPath = `${section.dir === '.' ? '' : `${section.dir}/`}${entry.basename}`
            entryList.push({ object: volumeName === 'code' ? `code:${fullPath}` : `database:${fullPath}`, tags: entry.tags, hash: fmt.entryHash({ path: fullPath, tags: entry.tags, f: entry.f, r: entry.r, a: entry.a, s: entry.s }) })
          }
        }
      }
      entryList.sort((a, b) => (a.object < b.object ? -1 : 1))
      // Deterministic coverage from the current tree.
      let coverage = null
      try {
        const walked = await scanner.scanInventory(root, { maxFileBytes, excludeDirs: [...extraExcludeDirs], include: extraExtensions })
        await scanner.hashFiles(root, walked.files)
        const stats = scanner.coverageStats(walked.files, stateData)
        coverage = { indexedFiles: stats.indexedFiles, totalFiles: stats.totalFiles, indexedLines: stats.indexedLines, totalLines: stats.totalLines, filesPct: Math.round(stats.coverageFiles * 100), linesPct: Math.round(stats.coverageLines * 100) }
      } catch { /* best-effort */ }
      let indexTokens = 0
      for (const volumeFile of [paths.root, paths.meta, paths.code, paths.database]) {
        if (await fileExists(volumeFile)) indexTokens += estimateTokens(await readFile(volumeFile, 'utf8'))
      }
      const snapshot = {
        kind: 'project-cognition/snapshot',
        derived: true,
        project: basename(root),
        root,
        takenAt: new Date().toISOString(),
        entries: entryList,
        counts: { entries: entryList.length, pending: (stateData.pending ?? []).length, databasePending: (stateData.database?.pending ?? []).length },
        coverage,
        indexTokens,
      }
      return { text: [`# cognition_snapshot (derived=true; save this JSON for cognition_evolution)`, JSON.stringify(snapshot, null, 2)].join('\n') }
    },
    presentCall: (args) => ({ card: 'generic', title: `Snapshot cognition state${args?.project ? `: ${args.project}` : ''}`, kind: 'read' }),
  })

  // -------------------------------------------------------------- evolution
  tool(ctx, {
    name: 'cognition_evolution',
    description: 'Compare a previously saved cognition_snapshot JSON file with the current state: entries added, removed, changed (hash differs), coverage change, index token change, and drift pending deltas. Read-only; derived=true; the caller supplies the old snapshot — nothing is stored.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project root directory. Defaults to the session working directory.' },
        snapshot_file: { type: 'string', description: 'Path to the saved snapshot JSON (absolute, or relative to the project root).' },
      },
      required: ['snapshot_file'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(value),
    },
    async execute(rawArgs, exec) {
      const args = { ...rawArgs, snapshot_file: String(rawArgs.snapshot_file ?? '') }
      const root = await resolveProjectRoot(ctx, exec.agent, args.project)
      const paths = cognitionPaths(root)
      const snapshotAbs = isAbsolute(args.snapshot_file) ? args.snapshot_file : resolve(root, args.snapshot_file)
      let previous
      try {
        previous = JSON.parse(await readFile(snapshotAbs, 'utf8'))
      } catch (error) {
        return { text: `cognition_evolution: cannot read snapshot file ${snapshotAbs} (${error.message}). Save cognition_snapshot output as JSON first.` }
      }
      if (previous?.kind !== 'project-cognition/snapshot' || !Array.isArray(previous.entries)) {
        return { text: `cognition_evolution: ${snapshotAbs} is not a cognition_snapshot JSON (missing kind=project-cognition/snapshot).` }
      }
      // Current observation, built the same deterministic way.
      const current = { entries: [] }
      for (const [volumeName, volumeFile] of [['code', paths.code], ['database', paths.database]]) {
        if (!(await fileExists(volumeFile))) continue
        const parsed = fmt.parseCodeVolume(await readFile(volumeFile, 'utf8'))
        for (const section of parsed.sections) {
          for (const entry of section.entries) {
            const fullPath = `${section.dir === '.' ? '' : `${section.dir}/`}${entry.basename}`
            current.entries.push({ object: volumeName === 'code' ? `code:${fullPath}` : `database:${fullPath}`, tags: entry.tags, hash: fmt.entryHash({ path: fullPath, tags: entry.tags, f: entry.f, r: entry.r, a: entry.a, s: entry.s }) })
          }
        }
      }
      current.entries.sort((a, b) => (a.object < b.object ? -1 : 1))
      const previousMap = new Map(previous.entries.map(entry => [entry.object, entry]))
      const currentMap = new Map(current.entries.map(entry => [entry.object, entry]))
      const added = current.entries.filter(entry => !previousMap.has(entry.object))
      const removed = previous.entries.filter(entry => !currentMap.has(entry.object))
      const changed = current.entries.filter(entry => previousMap.has(entry.object) && previousMap.get(entry.object).hash !== entry.hash)
      const stateData = await loadState(paths.state)
      const nowPending = (stateData?.pending ?? []).length + (stateData?.database?.pending ?? []).length
      const thenPending = (previous.counts?.pending ?? 0) + (previous.counts?.databasePending ?? 0)
      let currentCoverage = null
      try {
        const walked = await scanner.scanInventory(root, { maxFileBytes, excludeDirs: [...extraExcludeDirs], include: extraExtensions })
        await scanner.hashFiles(root, walked.files)
        const stats = scanner.coverageStats(walked.files, stateData ?? {})
        currentCoverage = { filesPct: Math.round(stats.coverageFiles * 100), linesPct: Math.round(stats.coverageLines * 100), totalLines: stats.totalLines }
      } catch { /* best-effort */ }
      const lines = [`# cognition_evolution — ${previous.project ?? '?'}`]
      lines.push(`snapshot from ${previous.takenAt ?? '?'} → now (${new Date().toISOString().slice(0, 19)}Z), derived=true`)
      lines.push(`entries: ${previous.entries.length} → ${current.entries.length} (added ${added.length}, removed ${removed.length}, changed ${changed.length})`)
      if (added.length > 0) lines.push(`added: ${added.map(entry => entry.object).join(', ')}`)
      if (removed.length > 0) lines.push(`removed: ${removed.map(entry => entry.object).join(', ')}`)
      if (changed.length > 0) lines.push(`changed: ${changed.map(entry => entry.object).join(', ')}`)
      if (previous.coverage !== null && currentCoverage !== null) {
        lines.push(`coverage: files ${previous.coverage.filesPct ?? '?'}% → ${currentCoverage.filesPct}%, lines ${previous.coverage.linesPct ?? '?'}% → ${currentCoverage.linesPct}% (total lines ${previous.coverage.totalLines ?? '?'} → ${currentCoverage.totalLines})`)
      }
      if (previous.indexTokens !== undefined) {
        let currentIndexTokens = 0
        for (const volumeFile of [paths.root, paths.meta, paths.code, paths.database]) {
          if (await fileExists(volumeFile)) currentIndexTokens += estimateTokens(await readFile(volumeFile, 'utf8'))
        }
        lines.push(`index tokens: ${previous.indexTokens} → ${currentIndexTokens}`)
      }
      lines.push(`pending maintenance items: ${thenPending} → ${nowPending}`)
      if (added.length === 0 && removed.length === 0 && changed.length === 0) lines.push('The indexed object set is unchanged since the snapshot (entry contents may still differ inside F/R/A/S if hashes moved — see changed list above).')
      return { text: lines.join('\n') }
    },
    presentCall: (args) => ({ card: 'generic', title: `Evolution vs snapshot${args?.snapshot_file ? `: ${args.snapshot_file}` : ''}`, kind: 'read' }),
  })

  // ----------------------------------------------------------------- doctor
  tool(ctx, {
    name: 'cognition_doctor',
    description: 'Diagnose a project cognition setup (read-only): checks the volume skeleton, Meta dictionary completeness, state.json integrity (v1/v2, hash consistency), pending-list sanity, schema evidence presence, drift summary, and index token size against the chunk budget. Returns an itemized HEALTHY / WARN / FAIL report. Run this when the index behaves oddly or after restoring from Git.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project root directory. Defaults to the session working directory.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const root = await resolveProjectRoot(ctx, exec.agent, args.project)
      const paths = cognitionPaths(root)
      const items = []
      const add = (level, check, detail) => items.push({ level, check, detail })

      // 1. Volume skeleton
      const present = {}
      for (const [label, file] of [['root', paths.root], ['meta', paths.meta], ['code', paths.code], ['database', paths.database], ['state', paths.state]]) {
        present[label] = await fileExists(file)
      }
      if (!present.root) {
        add('FAIL', 'volume skeleton', 'no cognition.txt — no index here; cognition_init creates one')
        return renderDoctor(root, items)
      }
      add('HEALTHY', 'volume skeleton', `root${present.meta ? '+meta' : ' (META MISSING)'}${present.code ? '+code' : ' (CODE MISSING)'}${present.database ? '+database' : ''}${present.state ? '+state' : ' (STATE MISSING)'}`)
      if (!present.meta) add('FAIL', 'meta volume', 'cognition.meta.txt missing — entries cannot be validated')
      if (!present.code) add('WARN', 'code volume', 'cognition.code.txt missing — cognition_scan will not accept entries until init completes')

      // 2. Root manifest parsable
      const rootText = await readFile(paths.root, 'utf8')
      const header = fmt.parseRootManifest(rootText)
      const volumeLines = rootText.split(/\r?\n/).filter(line => line.startsWith('#Volume:')).length
      add(volumeLines >= 2 ? 'HEALTHY' : 'WARN', 'root manifest', `format=${header['Format-Version'] ?? 'unknown'}, locale=${header['Locale'] ?? 'unknown'}, ${volumeLines} volume declaration(s)`)

      // 3. Meta dictionaries
      if (present.meta) {
        const metaText = await readFile(paths.meta, 'utf8')
        const codeDict = fmt.parseTagDictionary(metaText, 'code')
        add(codeDict.size >= 3 ? 'HEALTHY' : 'FAIL', 'meta code dictionary', codeDict.size >= 3 ? `${codeDict.size} axes declared` : 'fewer than 3 tag axes parseable — entries will fail validation')
        const dbDictDeclared = fmt.hasDictionarySection(metaText, 'database')
        if (present.database && !dbDictDeclared) add('WARN', 'meta database dictionary', 'database volume exists but meta lacks the #[Tag dictionary: database] section (auto-appended on next database_init)')
        else add('HEALTHY', 'meta database dictionary', dbDictDeclared ? 'declared' : 'not declared (only needed with a database volume)')
        const quota = fmt.parseSQuota(metaText)
        add(quota ? 'HEALTHY' : 'WARN', 'S quota', quota ? `limits parsed for ${Object.keys(quota).length} importance bands` : 'no S quota parsed; validation falls back to 200 chars')
      }

      // 4. state.json integrity
      const stateData = await loadState(paths.state)
      if (stateData === null) {
        add(present.state ? 'FAIL' : 'WARN', 'state.json', present.state ? 'present but unreadable/corrupt — cognition_init will not fix it; delete or repair the file' : 'absent')
      } else {
        const fileCount = Object.keys(stateData.files ?? {}).length
        const entryCount = Object.keys(stateData.entries ?? {}).length
        const pendingCount = (stateData.pending ?? []).length
        const pendingSanity = (stateData.pending ?? []).filter(path => stateData.entries?.[path] === undefined && stateData.files?.[path] === undefined).length
        add('HEALTHY', 'state.json', `v${stateData.stateVersion}, ${fileCount} files, ${entryCount} entries, ${pendingCount} pending`)
        if (pendingSanity > 0) add('WARN', 'pending list', `${pendingSanity} pending paths reference neither an entry nor a file record; cognition_scan rebuilds the list`)
        if (entryCount > fileCount) add('WARN', 'entry/file ratio', `${entryCount} entries vs ${fileCount} file records — run cognition_scan to reconcile hashes`)
      }

      // 5. Schema evidence when a database source is declared
      const sources = stateData?.database?.sources ?? {}
      if (Object.keys(sources).length > 0) {
        for (const [sourceId, source] of Object.entries(sources)) {
          const evidence = await loadEvidence(root, sourceId)
          if (evidence === null) add('FAIL', `schema evidence ${sourceId}`, 'declared in state.json but the evidence file is missing — re-run cognition_database_init with the dump')
          else {
            const tableCount = (evidence.tables ?? []).length
            add(tableCount > 0 ? 'HEALTHY' : 'WARN', `schema evidence ${sourceId}`, `${tableCount} tables, dump sha ${String(source.dumpSha256 ?? '').slice(0, 12)}`)
          }
        }
      }

      // 6. Drift quick pass (only when state is readable)
      if (stateData !== null) {
        try {
          const walked = await scanner.scanInventory(root, { maxFileBytes, excludeDirs: [...extraExcludeDirs], include: extraExtensions })
          await scanner.hashFiles(root, walked.files)
          const drift = scanner.compareDrift(walked.files, stateData)
          const drifted = drift.missing.length + drift.orphan.length + drift.stale.length
          add(drifted === 0 ? 'HEALTHY' : 'WARN', 'drift', `missing=${drift.missing.length} orphan=${drift.orphan.length} stale=${drift.stale.length} — cognition_scan reports the batch plan`)
          const coverage = scanner.coverageStats(walked.files, stateData)
          add('HEALTHY', 'coverage', `${coverage.indexedFiles}/${coverage.totalFiles} files (${Math.round(coverage.coverageFiles * 100)}%), ${coverage.indexedLines}/${coverage.totalLines} lines`)
        } catch (error) {
          add('WARN', 'drift scan', `scan failed: ${error.message}`)
        }
      }

      // 7. Index size vs chunk budget
      if (present.code) {
        const codeText = await readFile(paths.code, 'utf8')
        const tokens = fmt.estimateTokens(codeText) + (present.meta ? fmt.estimateTokens(await readFile(paths.meta, 'utf8')) : 0)
        add(tokens <= chunkTokenBudget ? 'HEALTHY' : 'WARN', 'index size', `~${tokens} tokens; ${tokens <= chunkTokenBudget ? 'fits one overview delivery' : `exceeds the ${chunkTokenBudget}-token chunk budget — overview delivers in chunks`}`)
      }

      // 8. AGENTS.md managed block (cross-host portability; informational)
      const agentsFile = join(root, 'AGENTS.md')
      if (await fileExists(agentsFile)) {
        const agentsText = await readFile(agentsFile, 'utf8')
        add(hasAgentsBlock(agentsText) ? 'HEALTHY' : 'WARN', 'AGENTS.md block', hasAgentsBlock(agentsText)
          ? 'managed rules block present'
          : 'AGENTS.md exists without the managed rules block — cognition_init with agents_md=true appends one (existing content untouched)')
      } else {
        add('HEALTHY', 'AGENTS.md block', 'no AGENTS.md in this project (optional: cognition_init agents_md=true creates one for non-DSH hosts)')
      }
      return renderDoctor(root, items)
    },
    presentCall: (args) => ({ card: 'generic', title: `Diagnose cognition setup${args?.project ? `: ${args.project}` : ''}`, kind: 'read' }),
  })

  // ---------------------------------------------------------------- gate
  tool(ctx, {
    name: 'cognition_gate',
    description: 'Per-conversation gate for the project cognition registry. Call once at the start of a conversation in a project: it resolves the project against the per-machine whitelist/blacklist and returns exactly one verdict — blacklisted (do nothing), whitelisted-unindexed (create the index), whitelisted-indexed (maintain it: keep aligned after development), or unlisted (ask the user through the user-question overlay, then call this tool again with user_response=accept or decline to record the choice).',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project root directory. Defaults to the session working directory.' },
        user_response: { type: 'string', enum: ['accept', 'decline'], description: 'After the user answers the overlay question for an unlisted project: accept records the whitelist, decline records the blacklist.' },
        remark: { type: 'string', description: 'Optional note stored with the accept/decline record.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(value),
    },
    async execute(rawArgs, exec) {
      const args = rawArgs ?? {}
      const root = await resolveProjectRoot(ctx, exec.agent, args.project)
      const paths = cognitionPaths(root)
      const hasIndex = await fileExists(paths.root)

      // Resolve the verdict first; the user_response write happens last so a
      // failing registry store still leaves a correct verdict behind.
      const response = args.user_response === 'accept' || args.user_response === 'decline' ? args.user_response : undefined
      let registryError
      if (response !== undefined) {
        try {
          if (response === 'accept') await registry.allowedAdd(root, args.remark ?? '')
          else await registry.declinedAdd(root, args.remark ?? '')
        } catch (error) {
          registryError = error.message
        }
      }

      const blacklisted = registry.declinedFor(root)
      const whitelisted = registry.allowedFor(root)
      if (blacklisted !== null && whitelisted === null) {
        const when = typeof blacklisted.declinedAt === 'string' ? ` (recorded ${blacklisted.declinedAt.slice(0, 10)})` : ''
        return {
          text: [
            `VERDICT: blacklisted${when}. The user chose not to maintain a cognition index for ${root}.`,
            'Do nothing: do not call cognition_init, cognition_overview, or suggest an index in this conversation.',
            blacklisted.remark ? `Remark: ${blacklisted.remark}` : '',
          ].filter(Boolean).join('\n'),
        }
      }
      if (whitelisted !== null) {
        if (hasIndex) {
          const stateData = await loadState(paths.state)
          const pending = (stateData?.pending?.length ?? 0) + (stateData?.database?.pending?.length ?? 0)
          // Lightweight drift summary from recorded state only (no rescan): the
          // stale count uses entry hashes versus nothing on disk — unavailable
          // without a walk — so report the recorded pending list and entry/file
          // record skew instead.
          const fileRecords = Object.keys(stateData?.files ?? {}).length
          const entryRecords = Object.keys(stateData?.entries ?? {}).length
          const unauthored = fileRecords - entryRecords
          const lines = [`VERDICT: whitelisted-indexed. ${root} has a cognition index; keep it dynamically maintained.`]
          if (pending > 0) lines.push(`Pending maintenance items recorded in state.json: ${pending}. Call cognition_overview to load the index and resolve them.`)
          else lines.push('No pending maintenance items; call cognition_overview before the first edits and cognition_scan after development to stay aligned.')
          if (unauthored > 0) lines.push(`${unauthored} managed file(s) have no entry yet (files ${fileRecords} vs entries ${entryRecords}); cognition_scan refreshes the authoring plan.`)
          if (fileRecords === 0) lines.push('state.json has no file records yet — run cognition_scan to establish the baseline.')
          return { text: lines.join('\n') }
        }
        return {
          text: [
            `VERDICT: whitelisted-unindexed. ${root} is whitelisted but has no cognition index yet — create one now:`,
            '1) cognition_init to create the volume skeleton; 2) cognition_scan for the batch plan;',
            '3) read each batch\'s files and cognition_update_entries one FRAS entry per file; 4) cognition_verify.',
            'Entry line format lives in cognition.meta.txt. Track the batches with the task planning tools.',
          ].join('\n'),
        }
      }

      // Unlisted: either the user just answered (record above) or the overlay
      // question must be asked before anything else.
      if (response !== undefined) {
        if (registryError) {
          return { text: `VERDICT: unlisted (registry write failed: ${registryError}). Fix the registry store, then retry the gate.` }
        }
        return {
          text: response === 'accept'
            ? `Recorded ${root} on the whitelist. Proceed with index creation: cognition_init → cognition_scan → cognition_update_entries per batch → cognition_verify.`
            : `Recorded ${root} on the blacklist. Do nothing: no cognition handling in this conversation or later ones.`,
        }
      }
      return {
        text: [
          `VERDICT: unlisted. ${root} is neither whitelisted nor blacklisted.`,
          'The Web client raises the gate overlay (create/decline) automatically after the first message; the user\'s choice lands on the whitelist or blacklist.',
          'Wait for the user\'s answer, then call cognition_gate again to observe the recorded verdict.',
          'If no overlay appears (non-Web session), ask once via ask_user_question ("为这个项目维护认知索引吗？" / create or decline), then answer this gate with user_response=accept or decline yourself.',
        ].join('\n'),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `Cognition gate${args?.project ? ` — ${args.project}` : ''}`, kind: 'read' }),
  })

  // ---------------------------------------------------------------- registry
  tool(ctx, {
    name: 'cognition_registry',
    description: 'Maintain the persistent project registry (~/.dsh/project-cognition.json). action="list" shows both the declined (blacklist) and allowed (whitelist) projects; action="decline" blacklists a project; action="allow" lifts a blacklist record (the whitelist counterpart is action="whitelist"); action="whitelist" whitelists a project; action="unwhitelist" removes it from the whitelist. Prefer cognition_gate for the per-conversation decision.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'decline', 'allow', 'whitelist', 'unwhitelist'], description: 'List both lists, blacklist (decline), lift a blacklist record (allow), whitelist, or remove from the whitelist (unwhitelist).' },
        project: { type: 'string', description: 'Project directory (absolute, or relative to the session working directory). Defaults to the session working directory.' },
        remark: { type: 'string', description: 'Optional note stored with a decline record (e.g. why the user declined).' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const action = ['decline', 'allow', 'whitelist', 'unwhitelist'].includes(args.action) ? args.action : 'list'
      if (action === 'list') {
        let store
        try {
          store = registry.readStore()
        } catch (error) {
          return { text: `cognition_registry: ${error.message}` }
        }
        const declinedRows = registry.listDeclined(store)
        const allowedRows = registry.listAllowed(store)
        const lines = [`# Project registry: ${declinedRows.length} blacklisted, ${allowedRows.length} whitelisted`, `store: ${registry.registryPath()}`]
        if (store.malformed === true) lines.push('WARNING: the store file is not valid JSON; fix or delete it before editing records.')
        lines.push('## Blacklist (declined cognition-index creation)')
        for (const row of declinedRows) {
          lines.push(`- ${row.path} | declined ${row.declinedAt ?? '?'}${row.remark ? ` | remark: ${row.remark}` : ''}`)
        }
        if (declinedRows.length === 0) lines.push('(none)')
        lines.push('## Whitelist (allowed, index created or maintained)')
        for (const row of allowedRows) {
          lines.push(`- ${row.path} | allowed ${row.allowedAt ?? '?'}${row.remark ? ` | remark: ${row.remark}` : ''}`)
        }
        if (allowedRows.length === 0) lines.push('(none)')
        return { text: lines.join('\n') }
      }
      const root = await resolveProjectRoot(ctx, exec.agent, args.project)
      try {
        if (action === 'whitelist' || action === 'unwhitelist') {
          if (action === 'whitelist') {
            const result = await registry.allowedAdd(root, args.remark ?? '')
            return {
              text: [
                result.added
                  ? `Recorded: ${root} is whitelisted — sessions will create or maintain its cognition index without asking.`
                  : `Already recorded: ${root} is already whitelisted (nothing changed).`,
                'Call cognition_registry with action="unwhitelist" to remove it.',
              ].join('\n'),
            }
          }
          const result = await registry.allowedRemove(root)
          return {
            text: result.removed
              ? `Removed: ${root} is no longer whitelisted; the gate will treat it as unlisted again.`
              : `Nothing to remove: ${root} is not whitelisted.`,
          }
        }
        if (action === 'decline') {
          const result = await registry.declinedAdd(root, args.remark ?? '')
          return {
            text: [
              result.added
                ? `Recorded: ${root} will not be offered a cognition index in future sessions.`
                : `Already recorded: ${root} was already on the declined list (nothing changed).`,
              'Call cognition_registry with action="allow" to lift the record if the user changes their mind.',
            ].join('\n'),
          }
        }
        const result = await registry.declinedRemove(root)
        return {
          text: result.removed
            ? `Lifted: ${root} is no longer on the declined list; a cognition index may be built here (call cognition_init to start).`
            : `Nothing to lift: ${root} is not on the declined list.`,
        }
      } catch (error) {
        return { text: `cognition_registry: ${error.message}` }
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `Registry: ${args?.action ?? 'list'}${args?.project ? ` — ${args.project}` : ''}`, kind: args?.action === 'allow' ? 'delete' : 'execute' }),
  })
}

export { }
