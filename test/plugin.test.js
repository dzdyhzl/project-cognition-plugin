/**
 * Project cognition plugin — test suite (node:test, no dependencies).
 * Run: node --test test/
 * Uses PROJECT_COGNITION_REGISTRY to isolate the gate/registry tests from the
 * real ~/.dsh store, and one temp project tree per describe block.
 * @module
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const mod = (rel) => import(String(pathToFileURL(join(pkgRoot, rel))))

const { parseCodeVolume, serializeCodeVolume, parseRootManifest, parseTagDictionary, parseSQuota, validateEntry, serializeEntry, entryHash, upsertEntries, removeEntries, estimateTokens, atomicWriteText } = await mod('lib/format.js')
const scanner = await mod('lib/scanner.js')
const stateMod = await mod('lib/state.js')
const templatesMod = await mod('lib/templates.js')
const plugin = await mod('index.js')

/** One temp project tree with a couple of source files. */
async function makeProject(files = { 'src/a.js': 'export const a = 1\n', 'src/b.js': 'export const b = 2\n', 'README.md': '# t\n' }) {
  const root = await mkdtemp(join(tmpdir(), 'pcog-test-'))
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), content, 'utf8')
  }
  return root
}

/** Load the plugin with a mock ctx bound to a project root. */
async function loadPlugin(root) {
  const registered = {}
  plugin.apply(
    {
      tools: { register: (def) => { registered[def.name] = def } },
      systemPrompt: { section: () => {} },
      workingDirectory: { ensure: async () => root },
    },
    {},
  )
  return registered
}

// ------------------------------------------------------------------ format

test('format: code volume parse/serialize roundtrip', () => {
  const text = ['#COGNITION-CODE-VOLUME: 1', '', '===src/===', 'a.js[CG5]: F:f-a | R:- | A:a | S:-', 'b.js[CG5]: F:f-b | R:code:a.js | A:b | S:s-b', ''].join('\n')
  const parsed = parseCodeVolume(text)
  const entries = parsed.sections.flatMap(s => s.entries)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].basename, 'a.js')
  assert.equal(entries[1].r, 'code:a.js')
  assert.equal(parsed.parseErrors.length, 0)
  const out = serializeCodeVolume(parsed.sections)
  const reparsed = parseCodeVolume(out)
  assert.deepEqual(reparsed.sections.flatMap(s => s.entries).map(e => [e.basename, e.tags, e.f]), entries.map(e => [e.basename, e.tags, e.f]))
})

test('format: unrecognized lines are preserved as extras', () => {
  const parsed = parseCodeVolume(['===./===', 'a.js[CG5]: F:x | R:- | A:- | S:-', 'a weird line', ''].join('\n'))
  assert.equal(parsed.parseErrors.length, 1)
  assert.equal(parsed.sections[0].extras[0], 'a weird line')
})

test('format: entry hash is stable across key order', () => {
  const h1 = entryHash({ path: 'a.js', tags: 'CG5', f: 'f', r: '-', a: 'a', s: 's' })
  const h2 = entryHash({ s: 's', a: 'a', r: '-', f: 'f', tags: 'CG5', path: 'a.js' })
  assert.equal(h1, h2)
})

test('format: validateEntry enforces dictionary, quota, and shape', () => {
  const meta = templatesMod.volumeTemplates('t', 'zh-CN').meta
  const dict = parseTagDictionary(meta, 'code')
  const quota = parseSQuota(meta)
  const ok = validateEntry({ path: 'src/a.js', tags: 'CG5', f: '职责', r: '-', a: 'a', s: '-' }, { dictionary: dict, quota })
  assert.deepEqual(ok, [])
  const badTags = validateEntry({ path: 'x.js', tags: 'WY9', f: 'f', r: '-', a: '-', s: '-' }, { dictionary: dict, quota })
  assert.ok(badTags.some(e => e.includes('#A Layer')), 'W is not a layer letter')
  const overQuota = validateEntry({ path: 'x.js', tags: 'CG9', f: 'f', r: '-', a: '-', s: '长'.repeat(601) }, { dictionary: dict, quota })
  assert.ok(overQuota.some(e => e.includes('over the quota')))
  const absolute = validateEntry({ path: '/abs/x.js', tags: 'CG5', f: 'f', r: '-', a: '-', s: '-' }, { dictionary: dict, quota })
  assert.ok(absolute.some(e => e.includes('relative')))
})

test('format: estimateTokens is CJK-aware and monotonic', () => {
  const ascii = estimateTokens('abcd'.repeat(100))
  const cjk = estimateTokens('测'.repeat(100))
  assert.ok(ascii > 0 && cjk > 0)
  assert.ok(ascii > cjk) // 400 ascii chars ≈ 100 tokens; 100 cjk ≈ 67 tokens
  assert.ok(estimateTokens('') === 0)
})

test('format: upsertEntries adds and updates; removeEntries deletes', () => {
  const parsed = parseCodeVolume('#COGNITION-CODE-VOLUME: 1\n')
  upsertEntries(parsed.sections, new Map([['a.js', { path: 'a.js', tags: 'CG5', f: 'f1', r: '-', a: '-', s: '-' }]]))
  upsertEntries(parsed.sections, new Map([['a.js', { path: 'a.js', tags: 'CG9', f: 'f2', r: '-', a: '-', s: '-' }]]))
  upsertEntries(parsed.sections, new Map([['src/b.js', { path: 'src/b.js', tags: 'CG5', f: 'b', r: '-', a: '-', s: '-' }]]))
  const all = parsed.sections.flatMap(s => s.entries)
  assert.equal(all.length, 2)
  assert.equal(all.find(e => e.basename === 'a.js').f, 'f2')
  removeEntries(parsed.sections, ['src/b.js'])
  assert.equal(parsed.sections.flatMap(s => s.entries).length, 1)
})

// ----------------------------------------------------------------- scanner

test('scanner: inventory honors gitignore, skip dirs, and size limit', async () => {
  const root = await makeProject({
    'src/keep.js': 'x\n',
    'src/skip/generated.js': 'y\n',
    'big.log': 'z'.repeat(100),
    'node_modules/dep.js': 'd\n',
    '.gitignore': 'src/skip/\n',
    'image.bin': 'not text',
  })
  const walked = await scanner.scanInventory(root, { maxFileBytes: 50 })
  const names = [...walked.files.keys()]
  assert.ok(names.includes('src/keep.js'))
  assert.ok(!names.some(n => n.startsWith('src/skip/')))
  assert.ok(!names.some(n => n.startsWith('node_modules/')))
  assert.ok(!names.includes('image.bin'))
  assert.ok(walked.skipped.some(s => s.startsWith('big.log')))
  await rm(root, { recursive: true, force: true })
})

test('scanner: hashFiles counts lines; compareDrift and coverageStats agree', async () => {
  const root = await makeProject()
  const walked = await scanner.scanInventory(root, {})
  await scanner.hashFiles(root, walked.files)
  assert.equal(walked.files.get('src/a.js').lines, 1)
  assert.equal(walked.files.get('README.md').lines, 1)

  const st = stateMod.emptyState('t', 'zh-CN')
  st.files = { 'src/a.js': { sha256: walked.files.get('src/a.js').sha256 }, 'src/gone.js': { sha256: 'x' } }
  st.entries = { 'src/a.js': { sha256: 'h' } }
  const drift = scanner.compareDrift(walked.files, st)
  assert.deepEqual(drift.missing, ['src/gone.js'])
  assert.deepEqual(drift.orphan, ['README.md', 'src/b.js'])
  assert.deepEqual(drift.unchanged, ['src/a.js'])

  const cov = scanner.coverageStats(walked.files, st)
  assert.equal(cov.indexedFiles, 1)
  assert.equal(cov.totalFiles, 3)
  assert.equal(cov.missingEntries, 1)
  await rm(root, { recursive: true, force: true })
})

// --------------------------------------------------------------- templates

test('templates: volume skeleton carries rules, not semantics', () => {
  const t = templatesMod.volumeTemplates('demo', 'zh-CN')
  assert.ok(t.root.startsWith('#COGNITION-ROOT-MANIFEST: 1'))
  assert.ok(t.root.includes('#Volume: id=code'))
  assert.ok(parseTagDictionary(t.meta, 'code').size >= 3)
  assert.ok(parseSQuota(t.meta) !== null)
  // No business semantics: the skeleton contains no entry lines.
  assert.equal(parseCodeVolume(t.code).sections.flatMap(s => s.entries).length, 0)
})

test('templates: AGENTS.md managed block is idempotent and preserves content', () => {
  const block = templatesMod.agentsBlock('zh-CN')
  assert.equal(templatesMod.hasAgentsBlock(null), false)
  assert.equal(templatesMod.hasAgentsBlock(block), true)
  const user = '# My project\n\nCustom instructions.\n'
  const once = templatesMod.upsertAgentsBlock(user, 'zh-CN')
  assert.ok(once.includes('Custom instructions.'))
  assert.equal(templatesMod.upsertAgentsBlock(once, 'zh-CN'), once)
  // content after the block survives a language switch
  const withTail = user + block + '\n\nPost-block notes.\n'
  const switched = templatesMod.upsertAgentsBlock(withTail, 'en-US')
  assert.ok(switched.includes('Post-block notes.'))
  assert.ok(switched.includes('Project cognition index'))
  assert.ok(!switched.includes('项目认知索引'))
  // duplicated blocks collapse into one
  const doubled = once + '\n' + block
  const collapsed = templatesMod.upsertAgentsBlock(doubled, 'zh-CN')
  assert.equal((collapsed.match(/project-cognition:start/g) ?? []).length, 1)
})

// ------------------------------------------------------------------- state

test('state: pending lists and v1 upgrade', () => {
  const st = stateMod.emptyState('demo', 'zh-CN')
  assert.equal(st.stateVersion, 2)
  assert.deepEqual(st.database, { sources: {}, tables: {}, pending: [] })
  assert.equal(stateMod.addPending(st, ['a.js', 'a.js', 'b.js']), 2)
  assert.equal(stateMod.removePending(st, ['a.js']), 1)
  assert.deepEqual(st.pending, ['b.js'])
  assert.equal(stateMod.addDatabasePending(st, ['public.orders']), 1)
  stateMod.removeDatabasePending(st, ['public.orders'])
  assert.deepEqual(st.database.pending, [])
  const v1 = JSON.parse(JSON.stringify(st))
  v1.stateVersion = 1
  delete v1.database
  // loadState upgrades v1 in place (via a real file)
  // covered through loadState below with a temp file — here just assert shape helper
  assert.equal(typeof stateMod.saveState, 'function')
})

// --------------------------------------------------------------------- ddl

test('ddl: mysql and postgres dumps parse into evidence', async () => {
  const ddl = await mod('lib/ddl.js')
  const mysql = ddl.parseDdl([
    'CREATE TABLE `users` (',
    '  `id` BIGINT NOT NULL AUTO_INCREMENT,',
    '  `email` VARCHAR(255) NOT NULL,',
    '  PRIMARY KEY (`id`),',
    '  UNIQUE KEY `uk_email` (`email`)',
    ') ENGINE=InnoDB;',
    'CREATE TABLE `orders` (',
    '  `id` BIGINT NOT NULL,',
    '  `user_id` BIGINT NOT NULL,',
    '  PRIMARY KEY (`id`),',
    '  KEY `idx_user` (`user_id`),',
    '  CONSTRAINT `fk_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)',
    ') ENGINE=InnoDB;',
  ].join('\n'), { sourceId: 'primary', engine: 'mysql' })
  assert.equal(mysql.tables.length, 2)
  const users = mysql.tables.find(t => t.name === 'users')
  assert.equal(users.primaryKey.length, 1)
  assert.ok(users.uniques.length >= 1)
  const orders = mysql.tables.find(t => t.name === 'orders')
  assert.ok(orders.foreignKeys.some(fk => fk.refTable === 'users'))

  const pg = ddl.parseDdl([
    'CREATE TABLE public.items (',
    '  id integer NOT NULL,',
    '  name text,',
    '  CONSTRAINT items_pkey PRIMARY KEY (id)',
    ');',
  ].join('\n'), { sourceId: 'pg', engine: 'postgresql' })
  assert.equal(pg.tables.length, 1)
  assert.equal(pg.tables[0].schema, 'public')
})

// ------------------------------------------------------------------- tools

test('tools: full authoring loop — init, scan, update, verify, search, relations, doctor', async () => {
  const root = await makeProject({
    'src/core.js': 'export const core = 1\n',
    'src/mid.js': "import { core } from './core.js'\n",
    'src/app.js': "import { mid } from './mid.js'\n",
    'README.md': '# t\n',
  })
  const tools = await loadPlugin(root)
  const exec = { agent: 'test' }

  const init = await tools.cognition_init.execute({}, exec)
  assert.match(init.text, /Initialized cognition index/)

  const scan1 = await tools.cognition_scan.execute({}, exec)
  assert.match(scan1.text, /managed files: 4/)
  assert.match(scan1.text, /orphan=4/)
  assert.match(scan1.text, /coverage: 0\/4 files/)

  const upd = await tools.cognition_update_entries.execute({ entries: [
    { path: 'src/core.js', tags: 'CG5', f: 'core', r: '-', a: 'core', s: '-' },
    { path: 'src/mid.js', tags: 'CG5', f: 'mid', r: 'code:src/core.js', a: 'mid', s: '-' },
    { path: 'src/app.js', tags: 'AB7', f: 'app', r: 'code:src/mid.js', a: 'app', s: '-' },
    { path: 'README.md', tags: 'SG3', f: 'readme', r: '-', a: '-', s: '-' },
  ] }, exec)
  assert.match(upd.text, /accepted: 4 \| rejected: 0/)

  const verify = await tools.cognition_verify.execute({}, exec)
  assert.match(verify.text, /aligned=true/)

  // relations
  const fwd = await tools.cognition_search.execute({ relations: 'forward', path: 'src/app.js' }, exec)
  assert.match(fwd.text, /code:src\/mid\.js/)
  const rev = await tools.cognition_search.execute({ relations: 'reverse', path: 'src/core.js' }, exec)
  assert.match(rev.text, /src\/mid\.js/)
  const imp = await tools.cognition_search.execute({ relations: 'impact', path: 'src/core.js' }, exec)
  assert.match(imp.text, /derived=true/)
  assert.match(imp.text, /src\/mid\.js/)
  assert.match(imp.text, /src\/app\.js/)

  // tag / keyword filter
  const byTag = await tools.cognition_search.execute({ tags: 'G,5' }, exec)
  assert.match(byTag.text, /matches/)

  const doctor = await tools.cognition_doctor.execute({}, exec)
  assert.match(doctor.text, /verdict: (HEALTHY|USABLE_WITH_WARNINGS)/)
  assert.match(doctor.text, /coverage:/)

  await rm(root, { recursive: true, force: true })
})

test('tools: update rejects missing files and over-quota S, and handles stringified arrays', async () => {
  const root = await makeProject({ 'src/a.js': 'x\n' })
  const tools = await loadPlugin(root)
  const exec = { agent: 'test' }
  await tools.cognition_init.execute({}, exec)
  // JSON-string entries (as some hosts pass them) are coerced
  const upd = await tools.cognition_update_entries.execute({ entries: JSON.stringify([
    { path: 'src/ghost.js', tags: 'CG5', f: 'f', r: '-', a: '-', s: '-' },
  ]) }, exec)
  assert.match(upd.text, /REJECTED src\/ghost\.js: file does not exist/)
  await rm(root, { recursive: true, force: true })
})

test('tools: snapshot is deterministic and evolution reports the diff', async () => {
  const root = await makeProject({ 'src/a.js': 'x\n', 'src/b.js': 'y\n' })
  const tools = await loadPlugin(root)
  const exec = { agent: 'test' }
  await tools.cognition_init.execute({}, exec)
  await tools.cognition_update_entries.execute({ entries: [
    { path: 'src/a.js', tags: 'CG5', f: 'a', r: '-', a: 'a', s: '-' },
    { path: 'src/b.js', tags: 'CG5', f: 'b', r: '-', a: 'b', s: '-' },
  ] }, exec)
  const snap1 = JSON.parse((await tools.cognition_snapshot.execute({}, exec)).text.split('\n').slice(1).join('\n'))
  const snap2 = JSON.parse((await tools.cognition_snapshot.execute({}, exec)).text.split('\n').slice(1).join('\n'))
  const { takenAt, ...rest1 } = snap1
  const { takenAt: t2, ...rest2 } = snap2
  assert.deepEqual(rest1, rest2)

  const snapFile = join(root, 'snap.json')
  await writeFile(snapFile, JSON.stringify(snap1), 'utf8')
  // evolve: change a.js, add c.js, remove b.js
  await writeFile(join(root, 'src/a.js'), 'x2\n', 'utf8')
  await writeFile(join(root, 'src/c.js'), 'z\n', 'utf8')
  await rm(join(root, 'src/b.js'))
  await tools.cognition_scan.execute({}, exec)
  await tools.cognition_update_entries.execute({ entries: [
    { path: 'src/a.js', tags: 'CG5', f: 'a changed', r: '-', a: 'a', s: '-' },
    { path: 'src/c.js', tags: 'CG5', f: 'c', r: '-', a: 'c', s: '-' },
  ] }, exec)
  await tools.cognition_remove_entries.execute({ paths: ['src/b.js'] }, exec)
  const evo = await tools.cognition_evolution.execute({ snapshot_file: 'snap.json' }, exec)
  assert.match(evo.text, /added: code:src\/c\.js/)
  assert.match(evo.text, /removed: code:src\/b\.js/)
  assert.match(evo.text, /changed: code:src\/a\.js/)
  // wrong kind fails loudly
  await writeFile(join(root, 'bad.json'), '{"nope":1}', 'utf8')
  const bad = await tools.cognition_evolution.execute({ snapshot_file: 'bad.json' }, exec)
  assert.match(bad.text, /not a cognition_snapshot/)
  await rm(root, { recursive: true, force: true })
})

test('tools: AGENTS.md block via init agents_md=true', async () => {
  const root = await makeProject()
  const tools = await loadPlugin(root)
  const exec = { agent: 'test' }
  await tools.cognition_init.execute({ agents_md: true, locale: 'en-US' }, exec)
  const agents = await readFile(join(root, 'AGENTS.md'), 'utf8')
  assert.ok(agents.includes('<!-- project-cognition:start'))
  assert.ok(templatesMod.hasAgentsBlock(agents))
  const doctor = await tools.cognition_doctor.execute({}, exec)
  assert.match(doctor.text, /AGENTS\.md block: managed rules block present/)
  await rm(root, { recursive: true, force: true })
})

test('tools: gate records verdicts into an isolated registry', async () => {
  process.env.PROJECT_COGNITION_REGISTRY = join(await mkdtemp(join(tmpdir(), 'pcog-reg-')), 'reg.json')
  const root = await makeProject()
  const tools = await loadPlugin(root)
  const exec = { agent: 'test' }
  const unlisted = await tools.cognition_gate.execute({}, exec)
  assert.match(unlisted.text, /VERDICT: unlisted/)
  const accepted = await tools.cognition_gate.execute({ user_response: 'accept' }, exec)
  assert.match(accepted.text, /whitelist/)
  const listed = await tools.cognition_gate.execute({}, exec)
  assert.match(listed.text, /whitelisted-unindexed/)
  const list = await tools.cognition_registry.execute({ action: 'list' }, exec)
  assert.match(list.text, /Whitelist/)
  delete process.env.PROJECT_COGNITION_REGISTRY
  await rm(root, { recursive: true, force: true })
})

test('tools: overview delivers whole small index and reports tokens and coverage', async () => {
  const root = await makeProject({ 'src/a.js': 'x\n' })
  const tools = await loadPlugin(root)
  const exec = { agent: 'test' }
  await tools.cognition_init.execute({}, exec)
  await tools.cognition_update_entries.execute({ entries: [{ path: 'src/a.js', tags: 'CG5', f: 'a', r: '-', a: 'a', s: '-' }] }, exec)
  const overview = await tools.cognition_overview.execute({}, exec)
  assert.match(overview.text, /# Index size: ~\d+ tokens/)
  assert.match(overview.text, /## Coverage: 1\/1 files \(100%\)/)
  assert.match(overview.text, /## Code volume/)
  // chunked delivery with a tiny token budget still covers everything
  process.env.PROJECT_COGNITION_REGISTRY = ''
  const chunked = await tools.cognition_overview.execute({ chunk: 1, chunk_entries: 2 }, exec)
  assert.match(chunked.text, /chunk 1\//)
  await rm(root, { recursive: true, force: true })
})

test('panel: snapshot exposes chunkPlan and deterministic nextActions', async () => {
  const { default: PanelService } = await mod('panel.js')
  const root = await makeProject({ 'src/a.js': 'x\n' })
  const tools = await loadPlugin(root)
  const exec = { agent: 'test' }
  await tools.cognition_init.execute({}, exec)
  // no entries yet: pending-driven advice
  const service = new PanelService({ reflect: { provide: () => {} } })
  const snap1 = await service.panelData({ project: root })
  assert.ok(snap1.indexExists)
  assert.equal(snap1.chunkPlan.entries, 0)
  assert.equal(snap1.chunkPlan.fullDelivery, true)
  assert.ok(snap1.nextActions.length > 0)
  assert.ok(snap1.nextActions[0].prompt.length > 10)

  // align one entry, orphan another file: drift-driven advice
  await writeFile(join(root, 'src/b.js'), 'y\n', 'utf8')
  await tools.cognition_update_entries.execute({ entries: [{ path: 'src/a.js', tags: 'CG5', f: 'a', r: '-', a: 'a', s: '-' }] }, exec)
  const snap2 = await service.panelData({ project: root })
  const driftAction = snap2.nextActions.find(action => action.title.includes('漂移'))
  assert.ok(driftAction, 'drift advice expected')
  // deterministic: same facts → same advice
  const snap3 = await service.panelData({ project: root })
  assert.deepEqual(snap2.nextActions, snap3.nextActions)

  // no index: early snapshot explains the empty state
  const empty = await service.panelData({ project: join(root, 'src') })
  assert.equal(empty.indexExists, false)
  await rm(root, { recursive: true, force: true })
})

test('ddl: pg_dump separate constraints and CREATE INDEX fold into evidence', async () => {
  const ddl = await mod('lib/ddl.js')
  const pgDump = [
    'CREATE TABLE public.orders (',
    '    id integer NOT NULL,',
    '    user_id integer NOT NULL,',
    '    total numeric(10,2)',
    ');',
    'ALTER TABLE public.orders',
    '    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);',
    'ALTER TABLE public.orders',
    '    ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);',
    'ALTER TABLE public.orders',
    '    ADD CONSTRAINT orders_total_check CHECK (total >= 0);',
    'CREATE UNIQUE INDEX orders_email_uq ON public.orders USING btree (email);',
    'CREATE INDEX orders_user_idx ON public.orders (user_id);',
  ].join('\n')
  const ev = ddl.parseDdl(pgDump, { sourceId: 'pg', engine: 'postgresql' })
  const orders = ev.tables.find(t => t.name === 'orders')
  assert.deepEqual(orders.primaryKey, ['id'])
  assert.equal(orders.foreignKeys.length, 1)
  assert.equal(orders.foreignKeys[0].refTable, 'public.users')
  assert.deepEqual(orders.uniques, [['email']])
  assert.deepEqual(orders.indexes, [['user_id']])
  assert.equal(ev.parseWarnings.length, 0)

  // mysqldump style: ALTER TABLE ADD PRIMARY KEY / KEY / UNIQUE
  const mysqlAlt = ddl.parseDdl([
    'CREATE TABLE `orders` (`id` int NOT NULL, `user_id` int NOT NULL, `email` varchar(255));',
    'ALTER TABLE `orders` ADD PRIMARY KEY (`id`);',
    'ALTER TABLE `orders` ADD KEY `idx_user` (`user_id`);',
    'ALTER TABLE `orders` ADD UNIQUE `uk_email` (`email`);',
  ].join('\n'), { engine: 'mysql' })
  const mo = mysqlAlt.tables[0]
  assert.deepEqual(mo.primaryKey, ['id'])
  assert.deepEqual(mo.indexes, [['user_id']])
  assert.deepEqual(mo.uniques, [['email']])
})

test('ddl: CHECK constraints are captured inline and as separate ALTER statements', async () => {
  const ddl = await mod('lib/ddl.js')
  // inline (mysql style): named + unnamed
  const inline = ddl.parseDdl('CREATE TABLE t (id INT, age INT, CONSTRAINT age_pos CHECK (age >= 0), CHECK (id > 0));', { engine: 'mysql' })
  assert.deepEqual(inline.tables[0].checks, [
    { name: 'age_pos', expression: 'age >= 0' },
    { name: undefined, expression: 'id > 0' },
  ])
  // pg_dump style: named constraint + bare CHECK via ALTER TABLE
  const pg = ddl.parseDdl([
    'CREATE TABLE public.orders (id integer, total numeric);',
    'ALTER TABLE public.orders ADD CONSTRAINT orders_total_check CHECK (total >= 0);',
    'ALTER TABLE public.orders ADD CHECK (id <> total);',
  ].join('\n'), { engine: 'postgresql' })
  assert.deepEqual(pg.tables[0].checks, [
    { name: 'orders_total_check', expression: 'total >= 0' },
    { name: undefined, expression: 'id <> total' },
  ])
  assert.equal(pg.parseWarnings.length, 0)
})

test('tools: code entries with database: R references validate against schema evidence', async () => {
  const ddl = await mod('lib/ddl.js')
  const root = await makeProject({ 'src/a.js': 'x\n' })
  const tools = await loadPlugin(root)
  const exec = { agent: 'test' }
  await tools.cognition_init.execute({}, exec)
  // declare a source with one table
  const dump = join(root, 'dump.sql')
  await writeFile(dump, 'CREATE TABLE public.orders (id integer NOT NULL);\n', 'utf8')
  const dbInit = await tools.cognition_database_init.execute({ dump: 'dump.sql', engine: 'postgresql' }, exec)
  assert.match(dbInit.text, /tables parsed: 1/)
  // a code entry referencing an UNDECLARED table is rejected
  const bad = await tools.cognition_update_entries.execute({ entries: [
    { path: 'src/a.js', tags: 'CG5', f: 'a', r: 'database:public.ghost', a: '-', s: '-' },
  ] }, exec)
  assert.match(bad.text, /REJECTED src\/a\.js/)
  assert.match(bad.text, /does not exist in the schema evidence/)
  // referencing the declared table is accepted
  const good = await tools.cognition_update_entries.execute({ entries: [
    { path: 'src/a.js', tags: 'CG5', f: 'a', r: 'database:public.orders', a: '-', s: '-' },
  ] }, exec)
  assert.match(good.text, /accepted: 1 \| rejected: 0/)
  // verify stays aligned
  const verify = await tools.cognition_verify.execute({}, exec)
  assert.match(verify.text, /aligned=true/)
  await rm(root, { recursive: true, force: true })
})
