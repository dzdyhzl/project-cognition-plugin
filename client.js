// Client half of the read-only Project Cognition panel.
//
// Registers one lazy factory whose id equals the package name: it mounts the
// Host Remote contribution (projectCognitionPanel namespace), a sidebar entry,
// and the panel page in the root `main` keyed slot. The page is strictly
// read-only: the only Host call is panelData, which computes one snapshot.

window.__ModuleLoader__.load({
  id: '@local/project-cognition',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const PKG = '@local/project-cognition'
    const NS = 'project-cognition-panel'
    const PANEL_ID = 'project-cognition-panel'

    // ------------------------------------------------------------ dictionaries

    const zh = {
      panel: '项目认知索引',
      loading: '正在读取索引…',
      retry: '重试',
      refresh: '刷新',
      auto: '30 秒自动刷新',
      project: '项目',
      noWorkspace: '没有已登记的工作区',
      pickProject: '选择项目',
      noIndexTitle: '这个项目还没有认知索引',
      noIndexBody: '在项目里对 AI 说「为这个项目建立认知索引」，或调用 cognition_init 开始。',
      declinedTitle: '这个项目已登记为「不建索引」',
      declinedBody: '曾在此项目拒绝建立认知索引，后续会话不再主动建议。登记时间：{time}{remark}',
      declinedLift: '解除登记：在会话中调用 cognition_registry，action="allow"。',
      codeEntries: '代码条目',
      dbEntries: '数据库条目',
      pendingCode: '待写代码条目',
      pendingDb: '待写表条目',
      driftTitle: '漂移（与当前代码树比对）',
      driftClean: '对齐：无漂移',
      missing: '已删文件仍有条目',
      orphan: '新文件未索引',
      stale: '内容已变需更新',
      pendingTitle: '待维护清单',
      dbTitle: '数据库卷',
      dbSource: '数据源',
      dbEvidenceTables: 'evidence 表数',
      dbMissing: '缺条目',
      dbOrphan: '孤儿条目',
      verifyTitle: '验证结论',
      aligned: 'aligned · 全部条目合规',
      notAligned: 'aligned=false',
      violations: '违规',
      checked: '已检查条目',
      entriesTitle: '条目预览',
      parseWarnings: '卷解析告警',
      updated: '更新于 {time}',
      failed: '读取失败：{message}',
      readonly: '只读面板；写入请通过会话中的 cognition_* 工具完成。',
    }

    const en = {
      panel: 'Project cognition index',
      loading: 'Reading index…',
      retry: 'Retry',
      refresh: 'Refresh',
      auto: 'Auto-refresh every 30s',
      project: 'Project',
      noWorkspace: 'No registered workspaces',
      pickProject: 'Pick project',
      noIndexTitle: 'No cognition index in this project yet',
      noIndexBody: 'Tell the AI in a session to "build the cognition index for this project", or call cognition_init.',
      declinedTitle: 'This project declined cognition-index creation',
      declinedBody: 'Index creation was declined here, so future sessions will not suggest one. Declined at: {time}{remark}',
      declinedLift: 'Lift the record: call cognition_registry with action="allow" in a session.',
      codeEntries: 'Code entries',
      dbEntries: 'Database entries',
      pendingCode: 'Pending code entries',
      pendingDb: 'Pending table entries',
      driftTitle: 'Drift (vs current code tree)',
      driftClean: 'Aligned: no drift',
      missing: 'Deleted files still indexed',
      orphan: 'New files not indexed',
      stale: 'Changed since authoring',
      pendingTitle: 'Pending authoring',
      dbTitle: 'Database volume',
      dbSource: 'Source',
      dbEvidenceTables: 'evidence tables',
      dbMissing: 'missing entry',
      dbOrphan: 'orphan entry',
      verifyTitle: 'Verification',
      aligned: 'aligned · every entry valid',
      notAligned: 'aligned=false',
      violations: 'violations',
      checked: 'entries checked',
      entriesTitle: 'Entry preview',
      parseWarnings: 'volume parse warnings',
      updated: 'updated {time}',
      failed: 'Failed to read: {message}',
      readonly: 'Read-only panel; perform writes through the cognition_* tools in a session.',
    }

    // ------------------------------------------------------------------ styles

    const CSS = `
.pcp-page { max-width: 860px; margin: 0 auto; padding: 16px 20px calc(24px + var(--dsh-frame-top-clearance, 0px));
  color: var(--dsw-alias-label-primary); font-size: 13px; }
.pcp-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: var(--dsh-frame-top-clearance, 0px); }
.pcp-title { font-size: 15px; font-weight: 600; margin-right: auto; }
.pcp-select { border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md, 6px);
  background: var(--dsw-alias-bg-layer-3, transparent); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; padding: 5px 8px; max-width: 340px; }
.pcp-btn { border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md, 6px);
  background: var(--dsw-alias-bg-layer-3, transparent); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; padding: 5px 10px; cursor: pointer; }
.pcp-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.pcp-btn:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.pcp-check { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.pcp-cards { display: flex; gap: 10px; flex-wrap: wrap; margin: 14px 0 4px; }
.pcp-card { flex: 1 1 150px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-lg, 10px);
  background: var(--dsw-alias-bg-layer-1, transparent); padding: 10px 14px; }
.pcp-card-num { font-size: 20px; font-weight: 600; }
.pcp-card-label { font-size: 11.5px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.pcp-section { margin: 16px 0 6px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.pcp-badge { display: inline-block; border-radius: 999px; padding: 2px 10px; font-size: 11.5px; margin-right: 8px;
  border: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); }
.pcp-badge-ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); color: var(--dsw-alias-state-success-primary); border-color: transparent; }
.pcp-badge-warn { background: color-mix(in srgb, var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-error-primary)) 14%, transparent); color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-error-primary)); border-color: transparent; }
.pcp-badge-bad { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); color: var(--dsw-alias-state-error-primary); border-color: transparent; }
.pcp-list { margin: 4px 0; padding: 0 0 0 18px; }
.pcp-list li { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 2px 0; overflow-wrap: anywhere; }
.pcp-entry { padding: 7px 10px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.pcp-entry-path { font-weight: 500; }
.pcp-entry-tags { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-left: 6px; }
.pcp-entry-f { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.pcp-note { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin: 8px 0; }
.pcp-error { color: var(--dsw-alias-state-error-primary); font-size: 12.5px; overflow-wrap: anywhere; }
.pcp-gate { max-width: 460px; margin: 12vh auto 0; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-xl, 14px);
  background: var(--dsw-alias-bg-layer-1, transparent); padding: 28px; text-align: center; }
.pcp-gate p { margin: 0 0 8px; font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.pcp-spinner { width: 13px; height: 13px; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l3);
  border-top-color: var(--dsw-alias-state-business-primary); animation: pcp-spin 0.8s linear infinite; display: inline-block; vertical-align: -2px; }
@keyframes pcp-spin { to { transform: rotate(360deg); } }
`

    function Style() {
      return h('style', null, CSS)
    }

    // ------------------------------------------------------------- components

    function StatCard({ num, label }) {
      return h('div', { className: 'pcp-card' },
        h('div', { className: 'pcp-card-num' }, String(num)),
        h('div', { className: 'pcp-card-label' }, label))
    }

    function Badge({ kind, children }) {
      return h('span', { className: `pcp-badge pcp-badge-${kind}` }, children)
    }

    function DriftList({ title, items }) {
      if (items.length === 0) return null
      return h('div', null,
        h('div', { className: 'pcp-note' }, `${title} (${items.length}):`),
        h('ul', { className: 'pcp-list' }, items.map(item => h('li', { key: item }, item))))
    }

    function PanelPage({ api, workspaces, t, locale }) {
      const [project, setProject] = useState(workspaces[0]?.path ?? null)
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(false)
      const [auto, setAuto] = useState(true)
      const projectRef = useRef(project)
      projectRef.current = project

      const load = useCallback(async () => {
        const target = projectRef.current
        if (target === null) return
        setLoading(true)
        try {
          const snapshot = await api.panelData({ project: target })
          setData(snapshot)
          setError(null)
        } catch (cause) {
          setError(cause?.message ?? String(cause))
        } finally {
          setLoading(false)
        }
      }, [api])

      useEffect(() => { load() }, [load, project])
      useEffect(() => {
        if (!auto) return undefined
        const timer = setInterval(() => { load() }, 30_000)
        return () => clearInterval(timer)
      }, [auto, load])

      if (workspaces.length === 0) {
        return h('div', { className: 'pcp-page' }, h(Style, null), h('div', { className: 'pcp-gate' }, h('p', null, t('noWorkspace'))))
      }
      if (data !== null && data.indexExists === false) {
        const declined = data.declined === true
        const remark = typeof data.declinedRemark === 'string' && data.declinedRemark !== '' ? ` · ${data.declinedRemark}` : ''
        const when = typeof data.declinedAt === 'string' ? data.declinedAt.slice(0, 10) : '—'
        return h('div', { className: 'pcp-page' }, h(Style, null),
          h('div', { className: 'pcp-header' }, headerControls()),
          h('div', { className: 'pcp-gate' },
            h('p', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
              declined ? t('declinedTitle') : t('noIndexTitle')),
            declined
              ? h('p', null, t('declinedBody', { time: when, remark }))
              : h('p', null, t('noIndexBody')),
            declined && h('p', { className: 'pcp-note' }, t('declinedLift'))))
      }
      if (error !== null && data === null) {
        return h('div', { className: 'pcp-page' }, h(Style, null),
          h('div', { className: 'pcp-header' }, headerControls()),
          h('p', { className: 'pcp-error' }, t('failed', { message: error })),
          h('button', { className: 'pcp-btn', onClick: () => load() }, t('retry')))
      }
      if (data === null) {
        return h('div', { className: 'pcp-page' }, h(Style, null),
          h('div', { className: 'pcp-header' }, headerControls()),
          h('p', { className: 'pcp-note' }, h('span', { className: 'pcp-spinner' }), ' ', t('loading')))
      }

      const drift = data.drift
      const driftClean = drift !== null && drift.missing === 0 && drift.orphan === 0 && drift.stale === 0
      const dbDrift = data.database?.drift
      const aligned = data.verify?.violationsTotal === 0 && data.verify?.error === undefined

      function headerControls() {
        return [
          h('span', { className: 'pcp-title' }, t('panel')),
          h('select', {
            className: 'pcp-select',
            value: project ?? '',
            onChange: event => setProject(event.target.value),
            'aria-label': t('pickProject'),
          }, workspaces.map(workspace => h('option', { key: workspace.path, value: workspace.path }, workspace.title || workspace.path))),
          h('button', { className: 'pcp-btn', onClick: () => load() }, loading ? `⟳ ${t('refresh')}` : t('refresh')),
          h('label', { className: 'pcp-check' },
            h('input', { type: 'checkbox', checked: auto, onChange: event => setAuto(event.target.checked) }),
            t('auto')),
        ]
      }

      return h('div', { className: 'pcp-page' }, h(Style, null),
        h('div', { className: 'pcp-header' }, headerControls()),
        h('div', { className: 'pcp-cards' },
          h(StatCard, { num: data.volumes?.code?.entries ?? 0, label: t('codeEntries') }),
          h(StatCard, { num: data.volumes?.database?.entries ?? 0, label: t('dbEntries') }),
          h(StatCard, { num: data.pending?.codeTotal ?? 0, label: t('pendingCode') }),
          h(StatCard, { num: data.pending?.databaseTotal ?? 0, label: t('pendingDb') })),
        h('div', { className: 'pcp-section' }, t('driftTitle')),
        driftClean
          ? h(Badge, { kind: 'ok' }, t('driftClean'))
          : h('div', null,
            h(Badge, { kind: drift.missing > 0 ? 'bad' : 'ok' }, `${t('missing')}: ${drift?.missing ?? '?'}`),
            h(Badge, { kind: drift.orphan > 0 ? 'warn' : 'ok' }, `${t('orphan')}: ${drift?.orphan ?? '?'}`),
            h(Badge, { kind: drift.stale > 0 ? 'warn' : 'ok' }, `${t('stale')}: ${drift?.stale ?? '?'}`)),
        drift !== null && h('div', null,
          h(DriftList, { title: t('stale'), items: drift.staleList ?? [] }),
          h(DriftList, { title: t('orphan'), items: drift.orphanList ?? [] }),
          h(DriftList, { title: t('missing'), items: drift.missingList ?? [] })),
        (data.pending?.code?.length ?? 0) + (data.pending?.database?.length ?? 0) > 0 && h('div', null,
          h('div', { className: 'pcp-section' }, t('pendingTitle')),
          h(DriftList, { title: t('pendingCode'), items: data.pending.code }),
          h(DriftList, { title: t('pendingDb'), items: data.pending.database })),
        data.database?.sources?.length > 0 && h('div', null,
          h('div', { className: 'pcp-section' }, t('dbTitle')),
          h('div', { className: 'pcp-note' },
            data.database.sources.map(source => `${t('dbSource')} ${source.id} (${source.engine}, ${t('dbEvidenceTables')} ${source.tables})`).join(' · ')),
          dbDrift !== null && (dbDrift.missingEntry.length > 0 || dbDrift.orphanEntry.length > 0) && h('div', null,
            h(Badge, { kind: dbDrift.missingEntry.length > 0 ? 'warn' : 'ok' }, `${t('dbMissing')}: ${dbDrift.missingEntry.length}`),
            h(Badge, { kind: dbDrift.orphanEntry.length > 0 ? 'warn' : 'ok' }, `${t('dbOrphan')}: ${dbDrift.orphanEntry.length}`),
            h(DriftList, { title: t('dbMissing'), items: dbDrift.missingEntry }),
            h(DriftList, { title: t('dbOrphan'), items: dbDrift.orphanEntry }))),
        h('div', { className: 'pcp-section' }, t('verifyTitle')),
        h('div', null,
          h(Badge, { kind: aligned ? 'ok' : 'bad' }, aligned ? t('aligned') : t('notAligned')),
          h('span', { className: 'pcp-note' }, `${t('checked')}: ${data.verify?.checked ?? 0} · ${t('violations')}: ${data.verify?.violationsTotal ?? 0}`)),
        data.verify?.violations?.length > 0 && h('ul', { className: 'pcp-list' },
          data.verify.violations.map((violation, index) => h('li', { key: index, className: 'pcp-error' }, violation))),
        h('div', { className: 'pcp-section' }, `${t('entriesTitle')} (${data.codeEntriesTotal})`),
        h('div', null, (data.codeEntries ?? []).map(entry => h('div', { key: entry.path, className: 'pcp-entry' },
          h('div', null, h('span', { className: 'pcp-entry-path' }, entry.path), h('span', { className: 'pcp-entry-tags' }, `[${entry.tags}]`)),
          h('div', { className: 'pcp-entry-f' }, entry.f)))),
        (data.volumes?.code?.parseWarnings ?? 0) + (data.volumes?.database?.parseWarnings ?? 0) > 0 &&
          h('p', { className: 'pcp-note' }, `⚠ ${t('parseWarnings')}: ${(data.volumes?.code?.parseWarnings ?? 0) + (data.volumes?.database?.parseWarnings ?? 0)}`),
        h('p', { className: 'pcp-note' }, `${t('updated', { time: new Date(data.updatedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') })} · ${t('readonly')}`))
    }

    // ------------------------------------------------- Remote contribution

    const z = require('zod')

    const strictJson = schema => ({ mode: 'strict', typeSymbol: `${PKG}#json`, create: () => schema })
    const requestJson = strictJson(z.record(z.string(), z.unknown()))

    function method(service, description, parameters) {
      return { service, description, invocation: { kind: 'direct' }, parameters, result: { mode: 'src-json' } }
    }

    const TYPERT_REMOTE = {
      package: PKG,
      get descriptors() {
        const descriptors = []
        for (const [endpoint, definition] of Object.entries(this.methods)) {
          const separator = endpoint.indexOf('/')
          const namespace = endpoint.slice(0, separator)
          const name = endpoint.slice(separator + 1)
          descriptors.push({
            ...definition,
            id: `${PKG}#${endpoint}`,
            namespace,
            method: name,
            parameters: definition.parameters.map(parameter => ({ ...parameter, wire: parameter.wire ?? parameter.name })),
          })
        }
        return descriptors
      },
      methods: {
        'projectCognitionPanel/panelData': method('projectCognitionPanel',
          'Read one read-only cognition panel snapshot for a project directory (volumes, drift, pending, database, verify).',
          [{ name: 'request', description: '{ project: absolute directory }.', source: 'json', codec: requestJson }]),
      },
    }

    // ------------------------------------------------------------ mounting

    function apply(ctx) {
      let remoteDispose
      const remoteReady = new Promise((resolve, reject) => {
        Promise.resolve()
          .then(() => ctx.remote.$mount(TYPERT_REMOTE))
          .then(dispose => {
            remoteDispose = dispose
            resolve(ctx.get('remote.projectCognitionPanel'))
          }, reject)
      })
      ctx.effect(() => () => {
        if (remoteDispose !== undefined) remoteDispose()
      }, 'project-cognition-panel: remote mount')
      remoteReady.catch(() => { /* failures surface through API calls */ })

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'project-cognition-panel: dictionaries')
      const t = ctx.locale.bind(NS)

      const call = async (name, ...rest) => {
        const namespace = await remoteReady
        const result = await namespace[name](...rest)
        if (!result.ok) {
          const failure = result.error
          const error = new Error(failure?.message ?? 'the call failed')
          error.code = failure?.code
          throw error
        }
        return result.value
      }
      const api = { panelData: request => call('panelData', request) }

      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_ID, locale: NS,
        inject: () => {
          const items = ctx.get('workspaces')?.list?.getSnapshot()?.items ?? []
          const workspaces = []
          for (const item of items) {
            if (typeof item?.path !== 'string' || item.path.length === 0) continue
            if (workspaces.some(existing => existing.path === item.path)) continue
            workspaces.push({ path: item.path, title: typeof item.title === 'string' ? item.title : undefined })
          }
          return {
            api,
            workspaces,
            t,
            locale: ctx.locale.getSnapshot().active === 'zh' ? 'zh' : 'en',
          }
        },
      }, PanelPage)), 'project-cognition-panel: main page')

      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 6, label: () => t('panel'), locale: NS,
      }, function PanelIcon() {
        return h('svg', { viewBox: '0 0 48 48', width: 18, height: 18, 'aria-hidden': true },
          h('rect', { x: 6, y: 8, width: 36, height: 32, rx: 6, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.6 }),
          h('path', { d: 'M13 17h14M13 24h22M13 31h9', stroke: 'currentColor', 'stroke-width': 2.6, 'stroke-linecap': 'round' }))
      })), 'project-cognition-panel: sidebar entry')
    }

    return { inject: ['remote', 'slots', 'locale', 'workspaces'], apply }
  },
})
