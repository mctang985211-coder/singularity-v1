# S3-B1 任务卡：获批 acceptance 与 submission schema

## Goal

将用户已批准的 amendment 002 最终推荐包同步到正式规范、spec-lock 和 protocol，形成 PublicReceipt、SubmissionManifest、host 验收分类与输出冻结形状的单一 strict schema 权威。

## Spec refs

- `docs/amendments/002-acceptance-and-submission.md` A0–A9；用户于 2026-10-30 回复“全部确定，以后不需要向我确认任何事，自行推进”。
- `docs/framework.md` §4.0、§11.4–§11.5、§15.2、§19、§23.2。
- `docs/build-plan.md` S3。

## 允许修改范围

- 正式规范、spec-lock、amendment 确认记录、conformance 证据说明（不升级状态）
- protocol acceptance schema、校验函数、index 与 tests
- 本任务卡、README、构建计划的实际状态

## 非目标

- 不实现 DSH Agent/workspace/verifier 执行、第二 writer/fold/wake/registry/transcript/model loop 或生产 activation。
- 不扩展 ExecutionRecord 记录 invalid receipt，不公开 privateReceipt schema，不新增 digest domain 或错误码。
- 不将 C-02/C-03/C-11 提前标为 proven。

## Done when

- amendment 记录批准，framework/spec-lock/protocol/conformance 同步一致。
- PublicReceipt 校验 provider/operationId/contract/input/output digests、required criteria 恰一次、metric/score、exit/timedOut；host 正确分类 verified/failed/invalid。
- SubmissionManifest 校验非 draft outputs、learningDrafts、includeLearningDrafts、checks、顺序和 object domain digest。
- 全部对象 strict，类型由 zod 推导，根 `pnpm verify` 通过，执行路径未验证项明确保留。

## 检查命令

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

## 失败证据与运行记录

### 失败证据（实现前）

基线 `7734cc9` 上没有 `packages/singularity/protocol/src/acceptance.ts`。先加入两个测试文件后执行：

```bash
cd packages/singularity/protocol
PATH=/tmp/node249/bin:$PATH node --test test/acceptance.test.ts test/submission-manifest.test.ts
```

实际结果：`tests 2 / pass 0 / fail 2`，两个文件都以 `ERR_MODULE_NOT_FOUND` 指向缺失的 `src/acceptance.ts`；证明 receipt/manifest schema、seal 与 validator 尚不存在。

### 实现（本切片）

- `src/acceptance.ts`：`PublicReceipt`、`PublicCriterionResult`、`PublicExitStatus`、`SubmissionManifest`、`SubmittedOutput`、`SubmittedLearningDraft`、`SubmissionCheck` 全部 strict schema 且类型由 `z.infer` 推导。
- `sealPublicReceipt` / `sealSubmissionManifest` 使用既有 `object` domain；未新增 digest domain，domain 集合仍为 9 个。
- `validatePublicReceipt` 校验 provider、operationId、contract/input/output digest 精确匹配、required criteria 恰一次、reason、metric/score、exit/timedOut，返回 `verified`/`failed`/`invalid`；receipt schema 不设总 verdict 字段，`invalid` 只返回诊断 reason。
- `validateSubmissionManifest` 校验 task/run/contract、合同非 draft 输出顺序、required output 冻结 object、draft 固定顺序与合同声明、`includeLearningDrafts` 规则、checks 与冻结对象一一对应及顺序。
- `src/index.ts` 导出 acceptance 模块；未实现 runtime、DSH、submit、external verifier、Evidence schema 或 privateReceipt schema。

### 通过证据（实现后）

```bash
cd packages/singularity/protocol
PATH=/tmp/node249/bin:$PATH pnpm typecheck   # pass
PATH=/tmp/node249/bin:$PATH pnpm lint        # pass
PATH=/tmp/node249/bin:$PATH pnpm test        # 223/223 pass（新增 acceptance/manifest 测试 34 个）

cd /home/ROXY/code/singularity-v1-swarm-acceptance
HOME=/tmp/s3b1-swarm-home PNPM_HOME=/tmp/s3b1-swarm-pnpm-home \
  PATH=/tmp/node249/bin:$PATH pnpm verify    # exit 0
```

根 `pnpm verify` 实际执行：`verify:project` 通过、`tsc -b` 通过、3 个 workspace typecheck 通过、3 个 workspace lint 通过、测试 protocol 223/223、app 6/6、runtime 30/30 全通过。

新增测试覆盖：verified/failed/invalid 分类；exit=0 不充分；fail + exit=0 仍 failed；fail + 非 0 exit 仍 failed；all pass + 非 0 exit 为 invalid；invalid criterion、timeout、signal 均为 invalid；provider/operationId/contract/input/output digest 不匹配；错误 digest domain 与 seal 后 tamper；NaN/Infinity metric、score 缺 metric、invalid criterion 携带 metric/score、空 metric name/unit、缺 reason；非 required/重复/缺失 criterion；manifest task/run/contract 不匹配；合同输出顺序、字段、缺失/多余输出；required object 缺失；drafts 固定顺序、唯一性、id/path/role 形状与合同声明；`includeLearningDrafts=false/true` 规则；checks 缺失、多余、乱序、错误 bytes/symlinks/重复；未知字段与错误版本。

### 未覆盖项

- 未实现或验证真实 submit、external verifier、Evidence 生成、`ExecutionRecord(invalid)`、runtime/DSH/Agent 路径；本切片只有 pure protocol 证据。
- 未新增 Evidence schema：当前校验消费者只需要 receipt/manifest，Evidence 仍由后续 runtime 切片消费。
- `privateReceipt` 保持 opaque `ObjectRef`，未冻结 schema。
- C-02/C-03/C-11 及全部 conformance 状态未升级，仍为 `unproven`。
- 本分支不修改 `docs/framework.md`、`spec-lock.json`、`docs/conformance.md`、README/build-plan；这些属于同一获批变更的其他所有者，需在集成时合并。
