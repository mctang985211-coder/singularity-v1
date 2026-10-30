# S2-C1 任务卡：获批 amendment 与闭合 fact payload

## Goal

将用户在 2026-10-30 确认的 `docs/amendments/001-s2-protocol-closure.md` K1–K5 推荐语义同步到正式规范和 spec-lock，并在纯 protocol 中实现 13 种闭合 fact payload、Fact envelope、 supporting CAS 对象与 command digest domain 的单一 schema 权威。

## Spec refs

- 获批 amendment：`docs/amendments/001-s2-protocol-closure.md`，K1–K5；K6 继续要求实际证据前保持 unproven。
- `docs/framework.md` §4、§8、§10、§15.2、§19.1、§21。
- `docs/build-plan.md` S2。

## 允许修改范围

- `docs/framework.md`、`spec-lock.json`、获批 amendment 的确认记录、conformance 的证据说明（不改变状态）
- `packages/singularity/protocol` 的 fact/supporting schema、index 与对应 package tests
- 本任务卡、构建计划、README 的实际状态

## 非目标

- 不实现 journal FS、command service、reducer、runtime、第二 writer/fold/wake/registry/transcript/model loop。
- 不采用未获批的 `commandRef + CAS` 备选，不引入 ContractSummary.usage 或额外 authority。
- 不修改 DSH/Node/MCP transport，不将任何 conformance 场景提前改为 proven。

## Done when

- amendment 记录用户确认，framework 与 spec-lock 在同一变更中一致更新。
- 13 种 fact 的 type/data 严格对应；未知 type/字段、错误 optional 组合、错误 digest domain 均拒绝。
- Fact envelope 含获批 `commandDigest`，digest domain 在既有 8 个末尾追加 `command`。
- supporting UsageRecord/ExecutionRecord/Composition/SessionCut/BudgetReservation/CancellationCut 及完整 child contracts 按获批语义验证，类型均由 schema 推导。
- 根 `pnpm verify` 全通过；journal/command/reducer/runtime 和真实场景仍未验证项明确保留。

## 检查命令

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

## 失败证据与运行记录

待首个复现和实现后填写实际命令、结果与未验证项。
