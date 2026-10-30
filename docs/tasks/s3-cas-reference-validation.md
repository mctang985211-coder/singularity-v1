# S3-A 遗留任务卡：domain-aware CAS 引用校验

- **状态**：实现完成，等待联调审查；不处理 acceptance amendment 002。
- **分支**：`s3-cas-reference-validation`
- **Worktree**：`/home/ROXY/code/singularity-v1-cas-reference-validation`
- **基线**：`origin/main` @ `9eeb8b9`（本地 main 的普通 merge 同步未用于本 worktree）。

## Goal

补齐 S3-A 遗留的 CAS 引用完整性：`putObject`/`readObject` 支持既有 9 个 digest domain 中 7 个实际 CAS 域；`DomainStore.open`/`replay` 在 journal 链校验后，对 fact 顶层 refs 和 TaskContract/MethodRevision/Composition/ExecutionRecord 的嵌套 refs 校验 CAS 存在、内容与 digest domain。保持单 journal、单 writer、CAS 和 store 非业务 reducer 边界。

## Spec refs

- `docs/framework.md` §4.0、§4.1、§5、§10.1、§10.2、§10.3、§15.2、§19.1
- `docs/amendments/002-acceptance-and-submission.md`：仅确认 `AcceptanceRef` domain 仍未批准，不实现、不猜测
- `docs/tasks/s3-a-journal-cas.md` 的 S3-A Done when 与未验证项

## 允许修改范围

- `packages/singularity/runtime/src/store.ts`
- `packages/singularity/runtime/src/service.ts`
- `packages/singularity/runtime/src/index.ts`
- `packages/singularity/runtime/test/**`
- 本任务卡

明确不修改：protocol、app、framework、spec-lock、conformance、build-plan、README、CI 或 lockfile。

## 非目标

- 不决定或验证 `TaskContract.acceptance`（AcceptanceRef）；等待 amendment 002。
- 不实现 `PublicReceipt`、`SubmissionManifest`、submit/verifier、Evidence 内部字段、RoundPlan 内部字段或 preview 对象内部字段。
- 不新增 digest domain、fact、writer、fold、registry、transcript、业务 reducer 或 state guard。
- 不把 replay 变成业务 reducer：只校验 ref 存在与 integrity，不检查 Run/Task 生命周期、预算、actor 或读取授权。

## API

- `putObject(id, bytes, domain = 'object')`
- `readObject(ref, domain = 'object')`
- `CAS_DIGEST_DOMAINS = ['object','contract','method','composition','evidence','round-plan','preview']`
- `fact`/`command` 不是 CAS domain，传入即 `INVALID_ARGUMENT`。
- `CommandObject` 增加可选 `domain`，`CommandService` 写 CAS 时透传。

## 校验映射

- 顶层 fact refs：13 种 fact 全覆盖；`method/activated.expectedPrevious`、`run/closed.planningSketchRef`、`run/closed.feedbackRefs` 也按 schema 语义校验。
- `TaskContract`：`method`/`template`=method；`spec.inputs[].object`、`resources.*`、`environment.seed/profile`、root `origin.requestRef`=object；`acceptance` 跳过。
- `MethodRevision`：`parent`=method；`templates[].guidance/example/acceptancePolicy`、`skills[].bundle`、`tools[].server.{bundle,manifest,sourceFiles,config}`=object。
- `Composition`：`dsh.config`、`contract`、`template`、`guidance?`、`skills[]`、`mcpServers[].{manifest,bundle,schema,config}`、`modelRoute`、`resources`、`seed` 全部=object；Composition ref 自身=composition。
- `ExecutionRecord`：`method`=method、`composition`=composition、`inputs[]`/`outputs?[]`=object。
- Evidence、RoundPlan、preview、manifest、receipt 只验 CAS 存在与 digest，不解析内部字段。

## Done when

- 7 个 CAS domain 均可读写；默认 object 兼容；错域、缺失、篡改拒绝。
- open/replay 对 13 种 fact 顶层 refs 和四类结构化对象嵌套 refs 校验；orphan 不阻断。
- AcceptanceRef 不验证，其他已映射字段不放宽。
- 根 `pnpm verify` 与 `git diff --check` 通过；真实文件测试覆盖正负例。

## 检查命令

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

## 红证据

先写 `test/cas-reference-validation.test.ts`，实现前运行：

```bash
pnpm build
node --test packages/singularity/runtime/test/cas-reference-validation.test.ts
```

结果：

```text
SyntaxError: The requested module '../src/index.ts' does not provide an export named 'CAS_DIGEST_DOMAINS'
ℹ pass 0
ℹ fail 1
```

失败原因是新 API/常量尚未实现，不是断言放宽。实现初版后，现有 runtime 测试还暴露了旧测试 fixture 引用未落 CAS 的问题；这些测试改为无 ref 的 `rsi/round-closed` 或真实 object ref，而不是关闭校验。

## 绿证据

```bash
pnpm verify
git diff --check
```

结果：project、build、typecheck、lint、test 全部通过；protocol `189/189`、app `6/6`、runtime `29/29`（合计 `224`），`git diff --check` 通过。

## 覆盖摘要

- CAS domain round-trip：7 个 domain 的 raw bytes 写入/读取；默认 object 兼容。
- 结构化对象：sealed contract/method/composition/execution-record 使用 self digest；payload-only 与 full sealed 两种表示均可读。
- 负例：错域 `OBJECT_DOMAIN_MISMATCH`、缺失 `OBJECT_MISSING`、篡改 `OBJECT_CORRUPT`、非法 domain `INVALID_ARGUMENT`。
- 13 种 fact + 两个 `run/closed` 变体组成真实 14-fact journal；覆盖 method/contract/composition/execution/evidence/round-plan/object refs。
- 嵌套 refs：rich MethodRevision（parent/template guidance/example/acceptancePolicy/skill bundle/tool server refs）、TaskContract（method/template/inputs/resources/environment/requestRef）、Composition（dsh/skills/mcp/modelRoute/resources/seed）、ExecutionRecord（method/composition/inputs/outputs）。
- `AcceptanceRef` 指向未存对象仍可启动，证明该字段未被擅自验证；other fields 未跳过。
- orphan CAS object 不影响 replay；损坏/缺失嵌套对象拒绝启动。

## 仍未验证

- AcceptanceRef domain 仍未批准；本变更不覆盖。
- Evidence、RoundPlan、preview、SubmissionManifest、PublicReceipt 的内部 refs 未解析/校验。
- `CommandService.commit` 不预检新 fact 的引用完整性；完整性在 open/replay 生效。提交后引用缺失会导致下次启动拒绝，而不是提交时拒绝。
- 无跨进程 OS writer lock；writer ownership 仍是进程内。
- 未做掉电/强杀 fsync 故障注入；未实现业务 reducer、DSH、Agent、workspace、verifier 或真实模型路径。
- 任何 conformance 场景状态未改变，仍为 unproven。
