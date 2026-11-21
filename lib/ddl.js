/**
 * Schema evidence extractor: parse `CREATE TABLE` DDL from a mysqldump /
 * pg_dump / hand-written .sql text file into a structured, evidence-shaped
 * JSON document. The parser handles the common dialect surface (backtick and
 * double-quote identifiers, MySQL column COMMENT / ENGINE, PostgreSQL types,
 * PRIMARY KEY / FOREIGN KEY / UNIQUE / KEY / INDEX constraints) and reports
 * everything it could not parse instead of silently dropping it.
 * @module
 */

import { createHash } from 'node:crypto'

/**
 * Parse DDL text into schema evidence.
 * @param text full .sql dump text
 * @param options { sourceId, engine } engine is informational ('mysql' | 'postgresql' | 'unknown')
 * @returns { engine, sourceId, importedAt, dumpSha256, tables: [{ name, schema, columns, primaryKey, foreignKeys, uniques, indexes, comment }], parseWarnings: string[], tablesSeen: number }
 */
export function parseDdl(text, options = {}) {
  const warnings = []
  const tables = []
  const stripped = stripComments(text)
  let cursor = 0
  const createRe = /create\s+(?:or\s+replace\s+)?table\s+(?:if\s+not\s+exists\s+)?/gi
  for (;;) {
    const match = createRe.exec(stripped)
    if (match === undefined || match === null) break
    cursor = match.index + match[0].length
    const parsed = parseOneTable(stripped, cursor, warnings)
    if (parsed === undefined) break
    tables.push(parsed.table)
    createRe.lastIndex = parsed.end
  }
  if (tables.length === 0) {
    warnings.push('no CREATE TABLE statement recognized in the dump; supported input is plain DDL text (mysqldump/pg_dump output)')
  }
  // pg_dump emits constraints and indexes as separate statements after the
  // CREATE TABLE body. Fold them into the evidence: ALTER TABLE x ADD
  // CONSTRAINT ... PRIMARY KEY / UNIQUE / FOREIGN KEY, and CREATE [UNIQUE]
  // INDEX ... ON x. Table references may be bare, schema-qualified, or quoted;
  // unquote() normalizes them before the name maps are consulted.
  const byName = new Map(tables.map(table => [table.name, table]))
  const byQualified = new Map(tables.map(table => [table.schema !== undefined ? table.schema + '.' + table.name : table.name, table]))
  const lookup = (raw) => {
    const name = unquote(String(raw).trim())
    return byQualified.get(name) ?? byName.get(name) ?? byName.get(name.split('.').pop())
  }
  const alterRe = /alter\s+table\s+(?:only\s+)?([^\s;]+)\s+([\s\S]*?);/gi
  for (const match of stripped.matchAll(alterRe)) {
    const target = lookup(match[1])
    if (target === undefined) continue
    const body = match[2]
    for (const action of body.split(/\s*,\s*(?=(?:add|drop)\b)/i)) {
      const addConstraint = /add\s+constraint\s+(\S+)\s+(primary\s+key|unique|foreign\s+key)\s*\(([^)]*)\)(\s+references\s+([^\s(]+)\s*\(([^)]*)\))?/i.exec(action)
      const addCheck = /add\s+(?:constraint\s+(\S+)\s+)?check\s*\(([\s\S]*)\)\s*$/i.exec(action)
      const addBare = /add\s+(primary\s+key|unique|foreign\s+key|index|key)\s*\(?\s*([^)]*?)\s*\)?$/i.exec(action)
      if (addConstraint !== null) {
        const kind = addConstraint[2].toUpperCase()
        if (kind.startsWith('PRIMARY')) target.primaryKey.push(...parseColumnList('PRIMARY KEY (' + addConstraint[3] + ')'))
        else if (kind === 'UNIQUE') target.uniques.push(parseColumnList('UNIQUE (' + addConstraint[3] + ')'))
        else if (addConstraint[5] !== undefined) {
          const fk = parseForeignKey('FOREIGN KEY (' + addConstraint[3] + ') REFERENCES ' + addConstraint[5] + ' (' + (addConstraint[6] ?? '') + ')')
          if (fk !== undefined) target.foreignKeys.push(fk)
        }
      } else if (addCheck !== null) {
        const check = parseCheckClause('CHECK (' + addCheck[2] + ')')
        if (check !== undefined) {
          check.name = addCheck[1] !== undefined ? unquote(addCheck[1]) : check.name
          target.checks.push(check)
        }
      } else if (addBare !== null) {
        const kind = addBare[1].toUpperCase()
        if (kind.startsWith('PRIMARY')) target.primaryKey.push(...parseColumnList('PRIMARY KEY (' + addBare[2] + ')'))
        else if (kind === 'UNIQUE') target.uniques.push(parseColumnList('UNIQUE (' + addBare[2] + ')'))
        else if (kind === 'KEY' || kind === 'INDEX') {
          const cols = parseColumnList('INDEX (' + addBare[2].replace(/^\S+\s+/, '') + ')')
          if (cols.length > 0) target.indexes.push(cols)
        }
        else if (kind.startsWith('FOREIGN')) {
          warnings.push('FOREIGN KEY on ' + target.name + ' without a recognized references clause was skipped')
        }
      }
    }
  }
  const indexRe = /create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([^\s(]+)\s+on\s+([^\s(]+)\s*(?:using\s+\w+\s*)?\(([^)]+)\)/gi
  for (const match of stripped.matchAll(indexRe)) {
    const target = lookup(match[3])
    if (target === undefined) continue
    const cols = parseColumnList('INDEX (' + match[4] + ')')
    if (cols.length === 0) continue
    if (match[1] !== undefined) target.uniques.push(cols)
    else target.indexes.push(cols)
  }
  return {
    engine: options.engine ?? 'unknown',
    sourceId: options.sourceId ?? 'primary',
    importedAt: new Date().toISOString(),
    dumpSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    tables,
    parseWarnings: warnings,
    tablesSeen: tables.length,
  }
}

/** Remove -- / # line comments and /* block comments (outside string literals is not tracked: dump files rarely embed them in DDL). */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map(line => line.replace(/(^|\s)--.*$/, '$1').replace(/(^|\s)#(?!\d).*$/, '$1'))
    .join('\n')
}

/**
 * Parse one CREATE TABLE starting just after the table keyword.
 * @returns { table, end } or undefined when the statement is malformed.
 */
function parseOneTable(text, start, warnings) {
  // Table name: identifier or schema.identifier, optionally quoted with ` " [.
  const nameMatch = /^\s*(?:(`[^`]+`|"[^"]+"|\[[^\]]+\]|[A-Za-z_][\w$]*))\s*(?:\.\s*(?:(`[^`]+`|"[^"]+"|\[[^\]]+\]|[A-Za-z_][\w$]*)))?\s*\(/.exec(text.slice(start))
  if (nameMatch === null) {
    warnings.push(`could not read a table name at offset ${start}`)
    return undefined
  }
  const parts = nameMatch.slice(1).filter(Boolean).map(unquote)
  const table = {
    name: parts[parts.length - 1],
    schema: parts.length > 1 ? parts[0] : undefined,
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    uniques: [],
    indexes: [],
    checks: [],
    comment: undefined,
  }

  // Balanced-paren scan for the body.
  let depth = 0
  let bodyStart = -1
  let bodyEnd = -1
  for (let index = start + nameMatch[0].length - 1; index < text.length; index++) {
    const char = text[index]
    if (char === '(') {
      depth++
      if (bodyStart === -1) bodyStart = index + 1
    } else if (char === ')') {
      depth--
      if (depth === 0) {
        bodyEnd = index
        break
      }
    }
  }
  if (bodyStart === -1 || bodyEnd === -1) {
    warnings.push(`unbalanced parentheses for table ${table.name}`)
    return undefined
  }
  const body = text.slice(bodyStart, bodyEnd)
  const tail = text.slice(bodyEnd, Math.min(text.length, bodyEnd + 500))

  // Split top-level commas.
  const items = []
  let current = ''
  let itemDepth = 0
  for (const char of body) {
    if (char === '(') itemDepth++
    if (char === ')') itemDepth--
    if (char === ',' && itemDepth === 0) {
      items.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim().length > 0) items.push(current.trim())

  for (const item of items) {
    const upper = item.toUpperCase()
    if (upper.startsWith('PRIMARY KEY')) {
      table.primaryKey.push(...parseColumnList(item))
    } else if (upper.startsWith('FOREIGN KEY') || (/^CONSTRAINT\b/.test(upper) && /FOREIGN KEY/.test(upper))) {
      const fk = parseForeignKey(item)
      if (fk !== undefined) table.foreignKeys.push(fk)
    } else if (upper.startsWith('UNIQUE') || (/^CONSTRAINT\b/.test(upper) && /UNIQUE/.test(upper))) {
      const unique = parseColumnList(item.replace(/^CONSTRAINT\s+\S+\s+/i, ''))
      if (unique.length > 0) table.uniques.push(unique)
    } else if (/^(KEY|INDEX)\b/.test(upper)) {
      const indexCols = parseColumnList(item)
      if (indexCols.length > 0) table.indexes.push(indexCols)
    } else if (upper.startsWith('CONSTRAINT') || upper.startsWith('CHECK')) {
      const check = parseCheckClause(item)
      if (check !== undefined) table.checks.push(check)
    } else {
      const column = parseColumn(item)
      if (column !== undefined) table.columns.push(column)
    }
  }

  // MySQL table options after the closing paren: COMMENT='...' ENGINE=...
  const commentMatch = /comment\s*=?\s*'((?:[^']|'')*)'/i.exec(tail)
  if (commentMatch !== null) table.comment = commentMatch[1].replaceAll("''", "'")
  const engineMatch = /engine\s*=?\s*(\w+)/i.exec(tail)
  if (engineMatch !== null) table.engine = engineMatch[1].toLowerCase()

  // Statement end: next ';' or end of text (mysqldump may use /*!40101 ... */ tails, already stripped of block comments).
  let end = text.indexOf(';', bodyEnd)
  if (end === -1) end = text.length
  return { table, end: end + 1 }
}

/** Unquote a backtick/double-quote/bracket identifier. */
function unquote(raw) {
  if (raw.startsWith('`') && raw.endsWith('`')) return raw.slice(1, -1)
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1)
  if (raw.startsWith('[') && raw.endsWith(']')) return raw.slice(1, -1)
  return raw
}

/** Extract the parenthesized column list of a table constraint. */
function parseColumnList(item) {
  const match = /\(([^()]*)\)/.exec(item)
  if (match === null) return []
  return match[1]
    .split(',')
    .map(part => unquote(part.trim().split(/\s+/)[0]))
    .filter(Boolean)
}

/**
 * Parse a CHECK constraint clause into { name?, expression }.
 * @param item full clause text containing CHECK (...)
 * @returns { name, expression } or undefined when no CHECK is present
 */
function parseCheckClause(item) {
  const match = /check\s*\(([\s\S]+)\)\s*$/i.exec(item.trim())
  if (match === null) return undefined
  const named = /constraint\s+(\S+)\s+check/i.exec(item)
  return {
    name: named !== null ? unquote(named[1]) : undefined,
    expression: match[1].trim(),
  }
}

/** Parse a FOREIGN KEY clause into { columns, refTable, refColumns }. */
function parseForeignKey(item) {
  const columns = parseColumnList(item)
  const refMatch = /references\s+(?:(`[^`]+`|"[^"]+"|\[[^\]]+\]|[A-Za-z_][\w$]*)\s*\.\s*)?(?:(`[^`]+`|"[^"]+"|\[[^\]]+\]|[A-Za-z_][\w$]*))\s*\(([^()]*)\)/i.exec(item)
  if (refMatch === null) {
    return { columns, refTable: undefined, refColumns: [] }
  }
  const schema = refMatch[1] !== undefined ? unquote(refMatch[1]) : undefined
  const refTable = unquote(refMatch[2])
  const refColumns = refMatch[3].split(',').map(part => unquote(part.trim())).filter(Boolean)
  return { columns, refTable: schema !== undefined ? `${schema}.${refTable}` : refTable, refColumns }
}

/** Parse one column definition into { name, type, nullable, comment }. */
function parseColumn(item) {
  const nameMatch = /^\s*(?:(`[^`]+`|"[^"]+"|\[[^\]]+\]|[A-Za-z_][\w$]*))\s+([^\s(]+(?:\([^)]*\))?)/.exec(item)
  if (nameMatch === null) return undefined
  const name = unquote(nameMatch[1])
  const type = nameMatch[2].toLowerCase()
  const upper = item.toUpperCase()
  const nullable = !/\bNOT\s+NULL\b/.test(upper)
  const commentMatch = /comment\s*'((?:[^']|'')*)'/i.exec(item)
  return {
    name,
    type,
    nullable,
    ...(commentMatch !== null ? { comment: commentMatch[1].replaceAll("''", "'") } : {}),
  }
}
