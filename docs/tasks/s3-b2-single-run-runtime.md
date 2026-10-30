# S3-B2 任务卡：单 Run 执行闭环 runtime

> **historical/superseded**：本切片已集成完成；原任务范围与下文证据只记录当时状态。当前阶段和最终证据以 [S3 closure](s3-closure.md)、[build-plan](../build-plan.md) 和 [conformance](../conformance.md) 为准。

- **历史状态**：实现共享 `executeSingleRun`，不实现第二 writer、第二模型 loop、registry、transcript 或 TS MCP 转接层。
- **分支**：`s3-b2-swarm-runtime`，基线 `315ece9`（S3-B1 acceptance/submission schema）。

## Goal

在 `@singularity/runtime` 中实现单 Run 执行闭环：root admit → `run/opened` → DSH Agent create/setup → 稳定 wake → 一次 `whenIdle` → 无提交结算或独立 verifier 只读 CAS 验收 → Evidence/ExecutionRecord → 按既有 retry policy 决定是否关闭 Task。

## Spec refs

- `docs/framework.md` §4.0、§9–§11、§12–§15、§19.1。
- `docs/amendments/002-acceptance-and-submission.md` A0–A9。
- `docs/build-plan.md` S3、S3-B。

## 允许修改范围

- `packages/singularity/runtime/package.json`、`pnpm-lock.yaml`、runtime `src` 与 tests。
- `packages/singularity/protocol/src/acceptance.ts`：仅 Evidence/VerifyRequest 必要扩展。
- `packages/singularity/protocol/src/reducer.ts`：仅导出既有 retry 决策复用。
- 本任务卡。

## 非目标

- 不实现 child 分解、replacement、feedback、RSI、真实模型证据。
- 不实现第二 writer/fold/wake authority、tool/skill registry、transcript mirror 或 TS MCP 转接层。
- 不修改 `docs/framework.md`、`spec-lock.json`、`docs/conformance.md`，不升级 conformance 状态。

## Done when

- 共享 `executeSingleRun` 接受 `ctx/journalRoot/workspace/sessionId/runId/admission/composition/agentOptions/maxOutputBytes/verifier/transientInvalidReasons`，返回 manifest、runFact、taskFact?、evidence?/executionRecord?。
- CAS 使用正确 domain：contract、composition、evidence、object；`run/opened` 先于 Agent create。
- 稳定 wake 从 raw session 去重；单次 `whenIdle`；worker card/NodeView 只显示剩余百分比。
- self read + PlanningSketch 门禁覆盖 Task tools 与 base tools；submit 冻结 no-follow 路径、symlink 拒绝与 size cap，并 `concludeTurn`。
- 独立 verifier 只通过只读 `readObject(ref, domain)` 读取 CAS，不读活动 workspace；host 校验 receipt 身份/digest/criteria/exit/timedOut，verifier 自报 verdict 无效。
- 无提交/stop/基础设施失败写 `ExecutionRecord`；verified/failed 写 Evidence；`run/closed.usage` 与结果内嵌 usage canonical-equal。
- 按既有 retry policy 决定是否写 `task/closed`。
- 根 `pnpm verify` 通过，实际运行命令、证据与未覆盖项记录在本卡。

## 检查命令

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

## 失败证据（实现前）

基线 `315ece9` 只含 runtime store/service 与 protocol acceptance/submission schema。先加入：

- `packages/singularity/runtime/test/single-run-smoke.test.ts`
- `packages/singularity/protocol/test/evidence.test.ts`

在 `packages/singularity/runtime` 执行 `node --test test/single-run-smoke.test.ts`，实际报 `SyntaxError: ... does not provide an export named 'executeSingleRun'`；在 protocol 执行 `node --test test/evidence.test.ts`，实际报 `does not provide an export named 'sealEvidence'`。失败原因是共享执行面和 Evidence schema 尚不存在，不是断言放宽。

## 实现与证据

### 实现切片

- `src/run.ts`：单一 `executeSingleRun`（root task/admitted → run/opened → DSH create/setup → stable wake → 一次 `whenIdle` → submit verify 或 ExecutionRecord → run/closed → retry policy → 可选 task/closed）；单 `CommandService` writer；返回 manifest/runFact/taskFact?/evidence?/executionRecord?。
- `src/prompt.ts`：固定 worker card（≤2 KiB）、required NodeView（≤8 KiB）、剩余预算百分比；不暴露精确 token/step/deadline。
- `src/tools.ts`：DSH scoped `singularity_read/plan/submit/stop` + 同一 guard 覆盖 base/domain tools；read self + 当前 epoch PlanningSketch 门禁；submit 无 follow 冻结、`concludeTurn`。
- `src/workspace.ts`：input copy-to-work、file/tree no-follow freeze、symlink/非普通文件/越界 path/size cap 拒绝、确定性 tree manifest、strict SubmissionManifest。
- `src/verification.ts`：独立 verifier request 只含 frozen task/inputs/outputs 与只读 `readObject`；host 使用 protocol `validatePublicReceipt` 派生 verified/failed/invalid；invalid 不写 Evidence。
- `src/wake.ts`：从 raw DSH session `agent/inbox/spliced`/`user/message` 判定 stable wake；pending/removed/corrupt fail closed。
- `src/epoch.ts`：session/end-seed 与成功 compaction 墓碑派生 contextEpoch；`initialContextEpoch` 可由 app 在首个请求前预计算。
- `protocol/acceptance.ts`：`VerifyRequest`、strict `Evidence` schema（evidence domain）、`sealEvidence`/`verifyEvidence`/`validateEvidence`。
- `protocol/reducer.ts`：把既有 retry 判定提取为纯 `decideRetryPolicy`，runtime 与 reducer 共用同一策略。
- `runtime/src/service.ts`：增加只写 CAS / 只读 CAS passthrough，保持单 writer；`runtime/src/store.ts` 修正获批 amendment 002 的 domain：`TaskContract.acceptance` 为 object、`Composition.contract` 为 contract（与 reducer 的 contract id/digest 比较一致）。

### 单元/仓库证据

```bash
HOME=$RUNTIME_HOME PNPM_HOME=$RUNTIME_PNPM PATH=/tmp/node249/bin:$PATH pnpm verify
git diff --check
```

实际结果：`verify:project`、`tsc -b`、3 个 workspace typecheck/lint 通过；protocol `225/225`、app `6/6`、runtime `44/44`，合计 `275/275`；`git diff --check` 通过。

### 真实 DSH app 组合 smoke（临时、未提交）

在 `.tmp/` 使用真实 `bootSpikeProfile` + chat-completions fixture（DSH `0.2.2-alpha.2`、Node `24.9.0`）运行 `executeSingleRun`：

```bash
HOME=$RUNTIME_HOME PATH=/tmp/node249/bin:$PATH node --test \
  .tmp/single-run-integration.test.ts .tmp/single-run-settlements.test.ts
```

实际结果 `1/1` + `3/3`，合计 `4/4` 场景通过：

- verified：fixture 依次 `singularity_read(self)` → `singularity_plan` → bash 写 `out.txt` → `singularity_submit`；4 个模型请求、断言事实顺序 `task/admitted → run/opened → run/submitted → run/closed → task/closed`，manifest/receipt 通过 protocol validator，`reduceTaskRunFacts` 得到 verified Task/Run，Evidence usage=run/closed usage，sessionCut 指向 Run session；verifier 在调用中改写 workspace 后仍只从 CAS 读到冻结 bytes。
- no-submission：普通文本 turn/end 产生 failed ExecutionRecord，无 manifest/receipt/Evidence，事实顺序 `task/admitted → run/opened → run/closed → task/closed`，Task 按 maxRuns=1 关闭 failed。
- invalid verifier：`timedOut=true` 产生 invalid ExecutionRecord，`run/closed.reason=verifier-timeout`，不写 Evidence、不引用 invalid receipt，Task 关闭 invalid。
- symlink 负例：submit 冻结拒绝 symlink，未产生 `run/submitted`，Run 按 no-submission failed 结算。
- CAS domain 实测：contract 以 contract、composition 以 composition、Evidence 以 evidence、manifest/receipt/tree/file/ExecutionRecord 以 object 读取；comp/reducer 接受完整事实链。

## 未覆盖项

- 未实现 resume/崩溃后 in-flight Run 恢复：已有 `run/opened` 会拒绝重入；没有按 DSH session 状态 resume 同一 intent。
- 未实现 S4 child decompose/replacement/feedback、preview/read receipt、ancestor query、skills/MCP/exploration mount；出现这些资源时 fail closed（`UNSUPPORTED_RESOURCES`）。
- 未实现 step/token/deadline 的硬取消 guard；NodeView/wake 只显示剩余百分比，模型可能在 `whenIdle` 前超过 limits。
- 未实现 agent create/wake/whenIdle/verifier 的宿主 timeout；没有 verifier exactly-once 查询恢复。
- read self 结果未强制 16 KiB 分页上限；NodeView 超限在 prompt assembly 时失败并结算 invalid，而非 admission 前收敛。
- 未验证真实模型行为；C-02/C-03/C-12 及所有 conformance 仍保持 `unproven`。fixture pass 只证明协议与 DSH 组合路径，不构成领域证据。

