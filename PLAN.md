# Project Cognition 插件 —— 简化复刻 AOCI-CODE

> 参考：https://github.com/aoci-spec/aoci-code （v0.2.0-rc3，FSL-1.1-MIT）
> 本插件为其核心方法的简化复刻，运行于 DeepSeek Harness（DSH）的 Host 插件机制上。

## 目标

AI 第一次接触一个项目时，在项目目录内建立随 Git 版本化的纯文本认知索引；新会话先读索引即可获得项目全局认知；代码变化后可检测漂移并增量维护，索引始终与代码对齐。

**不做**：数据库认知、Go 二进制 / MCP server、事务化治理状态机（Plan/CAS/Receipt/Recovery）、只读面板 UI。

## 已确认的决策（用户选定）

1. **简化复刻**：保留 Root/Meta/Code 分卷 + FRAS 条目 + 漂移检测 + 增量维护。
2. **触发方式**：注册 Agent 工具 + `ctx.systemPrompt.section()` 注入简短指引。
3. **索引存放**：项目目录内 `.cognition/`，随 Git 版本化（`state.json` 建议 gitignore）。
4. **插件目录**：`E:\private project\dsh\project-cognition-plugin\`。

## 索引设计（项目目录内）

```text
.cognition/
├── cognition.txt          Root：#COGNITION-ROOT-MANIFEST 头 + Volume 声明
├── cognition.meta.txt     Meta：标签字典（Layer/Module/Importance/Scale）+ FRAS 规则 + S 字段配额
├── cognition.code.txt     Code：===目录段=== + 每文件一条 FRAS 条目
└── state.json             机器状态：受管文件清单 + SHA-256 + 条目哈希（漂移检测用）
```

条目格式（对齐 AOCI 的 object-fras，简化字段）：

```text
atomic.go[CG9]: F:职责 | R:code:path/to/rel.go,... | A:导出接口 | S:非显而易见约束
```

- **分工沿用 AOCI 原则**：语义由模型依据真实源码撰写；插件只做结构校验（FRAS 字段齐全、标签在字典内、S 配额、路径可解析），不伪造语义。
- `state.json` 记录每个受管文件的哈希与条目哈希，实现 Missing / Orphan / Stale 三类漂移检测；首次建索引中断后可按 state.json 的待办清单续建。

## 工具设计（注册 6 个，对标 AOCI 的 9 个）

| 工具 | 作用 |
|---|---|
| `cognition_overview` | 读取整个索引交付全局认知；索引不存在时返回建立索引的工作流指引；有漂移时列出待维护条目；大索引按 chunk 分块交付（`chunk=N` 翻页直到 `ALL_CHUNKS_DELIVERED`）；已声明数据库源时附带 Database 卷 |
| `cognition_init` | 在项目根建立 Volume 骨架（无业务语义）+ state.json |
| `cognition_scan` | 按 git 忽略权威扫描受管文件，与 state.json 比对，返回 Missing/Orphan/Stale 清单和分批建议；支持嵌套 .gitignore 与配置的额外扩展名 |
| `cognition_update_entries` | 校验并批量写入/更新条目（结构、标签、配额、引用），`volume=code|database`；同步刷新 state.json 哈希 |
| `cognition_remove_entries` | 移除已删除文件/已删表的条目，`volume=code|database` |
| `cognition_search` | 按标签/关键词过滤条目；`relations=forward/reverse` 沿正式 R 关系做正/反向依赖投影；`volume=code|database` |
| `cognition_database_init` | 声明数据库源并导入 .sql DDL dump（mysqldump/pg_dump 输出）为 Schema Evidence；升级 Root 清单并创建 Database 卷；零网络 |
| `cognition_database_scan` | 表级漂移：evidence 中有表但无条目 / 有条目但表已不在 evidence |
| `cognition_verify` | 聚合门禁：重校验 Code+Database 全部条目（字段/字典/配额/R 引用可解析），返回 aligned=true 或违规清单 |

系统提示注入一段固定短文本（<150 token）：在项目内工作时先调 `cognition_overview`；完成开发后对受影响文件调 `cognition_scan` + `cognition_update_entries` 维护索引。Config 暴露 include/exclude glob、单文件大小上限、S 配额，写入 `cordis.patch.yml`（用户补丁层，升级不丢）。

## 实施步骤

1. 建目录 + 写计划（本文件）。
2. 确认 `ctx.tools.register` 的准确签名（读取内置工具插件源码，经 ASAR 感知读取）。
3. 实现核心模块：索引格式解析/序列化/校验、扫描器（.gitignore 尊重 + SHA-256）、漂移比对、原子写入、6 个工具、系统提示注入、Config schema。
4. 补齐 bundle 元数据：`package.json`（`@local/project-cognition`）、`cordis.patch.yml`、`locale/en.json` + `locale/zh.json`、原创 `icon.svg`、`docs/DETAIL.md`。
5. 安装：`plugin_manager install_bundle`，确认 `application: applied`。
6. 验证：新会话确认 6 个工具可见；测试项目走完 init → 建索引 → overview → 改文件 → scan 报 Stale → update → 重新对齐闭环。
7. 交付报告：位置、验证状态、未尽事项。

## 边界与故障处理

- 非 Git 项目：跳过 .gitignore，全量遍历 + 默认排除（node_modules、dist、二进制、超限文件）。
- 超大项目：scan 按批次返回待办，update_entries 接受数组，中断可续。
- 并发写：同目录临时文件 + 原子替换；CRLF/UTF-8 明确处理。
- 系统提示注入保持最短；详细指引放在工具返回里按需给出。

## 验收标准

- 本目录含 `PLAN.md` 与完整 bundle。
- 插件安装后在新会话中 6 个 `cognition_*` 工具可用，系统提示含指引段。
- 测试项目上闭环成功：首次建索引 → 新会话读 overview 即获全局认知 → 代码改动被 scan 检出 → 维护后重新对齐。
- 索引为纯文本、位于项目内、可被 Git diff；插件不做任何网络访问。

## 风险与假设

- 条目语义质量取决于模型，插件只能保证结构与对齐（与 AOCI 定位一致）。
- `ctx.tools.register` 具体签名以运行版本源码为准（步骤 2 落实后再写工具代码）。
