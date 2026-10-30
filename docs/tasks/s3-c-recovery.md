# S3-C 任务卡：fresh retry 与 resume/恢复

> **historical/superseded**：S3 后续已完成；下文的范围、测试数和未验证结论属于本切片交付时。当前证据见 [S3 closure](s3-closure.md)、[build-plan](../build-plan.md) 和 [conformance](../conformance.md)。

- **历史状态**：runtime 切片已完成；当时 S3 整体未完成。
- **分支**：`s3-c-swarm-recovery`，基线 `ec8d084`（S3-B2 single-run）。
- **Worktree**：`/home/ROXY/code/singularity-v1-swarm-recovery`。

## Goal

在 `@singularity/runtime` 中新增 `retrySingleRun` / `resumeSingleRun`：从 journal 读取上一 Task/Run，按冻结 retry policy 创建 fresh attempt/session/workspace；或从 `run/opened` 读取原 Composition，先用完整 Composition 比较实际装配，mismatch 零 Agent/模型请求并写 invalid `ExecutionRecord` + `run/closed`；match 时 resume 同一 DSH session 且稳定 wake 不重复购买。提交后恢复只使用同一 CAS submission snapshot 与固定 `operationId` 补写 closure；不可核对或超时写 invalid，不盲目重跑 verifier/模型。

## Spec refs

- `docs/framework.md` §4.1、§9.1–§9.2、§11.4–§11.5、§12.4、§15.3、§19.1。
- `docs/amendments/002-acceptance-and-submission.md` A0–A9。
- `docs/build-plan.md` S3、S3-C。
- `docs/conformance.md` C-03、C-11、C-12。

## 允许修改范围

- `packages/singularity/runtime/src/run.ts`、`src/recovery.ts`、`src/verification.ts`、`src/wake.ts`、`src/index.ts`
- `packages/singularity/runtime/test/recovery.test.ts` 及相关 runtime tests
- 本任务卡
- 不改 `docs/framework.md`、`spec-lock.json`、`docs/conformance.md`，不升级 conformance 状态

## 非目标

- 不实现第二 writer/fold/wake authority、第二模型 loop、tool/skill registry、transcript mirror、DSH patch 或兼容 shim。
- 不实现 S4 child/replacement/feedback/ancestor、skills/MCP/exploration mount、硬取消或宿主 timeout。
- 不新增 protocol fact/type/字段；只复用既有 reducer retry policy 与 acceptance schema。
- 不自动发布、不 push/reset/rebase。

## API 形状

```ts
retrySingleRun({
  ctx, journalRoot, workspace, previousRunId, runId, sessionId,
  agentOptions, maxOutputBytes, verifier, transientInvalidReasons?, composition?,
})

resumeSingleRun({
  ctx, journalRoot, workspace, runId, composition,
  agentOptions, maxOutputBytes, verifier, transientInvalidReasons?,
})
```

- retry 从 `task/admitted` 读取冻结合同、从上一 `run/opened` 读取 Composition；不接收第二份合同权威。新 attempt 为既有 Run 数 + 1，新 session/workspace 必须与旧值不同。
- resume 从 `run/opened` 读取原 Composition，比较完整 payload（含 dsh config、platformPrompt、template、resources、modelRoute、seed、skills/MCP 列表），不只比较 preset 名。
- mismatch 写 `ExecutionRecord(invalid, reason=composition-mismatch)` + `run/closed(invalid)` + `task/closed(invalid)`，不创建 Agent、不调用 verifier。
- match 且未提交：`agents.resume` 同一 session；无持久 session 时按恢复表以同一 session intent create；稳定 `${runId}:start` wake 已 admitted 时不重发。
- match 且已提交未关闭：只读 `run/submitted.outputs` 的 CAS manifest 与合同输入，复用 `${runId}:verify` operationId 调 verifier；receipt 身份/digest 可核对则补写 Evidence+`run/closed`，timedOut/畸形/manifest 不可核对写 invalid `ExecutionRecord`，不重新 submit、不重跑模型。
- `run/closed` 已存在时幂等返回；缺 `task/closed` 且 retry policy 不允许继续时补写 Task closure。

## Done when

- 先有失败测试：`recovery.test.ts` 在实现前因缺失 `retrySingleRun`/`resumeSingleRun` 失败，并记录实际错误。
- retry：policy 拒绝（未关闭/verified/maxRuns/deadline/unknown usage）零新 fact；允许时新 `run/opened` attempt+1、新 session/workspace，合同/Method/Composition 不变，旧 `run/closed`/ExecutionRecord 保留，旧 receipt 不复用。
- resume mismatch：零 Agent 调用与零 verifier 调用，写 invalid ExecutionRecord+run/closed(+task/closed)，事实链可被 reducer 接受。
- resume match/open：`agents.resume` 被调用，已 admitted wake 不重发、不产生第二次购买；settle no-submission/invalid 时写 ExecutionRecord。
- resume match/submitted：verifier 收到同一 manifest/input/output refs 与 `${runId}:verify`；verified/timeout 分别补写 Evidence 或 invalid ExecutionRecord；重复 resume 不重复验证。
- 根 `pnpm verify` 与 `git diff --check` 通过；实际命令、证据、未覆盖项写回本卡。

## 检查命令

```bash
HOME=/tmp/s3c-home PNPM_HOME=/tmp/s3c-home/pnpm-store \
  PATH=/tmp/node249/bin:/home/ROXY/code/bb_work/env/BB/buckyball/result/bin:$PATH \
  pnpm verify
git diff --check
```

## 失败证据（实现前）

基线只含 `executeSingleRun`，没有 recovery 入口。先加入 `packages/singularity/runtime/test/recovery.test.ts`，在 runtime 包执行：

```bash
PATH=/tmp/node249/bin:$PATH node --test test/recovery.test.ts
```

实际结果：

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'/home/ROXY/code/singularity-v1-swarm-recovery/packages/singularity/runtime/src/recovery.ts'
imported from .../test/recovery.test.ts
tests 1 / pass 0 / fail 1
```

失败原因是共享 `retrySingleRun`/`resumeSingleRun` 尚不存在，不是断言放宽。该测试覆盖 retry policy 拒绝零新 fact、fresh attempt/session/workspace、mismatch 零 Agent/verifier、submitted recovery 同 operationId、timeout invalid、不可核对 submission invalid、resume stable wake 不重发、缺持久 session 时 create 同一 intent。

## 实现与证据

### 实现切片

- `src/recovery.ts`：新增 `retrySingleRun` / `resumeSingleRun`。retry 用只读 `DomainStore` 从 journal 读取 `task/admitted` 合同、上一 `run/opened` Composition、`run/closed` usage 与 `decideRetryPolicy`；关闭只读 store 后才调用共享 `executeSingleRun`，保证任何时刻只有一个 CommandService writer。resume 打开一个 CommandService，从 `run/opened` 读取冻结合同/Composition，先做完整 canonical Composition 比较，再分派 mismatch / submitted recovery / open resume / closed reconcile。
- `src/run.ts`：把单 Run 执行拆成 `openSingleRun`、`continueOpenedRun`、`drivePreparedRun`、`completeSubmittedRun`、`closeOpenedRunInvalid`、`reconcileClosedRun` 与共享 `readRunJournalView`。新增 `compositionPayloadOf`/`compareCompositionPayload`、frozen submission 校验、closed-run 幂等 reconcile 和共享 retry decision。未新增第二 writer、第二 fold、第二 wake authority 或第二模型 loop。
- 稳定 wake：start wake 文本改为由 `run/opened.at` 与零 usage 决定，不再使用实时时钟；resume 重新计算得到同一文本，`deliverWakeOnceOrFail` 对已 admitted 的 `${runId}:start` 返回 `already-admitted`，不会再次购买模型请求。
- `src/index.ts`：显式导出公开 `executeSingleRun`、`retrySingleRun`、`resumeSingleRun` 与既有 runtime API；内部 recovery/run 协作类型不进入包根。
- 提交后恢复：`run/submitted.outputs` 的 manifest 从 CAS 读取并 `validateSubmissionManifest`；输入/输出 snapshot 由合同与 manifest 派生，固定 `${runId}:verify`。receipt 身份/digest 可核对时补写 Evidence+`run/closed`；manifest 不可核对、`timedOut`、signal、invalid criterion 或身份不匹配时写 invalid `ExecutionRecord`，不写 Evidence，不重新 submit、不驱动模型。verifier 仍只通过只读 `readObject` 访问冻结 CAS。
- 幂等：`run/closed` 已存在时 `resumeSingleRun` 只读 reconcile，缺 `task/closed` 且 retry policy 不允许继续时补写 Task closure；不会重复验证或重新购买 Run。已关闭 Run 不会因 resume 时 composition mismatch 被降级或重写，旧 Evidence/ExecutionRecord 保留。

### 失败测试（实现前）

见上节 `ERR_MODULE_NOT_FOUND`；实现后同一测试 10/10 通过。

### 单元/仓库证据

```bash
HOME=/tmp/s3c-home PNPM_HOME=/tmp/s3c-home/pnpm-store \
  PATH=/tmp/node249/bin:/home/ROXY/code/bb_work/env/BB/buckyball/result/bin:$PATH \
  pnpm verify
git diff --check
```

实际结果：`verify:project`、`tsc -b`、3 个 workspace typecheck/lint 通过；protocol `225/225`、runtime `54/54`（既有 44 + recovery 10）、app `11/11`，合计 `290/290`；`git diff --check` 通过。

`packages/singularity/runtime/test/recovery.test.ts` 覆盖：

- retry：failed latest Run 允许；新 `run/opened` attempt+1、新 session/workspace；上一 failed Evidence 与 ExecutionRecord digest 保留；verified/maxRuns 拒绝且零新 fact；复用旧 session 拒绝。
- resume mismatch：不同 `platformPrompt`（完整 Composition 比较，不是 preset 名）零 Agent/verifier 调用，写 invalid ExecutionRecord + `run/closed` + `task/closed`，再次 resume 幂等。
- resume submitted：同一 manifest/input/output refs 与 `${runId}:verify` 调 verifier；verified 补写 Evidence+Task closure；timeout 写 invalid ExecutionRecord 且 transient retry 保留；manifest 不可核对时 verifier 零调用并 invalid；重复 resume 不重复验证。
- resume open：`agents.resume` 同一 session，已 admitted wake 不重发、`followup` 0 次；持久 session 缺失时以同一 session intent create；两者都按 no-submission 结算。

### 真实 DSH 组合 smoke（临时、未提交）

在 `.tmp/s3c-recovery-smoke.test.ts` 使用真实 `bootSpikeProfile`（DSH `0.2.2-alpha.2`、Node `24.9.0`）与 scripted chat fixture 运行：

```bash
HOME=/tmp/s3c-home PATH=/tmp/node249/bin:/home/ROXY/code/bb_work/env/BB/buckyball/result/bin:$PATH \
  node --test .tmp/s3c-recovery-smoke.test.ts
```

实际结果 `2/2` 通过：

- composition mismatch：真实 DSH profile 下 fixture 请求数 `0`，`run/closed(invalid, composition-mismatch)` 与 `task/closed(invalid)` 写入。
- resume + retry：先用同一 DSH profile 创建 session、发送稳定 `${runId}:start` wake、结束一个 no-submission turn、flush 并 dispose；随后 `resumeSingleRun` 走真实 `agents.resume`，`wakeOutcome=already-admitted`，fixture 请求数保持 `1`；再 `retrySingleRun` 创建 attempt 2/session 2，fixture 只新增 `1` 个请求，旧 Run closure 保留，Task 按 maxRuns=2 关闭 failed。

该 smoke 使用 fixture 模型，不是真实模型证据；不升级任何 conformance 状态。

## 未覆盖项

- 未用真实模型验证 retry/resume；真实 DSH smoke 只证明 composition 装配、`agents.resume`、stable wake 去重与 fresh attempt 路径。
- submitted recovery 在没有 live session 时无法读取原 DSH usage，只能记录 `unknownRequests=1`；该未知 usage 会按固定 retry policy 阻止 further retry。恢复 verifier 仍按固定 `operationId` 调用；runtime 无法在不调用 verifier 的情况下枚举 CAS 中既有 receipt，因此 verifier 必须是 `operationId` 幂等/可查询的固定 broker。
- `run/submitted` fact 未落盘但 manifest CAS 已写的窗口没有自动恢复：Run 仍 open，模型需重新 submit，runtime 不扫描 orphan CAS。
- workspace freshness 是 host 输入约束；journal 只保存 `workspaceKey`，runtime 无法证明新 workspace 路径与旧路径不同。
- 未实现硬取消、宿主 timeout、in-flight turn 的继续执行、child/replacement/feedback/ancestor、skills/MCP/exploration mount、preview/read receipt。
- 不改 `docs/framework.md`、`spec-lock.json`、`docs/conformance.md`；C-03/C-11/C-12 保持 `unproven`，S3 整体未完成。
- 基线 `ec8d084` 的 app 测试 import `@singularity/runtime`/`@singularity/protocol`，但 committed app manifest 未声明这两个 workspace 依赖；本 worktree 为运行根 `pnpm verify` 在本地应用了父 checkout 已有的未提交 app `package.json`/`tsconfig` 变更与 lockfile 更新，但未纳入本 runtime 提交，最终 diff 只含 runtime/docs/tests。
