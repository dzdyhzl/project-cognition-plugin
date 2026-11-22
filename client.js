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
      gateTitle: '为这个项目维护认知索引吗？',
      gateBody: '{path} 既不在白名单也不在黑名单。选择会写入名单，之后不再询问。',
      gateAccept: '创建',
      gateAcceptHint: '加入白名单并建立认知索引',
      gateDecline: '拒绝',
      gateDeclineHint: '加入黑名单，不再询问',
      gateClose: '暂不选择（本次会话不再询问）',
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
      coverageTitle: '覆盖率',
      chunkPlan: '分块计划',
      chunkPlanFull: '整卷一次交付',
      chunkPlanMulti: '{chunks} 块交付（预算 {budget} token/块）',
      nextTitle: '下一步建议',
      registryTitle: '项目名单（黑/白名单）',
      blacklistTitle: '黑名单（不建索引）',
      whitelistTitle: '白名单（建/维护索引）',
      registryEmpty: '（空）',
      registryRemark: '备注',
      registryNoIndex: '尚无索引',
      registryHasIndex: '已有索引',
      registryStore: '名单存储',
      registryEditHint: '名单新增仍请在会话中调用 cognition_registry（whitelist / decline）；此处可直接移出成员。',
      registryRemove: '移出',
      registryRemoving: '移除中…',
      registryRemoved: '已移出名单',
      registryRemoveFailed: '移除失败',
      registryRemoveHint: '点击条目右侧的移出按钮可直接将该路径移出名单（黑名单=解除登记，白名单=移出白名单）；新增仍需在会话中完成。',
      copied: '已复制',
      coverageFiles: '文件',
      coverageLines: '行',
      coverageMissing: '已删文件条目',
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
      gateTitle: 'Maintain a cognition index for this project?',
      gateBody: '{path} is on neither list. Your choice is recorded and you will not be asked again.',
      gateAccept: 'Create',
      gateAcceptHint: 'Whitelist and build the cognition index',
      gateDecline: 'Decline',
      gateDeclineHint: 'Blacklist and never ask again',
      gateClose: 'Not now (no more prompts this session)',
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
      coverageTitle: 'Coverage',
      chunkPlan: 'Chunk plan',
      chunkPlanFull: 'single delivery',
      chunkPlanMulti: '{chunks} chunks ({budget} tokens each)',
      nextTitle: 'Suggested next input',
      registryTitle: 'Project lists (black/whitelist)',
      blacklistTitle: 'Blacklist (no index)',
      whitelistTitle: 'Whitelist (build/maintain index)',
      registryEmpty: '(empty)',
      registryRemark: 'remark',
      registryNoIndex: 'no index yet',
      registryHasIndex: 'index exists',
      registryStore: 'store',
      registryEditHint: 'Adding entries still happens in a session via cognition_registry (whitelist / decline); removing is available right here.',
      registryRemove: 'Remove',
      registryRemoving: 'Removing…',
      registryRemoved: 'Removed',
      registryRemoveFailed: 'Remove failed',
      registryRemoveHint: 'Use the remove button on each row to drop the path from its list (blacklist = lift record, whitelist = remove); adding entries still happens in a session.',
      copied: 'Copied',
      coverageFiles: 'files',
      coverageLines: 'lines',
      coverageMissing: 'entries for deleted files',
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
.pcp-page { height: 100%; box-sizing: border-box; max-width: 860px; width: 100%; margin: 0 auto; padding: 16px 20px calc(24px + var(--dsh-frame-top-clearance, 0px));
  color: var(--dsw-alias-label-primary); font-size: 13px; overflow-y: auto; overscroll-behavior: contain; flex: 1 1 auto; min-height: 0; }
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

    function NextActions({ actions }) {
      const [copiedIndex, setCopiedIndex] = useState(-1)
      if (!actions || actions.length === 0) return null
      const copy = async (text, index) => {
        try {
          await navigator.clipboard.writeText(text)
          setCopiedIndex(index)
          setTimeout(() => setCopiedIndex(-1), 1500)
        } catch { /* clipboard unavailable: user can still select the text */ }
      }
      return h('div', null, actions.map((action, index) => h('div', { key: index, className: 'pcp-entry' },
        h('div', { style: { fontWeight: 600 } }, action.title),
        h('div', { className: 'pcp-note' }, action.prompt),
        h('button', { className: 'pcp-btn', onClick: () => copy(action.prompt, index) },
          copiedIndex === index ? t('copied') : '\u29C9'),
      )))
    }

    function RegistryRow({ row, timeKey, t, removing, onRemove }) {
      const when = typeof row[timeKey] === 'string' ? row[timeKey].slice(0, 10) : '?'
      return h('li', { key: row.path, className: 'pcp-entry', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          h('div', { style: { overflowWrap: 'anywhere' } }, row.path),
          h('div', { className: 'pcp-note' },
            `${when}${row.remark ? ' · ' + t('registryRemark') + ': ' + row.remark : ''} · ${row.hasIndex ? t('registryHasIndex') : t('registryNoIndex')}`)),
        h('button', {
          className: 'pcp-btn',
          disabled: removing,
          onClick: onRemove,
        }, removing ? t('registryRemoving') : t('registryRemove')))
    }

    function PanelPage({ api, workspaces, t, locale }) {
      const [project, setProject] = useState(workspaces[0]?.path ?? null)
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(false)
      const [registry, setRegistry] = useState(null)
      const [registryError, setRegistryError] = useState(null)
      const [removing, setRemoving] = useState(null) // { list, path } while a removal is in flight
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
        // Registry lists are global (not per project); fetch once alongside.
        // Feature-detect: a Host that has not reloaded the plugin since v1.18.x
        // has no registryList remote method — show a reload hint instead of failing.
        if (typeof api.registryList !== 'function') {
          setRegistry(null)
          setRegistryError('面板名单功能需要重载 Host 后生效（registryList 远端方法缺失）')
        } else {
          try {
            setRegistry(await api.registryList({}))
            setRegistryError(null)
          } catch (cause) {
            setRegistry(null)
            setRegistryError(cause?.message ?? String(cause))
          }
        }
      }, [api])

      const removeRow = useCallback(async (list, path) => {
        if (typeof api.registryRemove !== 'function') {
          setRemoving(null)
          setRegistryError('面板移除功能需要重载 Host 后生效（registryRemove 远端方法缺失）')
          return
        }
        setRemoving({ list, path })
        try {
          await api.registryRemove({ list, project: path })
          // refresh the lists after a successful removal
          setRegistry(await api.registryList({}))
          setRegistryError(null)
        } catch (cause) {
          setRegistryError(cause?.message ?? String(cause))
        } finally {
          setRemoving(null)
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
        h('div', { className: 'pcp-section' }, t('registryTitle')),
        registryError !== null && h('p', { className: 'pcp-error' }, registryError),
        registry !== null && h('div', null,
          h('div', { className: 'pcp-note' }, `${t('registryStore')}: ${registry.storePath}`),
          registry.malformed === true && h('p', { className: 'pcp-error' }, t('failed', { message: 'the store file is not valid JSON' })),
          h('div', { style: { display: 'flex', gap: '2rem', flexWrap: 'wrap' } },
            h('div', { style: { flex: '1 1 20rem' } },
              h('div', { className: 'pcp-note', style: { fontWeight: 600 } }, `${t('blacklistTitle')} (${registry.declined.length})`),
              registry.declined.length === 0
                ? h('div', { className: 'pcp-note' }, t('registryEmpty'))
                : h('ul', { className: 'pcp-list' }, registry.declined.map(row => RegistryRow({
                  row, timeKey: 'declinedAt', t,
                  removing: removing !== null && removing.list === 'declined' && removing.path === row.path,
                  onRemove: () => removeRow('declined', row.path),
                })))),
            h('div', { style: { flex: '1 1 20rem' } },
              h('div', { className: 'pcp-note', style: { fontWeight: 600 } }, `${t('whitelistTitle')} (${registry.allowed.length})`),
              registry.allowed.length === 0
                ? h('div', { className: 'pcp-note' }, t('registryEmpty'))
                : h('ul', { className: 'pcp-list' }, registry.allowed.map(row => RegistryRow({
                  row, timeKey: 'allowedAt', t,
                  removing: removing !== null && removing.list === 'allowed' && removing.path === row.path,
                  onRemove: () => removeRow('allowed', row.path),
                }))))),
          h('p', { className: 'pcp-note' }, t('registryEditHint'))),
          h('p', { className: 'pcp-note' }, t('registryRemoveHint')),
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
        data.coverage !== null && data.coverage !== undefined && h('div', null,
          h('div', { className: 'pcp-section' }, t('coverageTitle')),
          h('div', null,
            h(Badge, { kind: data.coverage.filesPct >= 90 ? 'ok' : data.coverage.filesPct >= 50 ? 'warn' : 'bad' },
              `${t('coverageFiles')} ${data.coverage.filesPct}% (${data.coverage.indexedFiles}/${data.coverage.totalFiles})`),
            h(Badge, { kind: data.coverage.linesPct >= 90 ? 'ok' : data.coverage.linesPct >= 50 ? 'warn' : 'bad' },
              `${t('coverageLines')} ${data.coverage.linesPct}% (${data.coverage.indexedLines}/${data.coverage.totalLines})`),
            data.coverage.missingEntries > 0 && h(Badge, { kind: 'warn' }, `${t('coverageMissing')}: ${data.coverage.missingEntries}`),
            h('span', { className: 'pcp-note' }, `~${data.indexTokens ?? '?'} tokens`))),
        data.chunkPlan !== null && data.chunkPlan !== undefined && h('div', { className: 'pcp-note' },
          `${t('chunkPlan')}: ${data.chunkPlan.fullDelivery
            ? t('chunkPlanFull')
            : t('chunkPlanMulti', { chunks: data.chunkPlan.chunks, budget: data.chunkPlan.budget })}`),
        h('div', { className: 'pcp-section' }, t('nextTitle')),
        h(NextActions, { actions: data.nextActions }),
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


    // Self-contained stylesheet for the gate overlay: mounts in the
    // shell.overlay seat, which renders even when the panel page has never
    // been opened (same approach as github-workbench).
    const GATE_CSS = `
.pcp-gate-overlay { position: fixed; z-index: 40; display: flex; align-items: center; justify-content: center; }
.pcp-gate-card { position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px;
  max-width: 560px; width: min(560px, calc(100% - 48px)); box-sizing: border-box; padding: 28px 32px; border-radius: 16px; text-align: center;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #fff) 62%, transparent);
  backdrop-filter: blur(22px) saturate(1.4); -webkit-backdrop-filter: blur(22px) saturate(1.4);
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent);
  box-shadow: var(--dsw-elevation-prominent, 0 16px 48px rgba(0,0,0,0.22)); }
.pcp-gate-close { position: absolute; top: 12px; right: 12px; cursor: pointer; font: inherit; font-size: 14px; line-height: 1;
  width: 30px; height: 30px; border-radius: 999px; display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); color: var(--dsw-alias-label-secondary);
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent); }
.pcp-gate-close:hover { color: var(--dsw-alias-label-primary); }
.pcp-gate-heading { margin: 0 0 4px; font-size: 17px; font-weight: 650; color: var(--dsw-alias-label-primary); }
.pcp-gate-path { margin: 0 0 14px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.pcp-gate-choices { display: flex; gap: 14px; width: 100%; }
.pcp-gate-choice { flex: 1; cursor: pointer; font: inherit; display: flex; flex-direction: column; gap: 6px; align-items: center;
  padding: 22px 16px; border-radius: 12px; box-sizing: border-box; transition: background 120ms ease, border-color 120ms ease; }
.pcp-gate-create { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); color: var(--dsw-alias-state-success-primary); }
.pcp-gate-create:hover { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent); }
.pcp-gate-decline { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent); color: var(--dsw-alias-state-error-primary); }
.pcp-gate-decline:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 22%, transparent); }
.pcp-gate-choice:disabled { cursor: default; opacity: 0.55; }
.pcp-gate-choice-title { font-size: 14.5px; font-weight: 650; }
.pcp-gate-choice-hint { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
`

    /** Minimal snapshot store for the gate overlay request (workbench pattern). */
    function createGateStore() {
      let current = null
      const listeners = new Set()
      const publish = () => { for (const listener of [...listeners]) listener() }
      return {
        source: {
          getSnapshot: () => current,
          subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
          dismiss() { current = null; publish() },
        },
        set(next) { current = next; publish() },
      }
    }

    /**
     * Conversation-anchored gate overlay (ported from github-workbench):
     * anchors over the chat area only, never the composer or sidebars, and
     * tracks the region through window resizes. Frosted-glass card with two
     * choices: create (whitelist) or decline (blacklist).
     */
    function GateOverlay({ gateSource, actions, t }) {
      const [gate, setGate] = useState(gateSource.getSnapshot())
      const [region, setRegion] = useState(null)
      useEffect(() => gateSource.subscribe(() => setGate(gateSource.getSnapshot())), [gateSource])
      useEffect(() => {
        if (gate === null) return
        const measure = () => {
          let anchor = document.querySelector("[data-slot='conversation.session']")
          if (anchor === null || anchor.getBoundingClientRect().height < 80) {
            anchor = document.querySelector('[data-conversation-content]')
          }
          if (anchor === null) { setRegion(null); return }
          const box = anchor.getBoundingClientRect()
          if (box.width < 80 || box.height < 80) { setRegion(null); return }
          setRegion({ top: box.top, left: box.left, width: box.width, height: box.height })
        }
        measure()
        window.addEventListener('resize', measure)
        const anchor = document.querySelector('[data-conversation-content]')
        if (anchor !== null) {
          const observer = new ResizeObserver(measure)
          observer.observe(anchor)
          return () => { window.removeEventListener('resize', measure); observer.disconnect() }
        }
        return () => { window.removeEventListener('resize', measure) }
      }, [gate !== null])
      const styleEl = h('style', { 'data-plugin-css': PKG + '-gate', dangerouslySetInnerHTML: { __html: GATE_CSS } })
      if (gate === null || region === null) return styleEl

      return h(React.Fragment, null, styleEl, h('div', {
        className: 'pcp-gate-overlay',
        role: 'dialog', 'aria-modal': false, 'aria-label': t('gateTitle'),
        style: { top: region.top, left: region.left, width: region.width, height: region.height },
      },
        h('div', { className: 'pcp-gate-card' },
          h('button', {
            className: 'pcp-gate-close', title: t('gateClose'), 'aria-label': t('gateClose'),
            onClick: () => actions.close(gate),
          }, "✕"),
          h('h2', { className: 'pcp-gate-heading' }, t('gateTitle')),
          h('p', { className: 'pcp-gate-path' }, t('gateBody', { path: gate.path })),
          gate.error != null ? h('p', { className: 'pcp-gate-path', style: { color: 'var(--dsw-alias-state-error-primary)' } }, gate.error) : null,
          h('div', { className: 'pcp-gate-choices' },
            h('button', {
              className: 'pcp-gate-choice pcp-gate-create', disabled: gate.busy === true,
              onClick: () => actions.accept(gate),
            },
              h('span', { className: 'pcp-gate-choice-title' }, t('gateAccept')),
              h('span', { className: 'pcp-gate-choice-hint' }, t('gateAcceptHint')),
            ),
            h('button', {
              className: 'pcp-gate-choice pcp-gate-decline', disabled: gate.busy === true,
              onClick: () => actions.decline(gate),
            },
              h('span', { className: 'pcp-gate-choice-title' }, t('gateDecline')),
              h('span', { className: 'pcp-gate-choice-hint' }, t('gateDeclineHint')),
            ),
          ),
        ),
      ))
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
        'projectCognitionPanel/sessionGate': method('projectCognitionPanel',
          'Gate facts for one project directory: whitelist/blacklist coverage and index existence.',
          [{ name: 'request', description: '{ project: absolute directory }.', source: 'json', codec: requestJson }]),
        'projectCognitionPanel/gateDecision': method('projectCognitionPanel',
          'Record the user\'s gate answer: accept whitelists the project, decline blacklists it (mutually exclusive lists).',
          [{ name: 'request', description: '{ project: absolute directory, accept: boolean, remark?: string }.', source: 'json', codec: requestJson }]),
        'projectCognitionPanel/registryList': method('projectCognitionPanel',
          'Read-only registry snapshot: declined (blacklist) and allowed (whitelist) rows with timestamps, remarks, and index presence.',
          [{ name: 'request', description: 'unused.', source: 'json', codec: requestJson }]),
        'projectCognitionPanel/registryRemove': method('projectCognitionPanel',
          'Remove one project from a registry list from the panel: declined (lift blacklist) or allowed (remove from whitelist).',
          [{ name: 'request', description: '{ list, project }.', source: 'json', codec: requestJson }]),
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
      const api = {
        panelData: request => call('panelData', request),
        sessionGate: request => call('sessionGate', request),
        gateDecision: request => call('gateDecision', request),
        registryList: request => call('registryList', request),
        registryRemove: request => call('registryRemove', request),
      }

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

      // ------------------------------------------------ gate overlay
      // Conversation-start gate (ported from github-workbench): evaluate
      // once per session at the user's first activity; unlisted projects
      // raise the overlay question whose answer lands on the whitelist or
      // the blacklist via the Host gateDecision method.
      const gateStore = createGateStore()
      const gateDismissed = new Set()
      let gateBusy = false
      let gateShownSessionId
      const evaluateGate = async currentSession => {
        const snapshot = ctx.get('workspaces')?.list?.getSnapshot()
        const workspace = snapshot?.items?.find(item => item.sessionIds.includes(currentSession.id))
        const path = workspace?.path ?? (typeof currentSession.cwd === 'string' && currentSession.cwd !== '' ? currentSession.cwd : undefined)
        if (path === undefined || gateDismissed.has(path)) return
        if (gateBusy) return
        gateBusy = true
        try {
          const result = await api.sessionGate({ project: path })
          if (result.allowed === true || result.declined === true || gateDismissed.has(path)) return
          gateShownSessionId = currentSession.id
          gateStore.set({ path, busy: false, hasIndex: result.hasIndex === true })
        } catch {
          // Gate is best-effort: a failed probe never blocks the conversation.
        } finally {
          gateBusy = false
        }
      }
      const gateActions = {
        close: gate => { gateDismissed.add(gate.path); gateShownSessionId = undefined; gateStore.set(null) },
        accept: async gate => {
          gateStore.set({ ...gate, busy: true })
          try {
            await api.gateDecision({ project: gate.path, accept: true })
            gateDismissed.add(gate.path)
            gateStore.set(null)
          } catch (error) {
            gateStore.set({ ...gate, busy: false, error: error?.message ?? String(error) })
          }
        },
        decline: async gate => {
          gateStore.set({ ...gate, busy: true })
          try {
            await api.gateDecision({ project: gate.path, accept: false })
            gateDismissed.add(gate.path)
            gateStore.set(null)
          } catch (error) {
            gateStore.set({ ...gate, busy: false, error: error?.message ?? String(error) })
          }
        },
      }
      // The sessions list subscription is the activity sensor: the current
      // Canonical algorithm lives at shared/session-gate/index.js (tested); keep
      // this copy in sync when editing the sensor heuristics.
      // main-view session's first message moves updatedAt or starts running;
      // from then on the gate is evaluated exactly once for that session.
      ctx.effect(() => {
        let currentId
        let baselineUpdatedAt = Number.NEGATIVE_INFINITY
        let baselineRunning = false
        let evaluated = false
        const unsubscribe = ctx.get('sessions')?.list?.subscribe(() => {
          const sessions = ctx.get('sessions')?.list?.getSnapshot()
          if (sessions === undefined) return
          const currentSession = Object.values(sessions.byId).find(row => (row.retainedBy?.mainView ?? 0) > 0)
          if (currentSession === undefined) { currentId = undefined; return }
          if (currentId !== currentSession.id) {
            // Conversation switch: drop a visible prompt silently (no list
            // write, not dismissed) and re-baseline for the new session. A
            // prompt the user explicitly closed stays closed for this session
            // (gateShownSessionId parity with github-workbench: remember-close).
            if (gateShownSessionId !== undefined && gateShownSessionId !== currentSession.id) {
              gateShownSessionId = undefined
              gateStore.set(null)
            }
            currentId = currentSession.id
            baselineUpdatedAt = currentSession.updatedAt
            baselineRunning = currentSession.running === true
            evaluated = false
          }
          if (evaluated) return
          const firstMessage = currentSession.updatedAt > baselineUpdatedAt
            || (currentSession.running === true && !baselineRunning)
          if (!firstMessage) return
          evaluated = true
          void evaluateGate(currentSession)
        })
        return () => { unsubscribe?.() }
      }, 'project-cognition-panel: gate evaluation')
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'project-cognition-panel.gate', locale: NS,
        inject: () => ({ gateSource: gateStore.source, actions: gateActions, t }),
      }, GateOverlay)), 'project-cognition-panel: gate overlay')

      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 6, label: () => t('panel'), locale: NS,
      }, function PanelIcon() {
        return h('svg', { viewBox: '0 0 48 48', width: 18, height: 18, 'aria-hidden': true },
          h('rect', { x: 6, y: 8, width: 36, height: 32, rx: 6, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.6 }),
          h('path', { d: 'M13 17h14M13 24h22M13 31h9', stroke: 'currentColor', 'stroke-width': 2.6, 'stroke-linecap': 'round' }))
      })), 'project-cognition-panel: sidebar entry')
    }

    return { inject: ['remote', 'slots', 'locale', 'workspaces', 'sessions'], apply }
  },
})
