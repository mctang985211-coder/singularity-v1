# S3 → S4 结构出口与施工交接

## Goal / Spec refs

在现有 S3 行为与证据上完成一次有限的结构整理，为 S4 提供可执行的任务派发约束。

- Spec refs：framework §2–§3、§13–§14、§21、§23；不演进规范。
- 允许范围：Run 结算函数及其消费者、当前 S3 worker card 装配、AGENTS/PR 模板、构建计划与历史任务卡说明、S4 启动派发文件。
- 非目标：不实现 S4；不修改 framework/spec-lock、公开协议、DSH 依赖或既有验收强度；不机械拆分 store/reducer。
- Done when：原 Run/恢复行为保持，当前执行卡与可用工具面一致，历史状态不再被误作当前施工指令，S4 有逐片行为与结构出口。
- 检查：指定 Node >=24.9.0 / pnpm 11.18.0 下根 `pnpm verify`、`git diff --check`；本次不购买真实模型请求。

## Structure done when

- `run.ts` 保留 admission/open/drive、预算、NodeView；`run-settlement.ts` 拥有验收与无提交结算、retry 决策、结果构造及同一路径的 CAS/fact 提交辅助。
- `recovery-execution.ts` 直接复用同一结算模块，不再从 Run 编排模块取得结算函数；结算模块对 Run 数据类型只使用 `import type`。
- package index 的公开入口保持；新增内部导出均有当前消费者，无运行时循环依赖、第二 writer 或新 helper 杂物层。
- 任务卡与 PR 模板同时要求模块归属、依赖变化和大文件处理结果；超过治理触发线的文件须在任务内处理或记录有依据的例外。
- 规范 worker card 正文保留；S3 的执行卡不提前宣称分解、反馈、祖先查询或资源装配能力。本次不升级 conformance。

## Verification evidence

2026-10-31 在整合后的工作区使用 Node `24.22.2`、pnpm `11.18.0`、DSH `0.2.2-alpha.2` 执行根 `pnpm verify`，project/build/typecheck/lint/test 全部通过：protocol `225/225`、runtime `85/85`、app `31/31`，合计 `341/341`，无失败或跳过；`git diff --check` 通过。

- `run.ts` 从 `1129` 行降至 `726` 行；新增 `run-settlement.ts` 为 `427` 行。迁移的 14 个定义通过 AST 逐字核对（忽略导出修饰），函数正文保持。
- `recovery.ts` 与 `recovery-execution.ts` 直接导入结算模块；删除旧内部转导出，package index 保持。`run-settlement.ts` 仅 type-import Run 数据类型，无运行时反向依赖。
- 现有 prompt 预算测试同时核对完整规范卡的 2 KiB 上限与实际 S3 卡的四工具集合；未实现的 exploration renderer 明确拒绝。真实 DSH 的 scoped Composition、恢复、重试与结算在 app fixture 中回归通过。
- AGENTS、PR 模板、README 和构建计划同步要求结构出口；12 张旧任务卡明确标为历史证据。S4 的执行顺序、依赖和逐片交付要求见 [启动派发 prompt](s4-start-prompt.md)。
- `framework.md` 与 `spec-lock.json` 未变，规范 digest 保持 `5f33aa339f21496c375de637ef447656fc66d98d3054a5b6e0a1d3c8dc612b6f`。无新生产依赖、公开协议字段或业务 authority。

本次未购买真实模型请求、未生成新的业务 Evidence、未升级 conformance。既有真实模型证据仍见 `docs/conformance.md`；当前 prompt 变化只完成 fixture/DSH 回归，不被表述成新的 live 证明。S4 的 child、资源装配、反馈、摘要与探索行为继续未实现，后续依各片证据验收。
