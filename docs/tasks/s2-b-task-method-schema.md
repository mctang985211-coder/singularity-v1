# S2-B 任务卡：Task schema、contract seal 与 decompose 输入

- **状态**：实现与包级/根门禁完成；公共 `index.ts` 导出由另一范围接入。本卡只覆盖 Task 协议切片，Method schema 由其他独立范围负责。

## Goal

在既有纯 `@singularity/protocol` 基础上，按 `docs/framework.md` §4/§5.1/§8/§14 冻结字段实现 Task 相关 strict schema、类型推导、`sealTaskContract`、`verifyTaskContract` 与 `singularity_decompose` 输入 schema，并建立正负例测试。

## Spec refs

- `docs/framework.md` §4（TaskSpec/TaskProposal/TaskContract/InputRef/OutputSpec/ResourceBinding/TaskLimits/ContractSummary）
- `docs/framework.md` §5.1（TaskExample）
- `docs/framework.md` §8、§14.1（decompose prepare/commit 输入）
- `docs/framework.md` §10.1（`contract` digest domain）
- `docs/build-plan.md` S2
- 本切片只提供 schema 与纯 seal/verify 证据；C-01、C-05、C-11 保持 `unproven`。

## 允许修改范围

- `packages/singularity/protocol/src/task.ts`
- `packages/singularity/protocol/test/task-contract.test.ts`
- `packages/singularity/protocol/test/task-proposal.test.ts`
- `docs/tasks/s2-b-task-method-schema.md`

不修改 `packages/singularity/protocol/src/index.ts`；公共导出由另一范围统一处理。不修改 `docs/framework.md`、`spec-lock.json`、`docs/conformance.md`、根构建配置、锁文件或其他包。

## 非目标

- 不实现 child admission/merged TaskSpec、host 合并 required criteria/outputs、draft outputs 追加顺序、preview receipt 验证、`ackPreview` 权威校验或任何命令执行。
- 不实现闭合 fact payload、command guard、reducer、journal/FS、runtime/DSH 或真实模型路径。
- 不实现 Method、TaskTemplate、SkillAsset、ToolAsset 等 Method 侧 schema。
- 不新增未冻结的字符串长度、路径、数量、预算、次序或跨字段业务校验；`JsonSchema` 业务字段仍使用 `jsonObjectSchema`，不另写 DSH 子集。
- 不实现 authorisation、order、idempotency、retry/join/replacement、admission 或运行时语义。

## 实现约束

- 所有对象使用 `closedObject`，未知字段（含嵌套）拒绝；所有公开类型通过 `z.infer` 从 schema 推导，不手写平行接口。
- `TaskExample` 必须由 `taskProposalSchema.omit({ inputs: true }).extend(...)` 派生；example 输入形状为 `{ id, exampleText }`。
- `decomposeInputSchema`：prepare 为 `{ action, bindingId }`，commit 为 `{ action, children: [{ bindingId, ackPreview, task }] }`，全部 strict。
- `sealTaskContract` 只接受完整、已由调用方排好数组顺序的 contract body；不重排、不追加、不合并、不补默认值，只做 strict 校验并附加 `contract` domain digest。
- `verifyTaskContract` 同时要求 strict schema 完整和 `contract` domain digest 正确；错域、篡改、未知字段和错误版本均返回 false。
- `ContractSummaryRef`/`ContractSummary` 是只读派生视图 schema，不是 TaskContract 字段，不回写合同。

## Done when

- 合法 root/child contract 可 seal 并 verify；对象键插入顺序不影响 digest；数组顺序不被重排。
- 逐字段篡改、错 digest domain、未知顶层/嵌套字段、错误 `v` 均拒绝。
- TaskProposal 对 method/template/resources/acceptance/environment/limits/origin/taskId/parentId/parentRunId/batchId/bindingId/join/required/role/acceptancePolicy/verifier/scorer/supersedesChildIds/feedbackRef/digest 表驱动拒绝；localOutput 即使 `role: 'supporting'`/`required: false` 也拒绝。
- TaskExample 从 TaskProposal 派生；example input 只接受 `{ id, exampleText }`。
- decompose prepare/commit、commit child、嵌套 TaskProposal 全部 strict；不接受完整 TaskContract 冒充 proposal。
- ContractSummary 解析不修改、不反向写入冻结合同。
- 包级 `typecheck`、`lint`、`test`、`build` 与根 `pnpm verify` 通过；`git diff --check` 通过。
- 文档记录未覆盖的 admission/order/auth/runtime 语义，C-01/C-05/C-11 保持 unproven。

## 检查命令

在独立 worktree，使用官方 Node `24.9.0`、pnpm `11.18.0`、独立 HOME/store：

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

### 初始红证据

新增 `test/task-contract.test.ts`、`test/task-proposal.test.ts` 后、实现前运行：

```bash
pnpm --filter @singularity/protocol test
```

结果：既有 protocol tests `49/49` 通过；两个新测试文件均因 `ERR_MODULE_NOT_FOUND`（`src/task.ts` 不存在）失败，共 `51 tests / 49 pass / 2 fail`。

### 绿证据

在独立 worktree `/home/ROXY/code/singularity-v1-swarm-task`、独立 HOME/store、官方 Node `24.9.0`、pnpm `11.18.0` 下运行：

```bash
pnpm install --frozen-lockfile --store-dir /home/ROXY/code/singularity-v1-swarm-task-store
pnpm --filter @singularity/protocol typecheck
pnpm --filter @singularity/protocol lint
pnpm --filter @singularity/protocol test
pnpm --filter @singularity/protocol build
pnpm verify
git diff --check
```

结果：protocol tests `72/72`、app composition tests `6/6`；根 `pnpm verify` 的 project、typecheck、lint、test、build 全部通过；`git diff --check` 通过。

### 覆盖摘要

- contract：合法 root/child origin seal、`contract` domain digest、键插入顺序无关、数组顺序保留、可选字段不追加、逐字段篡改、错域、错误 `v`、顶层/嵌套未知字段、非 JSON accessor/undefined 输入全部覆盖。
- proposal：`method/template/resources/acceptance/environment/limits/origin/taskId/parentId/parentRunId/batchId/bindingId/join/required/role/acceptancePolicy/verifier/scorer/supersedesChildIds/feedbackRef/digest` 与 `criteria` 全部表驱动拒绝；`localOutput` 带 `role` 或 `required`（含 `supporting`/`false`）拒绝。
- example：由 `taskProposalSchema.omit({ inputs: true }).extend(...)` 派生；输入只接受 `{ id, exampleText }`，拒绝 ObjectRef/授权字段。
- decompose：prepare/commit/child 全 strict；`ackPreview` 只接受 Digest；commit task 只接受 TaskProposal，完整 TaskContract 与 example input 均拒绝。
- summary：`ContractSummaryRef`/`ContractSummary` strict；解析摘要不修改、不回写冻结合同。

### 仍未验证

- 未实现 child admission/合并 TaskSpec、模板 requiredCriteria/requiredOutputs 合并、localOutputs 转 supporting 的宿主逻辑。
- 未实现 draft outputs 追加顺序、preview receipt/`ackPreview` 持久交付与 next-step 权威校验、feedback replan/supersedes 派生。
- 未实现命令执行、order、authorisation、idempotency、guard、journal/FS、闭合 fact payload、reducer、runtime/DSH 或真实模型路径。
- 未实现 Method、TaskTemplate、SkillAsset、ToolAsset schema；未修改 `src/index.ts`，公共导出由另一范围接入。
- `JsonSchema` 业务字段仍按 `jsonObjectSchema` 处理，未新增 DSH 子集。
- C-01、C-05、C-11 保持 `unproven`；`docs/conformance.md` 与 `spec-lock.json` 未改。
