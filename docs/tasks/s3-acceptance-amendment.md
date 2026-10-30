# S3 前置任务卡：Acceptance amendment（草案）

- **状态：草案，待用户确认；未批准、未实现。** 本任务只新增两份文档，不修改规范、源码或 conformance。
- **分支：** `s3-acceptance-amendment`
- **基线：** `s3-a-journal-cas` @ `496615e9bedb31970db7b9dbb0529d4b5f1aade8`
- **提案文档：** `docs/amendments/002-acceptance-and-submission.md`
- **本任务性质：** 独立 S3 前置工作；为后续单 Run 执行闭环冻结 `PublicReceipt`/`SubmissionManifest` 的最小提案、失败场景和待确认项，避免实现先用未冻结字段形成行为。

## Goal

在 S3 单 Run 执行闭环前，明确验收 receipt 与提交 manifest 的最小 schema、校验规则、CAS/digest 身份、privateReceipt 隔离、ExecutionRecord 边界、权限/预算影响和 C-02/C-03/C-11 影响；同时把所有未决点列为待用户确认项，而不是写成已批准事实。

## Spec refs

- `docs/framework.md` §4.0（Ref/digest domain）、§4.3（acceptance authority）、§9.1–§9.2（Task/Run 状态与 closure）、§10.1–§10.3（command/fact/CAS/journal）、§11.4–§11.5（submit/verify）、§15.2（Evidence/ExecutionRecord/receipt）、§19–§19.1（DomainAdapter/恢复）、§20（C-02/C-03/C-11）。
- 已批准 amendment `docs/amendments/001-s2-protocol-closure.md` K1–K6（command identity、journal、ref domain、output merge、fact payload、conformance 证据规则）。
- `AGENTS.md` §1、§3、§4、§6、§7；`docs/build-plan.md` S3。
- `docs/conformance.md` C-02/C-03/C-11；本任务不改变其 `unproven` 状态。

## 允许修改范围

- 新增 `docs/amendments/002-acceptance-and-submission.md`
- 新增 `docs/tasks/s3-acceptance-amendment.md`
- 本任务卡记录实际验证命令与结果

明确不修改：

- `docs/framework.md`、`spec-lock.json`、`docs/conformance.md`
- `docs/build-plan.md`、`README.md`
- `packages/**`、`apps/**`、`scripts/**`、lockfile、tsconfig 或 CI

## 非目标

- 不实现 `PublicReceipt`、`SubmissionManifest`、submit/verifier/runtime/DSH/Agent。
- 不新增 fact、digest domain、authority、writer、fold、registry、transcript、model loop 或第二账本。
- 不修改验收所有者、读取授权、模型可见性、retry/join/取消语义或生产权限。
- 不把任何推荐字段、optional 字段或检查证据写成已批准事实。
- 不把 C-02/C-03/C-11 或任何 conformance 场景改为 `proven`。
- 不 push、reset、rebase 或修改父 checkout。

## Done when

- amendment 草案包含：规范条目、最小复现/失败场景、现有扩展点不足、拟改语义、权限/预算、兼容性、conformance 影响、用户确认记录和待确认问题。
- `PublicReceipt` 提案覆盖 provider、operationId、contract/input/output digests、required criterion 恰一次、id+verdict、公开 reason/metric+unit/finite score、raw exit status，以及 verified/failed/invalid 与 exit=0 不足的关系。
- `SubmissionManifest` 提案覆盖 v/taskId/runId/contractDigest、output id/path/kind/role/required、冻结 object refs、可选 learning drafts、稳定排序和 symlink/size 检查证据边界。
- 明确 privateReceipt 隔离、ExecutionRecord 不需要 acceptance receipt、object/evidence digest domain、权限预算兼容性和 C-02/C-03/C-11 影响。
- 最终 diff 只包含上述两份新文档；根 `pnpm verify` 与 `git diff --check` 通过。
- 状态明确为“待用户确认未批准”；未实现、未验证项如实记录。

## 检查命令

```bash
pnpm install --frozen-lockfile --store-dir /tmp/singularity-v1-acceptance-store
pnpm verify
git diff --check
git diff --name-only 496615e9bedb31970db7b9dbb0529d4b5f1aade8
```

## 失败证据与运行记录

### 环境

- 官方 Node `24.9.0`：`/tmp/node249/bin/node`（pnpm 由该 Node 直接执行；PATH 首位为 `/tmp/node249/bin`）。
- pnpm `11.18.0`：buckyball PATH。
- 独立 worktree：`/home/ROXY/code/singularity-v1-acceptance-amendment`。
- 独立 HOME：`/tmp/singularity-v1-acceptance-home`。
- 独立 pnpm store：`/tmp/singularity-v1-acceptance-store`。
- 父 checkout 未修改；未 push/reset/rebase。

### 红证据（文档缺口）

本任务不是代码实现，没有可运行的失败测试。开始前确认当前仓库不存在 `PublicReceipt`/`SubmissionManifest` schema、`VerifyRequest`、acceptance receipt 校验或 submission manifest 构建代码；`Evidence.verification.publicReceipt`/`privateReceipt` 仅有 `ObjectRef`，`run/submitted.outputs` 仅有 `ObjectRef`。因此任何实现都必须先猜字段，正是本 amendment 要阻止的失败方式。

```bash
grep -R "PublicReceipt\|SubmissionManifest\|VerifyRequest" -n packages --exclude-dir=dist
# 无输出；packages 下没有这些类型或实现。
```

### 绿证据

```bash
pnpm install --frozen-lockfile --store-dir /tmp/singularity-v1-acceptance-store
# Lockfile up to date; 701 packages installed from the isolated store.

pnpm verify
# project → build → typecheck → lint → test, all passed.
# protocol 189/189; app 6/6; runtime 20/20 (215 total).

git diff --check
# Passed.
```

注意：本任务卡自身只新增两份文档；同分支随后集成 PlanningSketch schema 后，根 verify 计数为 protocol `189/189`、app `6/6`、runtime `20/20`（合计 `215`）。`pnpm verify` 只证明仓库仍满足既有门禁；它不证明 acceptance/manifest 语义正确，也不替代 C-02/C-03/C-11 的真实证据。

## 覆盖摘要

- 记录了 `AcceptanceRef`/provider identity 的未冻结缺口，并把它列为 A0 待确认项；未擅自给 `AcceptanceRef` 定 domain。
- `PublicReceipt` 提案把 receipt 限定为 strict CAS object：provider、稳定 operationId、contract/input/output digests、required criteria 恰一次、criterion verdict/reason/metric/score 规则、raw exit status；host 派生 `verified`/`failed`/`invalid`，exit=0 不充分。
- `SubmissionManifest` 提案把声明与冻结 refs 绑定：合同顺序的非 draft outputs、固定顺序的 optional learning drafts、每个冻结输出的 `checks`、object-domain seal。
- 明确 manifest/receipt 使用 `object` domain，Evidence 使用 `evidence` domain；不新增 domain、fact 或 writer。
- 明确 no-submission/stop/invalid/cancelled 走 ExecutionRecord，不伪造 receipt；invalid receipt 不是 acceptance Evidence；retry 不复制旧 verdict。
- 记录 C-02/C-03/C-11 的增量影响：submit→manifest→external verify→receipt→Evidence（verified/criteria-failed failed）或 ExecutionRecord（invalid）；C-03 的 no-submission/stop/cancelled 无 receipt；C-11 对象先于 fact、幂等重放不重验、固定 operationId 恢复。
- 列出 Q1–Q11 共 11 个待确认问题，未把任何推荐字段写成已批准事实：AcceptanceRef domain（Q1）、PublicReceipt verdict/digests/metric/exit（Q2–Q5）、SubmissionManifest 拆分/checks（Q6–Q8）、privateReceipt opaque（Q9）、conformance 不变（Q10）、invalid receipt 去向（Q11）。

## 仍未验证

- 所有 A0–A9 字段和规则仍是提案；用户未确认，规范/spec-lock/conformance 未更新。
- 未实现 `PublicReceipt`、`SubmissionManifest`、submit、external verifier、Evidence、ExecutionRecord、runtime/DSH 或真实模型路径。
- 未执行 C-02/C-03/C-11 或任何 conformance 场景；所有场景保持 `unproven`。
- symlink/size 检查只有 host 断言和边界说明，没有真实文件系统测试证据。
- 未验证真实 verifier 的 exit status 语义、privateReceipt 的部署授权、provider/AcceptanceRef 的实际解析方式。
- `pnpm verify` 通过不构成 acceptance 语义或领域验收证据。

## 结论

S3 前置文档完成；acceptance amendment 待用户确认。确认前不得用本提案字段实现 `PublicReceipt`/`SubmissionManifest`，也不得把 C-02/C-03/C-11 标为 `proven`。
