# S2-C2 任务卡：纯 normalized command 与 command journal 投影

- **状态**：已完成（纯 protocol command 计算/投影/幂等决策 + journal replay/fold 集成）；S2 继续，下一 reducer/admission。command service、journal FS append、runtime 未实现。

## Goal

在 `@singularity/protocol` 中实现获批的 `NormalizedCommand` strict schema、`command` domain digest、从已封存 `Fact[]` 重建的内存 command 投影，以及无副作用的 command 幂等决策；同时集成纯 journal JCS NDJSON replay/fold（torn tail、seq/prev 链、重复 commandId 拒绝）。command 模块不依赖 journal 模块；journal 可直接消费投影与 replay 结果。

## Spec refs

- 获批 amendment：`docs/amendments/001-s2-protocol-closure.md` K1–K5（command identity、幂等、一 command 一 fact）。
- `docs/framework.md` §10.1（NormalizedCommand、commandId/commandDigest、幂等三分支）、§10.3（journal replay 边界）、§14.1（`IDEMPOTENCY_CONFLICT`）。
- `docs/build-plan.md` S2 工作项与 Done when。
- `docs/conformance.md` C-11；本任务只提供纯协议证据，状态保持 `unproven`。

## 允许修改范围

- `packages/singularity/protocol/src/command.ts`（新增）
- `packages/singularity/protocol/src/journal.ts`（cherry-pick 集成纯 replay/fold）
- `packages/singularity/protocol/src/index.ts`（追加 command/journal 导出）
- `packages/singularity/protocol/test/{command,journal,command-journal}.test.ts`
- 本任务卡

不修改 `docs/framework.md`、`spec-lock.json`、`docs/conformance.md`、`docs/build-plan.md`、既有 fact/schema/digest 实现或 app。

## 非目标

- 不实现 FS 字节级 torn UTF-8 处理、append/fsync、journal 文件写路径、启动 replay 服务、CAS 写入/读取、command service、唯一 writer、原结果业务映射、业务 guard/reducer、wake、runtime、DSH 或真实模型；纯 journal 字符串 replay/fold 由 cherry-pick 集成，不重新设计 framing 或持久格式。
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
- 集成 journal 纯 replay/fold：index 同时导出 command 与 journal；集成测试使用真实 `replayJournal(source)` + `foldFacts(facts, projectCommandFacts)` 覆盖 genesis/replay/conflict，并保持 builder 注入、无循环依赖。

## 检查命令

```bash
pnpm install --frozen-lockfile
pnpm --filter @singularity/protocol test
pnpm verify
git diff --check
```

## 失败证据与运行记录

环境：官方 Node `24.9.0`、pnpm `11.18.0`；父代理集成后运行。

### 红证据

先写 command 与 journal 测试，实现/集成交付前：

- `src/command.ts`、`src/journal.ts` 缺失；相关测试报 `ERR_MODULE_NOT_FOUND`。
- 失败原因是模块不存在，不是断言放宽。

### 绿证据

```bash
pnpm install --frozen-lockfile
pnpm --filter @singularity/protocol test
pnpm verify
git diff --check
```

结果：frozen install 通过；protocol tests `138/138`、app tests `6/6`（合计 `144`）；根 `pnpm verify` 的 project、typecheck、lint、test、build 全部通过；`git diff --check` 通过。首次实现后曾有一个测试失败，原因是测试误把空 `commandId` 当作非法；规范只要求 `string`，因此修正测试断言而未给 schema 增加规范外约束。

## 覆盖摘要

- `normalizedCommandSchema` 严格接受 `v`、`commandId`、`tool`、`toolVersion`、`actor`、`scope`、`input` 七个字段；根、actor、scope 的未知字段均拒绝；类型由 schema 推导。
- `computeCommandDigest` 先重新校验 strict shape，再使用 `command` domain；与 `object` domain 区分，同输入稳定，不同 commandId/tool/actor/scope/input 产生不同 digest。
- host-resolved state/contract/method/planning sketch/batch/feedback/budget/asOf/at/cursor 不是 `NormalizedCommand` 字段；带这些字段的输入在 schema 与 `computeCommandDigest` 两层均被拒绝，无法进入 digest。
- `projectCommandFacts` 从 `Fact[]` 建立 `commandId -> { commandDigest, seq, factDigest, fact }`；同一 commandId 的第二条 fact（无论 digest 是否相同）抛出 `CommandProjectionError`，replay 拒绝。
- `decideCommandIdempotency` 纯决策：无记录 `{ kind: 'new' }`；同 ID 同 digest `{ kind: 'replay', fact }` 返回原 `Fact` 引用；同 ID 不同 digest `{ kind: 'conflict', code: 'IDEMPOTENCY_CONFLICT' }`。测试验证 projection 在决策前后完全不变，replay/conflict 不携带 append、reservation 或新 fact。
- `replayJournal`/`decodeJournalFactLine` 读取 JCS NDJSON/LF：拒绝 BOM、CR、空行、前后空白、非 canonical JSON、无效 fact 与 digest mismatch；最后一段无 LF 的 torn tail 被丢弃，即使它是完整 canonical JSON。
- `verifyFactChain`/`foldFacts` 校验 seq 从 0 开始、连续、prev 链、fact digest 与每 commandId 至多一条 fact；`foldFacts` 在校验链后通过 `CommandProjectionBuilder` 注入 `projectCommandFacts`，不持久化第二 ledger。
- `command.ts` 只依赖 protocol 内的 digest/errors/fact/json/schema，不依赖 journal；`index.ts` 同时导出 command 与 journal，无循环依赖。
- `test/command-journal.test.ts` 用真实 `replayJournal(source)` + `foldFacts(replay.facts, projectCommandFacts)` 覆盖 genesis、idempotent replay、`IDEMPOTENCY_CONFLICT`、`new` 与重复 commandId 拒绝。

## 仍未验证

- FS 字节级 torn UTF-8 截断、append/fsync、文件级启动 replay、CAS 存在性、command service、唯一 writer、原结果业务映射、业务 state/budget guard、reducer、wake、runtime/DSH 与真实模型均未实现或未验证。
- C-11 整体仍为 `unproven`：已有纯字符串 journal replay/fold 与 command idempotency 证据，但没有 FS append/fsync、字节级恢复、启动接线或 runtime 证据；所有 conformance 场景保持 `unproven`。

结论：S2-C2 完成；S2 继续，下一 reducer/admission。
