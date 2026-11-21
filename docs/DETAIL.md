# Project cognition index

在项目的 `.cognition/` 目录维护一套随 Git 版本化的纯文本认知索引，让 AI 会话读一次索引就获得项目全局认知，而不是每个任务都重新搜索、重读整个代码库。本插件是 [AOCI-CODE](https://github.com/aoci-spec/aoci-code) 核心方法的简化复刻，运行在 DeepSeek Harness 的 Host 插件机制上。

## 它做什么

- **首次建索引**：`cognition_init` 在项目里创建 Root / Meta / Code 三个纯文本分卷骨架（只有规则和标签字典，不含业务语义），`cognition_scan` 按 gitignore 权威扫描受管文件并生成分批撰写计划。
- **撰写条目**：模型读真实源码后，用 `cognition_update_entries` 为每个文件写一条 FRAS 条目 —— F 职责 / R 强关系 / A 对外接口 / S 非显而易见约束，外加紧凑标签（如 `CG9`）。插件只校验结构（字段齐全、标签在字典内、S 配额、路径可解析），不伪造语义。
- **读取认知**：新会话开始时调用 `cognition_overview` 一次，读整份索引建立全局认知；大索引可分块读取并用 `cognition_search` 按标签/关键词过滤。
- **增量维护**：开发完成后调用 `cognition_scan` 检测漂移（Missing 已删文件 / Orphan 新文件 / Stale 内容已变），用 `cognition_update_entries` / `cognition_remove_entries` 补齐，索引回到与代码对齐的状态。
- **影响分析**：`cognition_search` 传 `relations=impact` + `path=目标文件`，沿模型撰写的正式 R 关系反向遍历传递闭包，逐层输出"改这个文件可能波及哪些条目"（derived=true，只走显式 R 边，不自动推断）。
- **覆盖率与规模**：overview 与 scan 报告索引覆盖了多少受管代码（文件数/行数百分比），并估算索引的 token 规模；大索引的 overview 分块按估算 token 预算（默认 7000，配置 `overviewChunkTokens`）切分，而不是固定条数。
- **跨卷影响分析**：`cognition_search` 传 `relations=impact` + `volume=code` + `path=schema.table`，可从数据库表出发沿 code 条目的 R 关系传递闭包，输出"改这张表可能波及哪些代码条目"（有测试固化）。
- **token 预算门控**：overview 的整卷交付门槛除条目数（默认 400）外还检查估算 token（默认 7000）；密集条目虽少也会建议分块，与 AOCI 的 chunk_tokens 交付模型一致。
- **跨卷引用校验**：code 条目的 R 可以写 `database:schema.table`（代码↔数据库强关系）；update_entries 与 verify 会把这类引用对照已导入的 Schema Evidence 验证，指向未声明表的引用被拒绝或计为违规；项目未声明数据库源时不启用此检查。
- **DDL 解析增强**：`cognition_database_init` 的解析器除 CREATE TABLE 内联约束外，还折叠 pg_dump 输出的分离语句——ALTER TABLE x ADD CONSTRAINT（PRIMARY KEY / UNIQUE / FOREIGN KEY ... REFERENCES）、MySQL 的 ALTER TABLE ADD PRIMARY KEY/KEY/UNIQUE，以及 CREATE [UNIQUE] INDEX ... ON x（USING btree 兼容）；CHECK 约束（内联或 ALTER 分离、具名/匿名）解析为 evidence 的 checks 字段（{ name?, expression }），供表级 FRAS 的 S 字段引用；列注释同样采集——MySQL 内联 `COMMENT '...'` 与 PostgreSQL 分离的 `COMMENT ON COLUMN x IS '...'`（schema 限定名、转义引号兼容），database_init 摘要报告列注释数，供表级 F/A 撰写引用列语义；表引用支持裸名、schema 限定名与引号形式。
- **下一步建议**：面板按快照事实（待维护数、漂移数、校验违规）确定性推导现在该输入给 AI 的指令，一键复制；索引已对齐时提示正常开发即可。对应 AOCI 面板的“推荐输入”。
- **面板分块计划**：面板与 overview 使用同一个 token 估算器计算当前索引需要的分块交付数（默认 7000 token/块预算），展示整卷一次交付还是分几块。
- **回归测试**：`test/plugin.test.js`（node:test，零依赖）覆盖纯函数库（format/scanner/state/ddl/templates）与全部 cognition_* 工具的 mock-ctx 端到端链路；注册表经环境变量隔离，可安全重复运行。
- **刷新阈值**：`overview` 在待办条数达到配置阈值（`refreshThreshold`，默认 30）时提示先 `cognition_scan` 再依赖索引图景，对应 AOCI-CODE 的语义刷新阈值。
- **跨宿主规则块**：`cognition_init` 传 `agents_md=true` 向项目根 `AGENTS.md` 写入定界托管块（`<!-- project-cognition:start/end -->`），块内是工作流规则（gate→overview→scan→update/verify→impact），幂等可更新；块外用户内容零改动。对应 AOCI-CODE `init` 写受管 AGENTS.md 规则块的做法，简化为 opt-in 单宿主无关形态。
- **快照与演化**：`cognition_snapshot` 输出一份确定性只读 JSON 观察（条目清单+条目哈希+覆盖率+token 规模），由调用方自行保存（如存到仓库外或 Git 历史里）；`cognition_evolution` 读入旧快照与当前状态对比——新增/删除/变更条目、覆盖率百分比变化、索引 token 变化、待维护差值。两者都不落盘到项目内，对应 AOCI-CODE 的 snapshot/evolution 派生观察。
- **诊断**：`cognition_doctor` 一次性体检索引环境——分卷骨架、Meta 字典可解析、state.json 完整性（v1/v2、条目/文件哈希一致性、待办清单异常）、schema evidence 与声明一致性、漂移摘要、覆盖率、索引规模与分块预算；输出逐项 HEALTHY / WARN / FAIL 结论，索引行为异常或从 Git 恢复后可运行。
- **只读 Web 面板**：左侧栏新增"项目认知索引"页：选一个已登记的工作区，即可查看代码/数据库条目数、漂移计数（missing/orphan/stale）、待写清单、数据库 evidence 状态与 verify 对齐结论，30 秒自动刷新可关。面板严格只读，所有写入仍通过会话中的 cognition_* 工具完成。
- **白/黑名单门禁**：`cognition_gate` 在每次会话开始时把项目对照 `~/.dsh/project-cognition.json` 里的两份名单（白名单 allowed / 黑名单 declined，二者互斥）：黑名单项目不处理，也不建议建索引；白名单项目已有索引则动态维护（开发后 `cognition_scan` → `cognition_update_entries` / `cognition_remove_entries`），没有索引则立即创建；两表都未登记时，模型通过用户问答覆盖对话框询问一次"是否创建 cognition"，用户选创建→写入白名单并开始建索引，选拒绝→写入黑名单。`cognition_registry` 的 `list` 展示两份名单，`whitelist`/`unwhitelist`/`decline`/`allow` 分别维护白/黑名单。
- **数据库认知（可选）**：`cognition_database_init` 导入一份 .sql DDL dump（mysqldump / pg_dump 输出，本地文件，零网络）作为 Schema Evidence，随后为每张表写表级 FRAS 条目；`cognition_database_scan` 检测表级漂移；`cognition_verify` 一次性重校验两个卷的全部条目。

## 索引文件

```text
.cognition/
├── cognition.txt          Root：清单头 + Volume 声明（启用数据库后含 database 卷行）
├── cognition.meta.txt     Meta：FRAS 规则、S 配额、code/database 两套标签字典
├── cognition.code.txt     Code：===目录段=== + 每文件一条 FRAS 条目
├── cognition.database.txt Database：===schema段=== + 每表一条 FRAS 条目（启用后存在）
├── schema/<source>.json   Schema Evidence（DDL 解析出的列/PK/FK/唯一键，Git 忽略）
├── state.json             机器状态（哈希与待办清单，已由 .gitignore 排除）
└── .gitignore             排除 state.json 与 schema/
```

索引是纯文本，可被 Git diff、审查、版本化和回滚；换人、换 Agent、换会话，读一次即可接上。

## 使用建议

- 在目标项目里说"为这个项目建立认知索引"，然后跟随 scan 返回的分批计划逐批撰写。
- 首次建立需要模型读完全部受管文件，项目越大耗时越长；中途中断可继续（待办保存在 state.json）。
- 大索引（默认超过 400 条）时 overview 会建议分块：调用 `cognition_overview` 传 `chunk=1`，跟随 `NEXT_CHUNK` 逐块读取，直到 `ALL_CHUNKS_DELIVERED`。
- 改动前想看影响面：`cognition_search` 传 `relations=reverse` + `path=目标文件`，列出所有在 R 里引用它的条目；`relations=forward` 则列出目标条目自身依赖的文件。
- 条目语义质量取决于模型；插件保证的是结构正确与索引-代码对齐。

## 边界

- 不做 MCP server 与治理状态机（AOCI-CODE 的完整能力见其仓库）；面板为 DSH 内置页面，不是独立 HTTP 服务。
- 数据库认知走本地 DDL dump 文件（mysqldump / pg_dump 输出），不连接数据库、不读凭据、不访问网络；解析失败的 dump 会显式报错而不是静默降级。
- 只读写项目目录内的索引文件；面板只读。
- 忽略 node_modules、dist 等目录与二进制、超限文件（默认 512 KiB，可在配置调整）。子目录的 .gitignore / .cognitionignore 作用于各自子树；配置 `include` 可追加文本扩展名（如 `.sol`），`excludeDirs` 可追加忽略目录。
