# S3-A 任务卡：单 writer journal 与 CAS

## Goal

建立 `packages/singularity/runtime` 的真实文件存储：一个 domain journal、一个 command writer、一个 CAS。验证原子 CAS 写入、fact append/fsync、串行 command 幂等、torn-tail 恢复和 replay，不实现第二写入路径或存储层业务 guard。

## Spec refs

- `docs/framework.md` §10、§11、§19.1 及获批 amendment K1–K3
- `docs/build-plan.md` S3

## 允许修改范围

- 新 runtime package 的存储、command service、package tests 与必要构建配置
- 根 tsconfig references、lockfile、验证文档

## 非目标

- 不实现 Agent loop、workspace/verifier、业务 reducer 第二份、第二 writer/fold/wake/registry/transcript。
- 不用内存 boolean 代替持久幂等，不用跳过损坏行或破坏性清理制造恢复成功。
- 不宣称 C-02/C-03/C-12 或真实模型场景已验证。

## Done when

- CAS 先临时写入、校验 object digest、原子 rename、fsync；引用前可重读验证。
- 一个 project process 内 command writer 串行分配 seq/prev/digest，fact append+fsync 后才返回成功。
- 同一 process 内同一规范化绝对 root 只允许一个未关闭 `CommandService`；close 后允许重新 open，重启幂等仍成立。
- 同 commandId+commandDigest 返回原 fact 且不追加；不同 digest 返回 IDEMPOTENCY_CONFLICT；重启后仍成立。
- 仅 EOF 未终止 tail 可截去，中间损坏拒绝启动；replay 与 protocol fold 一致。
- 根 `pnpm verify` 全通过，真实文件证据与未验证项明确记录。

## 检查命令

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

## 失败证据与运行记录

环境：官方 Node `24.9.0`、pnpm `11.18.0`；独立 worktree、HOME 与 pnpm store。联调审查后根 `pnpm verify` 顺序改为 `verify:project → build → typecheck → lint → test`，先由 `tsc -b` references 生成 protocol/runtime/app 产物。

### 红证据

- 首版实现前：runtime tests 因 `../src/index.ts` 不提供 `CommandService` 导出而失败，非断言放宽。
- 联调审查：删除 `packages/singularity/protocol/dist` 后运行 `pnpm --filter @singularity/runtime typecheck`，runtime `src` 与 tests 均报 `TS2307: Cannot find module '@singularity/protocol'`；旧 verify 顺序在 build 前执行 typecheck，干净 checkout 无法通过。
- 联调审查：新增“同一 root 只允许一个 live writer”测试后、实现前，第二实例 open 成功，测试报 `Missing expected rejection`。

### 绿证据

```bash
rm -rf packages/singularity/protocol/dist
pnpm verify
git diff --check
```

结果：clean-checkout 路径下根 `pnpm verify` 的 project、build、typecheck、lint、test 全部通过；protocol tests `178/178`、app tests `6/6`、runtime tests `9/9`（合计 `193`），`git diff --check` 通过。runtime 测试覆盖 CAS 原子写入与 digest 校验、append seq/prev/commandId 严格检查、EOF torn tail（含完整 JSON 与 split UTF-8）、中间损坏拒绝、CommandService 重启幂等/冲突/并发串行、对象先于 fact，以及同 root 第二 writer 拒绝与 close 后重新 open。

联调说明：外部 `s3-a-swarm-store-tests` worktree 的 restart 用例在重新 open 前未关闭第一个 service，按新单 writer 语义会得到 `WRITER_ALREADY_OPEN`；只在该用例副本中补 `await firstService.close()` 后，11 个验收测试全部通过。该外部 worktree 未被修改。

### 覆盖摘要

- `DomainStore`：raw-byte CAS 临时文件 + fsync + 重读 digest + 原子 rename + 目录 fsync；`readObject` 校验 ref digest；JCS NDJSON journal 逐行 append+fsync。
- Journal 恢复：仅截 EOF 未终止 tail；中间 CR、坏 JSON、坏 UTF-8、seq/prev/digest/commandId 链错误拒绝启动，不截断。
- `CommandService`：启动 replay 建立 command projection；Promise 队列串行；同 commandId+digest 返回原 Fact 且不追加、不写对象；异 digest `IDEMPOTENCY_CONFLICT`；对象先写、fact 后 append。
- 进程内 writer ownership：`CommandService.open` 先 `resolve` 绝对路径并 `realpath` 规范化，再占用 root；同一 root 已有未关闭 writer 时返回 `WRITER_ALREADY_OPEN`；成功 `close` 后释放，允许重新 open。该 Set 只表示 writer ownership，不是业务状态、投影或第二事实账本。

### 仍未验证

- CAS 引用内容的 domain-aware replay 校验仍未实现：replay 只验证 journal 链与 fact digest，不按字段 domain 检查 fact 引用的 CAS 对象是否存在/损坏；留待后续 runtime/reducer 接线。
- 无跨进程 OS 文件锁；writer ownership 只在同一 Node 进程内生效。
- 无掉电/强杀故障注入；未实现业务 reducer/state guard、Agent/DSH、workspace、verifier、Evidence、usage、wake。
- C-02/C-03/C-12 与 conformance 状态仍为 unproven，未宣称完成。
