# S2-C2 任务卡：纯 normalized command 与 command journal 投影

- **状态**：已完成（纯 protocol command 计算/投影/幂等决策）；command service、journal FS/replay、runtime 未实现。

## Goal

在 `@singularity/protocol` 中实现获批的 `NormalizedCommand` strict schema、`command` domain digest、从已封存 `Fact[]` 重建的内存 command 投影，以及无副作用的 command 幂等决策。command 模块不依赖 journal 模块；journal 可直接消费投影与 replay 结果。

## Spec refs

- 获批 amendment：`docs/amendments/001-s2-protocol-closure.md` K1–K5（command identity、幂等、一 command 一 fact）。
- `docs/framework.md` §10.1（NormalizedCommand、commandId/commandDigest、幂等三分支）、§10.3（journal replay 边界）、§14.1（`IDEMPOTENCY_CONFLICT`）。
- `docs/build-plan.md` S2 工作项与 Done when。
- `docs/conformance.md` C-11；本任务只提供纯协议证据，状态保持 `unproven`。

## 允许修改范围

- `packages/singularity/protocol/src/command.ts`（新增）
- `packages/singularity/protocol/src/index.ts`（追加 command 导出）
- `packages/singularity/protocol/test/command.test.ts`（新增）
- 本任务卡

不修改 `docs/framework.md`、`spec-lock.json`、`docs/conformance.md`、`docs/build-plan.md`、既有 fact/schema/digest 实现或 app。

## 非目标

- 不实现 FS append/fsync、journal 文件 framing、torn tail、启动 replay、CAS 写入/读取、command service、唯一 writer、业务 guard/reducer、wake、runtime、DSH 或真实模型。
- 不新增持久 command 表、第二 ledger、第二 writer/fold、tool result 字段或 `commandRef + CAS` 备选。
- 不从 fact 重新执行命令；replay 只返回原 `Fact`，结果由既有 Fact/CAS 携带。
- 不将任何 conformance 场景改为 `proven`。

## Done when

- `NormalizedCommand` 是单一 zod strict schema，字段为 `v`、`commandId`、`tool`、`toolVersion`、`actor`、`scope`、`input`；未知字段拒绝；类型由 schema 推导。
- `computeCommandDigest` 先按 strict schema 校验，再使用 `command` domain；host 状态不能作为额外字段进入 digest。
- 投影从 `Fact[]` 建立 `commandId -> { commandDigest, seq, factDigest, fact }`；同一 `commandId` 出现多条 fact 时拒绝。
- `decideCommandIdempotency` 纯决策：无记录 `new`；同 ID 同 digest `replay` 原 `Fact`；同 ID 不同 digest `IDEMPOTENCY_CONFLICT`；不 append、不预留、不派 child、不唤醒。
- 新增测试先红后绿，覆盖 normalized 字段/未知字段、digest 稳定性与差异性、actor/scope 影响、host 状态隔离、重复 commandId 拒绝和幂等三分支。
- 根 `pnpm verify` 与 `git diff --check` 通过；`command.ts` 不依赖 journal，protocol 仍不依赖 DSH/FS/网络/进程/时钟。

## 检查命令

```bash
pnpm install --frozen-lockfile
pnpm --filter @singularity/protocol test
pnpm verify
git diff --check
```

## 失败证据与运行记录

环境：官方 Node `v24.9.0`（`/tmp/node249/bin`）、pnpm `11.18.0`；独立 worktree、`HOME=/tmp/s2-c2-command-home`、store `/tmp/s2-c2-command-store`。父 checkout 保持 `s2-c1-fact-payload` @ `c805f28` 且无改动。

### 红证据

先写 `test/command.test.ts`，实现前在 protocol 包运行：

```bash
node --test test/command.test.ts
```

结果：`ERR_MODULE_NOT_FOUND`，找不到 `src/command.ts`，`tests 1 / fail 1`。失败原因是 command 模块尚不存在，而不是断言放宽。

### 绿证据

实现后运行：

```bash
pnpm --filter @singularity/protocol test
pnpm verify
git diff --check
```

- protocol tests `119/119` 通过（新增 command tests `10/10`）。
- 根 `pnpm verify`：project verification、typecheck、lint、test、build 全部通过；其中 app tests `6/6`，protocol tests `119/119`。
- `git diff --check` 退出码 `0`。
- 首次实现后曾有一个测试失败，原因是测试误把空 `commandId` 当作非法；规范只要求 `string`，因此修正测试断言而未给 schema 增加规范外约束。

## 覆盖摘要

- `normalizedCommandSchema` 严格接受 `v`、`commandId`、`tool`、`toolVersion`、`actor`、`scope`、`input` 七个字段；根、actor、scope 的未知字段均拒绝；类型由 schema 推导。
- `computeCommandDigest` 先重新校验 strict shape，再使用 `command` domain；与 `object` domain 区分，同输入稳定，不同 commandId/tool/actor/scope/input 产生不同 digest。
- host-resolved state/contract/method/planning sketch/batch/feedback/budget/asOf/at/cursor 不是 `NormalizedCommand` 字段；带这些字段的输入在 schema 与 `computeCommandDigest` 两层均被拒绝，无法进入 digest。
- `projectCommandFacts` 从 `Fact[]` 建立 `commandId -> { commandDigest, seq, factDigest, fact }`；同一 commandId 的第二条 fact（无论 digest 是否相同）抛出 `CommandProjectionError`，replay 拒绝。
- `decideCommandIdempotency` 纯决策：无记录 `{ kind: 'new' }`；同 ID 同 digest `{ kind: 'replay', fact }` 返回原 `Fact` 引用；同 ID 不同 digest `{ kind: 'conflict', code: 'IDEMPOTENCY_CONFLICT' }`。测试验证 projection 在决策前后完全不变，replay/conflict 不携带 append、reservation 或新 fact。
- `command.ts` 只依赖 protocol 内的 digest/errors/fact/json/schema，不依赖 journal；index 追加导出 command surface，后续 journal 可直接消费投影与 replay Fact。

## 仍未验证

- command service、唯一 writer、journal 文件 append/fsync、torn tail、启动 replay、CAS 存在性、业务 state/budget guard、reducer、wake、runtime/DSH 与真实模型均未实现。
- C-11 及所有 conformance 场景保持 `unproven`；本任务只覆盖其纯协议子集。
