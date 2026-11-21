/**
 * Host half of the read-only Project Cognition panel.
 *
 * A Typert Remote service (`projectCognitionPanel`) that turns a project's
 * `.cognition/` assets into one structured, read-only snapshot for the Web
 * panel page: volume counts, drift facts, pending lists, database sources,
 * and the verify verdict. No method here writes anything.
 * @module
 */

import { readFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The Host process owns @deepseek-ai/cordis (apply-form plugins resolve bare
// specifiers against the Host context), but NOT dsh-typert-protocol — so the
// panel service embeds the small Typert Remote binding shape here: a
// Service-like base (ctx.provide + [symbols.tracker]), the `typertRemote`
// binding the Gateway's source-mode discovery reads, and the plain-JS
// remote-method descriptor. Failure identity follows the wire contract: the
// Gateway discriminates RemoteError by the `isDSHRemoteError` marker and
// `code`, never by instanceof (see dsh-typert-protocol lib/index.js).
class PanelServiceBase {
  constructor(ctx, name) {
    this.ctx = ctx
    this.name = name
    this.ctx.reflect.provide(name, this)
  }
}

/** A real Error carrying the stable code; identified structurally on the wire. */
class RemoteError extends Error {
  isDSHRemoteError = true
  constructor(code, message, details) {
    super(message)
    this.code = code
    this.details = details
    this.name = 'RemoteError'
  }
}

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** The visible binding consumed by the Gateway's source-mode discovery. */
function bindTypertRemote(service, serviceKey, namespace) {
  return Object.freeze({ service, serviceKey, namespace })
}

// Resolve lib modules against this file's real directory: the profile links
// the package checkout, and bare relative specifiers can mis-resolve through
// the link (see index.js for the same workaround).
const here = dirname(fileURLToPath(import.meta.url))
const fmt = await import(`file://${here.replaceAll('\\', '/')}/lib/format.js`)
const scanner = await import(`file://${here.replaceAll('\\', '/')}/lib/scanner.js`)
const stateModule = await import(`file://${here.replaceAll('\\', '/')}/lib/state.js`)
const registry = await import(`file://${here.replaceAll('\\', '/')}/lib/registry.js`)

const MAX_LIST = 40

async function fileExists(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

async function readTextOrNull(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** Count entries and collect section dirs from one volume text. */
function summarizeVolume(text) {
  if (text === null) return null
  const parsed = fmt.parseCodeVolume(text)
  const entries = []
  for (const section of parsed.sections) {
    for (const entry of section.entries) {
      entries.push({
        path: `${section.dir === '.' ? '' : `${section.dir}/`}${entry.basename}`,
        tags: entry.tags,
        f: entry.f,
        r: entry.r,
        a: entry.a,
        s: entry.s,
      })
    }
  }
  return { entries, sections: parsed.sections.filter(s => s.entries.length > 0).map(s => s.dir), parseWarnings: parsed.parseErrors }
}

/**
 * Read-only panel service. Mounted by the Client half through the Typert
 * Gateway; methods are marked with the plain-JS `@Remote` shape.
 */
export class ProjectCognitionPanelService extends PanelServiceBase {
  constructor(ctx) {
    super(ctx, 'projectCognitionPanel')
    this.typertRemote = bindTypertRemote(this, this.name, this.name)
  }

  /**
   * Build one read-only panel snapshot for a project root.
   * @param request { project: string } absolute project directory
   */
  async panelData(request) {
    const project = String(request?.project ?? '').trim()
    if (project.length === 0) throw new RemoteError('project-cognition/invalid-project', 'a project directory is required', {})
    const root = isAbsolute(project) ? project : resolve(project)
    let isDir = false
    try {
      isDir = statSync(root).isDirectory()
    } catch {}
    if (!isDir) throw new RemoteError('project-cognition/invalid-project', `not a directory: ${root}`, { path: root })

    const paths = stateModule.cognitionPaths(root)
    const rootText = await readTextOrNull(paths.root)
    if (rootText === null) {
      // No index: surface whether the user declined index creation for this
      // project, so the panel explains the empty state instead of nudging.
      let declined = null
      try { declined = registry.declinedFor(root) } catch { /* read-only best effort */ }
      return {
        project: basename(root),
        root,
        indexExists: false,
        declined: declined === null ? false : true,
        declinedAt: declined?.declinedAt,
        declinedRemark: declined?.remark,
      }
    }

    const metaText = await readTextOrNull(paths.meta)
    const state = await stateModule.loadState(paths.state)
    const codeSummary = summarizeVolume(await readTextOrNull(paths.code))
    const databaseSummary = summarizeVolume(await readTextOrNull(paths.database))
    const header = fmt.parseRootManifest(rootText)

    // Code drift: one walk, then compare against state.files.
    let drift = null
    if (state !== null) {
      try {
        const walked = await scanner.scanInventory(root, {})
        await scanner.hashFiles(root, walked.files)
        drift = scanner.compareDrift(walked.files, state)
      } catch (error) {
        drift = { error: error.message, missing: [], orphan: [], stale: [], unchanged: [] }
      }
    }

    // Database drift: evidence tables vs indexed table entries.
    let databaseDrift = null
    const sources = state?.database?.sources ?? {}
    const primarySourceId = Object.keys(sources)[0]
    if (primarySourceId !== undefined && databaseSummary !== null) {
      const evidence = await readTextOrNull(stateModule.evidencePath(root, primarySourceId))
      let evidenceTables = []
      try {
        evidenceTables = (JSON.parse(evidence)?.tables ?? []).map(table => table.schema !== undefined ? `${table.schema}.${table.name}` : table.name)
      } catch {}
      const evidenceSet = new Set(evidenceTables)
      const indexed = (databaseSummary?.entries ?? []).map(entry => entry.path)
      databaseDrift = {
        sourceId: primarySourceId,
        engine: sources[primarySourceId].engine,
        evidenceTables: evidenceTables.length,
        missingEntry: evidenceTables.filter(table => !indexed.includes(table)),
        orphanEntry: indexed.filter(table => !evidenceSet.has(table)),
      }
    }

    // Verify: re-validate every entry against dictionaries, quota, and targets.
    const verify = { checked: 0, violations: [] }
    try {
      const metaForRules = metaText ?? ''
      const dictionary = fmt.parseTagDictionary(metaForRules, 'code')
      const databaseDictionary = fmt.hasDictionarySection(metaForRules, 'database')
        ? fmt.parseTagDictionary(metaForRules, 'database')
        : null
      const quota = fmt.parseSQuota(metaForRules)
      const fileSet = new Set()
      try {
        const walked = await scanner.scanInventory(root, {})
        for (const path of walked.files.keys()) fileSet.add(path)
      } catch {}
      const tableLookup = await (async () => {
        if (databaseSummary === null) return undefined
        let names = null
        try {
          names = new Set((JSON.parse(await readTextOrNull(stateModule.evidencePath(root, primarySourceId ?? 'primary')))?.tables ?? []).flatMap(table => [table.name, table.schema !== undefined ? `${table.schema}.${table.name}` : null].filter(Boolean)))
        } catch {}
        return ref => names === null ? false : names.has(String(ref))
      })()
      for (const [volumeName, summary, dict] of [
        ['code', codeSummary, dictionary],
        ['database', databaseSummary, databaseDictionary],
      ]) {
        if (summary === null || dict === null) continue
        for (const warning of summary.parseWarnings) verify.violations.push(`${volumeName}: ${warning}`)
        for (const entry of summary.entries) {
          verify.checked++
          const errors = fmt.validateEntry(entry, {
            dictionary: dict,
            quota,
            fileExists: volumeName === 'code' ? ref => fileSet.has(ref) : undefined,
            tableExists: volumeName === 'database' ? tableLookup : undefined,
          })
          for (const error of errors) verify.violations.push(`${volumeName}: ${entry.path}: ${error}`)
        }
      }
    } catch (error) {
      verify.error = error.message
    }

    return {
      project: header['Project'] ?? basename(root),
      root,
      indexExists: true,
      locale: header['Locale'],
      format: header['Format-Version'],
      volumes: {
        databaseDeclared: rootText.includes('#Volume: id=database'),
        code: codeSummary === null ? null : { entries: codeSummary.entries.length, sections: codeSummary.sections, parseWarnings: codeSummary.parseWarnings.length },
        database: databaseSummary === null ? null : { entries: databaseSummary.entries.length, sections: databaseSummary.sections, parseWarnings: databaseSummary.parseWarnings.length },
      },
      codeEntries: codeSummary?.entries.slice(0, MAX_LIST) ?? [],
      codeEntriesTotal: codeSummary?.entries.length ?? 0,
      drift: drift === null ? null : {
        missing: drift.missing.length,
        orphan: drift.orphan.length,
        stale: drift.stale.length,
        unchanged: drift.unchanged.length,
        missingList: drift.missing.slice(0, MAX_LIST),
        orphanList: drift.orphan.slice(0, MAX_LIST),
        staleList: drift.stale.slice(0, MAX_LIST),
        ...(drift.error !== undefined ? { error: drift.error } : {}),
      },
      pending: {
        code: (state?.pending ?? []).slice(0, MAX_LIST),
        codeTotal: (state?.pending ?? []).length,
        database: (state?.database?.pending ?? []).slice(0, MAX_LIST),
        databaseTotal: (state?.database?.pending ?? []).length,
      },
      database: {
        sources: Object.entries(sources).map(([id, source]) => ({ id, engine: source.engine, tables: source.tables, importedAt: source.importedAt })),
        drift: databaseDrift,
      },
      verify: { ...verify, violations: verify.violations.slice(0, MAX_LIST), violationsTotal: verify.violations.length },
      updatedAt: new Date().toISOString(),
    }
  }
}

/** Record one method as a direct Remote invocation (plain-JS decorator shape). */
function markRemote(target, method) {
  const existing = Object.getOwnPropertyDescriptor(target, REMOTE_METHOD_DESCRIPTOR)?.value
  const previous = existing !== null && typeof existing === 'object' && Array.isArray(existing.methods) ? existing.methods : []
  Object.defineProperty(target, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([...previous, Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) })]),
    }),
  })
}

markRemote(ProjectCognitionPanelService.prototype, 'panelData')

export default ProjectCognitionPanelService
