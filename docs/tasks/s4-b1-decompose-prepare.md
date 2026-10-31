# S4-B1 — decompose prepare 的持久交付与 preview receipt

- **状态**：已完成（复核修复后；prepare-only，commit 留给 S4-B2）。
- **基线**：`origin/main=ccc451e`（含 S4-A1–A4），分支 `s4-b1-decompose-prepare`。
- **证据边界**：仓库/类型/unit + 真实 DSH profile + scripted chat fixture；不购买真实模型请求；C-04/C-05 不升级。

## Goal

在 A1–A4 的 pinned Method/template/guidance/skill/MCP 资源面上，交付完整的 `singularity_decompose(action='prepare', bindingId)` 行为：

- 在 `readSelf` 和当前 epoch 的 PlanningSketch 之后，返回完整 `TaskExample`、binding brief、公开接口、host 派生 join、method/template/parentRun 身份、当前 sketch/contextEpoch/剩余预算，以及从 A2–A4 冻结资源解析出的真实 skill/MCP 摘要。
- 写入两个严格分离的对象：**preview CAS 对象（preview domain）**与 **delivery receipt CAS（object domain）**。
- 后续 step 的 `singularity_read(kind='status')` 从持久 DSH 成功 `tool/result` 重建 previews，区分 `current` / `next-step-required` / `stale`。
- prepare 不写 fact、不创建 child/session/workspace、不预留预算、不 dispatch。
- 不注册 commit 分支；收到 `action='commit'` 以既有 `INVALID_ARGUMENT` 拒绝且无副作用。

## Spec refs

- §4.0：`PreviewRef` / `ackPreview` 使用 `preview` domain；`ObjectRef` 使用 `object` domain。
- §5、§5.1：template example 是完整业务用例；child preview 不展示孙模板/内部 workflow。
- §6.3：PlanningSketch 必须匹配 task/run/contextEpoch/sourceContract；directPlan 只引用可见 binding。
- §8.1：prepare 返回 previewRef、binding/template/method/parentRun、join、brief、完整 example、接口、resolved skill/tool 摘要、当前 sketch 和预算；prepare 不创建 Task/预算预留。
- §8.2 第 3 步：ack 必须等于已持久交付的 previewRef.digest，且必须在后续模型 step。
- §10.1：不新增 fact；command/fact 语义不变。
- §11.3：tool result 是持久交付面；恢复从对应 session tool-call/result 重新解析。
- §12.1–§12.2：NodeView childOptions/join 是模型可见投影；contextEpoch 随 resume/compaction 变化。
- §14.1–§14.3：strict tool input；prepare result ≤32 KiB；单个 child example ≤12 KiB。
- §19.1：prepare 后未 commit 时从原 tool result/contextEpoch 重读；无 Task 可撤销。
- `AGENTS.md` §3/§4.1/§5；A1–A4 任务卡。

## Allowed scope

- 新增 `packages/singularity/runtime/src/receipts.ts`：唯一 DSH `tool/call`/`tool/result`/surface/epoch 适配；不解析 preview 业务对象。
- 新增 `packages/singularity/runtime/src/decompose.ts`：preview/delivery receipt 的 runtime-private 类型、strict guard、builder、prepare、reader/classifier；不写 fact。
- `packages/singularity/runtime/src/resources.ts`：继续拥有 Method/template/guidance/skill/MCP 资源读取；增加 example loader 与 child template resource summary resolver。
- `packages/singularity/runtime/src/errors.ts`：增加 internal `DecomposeError`（既有 tool code 集合，不新增协议错误码）。
- `packages/singularity/runtime/src/tools.ts`：注册 prepare、扩展 status、传递 `DecomposeToolContext`；只做注册/guard，不堆 preview schema。
- 新增 `packages/singularity/runtime/src/node-view.ts`：live NodeView 与 admission 静态 8 KiB preflight 共用 ownTemplate/skills/tools/childOptions 投影；由 `run.ts`/recovery 消费。
- `packages/singularity/runtime/src/run.ts`：窄 wiring：controller 获得 `methodResources`/reader/decompose context；在 `run/opened`/fact/Agent 前调用静态 NodeView preflight；不实现 child batch/dispatch。
- `packages/singularity/runtime/src/prompt.ts`：当前 worker card 只描述实际 prepare/read/plan/submit/stop；保留完整规范 card 常量。
- `packages/singularity/runtime/src/index.ts`：仅在真实消费者需要时导出；优先保持内部。
- `apps/singularity/src/host-composition.ts`：如 worker card 文本变化，保持 app 全局 card 与 runtime scoped card 同源（当前两者都调用 `renderWorkerCard(false)`）。
- runtime/app tests、fixtures、任务卡、build-plan、AGENTS、README 与实际证据记录。
- 不修改 `docs/framework.md`、`spec-lock.json`、protocol 公开类型/schema/fact、MCP/skill parser、store/service/recovery。

## Non-goals

- 不实现/不注册 commit；不写 `task/children-admitted`；不创建 child Task/Run/session/workspace；不 dispatch；不实现 required/probe join、parent yield、batch wake、feedback、direct outputs。
- 不将 preview 当作授权 token；previewRef 只证明冻结用例已交付，不授予 child 创建/读取权限。
- 不修改 `run/submitted.previewReceipts`；B2 再决定把 delivery receipt 的 object refs 放入该数组。
- 不把 preview 写入 fact；不新增 writer/fold/registry/transcript；不新增第二 preview authority。
- 不购买真实模型请求；app 测试使用 scripted chat fixture。
- 不修改 A2–A4 的资源解析语义；child template 的资源摘要复用同一 `readSkills`/`readMcpServers`，不复制 CAS/MCP 解析。

## 当前消费者与不变量

- prepare consumer：`singularity_decompose(action='prepare', bindingId)`。
- read-side consumer：`singularity_read(kind='status')` 的 `previews`；与 B2 commit 共用同一 reader/classifier。
- 不变量：
  1. prepare 只写 preview CAS（preview domain）和 delivery receipt CAS（object domain）；`facts()` 与 Task/Run/batch 投影不变。
  2. 成功、append-origin、当前 surface、当前 epoch 的 `tool/result` 是唯一交付证据；仅有 receipt CAS 不算交付。
  3. 同一 Run/binding/template/example 重复 prepare 返回同一 `previewRef`；每次实际交付产生新的 receipt（toolCallId/step）。
  4. 旧 epoch、shadowed/replacement result、身份/digest 错误均不成为 current。
  5. `ackPreview` 使用 preview domain；`run/submitted.previewReceipts` 的 future object refs 使用 delivery receipt 的 object domain，二者不可互换。
  6. 无内存 `previewDelivered` 布尔；status/reader 每次从 session log + CAS 重建。
  7. child template 的 skills/tools 用于 preview 摘要；root contract 资源仍只用于当前层 Composition/NodeView。

## 两个 runtime-private 对象

### Preview CAS（preview domain）

```ts
interface DecomposePreviewBody {
  readonly v: 1
  readonly kind: 'decompose-preview'
  readonly parentTaskId: string
  readonly parentRunId: string
  readonly bindingId: string
  readonly templateId: string
  readonly method: Ref
  readonly join: 'required' | 'probe'
  readonly brief: string
  readonly exampleRef: Ref
  readonly example: TaskExample
  readonly interface: {
    readonly requiredCriteria: readonly TaskCriterion[]
    readonly requiredOutputs: readonly OutputSpec[]
    readonly acceptance: Ref
    readonly instanceSchema: JsonObject
  }
  readonly resolved: {
    readonly skills: readonly { readonly id: string; readonly name: string }[]
    readonly mcpServers: readonly {
      readonly id: string
      readonly serverName: string
      readonly transport: 'stdio' | 'streamable-http'
      readonly tools: readonly string[]
    }[]
  }
  readonly sourceContract: Digest
  readonly digest: Digest // preview domain
}
```

- 不包含 `contextEpoch`/`turn`/`step`/`toolCallId`/`asOf`/预算/当前 sketchRef；这些属于 delivery receipt 或 response 动态部分。
- CAS id：`decompose-preview:${parentRunId}:${bindingId}`；同内容同 digest。

### Delivery receipt（object domain）

```ts
interface DecomposePreviewDeliveryBody {
  readonly v: 1
  readonly kind: 'decompose-preview-delivery'
  readonly sessionId: string
  readonly parentTaskId: string
  readonly parentRunId: string
  readonly bindingId: string
  readonly method: Ref
  readonly templateId: string
  readonly join: 'required' | 'probe'
  readonly previewRef: Ref
  readonly sourceContract: Digest
  readonly contextEpoch: string
  readonly turn: number
  readonly step: number
  readonly toolCallId: string
  readonly digest: Digest // object domain
}
```

- CAS id：`decompose-delivery:${sessionId}:${toolCallId}`；无时钟/随机值。
- 仅 receipt 对象不构成交付；必须在当前 surface 找到对应成功 `tool/result`。

## Prepare tool

- 输入：`{ action: string, bindingId?: string }`；`action='prepare'` 才执行；`action='commit'` 直接 `INVALID_ARGUMENT`，无 CAS/fact/child 副作用；其他 action 同样拒绝。不带 `children` 分支、不注册 commit。
- guard：readSelf、当前 PlanningSketch、预算、未 submitted/stopped；binding 必须恰有一个可见 child binding。
- 读取 child template 的 `example`（object CAS、strict UTF-8/JSON、`taskExampleSchema`、12 KiB cap）；通过 `readTemplateResourceSummaries` 解析 child template 的 skills/tools（复用 A2–A4）。
- 返回字段：`status='preview'`、`previewRef`、`deliveryReceiptRef`、binding/parentRun/templateId/templateRef/methodRef、join、brief、example、interface、resolved、reminder、planningSketchRef、contextEpoch、asOf、remainingBudgetPct。
- 先在内存构造 preview/receipt/response；response canonical bytes >32 KiB 或 example >12 KiB 时不写任何 CAS、不截断。

## Receipt reader / classifier

`receipts.ts` 只提供：

- `readSessionToolView(session: Session): SessionToolView`：调用 alpha2 唯一可用的 `session.snapshotEvents()`（deprecated 例外）读取 committed events，并用 `session.seq` 校验长度、`session.surface.nodes` 取当前 surface、`deriveContextEpochFromEvents` 取 epoch；不新增第二 transcript/ledger。
- `findCurrentToolCall(view, callId)`：精确匹配；缺失/重复 fail closed。
- `ToolCallRecord`：`seq/turn/step/callId/name/arguments`。
- `ToolResultRecord`：`seq/turn/step/callId/isError/content/text/surfaceOp/sourceEventSeqs/surfaceVisible`。

`decompose.ts` 提供：

- `readPrepareDeliveries({contract, runId, resources, reader, session, currentCallId})`：配对 call/result，严格解析 result 的 example/interface/resolved，重读 frozen example/A2–A4 summaries，读 receipt/preview CAS，验证确定性 id/digest、身份、epoch、surface；返回每条 delivery 的 `state`。
- 内部 `isStrictlyEarlierToolStep(prepare, current)`：仅当 prepare 严格早于 current 时为 true；不导出，避免 B2 误用命名。
- 分类：无成功交付在 B2 commit/ack 中为 `PREVIEW_REQUIRED`（status 只显示无 current preview，不返回该 code）；存在但 epoch/surface/身份/digest 错 → `PREVIEW_STALE`；同 step → `NEXT_STEP_REQUIRED`；严格后续 step → `current`。
- status 按 binding 取最新 result，投影 `{bindingId, previewRef, deliveryReceiptRef, state}`；不暴露精确 step/token。

## Status / NodeView

- `singularity_read(kind='status')` 增加 `previews`，从持久 reader 重建；fresh controller 必须得到相同结果。
- NodeView `childOptions` 从 pinned template children 投影 `{bindingId, templateId, brief, join}`；`obligations.canDecompose` 与实际 prepare guard 一致。
- 静态 preflight 使用保守动态上界：`planningSketchRef` 使用实际预期 id `${runId}:planning-sketch` + 等长占位 digest、`phase='integrating'`、全 false obligations + 最长固定 denialCode、`tokensPct:null`、其余预算 100%；create/recovery/live 统一使用 `resolve(request.workspace)` 后的路径，`contextEpoch`/`lastAttempt` 使用已知值。`node-view.test.ts` 覆盖 near-cap 与相对 workspace；不预建 B2 child history。
- 当前 worker card 只描述 read/status/plan/decompose prepare/submit/stop；不指示 commit/feedback/child dispatch。app 全局 card 与 runtime scoped card 同源。
- 兼容边界：B1 改变了 scoped worker card；pre-B1 旧 card 创建的 open Run 在恢复时会因实际 scoped assembly 与冻结 `Composition.platformPrompt` 不同而按 `COMPOSITION_MISMATCH` fail closed。不增加 legacy card/兼容分支。

## Done when

- [x] prepare 返回完整 example/brief/interface/join/身份/sketch/epoch/预算和真实 skill/MCP 摘要；example 12 KiB、result 32 KiB 边界正确，超限不写 CAS、不截断。
- [x] 只写 preview（preview domain）与 delivery receipt（object domain）；无 fact/Task/Run/batch/预算/child/session/workspace 副作用。
- [x] 重复 prepare 同 Run/binding 内容返回同一 previewRef；每次实际交付新增 receipt；receipt 与 preview 互读域错误。
- [x] status 从 fresh reader 重建 previews；同 step、failed/non-append/shadowed result、旧 epoch、身份/digest 错误均不 current。
- [x] commit action 以 `INVALID_ARGUMENT` 拒绝且无副作用；未注册 commit 能力。
- [x] NodeView childOptions/canDecompose 与 prepare 一致；worker card/platformPrompt 同步。
- [x] 定向/包测试/根 `pnpm verify`/`git diff --check` 通过；C-04/C-05 不升级。
- [x] 记录事件/receipt refs、prompt/request bytes、fixture usage、行数、导出/依赖和未覆盖项。

## 必测负例

- 无 self read/plan；unknown/duplicate binding；join 由 host 派生、模型不能提供。
- example 缺失/非 UTF-8/非 strict JSON/未知字段/无效 example inputs/12 KiB 超限。
- prepare result >32 KiB；超限前不写 preview/receipt。
- previewRef 按 object 读取失败；receipt 按 preview 读取失败；delivery receipt 可作为 future object ref。
- prepare 前后 facts/Task/Run/budget/child session/workspace 数量不变。
- 重复 prepare 同 previewRef；不同 toolCallId 新 receipt；receipt 内容确定性。
- fresh controller/session log reader 重建；无内存状态。
- result 缺失/失败/重复；result 非 append surface / 被 shadow；旧 epoch；binding/run/method/template/preview/receipt 身份或 digest 错。
- 同 turn/step 为 `next-step-required`；严格后续 step 为 current；prepare 在当前 call 之后为 stale。
- commit action、未知 action、未知字段均 `INVALID_ARGUMENT`，无副作用。
- 真实 DSH：prepare → status → probe parent submit；无 `task/children-admitted`、无 child session；skill/MCP 摘要来自 pinned Method。
- NodeView 8 KiB、tool schemas 12 KiB、worker card 2 KiB、prepare result 32 KiB。

## 验证命令

```bash
export PATH=/home/ROXY/code/singularity/.tooling/node-v24.22.2-linux-x64/bin:$PATH
export DSH_HOME="$PWD/.tmp/s4b1-dsh"
export TMPDIR="$PWD/.tmp"

node --test packages/singularity/runtime/test/receipts.test.ts
node --test packages/singularity/runtime/test/decompose-prepare.test.ts
node --test --test-name-pattern='S4-B1' apps/singularity/test/run-recovery.test.ts
pnpm --filter @singularity/runtime build
pnpm --filter @singularity/runtime test
pnpm --filter @singularity/app test
pnpm verify
git diff --check
```

不设置 `SINGULARITY_SPIKE_LIVE`；fixture 不是真实模型。

## Structure done when

- `receipts.ts` 只做 DSH 事件适配；`decompose.ts` 只做 preview/receipt/prepare/classifier；`node-view.ts` 只做 live/static NodeView 投影与 admission preflight；`resources.ts` 继续拥有 Method/template/guidance/skill/MCP/example 读取；`tools.ts` 只注册/guard；`run.ts` 只窄 wiring。
- `run.ts` 起始 756 行；本片拆分 NodeView 后应低于起始值。`tools.ts` 起始 545 行，不堆 preview schema；`tools.ts`/`resources.ts` 超 20% 触发线时记录单一注册/资源入口理由。
- `loadMethodResources` 在 admission 前校验当前 template children bindingId 唯一、每个 child template 恰一存在；NodeView 静态目录在 `run/opened`/fact/Agent 前完整 8 KiB preflight。
- 不新增公开 protocol/fact/writer/fold/registry/transcript；无新依赖；package index 只在真实消费者出现时增加导出。
- A2–A4 资源解析保持单一入口；child template 摘要通过同一 `readSkills`/`readMcpServers`，不复制 MCP/skill parser。
- 登记 before/after 行数、导出/依赖变化、测试数量、fixture usage、prompt/request bytes、未覆盖项。

## Verification evidence

环境：官方 Node `v24.22.2`、pnpm `11.18.0`、DSH `0.2.2-alpha.2`；独立 worktree `/home/ROXY/code/singularity-v1-s4-b1`、分支 `s4-b1-decompose-prepare`、基线 `origin/main=ccc451e`。未设置 `SINGULARITY_SPIKE_LIVE`，未购买真实模型请求。

### 失败证据（实现前）

```bash
node --test packages/singularity/runtime/test/receipts.test.ts \
  packages/singularity/runtime/test/decompose-prepare.test.ts
# tests 2, pass 0, fail 2
# ERR_MODULE_NOT_FOUND: src/receipts.ts / src/decompose.ts

node --test --test-name-pattern='S4-B1' apps/singularity/test/run-recovery.test.ts
# tests 1, pass 0, fail 1
# AssertionError: toolSchemaNames(firstRequest).includes('singularity_decompose') === false
```

原始输出：`.tmp/s4b1-runtime-baseline.log`、`.tmp/s4b1-app-baseline.log`（gitignored）。app 基线在真实 DSH fixture 上直接证明旧代码没有 decompose tool；runtime 基线确认新模块尚不存在。

### 实现后

```bash
node --test packages/singularity/runtime/test/receipts.test.ts \
  packages/singularity/runtime/test/decompose-prepare.test.ts \
  packages/singularity/runtime/test/node-view.test.ts           # 18/18
node --test packages/singularity/runtime/test/run-verification.test.ts  # 11/11
node --test --test-name-pattern='S4-B1' apps/singularity/test/run-recovery.test.ts  # 1/1
pnpm --filter @singularity/runtime test  # 162/162
pnpm --filter @singularity/app test      # 75/75
pnpm verify                              # exit 0
git diff --check                         # exit 0
```

根 `pnpm verify`：protocol `225/225`、runtime `162/162`、app `75/75`，合计 `462/462`；A4 基线 `441`，本片新增 `21`（runtime 20、app 1）。`git diff --check` 通过。

### 行为与证据

- 真实 DSH fixture（`S4-B1 prepare delivers...`）使用一个 probe child binding 和真实 A2 skill：首请求可见 `singularity_decompose`；NodeView `childOptions` 包含 binding/join；prepare 结果包含完整示例标记、probe join、brief、真实 skill summary；status 在后续 step 从持久 `tool/result` 重建 `state=current`；commit action 返回 `INVALID_ARGUMENT` 且未创建 child。
- 事实链仍为 `task/admitted → run/opened → run/submitted → run/closed → task/closed`；无 `task/children-admitted`；created Agent session 仅有 root；prepare 未创建 child session/workspace/预算预留。
- 实测证据（动态 taskId/epoch，digest 只是该次运行的样例，不冒充稳定对象）：
  - previewRef id `decompose-preview:<task>-run:binding:s4b1-probe`，digest `sha256:5d8b045a4cb3a9f645d94ffc145237671906e08e0ad593161d3e7377815f3667`；
  - deliveryReceiptRef id `decompose-delivery:<task>-session:s4b1-prepare`，digest `sha256:80207efec7fac9e9b6f4d2abcee8ef4acc2d85d508f12976902b22af58cbdbb3`；
  - contextEpoch `sha256:23aa51f9fb3440a2e64a595012d3d32564b113c7cc3b956fbbc0384d7dc9e16a`；
  - usage `430 input / 56 output tokens, 7 steps, unknown=0`；system `1212`, NodeView `1886`, tool schemas `3875`, first request `8614` bytes。
  - committed session events `52`：7 次 `tool/call`/`tool/result` 对（`s3c-read`、`s3c-plan`、`s4b1-prepare`、`s4b1-status`、`s4b1-commit`、`s3c-bash`、`s3c-submit`），7 个 `step/start`/`step/end`，1 个 `turn/start`/`turn/end`；`s4b1-commit` 的结果为 `INVALID_ARGUMENT`，未产生 child/fact。
- runtime unit 覆盖：preview 与 receipt 域互读失败；仅两个 CAS 写入且无 fact；重复 prepare 同 previewRef/新 receipt；example 12 KiB exact/over 且超限无 CAS；prepare result 32 KiB exact/over；unknown/duplicate binding；status 的 `current/next-step-required/stale`；failed/replacement/duplicate/order/source/identity result；result example/interface（含 `instanceSchema`）/resolved 缺失、截断、篡改；frozen example/resolved 重读相等；fresh reader；skill/MCP summary identity；no-self/plan、no-child schema/guard、directPlan unknown/duplicate；NodeView 8 KiB preflight 正负例与 near-cap（真实 controller self-read+plan 后 live≤8192、resolved 相对 workspace）；method child binding 重复/dangling 在资源 admission 前拒绝。
- domain 结论：preview 使用 `preview` domain；delivery receipt 使用 `object` domain。`run/submitted.previewReceipts` 本片未改；B2 若列入，应使用 delivery receipt 的 `ObjectRef`，不得把 `PreviewRef` 混入。
- `readSessionToolView` 使用 alpha2 唯一可用的 committed session 读取（`snapshotEvents` 带明确 deprecated 例外）；它是 receipt adapter 的唯一未迁移读取点，不新增第二 transcript/ledger。
- 证据边界：fixture provider 不是真实模型；C-04/C-05 仍未 `proven`（commit/ack admission 不在本片）；child dispatch、required/probe join、parent yield、feedback、direct outputs、真实模型/领域评测未验证。B1 app fixture 的 child template 实际绑定 A2 skill 并断言 summary；MCP summary 走同一 `readMcpServers`（A3/A4 已覆盖其解析），B1 unit 只断言 frozen server identity 的摘要投影，未在 B1 app 中启动真实 MCP server。`receipts.ts` 使用 alpha2 唯一可用的 committed session `snapshotEvents`（deprecated 例外）作为 receipt adapter，不新增 transcript/ledger。

### Actual structure data

| 文件 | before | after | 变化 |
|---|---:|---:|---:|
| `runtime/src/decompose.ts` | — | 790 | +790（新） |
| `runtime/src/receipts.ts` | — | 130 | +130（新） |
| `runtime/src/node-view.ts` | — | 146 | +146（新） |
| `runtime/src/resources.ts` | 312 | 434 | +122 |
| `runtime/src/tools.ts` | 545 | 718 | +173 |
| `runtime/src/run.ts` | 756 | 732 | -24 |
| `runtime/src/recovery-execution.ts` | 618 | 633 | +15 |
| `runtime/src/prompt.ts` | 151 | 155 | +4 |
| `runtime/src/errors.ts` | 42 | 62 | +20 |
| `runtime/src/index.ts` | 31 | 31 | 0 |
| `apps/singularity/src/host-composition.ts` | 299 | 299 | 0 |
| `runtime/test/decompose-prepare.test.ts` | — | 862 | +862（新） |
| `runtime/test/receipts.test.ts` | — | 100 | +100（新） |
| `runtime/test/node-view.test.ts` | — | 184 | +184（新） |
| `runtime/test/run-verification.test.ts` | 699 | 884 | +185 |
| `apps/singularity/test/run-recovery.test.ts` | 5765 | 6053 | +288 |

- `run.ts` 756→732（-24）：live NodeView 与静态 preflight 已拆到 `node-view.ts`，`run.ts` 只保留 admission wiring 和 preflight 调用。
- `tools.ts` 545→718（+173，超过 20%/150 行较小触发值）：保留理由是该文件仍是唯一 DSH scoped Task tool 注册与共享 dispatch guard 面；新增块仅为 decompose tool 声明、guard 分支和 status 投影，preview/delivery schema、CAS 读取、step/epoch 分类全部在 `decompose.ts`/`receipts.ts`。若后续再加入 commit/feedback，应先拆 tool declaration 或 status projection。
- `resources.ts` 312→434（+122，超过 20% 触发值）：保留理由是该文件仍是唯一 Method/template/guidance/skill/MCP/example 资源读取入口；新增 `loadTaskExample`、`summarizeTemplateResources`、`readTemplateResourceSummaries` 与 child binding admission 校验全部复用 A2–A4 `readSkills`/`readMcpServers`，未复制 resolver/parser，434<800。
- `decompose.ts` 790 <800，仍是 preview/receipt/prepare/classifier 单一内部权威；已接近 800，B2 commit/feedback 接入时必须先拆 preview/receipt 或 reader/classifier。
- `node-view.ts` 146 单独拥有 live/static 投影；`run.ts` 不复制目录。
- 无新依赖、无 lockfile 变化、无 protocol/fact 变更、无 package index 导出变化；`decompose.ts`/`receipts.ts`/`node-view.ts` 保持内部模块，schema/behavior 由 `tools.ts`/`run.ts` 与 tests 相对导入。`SessionReceiptError` 与 step 比较函数保持模块内部，不作为 package export。
- 未覆盖：commit/ack admission、child batch/dispatch、join/winner、parent yield/wake、feedback、direct outputs、exploration/ancestor/summary、真实模型与领域评测。
