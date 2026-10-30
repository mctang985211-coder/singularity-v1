# S2-C3 任务卡：纯 root/child Task admission 合并

- **状态**：已完成（纯 protocol root/child admission 合并）；S2 继续，下一 Task/Run reducer。preview、epoch、FS、runtime 未实现，所有 conformance 保持 `unproven`。

## Goal

在 `@singularity/protocol` 中实现无副作用的 root/child Task admission 合并。root 接收 host 已解析的完整 spec/origin/method/template/resources/acceptance/environment/limits，按冻结顺序追加 learning drafts 并 seal；child 在已验证的 parent contract 与 Method revision 上，按固定 child binding 合并 template required criteria/outputs、proposal local guidance/supporting outputs，派生 origin/join/template/method，并一次返回完整 child contracts。失败在产生任何 contract 前拒绝。

## Spec refs

- `docs/framework.md` §4.1（TaskSpec/TaskProposal/TaskContract、模型可填写字段）
- `docs/framework.md` §4.2.1（Output 合并顺序与保留命名空间）
- `docs/framework.md` §4.3（child required criteria/outputs、localCriteria/localOutputs 边界）
- `docs/framework.md` §6.2（learning drafts 固定 output）
- `docs/framework.md` §8.2（commit admission 顺序）
- `docs/framework.md` §10.2（child contract 进入 `task/children-admitted` 的形态）
- `docs/framework.md` §12.3（inputs 授权）
- `docs/framework.md` §14.1（既有 tool error codes）
- `docs/amendments/001-s2-protocol-closure.md` K1–K5 与 §4.4
- `docs/build-plan.md` S2-C3；本切片只提供纯协议证据，所有 conformance 保持 `unproven`。

## 允许修改范围

- `packages/singularity/protocol/src/admission.ts`（新增）
- `packages/singularity/protocol/src/index.ts`（追加 admission 导出）
- `packages/singularity/protocol/test/admission.test.ts`（新增）
- 本任务卡

不修改 `docs/framework.md`、`spec-lock.json`、`docs/conformance.md`、`docs/build-plan.md`、既有 Task/Method/Fact/Command/Journal 类型或其他包。

## 非目标

- 不实现 preview、preview receipt、`ackPreview`、PlanningSketch、context epoch、next-step 或对话 step 校验。
- 不实现 FS/CAS IO、journal append、fact 写入、budget reservation、唯一 writer/fold/wake/registry/transcript/model loop。
- 不实现 runtime、DSH Agent、真实模型、verifier、retry/replacement/feedback、taskId/batchId/runId 生成或时钟。
- 不实现 `children-admitted` fact 组装；本切片只返回纯 admission 结果。
- 不新增 tool error code，不把任何 conformance 改为 `proven`。

## 实现约束

- `admission.ts` 只依赖 protocol 内 schema/type；不访问 DSH、FS、网络、进程或时钟。
- 输入 schema 使用 `closedObject` 与既有 `taskSpecSchema`/`taskProposalSchema`/`taskContractSchema`/`methodRevisionSchema`/`inputRefSchema`/`outputSpecSchema`；不定义 Task/Method 的平行类型或手写 validator。
- 输出顺序固定为：base outputs → child `localOutputs`（按 proposal 顺序转 `role='supporting'`, `required=false`）→ `__skill-drafts`（`tree`, `role='skill-draft'`, `required=false`, path `learning-drafts/skills`）→ `__mcp-drafts`（`tree`, `role='mcp-draft'`, `required=false`, path `learning-drafts/mcp-servers`）。
- 保留 criteria/localGuidance/inputs/base outputs/local outputs 的输入顺序；optional 字段不补默认值。
- 合并后 output `id`/`path` 必须唯一；base/local/template 不得占用保留 ID `__skill-drafts`/`__mcp-drafts` 或 `learning-drafts` 保留路径；template requiredOutputs 不得使用 draft role。localOutputs 不能携带模型 `role`/`required` 字段（由既有 strict proposal schema 保证）。
- child inputs 必须与 host 给出的 `authorizedInputs` 逐项、按顺序完全一致；不一致返回 `INPUT_NOT_AUTHORIZED`。
- child 的 `method` pin `parent.method`；child `template` 为 `{ id: binding.templateId, digest: method.digest }`；parent template 必须属于同一 Method revision。binding 只能来自 parent template 的固定 children。
- child origin 固定派生为 `{ kind: 'child', parentId: parent.taskId, parentRunId, batchId, bindingId }`；join 从 binding 派生并只出现在 admission 结果，不进入 TaskContract。
- batch 拒绝空列表、重复 binding、重复 child `taskId`、超过 `parent.limits.maxBatchChildren`、已有 active batch（输入 projection 非空）。active batch → `CHILD_BATCH_ACTIVE`；超限 → `LIMIT_EXCEEDED`；重复/空/保留/形状错误 → `INVALID_ARGUMENT`；method/template/binding 固定身份不一致 → `BINDING_FIXED`；inputs 不一致 → `INPUT_NOT_AUTHORIZED`。
- root/child 的 `spec.criteria` 与 `spec.inputs` ID 必须唯一；required/local outputs 继续按合并结果检查 ID/path 唯一。
- child limits 不得放大 parent：`deadlineAt <= parent.deadlineAt`、`maxDepth < parent.maxDepth`、`1 <= maxTasks <= parent.maxTasks - 1`、`maxTokens <= parent.maxTokens`、`maxStepsPerRun <= parent.maxStepsPerRun`、`maxBatchChildren <= parent.maxBatchChildren`，超限统一 `LIMIT_EXCEEDED`；不约束 `maxRuns`，也不声称已处理历史 descendants、已消耗预算或全局 reservation。
- 所有失败在构造任何可返回 contract 前发生；不修改输入对象或数组。

## 公共 API

```ts
export const SKILL_DRAFTS_OUTPUT: OutputSpec
export const MCP_DRAFTS_OUTPUT: OutputSpec
export class AdmissionError extends Error { readonly code: AdmissionErrorCode }
export function admitRootTask(input: RootAdmissionInput): TaskContract
export function admitChildBatch(input: ChildBatchAdmissionInput): AdmittedChildBatch
```

`RootAdmissionInput` 为 host 完整解析的 root 字段；`ChildBatchAdmissionInput` 包含已冻结 parent contract、已验证 Method revision、parentRunId/batchId/active batch projection，以及每 child 的 bindingId、host taskId、authorizedInputs、proposal 和 host-resolved resources/environment/limits。`AdmittedChildBatch.children[]` 含 `bindingId`、派生 `join` 与 sealed `contract`。

## Done when

- root/child 正常路径分别 seal 出可 `verifyTaskContract` 的 contract；digest 使用 `contract` domain。
- root 与 child outputs 顺序、draft 固定末尾、local supporting 转换、criteria/localGuidance/inputs 顺序均有测试。
- 重复 criteria/input/output ID、重复 output path、重复 child taskId、保留 ID/path、template draft role、未知/越权字段、空 batch、重复 binding、超 maxBatchChildren、active batch、inputs 不匹配、parent/method/template/binding 不一致、child limits 放大 parent 均有负例。
- 失败返回稳定 `AdmissionError` code；失败与成功路径都不修改输入；失败不返回部分 contract。
- `admission.ts` 保持纯 protocol；`index.ts` 同时保留既有导出并可与另一范围 reducer 导出共存。
- 包级 typecheck/lint/test/build 与根 `pnpm verify` 通过；`git diff --check` 通过。
- 文档记录未覆盖的 preview/epoch/FS/runtime/conformance 项。

## 检查命令

```bash
pnpm install --frozen-lockfile
pnpm --filter @singularity/protocol typecheck
pnpm --filter @singularity/protocol lint
pnpm --filter @singularity/protocol test
pnpm --filter @singularity/protocol build
pnpm verify
git diff --check
```

## 失败证据与运行记录

环境：官方 Node `24.9.0`、pnpm `11.18.0`；独立 worktree、HOME 与 pnpm store。

### 红证据

先写 `test/admission.test.ts`，实现前运行：

```bash
pnpm --filter @singularity/protocol test
```

结果：protocol tests `139`，`138` pass、`1` fail；失败为 `ERR_MODULE_NOT_FOUND`（`src/admission.ts` 不存在）。失败原因是模块缺失，不是断言放宽或跳过。

集成审查补齐 guard 时，先增加 taskId/criteria/input ID 唯一性与 child limits 正负例，实现前运行同一命令：protocol tests `157`，`153` pass、`4` fail；失败均为新的 guard 缺失（缺少预期异常），不是测试环境或已有行为回归。

### 绿证据

```bash
pnpm install --frozen-lockfile
pnpm --filter @singularity/protocol typecheck
pnpm --filter @singularity/protocol lint
pnpm --filter @singularity/protocol test
pnpm --filter @singularity/protocol build
pnpm verify
git diff --check
```

结果：frozen install 通过；protocol tests `157/157`、app tests `6/6`（合计 `163`）；根 `pnpm verify` 的 project/typecheck/lint/test/build 全部通过；`git diff --check` 通过。

### 覆盖摘要

- root：host 完整 spec/origin/method/template/resources/acceptance/environment/limits 原样保留，base outputs 顺序不变，固定追加 `__skill-drafts` → `__mcp-drafts`，seal 后可 `verifyTaskContract`；optional `localGuidance`/`resources.exploration` 缺失时不被补默认值。
- child：template `requiredCriteria` 原序进入 `criteria`，proposal `localCriteria` 只进入 `localGuidance`；template `requiredOutputs` 原序保留，`localOutputs` 原序转 `role='supporting'`, `required=false`，随后固定追加两个 drafts；proposal inputs 与 host `authorizedInputs` 逐项按顺序完全一致，否则 `INPUT_NOT_AUTHORIZED`。
- 派生：child `origin` 由 parentId/parentRunId/batchId/bindingId 生成；`method` 逐字段 pin `parent.method`；`template` 为 `{ id: binding.templateId, digest: method.digest }`；`acceptance` 来自 template `acceptancePolicy`；`join` 只出现在 admission 结果，TaskContract 无该字段。
- 唯一性：root/child `spec.criteria` 与 `spec.inputs` ID 唯一；batch 内 binding 与 taskId 唯一；required/local outputs 合并后 ID/path 唯一。
- limits：child 的 deadlineAt/maxDepth/maxTasks/maxTokens/maxStepsPerRun/maxBatchChildren 按 parent 边界收紧，超限 `LIMIT_EXCEEDED`；`maxRuns` 未新增继承规则，正例覆盖 child > parent。
- 拒绝：root/child 重复 criteria/input/output ID、重复 output path、重复 child taskId/binding、保留 ID `__skill-drafts`/`__mcp-drafts`、保留路径 `learning-drafts` 前缀、template draft role、未知字段、proposal 越权字段、空 batch、超过 `maxBatchChildren`、active batch、parent/Method 篡改、method pin/template/binding 不一致、binding 指向缺失 template、未授权/重排 inputs、child limits 放大 parent；对应错误码为 `INVALID_ARGUMENT`/`BINDING_FIXED`/`INPUT_NOT_AUTHORIZED`/`LIMIT_EXCEEDED`/`CHILD_BATCH_ACTIVE`，未新增错误码。
- 原子性与不变性：所有测试比较调用前后输入深拷贝；admission 在全部 child 建立并 seal 后才返回，后继 child 失败不会返回先前 contract；`index.ts` 同时保留既有导出并导出 admission surface。

### 仍未验证

- 未实现 preview/`ackPreview`/receipt、PlanningSketch、context epoch、next-step、模型 step 与 active batch 的真实持久 projection；`activeBatch` 仅由调用方输入表示。
- 未实现 FS/CAS IO、journal append、fact 写入、budget reservation/reservation accounting、唯一 writer/fold/wake/registry/transcript、taskId/batchId/runId 生成、时钟或 runtime/DSH/真实模型。
- 纯 admission 只比较 child limits 与 parent limits；未处理历史 descendants、已消耗预算、全局 reservation 或真实预算计量，也不证明剩余预算足够。template/binding catalog 重复、capability/bundle 内容与 verifier 语义仍未验证。
- 本切片只提供纯 protocol 证据；C-01/C-05 等所有 conformance 仍为 `unproven`，不能据此宣称 admission runtime 或 Task/RSI 功能完成。
