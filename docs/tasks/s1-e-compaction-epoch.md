# S1-E 任务卡：DSH alpha2 compaction 与 context epoch receipt

- **状态**：已完成；只提供 test-local helper 与真实 DSH profile 宿主证据，S1 其余能力仍未验证。

## Goal

在真实 DSH `0.2.2-alpha.2` profile 中验证：持久 self-read/preview tool result 的 receipt 必须同时匹配当前 context epoch 与当前 surface membership；raw session log 仍保留源事件并不足以让 receipt 继续有效。通过 dispose/resume 与真实 `ctx.compaction.compactNow()` 分别证明 epoch 失效和 surface 失效，并确认 `inbox.clear()` 只取消 pending，不改变 epoch 或 surface。

## Spec refs

- `docs/framework.md` §12.1：compaction/resume 后开启新的 contextEpoch，重新要求 self read；child preview 必须处于当前可见 epoch，不能使用被压缩掉的旧摘要。
- `docs/framework.md` §12.3、§14.2：preview result 与 receipt 的持久交付、当前 epoch 和后续 commit 检查。
- `docs/framework.md` §14.3：DSH compaction/pruning 由宿主实现；runtime 只记录新 epoch 并重建阅读义务；无法识别 epoch 时拒绝复用旧 receipt。
- `docs/framework.md` §19.1：resume 从持久 message/inbox/turn 边界重建；compaction/clear 若丢失必要 receipt 不得伪装成同一上下文。
- `docs/build-plan.md` S1：alpha2 集成证据中的 compaction epoch 与取消清理。

本片段不把 C-12、C-16、C-20 整体标为 proven，也不修改 `docs/conformance.md`。

## 允许修改范围

- `docs/tasks/s1-e-compaction-epoch.md`
- `apps/singularity/test/helpers/context-epoch.ts`
- `apps/singularity/test/compaction-epoch.test.ts`
- 确有必要时新增独立 fixture 文件；本片段复用现有 `test/fixtures/chat-completions.ts`，未新增 fixture，也未修改其他现有文件。

## 非目标

- 不实现 production runtime 的 epoch 服务、receipt 存储、compaction 策略或第二 writer/journal/transcript/model loop/registry。
- 不实现或声称自动 pressure compaction、tool-result pruning、context-overflow recovery。
- 不把 fixture summarizer 结果表述为真实模型证据。
- 不修改 DSH、`docs/framework.md`、`docs/build-plan.md`、`README.md`、`docs/conformance.md`、`spec-lock.json` 或根门禁；不需要 amendment。
- 不把 `request/header` 事件数量当作模型请求数；请求数只读取 chat fixture 实际收到的 HTTP 请求。

## Test-local 设计

### contextEpoch

`deriveContextEpoch(session)` 只使用：

1. `session.id`；
2. raw log 中的 `session/end-seed` 事件（resume 边界）；
3. raw log 中匹配到 `compaction/start` 且没有 `error` 的 `compaction/end`（成功 compaction 边界）。

其他 turn、step、user/assistant/tool、inbox splice、`compaction/summary` 或失败的 `compaction/end` 都不改变 epoch。epoch 是这些输入的确定性 SHA-256 标识。

### receipt

`issueContextEpochReceipt(session, sourceEventSeq)` 只在源事件存在且当前在 `session.surface.nodes` 中时签发：

```ts
{ sourceEventSeq, sessionId, epoch, digest }
```

`digest` 是 test-local 事件内容摘要。`evaluateContextEpochReceipt(session, receipt)` 同时检查 session identity、epoch、event digest 和当前 surface membership；`current` 只在四项全部成立时为 true。raw log 里仍能用 `snapshotEvents()` 找到源事件，但源事件已被 compaction replacement shadow 时，`eventExists`/`digestMatches` 可以为 true，而 `surfaceMember` 与 `current` 必须为 false。

## Done when

- 用真实 DSH Agent 与 chat fixture 产生两个持久 tool result（self-read/preview），receipt 在 dispose 前为 current。
- dispose/resume 后两个旧 tool result 仍可 surface 可见、raw log 仍存在，但 epoch 改变，两个 receipt 都 stale。
- 真实 `ctx.compaction.compactNow()` 成功返回；fixture 实际多收到恰好一次 summarizer 模型请求；持久事件包含一对 `compaction/start`、`compaction/summary`、`compaction/end`，且无 error。
- `shadowedSeqs` 包含两个 receipt 的源事件；surface 与 `deriveMessages()` 不再含旧 tool result 正文；两个 receipt 同时因 epoch 与 surface membership 失效。
- `inbox.clear()` 清空 pending next-turn/next-step，不增加模型请求，不改变 epoch 或 surface。
- `pnpm verify`（project、typecheck、lint、test、build）通过；本任务卡记录实际红/绿命令与输出摘要。
- 未验证项明确保留，不宣称自动 compaction/prune 或真实模型证据。

## 检查命令

使用官方 Node `24.9.0`、pnpm `11.18.0`，独立 worktree、HOME 与 pnpm store：

```bash
PATH=/tmp/node249/bin:$PATH HOME=$PWD/.tmp/home pnpm install --frozen-lockfile --store-dir=$PWD/.tmp/pnpm-store
PATH=/tmp/node249/bin:$PATH HOME=$PWD/.tmp/home pnpm --filter @singularity/app test
PATH=/tmp/node249/bin:$PATH HOME=$PWD/.tmp/home pnpm verify
git diff --check
```

## 失败证据与运行记录

### 基线（实现前）

```text
pnpm verify
```

结果：project、typecheck、lint、test、build 全部通过；既有根测试 `3/3`。

### 初始红证据（实现前）

测试先于 helper 写入，只运行新测试：

```bash
cd apps/singularity
PATH=/tmp/node249/bin:$PATH HOME=<worktree>/.tmp/home node --test test/compaction-epoch.test.ts
```

结果：失败（exit 1），Node `ERR_MODULE_NOT_FOUND`，缺少 `test/helpers/context-epoch.ts`；测试本身未执行到 DSH 组合。红证据确认新测试依赖尚不存在的 test-local helper，而不是先写实现再补断言。

### 实现后绿证据

独立 worktree `/home/ROXY/code/singularity-v1-swarm-compaction`、分支 `s1-e-swarm-compaction`、独立 HOME 与 pnpm store；Node `24.9.0`、pnpm `11.18.0`。

单测试：

```bash
cd apps/singularity
PATH=/tmp/node249/bin:$PATH HOME=<worktree>/.tmp/home node --test test/compaction-epoch.test.ts
```

结果：`1/1` 通过（约 0.55 s）。实际观察：

- 初次 turn 产生 2 次 fixture 模型请求；self-read 与 preview 的 `tool/result` 均从真实 DSH Agent session 持久读出；原 receipt 的 `current=true`。
- dispose/resume 不增加 fixture 请求；两个旧 `tool/result` 仍存在 raw log 且仍在 surface，`session/end-seed` 使 epoch 改变，两个 receipt 均为 `epochMatches=false, surfaceMember=true, current=false`。
- `inbox.clear()` 清除 next-turn/next-step 各 1 条 pending，产生 2 条 `agent/inbox/spliced` cancelled 记录；没有打开新 turn、没有把 pending 正文写成 `user/message`，fixture 请求数、epoch、surface 均不变。
- 真实 `ctx.compaction.compactNow()` 返回成功；fixture 实际请求数恰好增加 1，summarizer 请求回放了两个旧 tool result 正文并包含 compaction instruction。
- session log 恰好出现各 1 条同一 `compactionId` 的 `compaction/start`、`compaction/summary`、无 `error` 的 `compaction/end`；`shadowedSeqs` 同时包含 self-read 与 preview 的源 seq。
- compaction 后两个源事件仍在 raw log，但不在当前 surface；`deriveMessages()` 不再包含两个旧正文 marker；两个 receipt 均为 `epochMatches=false, surfaceMember=false, current=false`（双失效）。

类型与 lint：

```bash
PATH=/tmp/node249/bin:$PATH HOME=<worktree>/.tmp/home pnpm --filter @singularity/app typecheck
PATH=/tmp/node249/bin:$PATH HOME=<worktree>/.tmp/home pnpm --filter @singularity/app lint
```

结果：均通过。

根门禁：

```bash
PATH=/tmp/node249/bin:$PATH HOME=<worktree>/.tmp/home pnpm verify
git diff --check
```

结果：`pnpm verify` 的 project、typecheck、lint、test、build 全部通过；根测试 `4/4`（既有 3 个 + 本切片 1 个）。`git diff --check` 无输出、exit 0。

### 范围核对

只新增本任务卡、`apps/singularity/test/helpers/context-epoch.ts` 与 `apps/singularity/test/compaction-epoch.test.ts`；未修改现有测试、fixture、app 源码、profile、规范、build-plan、README、conformance、spec-lock 或 lockfile，未新增 fixture 文件。父 checkout 未修改。

### 仍未验证

- 自动 pressure compaction、context-overflow recovery、tool-result pruning 未触发，也不属于本片段证据。
- 失败/取消的 compaction（`compaction/end` 带 error 或缺失 end）对 epoch 的影响未通过真实 DSH 路径验证；helper 按“成功 end 才改变 epoch”实现并只由成功路径覆盖。
- self-read/preview 只是 test-local tool result 与 receipt helper，不是 production runtime 的阅读义务实现。
- 真实模型请求、真实领域任务与 conformance C-12/C-16/C-20 整体保持未验证。
