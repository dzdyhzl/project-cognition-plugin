# @local/project-cognition — 项目认知索引

[![DSH Plugin](https://img.shields.io/badge/platform-DeepSeek%20Harness-blue)](https://github.com/dzdyhzl/project-cognition-plugin)
[![Version](https://img.shields.io/badge/version-1.23.0-green)](./package.json)

在每个项目的 `.cognition/` 目录维护一套**随 Git 版本化的纯文本认知索引**，让 AI 会话读一次索引即可获得项目全局认知，而不是每个任务都重新搜索、重读整个代码库。代码变化后可检测漂移并增量维护，索引始终与代码对齐。

本项目是 [AOCI-CODE](https://github.com/aoci-spec/aoci-code) 核心方法的简化复刻，运行于 DeepSeek Harness（DSH）的 Host 插件机制之上。

## 工作原理

```text
.cognition/
├── cognition.txt          Root：清单头 + Volume 声明
├── cognition.meta.txt     Meta：FRAS 规则、S 配额、标签字典
├── cognition.code.txt     Code：===目录段=== + 每文件一条 FRAS 条目
├── cognition.database.txt Database：每表一条 FRAS 条目（可选，启用后存在）
├── state.json             机器状态（哈希与待办清单，已 gitignore）
└── .gitignore             排除 state.json 与 schema/
```

每个受管文件对应一条 **FRAS 条目**：

```text
lib/scanner.js[CG9]: F:职责 | R:code:lib/state.js,... | A:导出接口 | S:非显而易见约束
```

- **F** 职责 · **R** 强关系 · **A** 对外接口 · **S** 非显而易见约束，外加紧凑标签（如 `CG9`）。
- 语义由模型依据真实源码撰写；插件只做结构校验（字段齐全、标签在字典内、S 配额、路径可解析），不伪造语义。
- 索引是纯文本，可被 Git diff、审查、版本化和回滚；换人、换 Agent、换会话，读一次即可接上。

## 提供的工具

| 工具 | 作用 |
|---|---|
| `cognition_overview` | 读取整个索引交付全局认知；大索引分块交付；无索引时返回建立索引的工作流指引 |
| `cognition_init` | 在项目根创建分卷骨架（只有规则和标签字典，不含业务语义） |
| `cognition_scan` | 按 gitignore 权威扫描受管文件，报告 Missing / Orphan / Stale 漂移与分批撰写计划 |
| `cognition_update_entries` | 校验并批量写入 FRAS 条目（code / database 卷） |
| `cognition_remove_entries` | 移除已删除文件 / 已删表的条目 |
| `cognition_search` | 按标签、路径、关键词检索；`relations=forward/reverse` 沿 R 关系做依赖投影 |
| `cognition_database_init` | 导入 .sql DDL dump（mysqldump / pg_dump 输出）为 Schema Evidence，零网络 |
| `cognition_database_scan` | 检测表级漂移（缺条目 / 孤儿条目） |
| `cognition_verify` | 聚合门禁：重校验全部卷的条目，返回对齐结论或违规清单 |
| `cognition_gate` | 每次会话开始的门禁：黑名单不处理；白名单建索引或动态维护；未登记时经覆盖对话框询问一次并把选择写入对应名单 |
| `cognition_registry` | 维护白/黑名单注册表（decline / allow / whitelist / unwhitelist / list） |
| `cognition_snapshot` | 输出当前索引状态的确定性只读 JSON 观察（条目+哈希+覆盖率+token），由调用方保存 |
| `cognition_evolution` | 把已保存的快照与当前状态对比：新增/删除/变更条目、覆盖率与 token 变化（derived=true，不在项目内存储） |
| `cognition_doctor` | 诊断索引环境：分卷骨架、Meta 字典、state 完整性、schema evidence、漂移、覆盖率与索引规模，输出逐项 HEALTHY / WARN / FAIL 报告 |

## 快速开始

1. 在 DSH 中安装本插件包（`plugin_manager install_bundle`）。
2. 在目标项目里对 AI 说：**"为这个项目建立认知索引"**，然后跟随 `cognition_scan` 返回的分批计划逐批撰写。
3. 之后每个新会话开始时，AI 先调 `cognition_gate` 确认名单状态（未登记项目会弹对话框询问一次），再调 `cognition_overview` 获得项目全局认知。
4. 完成开发后 AI 会自动 `cognition_scan` → `cognition_update_entries`，保持索引与代码对齐。

## 测试

`pnpm test`（即 `node --test test/`）：18 个测试覆盖格式解析、扫描器、模板（含 AGENTS.md 托管块幂等）、state、DDL 解析与全部工具的 mock-ctx 链路；gate 测试经 `PROJECT_COGNITION_REGISTRY` 环境变量指向临时注册表，不触碰真实 `~/.dsh`。

## 跨宿主集成（AGENTS.md）

对标 AOCI-CODE 的受管规则块：`cognition_init` **默认**在项目根的 `AGENTS.md` 写入一段以 `project-cognition:start/end` 定界的托管规则块（中文或英文随 locale），其中明确要求**每次对项目改动后都必须维护认知索引**（cognition_scan → cognition_update_entries / cognition_remove_entries，直到 cognition_verify aligned=true）。传 `agents_md=false` 可跳过；块外内容绝不改动；再次 init 或 doctor 可检查/更新块状态（旧块会被新文案原地替换）。
## 只读 Web 面板

左侧栏新增"项目认知索引"页：选择一个已登记的工作区，即可查看代码/数据库条目数、漂移计数（missing / orphan / stale）、待写清单、覆盖率与索引 token 规模、Overview 分块计划、数据库 evidence 状态、verify 对齐结论、按当前事实推导的“下一步建议”（带复制按钮，对标 AOCI 面板的推荐输入），以及**显式展示黑名单与白名单**（路径、登记时间、备注、索引状态；每条可一键**移出名单**——黑名单解除登记、白名单移出白名单；页面只展示项目名单（黑/白名单，30 秒自动刷新可关，均可一键移出）；白名单条目可点**查看**，在名单下方展开该项目的 cognition 配置快照（条目数、漂移、覆盖率、下一步建议、验证结论与条目预览），不选择任何项目时不会显示任何项目快照。新增仍走会话中的 cognition_gate / cognition_registry。面板除名单移除外均为只读；其余写入仍通过会话中的 `cognition_*` 工具完成。

## 边界

- 不做 MCP server 与治理状态机（完整能力见 [AOCI-CODE](https://github.com/aoci-spec/aoci-code)）。
- 数据库认知走本地 DDL dump 文件，不连接数据库、不读凭据、不访问网络。
- 忽略 `node_modules`、`dist` 等目录与二进制、超限文件（默认 512 KiB，可在插件配置调整）。
- 条目语义质量取决于模型；插件保证的是结构正确与索引-代码对齐。

## 许可

供个人使用；方法参考 [AOCI-CODE](https://github.com/aoci-spec/aoci-code)（FSL-1.1-MIT）。
