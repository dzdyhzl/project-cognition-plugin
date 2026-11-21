/**
 * Project Cognition index format: parse, validate, and serialize the plain-text
 * cognition volumes stored in a project's `.cognition/` directory.
 *
 * Layout (project-cognition/v1, simplified from AOCI-CODE's Volumes v1):
 *   cognition.txt       Root manifest: header + #Volume declarations
 *   cognition.meta.txt  Meta volume: FRAS rules, S quota, tag dictionary
 *   cognition.code.txt  Code volume: ===dir=== sections with one FRAS entry per file
 *   state.json          Machine state: managed files, SHA-256, entry hashes, pending list
 * @module
 */

import { createHash } from 'node:crypto'

/** Regex for one FRAS entry line: `file.ext[TAGS]: F:... | R:... | A:... | S:...` */
export const ENTRY_RE = /^([^|\[\]\n#]+?)\[([A-Z0-9]{3,4})\]: F:(.+?) \| R:(.*?) \| A:(.*?) \| S:(.*)$/

/** Regex for a directory section header: `===relative/dir/===` (root is `===./===`). */
export const SECTION_RE = /^===(.+?)===$/

/** Parse the Root manifest header lines into a map. */
export function parseRootManifest(text) {
  const header = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^#([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (match) header[match[1]] = match[2]
  }
  return header
}

/** Whether the Meta declares a `#[Tag dictionary: <kind>]` section. */
export function hasDictionarySection(metaText, kind) {
  return new RegExp(`^#\\[Tag dictionary:\\s*${kind}\\]`, 'm').test(metaText)
}

/**
 * Parse the tag dictionary from a Meta volume, scoped by kind.
 * Meta sections start at `#[Tag dictionary: code]` / `#[Tag dictionary: database]`;
 * when no section markers exist at all (older metas), every #A/#B/#C/#E line is
 * treated as belonging to the requested kind. Returns dimension letter -> Set of codes.
 */
export function parseTagDictionary(metaText, kind = 'code') {
  const dict = new Map()
  let current = null
  let sawMarker = false
  for (const line of metaText.split(/\r?\n/)) {
    const marker = /^#\[Tag dictionary:\s*(\w+)\]/.exec(line)
    if (marker) {
      sawMarker = true
      current = marker[1] === kind ? dict : null
      continue
    }
    const match = /^#([ABCE])\s[^:]*:\s*(.+)$/.exec(line)
    if (!match) continue
    if (sawMarker && current === null) continue
    const codes = new Set()
    for (const token of match[2].split(/\s+/)) {
      const code = /^[A-Z0-9]-/.exec(token)
      if (code) codes.add(token[0])
    }
    dict.set(match[1], codes)
  }
  return dict
}

/** Parse the S-quota line from a Meta volume: importance digit -> max characters. */
export function parseSQuota(metaText) {
  const defaults = { 9: 600, 8: 600, 7: 200, 6: 200, 5: 200, 4: 200, 3: 50, 2: 50, 1: 50 }
  const match = /^#S-Quota:\s*(.+)$/m.exec(metaText)
  if (!match) return defaults
  const quota = {}
  for (const part of match[1].split(/\s+/)) {
    const range = /^C(\d)-(\d)<=(\d+)$/.exec(part)
    if (!range) continue
    for (let digit = Number(range[1]); digit >= Number(range[2]); digit--) quota[digit] = Number(range[3])
  }
  return Object.keys(quota).length > 0 ? quota : defaults
}

/**
 * Validate one candidate entry against the Meta rules.
 * @param context { dictionary, quota, fileExists, tableExists }
 *   fileExists(relativePath) -> boolean for code: R references (and code-volume paths);
 *   tableExists(schemaTable) -> boolean for database: R references.
 * @returns array of error strings; empty means valid.
 */
export function validateEntry({ path, tags, f, r, a, s }, { dictionary, quota, fileExists, tableExists }) {
  const errors = []
  const posix = String(path).replaceAll('\\', '/')
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) errors.push('path must be relative to the project root')
  if (posix.split('/').some(part => part === '..' || part === '.')) errors.push('path must not traverse outside the project root')
  if (fileExists && !fileExists(posix)) errors.push(`file does not exist in the project: ${posix}`)

  if (!/^[A-Z0-9]{3,4}$/.test(tags ?? '')) {
    errors.push(`tags "${tags}" must be 3-4 compact codes (Layer+Module+Importance+optional Scale), e.g. CG9 or ET8`)
  } else {
    const layer = dictionary.get('A')
    const module = dictionary.get('B')
    const scale = dictionary.get('E')
    if (layer && !layer.has(tags[0])) errors.push(`tag position 1 "${tags[0]}" is not in the #A Layer dictionary`)
    if (module && !module.has(tags[1])) errors.push(`tag position 2 "${tags[1]}" is not in the #B Module dictionary`)
    if (!/[1-9]/.test(tags[2])) errors.push(`tag position 3 "${tags[2]}" must be an importance digit 1-9`)
    if (tags.length === 4 && scale && !scale.has(tags[3])) errors.push(`tag position 4 "${tags[3]}" is not in the #E Scale dictionary`)
  }

  if (!f || f.trim().length === 0) errors.push('F (function) must describe the object responsibility')
  if (s && quota) {
    const importance = Number((tags ?? '')[2] ?? 5)
    const limit = quota[importance] ?? 200
    if (s.length > limit) errors.push(`S is ${s.length} chars, over the quota ${limit} for importance ${importance}`)
  }
  if (r && r !== '-') {
    for (const ref of r.split(',').map(item => item.trim()).filter(Boolean)) {
      const codeRef = /^code:(.+)$/.exec(ref)
      const dbRef = /^database:(.+)$/.exec(ref)
      if (!codeRef && !dbRef) {
        errors.push(`R reference "${ref}" must be code:<relative-path>, database:<schema.table>, or "-" for none`)
        continue
      }
      if (codeRef && fileExists && !fileExists(codeRef[1])) errors.push(`R reference target does not exist: ${ref}`)
      if (dbRef && tableExists && !tableExists(dbRef[1])) errors.push(`R reference target table does not exist in the schema evidence: ${ref}`)
    }
  }
  return errors
}

/** Canonical serialized entry line for a path. */
export function serializeEntry({ path, tags, f, r, a, s }) {
  const basename = String(path).replaceAll('\\', '/').split('/').pop()
  return `${basename}[${tags}]: F:${f} | R:${r || '-'} | A:${a || '-'} | S:${s || '-'}`
}

export function entryHash(entry) {
  return createHash('sha256').update(serializeEntry(entry), 'utf8').digest('hex')
}

/** Section directory for a file path ('.' for root). */
export function sectionOf(path) {
  const posix = String(path).replaceAll('\\', '/')
  const index = posix.lastIndexOf('/')
  return index === -1 ? '.' : posix.slice(0, index)
}

/**
 * Parse a Code volume into sections with entries and preserved unknown lines.
 * @returns { sections: [{ dir, entries: [{ path, tags, f, r, a, s, line }], extras: string[] }], parseErrors: string[] }
 */
export function parseCodeVolume(text) {
  const sections = []
  const parseErrors = []
  let current = { dir: '.', entries: [], extras: [] }
  sections.push(current)
  let lineNumber = 0
  for (const raw of text.split(/\r?\n/)) {
    lineNumber++
    if (raw.trim().length === 0) continue
    const sectionMatch = SECTION_RE.exec(raw)
    if (sectionMatch) {
      const dir = sectionMatch[1].replace(/\/+$/, '') || '.'
      // Reuse the still-empty implicit first section instead of stacking a
      // duplicate, and merge into an existing section of the same dir.
      const existing = sections.find(candidate => candidate.dir === dir)
      if (current.entries.length === 0 && current.extras.length === 0 && current === sections[0] && sections[0].dir === '.') {
        if (existing !== undefined && existing !== current) {
          sections.splice(sections.indexOf(current), 1)
          current = existing
        } else {
          current.dir = dir
        }
      } else {
        if (existing !== undefined) current = existing
        else {
          current = { dir, entries: [], extras: [] }
          sections.push(current)
        }
      }
      continue
    }
    if (raw.startsWith('#')) continue
    const entryMatch = ENTRY_RE.exec(raw)
    if (!entryMatch) {
      parseErrors.push(`line ${lineNumber}: unrecognized line preserved as-is: ${raw.slice(0, 80)}`)
      current.extras.push(raw)
      continue
    }
    current.entries.push({
      basename: entryMatch[1].trim(),
      tags: entryMatch[2],
      f: entryMatch[3],
      r: entryMatch[4],
      a: entryMatch[5],
      s: entryMatch[6],
      line: lineNumber,
    })
  }
  return { sections, parseErrors }
}

/** Resolve the full path (section + basename) for every parsed entry. */
export function entryPath(section, entry) {
  return section.dir === '.' ? entry.file ?? entry.basename : `${section.dir}/${entry.basename}`
}

/**
 * Upsert entries into parsed sections, keyed by full path.
 * @param sections parsed sections (mutated)
 * @param updates Map<posixPath, entry fields>
 * @returns list of upserted paths
 */
export function upsertEntries(sections, updates) {
  const index = new Map()
  for (const section of sections) {
    for (const entry of section.entries) {
      const full = `${section.dir === '.' ? '' : `${section.dir}/`}${entry.basename}`
      index.set(full, { section, entry })
    }
  }
  for (const [path, fields] of updates) {
    const existing = index.get(path)
    const basename = path.split('/').pop()
    const dir = sectionOf(path)
    if (existing) {
      Object.assign(existing.entry, { basename, ...fields })
      if (existing.section.dir !== dir) {
        existing.section.entries.splice(existing.section.entries.indexOf(existing.entry), 1)
        let target = sections.find(candidate => candidate.dir === dir)
        if (!target) {
          target = { dir, entries: [], extras: [] }
          sections.push(target)
        }
        target.entries.push(existing.entry)
        index.set(path, { section: target, entry: existing.entry })
      }
    } else {
      let target = sections.find(candidate => candidate.dir === dir)
      if (!target) {
        target = { dir, entries: [], extras: [] }
        sections.push(target)
      }
      const entry = { basename, ...fields }
      target.entries.push(entry)
      index.set(path, { section: target, entry })
    }
  }
  return [...updates.keys()]
}

/** Remove entries by full path. @returns removed paths */
export function removeEntries(sections, paths) {
  const wanted = new Set(paths)
  const removed = []
  for (const section of sections) {
    section.entries = section.entries.filter(entry => {
      const full = `${section.dir === '.' ? '' : `${section.dir}/`}${entry.basename}`
      if (wanted.has(full)) {
        removed.push(full)
        return false
      }
      return true
    })
  }
  return removed
}

/** Serialize parsed sections back into a volume text with the given header line. */
export function serializeVolume(sections, headerLine = '#COGNITION-CODE-VOLUME: 1') {
  const lines = [headerLine, '']
  const ordered = [...sections].sort((a, b) => (a.dir === '.' ? -1 : b.dir === '.' ? 1 : a.dir < b.dir ? -1 : 1))
  for (const section of ordered) {
    if (section.entries.length === 0 && section.extras.length === 0) continue
    lines.push(`===${section.dir === '.' ? './' : `${section.dir}/`}===`)
    const sorted = [...section.entries].sort((a, b) => (a.basename < b.basename ? -1 : 1))
    for (const entry of sorted) {
      lines.push(serializeEntry({
        path: `${section.dir === '.' ? '' : `${section.dir}/`}${entry.basename}`,
        tags: entry.tags,
        f: entry.f,
        r: entry.r,
        a: entry.a,
        s: entry.s,
      }))
    }
    for (const extra of section.extras) lines.push(extra)
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** Serialize the Code volume (root sections = directories). */
export function serializeCodeVolume(sections) {
  return serializeVolume(sections, '#COGNITION-CODE-VOLUME: 1')
}

/** Serialize the Database volume (root sections = schema/table, dir = schema). */
export function serializeDatabaseVolume(sections) {
  return serializeVolume(sections, '#COGNITION-DATABASE-VOLUME: 1')
}

/** Atomic text-file write: temp file in the same directory, then rename over the target. */
export async function atomicWriteText(file, text) {
  const { writeFile, rename, mkdir } = await import('node:fs/promises')
  const { dirname, join } = await import('node:path')
  await mkdir(dirname(file), { recursive: true })
  const temp = join(dirname(file), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
  await writeFile(temp, text, 'utf8')
  await rename(temp, file)
}
