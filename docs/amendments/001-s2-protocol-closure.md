# Amendment 001：S2 protocol closure（fact payload、command 与 admission 最小语义）

- **状态：待用户确认，未批准，未实现。**
- **日期：** 2026-10-30
- **基线：** `main` @ `5b5f2584d2572dab83ff97ee5065563feecdb332`；`docs/framework.md` V1 发布规范 1.0；`spec-lock.json` `sha256:06fa0b717eb1ed83ee3e319c809b1b1569263eb84cbe03abc7259ce6347957c2`。
- **证据基线：** S2-A/B 已完成；protocol tests `86/86`。当前没有 fact payload、command guard、journal/FS、reducer 或 runtime 实现。
- **本文件性质：** 规范 amendment 提案。它合并 fact payload 与 command/admission 两份草案，只保留关闭 S2 所需的最小内容；不实现代码，不修改 `docs/framework.md`、`spec-lock.json`、`docs/conformance.md`、`docs/build-plan.md`、`README.md` 或源码。
- **非目标：** 不新增 authority、第二 writer、第二 journal、第二 fold、wake 来源、registry、transcript mirror、model loop 或兼容层。

> 本文所有字段、规则、表和类型都是**提案**，不是已批准规范或已实现行为。只有用户明确批准后，才在 framework/spec-lock/protocol/conformance 的同一变更中落地。

## 1. 规范条目与缺口

| 条目 | 现有文本 | 缺口 |
|---|---|---|
| §4 开头 | 未展开的 Ref 都是 `{ id, digest }`，Digest 为 `sha256:<hex>` | digest 没有 domain 映射；schema 只校验形状 |
| §4.1–§4.3 | TaskContract、TaskSpec、OutputSpec、`deadlineAt`；localOutputs 转 supporting | output 合并顺序、冲突和保留命名空间未定义；`deadlineAt` 无单位 |
| §6.1–§6.2 | 资源快照；每个 TaskContract 追加 `__skill-drafts`/`__mcp-drafts` | 资源 digest domain、draft 相对位置未定义 |
| §8.1–§8.2 | previewRef/ackPreview；commit 时合并 required outputs 与 localOutputs | preview domain、合并函数和失败点未定义 |
| §10.1 | Fact envelope、JCS、8 个 digest domain、commandId 幂等 | `FactType`/`FactPayload` 未定义；normalized command、command 内容身份、原结果重建未定义 |
| §10.2 | 13 种闭合 facts 的业务内容 | 只有散文，没有字段名、类型、optional 语义或引用边界 |
| §10.3、§19.1 | append/fsync 是提交点；torn tail；恢复 | journal 编码、行 framing、`seq` 起始/连续性、时间单位未定义 |
| §15.2 | Evidence、UsageRecord、ExecutionRecord、Composition、receipt | 被 fact 引用的对象没有最小形状 |
| §20 | C-01/C-05/C-11 等场景 | 当前均为 `unproven`；上述缺口使场景无法形成一致证据 |
| §21 | 1 journal、1 fold、1 writer、1 wake authority、0 registry/transcript | 本提案必须证明不突破这些预算 |

## 2. 最小复现与失败场景

| # | 场景 | 失败方式 |
|---|---|---|
| 1 | 两个实现把 `run/closed` 写成不同字段（`verdict/evidence` vs `classification/evidenceRef/executionRecordRef`） | 同一 journal 无法 replay；C-11 失败 |
| 2 | `task/children-admitted` 把完整 child contracts 降为 refs，另一个实现内联完整合同 | 同一 batch 的 digest、children 计数和恢复行为不一致；C-05 失败 |
| 3 | `run/closed.usage` 与 Evidence/ExecutionRecord.usage 不一致，或一方缺失 | usage 漂移；unknown 计数和 retry/trace 结果分叉 |
| 4 | `task/closed` 为每个被取消 descendant 补写 `run/closed` | 违反 §10.2“task/closed 是取消结论的唯一来源”；C-10 失败 |
| 5 | 同一 `commandId` 重试时 payload 变化，但 fact 没有 command 内容身份 | 重复 child/admission/activation；C-11 幂等失败 |
| 6 | Host A 的 `seq` 从 0 开始，Host B 从 1 开始；或 A 写 LF、B 写 CRLF | genesis、torn tail 和 replay 不一致；C-11 失败 |
| 7 | `deadlineAt` 被按秒解释，或时钟回拨后 retry 获得更长时间 | 任务过早结束或永不结束；§4.2 预算不变量失败 |
| 8 | `previewRef` 按 `object` 而非 `preview` domain 验证 | 合法 preview 被拒或任意 object 被接受；C-04/C-08 失败 |
| 9 | Host A/B 对同一 base/local outputs 采用不同合并顺序 | 同一逻辑 child 得到不同 contract digest；C-01/C-05 失败 |

## 3. 为什么现有扩展点不足

- **不能把事件字段塞进 TaskContract/MethodRevision/Evidence**：这些是冻结业务对象，字段变化会改变 digest 和 seal 语义，并把“对象状态”与“journal 事件”混在一起。
- **不能用自由 `JsonObject` 作为 `FactPayload`**：协议要求 strict schema、拒绝未知字段、可从单一权威源生成 JSON Schema；自由对象无法提供字段 guard 或稳定 digest。
- **不能只保留 `commandId`**：它只是稳定 ID，不是内容身份；同 ID 不同 payload 无法区分，重启后无法重建原结果。
- **不能新增持久 command 表或 registry**：这会成为第二 ledger；幂等投影必须从 journal 内存重建。
- **不能把完整 transcript 或 contract 副本写进 fact**：§10.2 要求大对象存 CAS；但 `task/children-admitted` 的“完整 children contracts”是既有例外，必须按合同对象内联，不得擅自降为 refs。
- **不能把 Usage/ExecutionRecord/Composition 复制进每个 fact 或另建账本**：这些是既有 §15.2 对象；fact 只引用它们或保留独立 usage 字段，不能形成第二 usage/evidence 账本。
- **不能为 subtree cancellation 补写 `run/closed`**：§10.2 已规定 `task/closed` 是这些取消结论的唯一来源；per-descendant facts 会破坏单 writer/fold 和 C-10。
- **不能靠实现约定补 domain/merge/framing**：ref、output 顺序和 journal framing 都是 digest 的一部分；两个实现分叉会直接破坏 C-01/C-05/C-11。

## 4. 公共协议闭包

### 4.1 Fact envelope、command identity 与唯一推荐

在 §10.1 的 Fact 上只增加一个字段：`commandDigest`。Digest domain 增加一个 `command`；现有 8 个 domain 不重排、不改名。

```ts
interface Fact {
  readonly v: 1
  readonly seq: number                 // genesis = 0；见 §4.2
  readonly commandId: string           // host 分配；模型不可提供
  readonly commandDigest: Digest       // command domain；新增
  readonly type: FactType
  readonly actor: { readonly kind: 'operator' | 'runtime'; readonly id: string }
  readonly at: number                  // Unix epoch ms；只用于审计
  readonly data: FactPayload
  readonly prev: Digest | null         // 前一条 fact 的 fact-domain digest
  readonly digest: Digest              // fact domain
}

interface NormalizedCommand {
  readonly v: 1
  readonly commandId: string
  readonly tool: string                // singularity_* 或 host operation 名
  readonly toolVersion: 1
  readonly actor: { readonly kind: 'operator' | 'runtime'; readonly id: string }
  readonly scope: {
    readonly taskId?: string
    readonly runId?: string
    readonly sessionId?: string
  }
  readonly input: JsonValue            // strict 校验后的原始命令输入
}
```

- `commandDigest = computeDigest('command', NormalizedCommand)`；`NormalizedCommand` 不存 CAS，不是 `ObjectRef`。
- `input` 是 strict schema 校验后的原始输入；不得补默认值、重排或“修复”。host-resolved 的当前 state、contract/method digest、当前 PlanningSketch、batch、feedback、预算、`asOf`、`at`、cursor 不进入 digest；它们由 state guard 校验。
- `commandId` 由 host 绑定；DSH 命令使用跨 resume 稳定的 `(sessionId, toolCallId)` 派生 ID；operator/runtime 命令由 trusted host 生成。模型和工具参数不能提供 `commandId`、actor、domain 或 digest。
- **一 command 一 fact**：成功的 journal command 恰好 append 一条 fact；没有 append 的不是 journal command。一个 command 多条 fact 在 replay 时拒绝。
- 命令到达时，host 从 journal 构建内存 `commandId -> {commandDigest, seq, factDigest}` 投影（不持久化、不是第二 ledger）：
  1. 同 `commandId`、同 `commandDigest`：从 fact 重建原结果，不 append、不预留预算、不派 child、不唤醒。
  2. 同 `commandId`、不同 `commandDigest`：`IDEMPOTENCY_CONFLICT`，无副作用。
  3. 无记录：走正常 state/budget/guard；成功后 CAS 先写、append 一条带 `commandDigest` 的 fact、fsync、返回结果。
- 原结果重建：taskId/runId/batchId/child IDs、contract/method/evidence refs、outcome/classification、submission ref 等必须能从 fact 的 `type`/`data` 确定性重建；`remainingBudgetPct`、`asOf` 是可变视图字段，可重新计算。若原结果字段无法从 fact 推导，命令必须在 append 前把它作为 CAS ref 放进 fact；禁止“记不清就重新执行”。fact 引用的 CAS 缺失/损坏时 replay 拒绝启动。
- 已提交命令在 Run/Task 已 closed 后重放仍返回原结果；幂等匹配不绕过 actor/run 绑定或读取授权。若实现暴露 writer 之外的 in-flight 状态，复用既有 `ACTIVE_JOB`，不新增错误码或持久状态。
- **备选（不推荐）**：`Fact.commandRef: ObjectRef` + 把 `NormalizedCommand` 存 CAS。它不需要新 domain，但每个命令多一次 CAS 写、多一次 ref 解析，并可能把 tool input 暴露到 CAS；对幂等正确性没有额外收益。本文只保留一个推荐：`commandDigest` + `command` domain。

### 4.2 Journal framing、seq 与时间

- Journal 是 UTF-8 文件，无 BOM、无文件头；每条 fact 是一行 `JCS(fact)` 的 UTF-8 字节，后跟一个 LF (`0x0A`)。行内不得有 CR、空行或前导/尾随空白；JCS 字符串中的换行已转义。
- `seq` 从 `0` 开始、连续、不跳号、不重复；`prev` 是前一条 fact 的 `digest`，genesis 为 `null`。replay 逐条校验 seq、prev、fact digest 和 commandDigest；任何失败拒绝启动。
- 空文件是合法未初始化状态。最后一段没有 LF 的字节是 torn tail，可以截去；即使它碰巧是完整 JSON，也截去，因为提交点是“完整行 + fsync”。以 LF 结尾但解析/schema/digest 失败的行是中间损坏，拒绝启动，不能跳过。
- `at`、`deadlineAt`、`asOf` 统一为 Unix epoch milliseconds（UTC）安全整数，`0 <= value <= Number.MAX_SAFE_INTEGER`；不得用字符串、浮点、`Date`、NaN/Infinity。
- `at` 只用于审计，不参与排序、幂等、deadline 或 replay；`seq` 才是顺序。`deadlineAt` 为绝对时间，行动边界只允许 `now < deadlineAt`；`now >= deadlineAt` 不开始新行动；retry/recovery 不延长。无法提供可信时间或检测到时钟回拨时 fail closed，不把回拨解释为更多预算。
- `Fact.digest` 使用 `fact` domain；`Fact.commandDigest` 使用 `command` domain；两者都按 §10.1 的 `SHA256(UTF8("singularity/v1/" + domain + "\n") || payloadBytes)` 计算。

### 4.3 Ref 类型/字段 → digest domain

不改变 `{ id, digest }` 线形，不新增带 domain 的 ref 字段，不新增 ref/template domain。domain 由 schema 位置决定。

| Ref 类型或字段 | Domain | 规则 |
|---|---|---|
| `ObjectRef`、`AssetRef`（inputs、resources、guidance、example、bundle、manifest、config、receipt、planningSketch、feedback 等） | `object` | CAS 原始 bytes；结构化对象为去掉最外层 digest 的 JCS |
| `MethodRef`（contract.method、method.parent、NodeView.method、RoundPlan.baseMethod 等） | `method` | MethodRevision 去掉最外层 digest 的 JCS |
| `TemplateRef`（contract.template） | `method` | 其所在 MethodRevision 的 method digest；`id` 在该 revision 的 templates 中存在 |
| contract refs（contractDigest、ContractSummary.sourceContract、TaskRef.digest、Evidence.task.digest） | `contract` | TaskContract 去掉最外层 digest 的 JCS |
| `PreviewRef` / `ackPreview` | `preview` | preview 对象去掉最外层 digest；`ackPreview` 必须等于 `previewRef.digest` |
| `EvidenceRef`（run/closed、task/closed、NodeView evidenceRef） | `evidence` | Evidence 去掉最外层 digest；ExecutionRecord 不得冒充 |
| `ExecutionRecordRef` | `object` | ExecutionRecord 去掉最外层 digest |
| `CompositionRef` | `composition` | Composition 去掉最外层 digest |
| `RoundPlanRef` | `round-plan` | RoundPlan 去掉最外层 digest |
| `Fact.prev` / `Fact.digest` | `fact` | fact 去掉最外层 digest |
| `Fact.commandDigest` | `command` | NormalizedCommand 的 JCS |

- `PreviewRef`、`EvidenceRef`、`ExecutionRecordRef`、`CompositionRef`、`RoundPlanRef` 都是 `Ref` 的语义别名；线形仍是 `{ id, digest }`，domain 由字段位置决定。
- 未列出的 ref 类型或裸 Digest 不猜默认 domain；按 `INVALID_ARGUMENT` 拒绝，直到 amendment 补充。
- `TemplateRef.digest == MethodRef.digest` 是有意的：template 的权威是冻结的 Method revision，不是独立 CAS 对象。
- **digest 匹配不是读取授权**：即使 ref 验证通过，CAS 读取仍受 §12.3/§17.2 scope 限制。

### 4.4 Output 合并顺序与保留命名空间

准入时 root/child 使用同一个纯函数：

```text
base outputs
→ localOutputs（仅 child；按 proposal 顺序转 role='supporting', required=false）
→ __skill-drafts（tree, role='skill-draft', required=false）
→ __mcp-drafts（tree, role='mcp-draft', required=false）
```

- base 顺序严格保留（root: operator/domain 授权 outputs；child: template.requiredOutputs）；local 顺序严格保留；drafts 永远最后，固定 skill 在前、MCP 在后。
- root 也追加两个 drafts，保持“每个 TaskContract”一致；`includeLearningDrafts` 只控制提交时是否冻结实际目录，不控制是否声明 drafts。
- 合并后 `id`、`path` 必须唯一；重复 → `INVALID_ARGUMENT`，不覆盖、不去重。base/local 不得使用保留 ID `__skill-drafts`/`__mcp-drafts` 或保留 path `learning-drafts`/`learning-drafts/`；template 使用 draft role/path 在 Method precheck/admission 拒绝。
- `spec.criteria`、`spec.localGuidance`、`spec.inputs` 保留各自声明/proposal 顺序；localCriteria 不合并进 criteria；acceptance 仍由 host 解析。
- 失败发生在 append fact 之前：不产生 child、fact 或预算预留。seal 不重排、不追加；admission guard 验证 tail 恰好是两个 drafts。

### 4.5 Supporting CAS 对象与 receipt 边界

这些是 CAS 数据形状，不是 authority、fact 或第二账本。未列出的字段保持现有 §15.2 语义；optional 字段保留 optional，不统一改 null。

```ts
interface UsageRecord {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly steps: number
  readonly unknownRequests: number       // 未知不等于 0
  readonly summary?: {                    // Contract Summary Worker 子记录；不新增对象字段
    readonly ownerTaskId: string
    readonly sourceContract: Digest
    readonly inputTokens: number
    readonly outputTokens: number
    readonly steps: number
    readonly unknownRequests: number
  }
}

interface ExecutionRecord {
  readonly v: 1
  readonly taskId: string
  readonly runId: string
  readonly contractDigest: Digest
  readonly method: MethodRef
  readonly composition: ObjectRef
  readonly inputs: readonly ObjectRef[]
  readonly outputs?: readonly ObjectRef[] // 可缺；partial outputs 不是 acceptance 依据
  readonly usage: UsageRecord
  readonly sessionCut: SessionCut
  readonly reason: string
  readonly drainPending?: boolean
  readonly digest: Digest                  // object domain
}

interface Composition {
  readonly v: 1
  readonly dsh: { readonly package: string; readonly version: string; readonly config: ObjectRef }
  readonly platformPrompt: Digest
  readonly contract: ObjectRef
  readonly template: ObjectRef
  readonly guidance?: ObjectRef
  readonly skills: readonly ObjectRef[]     // 完整 skill bundle refs
  readonly mcpServers: readonly {
    readonly manifest: ObjectRef
    readonly bundle: ObjectRef
    readonly schema: ObjectRef
    readonly config: ObjectRef
    readonly transport: 'stdio' | 'streamable-http'
    readonly capabilities: readonly string[]
  }[]
  readonly modelRoute: ObjectRef
  readonly resources: ObjectRef
  readonly seed: ObjectRef
  readonly digest: Digest                   // composition domain
}

interface SessionCut {
  readonly sessionId: string
  readonly from: number  // inclusive
  readonly to: number    // exclusive；DSH sequence 语义在实现期验证
}

interface BudgetReservation {
  readonly tokens: number
  readonly steps: number
  readonly deadlineAt: number
}
```

- `Evidence` 保持 §15.2：`task`、`runId`、`contractDigest`、`method`、`inputs`、`outputs`、`composition`、`verification.publicReceipt`/`privateReceipt?`、`usage`、`sessionCut`、`environment`。
- `run/closed.usage` 是该 Run closure 的最终 usage 快照；若同时引用 Evidence/ExecutionRecord，其内嵌 usage 必须与 fact.usage canonical-equal。两者由同一 writer 在同一 command 中产生，不是两套独立计量。
- `UsageRecord` 的 `summary?` 是 §15.2 的 summary 子记录；不增加 `ContractSummary.usage` 字段，不新增 usage fact。RSI proposer usage 仍按 §15.2 留在 Round 预算/宿主记录，本 amendment 不为 `rsi/round-closed` 增加 usage 字段。
- Receipt、preview/read receipt、precheck receipt、comparison、approval 一律是 CAS `ObjectRef`；fact 不内联 receipt 内容。`privateReceipt` 只在 Evidence 内，不进入 fact、NodeView、ProposerView 或模型输出。
- `CancellationCut` 是 `task/closed` 引用的不可变 CAS 快照，不是一套新 facts：

```ts
interface CancellationCut {
  readonly v: 1
  readonly targetTaskId: string
  readonly affected: readonly {
    readonly taskId: string
    readonly runId?: string
    readonly executionRecordRef?: ObjectRef
  }[]
  readonly digest: Digest // object domain
}
```

## 5. 13 种 fact payload 精确提案

`TaskContract`、`MethodRevision`、`Evidence`、`RoundPlan`、`MethodPatch` 沿用 §4/§5/§15/§17/§18，不在此重定义。字段名尽量沿用 §10.2 散文；`?` 表示既有语义允许缺失，不把 optional 改成 null。Payload 不重复 `v`；版本由 Fact envelope 拥有。未知字段、未知 type、错误 type/data 组合均拒绝。

```ts
type FactType =
  | 'method/registered'
  | 'method/activated'
  | 'task/admitted'
  | 'run/opened'
  | 'task/children-admitted'
  | 'run/submitted'
  | 'run/closed'
  | 'task/closed'
  | 'rsi/trace-sealed'
  | 'rsi/round-opened'
  | 'rsi/proposal-submitted'
  | 'rsi/candidate-ready'
  | 'rsi/round-closed'

interface MethodRegisteredPayload {
  readonly revision: MethodRef
  readonly parent?: MethodRef
  readonly sourceProposal?: ObjectRef // 初始化/人工导入来源；candidate-ready 不写本 fact
}

interface MethodActivatedPayload {
  readonly expectedPrevious?: MethodRef
  readonly previous?: MethodRef
  readonly next: MethodRef
  readonly approval: ObjectRef
  readonly evaluationRef?: ObjectRef
}

interface TaskAdmittedPayload {
  readonly taskId: string
  readonly contract: ObjectRef // contract domain；完整 root contract
}

interface RunOpenedPayload {
  readonly taskId: string
  readonly runId: string
  readonly attempt: number
  readonly sessionId: string
  readonly composition: ObjectRef
  readonly workspaceKey: string
  readonly workspaceSeed: ObjectRef
  readonly budgetReservation: BudgetReservation
}

interface ChildrenAdmittedPayload {
  readonly parentRunId: string
  readonly batchId: string
  readonly children: readonly {
    readonly contract: TaskContract        // 完整 child contract，按 §10.2 保留
    readonly join: 'required' | 'probe'    // 由 binding 派生
    readonly budgetReservation: BudgetReservation
    readonly replacement?: {
      readonly feedbackRef: ObjectRef
      readonly supersedesChildIds: readonly string[]
    }
  }[]
}

interface RunSubmittedPayload {
  readonly runId: string
  readonly outputs: ObjectRef              // frozen outputs manifest
  readonly transcriptOffset: { readonly sessionId: string; readonly seq: number }
  readonly previewReceipts: readonly ObjectRef[]
  readonly readReceipts: readonly ObjectRef[]
  readonly planningSketchRef: ObjectRef
  readonly feedbackRefs: readonly ObjectRef[]
}

interface RunClosedPayload {
  readonly runId: string
  readonly classification: 'verified' | 'failed' | 'invalid' | 'cancelled'
  readonly reason: string
  readonly evidenceRef?: ObjectRef          // verified / criteria-failed
  readonly executionRecordRef?: ObjectRef   // no-submission / stop / invalid / cancelled
  readonly usage: UsageRecord                // 保留独立 usage，不只依赖 result 对象
  readonly planningSketchRef?: ObjectRef
  readonly feedbackRefs: readonly ObjectRef[]
}

interface TaskClosedPayload {
  readonly taskId: string
  readonly outcome: 'verified' | 'failed' | 'invalid' | 'cancelled'
  readonly reason: string
  readonly decisiveRunId?: string
  readonly evidenceRefs: readonly ObjectRef[] // 保留名称；Evidence refs
  readonly scope?: 'subtree'                  // 仅级联关闭时出现
  readonly cancellationCutRef?: ObjectRef
}

interface TraceSealedPayload {
  readonly rootTaskId: string
  readonly trace: ObjectRef
  readonly usage: UsageRecord                // 完整 source trace usage
  readonly sessionCuts: readonly SessionCut[]
}

interface RsiRoundOpenedPayload {
  readonly roundId: string
  readonly sourceTrace: ObjectRef
  readonly baseMethod: MethodRef
  readonly plan: ObjectRef
  readonly proposerSessionId: string
}

interface RsiProposalSubmittedPayload {
  readonly roundId: string
  readonly patch: ObjectRef
}

interface RsiCandidateReadyPayload {
  readonly roundId: string
  readonly patch: ObjectRef
  readonly precheckReceipt: ObjectRef
  readonly candidateMethod: MethodRef
}

interface RsiRoundClosedPayload {
  readonly roundId: string
  readonly outcome: 'improved' | 'no-improvement' | 'insufficient-evidence' | 'rejected' | 'cancelled'
  readonly comparisonRef?: ObjectRef
  readonly precheckReceipt?: ObjectRef
  readonly reason?: string
}

interface FactPayloadMap {
  'method/registered': MethodRegisteredPayload
  'method/activated': MethodActivatedPayload
  'task/admitted': TaskAdmittedPayload
  'run/opened': RunOpenedPayload
  'task/children-admitted': ChildrenAdmittedPayload
  'run/submitted': RunSubmittedPayload
  'run/closed': RunClosedPayload
  'task/closed': TaskClosedPayload
  'rsi/trace-sealed': TraceSealedPayload
  'rsi/round-opened': RsiRoundOpenedPayload
  'rsi/proposal-submitted': RsiProposalSubmittedPayload
  'rsi/candidate-ready': RsiCandidateReadyPayload
  'rsi/round-closed': RsiRoundClosedPayload
}

type FactPayload = FactPayloadMap[FactType]
```

关键约束：

| Fact | 约束 |
|---|---|
| `method/registered` | `revision` 验证 method domain；`parent` 与 revision.parent 一致；candidate-ready 不写本 fact |
| `method/activated` | `expectedPrevious`/`previous` 在非首次 activation 出现；`next` 已在只读 catalog；approval 含 expected/next；不移动 live Task |
| `task/admitted` | root contract；taskId 与 contract 一致；同一 taskId 只准入一次 |
| `run/opened` | Task open、无 active Run；attempt 1-based 且不超过 maxRuns；budget/deadline 不超父预算 |
| `task/children-admitted` | parent Run active；children 非空且不超过 maxBatchChildren；完整 child contracts；replacement 仅 source child terminal failure；模型不能提供 binding/join/replacement |
| `run/submitted` | Run open；self read/PlanningSketch 有效；无 active child batch；outputs manifest 身份匹配；提交后 latch |
| `run/closed` | `evidenceRef` 与 `executionRecordRef` 恰好一个；verified 只引用 Evidence；no-submission/invalid/cancelled 引用 ExecutionRecord；`usage` 独立保存且与 result 内嵌 usage canonical-equal |
| `task/closed` | verified 需 decisive Run verified + join；`evidenceRefs` 只放 Evidence；subtree cancellation 由本 fact 独占，不补写 run/closed |
| `rsi/trace-sealed` | 全树 terminal、所有 Run closed、agents/processes drained；same rootTaskId 只 seal 一次 |
| `rsi/round-opened` | plan 先冻结；base = active head；proposer 尚未发请求 |
| `rsi/proposal-submitted` | Round proposing；patch base 一致；每 Round 一个正式 patch |
| `rsi/candidate-ready` | precheck 成功；candidate 加入只读 catalog；不写 method/registered |
| `rsi/round-closed` | improved/no-improvement 必须有 comparison；rejected 必须有 precheck receipt/reason；不移动 production head |

## 6. C-11 变化与 conformance 影响

### 6.1 C-11 的精确增量

1. `commandDigest` 绑定 normalized command；同 `commandId` 同 digest 返回原结果，不同 digest `IDEMPOTENCY_CONFLICT`。
2. 一个 command 恰好一条 fact；同 commandId 多条 fact、同 fact commandDigest 不符均拒绝 replay。
3. `seq=0` genesis、连续、`prev` 成链；gap/duplicate/wrong prev/fact digest 错拒绝启动。
4. journal 为 JCS NDJSON/LF；只截 EOF 未终止 tail；LF 结尾的损坏行拒绝。
5. 幂等重放不新增 fact、预算、child、wake；deadline 不延长；原结果从 fact/CAS 重建，不重新执行。
6. `at`/`deadlineAt`/`asOf` 为 epoch ms 安全整数；`at` 不参与排序/幂等；deadline exclusive。

### 6.2 受影响场景

| 场景 | 本提案新增的可验证内容 |
|---|---|
| C-01 | root contract 的 method/template/acceptance/resources refs 按 domain 验证；root outputs = base → drafts；`deadlineAt` 为 epoch ms；合同 digest 确定 |
| C-05 | localOutputs 只能转 supporting/false；保留 ID/path 和 template draft role 拒绝；完整 child contracts 与 join/budget 来自 host；同命令重试返回同一 child IDs/contract digests |
| C-11 | commandDigest/一 command 一 fact/replay 投影/原结果重建/seq/framing/torn tail/deadline |
| C-10 | `task/closed(scope='subtree')` 是 cancellation 唯一来源；cut 记录 affected descendants/Runs |
| C-14 | `rsi/trace-sealed` 的 usage/sessionCuts 与 private receipt 边界 |
| C-19/C-23 | `method/activated` 的 expected/previous/approval CAS；Round fact 不移动 head |

**本提案不修改 `docs/conformance.md`，不把任何场景改为 `proven`。** 实现并跑出真实证据前，C-01/C-05/C-11 及相关场景继续保持 `unproven`。

## 7. 权限、预算与复杂度

### 7.1 权限

| Fact | actor | 关键 guard |
|---|---|---|
| `method/registered` | operator | initialization/manual import；revision/parent 匹配；proposer 不可写 |
| `method/activated` | operator | approval + expectedPrevious；不移动 live Task |
| `task/admitted` | runtime | root contract；taskId 唯一 |
| `run/opened` | runtime | Task open、无 active Run、预算足够 |
| `task/children-admitted` | runtime | live parent Run；binding/join/replacement host 派生 |
| `run/submitted` | runtime | live Agent/Run；submission latch |
| `run/closed` | runtime | verifier/ExecutionRecord 身份；模型不写 verdict |
| `task/closed` | runtime（cancel 可为 operator） | verified/join 或 retry policy；trusted cancel |
| `rsi/trace-sealed` | runtime | 全树 terminal/drained；exactly-once |
| `rsi/round-opened` | operator | plan 先冻结；base = active head |
| `rsi/proposal-submitted` | runtime | live proposer session；每 Round 一个 patch |
| `rsi/candidate-ready` | runtime | precheck pass；candidate 注册 |
| `rsi/round-closed` | runtime | comparison 校验；不 activation |

所有 fact 仍由单一 command service 写入；`actor` 是授权来源，不是新 writer。模型只能通过工具表达 intent，不能提供 commandId/commandDigest/actor/ref/role/required/digest；`privateReceipt`、validation/holdout payload、golden data 不进入 fact 或模型视图。

### 7.2 预算与复杂度

| 维度 | 影响 |
|---|---|
| authority | 仍 5：Task、Run、Evidence、Method、RsiRound |
| journal / fold / writer / wake | 仍各 1；无新 registry/transcript/model loop |
| fact 类型 | 仍 13；不新增 |
| digest domain | 8 → 9（仅 `command`）；现有 8 个不重排 |
| Fact envelope | 仅新增 `commandDigest`（约 80–100 字节/fact） |
| 幂等索引 | 仅 replay 内存投影；不持久化、不是第二 ledger |
| 模型 token/step | 无新增；payload 不进入 prompt；预算仍按百分比展示 |
| journal 字节 | `run/closed` usage 与 `task/children-admitted` 完整 contracts 按既有 prose；children 受 maxBatchChildren/既有 bytes cap 限制 |
| runtime | 增加 strict schema、domain/merge、command projection；不增加模型请求或自动 loop |

## 8. 兼容性

- 当前没有 fact/journal 实现或生产数据；新增 required `commandDigest` 不需要迁移。
- 现有 8 个 digest domain 字符串不变；`command` 追加到枚举末尾。任何硬编码 8 domain 的测试/实现须在批准后更新。
- Ref JSON 线形不变；语义校验更严格。任何预规范 journal 若使用 1-based seq、CRLF、JSON array、缺 commandDigest 或错 domain，均不兼容；不提供 shim 或迁移层。
- `task/children-admitted` 内联完整 child contracts，符合 §10.2 既有散文；不把 contracts 降为 refs。
- `run/closed` 保留 `usage` 字段并区分 `evidenceRef`/`executionRecordRef`；`task/closed` 保留 `evidenceRefs` 名称；不把 existing optional 字段统一改 null。
- Output 合并顺序/保留命名空间会改变预规范实现的 contract digest；当前无生产合同，C-01/C-05 fixture 在批准后更新。
- 不改变 DSH/Node/MCP transport、验收所有者、模型可见性或生产权限。
- 批准后必须在同一变更更新 `docs/framework.md`、`spec-lock.json`、protocol schema/guard、相关 runtime 和 `docs/conformance.md`；本提案单独不产生规范或代码变更。

## 9. 用户确认记录

### 9.1 当前状态

| 项目 | 内容 |
|---|---|
| 状态 | **待用户确认，未批准，未实现** |
| 确认人 | 尚未确认 |
| 确认日期 | 无（本文创建于 2026-10-30，仅为提案日期） |
| 本文件效力 | 仅为 amendment 提案；不是已批准规范，不是已实现行为 |
| 规范/spec-lock/conformance 修改 | 无 |
| 代码/构建修改 | 无 |

### 9.2 需要用户明确决定的关键点

| ID | 选择 | 推荐 | 不接受的后果 |
|---|---|---|---|
| K1 | command 内容身份 | `Fact.commandDigest` + 新 `command` domain；`commandRef`+CAS 仅作备选 | 无法检测同 ID 不同 payload；C-11 幂等不成立 |
| K2 | journal/time | `seq=0` 连续、JCS NDJSON/LF、`at`/`deadlineAt`/`asOf` epoch ms、deadline exclusive | 不同实现的 genesis/torn tail/deadline 不一致 |
| K3 | ref domain | 采用 §4.3 映射；`TemplateRef` 复用 Method digest；`preview` 使用 preview domain；不新增 ref/template domain | method/template/preview ref 可被错域验证；C-01/C-05 分叉 |
| K4 | output 合并 | `base → local(supporting) → __skill-drafts → __mcp-drafts`；保留顺序；拒绝重复/保留 ID/path | 同一逻辑合同产生不同 digest |
| K5 | fact payload | 采用 §5：完整 child contracts、run/closed 独立 usage + evidence/execution 区分、task/closed `evidenceRefs`、保留 optional | 无法形成一致的 13 fact schema；C-11 replay 不确定 |
| K6 | conformance | C-01/C-05/C-11 及相关场景在实现并跑出真实证据前保持 `unproven` | 把提案或静态向量误写成已证明 |

### 9.3 未确认时的阻塞摘要

- **阻塞**：`FactType`/`FactPayloadMap`、13 种 fact schema、`commandDigest`/command guard、journal framing/replay、reducer、C-01/C-05/C-11 的纯协议证据、依赖这些 fact 的 runtime 恢复。
- **不阻塞**：本提案的文档评审；现有 Task/Method schema 的独立修正；不依赖 fact/command 的文档与测试。
- **不得做**：把本文任何字段或规则写成已批准事实；在实现中先造 payload 再回写规范；修改 framework/spec-lock/conformance 或源码来让测试先绿。
