# 工作区提示（project-cognition-plugin）

- 本插件是三插件联合开发区的一员，依赖 ../shared/ 两个模块：
  - agents-block —— cognition_init 写入项目 AGENTS.md 的认知维护托管块（`<!-- project-cognition:start -->`）由它 upsert。
  - local-store —— 项目黑白名单（~/.dsh/project-cognition.json）的串行化读写。
- 改动 shared/ 下模块前，先评估对 github-workbench 的影响（另一消费方）；本仓库自带 29 例测试（node --test test/），是共享模块改动的回归基准。
- client.js 的 gate 传感器以 ../shared/session-gate/index.js 为权威算法（ remember-close 语义已与 workbench 对齐）；改启发式先改共享模块再移植。
- 提交习惯：本仓库单独提交；涉及 shared/ 时在提交信息中注明模块指纹。
