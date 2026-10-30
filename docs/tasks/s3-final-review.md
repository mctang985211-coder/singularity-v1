# S1–S3 最终复核与 S4–S7 自主施工交接

## Goal / Spec refs

依据用户本次授权，复核已知 S1–S3 缺陷，修复全历史 retry workspace 校验与文档入口问题，形成持续推进 S4–S7 的正向派发指令。

- Spec refs：framework §3、§4.2、§9.2、§19.1、§22–§24；build-plan S4–S7。
- Allowed scope：recovery 的 freshness guard 与回归测试、非语义文档修订及 digest 同步、项目工作约束和后续派发文档。
- Non-goals：保持冻结协议、验收权和依赖版本；本任务不实施 S4–S7、不购买模型请求、不激活生产 Method。
- Done when：第三次 retry 拒绝复用更早 attempt 的目录或别名，历史 cwd 不可核对时拒绝；文档权威入口与当前状态一致；后续授权、逐片出口、遗留项 owner 和证据边界可执行。
- Verification：先运行历史目录复用负例，再修复并运行根 `pnpm verify`、`git diff --check`；编辑性规范差异和新 digest 单独登记。

## Structure done when

复用 `recovery.ts` 的同一个 freshness guard，从 journal 的本 Task 历史 session IDs 与 DSH SessionHeader.cwd 核对全部 attempt；沿用现有错误与测试 fixture。新增行为保持在既有恢复职责内，无新生产文件、公开导出、registry、状态或依赖。文档将唯一规范、当前施工状态和历史证据各自指向既有入口；S4–S7 全局派发指令集中在一个文件。

## Verification evidence

### Retry 缺陷与结构

- 旧 guard 只比较最新 Run 的 workspace。新增回归 `retrySingleRun checks every historical Run workspace before a third attempt` 在旧实现失败：`Missing expected rejection`，复现第三次尝试复用第一次目录。
- 修复后，在 runtime 包以 Node `24.22.2` 执行 `node --test --test-name-pattern='every historical Run workspace' test/recovery.test.ts`，`1/1` 通过。回归同时验证 canonical symlink、历史 cwd 缺失、拒绝时零新 fact/Agent，以及新目录的第三次执行成功。
- 2026-10-31 使用 Node `24.22.2`、pnpm `11.18.0`、DSH `0.2.2-alpha.2` 执行根 `pnpm verify`，project/build/typecheck/lint/test 全部通过：protocol `225/225`、runtime `86/86`、app `31/31`，合计 `342/342`，无失败或跳过；`git diff --check` 通过。app 本轮使用真实 DSH 与 fixture provider，LIVE=0。
- 生产修改集中于 `recovery.ts`：从已有 journal 获取本 Task 全部历史 session IDs，在同一 guard 中读取 DSH `SessionHeader.cwd` 并比较 canonical 路径。文件当前 `452` 行；无新增生产文件、公开导出、依赖、状态或写路径。既有 `run.ts` 保持 `726` 行、`run-settlement.ts` 保持 `427` 行。

### 规范与施工入口

本轮 `framework.md` 为 **editorial only**：权威文件名改为仓库真实入口，外部来源改成可移植资料身份，规范发布时范围与当前实现状态分开说明，并说明目录树表达职责。冻结类型、schema、guard、状态机、模型 card、权限和验收语义保持。

- 旧 SHA-256：`5f33aa339f21496c375de637ef447656fc66d98d3054a5b6e0a1d3c8dc612b6f`。
- 新 SHA-256：`6ee6d9e30af443530bc1ef4a8af5408b0963cceeffbce5b299c045ed0d2bf076`；同步 `spec-lock.json`。
- 项目门禁检查规范真实入口、来源链接的可移植性，以及 AGENTS/PR 模板的结构出口。
- README、AGENTS、build-plan 与 [S4–S7 整体派发入口](s4-s7-start-prompt.md)同步本轮自主施工授权、必要小规模验证预算和逐片行为/结构/证据出口；旧 S4 prompt 保留为专项说明，历史任务卡及 amendment 以当前状态和原有证据分别呈现。

### 剩余证据责任

各项 owner 与出口见 build-plan 的“S3 交接后的待验收项”。全历史 workspace 已修复并有专项 fixture；自动 compaction、不可停止进程的实际隔离、完整 Capsule、真实资源正文、强杀/持久化边界和最终执行卡的新 live 证明继续由 S4–S7 逐片验收。

本轮未购买真实模型请求、未生成新业务 Evidence、未升级 conformance，也未实施 S4–S7。已知缺陷的关闭覆盖本次实际复现和验证的范围。
