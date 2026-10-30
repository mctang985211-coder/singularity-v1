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

待首个复现和实现后填写实际命令、结果与未验证项。
