# S3-C 任务卡：fresh retry 与 Run 恢复 app 集成

> **historical/superseded**：下文保留最初 app 集成的范围与 fixture 证据；不再限制后续 conformance 状态。最终真实模型与闭合证据见 [S3 closure](s3-closure.md)、[build-plan](../build-plan.md) 和 [conformance](../conformance.md)。

- **状态**：实现完成；app 4 个场景通过真实 DSH `0.2.2-alpha.2` + scripted chat fixture。
- **Worktree**：`/home/ROXY/code/singularity-v1-swarm-recovery`
- **分支**：`s3-c-swarm-recovery`，基线 `ec8d084`（S3-B2 单 Run 执行闭环）。
- **Runtime**：保留本分支 `f8b7054` 的 `recovery.ts` + `run.ts` 实现；未采用并行分支的另一份 runtime/run.ts。
- **集成方式**：cherry-pick 集成分支 `s3-c-swarm-integration` 的 app 测试与任务卡提交 `2d764c3`、`a246dca`、`8ff5137`、`e771148`；测试与任务卡按本分支公开 API/返回字段调整，未修改生产实现来迎合另一实现。

## Goal

在 app 集成层用真实 DSH profile 验证 S3-C 的两条恢复路径：

1. **fresh retry**：第一次 Run 普通文本 no-submission 结算 failed `ExecutionRecord` 后，按固定 retry policy 以新 `runId`/`sessionId`/workspace 开 attempt 2；合同与 Method 不变，旧 manifest/receipt 不自动复用，重新 submit + verifier 后才 verified；两次事实链和旧记录保留。
2. **resume**：从 `run/opened` 读取冻结 composition，先比较完整实际 composition。mismatch 时 Agent create/resume 和模型请求均为 0，写 invalid `ExecutionRecord` 与 `run/closed`，不写 Evidence；match 时复用已 admitted 的 stable wake，不重复购买模型请求；已 submit 的 Run 只从同一 CAS snapshot 以固定 `operationId` 恢复验收。

## Spec refs

- `docs/framework.md` §4.1、§4.3、§9.2、§10.2–§10.3、§11.2–§11.5、§15.3、§19.1。
- `docs/amendments/002-acceptance-and-submission.md` A0–A9。
- `docs/build-plan.md` S3、S3-C。
- `docs/conformance.md` C-03、C-12；本卡不升级 conformance 状态。

## 允许修改范围

- `apps/singularity/test/run-recovery.test.ts`
- 本任务卡
- app 集成所需的 `apps/singularity/package.json`、`apps/singularity/tsconfig.json` reference、`pnpm-lock.yaml` workspace 依赖（基线缺少，已纳入集成提交）
- 不改 runtime 生产实现、既有 runtime/协议测试、规范、spec lock 或 conformance 状态

## 非目标

- 不实现第二 writer、第二模型 loop、tool/skill registry、transcript mirror、TS MCP 转接层或 DSH patch。
- 不实现 child 分解、replacement、feedback、RSI 或真实模型证据。
- 不修改 `docs/framework.md`、`spec-lock.json`、`docs/conformance.md`，不把 C-03/C-12 标为 proven。

## 共享 API 与本分支返回字段

Runtime 在既有 `executeSingleRun` 同一执行面上新增：

```ts
retrySingleRun(request): Promise<RetrySingleRunResult>
resumeSingleRun(request): Promise<ResumeSingleRunResult>
```

- `retrySingleRun` 输入 `ctx/journalRoot/previousRunId/runId/sessionId/workspace/agentOptions/maxOutputBytes/verifier/transientInvalidReasons`，可选 `composition`；若提供则必须与冻结 Composition 完整相等。
  - 从 journal 读取上一 `task/admitted`、`run/opened`、`run/closed`；合同与 Method 来自冻结合同，调用方不能替换。
  - 用 protocol `decideRetryPolicy` 判定；要求上一 Run 是 Task 的最新 attempt，且新 `runId`/`sessionId` 与上一 Run 不同。
  - 新 `workspaceKey` 固定为新 `runId`；workspace 由调用方提供为 fresh 目录并按合同输入重新准备。
  - 通过既有 `executeSingleRun` 写新 attempt，因此新 Run 必须重新 submit、重新验收；旧 manifest/receipt 不复制。
  - 返回 `previousRunId`、`attempt`、`retryPolicy`，并继承 `ExecuteSingleRunResult`。
- `resumeSingleRun` 输入 `ctx/journalRoot/runId/workspace/composition/agentOptions/maxOutputBytes/verifier/transientInvalidReasons`。
  - 返回额外字段：`compositionMatched`、`sessionAction: 'none' | 'created' | 'resumed'`、`wakeOutcome?: 'sent' | 'already-admitted'`、`recoveredSubmission`。
  - 先读取 `run/opened` 的冻结 composition，按完整 payload canonical 比较实际 `composition`，覆盖全部字段与 refs，不比较 preset 名。
  - mismatch/corrupt：不 acquire Agent，不调用 verifier；写 `ExecutionRecord(invalid)` + `run/closed(invalid)`，composition mismatch 按非 retryable 关闭 Task，不写 Evidence；`sessionAction='none'`、`wakeOutcome=undefined`、`compositionMatched=false`。
  - 已存在 `run/submitted`：只从 CAS 读取冻结 manifest，以 `${runId}:verify` 调用 independent verifier，写 Evidence/`run/closed`；不重新冻结、不回读活动 workspace、不追加 `run/submitted`。无 live session 时 usage 记 `unknownRequests: 1`，不声称 0；`sessionAction='none'`、`wakeOutcome=undefined`、`recoveredSubmission=true`。
  - 否则：`prepareWorkspace` 后优先 `agents.resume` 同一 session（不存在则 create 同一 intent），按 wake id 与正文检查 raw session；已 admitted 的 start wake 不再发送，只执行一次 `whenIdle`，随后走既有 submit/ExecutionRecord 结算。`sessionAction='resumed'|'created'`、`wakeOutcome='already-admitted'|'sent'`。
  - start wake 正文由 `run/opened.at` + 零 usage 的确定性剩余百分比派生；resume 重新计算得到同一正文，因此已 admitted 的稳定 wake 通过正文检查且不重发。

## 先失败测试

红测试提交 `2d764c3`，在 runtime 尚无恢复导出时：

```bash
cd apps/singularity
node --test test/run-recovery.test.ts
```

实际结果：

```text
SyntaxError: The requested module '@singularity/runtime' does not provide an export named 'resumeSingleRun'
tests 1 / pass 0 / fail 1
```

## 场景与断言

### 1. fresh retry

- 第一次 Run：fixture 普通文本 turn/end，无 submit；`run/closed` failed 且引用 `ExecutionRecord(no-submission)`，`retry.allowed=true`（`maxRuns=2`），Task 保持 open。
- `retrySingleRun`：新 `runId`/`sessionId`/workspace；`run/opened.attempt=2`，`workspaceKey` 与旧 Run 不同；`composition` 内容 digest 不变但新 Run 写自己的 composition 对象；`retryPolicy.allowed=true`，`previousRunId`/`attempt` 与旧 Run 对齐。
- 第二次 Run：fixture 依次 `singularity_read(self)`、`singularity_plan`、native `bash` 写 `result.txt`、`singularity_submit`；verifier 以 `${secondRunId}:verify` 通过。
- 断言事实顺序：`task/admitted → run/opened(1) → run/closed(1) → run/opened(2) → run/submitted → run/closed(2) → task/closed(verified)`。
- 旧 `run/opened`/`run/closed` digest 与旧 `ExecutionRecord` 保留且可重读；新 Run 无旧 receipt，新 Evidence/receipt 与旧记录不同。
- 新 workspace 在 verifier 冻结后被改写，旧 workspace 无输出，证明 attempt 2 使用独立 workspace。

### 2. composition mismatch

- 手工写 `task/admitted` + `run/opened`（无 Agent/session），改变完整 composition 的 `platformPrompt`。
- `resumeSingleRun` 返回 invalid；`agents.create`/`agents.resume` 计数均为 0，fixture 模型请求为 0，verifier 未调用。
- `sessionAction='none'`、`wakeOutcome=undefined`、`compositionMatched=false`、`recoveredSubmission=false`。
- 写 `ExecutionRecord(invalid)` + `run/closed(reason=composition-mismatch)` + `task/closed(invalid)`；`run/closed` 无 `evidenceRef`，结果无 Evidence；usage 以 `unknownRequests>0` 表达未知，不声称零成本。
- 只有一个 `run/opened`。

### 3. match resume 的 stable wake

- 手工写 `task/admitted` + `run/opened`，先用同一 `sessionId` 创建并持久化一个已消费 start wake；wake 正文使用本分支 `startWakeText` 的确定性结果（与恢复时重新计算一致），dispose 后调用 `resumeSingleRun`。
- `agents.resume=1`、`agents.create=0`；恢复期间新增 `user/message(id=runId:start)` 为 0，新增 `turn/start` 为 0；fixture 请求数保持 1。
- `sessionAction='resumed'`、`wakeOutcome='already-admitted'`、`compositionMatched=true`、`recoveredSubmission=false`。
- 无提交按 no-submission failed `ExecutionRecord` 结算；usage 来自恢复后的 raw session（steps=1，unknownRequests=0）。

### 4. 提交后恢复

- 手工写 `task/admitted` + `run/opened` + `run/submitted`，manifest/output 已通过 `freezeSubmission` 写入 CAS；随后改写活动 workspace 输出。
- `resumeSingleRun` 不 acquire Agent，模型请求为 0；verifier 只收到冻结 inputs/outputs 与 `${runId}:verify`，读到旧的冻结 bytes。
- `sessionAction='none'`、`wakeOutcome=undefined`、`compositionMatched=true`、`recoveredSubmission=true`。
- 不追加 `run/submitted`；写 Evidence + `run/closed(verified)` + `task/closed(verified)`；Evidence/`run/closed` usage canonical-equal，且无 session 可重放时 `unknownRequests=1`。

## 检查命令

```bash
HOME=/tmp/s3c-home PNPM_HOME=/tmp/s3c-home/pnpm-store \
  PATH=/tmp/node249/bin:/home/ROXY/code/bb_work/env/BB/buckyball/result/bin:$PATH \
  pnpm verify
git diff --check
```

## 实现与验证记录

- 保留 runtime：`s3-c-swarm-recovery` 的 `f8b7054`（`recovery.ts` + `run.ts`），含 10 个 runtime recovery 测试。
- 集成 cherry-pick：
  - `2d764c3` test: add failing S3-C retry and recovery integration（app 依赖 + 红测试）
  - `a246dca` test: tighten S3-C workspace and wake recovery evidence
  - `8ff5137`、`e771148` docs: record/finalize S3-C evidence
- 测试对齐：`agentAction` → `sessionAction`；`wake='not-delivered'` → `wakeOutcome=undefined`；`wake='already-admitted'` → `wakeOutcome='already-admitted'`；新增 `compositionMatched` 与 `retryPolicy.allowed` 断言；stable wake 种子正文改用本分支确定性 `startWakeText`。未放宽任何场景断言。
- app 局部验证：

```bash
cd apps/singularity
pnpm typecheck   # pass
pnpm lint        # pass
node --test test/run-recovery.test.ts   # 4/4 pass
```

- 根 `pnpm verify`：`verify:project`、`tsc -b`、3 个 workspace typecheck/lint/test 全部通过；protocol `225/225`、runtime `54/54`、app `15/15`（原有 11 + 本切片 4），合计 `294/294`；`git diff --check` 通过。

## 未覆盖项

- 未执行 crash-after-provider-receipt 子进程场景；提交后恢复在无 live session 时只能保守记录 `unknownRequests=1`，本切片不通过 persistence 重新读取完整 usage。
- 不处理已在 registry 中 live 的 Agent 接管/取消；`resumeSingleRun` 在检测到 live Agent/session 时 fail closed，最终一致性仍由 operator/后续 drain 负责。
- 未验证真实模型行为；fixture 只证明协议、DSH composition、wake 去重与 CAS 恢复路径。
- C-03/C-12 及全部 conformance 仍为 `unproven`；本切片不修改规范、spec lock 或 conformance 状态。
