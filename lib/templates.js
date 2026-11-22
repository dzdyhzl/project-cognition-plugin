/**
 * Volume templates for `cognition_init`. The plugin never fabricates business
 * semantics; these skeletons only carry the rules the model authors against.
 * @module
 */

const CODE_TAG_DICT_ZH = [
  '#Tag dictionary: code',
  '#A Layer: C-共享基础 E-入口边界 A-应用编排 D-领域逻辑 K-算法计算 M-中间件 P-持久化 I-集成适配 R-运行基础 L-库与SDK F-声明配置 O-运维交付 T-测试验证 S-文档规范 X-开发工具 Z-其他',
  '#B Module: G-跨域通用 U-用户交互 B-核心业务 D-数据状态 I-身份权限 N-网络协议 M-消息事件 S-安全隐私 C-配置策略 O-可观测性 R-可靠性恢复 P-性能资源 W-流程调度 A-分析智能 L-本地化 V-构建发布 Q-质量保障 Z-其他',
  '#C Importance: 9-最高 8-很高 7-高 6-较高 5-中等 4-较低 3-低 2-很低 1-最低',
  '#E Scale: L-大>400 M-中200-400 S-小100-200 T-微<100',
].join('\n')

const CODE_TAG_DICT_EN = [
  '#Tag dictionary: code',
  '#A Layer: C-shared foundation E-entry boundary A-app orchestration D-domain logic K-algorithm M-middleware P-persistence I-integration adapter R-runtime L-library/SDK F-declarative config O-ops delivery T-test S-docs/spec X-dev tooling Z-other',
  '#B Module: G-cross-cutting U-user interaction B-core business D-data state I-identity/auth N-network protocol M-messaging S-security C-config policy O-observability R-reliability P-performance W-workflow A-analytics L-localization V-build/release Q-quality Z-other',
  '#C Importance: 9-highest 8-very high 7-high 6-medium-high 5-medium 4-low 3-lower 2-very low 1-lowest',
  '#E Scale: L-large>400 M-medium200-400 S-small100-200 T-tiny<100',
].join('\n')

const DATABASE_TAG_DICT_ZH = [
  '#[Tag dictionary: database]',
  '#A Layer: E-实体主表 T-事务事实 R-关联映射 M-明细从属 C-参考字典 S-状态存储 H-历史版本 L-日志审计 Q-队列发件 A-聚合投影 K-键值配置 B-文档大对象 Z-其他',
  '#B Module: G-跨域通用 B-核心业务 I-身份权限 T-组织租户 U-用户体验 F-财务计费 K-内容知识 C-配置策略 W-流程任务 M-消息事件 N-外部集成 S-安全隐私 O-可观测审计 R-可靠性恢复 P-性能资源 A-分析智能 L-本地化 V-构建发布 Q-质量测试 Z-其他',
  '#C Importance: 9-最高 8-很高 7-高 6-较高 5-中等 4-较低 3-低 2-很低 1-最低',
  '#E Scale: L-大>400行 M-中100-400行 S-小30-100行 T-微<30行',
].join('\n')

const DATABASE_TAG_DICT_EN = [
  '#[Tag dictionary: database]',
  '#A Layer: E-entity master T-transaction fact R-relation mapping M-detail child C-reference dictionary S-state store H-history L-log/audit Q-queue/outbox A-aggregate projection K-key-value config B-document/large object Z-other',
  '#B Module: G-cross-cutting B-core business I-identity/auth T-organization/tenant U-user experience F-billing K-content C-config policy W-workflow M-messaging N-external integration S-security O-observability R-reliability P-performance A-analytics L-localization V-build/release Q-quality Z-other',
  '#C Importance: 9-highest 8-very high 7-high 6-medium-high 5-medium 4-low 3-lower 2-very low 1-lowest',
  '#E Scale: L-large>400rows M-medium100-400rows S-small30-100rows T-tiny<30rows',
].join('\n')

/**
 * Build the three volume texts.
 * @param project project display name (directory basename)
 * @param locale 'zh-CN' | 'en-US'
 */
export function volumeTemplates(project, locale = 'zh-CN') {
  const zh = locale !== 'en-US'
  const root = [
    '#COGNITION-ROOT-MANIFEST: 1',
    '#Format-Version: project-cognition/v1',
    `#Locale: ${locale}`,
    `#Project: ${project}`,
    '#Global-Constraints: -',
    '#Volume: id=meta kind=meta path=cognition.meta.txt format=meta-v1 depends=- state=enabled',
    '#Volume: id=code kind=code path=cognition.code.txt format=object-fras-v1 depends=meta state=enabled',
    '',
  ].join('\n')

  const meta = [
    '#COGNITION-META-VOLUME: 1',
    '#Object-Protocol: project-cognition-object/v1',
    zh
      ? '#FRAS-Discipline: F=核心职责 R=修改时必须同时关注的强关系 A=对外接口或契约 S=F/R/A之外的非显而易见约束'
      : '#FRAS-Discipline: F=core function R=strong relations to read together A=public API or contract S=non-obvious constraints beyond F/R/A',
    zh
      ? '#S-Admission: 仅写非显而易见且能防止错误的信息；不得复述 F/R/A'
      : '#S-Admission: only non-obvious, error-preventing facts; never restate F/R/A',
    '#S-Quota: C9-8<=600 C7-4<=200 C3-1<=50',
    zh
      ? '#Entry-Line: <basename>[<tags>]: F:<职责> | R:<code:相对路径 或 database:schema.表,逗号分隔,或-> | A:<接口/关键列,或-> | S:<约束>'
      : '#Entry-Line: <basename>[<tags>]: F:<function> | R:<code:rel-path or database:schema.table,comma-separated,or-> | A:<api/key columns,or-> | S:<constraint>',
    zh
      ? '#Section-Line: ===<相对目录/>===  根目录使用 ===./===  数据库卷按 ===<schema>/=== 分段'
      : '#Section-Line: ===<relative-dir/>===  root files use ===./===  database volume groups by ===<schema>/===',
    zh ? '#Entry-Role: 只为承担实际职责的源文件写条目；琐碎文件可跳过并留在 pending' : '#Entry-Role: author entries for files with real responsibility; trivial files may stay pending',
    '#Read-Order: Root -> Meta -> Code -> Database；R 引用使用 code:相对路径 或 database:schema.表',
    zh ? '#Authoring: 依据真实源码与已接受的 Schema Evidence 撰写语义；本插件只校验结构与配额' : '#Authoring: write semantics from real source code and accepted Schema Evidence; this tool only validates structure and quota',
    '',
    '#[Tag dictionary: code]',
    zh ? CODE_TAG_DICT_ZH : CODE_TAG_DICT_EN,
    '',
    zh ? DATABASE_TAG_DICT_ZH : DATABASE_TAG_DICT_EN,
    '',
  ].join('\n')

  const code = [
    '#COGNITION-CODE-VOLUME: 1',
    '',
  ].join('\n')

  const database = [
    '#COGNITION-DATABASE-VOLUME: 1',
    '',
  ].join('\n')

  return { root, meta, code, database }
}

/**
 * Root manifest text with the database volume declaration appended.
 * Used by cognition_database_init to upgrade an existing project.
 */
export function rootWithDatabaseVolume(existingRootText) {
  if (/^#Volume: id=database kind=database/m.test(existingRootText)) return existingRootText
  const lines = existingRootText.trimEnd().split(/\r?\n/)
  lines.push('#Volume: id=database kind=database path=cognition.database.txt format=table-fras-v1 depends=meta state=enabled')
  return `${lines.join('\n')}\n`
}


/**
 * Managed AGENTS.md rules block (AOCI-style host integration, simplified):
 * a clearly delimited block appended to the repository's AGENTS.md so
 * non-DSH hosts and their agents also follow the index workflow. The block
 * carries rules only — never business semantics. Both delimiters are stable
 * markers: update rewrites everything between them and nothing else.
 */
const AGENTS_BLOCK_ZH = [
  '<!-- project-cognition:start (managed block; edits between these markers are overwritten) -->',
  '## 项目认知索引（project-cognition）',
  '',
  '- 每次会话开始（项目内第一轮、做其他事之前）先调用 cognition_gate 确认项目名单状态。',
  '- 开发前调用 cognition_overview 读取整份索引建立全局认知；大索引跟随 NEXT_CHUNK 分块读完。',
  '- 【必须】每次对项目做出改动（代码/配置/测试/文档/数据库）之后，都要维护本索引：cognition_scan 检查漂移，cognition_update_entries / cognition_remove_entries 更新受影响条目，直到 cognition_verify 返回 aligned=true 才算完成——这不是可选项。',
  '- 改动前想看影响面：cognition_search 传 relations=impact 与 path=目标文件（只走正式 R 关系，derived 结果仅供参考）。',
  '- 条目语义必须依据真实源码撰写；工具只校验结构、标签与配额。',
  '<!-- project-cognition:end -->',
].join('\n')

const AGENTS_BLOCK_EN = [
  '<!-- project-cognition:start (managed block; edits between these markers are overwritten) -->',
  '## Project cognition index (project-cognition)',
  '',
  '- At the start of every conversation in this project (first turn, before other work), call cognition_gate once.',
  '- Before development, call cognition_overview to load the whole index; for large indexes follow NEXT_CHUNK until ALL_CHUNKS_DELIVERED.',
  '- [MANDATORY] After every change to the project (code/config/tests/docs/database), maintain this index: cognition_scan for drift, then cognition_update_entries / cognition_remove_entries on the affected entries, until cognition_verify reports aligned=true — this is not optional.',
  '- To see the impact of a change first: cognition_search with relations=impact and path=<target file> (formal R edges only; derived output).',
  '- Author entry semantics from real source code; the tools validate structure, tags, and quotas only.',
  '<!-- project-cognition:end -->',
].join('\n')

/** The managed block text for a locale. */
export function agentsBlock(locale = 'zh-CN') {
  return locale === 'en-US' ? AGENTS_BLOCK_EN : AGENTS_BLOCK_ZH
}

/** Delimiter prefixes of the managed block (the written lines carry a suffix note). */
export const AGENTS_MARKERS = { start: '<!-- project-cognition:start', end: '<!-- project-cognition:end' }

/**
 * Apply the managed block to an AGENTS.md text: append, or replace the
 * existing block in place. Never touches content outside the markers.
 * @param existing current file text, or null when the file does not exist
 * @param locale block language
 * @returns new file text
 */
export function upsertAgentsBlock(existing, locale = 'zh-CN') {
  const block = agentsBlock(locale)
  if (existing === null || existing.trim().length === 0) {
    return `${block}\n`
  }
  const startIndex = existing.indexOf(AGENTS_MARKERS.start)
  const endIndex = existing.lastIndexOf(AGENTS_MARKERS.end)
  if (startIndex >= 0 && endIndex > startIndex) {
    const endLine = existing.indexOf('\n', endIndex)
    const before = existing.slice(0, startIndex).trimEnd()
    const after = endLine === -1 ? '' : existing.slice(endLine).trim()
    const parts = [before, block]
    if (after.length > 0) parts.push(after)
    return `${parts.filter(part => part.length > 0).join('\n\n')}\n`
  }
  return `${existing.trimEnd()}\n\n${block}\n`
}

/** Whether an AGENTS.md text currently contains the managed block. */
export function hasAgentsBlock(existing) {
  return existing !== null && existing.includes(AGENTS_MARKERS.start) && existing.includes(AGENTS_MARKERS.end)
}

/** Nested .gitignore so machine state stays out of Git while volumes stay tracked. */
export const COGNITION_GITIGNORE = 'state.json\n'

