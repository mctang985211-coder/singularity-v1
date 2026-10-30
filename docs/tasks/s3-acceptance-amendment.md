# S3 前置任务卡：Acceptance amendment（最终候选）

- **状态：最终候选，待用户一次性确认；未批准、未实现。** 本任务只修改两份文档，不修改规范、源码或 conformance。
- **分支：** `s3-acceptance-amendment-final`
- **基线：** `main` @ `bf79e3a7fec560ab91d62de867c2d41d22f0de7a`（含 PlanningSketch schema 与 amendment 002 草案）。
- **Worktree：** `/home/ROXY/code/singularity-v1-acceptance-final`
- **提案文档：** `docs/amendments/002-acceptance-and-submission.md`
- **本任务性质：** 将原 Q1–Q11 收敛为一个推荐包，形成可一次性批准/拒绝的最终候选；仍不实现、不把推荐字段写成已批准事实。

## Goal

把 amendment 002 的 11 个待确认问题收敛为一个整体推荐包：`AcceptanceRef=object`、receipt 不设总 verdict、host 派生分类、有序 input/output digests、`Evidence.inputs` 与 verifier 授权输入一致、criterion reason/metric/score 规则、独立 `timedOut`、SubmissionManifest 的 outputs/learningDrafts 拆分、required `checks`、opaque privateReceipt、invalid receipt 仅诊断、conformance 不变。用户只需做一个批准/拒绝决定。

## Spec refs

- `docs/framework.md` §4.0（Ref/digest domain）、§4.3（acceptance authority）、§9.1–§9.2（Task/Run 状态与 closure）、§10.1–§10.3（command/fact/CAS/journal）、§11.4–§11.5（submit/verify）、§12.3（direct child 读取与 Evidence.inputs）、§15.2（Evidence/ExecutionRecord/receipt）、§19–§19.1（DomainAdapter/恢复）、§20（C-02/C-03/C-11）。
- 已批准 amendment `docs/amendments/001-s2-protocol-closure.md` K1–K6；本推荐包声明 K1–K6 不变，A0 仅补充 K3 允许的 `AcceptanceRef` 映射。
- `AGENTS.md` §1、§3、§4、§6、§7；`docs/build-plan.md` S3。
- `docs/conformance.md` C-02/C-03/C-11；本任务不改变其 `unproven` 状态。

## 允许修改范围

- `docs/amendments/002-acceptance-and-submission.md`
- `docs/tasks/s3-acceptance-amendment.md`
- 本任务卡记录实际验证命令与结果

明确不修改：

- `docs/framework.md`、`spec-lock.json`、`docs/conformance.md`
- `docs/build-plan.md`、`README.md`
- `packages/**`、`apps/**`、`scripts/**`、lockfile、tsconfig 或 CI

## 非目标

- 不实现 `PublicReceipt`、`SubmissionManifest`、submit/verifier/runtime/DSH/Agent。
- 不新增 fact、digest domain、authority、writer、fold、registry、transcript、model loop 或第二账本。
- 不修改验收所有者、读取授权、模型可见性、retry/join/取消语义或生产权限。
- 不把任何推荐字段写成已批准事实；批准前不得实现。
- 不把 C-02/C-03/C-11 或任何 conformance 场景改为 `proven`。
- 不 push、reset、rebase 或修改父 checkout。

## Done when

- amendment 将 Q1–Q11 收敛为一个推荐包，并给出单一批准/拒绝决定。
- `PublicReceipt` 推荐覆盖 provider、operationId、contract/input/output digest、required criterion 恰一次、id+verdict、reason 全 verdict、metric/score 仅 pass/fail 且 score 必须伴随 metric、非 required criterion 拒绝、`exit{code,signal}` 与独立 `timedOut`。
- `SubmissionManifest` 推荐覆盖 v/taskId/runId/contractDigest、非 draft outputs 与 learningDrafts 分离、required `includeLearningDrafts`、缺目录空数组、required `checks`（bytes/symlinks:'none'）、部署 size cap、稳定排序。
- 明确 `AcceptanceRef=object`、receipt 无总 verdict、`Evidence.inputs` 与 verifier 授权输入一致（含 direct child outputs）、privateReceipt opaque、invalid receipt 仅诊断且不扩 ExecutionRecord、conformance 不变。
- 保留最小复现、扩展点不足、权限/预算、兼容性、K1–K6 不变性和明确不兼容清单。
- 最终 diff 只包含这两份文档；根 `pnpm verify` 与 `git diff --check` 通过。
- 状态明确为“待用户一次性确认；未批准、未实现”。

## 检查命令

```bash
pnpm install --frozen-lockfile --store-dir /tmp/singularity-v1-acceptance-final-store
pnpm verify
git diff --check
git diff --name-only bf79e3a7fec560ab91d62de867c2d41d22f0de7a
```

## 失败证据与运行记录

### 环境

- 官方 Node `24.9.0`：`/tmp/node249/bin/node`（pnpm 由该 Node 直接执行；PATH 首位为 `/tmp/node249/bin`）。
- pnpm `11.18.0`：buckyball PATH。
- 独立 worktree：`/home/ROXY/code/singularity-v1-acceptance-final`。
- 独立 HOME：`/tmp/singularity-v1-acceptance-final-home`。
- 独立 pnpm store：`/tmp/singularity-v1-acceptance-final-store`。
- 父 checkout `main` @ `bf79e3a` 未修改；未 push/reset/rebase。

### 红证据（文档缺口）

本任务不是代码实现，没有可运行的失败测试。开始前确认当前仓库不存在 `PublicReceipt`/`SubmissionManifest` schema、`VerifyRequest`、acceptance receipt 校验或 submission manifest 构建代码；`Evidence.verification.publicReceipt`/`privateReceipt` 仅有 `ObjectRef`，`run/submitted.outputs` 仅有 `ObjectRef`。因此任何实现都必须先猜字段，正是本 amendment 要阻止的失败方式。

```bash
grep -R "PublicReceipt\|SubmissionManifest\|VerifyRequest" -n packages --exclude-dir=dist
# 无输出；packages 下没有这些类型或实现。
```

### 绿证据

```bash
pnpm install --frozen-lockfile --store-dir /tmp/singularity-v1-acceptance-final-store
# Lockfile up to date; packages installed from the isolated store.

pnpm verify
# project → build → typecheck → lint → test, all passed.
# protocol 189/189; app 6/6; runtime 20/20 (215 total).

git diff --check
# Passed.
```

注意：`pnpm verify` 只证明仓库在新增/修改文档后仍满足既有门禁；它不证明 acceptance/manifest 语义正确，也不替代 C-02/C-03/C-11 的真实证据。

## 覆盖摘要

- 将 Q1–Q11 收敛为单一推荐包，并在 amendment §9 给出 Q→推荐值映射和“批准/拒绝”单一决定。
- `AcceptanceRef=object`；`PublicReceipt.provider` 与冻结 acceptance provider、`Evidence.verification.provider` 做 id/digest 比较。
- receipt 不设总 verdict；host 从 required criteria、`exit`、`timedOut` 派生 `verified`/`failed`/`invalid`；exit=0 不充分。
- input/output digests 为有序数组；`Evidence.inputs` 与 verifier 授权输入一致（含 direct child outputs），`Evidence.outputs` 与冻结输出一致。
- `reason` 全 verdict 必填；`metric`/`score` 仅 pass/fail；`score` 必须伴随 `metric`；非 required criterion 拒绝。
- `exit={code,signal}` 对未超时的实际终止状态恰一个非 null；timeout 使用独立 `timedOut:boolean`，不模拟 signal。
- `SubmissionManifest` 的 `outputs` 只含非 draft；`learningDrafts` 独立且必填，缺目录为空数组；`includeLearningDrafts` 必填；`checks` 必填；size cap 属部署 policy。
- privateReceipt 保持 opaque；invalid receipt 仅 operator 诊断，不写 Evidence、不扩 ExecutionRecord；conformance 不变。
- 明确列出与推荐包不兼容的实现；README/build-plan 仍描述 Q1–Q11 待决定，本任务按范围不修改，标注为文档滞后。

## 仍未验证

- 所有 A0–A9 与 §9 推荐值仍是最终候选；用户未确认，规范/spec-lock/conformance 未更新。
- 未实现 `PublicReceipt`、`SubmissionManifest`、submit、external verifier、Evidence、ExecutionRecord、runtime/DSH 或真实模型路径。
- 未执行 C-02/C-03/C-11 或任何 conformance 场景；所有场景保持 `unproven`。
- symlink/size 检查只有 host 断言和边界说明，没有真实文件系统测试证据。
- 未验证真实 verifier 的 exit/timeout 语义、privateReceipt 的部署授权、provider/AcceptanceRef 的实际解析方式。
- `pnpm verify` 通过不构成 acceptance 语义或领域验收证据。

## 结论

最终候选已提交，等待用户单一决定：**批准/拒绝推荐包**。批准前不得实现 `PublicReceipt`/`SubmissionManifest`，也不得把 C-02/C-03/C-11 标为 `proven`。
