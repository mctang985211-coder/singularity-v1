# S2-C4 任务卡：纯 Task/Run reducer

- **状态**：已完成（纯 protocol Task/Run reducer + 负例）；S2 Done when 的 C-01/C-05/C-11 纯协议正负例已覆盖，S2 完成。conformance 整体仍 unproven；下一 S3 单 Task/Run 闭环。Method/RSI reducer 属后续。runtime/FS/CAS IO/真实模型不在本切片。

## Goal

在 `@singularity/protocol` 中实现单一纯 Task/Run fold：消费已封存 `Fact[]` 与冻结 `ReplayContext`，按 journal 顺序重建 Task/Run 投影。reducer 只覆盖 `task/admitted`、`run/opened`、`task/children-admitted`、`run/submitted`、`run/closed`、`task/closed`；其余 fact type 明确拒绝，不静默忽略。CAS 仍是权威：reducer 只使用调用方冻结的 contracts/methods 上下文，不读取 live registry、文件、时钟或进程。

## Spec refs

- `docs/framework.md` §4.0（ref/digest domain）、§4.1–§4.2（Task 合同与预算）、§4.2.1（retry 约束）、§7.1（required/probe、replacement、跨 Run winner）、§8.2（child admission host 派生字段）、§9.1–§9.2（Task/Run 状态与 closure classification）、§10.2（六种 fact payload 与关键约束）、§10.3（取消唯一来源）、§11.4–§11.6（submit/verify/join）、§15.2（usage）、§19.1（恢复与 retry）。
- `docs/amendments/001-s2-protocol-closure.md` K1–K5 已获批语义；K6 证据规则未改变。
- `docs/build-plan.md` S2 工作项与 Done when。
- `docs/conformance.md` C-01/C-05/C-06/C-07/C-10/C-11/C-21/C-22；本切片只提供纯协议证据，所有场景保持 `unproven`。

## 允许修改范围

- `packages/singularity/protocol/src/reducer.ts`
- `packages/singularity/protocol/test/reducer.test.ts`
- `packages/singularity/protocol/src/admission.ts`（仅导出共享 child-limits guard）
- `packages/singularity/protocol/src/index.ts`（导出 reducer）
- 本任务卡

不修改 `docs/framework.md`、`spec-lock.json`、`docs/conformance.md`、`docs/build-plan.md`、既有 fact/task/method/digest/schema/command/journal 语义或 app。集成基线通过 cherry-pick S2-C3 `c15c861`/`91f642e` 引入 admission 与任务卡。

## 非目标

- 不实现 Method/RSI reducer、runtime、command service、writer、wake、CAS 读取/写入、journal FS、DSH、真实模型或 conformance 执行。
- 不新增第二 writer、journal、fold、ledger、registry、transcript 或 model loop。
- 不把 `ReplayContext` 变成 live registry；不验证 CAS 对象存在性、Evidence/ExecutionRecord 内容或 `run/closed.usage` 与内嵌 result usage 的 canonical equality（需要 CAS IO，留给 runtime）。
- 不改任何 conformance 状态为 `proven`。

## 设计语义

### 输入与输出

```ts
interface ReplayContext {
  readonly contracts: ReadonlyMap<string, TaskContract> // CAS object id -> frozen contract
  readonly methods: ReadonlyMap<string, MethodRevision> // method id -> frozen revision
  readonly compositions: ReadonlyMap<string, Composition> // CAS object id -> frozen composition
  readonly transientInvalidReasons: readonly string[]     // deployment pre-listed transient reasons
}

interface TaskRunState {
  readonly tasks: ReadonlyMap<string, TaskState>
  readonly runs: ReadonlyMap<string, RunState>
  readonly batches: ReadonlyMap<string, ChildBatchState> // key = childBatchKey(parentRunId, batchId)
}

function reduceTaskRunFacts(facts: readonly Fact[], context: ReplayContext): TaskRunState
function childBatchKey(parentRunId: string, batchId: string): string
```

- Fold 为纯函数：不修改 facts/context，不访问 FS/网络/进程/时钟；同一输入产生同一投影。
- 每个 fact 先经既有 `verifyFact` 校验；失败抛 `ReducerError('FACT_INVALID')`。
- 六个受支持 type 之外的 fact（method/rsi）抛 `ReducerError('UNSUPPORTED_FACT_TYPE')`。

### task/admitted

- payload contract ref 必须按 `id` 在冻结 contracts 中找到，且 digest 完全相等；找不到为 `CAS_REF_MISSING`。
- 冻结 contract 必须通过既有 `verifyTaskContract`；失败为 `CONTRACT_INVALID`。
- contract 必须为 root origin，且 `payload.taskId === contract.taskId`；重复 taskId 拒绝。
- `contract.method` 按 id/digest 在冻结 methods 中解析并通过 `verifyMethodRevision`；失败为 `CAS_REF_MISSING`/`METHOD_INVALID`。
- `contract.template.digest === method.digest`，且 template id 在 method revision 中恰存在一次；否则 `METHOD_TEMPLATE_MISMATCH`。

### run/opened

- Task 必须存在且为 open（因此无 active Run）。
- runId 全局唯一；attempt 为 1-based 且必须等于 `runIds.length + 1`，不超过 `limits.maxRuns`。
- 若已有历史 Run，固定 retry policy 必须允许新 Run；否则 `RETRY_NOT_ALLOWED`。
- budget reservation 为正安全整数，且不超过 Task `limits.maxTokens` / `maxStepsPerRun` / `deadlineAt`；否则 `BUDGET_INVALID` / `BUDGET_EXCEEDED`。
- `composition` ref 必须按 id/digest 在冻结 compositions 中解析，并通过 `compositionSchema` 与 `composition` domain digest 校验；失败为 `CAS_REF_MISSING` / `COMPOSITION_INVALID`。
- Composition 的 `contract.id`/`contract.digest` 必须等于 TaskContract 的 `taskId`/`digest`，`composition.seed` 必须等于 `run/opened.workspaceSeed`；不一致为 `COMPOSITION_MISMATCH`。本切片不读取或校验 Evidence/ExecutionRecord 内容。
- 成功后 Task 进入 active，记录 activeRunId。

### task/children-admitted

- parent Run 必须存在、open，且是 parent Task 的 active Run；Task 必须 active。
- batch 权威身份是 `parentRunId + batchId`：不同 parent Run 可以重用同一 batchId；同一 parent Run 内重复 batchId 拒绝。
- children 非空，数量不超过 parent `maxBatchChildren`，子树 Task 数不超过 root `maxTasks`，child depth 不超过 root `maxDepth`。
- child limits（deadline/depth/tasks/tokens/steps/batch）复用 `admission.ts` 导出的 `assertChildLimitsWithinParent`，reducer 不维护平行 child-limit 逻辑；失败映射为 `CHILD_LIMIT_EXCEEDED`。
- 每个 child contract 必须是合法 sealed contract；child origin 必须是 child，且 `parentId`/`parentRunId`/`batchId` 与当前 admission 一致。
- child method 必须与 parent 同一 Method revision；child template id 必须等于 binding 的 `templateId`，digest 必须等于 method digest；join 必须等于 binding join。
- child binding 必须存在于 parent frozen template；同一 batch 每个 binding 最多一个 child；同一 binding 不得已有 active child。
- child budget reservation 不超过 child frozen limits。
- 当前 parent Task 不得已有非 terminal child（一次只允许一个 active child batch）。
- required binding 已有当前 parent Run 的 non-superseded verified winner 时拒绝再准入。
- replacement/eligible predecessor 只计算当前 parent Run 的 terminal nonverified child；新 parent Run 不得 supersede 旧 Run child。列表必须是完整集合；required binding 存在当前 Run eligible failed/cancelled/invalid child 时，新 child 必须带 replacement；否则 `REPLACEMENT_REQUIRED`。

### run/submitted

- Run 必须 open 且是 Task 的 active Run；Task 必须 active。
- transcriptOffset.sessionId 必须与该 Run 的 sessionId 一致。
- 该 Run 已创建的所有 child Task 必须 terminal；否则 `CHILD_ACTIVE`。
- 按 parent frozen template 检查当前 Run 每个 required binding 都有 non-superseded verified winner；probe binding 不阻断。缺失为 `JOIN_UNSATISFIED`。
- 提交后 Run 进入 submitted；重复提交不再接受。

### run/closed

- Run 必须存在且未 closed；Task 必须 active 且 activeRunId 指向该 Run。
- `verified` / criteria-failed `failed`（带 Evidence）只能从 submitted 关闭；open Run 只能以 ExecutionRecord 的 `failed`/`invalid`/`cancelled` 关闭。
- 成功后 Run 关闭；Task 无 active Run。verified Run 使 Task 保持 active 等待 `task/closed`；其他 classification 使 Task 回到 open 等待 retry 或 Task closure。
- `usage` 保留在 Run 投影中，仅用于 retry/token/unknown 判断；不与 Evidence/ExecutionRecord 内嵌 usage 比较（CAS 权威由 runtime 校验）。

### retry policy

固定 retry 仅由 reducer 基于 facts 判断，`now` 取当前 closure/opening fact 的 `at`（reducer 无时钟）：

- 最后 Run 为 `failed`：剩余 maxRuns、`now < deadlineAt`、subtree known tokens `< maxTokens`、且无 unknown usage 时允许 retry。
- 最后 Run 为 `invalid`：只有 reason 在 `ReplayContext.transientInvalidReasons` 中且上述限额允许时允许 retry。
- `verified`、`cancelled`、非 transient `invalid` 不允许 retry。
- subtree usage 汇总该 Task 及所有 descendants 已关闭 Run 的 input+output tokens（并计入 usage.summary 子记录）；任一 usage 的 `unknownRequests > 0` 都 fail closed。

### task/closed

- 目标 Task 未 closed；非 subtree closure 不允许仍有 active Run（cancelled 除外，cancelled 以同一 fact 关闭目标 Run）。
- `verified`：
  - 必须提供 `decisiveRunId`，且是该 Task 最新 Run、已 closed `verified`；
  - decisive Run 的 evidenceRef 必须包含在 `evidenceRefs`；
  - decisive Run 所在的 frozen template 中每个 required binding 必须有非 superseded、同 parent Run 的 verified child winner；
  - 该 Task 所有 direct children 必须 terminal。
- `failed`：最新 Run 必须是 closed `failed`，且固定 retry policy 已不允许继续。
- `invalid`：最新 Run 必须是 closed `invalid`；transient reason 且 retry 仍允许时拒绝 Task closure，非 transient 或限额耗尽时允许。
- `cancelled`：允许从 open/active 关闭；目标自身未关闭 Run 以同一 cancellation cause 在投影中关闭，不补写 `run/closed`。
- `scope='subtree'`：
  - 必须带 `cancellationCutRef`；无 `scope` 时不得带 `cancellationCutRef`。
  - 目标 outcome 只允许 `failed` 或 `cancelled`；descendants 一律在投影中变为 `cancelled`。
  - 同一次 fold 关闭目标及所有非 terminal descendants、其未关闭 Runs；已 terminal 节点/Run 原样保留；不产生新的 run/closed fact。
- verified Join 只计算 decisive Run 的 required winners；旧 parent Run 的 verified child 不作为新 Run 的 winner，也不被自动 supersede；replacement predecessor 同样只取当前 parent Run。

## Done when

- reducer.ts 为单一纯 fold，无 DSH/FS/网络/进程/时钟依赖，不读 live registry。
- 六种 fact type 正向投影完整；其他 type 明确拒绝。
- 覆盖 root ref/digest + method/template、Composition identity、openRun、child admission/replacement、batch identity、submit required join、run closure classification、retry、join、subtree cancellation 与非法转换的负例。
- 测试覆盖 replay 确定性、输入不可变、基本闭环、retry/replacement/join/cancel、坏 ref/非法转换，以及 Composition/child-limits 边界。
- `index.ts` 同时导出 admission 与 reducer；child limits 与 admission 共用导出的 `assertChildLimitsWithinParent`。
- 根 `pnpm verify` 与 `git diff --check` 通过；所有 conformance 保持 `unproven`。

## 检查命令

```bash
pnpm install --frozen-lockfile
pnpm --filter @singularity/protocol test
pnpm verify
git diff --check
```

## 失败证据与运行记录

环境：官方 Node `24.9.0`、pnpm `11.18.0`，独立 worktree/HOME/store。

### 红证据

先写 `test/reducer.test.ts` 并运行 `pnpm --filter @singularity/protocol test`，`src/reducer.ts` 尚不存在：新增测试文件以 `ERR_MODULE_NOT_FOUND` 失败，既有 protocol tests 通过。失败原因是模块缺失，不是断言放宽。

集成审查修正时，先合并 S2-C3 `c15c861`/`91f642e` 作为基线，再为 batch identity、current-Run replacement、submit required join、Composition、subtree cut、shared child limits 与 index export 增加正负例；实现前运行同一命令：protocol tests `158`，`157` pass、`1` fail，失败为 `reducer.ts` 尚未导出 `childBatchKey`（测试文件加载失败），不是断言放宽或环境问题。

### 绿证据

```bash
pnpm install --frozen-lockfile
pnpm --filter @singularity/protocol test
pnpm --filter @singularity/protocol typecheck
pnpm --filter @singularity/protocol lint
pnpm verify
git diff --check
```

结果：官方 Node `24.9.0`/pnpm `11.18.0`，独立 HOME/store；frozen install 通过；protocol tests `178/178`、app tests `6/6`（合计 `184`）；根 `pnpm verify` 的 project、typecheck、lint、test、build 全部通过；`git diff --check` 通过。reducer 测试先红后绿；修正过程中只更新因语义收紧而失效的测试编排与测试数据，未删除断言或修改规范。

## 覆盖摘要

- `reduceTaskRunFacts` 是单一纯 fold：不修改 `facts`/`ReplayContext`，不使用 FS/网络/进程/时钟；两次完全相同的 replay 产生相同投影。
- `task/admitted`：按 CAS object id 解析冻结 contract，校验 contract digest、root origin、taskId、method digest 与 `verifyMethodRevision`、template id 存在且 `template.digest === method.digest`；重复 task 拒绝。
- `run/opened`：Task 必须 open 且无 active Run；runId 唯一；attempt 连续、1-based、不超过 maxRuns；budget reservation 为正安全整数且不超过 frozen limits；历史 failed/invalid retry 由固定策略校验；旧 child 未 terminal 时拒绝新 Run；Composition 必须解析、验证 composition domain digest，且 contract id/digest 与 workspaceSeed 匹配。
- `task/children-admitted`：parent Run 必须 open，parent Task 必须 active；batch 身份为 parentRunId+batchId，不同 Run 可重用 batchId、同 Run 重复拒绝；children 非空且受 maxBatchChildren/maxTasks/maxDepth 限制；child origin parent/run/batch 匹配；child 必须 pin 同一 Method revision、template 匹配 binding、join 等于 binding join；child limits 与 admission 共用 `assertChildLimitsWithinParent`；同一 binding 无 active child、无当前 Run verified winner；required binding 的当前 Run terminal nonverified predecessor 必须由 replacement 完整 supersede。
- `run/submitted`：Run 必须 open、Task active、transcript session 匹配、该 Run 的 children 全部 terminal，且当前 Run 的每个 required binding 有 non-superseded verified winner；probe 不阻断；重复 submit / closed Run submit 拒绝。
- `run/closed`：Run 必须未 closed 且为当前 active Run；Evidence-backed closure 只能来自 submitted；open Run 只能以 ExecutionRecord 的 failed/invalid/cancelled 关闭；verified 使 Task 等待 Task closure，其他 classification 回到 open。
- retry：failed 只在 maxRuns、`fact.at < deadlineAt`、known subtree tokens、无 unknown usage 时允许；invalid 仅在 `ReplayContext.transientInvalidReasons` 命中且限额允许时允许；verified/cancelled/非 transient invalid 不 retry。Task failed/invalid closure 在 retry 仍可用时拒绝。
- Task verified closure：最新 decisive Run 必须 closed verified；`evidenceRefs` 必须包含该 Run 的 Evidence；frozen template 每个 required binding 必须在当前 decisive Run 有非 superseded verified winner；所有 direct children terminal。旧 Run 的 verified child 不会成为新 Run 的 winner。
- replacement：只允许 supersede 当前 parent Run、同一 binding 下 terminal nonverified、未 superseded 的 direct child；集合必须完整；active/verified/already-superseded/旧 Run target 拒绝；旧 child 保留 trace 与 outcome。
- Task failed/invalid/cancelled closure：failed 要求最新 Run failed 且 retry 耗尽/不允许；invalid 要求最新 Run invalid，transient 且仍可 retry 时拒绝，非 transient 允许；cancelled 关闭目标自身未关闭 Runs。
- `scope='subtree'`：必须带 `cancellationCutRef`，无 scope 不得带；目标 outcome 允许 failed/cancelled，descendants 一律 cancelled；一次 fold 关闭目标与所有非 terminal descendants 及其未关闭 Runs；terminal 节点/Run 原样保留；Run closure source 标记为 `subtree-cancellation`，不新增 `run/closed`，事后补写 `run/closed` 拒绝。
- 非六类 fact（method/rsi）以 `UNSUPPORTED_FACT_TYPE` 明确拒绝；非法状态转换返回稳定 `ReducerErrorCode`。
- 集成审查修复：跨 Run replacement 只取当前 parent Run；submit required winner 按当前 Run 计算；batch 身份为 `parentRunId`+`batchId`，避免全局误识别；subtree cut 必须带 `cancellationCutRef`；Composition contract/seed 必须与 `run/opened` 匹配。以上均先增加负例再修正，不是只写首版。
- `index.ts` 导出 admission 与 reducer，`childBatchKey`/`reduceTaskRunFacts` 可从协议入口使用。

## 仍未验证

- 不验证 CAS 对象存在性/内容、Evidence/ExecutionRecord 内部字段、usage canonical equality、journal FS、command service、runtime/DSH、真实模型。
- Composition 只校验 strict schema、composition domain digest、contract id/digest 与 workspaceSeed；不读取 Composition 引用的 DSH/MCP/skill/CAS 对象内容，也不证明 runtime 实际按该 Composition 启动。
- Method/RSI reducer、admission command guard、preview/receipt、wake、trace seal 未实现。
- C-01/C-05/C-06/C-07/C-10/C-11/C-21/C-22 及其他 conformance 仍为 `unproven`。

结论：S2-C4 完成，S2 完成；下一步 S3 单 Task/Run 闭环。Method/RSI reducer 属后续。
