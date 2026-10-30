# S3 PlanningSketch schema 任务卡

- **状态**：已完成（纯 protocol strict schema 与 `z.infer` 类型；levels 已按集成审查收紧为 `[0,1]`/`[0,1,2]` schema union）；S3 继续，未实现 host guard、receipt 或 runtime。acceptance/submission amendment 仍待用户确认，S3 验收前规范阻断，不宣称 S3-B 开始。

## Goal

按 `docs/framework.md` §6.3 冻结的字段实现 `PlanningSketch` 的单一 zod strict schema 与派生 TS 类型，并用 schema union 精确约束 `levels` 只能是按序的 `[0,1]` 或 `[0,1,2]`。验证非法 level/序列、未知字段及模型侧 authority 字段拒绝。只做结构校验，不创建 Task/Workflow/调度 authority。

## Spec refs

- `docs/framework.md` §6.3、§14.1
- `docs/build-plan.md` S4（PlanningSketch 归属）与 S3 当前边界
- `AGENTS.md` §2.7、§3、§5

## 允许修改范围

- `packages/singularity/protocol/src/planning.ts`（新增）
- `packages/singularity/protocol/src/index.ts`（导出）
- `packages/singularity/protocol/test/planning.test.ts`（新增）
- `docs/tasks/s3-planning-schema.md`（本任务卡）

## 非目标

- 不实现 `singularity_plan` tool、CAS sketch receipt、context epoch guard 或 `decompose commit`/`submit` 的 receipt 引用。
- 不校验 `taskId`/`runId`/`contextEpoch`/`sourceContract` 与当前 Run 的匹配，不校验 `directPlan` 只引用可见 binding；这些是 host guard，不是 schema。
- 不实现 `directPlan.join`、acceptance、resources、verifier、environment、limits 或任何调度/验收字段。`directPlan` 仍只表达 level 1 direct-child 意图，不接受 `level` 字段，不表达 level 2。
- 不实现 Task、Workflow、Graph、调度、runtime 或祖先查询。
- 不宣称 C-08 或其他 conformance 场景 proven。

## Done when

- `planningSketchSchema` 严格包含且仅包含：`v`、`taskId`、`runId`、`contextEpoch`、`objective`、`levels`、`directPlan`、`assumptions`、`sourceContract`。
- `levels` 用 zod schema union 精确表达按序的 `[0,1]` 或 `[0,1,2]`：level 0 当前 Task、level 1 direct children、level 2 可选 grandchildren；拒绝空数组、仅 `[0]`、重复、乱序、跳级和超过三项。
- `levels` 每项严格包含 `level`、`purpose`、`likelyChildren`、`expectedInputs`、`expectedOutputs`；`directPlan` 每项严格包含 `bindingId`、`purpose`，仍是仅表达 level 1 的扁平列表。
- `PlanningSketch` 由 `z.infer<typeof planningSketchSchema>` 派生，无平行手写类型或 validator。
- 合法 `[0,1]`/`[0,1,2]` 草图通过；非法 level、非法序列、任意层级未知字段、`directPlan.join`、模型 `acceptance`/`resources`/`verifier` 等字段被拒绝。
- protocol 包 typecheck、lint、test 通过；根 `pnpm verify` 通过；`git diff --check` 通过。

## 检查命令

```bash
pnpm install --frozen-lockfile
pnpm --filter @singularity/protocol typecheck
pnpm --filter @singularity/protocol lint
pnpm --filter @singularity/protocol test
pnpm verify
git diff --check
```

## 失败证据与运行记录

环境：官方 Node `24.9.0`（`/tmp/node249/bin`）、pnpm `11.18.0`；独立 worktree `/home/ROXY/code/singularity-v1-planning-schema`，独立 `HOME` 与 pnpm store。基线为 `s3-a-journal-cas` HEAD `496615e`。

### 红证据

先写 `test/planning.test.ts`，在 `src/planning.ts` 尚不存在时运行：

```bash
node --test test/planning.test.ts
```

结果：`ERR_MODULE_NOT_FOUND`，找不到 `src/planning.ts`；tests `0/1` 通过、`1` 失败。失败原因是缺少实现，不是放宽断言。

### 绿证据

```bash
pnpm --filter @singularity/protocol typecheck
pnpm --filter @singularity/protocol lint
pnpm --filter @singularity/protocol test
pnpm verify
git diff --check
```

结果：protocol typecheck 与 lint 通过；protocol tests `187/187`（新增 planning `9/9`）；根 `pnpm verify` 的 project、build、typecheck、lint、test 全部通过，其中 protocol `187/187`、app `6/6`、runtime `20/20`（合计 `213`）；`git diff --check` 通过。

### 集成审查修正：levels 精确序列

审查确认 framework 要求 worker 提交 2–3 层草图，且 level 0/1/2 分别对应当前 Task、direct children、可选 grandchildren。首版 schema 只约束每个 level 的值，未约束序列。按审查意见改为 zod schema union，不使用 `superRefine`：

```ts
z.union([
  z.tuple([level0Schema, level1Schema]),
  z.tuple([level0Schema, level1Schema, level2Schema]),
])
```

红证据：先增加 `[0,1]`/`[0,1,2]` 之外的序列负例，再改 schema。旧 schema 下运行 `node --test test/planning.test.ts` 得到 tests `11`、pass `10`、fail `1`，失败为 `AssertionError: Missing expected exception: empty levels`（空数组被旧 schema 接受）。新增的 `directPlan` level 字段负例同时通过，确认 `directPlan` 不引入 level 2。

绿证据（本次修正后）：

```bash
node --test test/planning.test.ts                    # 11/11
pnpm --filter @singularity/protocol typecheck        # 通过
pnpm --filter @singularity/protocol lint             # 通过
pnpm --filter @singularity/protocol test             # 189/189
pnpm verify                                          # 通过
git diff --check                                     # 通过
```

根 `pnpm verify` 结果：protocol `189/189`（planning `11/11`）、app `6/6`、runtime `20/20`（合计 `215`）。

### 覆盖摘要

- `planningSketchSchema` 使用 `closedObject`（`z.strictObject`）覆盖根对象、level 项和 directPlan 项；未知字段在任一层都被拒绝。
- `v` 仅接受 `1`；`sourceContract` 复用冻结的 `digestSchema`；`levels` 是 `z.union([z.tuple([level0, level1]), z.tuple([level0, level1, level2])])`，每个位置的 level 为对应 literal，不使用 `superRefine`。
- `levels` 只接受按序的 `[0,1]` 或 `[0,1,2]`；空数组、仅 `[0]`、重复、乱序、跳级、超过三项均由 tuple 长度与位置 literal 拒绝。
- `directPlan` 仍是扁平的 `{ bindingId, purpose }` 列表，只表达 level 1 direct-child 意图；不接受 `level`、`join` 或其他 level 2/authority 字段。
- `PlanningSketch` 类型直接 `z.infer`；没有第二套字段定义。
- 根级、level 级、directPlan 级的 `acceptance`、`resources`、`verifier`、`join`、`required`、`role` 等模型 authority 字段全部拒绝；`directPlan.join` 单独覆盖。
- `parseProtocolValue` 验证 schema 不 transform/default，且测试确认输入不被修改。

### 仍未验证

- host 对 `taskId`/`runId`/`contextEpoch`/`sourceContract` 与当前 Run/合同的一致性校验未实现。
- `directPlan.bindingId` 是否属于当前可见 binding 的 host 校验未实现。
- `singularity_plan` tool 接线、CAS sketch 写入、receipt 生成、epoch 失效、`decompose commit`/`submit` 对当前 epoch receipt 的引用均未实现。
- `directPlan.join` 的固定 Method 派生、preview/children-admitted/NodeView 呈现未实现。
- Task/Workflow/调度 authority、祖先查询、runtime、真实模型场景均未涉及。
- C-08 及所有 conformance 场景保持 unproven。

结论：PlanningSketch schema 完成；S3-B 未开始，等待 acceptance/submission amendment 用户确认。
