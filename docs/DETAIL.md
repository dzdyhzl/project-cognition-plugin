# Project cognition index

在项目的 `.cognition/` 目录维护一套随 Git 版本化的纯文本认知索引，让 AI 会话读一次索引就获得项目全局认知，而不是每个任务都重新搜索、重读整个代码库。本插件是 [AOCI-CODE](https://github.com/aoci-spec/aoci-code) 核心方法的简化复刻，运行在 DeepSeek Harness 的 Host 插件机制上。

## 它做什么

- **首次建索引**：`cognition_init` 在项目里创建 Root / Meta / Code 三个纯文本分卷骨架（只有规则和标签字典，不含业务语义），`cognition_scan` 按 gitignore 权威扫描受管文件并生成分批撰写计划。
- **撰写条目**：模型读真实源码后，用 `cognition_update_entries` 为每个文件写一条 FRAS 条目 —— F 职责 / R 强关系 / A 对外接口 / S 非显而易见约束，外加紧凑标签（如 `CG9`）。插件只校验结构（字段齐全、标签在字典内、S 配额、路径可解析），不伪造语义。
- **读取认知**：新会话开始时调用 `cognition_overview` 一次，读整份索引建立全局认知；大索引可分块读取并用 `cognition_search` 按标签/关键词过滤。
- **增量维护**：开发完成后调用 `cognition_scan` 检测漂移（Missing 已删文件 / Orphan 新文件 / Stale 内容已变），用 `cognition_update_entries` / `cognition_remove_entries` 补齐，索引回到与代码对齐的状态。
- **只读 Web 面板**：左侧栏新增"项目认知索引"页：选一个已登记的工作区，即可查看代码/数据库条目数、漂移计数（missing/orphan/stale）、待写清单、数据库 evidence 状态与 verify 对齐结论，30 秒自动刷新可关。面板严格只读，所有写入仍通过会话中的 cognition_* 工具完成。
- **项目名单体系**：`cognition_registry` 维护一份跨会话、跨工作区持久的名单（`~/.dsh/project-cognition.json`，仿照 github-workbench 的拒绝工作区存储）：`action="decline"` 记录"该项目不建索引"（去重、可带备注），之后新会话的 `cognition_overview` 在无索引时不再建议建索引，而是提示该项目在名单上；`action="allow"` 解除登记；`action="list"` 查看全部记录。在名单项目里成功执行 `cognition_init` 会自动解除登记。路径以规范化形式比较（Windows 盘符大小写归一），注册表文件损坏时报错且拒绝编辑、绝不覆盖。
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
