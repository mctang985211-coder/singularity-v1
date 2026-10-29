# S1-D 任务卡：DSH alpha2 稳定 wake 去重

- **状态**：已完成；仅覆盖 test-local wake delivery 垂直切片，S1 整体继续。

## Goal

在真实 DSH `0.2.2-alpha.2` session 日志上实现 test-local `deliverWakeOnceOrFail`：每次 wake 使用稳定 `MessageId`，发送前只从 raw session 事件判断该 wake 是 never-inserted、pending、admitted、removed 还是冲突；只有从未出现且持久状态明确的 wake 可首次发送，admitted 绝不重发，removed/pending/unknown/corrupt 一律 fail closed，不新增持久账本、协议字段或第二 wake authority。

## Spec refs

- `docs/framework.md` §2、§3、§11.2、§19.1
- `docs/build-plan.md` S1（尤其“恢复不重复购买请求”与稳定 wake/message ID 去重）
- 本片段不改变任何 conformance 场景状态。

## 允许修改范围

- `docs/tasks/s1-d-wake-delivery.md`
- `apps/singularity/test/helpers/wake-delivery.ts`
- `apps/singularity/test/wake-delivery.test.ts`
- `apps/singularity/test/fixtures/wake-crash-child.ts`

不修改 `docs/framework.md`、`docs/build-plan.md`、`README.md`、`docs/conformance.md`、`spec-lock.json`、既有 src/test/fixture、manifest、lockfile 或 CI。

## 非目标

- 不实现生产 runtime 的 wake authority；helper 只存在于 app test。
- 不增加持久去重表、journal、transcript、第二模型 loop、DSH patch 或兼容层。
- 不把 `request/header`、`agent/inbox/*` 事件数量当作模型请求数；外部 chat fixture 的实际 HTTP 请求才是购买证据。
- 不承诺 provider 网络请求 exactly-once。
- 不实现 pending/removed wake 的成功恢复语义；本切片的 fail closed 不新增协议语义，不需要 amendment；若未来要求恢复，再另行定义。
- 不验证 compaction/context epoch 失效；只保证已有 raw admission 证据不被重发。

## 状态判定（raw session 事件）

| 判定 | 证据 | 动作 |
|---|---|---|
| never-inserted | 日志中没有该 `MessageId` 的 inbox/消息事件 | 发送一次 stable-ID wake |
| removed | 该 ID 出现在 `agent/inbox/spliced.inserted`，当前 fold 后不在 pending，且从未 admission | fail closed；不推断恢复语义，0 请求 |
| pending | fold `agent/inbox/spliced` 后该 ID 仍在 next-turn/next-step | fail closed，0 请求 |
| admitted | raw `user/message` 带该 ID | 绝不重发，返回 already-admitted |
| conflict/corrupt/unknown | 重复 admission、admitted 同时 pending、重复 pending、ID 被其他 role 使用、非法 splice、内容不一致、无法识别的 inbox 变更 | fail closed，0 请求 |

`session/end-seed` 只标记 resume 边界；compaction/start/summary/end 与 checkpoint replacement 只说明 surface epoch 变化，不能抹掉 raw `user/message` admission 证据。只有 `surfaceOp: 'append'` 的 `user/message` 才算 admission；同 ID 出现在 replacement 中按冲突处理。helper 不依赖 `agent.inbox` 的内存状态，也不靠进程内 boolean 去重。只有 never-inserted 可以首次发送；removed/pending/unknown/corrupt 全部 fail closed，不定义恢复语义，因此不需要 amendment。

## Done when

- `deliverWakeOnceOrFail` 使用 `freezeMessage` + `MessageId(wakeId)` 构造冻结 user message，并在 raw log 上分类。
- 真实 DSH profile + 外部 chat fixture：首次 deliver 产生 1 个 HTTP 请求；完成后再次 deliver 同 ID 不新增请求/turn。
- dispose + resume 同一 session 后再次 deliver 同 ID 仍不新增请求/turn。
- raw DSH `agent.followup` 使用同一 ID 的对照真实产生第 2 个请求和第 2 个 turn，证明没有宿主 guard 会重复购买。
- pending 重复（同一 ID 再次入队）被 DSH 拒绝；helper 对 pending 状态 fail closed 且外部请求数不变。
- 对 pending 消息执行 durable `inbox.remove`（或等价的 durable clear）后，helper 返回 removed fail closed；外部 fixture 请求数、raw admission 与 turn 均不增加，不使用 remove+send 恢复 pending。
- 独立子进程在外部 fixture 收到永不响应的请求后被测试 SIGKILL；父进程 resume 同一 session 后 turn 为 interrupted、无 assistant settlement/usage unknown；deliver 同 ID 不重发，外部请求仍为 1。
- 子进程留下 pending wake 并 kill 后，父进程 resume 同一 session；该 pending session 自身无请求，helper 对 pending 恢复 fail closed，父进程 resume 不新增 fixture 请求。
- 根 `pnpm verify` 通过；根 test 由 3/3 增至 5/5，无 profile listener 泄漏。

## 检查命令

使用官方 Node `24.9.0`、pnpm `11.18.0`，独立 worktree/HOME/store：

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

## 失败证据与运行记录

### 初始红证据

helper 仅保留抛错桩、crash child 尚未创建时，新增测试真实失败：

```text
✖ wake delivery reuses admitted wake across resume and raw followup proves the guard
  Error: S1-D wake delivery helper is not implemented
      at deliverWakeOnceOrFail (.../apps/singularity/test/helpers/wake-delivery.ts:53:25)
      at deliverAndSettle (.../apps/singularity/test/wake-delivery.test.ts:79:22)

✖ crash after provider receipt resumes interrupted without resending
  Error: pending wake persistence: child exited (code 1, signal null):
  Error: Cannot find module '.../apps/singularity/test/fixtures/wake-crash-child.ts'
```

### 集成环境与门禁

- Node：官方 `/tmp/node249/bin/node`，`v24.9.0`。
- pnpm：`11.18.0`。
- 独立 worktree：`/home/ROXY/code/singularity-v1-swarm-wake`。
- 独立 HOME：`/home/ROXY/code/singularity-v1-swarm-wake-home`。
- 独立 pnpm store：`/home/ROXY/code/singularity-v1-swarm-wake-store`。

### 真实组合证据

使用官方 Node `24.9.0`、真实 DSH `0.2.2-alpha.2` profile 与外部 chat fixture；所有请求数断言都来自 fixture 实际收到的 HTTP 请求，`request/header` 只作日志一致性检查。

- **首次与重复 deliver**：guarded session 首次 `deliverWakeOnceOrFail` 返回 `sent`，fixture 请求 1、`turn/start` 1、`turn/end.completed` 1、同 ID `user/message` 1。再次 deliver 同 ID 返回 `already-admitted`；fixture 仍为 1，`turn/start` 仍为 1。
- **dispose + resume**：flush 后 dispose，再 `agents.resume` 同一 session；resume 只追加 `session/end-seed`，fixture 请求仍为 1。再次 deliver 同 ID 返回 `already-admitted`，fixture 仍为 1，`turn/start` 仍为 1。
- **raw DSH 对照**：control session 首次 deliver 后 fixture 请求 2；直接 `agent.followup` 同一冻结 ID 后 fixture 请求 3、`turn/start` 2，日志出现两条同 ID `user/message`。这证明 DSH 只检查 pending 唯一性，已 admission 的同一 ID 会再次购买；helper 随后对该冲突返回 `corrupt`，fixture 仍为 3，raw log 长度不变。
- **pending 重复**：同一冻结 ID 先 `inject`，再 `inject` 被 DSH 以 `already pending` 拒绝；helper 返回 `pending` fail closed，fixture 请求不变、raw log 长度不变、`turn/start` 0。
- **removed**：对该 pending 消息执行 durable `agent.inbox.remove` 后，helper 返回 `removed` fail closed；fixture 请求仍为 3，raw log 长度不变，`turn/start`、`request/header` 和同 ID `user/message` 均为 0。没有使用 remove+send 恢复 pending。
- **crash-after-provider-receipt**：独立子进程用同一 HOME 创建两个 session；session A `inject` pending wake 并 flush，session B deliver 后外部 fixture 收到 1 个永不响应的请求。父测试在 fixture 收到请求后 SIGKILL 子进程（exit signal `SIGKILL`）。
  - 父进程 resume A：无 `turn/start`、无 `request/header`、无同 ID `user/message`；raw `agent/inbox/spliced` 仍含 pending wake；resume 追加 `session/end-seed`；helper 返回 `pending` fail closed，fixture 请求仍为 1，raw log 长度不变。
  - 父进程 resume B：fixture 请求仍为 1；`turn/start` 1、`step/start` 1、`step/end` 1、`turn/end.interrupted` 1；`assistant/message` 0、`assistant/attempt` 0，usage 保持 unknown；`request/header` 1；同 ID `user/message` 1；resume 追加 `session/end-seed`。
  - 对 B 再次 deliver 同 ID 返回 `already-admitted`；fixture 请求仍为 1，`turn/start`/`turn/end`/`request/header` 均不变，raw log 长度不变。

### 实际命令结果

```text
pnpm install --frozen-lockfile
  -> frozen lockfile accepted; 701 packages installed into the isolated store

pnpm verify
  -> verify:project passed
  -> typecheck passed
  -> lint passed
  -> test: 5/5 passed (S1-A, S1-B, S1-C, S1-D x2)
  -> build passed

git diff --check
  -> no output
```

根 test 由 3/3 增至 5/5；本文件的两个 test 顺序执行，profile 均在 finally 中 dispose，crash child 在 finally 中 SIGKILL 并 await exit，无 listener 或子进程泄漏。

### 仍未验证

- provider 网络请求 exactly-once；本切片只证明宿主不会在 DSH 已有 admission/pending/removed 证据时重复发送。
- pending/removed wake 的成功恢复（重发或提升为 turn）；当前一律 fail closed，不定义恢复语义，也不需要 amendment；若未来要求恢复再另行定义。
- compaction/context epoch 变化后 receipt 失效和 C-12/C-16/C-20；本切片只证明 raw admission 不因 resume 边界被抹掉。
- 真实模型请求；外部 fixture 只替代 provider 传输，不构成模型能力或领域证据。
