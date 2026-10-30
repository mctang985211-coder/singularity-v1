# S3-B2 任务卡：单 Run 执行闭环 app 集成

- **状态**：已完成；S3 继续，下一 fresh retry/resume composition mismatch。

## Goal

在独立 app worktree 中，用真实 DSH profile 驱动共享 runtime `executeSingleRun`，形成 S3-B 单 Run 执行闭环的端到端证据：root admit → `run/opened` → DSH create/setup → 稳定 wake → 一次 `whenIdle` → submit 后独立 verifier 只读 CAS 验收，或无提交/invalid verifier 的结算；断言 fact 顺序、receipt/manifest 身份与 digest、usage/sessionCut、wake 去重、验证器不读活动 workspace。

## Spec refs

- `docs/framework.md` §4.0、§4.3、§9、§10.2–§10.3、§11、§12、§14、§15.2–§15.3、§19.1。
- `docs/amendments/002-acceptance-and-submission.md` A0–A9。
- `docs/build-plan.md` S3、S3-B。
- `docs/conformance.md` C-02、C-03、C-11、C-12。

## 允许修改范围

- `apps/singularity/test/single-run.test.ts`
- 本任务卡
- app 集成所需的 `apps/singularity/package.json`、`apps/singularity/tsconfig.json` reference（仅为导入共享 `@singularity/runtime` 与 `@singularity/protocol`）
- 若联调需要，允许 cherry-pick runtime 分支的共享 `executeSingleRun` 实现；不得在本分支修改 runtime 生产文件或现有 S1 测试。

## 非目标

- 不实现第二 writer、第二模型 loop、tool/skill registry、transcript mirror、TS MCP 转接层或 DSH patch。
- 不实现 runtime 的 CAS/journal/Agent/verifier；复用共享 `executeSingleRun`。
- 不实现 child 分解、replacement、feedback 或 RSI；verified 场景已用真实模型跑通，其余 4 个 fixture 场景只证明 DSH 组合路径。
- 不在本实现切片修改 `docs/framework.md` 或 `spec-lock.json`；证据收尾只将 C-02 标为 `proven`，C-03/C-11/C-12 保持 `unproven`。

## Done when

- 先有失败测试：在 runtime 分支尚未提供 `executeSingleRun` 前，app 测试因缺失共享 API 失败，并记录实际错误。
- verified 场景：fixture 模型依次 `singularity_read(kind=self)` → `singularity_plan` → bash 写声明产物 → `singularity_submit`；外部 verifier 只通过 `readObject(ref, domain)` 读取冻结输入/输出，断言 provider/operationId/contract/input/output digest 与 required criteria；`run/closed` 为 verified，`task/closed` 为 verified。
- no-submission 场景：普通文本 turn/end 产生 failed `ExecutionRecord`，没有 `SubmissionManifest`/`PublicReceipt`/Evidence。
- invalid verifier 场景：invalid criterion 或 `timedOut=true` 产生 invalid `ExecutionRecord`，不是 Evidence；invalid receipt 不进入公开结果。
- 断言事实顺序：verified 为 `task/admitted` → `run/opened` → `run/submitted` → `run/closed` → `task/closed`；no-submission 为 `task/admitted` → `run/opened` → `run/closed` → `task/closed`。
- 断言稳定 wake 不重复：一次 Run 只有一个 turn/start，fixture 请求数等于脚本步骤数。
- 断言 manifest/receipt/usage/sessionCut：manifest 通过 `validateSubmissionManifest`，receipt 通过 `validatePublicReceipt`；Evidence.usage 与 `run/closed.usage` canonical-equal；sessionCut 指向 Run session。
- 断言 verifier 不读活动 workspace：verifier 调用前/中修改 workspace 文件，CAS 读取仍返回冻结 bytes；verifier 只使用 `readObject`。
- symlink 负例：若共享 API 的 submit 冻结检查覆盖 symlink，断言含 symlink 的声明输出被拒绝，不产生 manifest/`run/submitted`/receipt，Run 按 no-submission 结算 failed。
- 根 `pnpm verify` 通过；若 runtime 分支未就绪，明确报告父集成缺口与已形成的失败证据，不宣称 S3-B 完成。

## 检查命令

```bash
HOME=/tmp/s3b2-home PNPM_HOME=/tmp/s3b2-pnpm \
  PATH=/tmp/node249/bin:/home/ROXY/code/bb_work/env/BB/buckyball/result/bin:$PATH \
  pnpm verify
git diff --check
```

## 失败证据与运行记录

### 环境与基线

- Worktree：`/home/ROXY/code/singularity-v1-swarm-integration`
- 分支：`s3-b2-swarm-integration`，基线 `315ece9`（`s3-b1-acceptance-schema` HEAD）
- Node：`/tmp/node249/bin/node` = `v24.9.0`；pnpm：buckyball PATH = `11.18.0`
- 独立 `HOME=/tmp/s3b2-home`、pnpm store `/tmp/s3b2-pnpm-store`，DSH home/store 与父 checkout 分离
- 为导入共享 API，app 增加 `@singularity/protocol`、`@singularity/runtime` workspace 依赖与 tsconfig references；`pnpm-lock.yaml` 同步更新
- runtime 分支就绪后 cherry-pick `s3-b2-swarm-runtime` 的 `2a970db`（本分支提交 `c748bb8`），未在本分支另写 runtime 生产实现

### 先失败测试（runtime 分支未就绪）

在 `packages/singularity/runtime` 仅含既有 store/service、尚无 `executeSingleRun` 时执行：

```bash
pnpm install --frozen-lockfile
pnpm build
cd apps/singularity
node --test test/single-run.test.ts
```

实际结果：

```text
SyntaxError: The requested module '@singularity/runtime' does not provide an export named 'executeSingleRun'
tests 1 / pass 0 / fail 1
```

同一切片 `tsc --noEmit` 实际结果：

```text
test/single-run.test.ts(38,23): error TS2305: Module '"@singularity/runtime"' has no exported member 'executeSingleRun'.
```

根 `pnpm verify` 在 app typecheck 阶段以同一 TS2305 失败；此前还捕获并修复了测试自身的 `EvidenceLike` 不是 JSONType 的类型错误。这些失败证明共享执行 API 尚不存在，而不是测试把未实现行为写成通过。

### 联调后的真实 DSH app 证据

cherry-pick runtime `2a970db` 后执行：

```bash
HOME=/tmp/s3b2-home PNPM_HOME=/tmp/s3b2-pnpm \
  PATH=/tmp/node249/bin:/home/ROXY/code/bb_work/env/BB/buckyball/result/bin:$PATH \
  pnpm verify
```

实际结果：`verify:project`、`tsc -b`、3 个 workspace typecheck/lint 全部通过；protocol `225/225`、app `11/11`（S1 既有 `6/6` + 本切片 `5/5`）、runtime `44/44`，合计 `280/280`；`git diff --check` 通过。

本切片 5 个场景均通过真实 `bootSpikeProfile`（DSH `0.2.2-alpha.2`）+ OpenAI-compatible chat fixture：

- **verified**：fixture 依次 `singularity_read(kind=self)` → `singularity_plan` → 原生 `bash` 写 `result.txt` → `singularity_submit`；4 个模型请求，断言首次请求已声明 `singularity_read`/`singularity_plan`/`singularity_submit`/`bash`，事实顺序 `task/admitted → run/opened → run/submitted → run/closed → task/closed`；`run/submitted.planningSketchRef` 解析回 `PlanningSketch` 且 task/run/sourceContract 匹配；manifest 通过 `validateSubmissionManifest`，receipt 通过 `validatePublicReceipt`；Evidence 通过 `validateEvidence` 且 `evidence.usage` 与 `run/closed.usage` 相等，`sessionCut.sessionId` 等于 Run session；verifier 请求无 workspace 字段，调用中改写活动 workspace 后仍只从 `readObject` 读到冻结 bytes。
- **no-submission**：普通文本 turn/end 只产生 1 个模型请求；无 manifest/receipt/Evidence，`run/closed` 为 failed 且引用 `ExecutionRecord(no-submission)`，Task 按 `maxRuns=1` 关闭 failed。
- **invalid criterion**：verifier 返回 invalid criterion；`run/closed.reason=verifier-invalid`，引用 invalid `ExecutionRecord`，不写 Evidence、不发布 receipt，Task 关闭 invalid。
- **verifier timeout**：`timedOut=true`；`run/closed.reason=verifier-timeout`，同样引用 invalid `ExecutionRecord` 而非 Evidence。
- **symlink**：bash 创建 symlink 后 submit 被 `OUTPUT_SYMLINK` 拒绝，未产生 `run/submitted`；随后普通文本结束，Run 按 no-submission 结算 failed，verifier 未运行。

### Live 模式（真实模型已验证 verified 场景）

- 父代理设置 `SINGULARITY_SPIKE_LIVE=1`、`SINGULARITY_SPIKE_BASE_URL=http://127.0.0.1:16660/v1`，API key 仅由进程环境提供后运行同一 app test；其余 4 个场景保持 scripted fixture，默认路径不变。
- 模型 `deepseek-v4.1-flash`、`reasoning=max`；live verified 场景通过，输出 Evidence digest `sha256:2cf1acd25b5f46ca5289bab9ccb238502b36d52bc195a7944b3c49bfcd059ec4`。
- 真实模型仍走同一 worker card/guard：必须 `singularity_read(kind=self)` → `singularity_plan`（task/run/sourceContract/contextEpoch 语义有效）→ 原生 bash 写 `result.txt` → `singularity_submit`。断言从 DSH 持久 session 事件按语义关联：恰好 1 个 `turn/start`、恰好 1 个 `${runId}:start` wake、工具名与参数顺序；不依赖固定文本、message id 或 tool call id。该断言同时跑在 fixture verified 路径，live 路径复用同一断言。
- required outputs、self-read/plan/submit guard、冻结 CAS、manifest/receipt/Evidence/usage/sessionCut 和 verifier 对 `result.txt` 精确 bytes 的断言均不放宽。`localGuidance` 只提示“用 bash/printf 写 exactly `frozen-output-before-verify`，无尾随换行”，不改变验收。
- API key 只经 `bootSpikeProfile` launch environment 传入；测试不打印 key，Run 结束后递归扫描临时 DSH home，断言 key 未落盘。

### 本次 live 支持后的局部验证

```bash
cd apps/singularity
node --test test/single-run.test.ts   # 5/5 pass
tsc --noEmit                          # pass
eslint test/single-run.test.ts        # pass
```

### 未覆盖项

- Live verified 已用真实模型跑通并输出上述 Evidence digest；fixture 其余 4 场景只证明协议、DSH composition、工具门禁与 CAS 结算路径。领域评测或 RSI 收益不属于本切片证据。
- runtime 自身的未覆盖项保持有效：in-flight resume/恢复、fresh retry、step/token/deadline 硬取消、agent/verifier 宿主 timeout、preview/read receipt、S4 child/replacement/feedback/ancestor、skills/MCP/exploration mount。
- C-02 已由真实 DSH + 真实模型证据标为 `proven`；C-03/C-11/C-12 保持 `unproven`：C-03 尚无 fresh retry，C-11 尚无完整 replay/CAS domain-aware 证据，C-12 尚无 composition mismatch 实跑。
- 不改 `docs/framework.md` 或 `spec-lock.json`；不宣称 S3 整体完成。
