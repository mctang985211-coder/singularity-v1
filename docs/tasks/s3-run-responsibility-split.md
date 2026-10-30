# Run 职责归位与同语义拆分

> **historical/superseded**：本卡保留首次职责拆分的实施与 live 证据。后续结算边界已进一步归位，当前模块归属和规模见 [S3→S4 结构交接](s3-s4-structure-handoff.md) 与 `AGENTS.md`。

## Goal / Spec refs

将 S3 集中在 `run.ts` 的 DSH 生命周期、Run 编排和恢复执行按 framework §3 归入独立模块；重写项目约束，使用正向职责语言和正确示例，让后续 S4–S7 沿同一边界扩展。

- Spec refs：framework §2–§3、§9–§15.3、§19.1、§21、§23.1；build-plan S3/S4；AGENTS 的工作流与证据要求。
- 允许范围：runtime `run.ts`、现有 `recovery.ts`、新 `agent.ts`/共享错误与恢复执行模块、对应 imports、AGENTS 和当前任务/构建文档。
- 非目标：保持公开协议、fact、guard、可见内容、状态、验收和副作用语义；不进入 S4，不改变依赖版本，不新增 writer、fold、registry、模型 loop、工具协议或领域行为。
- Done when：DSH create/resume/setup/wake/dispose 位于 `agent.ts`；Run admission/drive/settlement 位于 `run.ts`；恢复执行与 journal/Composition 读取位于恢复模块；包级公开 API 保持兼容；根验证和既有真实模型场景通过；最终 diff 无循环运行时依赖和旧职责注释。
- 检查：指定 Node 24 下 `pnpm install --frozen-lockfile`、根 `pnpm verify`、`git diff --check`，以及默认路由的 live app 场景。

## 模块边界

- `errors.ts`：共享 `SingleRunError` 与稳定内部错误码，消除运行时循环依赖。
- `agent.ts`：仅协调 DSH Agent 生命周期、session 使用量和 wake/drain；返回宿主观察，不决定 Task/Run verdict。
- `run.ts`：仅编排 admission、open/drive、预算、提交、验收结算与 NodeView。
- `recovery-execution.ts`：继续、恢复和关闭既有 Run，读取 frozen journal/Composition/submission；复用 `run.ts` 的结算与 `agent.ts` 的 session 观察。
- `recovery.ts`：保留 retry/resume 的宿主入口、固定 retry policy 和 fresh workspace 检查，调用恢复执行模块。

拆分只移动现有职责和必要的内部类型，不建立平行执行路径。结构示例写入 AGENTS，作为后续实现指引而非新增协议。

## 最终结构与验证

- `run.ts` 从 **1943** 行降为 **1129** 行，保留 Run admission/open/drive、预算、提交、验收结算和 NodeView。
- `agent.ts` **329** 行，负责 DSH create/resume/setup/wake/dispose、job drain 和 session usage/cut；`recovery-execution.ts` **580** 行，负责既有 Run 的恢复与 frozen 读取；`recovery.ts` **449** 行，保留宿主 retry/resume 策略；`errors.ts` **27** 行，提供共享错误类型。
- 包级 `executeSingleRun`、`retrySingleRun`、`resumeSingleRun`、结果类型和 `SingleRunError` 保持兼容。运行时依赖为 `run → agent`、`recovery → recovery-execution → run/agent`，共享错误独立，无运行时循环、第二 writer/fold/registry 或新公开协议。
- `AGENTS.md` 已重写为正向职责约束，包含模块职责表、正确调用示例、消费者驱动和证据驱动的工作法；README/build-plan 已链接本卡。

指定 Node `24.22.2`、pnpm `11.18.0` 下，frozen install 与根 `pnpm verify` 通过 **341/341**（protocol 225、runtime 85、app 31）；`git diff --check` 通过。framework/spec-lock 和依赖 manifest/lockfile 未改。

最终代码使用默认 chat 路由、`deepseek-v4.1-flash`、`reasoning=max` 完成全部 live app 场景 **31/31**：C-02 Evidence `sha256:932a8cd476a412c72eb980a38c47bcf0e89f90af0be8353896e064bca37b9bc0`，C-03 Evidence `sha256:af1d59d9fbc557a57c427c80940e898d166eae4cc9b052e1531a6b7c38068474`，C-11 全量 replay 7 facts 且 torn-tail 正确截断，C-12 match/mismatch 均通过。usage 继续使用真实计量，C-12 mismatch 保留 `unknownRequests=1`。

一次 C-02 live 首次尝试中，模型先提交自定义 PlanningSketch 字段，guard 返回 `INVALID_ARGUMENT`；模型随后在第 3 步使用正确 schema，并成功 bash/submit。该记录证明既有参数 guard 与修正路径有效，不是拆分回归；临时 trace 已移除，最终交付不包含诊断输出。

本卡是同语义职责重构证据，不增加新的 conformance 场景，也不改变 C-02/C-03/C-11/C-12 的既有状态。S4 沿 AGENTS 的模块表扩展 Method/child 行为。
