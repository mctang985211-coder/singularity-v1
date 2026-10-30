# S2-C1 任务卡：获批 amendment 与闭合 fact payload

- **状态**：已完成（K1–K5 获批并实现；K6 仍未证明）；S2 继续，下一 command/journal。

## Goal

将用户在 2026-10-30 确认的 `docs/amendments/001-s2-protocol-closure.md` K1–K5 推荐语义同步到正式规范和 spec-lock，并在纯 protocol 中实现 13 种闭合 fact payload、Fact envelope、supporting CAS 对象与 command digest domain 的单一 schema 权威。

## Spec refs

- 获批 amendment：`docs/amendments/001-s2-protocol-closure.md`，K1–K5；K6 继续要求实际证据前保持 unproven。
- `docs/framework.md` §4、§8、§10、§15.2、§19.1、§21。
- `spec-lock.json` 与 `docs/framework.md` 同步更新，spec sha256=`6f4a57e7987c8def2b5e12504fb8a6e2599968161f94115a473b8b98ed29fd91`。
- `docs/build-plan.md` S2。

## 允许修改范围

- `docs/framework.md`、`spec-lock.json`、获批 amendment 的确认记录、conformance 的证据说明（不改变状态）
- `packages/singularity/protocol` 的 fact/supporting schema、index 与对应 package tests
- 本任务卡、构建计划、README 的实际状态

## 非目标

- 不实现 normalized command 计算、command service、journal FS/replay、reducer、runtime、CAS 存在性检查或业务 guard，不新增第二 writer/fold/wake/registry/transcript/model loop。
- 不采用未获批的 `commandRef + CAS` 备选，不引入 ContractSummary.usage 或额外 authority。
- 不修改 DSH/Node/MCP transport，不将任何 conformance 场景提前改为 proven。

## Done when

- amendment 记录用户 2026-10-30 对 K1–K5 的确认，K6 仍未证明；framework、spec-lock、amendment 与 conformance 在同一变更中一致更新，spec sha256=`6f4a57e7987c8def2b5e12504fb8a6e2599968161f94115a473b8b98ed29fd91`。
- 13 种 fact payload 是单一 strict union；type/data 严格对应，未知 type/字段、错误 optional 组合、错误 digest domain 均拒绝。
- Fact envelope 含获批 `commandDigest`，digest domain 在既有 8 个末尾追加 `command`，共 9 个且顺序不变。
- supporting UsageRecord/ExecutionRecord/Composition/SessionCut/BudgetReservation/CancellationCut 按获批语义验证；`task/children-admitted` 内联完整 child contracts、host 派生 join/budget/replacement；类型均由 schema 推导。
- `run/closed` 恰好一个 result ref（`evidenceRef` 与 `executionRecordRef` 二选一）且 classification 合法。
- 根 `pnpm verify` 全通过；journal/command/reducer/runtime 和真实场景仍未验证项明确保留。

## 检查命令

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

## 失败证据与运行记录

### 初始红证据

新增 fact payload/envelope/supporting tests 后、实现前：`src/fact.ts` 尚不存在，相关测试报 `ERR_MODULE_NOT_FOUND`；digest 测试仍按 8 个 domain 断言，`command` 未追加而失败。

### 绿证据

父代理集成后，在官方 Node `24.9.0`、pnpm `11.18.0`、DSH `0.2.2-alpha.2`（app 组合）环境运行：

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

结果：frozen install 通过；protocol tests `109/109`、app tests `6/6`；根 `pnpm verify` 的 project、typecheck、lint、test、build 全部通过；`git diff --check` 通过。

### 规范落地

- 用户于 2026-10-30 确认 K1–K5；K6 仍未证明。
- `docs/framework.md`、`spec-lock.json`、获批 amendment 与 `docs/conformance.md` 已在同一变更更新；`docs/framework.md` sha256=`6f4a57e7987c8def2b5e12504fb8a6e2599968161f94115a473b8b98ed29fd91`。
- conformance 只补充 amendment 链接与证据边界；所有场景保持 `unproven`。

### 覆盖摘要

- 13 种 fact payload 由 `factPayloadSchemaByType` 单一映射到 strict schema；未知 type/字段、错误 optional 组合与错误 digest domain 拒绝。
- Fact envelope 含 `commandDigest`；`DIGEST_DOMAINS` 在既有 8 个末尾追加 `command`，共 9 个；fact seal/verify 使用 `fact` domain。
- supporting 对象：UsageRecord（含 summary）、ExecutionRecord、Composition、SessionCut、BudgetReservation、CancellationCut 均由 strict schema 推导类型。
- `run/closed` 是 schema union，`evidenceRef` 与 `executionRecordRef` 恰好一个，且 classification 与 result 类型匹配。
- `task/children-admitted` 保留完整 child contracts，并验证 host 派生 join、budget reservation 与 replacement。
- index 导出 fact envelope、payload 与 supporting schemas；既有 protocol surface 保留。

### 仍未验证

- normalized command 计算、command service、journal/replay、reducer 与 runtime 未实现；CAS 存在性和业务 guard 未验证。
- 没有真实 DSH runtime、journal replay、取消/恢复或领域任务证据。
- 所有 conformance 场景（含 C-01/C-05/C-11 及相关 amendment 场景）保持 `unproven`；`docs/conformance.md` 与 `spec-lock.json` 未在本范围再修改。

结论：S2-C1 完成；S2 继续，下一 command/journal。
