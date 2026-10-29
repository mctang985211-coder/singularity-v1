# S2-B 任务卡：Task + Method schema、contract seal 与 tool errors

- **状态**：已完成（Task + Method 整体）；S2 继续。

## Goal

在既有纯 `@singularity/protocol` 基础上，按 `docs/framework.md` §4/§5/§5.1/§8/§14 冻结字段实现 Task/Method 相关 strict schema、类型推导、`sealTaskContract`/`verifyTaskContract`、`sealMethodRevision`/`verifyMethodRevision`、`singularity_decompose` 输入 schema 与 16 个 tool error 码/预算 schema，并建立正负例测试和公共导出。

## Spec refs

- `docs/framework.md` §4（TaskSpec/TaskProposal/TaskContract/InputRef/OutputSpec/ResourceBinding/TaskLimits/ContractSummary）
- `docs/framework.md` §5（MethodRevision/TaskTemplate/SkillAsset/ToolAsset/ChildBinding）
- `docs/framework.md` §5.1（TaskExample）
- `docs/framework.md` §8、§14.1（decompose prepare/commit 输入与 16 个 tool error 码）
- `docs/framework.md` §10.1（`contract`、`method` digest domain）
- `docs/build-plan.md` S2
- 本切片只提供 schema 与纯 seal/verify 证据；C-01、C-05、C-11 保持 `unproven`。

## 允许修改范围

- `packages/singularity/protocol/src/{task,method,errors,index}.ts`
- `packages/singularity/protocol/test/{task-contract,task-proposal,method,tool-errors}.test.ts`
- `docs/tasks/s2-b-task-method-schema.md`

不修改 `docs/framework.md`、`spec-lock.json`、`docs/conformance.md`、根构建配置、锁文件或其他包。

## 非目标

- 不实现 child admission/merged TaskSpec、host 合并 required criteria/outputs、draft outputs 追加顺序、preview receipt 验证、`ackPreview` 权威校验或任何命令执行。
- 不实现闭合 fact payload、command guard、reducer、journal/FS、runtime/DSH 或真实模型路径。
- Method 只做结构校验：不检查 catalog 悬空/重复 ID、capability allowlist、bundle/manifest 内容或跨字段语义。
- 不新增未冻结的字符串长度、路径、数量、预算、次序或跨字段业务校验；`JsonSchema` 业务字段仍使用 `jsonObjectSchema`，不另写 DSH 子集。
- 不实现 authorisation、order、idempotency、retry/join/replacement、admission 或运行时语义。

## 实现约束

- 所有对象使用 `closedObject`，未知字段（含嵌套）拒绝；所有公开类型通过 `z.infer` 从 schema 推导，不手写平行接口。
- `TaskExample` 必须由 `taskProposalSchema.omit({ inputs: true }).extend(...)` 派生；example 输入形状为 `{ id, exampleText }`。
- `decomposeInputSchema`：prepare 为 `{ action, bindingId }`，commit 为 `{ action, children: [{ bindingId, ackPreview, task }] }`，全部 strict。
- `sealTaskContract` 只接受完整、已由调用方排好数组顺序的 contract body；不重排、不追加、不合并、不补默认值，只做 strict 校验并附加 `contract` domain digest。
- `verifyTaskContract` 同时要求 strict schema 完整和 `contract` domain digest 正确；错域、篡改、未知字段和错误版本均返回 false。
- `ContractSummaryRef`/`ContractSummary` 是只读派生视图 schema，不是 TaskContract 字段，不回写合同。
- Method 对象全部 strict；`method-empty` 合法；递归/悬空 child binding 只保留结构；完整 MCP server `ToolAsset` 保留 frozen server 字段；`sealMethodRevision`/`verifyMethodRevision` 使用 `method` domain。
- `taskCriterionSchema`/`outputSpecSchema` 只由 `task.ts` 拥有；`method.ts` 直接复用，不定义或再导出平行 schema；对象身份断言固定该关系。
- 16 个 tool error code 是单一冻结集合；`RemainingBudgetPct` 百分比 strict、0–100、`tokensPct` nullable；`toolErrorSchema` 只含 `code`/`nextAction`/`remainingBudgetPct`。
- `src/index.ts` 导出既有 protocol surface、Task/Method schema/helpers 与 tool error contract，不丢失既有导出。

## Done when

- 合法 root/child contract 可 seal 并 verify；对象键插入顺序不影响 digest；数组顺序不被重排。
- 逐字段篡改、错 digest domain、未知顶层/嵌套字段、错误 `v` 均拒绝。
- TaskProposal 对 method/template/resources/acceptance/environment/limits/origin/taskId/parentId/parentRunId/batchId/bindingId/join/required/role/acceptancePolicy/verifier/scorer/supersedesChildIds/feedbackRef/digest 表驱动拒绝；localOutput 即使 `role: 'supporting'`/`required: false` 也拒绝。
- TaskExample 从 TaskProposal 派生；example input 只接受 `{ id, exampleText }`。
- decompose prepare/commit、commit child、嵌套 TaskProposal 全部 strict；不接受完整 TaskContract 冒充 proposal。
- method-empty、递归/悬空 child bindings、完整 stdio/streamable-http MCP server asset 均可 seal；篡改、错域、未知字段、非法 transport/join/ref 拒绝。
- 16 个 tool error code 精确一致；预算百分比边界/类型严格；tool error 缺少或未知字段拒绝。
- `taskCriterionSchema`/`outputSpecSchema` 仅由 `task.ts` 定义，Method 直接复用并有对象身份断言；公共导出不产生平行 schema。
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

结果：既有 protocol tests `49/49` 通过；两个新测试文件均因 `ERR_MODULE_NOT_FOUND`（`src/task.ts` 不存在）失败，共 `51 tests / 49 pass / 2 fail`。Method 与 tool error 证据由最终绿结果覆盖。

### 绿证据

父代理集成后，在官方 Node `24.9.0`、pnpm `11.18.0`、DSH `0.2.2-alpha.2` 环境运行：

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

结果：frozen install 通过；protocol tests `86/86`、app tests `6/6`；根 `pnpm verify` 的 project、typecheck、lint、test、build 全部通过；`git diff --check` 通过。

### 覆盖摘要

- contract：合法 root/child origin seal、`contract` domain digest、键插入顺序无关、数组顺序保留、可选字段不追加、逐字段篡改、错域、错误 `v`、顶层/嵌套未知字段、非 JSON accessor/undefined 输入全部覆盖。
- proposal：`method/template/resources/acceptance/environment/limits/origin/taskId/parentId/parentRunId/batchId/bindingId/join/required/role/acceptancePolicy/verifier/scorer/supersedesChildIds/feedbackRef/digest` 与 `criteria` 全部表驱动拒绝；`localOutput` 带 `role` 或 `required`（含 `supporting`/`false`）拒绝。
- example：由 `taskProposalSchema.omit({ inputs: true }).extend(...)` 派生；输入只接受 `{ id, exampleText }`，拒绝 ObjectRef/授权字段。
- decompose：prepare/commit/child 全 strict；`ackPreview` 只接受 Digest；commit task 只接受 TaskProposal，完整 TaskContract 与 example input 均拒绝。
- summary：`ContractSummaryRef`/`ContractSummary` strict；解析摘要不修改、不回写冻结合同。
- Method：`method-empty` 合法并 seal 在 `method` domain；递归/悬空 child binding 仅结构合法；完整 stdio/streamable-http MCP server asset 字段保真；未知字段、非法 transport/join/ref、digest 篡改/错域/未 seal 拒绝。
- shared schema：`taskCriterionSchema`/`outputSpecSchema` 只由 `task.ts` 定义；`method.ts` 直接复用；测试断言对象身份且 method 模块不拥有这些 schema，确认 Method/Task 没有平行 schema。
- tool errors：16 码精确集合与未知码拒绝；budget 百分比 0–100、`tokensPct` nullable、未知字段拒绝；`toolErrorSchema` 只含 `code`/`nextAction`/`remainingBudgetPct`。
- index：既有 protocol 导出保留，Task/Method schema/helpers 与 tool error contract 可从公共入口取得。

### 仍未验证

- 只做结构校验；catalog 悬空/重复 ID、capability allowlist、bundle/manifest 内容与跨字段语义未做。
- child admission/合并 TaskSpec、模板 requiredCriteria/requiredOutputs 合并、localOutputs 转 supporting、draft outputs 追加顺序、preview receipt/`ackPreview` 持久交付与 next-step 权威校验、feedback replan/supersedes 派生未实现。
- 命令执行、order、authorisation、idempotency、guard、journal/FS、闭合 fact payload、reducer、runtime/DSH 与真实模型路径未验证。
- `JsonSchema` 业务字段仍按 `jsonObjectSchema` 处理，未新增 DSH 子集。
- 所有 conformance 场景（含 C-01/C-05/C-11）保持 `unproven`；`docs/conformance.md` 与 `spec-lock.json` 未改。
