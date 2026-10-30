# Amendment 002：Acceptance receipt 与 submission manifest（已批准并纳入）

- **状态：已批准；A0–A9 已纳入正式规范。** 本文保留提出和纳入时的基线，当前实现与逐场景证据见 [build-plan](../build-plan.md) 和 [conformance](../conformance.md)。
- **日期：** 2026-10-30
- **提出基线：** `main` @ `bf79e3a7fec560ab91d62de867c2d41d22f0de7a`；`docs/framework.md` V1 发布规范 1.0；`spec-lock.json` `sha256:6f4a57e7987c8def2b5e12504fb8a6e2599968161f94115a473b8b98ed29fd91`。
- **纳入基线：** `s3-b1-acceptance-schema` @ `7734cc9`；纳入后 `spec-lock.json` `sha256:5f33aa339f21496c375de637ef447656fc66d98d3054a5b6e0a1d3c8dc612b6f`。
- **本文件性质：** 记录用户已批准的 A0–A9 语义、理由、兼容性、证据边界和批准记录；正式规范以 `docs/framework.md` §4.0、§4.3、§9.2、§11.4–§11.5、§15.3、§19.1、§20 为准。
- **本次变更：** 同一 docs 变更更新 `docs/framework.md`、`spec-lock.json`、本 amendment、`docs/conformance.md`、`docs/build-plan.md` 与 `README.md`；不修改任何源码，不代表 schema/runtime 已实现。
- **非目标：** 不新增 authority、fact、digest domain、writer、fold、registry、transcript mirror、model loop、验收所有者或第二账本；不改变 DSH/Node/MCP transport、生产权限、模型可见性或 retry/join/取消语义；不宣称 C-02/C-03/C-11 已验证。

> 用户于 2026-10-30 回复：“全部确定，以后不需要向我确认任何事，自行推进”，批准 A0–A9 整体包。批准冻结语义；`PublicReceipt`/`SubmissionManifest` 的实现、测试、真实 DSH/模型/领域验收证据和任何 conformance 状态升级仍须后续变更独立完成。

## 1. 规范条目与缺口

| 条目 | 当前冻结内容 | 缺口 |
|---|---|---|
| §4.0 | `Ref` 线形为 `{ id, digest }`；`ObjectRef`、`AssetRef` 等按 schema 位置映射 `object` domain；未列出的 ref 不猜默认 domain | `TaskContract.acceptance: AcceptanceRef` 没有 domain 或对象形状；`PublicReceipt.provider` 无法与冻结合同中的验收身份做确定比较 |
| §4.3 | root criteria/verifier/scorer 来自用户授权的 domain case/operator；child acceptance provider 由固定 domain policy 解析 | 只定义权威来源，没有 provider identity、receipt shape 或 receipt 校验边界 |
| §9.2、§11.4–§11.5 | `run/submitted` 冻结 outputs manifest；verifier 在 CAS 上运行；`validateReceipt` 必须检查 provider、operationId、contract/input/output digest、每条 required criterion 恰一次、verdict、score metric/unit/finite、原始退出状态；exit=0 本身不足以 verified | 上述检查只有散文，没有 `PublicReceipt` 字段、类型或失败分类；`SubmissionManifest` 只有“frozen outputs manifest”名称 |
| §10.1–§10.3 | 一个 command 一条 fact；CAS 先写、fact 后 append；fact 引用 CAS；replay 校验 fact 链；`run/submitted.outputs` 是 `ObjectRef` | 没有定义被引用 manifest 和 receipt 的 strict schema、排序、digest domain 或负例 |
| §12.3 | 父 Run 对 direct children 的公开 Evidence 和声明 outputs 有读取权；最终 `Evidence.inputs` 包含初始输入及追加的 direct outputs | 没有冻结“verifier 授权输入”“Evidence.inputs”与 receipt digest 列表必须由同一 snapshot 派生 |
| §15.2 | `Evidence.verification.publicReceipt` / `privateReceipt?` 是 `ObjectRef`；`ExecutionRecord` 用于 no-submission/stop/cancel/基础设施异常；`privateReceipt` 不返回 worker/RSI | `PublicReceipt` 只有“criterion ID、pass/fail/invalid、公开错误与可用 metric”的描述；没有字段名、optional 语义或 finite number 规则 |
| §19、§19.1 | `DomainAdapter.verify(request: VerifyRequest): Promise<PublicReceipt>`；verifier 在进程外或固定 broker 中执行；恢复用固定 `operationId` 查询/验证同一 snapshot | `VerifyRequest`、`PublicReceipt` 都未定义；恢复时如何判断 receipt 属于同一 submission 未冻结 |
| §20 | C-02、C-03、C-11 必须分别形成可审查证据 | 没有 receipt/manifest schema，C-02 无法证明外部验收；C-03 无法证明 no-submission 与 fresh retry 的证据形状；C-11 无法证明 manifest/receipt 的 CAS 身份和幂等重放 |

结论：当前冻结协议已经规定了验收所有权和“必须具备哪些检查”，但没有冻结 receipt 与 manifest 的数据形状。继续实现只能靠实现约定补字段，违反 AGENTS.md §1 与 §23.2。

## 2. 最小复现与失败场景

| # | 场景 | 失败方式 |
|---:|---|---|
| 1 | verifier 进程 exit=0，但 receipt 没有 criteria 或缺少一条 required criterion | 若 host 用 exit code 判定，Run 被错误标为 `verified`；批准包必须拒绝为 `invalid` |
| 2 | verifier 进程 exit=0，但 receipt 的 required criterion 为 `fail` | exit=0 不能覆盖领域失败；批准包必须为 `failed`，不能为 `verified` |
| 3 | 所有 required criterion 为 `pass`，但 verifier 超时、被信号终止或 exit code 非 0 | 不能为 `verified`；批准包按 `invalid` 结算，timeout 不得伪造成 signal |
| 4 | score 为 `NaN`/`Infinity`、metric 缺 unit、`invalid` criterion 携带分数、或出现非 required criterion | 若用自由 JSON，会被接受并进入比较；批准包必须拒绝 receipt 或按 `invalid` 结算 |
| 5 | receipt 的 provider/operationId/contract/input/output digest 与当前 submission 不一致 | 别的 Run 的 receipt 被复用；批准包必须按 `invalid` 拒绝，不能补写 closure |
| 6 | 两个 host 对同一 logical outputs 采用不同顺序或不同 path 表示 | 产生不同 manifest digest，`run/submitted.outputs` 身份不一致；C-11 幂等/恢复分叉 |
| 7 | required output 缺失、path 是 symlink、tree 内含 symlink 或超出部署 size cap | 若只 hash 跟随后的 bytes，可能冻结 workspace 外内容或不可复现内容；批准包必须在 manifest/fact 前拒绝 submit |
| 8 | no-submission/stop 的 Run 被伪造一个 receipt 以统一数据外观 | 违反 §9.2：没有提交的 failed Run 可以有 ExecutionRecord，但没有 acceptance receipt；C-03 失败 |
| 9 | public receipt 的 reason/metric 含隐藏用例答案、fixture 路径或 private verifier recipe | private 数据泄漏给 worker/RSI；C-14/C-18 的隔离边界被破坏 |
| 10 | 同一 commandId 重放 submit 时重新冻结/重新验证并生成不同 manifest/receipt | 同命令产生第二结果，违反一 command 一 fact 与 C-11 幂等 |
| 11 | verifier 超时被写成 `signal='timeout'` 或 `code=-1` | timeout 与真实进程退出/信号混淆，无法区分基础设施 invalid 和领域 failed；批准包要求独立 `timedOut` |
| 12 | `Evidence.inputs` 记录 direct child outputs，但 verifier 只收到初始 inputs | 验收与证据看到不同 snapshot；批准包要求两者由同一授权输入 snapshot 派生 |

## 3. 为什么现有扩展点不足

- **不能把字段加进 `TaskContract`、`Evidence` 或 `ExecutionRecord`**：这些是冻结业务对象；加字段会改变 contract/evidence digest、seal 语义和已有 consumer。receipt/manifest 是 CAS 数据，不是新的业务 authority。
- **不能把 receipt 内联进 fact**：§10.2 明确大对象存 CAS、fact 只引用；`run/submitted.outputs` 和 `run/closed.evidenceRef` 已经分别为 manifest 和 Evidence 留出 ref。内联会扩大 journal、破坏重放和 13 fact 闭合集。
- **不能只靠 `ObjectRef`**：`{ id, digest }` 不表达 provider、operationId、criterion verdict、metric/unit、finite score、exit/timedOut，也不表达 output declaration 的 id/path/kind/role/required。实现只能各自猜字段，无法形成 C-02/C-11 的一致证据。
- **不能复用 `ExecutionRecord` 承载 acceptance**：它的语义是 no-submission/stop/cancel/基础设施异常，可缺 verification/outputs；把 receipt 塞进去会让“没有验收”的 Run 看起来像“已验收”，直接违反 C-03。
- **不能新增 fact type、receipt 表或 check 账本**：会突破 13 fact、1 journal、1 fold、1 writer、1 wake authority 的预算，并形成第二账本。
- **不能新增 `receipt`/`acceptance`/`submission` digest domain**：现有 `object` domain 已覆盖 CAS 原始 bytes/结构化对象；新增 domain 会扩张 §4.0 的 9 个 domain，且没有消费者需要新的哈希前缀。
- **不能把 manifest 简化为路径列表**：路径不证明冻结内容、排序、kind/role/required，也不证明 required output 存在；C-02 无法验证提交快照。
- **不能把 verifier 自报的总 verdict 当作权威**：`verified`/`failed`/`invalid` 必须由 host 根据 strict receipt、冻结合同、`timedOut` 和 raw exit status 派生；否则模型/verifier 可以通过缺 criterion 或 exit=0 弱化验收。

## 4. 批准包（已批准并纳入）

### A0. `AcceptanceRef` = `object` domain

已批准的冻结语义：

- `TaskContract.acceptance: AcceptanceRef` 的线形保持 `{ id, digest }` 不变。
- 在 §4.0 的 ref 映射中把 `AcceptanceRef`（`contract.acceptance`、`DomainAdapter.resolveAcceptance` 的返回）映射到 **`object` domain**；对象是冻结的 acceptance policy/provider identity。
- `PublicReceipt.provider: AssetRef` 使用 `object` domain，并必须与 host 从冻结合同解析出的 acceptance provider、`Evidence.verification.provider` 在 `id` 和 `digest` 上完全相等。
- 未采用：新增 `acceptance` domain（9 → 10）、复用 `evidence` domain（会与 EvidenceRef 混淆）、复用 `method` domain（acceptance 不是 Method revision）。

这是对 K3 “未列出的 ref 不猜默认 domain，直到 amendment 补充”的补充，不改变 K3 的规则本身。

### A1. `PublicReceipt` schema

```ts
interface PublicReceipt {
  readonly v: 1
  readonly provider: AssetRef
  readonly operationId: string
  readonly contractDigest: Digest
  readonly inputDigests: readonly Digest[]
  readonly outputDigests: readonly Digest[]
  readonly criteria: readonly PublicCriterionResult[]
  readonly exit: PublicExitStatus
  readonly timedOut: boolean
  readonly digest: Digest // object domain；最外层 CAS seal
}

interface PublicCriterionResult {
  readonly id: string
  readonly verdict: 'pass' | 'fail' | 'invalid'
  readonly reason: string
  readonly metric?: {
    readonly name: string
    readonly unit: string
    readonly value: number // finite number
  }
  readonly score?: number // finite number；必须伴随 metric
}

interface PublicExitStatus {
  readonly code: number | null // 进程退出码；signal 终止时为 null
  readonly signal: string | null // 原始 signal 名；正常退出时为 null
}
```

严格规则：

1. `v` 只允许 `1`；未知字段、未知版本、缺字段拒绝。
2. `provider` 使用 `object` domain，且与 A0 解析出的 acceptance provider、`Evidence.verification.provider` 完全相等。
3. `operationId` 非空，必须等于 verifier request 的 operationId 和 `Evidence.verification.operationId`；批准值 `runId + ':verify'`。同一 Run 的恢复/重放不得重新生成；新 Run 使用新的 `runId + ':verify'`。
4. `contractDigest` 必须等于冻结 `TaskContract.digest` 和 `Evidence.contractDigest`。
5. `inputDigests` 是 verifier 授权输入 `ObjectRef` 的 digest 有序数组；必须与 `Evidence.inputs[].digest` 逐位相等。verifier 授权输入包含冻结合同输入和已授权的 direct child outputs；`Evidence.inputs` 必须由同一 snapshot 派生，不得额外加入未给 verifier 的审计输入。`outputDigests` 是从 `SubmissionManifest` 派生给 verifier 的冻结输出 `ObjectRef` 的 digest 有序数组，必须与 `Evidence.outputs[].digest` 逐位相等。不排序、不去重、不补默认值。
6. `criteria` 的 ID 集合必须恰好等于 `TaskSpec.criteria` 中 `required=true` 的 ID 集合；每条恰好一次；缺项、重复、未知 ID、非 required criterion 均拒绝。空 required set 是否允许准入由既有 admission policy 决定；本 amendment 不新增“空 criterion 自动 verified”的放宽。
7. `reason` 对所有 verdict 必填且必须是公开可读文本；不得包含隐藏用例答案、fixture 内部路径、golden data 或 private verifier recipe。
8. `metric`/`score` 只允许出现在 `pass`/`fail` criterion；`invalid` criterion 不得携带 `metric` 或 `score`。`metric.name`/`metric.unit` 非空，`metric.value` 与 `score` 必须是有限 number（拒绝 `NaN`、`Infinity`、字符串和超出 JSON 数值模型的输入）。`score` 必须同时出现 `metric`。
9. `exit` 是原始进程终止状态：`code` 为整数或 `null`，`signal` 为字符串或 `null`；对实际产生终止状态且未超时的进程，恰好一个非 `null`。`signal` 只记录真实 signal，不能用来表达 timeout。两者都为 `null` 且 `timedOut=false` 使 receipt 无效。
10. `timedOut` 是必填 boolean，独立于 `exit`。`timedOut=true` 表示 verifier 超时；此时 `exit` 可以是 `{ code: null, signal: null }` 或强制终止后的原始状态，但 host 必须按 `invalid` 结算，不得用 signal 模拟 timeout。
11. receipt 不包含 `at`/`asOf`/随机 ID/agent ID/usage；这些要么属于 Evidence/DSH 记录，要么会破坏内容寻址和 C-11 幂等。
12. `digest` 是 `object` domain 的最外层 seal，不是新的业务字段；`PublicReceipt` 本身不是 Evidence，host 把它放入 `Evidence.verification.publicReceipt` 后才形成验收证据。
13. receipt 不设总 verdict 字段；`verified`/`failed`/`invalid` 只由 host 按 A2 派生，避免 verifier 用总 verdict 绕过逐 criterion 校验。

### A2. Host 分类、exit 与 timeout

| 条件 | host 结果 |
|---|---|
| receipt strict 有效；provider/operationId/contract/input/output digest 全匹配；required criteria 恰好一次且全部 `pass`；`timedOut=false`；`exit={code:0, signal:null}` | `verified` |
| receipt strict 有效；身份/digest 匹配；至少一条 required criterion 为 `fail`；没有 required criterion 为 `invalid`；`timedOut=false`；`exit.code` 非 null 且 `signal=null` | `failed`；exit code 可以是 0 或非 0，exit=0 不能覆盖 fail |
| 任一 required criterion 为 `invalid`；或 `timedOut=true`；或 `signal` 非 null；或 `exit` 两者皆 null 且未超时；或 receipt 缺失/畸形；或 provider/operationId/digest 不匹配；或 criteria 缺失/重复/未知/非 required；或 metric/score 非有限；或 `invalid` 携带分数；或全部 pass 但 exit code 非 0 | `invalid` |
| 没有 submit（no-submission/stop/基础设施终结） | 走 `ExecutionRecord`；不需要 acceptance receipt，也不因“没有 receipt”判 `invalid` |

- **exit=0 是 verified 的必要但不充分条件**：它只有在 receipt 完整、身份/digest 匹配、required criteria 全部 pass、`timedOut=false` 且 `signal=null` 时才成立。
- **exit=0 不能把 fail 变成 verified**；**非 0 exit 也不能单独决定 failed**：有完整 fail receipt 且进程未超时/未被信号终止时为 `failed`，receipt 不完整/全部 pass 却非 0 时为 `invalid`。
- `timedOut=true` 是基础设施/超时 invalid，不是领域 failed，不给领域分数；不得用 `signal` 或特殊 exit code 代替。
- `invalid` receipt 仅作诊断：不得 seal Evidence，也不得扩展 `ExecutionRecord` 来引用它；closure 使用现有 `ExecutionRecord(invalid)`。
- `failed` 可以有有限失败分；`verified` 可以携带 metric/score 作为公开测量，但不能由模型自报；`invalid` 没有领域分数。

### A3. `SubmissionManifest` schema

```ts
interface SubmissionManifest {
  readonly v: 1
  readonly taskId: string
  readonly runId: string
  readonly contractDigest: Digest
  readonly includeLearningDrafts: boolean
  readonly outputs: readonly SubmittedOutput[]
  readonly learningDrafts: readonly SubmittedLearningDraft[]
  readonly checks: readonly SubmissionCheck[]
  readonly digest: Digest // object domain；最外层 CAS seal
}

interface SubmittedOutput {
  readonly id: string
  readonly path: string
  readonly kind: 'file' | 'tree'
  readonly role: 'deliverable' | 'supporting'
  readonly required: boolean
  readonly object?: ObjectRef // required=true 时必填；可选输出未冻结时可缺
}

interface SubmittedLearningDraft {
  readonly id: '__skill-drafts' | '__mcp-drafts'
  readonly path: 'learning-drafts/skills' | 'learning-drafts/mcp-servers'
  readonly kind: 'tree'
  readonly role: 'skill-draft' | 'mcp-draft'
  readonly required: false
  readonly object: ObjectRef
}

interface SubmissionCheck {
  readonly outputId: string
  readonly bytes: number // 非负安全整数；file 为文件 bytes，tree 为总 bytes
  readonly symlinks: 'none' // host 在冻结前完成 no-follow 遍历的断言
}
```

严格规则：

1. `v` 只允许 `1`；未知字段、未知版本拒绝。
2. `taskId`、`runId`、`contractDigest` 必须与当前 open/submitted 的 Run 和冻结合同一致；不得由模型或 submit 参数提供。
3. `outputs` 包含 `TaskSpec.outputs` 中所有非 draft 输出（`role` 为 `deliverable` 或 `supporting`），顺序严格等于合同声明顺序；不得按 id/path 排序。每个 output 的 `id`/`path`/`kind`/`role`/`required` 原样来自冻结合同；id 与 path 均唯一。
4. `required=true` 必须有 `object`；可选 supporting 输出未产生时可以没有 `object`，且不得成为 acceptance 依据。
5. `learningDrafts` 是必填数组，不是 optional 字段。没有冻结 draft 目录时为空数组；有目录时只允许固定 `__skill-drafts`（skill 在前）与 `__mcp-drafts`（MCP 在后），各项必须 `kind='tree'`、`required=false` 且带 `object`。`learningDrafts` 中的 id/path 不得与 `outputs` 重叠。
6. `includeLearningDrafts` 是必填 boolean。`false` 时 `learningDrafts` 必须为空；`true` 时按实际存在的目录冻结，目录缺失不失败、对应数组为空或只含存在项。
7. `checks` 是必填数组，不是 optional 字段。每个已冻结输出（`outputs` 中带 `object` 的项，加上 `learningDrafts` 的项）各提供恰好一条，`outputId` 唯一；顺序先按 `outputs` 合同顺序，再按 `learningDrafts` 固定顺序。未冻结的可选输出没有 check 条目；没有冻结输出时 `checks=[]`。
8. `bytes` 是非负安全整数；`symlinks: 'none'` 表示 host 在冻结前对 file 本体和 tree 每个节点做了 no-follow 检查，未发现 symlink。它不是对 CAS bytes 的密码学证明，见 A5。
9. manifest 不包含 `at`/`asOf`/随机 ID/agent ID/私有 receipt/validation payload；同样是为了内容寻址和 C-11 幂等。
10. `digest` 是 `object` domain 的最外层 seal；`run/submitted.outputs` 引用该 manifest 的 `ObjectRef`，`singularity_submit` 返回的 `submissionRef` 也指向同一 ref。manifest 不是新的 fact，也不是第二账本。

### A4. 稳定排序与 `Evidence.inputs`

- 非 draft `outputs`：严格按 `TaskSpec.outputs` 中非 draft 项的声明顺序；base 与 local supporting 的相对顺序不得改变。两个 draft 声明不进入 `outputs`，而是按固定 skill → MCP 顺序进入 `learningDrafts`；这不是对合同声明顺序的重新排序，因为 draft 在合同中本来就固定在最后。
- `learningDrafts`：固定 skill 在前、MCP 在后；无目录时为空数组。
- `checks`：先按 `outputs` 中有 `object` 的项，再按 `learningDrafts` 顺序；无冻结输出时为空数组。
- `PublicReceipt.inputDigests`：按 verifier 授权输入顺序，包含冻结合同输入和已授权的 direct child outputs；`Evidence.inputs` 必须由同一 snapshot 派生并逐位一致。
- `PublicReceipt.outputDigests`：按 manifest 派生给 verifier 的冻结输出顺序（`outputs` 中有 object 的项，再按 `learningDrafts`）；`Evidence.outputs` 必须逐位一致。
- 数组顺序是 JCS/digest 的一部分；同一组文件但顺序不同必须产生不同 manifest digest，并按身份不匹配拒绝，不能静默排序后接受。
- 所有 schema 不包含时间戳或随机值；同一合同、同一冻结 bytes、同一顺序应产生同一 manifest/receipt digest。

### A5. Symlink / size 检查证据边界

Host 在写 manifest 和 `run/submitted` 之前必须完成：

1. 声明的 `path` 必须是 workspace 内相对路径，规范化后不得为绝对路径、不得含 `..`、不得命中保留 draft ID/path。
2. 对 `file` 使用 no-follow `lstat`，必须是普通文件；对 `tree` 递归 no-follow 遍历，拒绝 symlink、socket、device、FIFO 等非普通文件/目录节点。hardlink 是否拒绝由部署 policy 决定，不由 manifest digest 证明。
3. 按部署 policy 检查 size cap；框架当前没有冻结 output size 上限，本 amendment 不新增协议级 limit，也不在 manifest 中写 cap/policy。`checks.bytes` 只记录冻结时观测到的总 bytes。
4. 先在 workspace 中检查，再把 bytes 写入 CAS，重读并校验 object digest；manifest 只在所有 required 输出成功冻结后写入。
5. 冻结后 verifier 只读 CAS，不回读活动 workspace；因此 workspace 在冻结后的变化不能改变本次 submission。

证据边界：

- manifest digest 能证明 manifest 内容（包括 `checks`、refs、声明顺序）未被篡改，也能通过 object ref 重验冻结 bytes。
- `checks.symlinks='none'` 和 `bytes` 是 **host 写入的断言**，不是密码学证明；digest 不能证明 host 真的执行了正确遍历，也不能证明 traversal 与 freeze 之间没有 TOCTOU。可信度来自单一 trusted writer 和冻结前检查，不来自哈希本身。
- 批准包把检查结果放进 manifest 的 required `checks`，不另立 check receipt/账本。若未来需要独立检查 receipt，必须另提 amendment；当前把它作为替代实现会与批准包不兼容。
- 缺失 required output、symlink、越界 path 或 size 超限必须在 manifest/fact 之前拒绝 submit；已写入但未被 fact 引用的 CAS 对象是 orphan，不是业务成功。

### A6. Object / evidence digest domain

| 对象或字段 | 批准 domain | 规则 |
|---|---|---|
| `AcceptanceRef`（`contract.acceptance`） | `object` | A0；与 `AssetRef` 一致，不新增 domain |
| `PublicReceipt.digest` | `object` | receipt 是 CAS 数据对象，不是 Evidence |
| `PublicReceipt.provider` | `object` | `AssetRef`；A0 解析出的 acceptance provider |
| `PublicReceipt.inputDigests` / `outputDigests` | 既有 object digest 值 | 只保存被引用 CAS 对象的 digest，不新增 domain |
| `SubmissionManifest.digest` | `object` | manifest 是 CAS 数据对象 |
| `SubmissionManifest.outputs[].object` / `learningDrafts[].object` | `object` | 冻结输出 bytes 的 ObjectRef |
| `run/submitted.outputs` | `object` | 已冻结的 manifest ObjectRef |
| `Evidence.digest` | `evidence` | 保持现有 Evidence domain |
| `Evidence.verification.publicReceipt` / `privateReceipt` | `object` | ObjectRef；receipt 不得冒充 EvidenceRef |
| `ExecutionRecord.digest` | `object` | 保持现有 supporting object domain |

- domain 集合保持 §4.0 的 9 个，不新增 `receipt`、`submission` 或 `acceptance` domain。
- 不得用 `evidence` domain 计算 receipt/manifest；否则 `verifyDigest('evidence', receipt)` 可能与 EvidenceRef 混淆，破坏“ExecutionRecord 不得冒充 Evidence”的边界。
- digest 匹配不是读取授权；receipt/manifest 的读取仍受 §12.3/§17.2 scope 限制。

### A7. `privateReceipt` 隔离

- `privateReceipt` 只作为 `Evidence.verification.privateReceipt?: ObjectRef` 存在；不进入 `PublicReceipt`、`SubmissionManifest`、fact、NodeView、ProposerView、模型输出、feedback refs 或 submit 结果。
- `PublicReceipt.reason`/`metric`/`score` 必须是公开安全内容；隐藏用例、答案、golden data、private fixture 路径和 private verifier recipe 只能留在 private receipt 或受权 evaluator/verifier scope。
- `privateReceipt` 保持 opaque CAS object，本 amendment 不冻结其 schema；若以后需要跨实现校验，另提 amendment。
- host 在生成 public receipt、feedback、祖先查询、RSI trace 和 direct child 结果时必须过滤 private refs；digest 相等不等于读取授权。
- 一个 Run 可以只有 public receipt 而没有 private receipt；`privateReceipt` 缺失不是失败。

### A8. `ExecutionRecord` 与 invalid receipt

- no-submission、显式 stop、基础设施 invalid、cancelled：使用 `ExecutionRecord`，保留 taskId/runId/contractDigest/method/composition/inputs/usage/sessionCut/reason，可缺 outputs/verification；它不能被冒充成 verified Evidence。
- 没有提交的失败 Run 可以有 ExecutionRecord，但没有 acceptance receipt；不得为了统一数据外观伪造 `PublicReceipt`。
- `run/closed` 仍恰好引用一个结果：`verified`/带 Evidence 的 criteria-failed `failed` 用 `evidenceRef`；no-submission/stop/invalid/cancelled 用 `executionRecordRef`。该事实字段不因本 amendment 改变。
- 已 submit 但 verifier 超时、基础设施失败或返回含 `invalid` criterion 的 receipt 时：host 按 `invalid` 结算，使用现有 `ExecutionRecord(invalid)`；invalid receipt 仅可作为 operator 诊断留存，不得写入 Evidence，也不得扩展 `ExecutionRecord` 增加 receipt 字段，不进入 NodeView/ProposerView/公开 trace。
- C-03 的 fresh retry 使用新 Run/session/workspace，合同与 Method 不变；旧 receipt/manifest 不复制、不覆盖、不自动成为新 Run 的验收结果。新 Run 只有重新 submit 并重新验收才可能 verified。

### A9. C-02 / C-03 / C-11 影响

#### C-02 one Run submit and external receipt

已批准语义下，C-02 的完整链路为：

```text
submit(outputIds, includeLearningDrafts)
  → validate Run/self-read/PlanningSketch/no active batch/required winners
  → validate declared paths, symlinks, size, required outputs
  → freeze output bytes into CAS
  → build SubmissionManifest (includeLearningDrafts + outputs + learningDrafts + checks)
  → append run/submitted with outputs = manifestRef
  → external verifier on the same authorized input/output CAS snapshot with stable operationId
  → PublicReceipt (criteria, metric/score, exit, timedOut)
  → host validates receipt identity/digests/criteria/exit/timedOut
  → all required pass + timedOut=false + exit code 0: seal Evidence → run/closed(verified)
  → at least one fail, none invalid, timedOut=false, code non-null: seal Evidence → run/closed(failed)
  → any invalid / timedOut / signal / receipt invalid: ExecutionRecord → run/closed(invalid)
```

C-02 证据必须能证明：模型只提供 output IDs 和 draft flag，不提供 verdict/score/ref/role/required/timedOut；manifest 与 receipt 都绑定同一冻结合同、同一授权输入 snapshot（含 direct child outputs）和同一输出 snapshot；exit=0 不能单独产生 verified；外部 verifier 只读 CAS；invalid receipt 不是 acceptance Evidence。

#### C-03 no-submission and fresh retry

- no-submission/stop/cancelled 不生成 SubmissionManifest 或 PublicReceipt；走 ExecutionRecord。
- 已 submit 但 verifier 超时/基础设施失败时，provider 可能返回一个含 `invalid` criterion 的 receipt 对象；该对象不是 acceptance Evidence，不产生领域分数，closure 用 ExecutionRecord(invalid)，且不扩展 ExecutionRecord。
- 对 no-submission/stop/cancelled，缺 receipt 是定义行为，不是 `invalid` 的新理由；不得把缺 receipt 填成 fail/零分。
- retry 创建新 Run/session/workspace，复用同一合同/Method，但重新 submit、重新冻结 manifest、重新生成 receipt；旧对象保持不可变。
- C-03 证据必须覆盖“没有 submit 就没有 receipt”“timeout 不伪造成 signal”“新 Run 不复用旧 verdict”。

#### C-11 journal replay / torn tail / command idempotency

- `PublicReceipt` 与 `SubmissionManifest` 都是 CAS 对象；host 先写对象，再 append 引用它们的 fact。它们不新增 journal 行、不新增 fact type、不新增 writer。
- 同一 commandId + commandDigest 重放时返回原 `Fact` 及其原 manifest/receipt refs，不重新冻结、不重新验证、不追加 fact。
- verifier 已完成但 closure 未写时，用固定 `operationId` 和 receipt 身份恢复：身份/digest 可核对则补写 closure；不可核对或超时则 `invalid`，不盲目重复有外部副作用的调用。
- manifest/receipt 的稳定排序、无时间戳和独立 `timedOut` 使同一提交在重放/重启后产生相同 digest；不同顺序或不同 refs 必须产生不同 digest 并按身份不匹配拒绝。
- `seq`/`prev`/`commandDigest`/torn-tail 规则不变；S3-A 已记录的“CAS 引用内容 domain-aware replay 校验仍未实现”仍是后续 runtime/reducer 工作，本 amendment 不声称已补上。

## 5. 权限、预算与复杂度影响

| 维度 | 影响 |
|---|---|
| authority | 仍 5：Task、Run、Evidence、Method、RsiRound；receipt/manifest 是 CAS 数据，不是 authority |
| journal / fold / writer / wake | 仍各 1；不新增 registry、transcript mirror、model loop 或自动 loop |
| fact 类型 | 仍 13；不新增 fact；`run/submitted.outputs` 和 `run/closed.evidenceRef` 继续是 ref |
| digest domain | 仍 9；receipt/manifest 使用 `object`；Evidence 使用 `evidence`；A0 也复用 `object` |
| 模型可见性 | submit 输入仍是 outputIds + includeLearningDrafts；模型不能提供 provider/operationId/verdict/score/metric/path/role/required/object ref/digest/timedOut；privateReceipt 不进入模型视图 |
| 验收权限 | root acceptance 仍由 operator/domain 拥有；verifier 在进程外或固定 broker 执行；host 校验 receipt，不把模型自述或 exit code 当验收 |
| 预算 | 不新增模型请求、token、step 或自动 loop；verifier 调用是既有领域验收；manifest/receipt 大小受 criteria/outputs 数量约束；hash/size 检查是 host CPU/IO，精确值不进入模型 prompt |
| 复杂度 | 增加两个 strict CAS schema、required checks 和 host 校验；不增加第二账本、第二 writer、第二 fold、持久 command 表或新错误码 |

## 6. 兼容性、K 系列不变性与明确不兼容清单

### 6.1 K1–K6 不变

| 既有语义 | 本 amendment 影响 |
|---|---|
| K1 `Fact.commandDigest` + `command` domain；一 command 一 fact | 不变；receipt/manifest 不新增 command 或 fact |
| K2 journal `seq=0`、JCS NDJSON/LF、epoch ms、deadline exclusive | 不变；receipt/manifest 不改变 journal framing |
| K3 ref domain 映射 | 规则不变；A0 用既有 `object` domain 补充 `AcceptanceRef` 映射，不重排/新增 domain |
| K4 output 合并 `base → local → __skill-drafts → __mcp-drafts` | 不变；manifest 只在提交对象中分离非 draft 与 draft，不改变 TaskContract 的合并/顺序 |
| K5 13 种 fact payload 与 `run/closed` 恰一 result ref | 不变；不新增 fact 字段 |
| K6 conformance 证据规则 | 不变；C-02/C-03/C-11 继续 `unproven` |

### 6.2 明确不兼容清单

以下不是“实现选择”，而是与已批准语义不兼容；实现必须修正，不能静默兼容：

- **A0**：任何已按未列 domain 或其他 domain 计算/落盘的 `AcceptanceRef` 或含该 ref 的 `TaskContract` 不兼容；必须重新 seal。当前无生产数据。
- **Receipt 总 verdict**：接收 verifier 自报 `outcome`/`classification` 或依赖该字段决定 `verified`/`failed`/`invalid` 的实现不兼容。
- **Digest 列表**：使用聚合 digest、排序后数组、去重或补默认值的 receipt 不兼容；`inputDigests`/`outputDigests` 必须与授权输入/冻结输出逐位一致。
- **Evidence.inputs**：`Evidence.inputs` 含未给 verifier 的 audit-only 输入，或 verifier 只收到初始输入而 `Evidence.inputs` 记录 direct child outputs 的实现不兼容；两者必须由同一授权 snapshot 派生。
- **Criterion 可选项**：`pass`/`invalid` 缺 `reason`、`invalid` 携带 `metric`/`score`、`score` 不带 `metric`、或 receipt 含非 required criterion 的实现不兼容。
- **Timeout**：用 `signal`、特殊 `code` 或字符串原因模拟 timeout 的实现不兼容；必须使用独立 `timedOut: boolean`，且 timeout 结算为 `invalid`。
- **Manifest 可选性**：把 `includeLearningDrafts`、`learningDrafts` 或 `checks` 当 optional/缺省字段，或在缺少 draft 目录时省略 `learningDrafts` 而不是空数组的实现不兼容。
- **Check 账本**：把 symlink/size 检查放到 manifest 之外另立 check receipt/账本，或不写 required `checks` 的实现不兼容。
- **Size cap**：把 output size cap 写成协议字段/冻结 limit 的实现不兼容；cap 属于部署 policy，manifest 只记录实际 bytes。
- **Invalid receipt**：把 invalid receipt 写入 Evidence、扩展 `ExecutionRecord` 增加 receipt ref、或让 invalid 产生领域分数的实现不兼容；invalid receipt 仅诊断。
- **PrivateReceipt**：冻结 privateReceipt schema 或把它暴露给 worker/RSI/模型/feedback 的实现不兼容。
- **Conformance**：把 C-02/C-03/C-11 或任何场景因本 amendment 改为 `proven` 的实现不兼容；本 amendment 不提供实现证据。
- **文档状态**：`README.md` 与 `docs/build-plan.md` 已在本变更同步，声明 S3-B1 schema 进行中、S3-B 执行未开始；继续把它们描述为 Q1–Q11 待决定或“规范阻断”属于不兼容的旧文档。

## 7. Conformance 不变与证据边界

- 本变更只更新 `docs/conformance.md` 的 amendment 链接和验收/提交/重放证据边界，不把任何场景改为 `proven`。
- C-02/C-03/C-11 的实现证据必须覆盖 A0–A9；C-18（missing/invalid evidence is insufficient, not zero）复用“invalid 无领域分数、不得填零”的边界。
- 真实证据出现前，C-02/C-03/C-11 及相关场景继续保持 `unproven`。`pnpm verify`、静态 schema 通过或文档 digest 一致不能替代真实 DSH/真实模型/领域验收证据。
- 本 amendment 不实现、不跑 conformance；批准不等于实现或验证。

## 8. 用户确认记录

| 项目 | 内容 |
|---|---|
| 状态 | **已批准并纳入正式规范；实现与 conformance 证据待后续** |
| 确认人 | 用户 |
| 确认日期 | 2026-10-30 |
| 用户原话 | “全部确定，以后不需要向我确认任何事，自行推进” |
| 批准范围 | amendment 002 A0–A9 整体包 |
| 本文件效力 | 已批准 amendment；A0–A9 已并入 `docs/framework.md`；框架为唯一规范权威 |
| 规范/spec-lock/conformance 修改 | 同一变更已更新 framework、spec-lock、conformance 链接、README 与 build-plan；conformance 全部保持 `unproven` |
| 代码/构建修改 | 无；本变更不修改源码 |
| 实现许可 | 已授予后续实现；实现仍需独立测试与证据，不得把规范纳入写成功能完成 |

## 9. Q1–Q11 收敛与批准记录

### 9.1 批准映射

| 原问题 | 批准值 |
|---|---|
| Q1 `AcceptanceRef` domain | `AcceptanceRef = object`；`provider` 与冻结 acceptance provider/Evidence provider id+digest 相等 |
| Q2 receipt 总 verdict | 不设总 verdict；host 从 required criteria + exit + `timedOut` 派生 `verified`/`failed`/`invalid` |
| Q3 input/output digest | 有序数组；`Evidence.inputs` 与 verifier 授权输入一致（含 direct child outputs），`Evidence.outputs` 与冻结输出一致 |
| Q4 criterion 可选项 | `reason` 全 verdict 必填；`metric`/`score` 仅 pass/fail；`score` 必须伴随 `metric`；非 required criterion 拒绝 |
| Q5 exit/timeout | `exit={code,signal}`；未超时的实际终止状态恰一个非 null；timeout 用独立 `timedOut:boolean`，不模拟 signal |
| Q6 manifest 拆分 | `outputs` 只含非 draft；`learningDrafts` 独立且必填数组 |
| Q7 learning drafts | `includeLearningDrafts` 必填；缺目录时 `learningDrafts=[]`，不失败 |
| Q8 checks | `checks` 为 manifest required 字段，保存 `bytes`/`symlinks:'none'`；size cap 属部署 policy |
| Q9 privateReceipt | 保持 opaque `ObjectRef`，不冻结 schema、不暴露给模型 |
| Q10 conformance | 不改变任何状态；C-02/C-03/C-11 保持 `unproven` |
| Q11 invalid receipt | 仅 operator 诊断；不写 Evidence、不扩 `ExecutionRecord`、不进入公开 trace |

### 9.2 批准结果与后续

用户已批准上述整体包，A0–A9 已按同一变更纳入 `docs/framework.md`、`spec-lock.json`、`docs/conformance.md`、`README.md` 与 `docs/build-plan.md`。Q1–Q11 已由该单一批准决定收敛，不再需要逐项确认，也不再存在“待确认/规范阻断”状态。

后续实现必须：

1. 在 protocol 中实现 `AcceptanceRef=object`、`PublicReceipt`/`SubmissionManifest` strict schema、校验和负例，并先建立失败证据；
2. 在 runtime/DSH 集成中实现 host 分类、digest 顺序、`exit`/`timedOut`、`checks`、`privateReceipt` 过滤和 invalid receipt 仅诊断，但不新增 fact/domain/writer/fold；
3. 用真实 DSH、真实模型和领域验收证据推进 C-02/C-03/C-11；在证据出现前保持 `unproven`；
4. 不把 schema 类型、`pnpm verify`、fixture pass 或文档 digest 一致表述为功能完成或领域收益。

## 10. 本次纳入的验证与未覆盖项

- 实际运行：官方 Node `24.9.0`（`/tmp/node249/bin`）、pnpm `11.18.0`；独立 worktree、HOME 与 pnpm store；`pnpm install --frozen-lockfile`、根 `pnpm verify` 与 `git diff --check`。
- 根 `pnpm verify` 结果：protocol `189/189`、app `6/6`、runtime `30/30`（合计 `225`）通过；该结果只证明当前仓库门禁，不证明 receipt/manifest 已实现。
- 纳入后 `spec-lock.json` `sha256:5f33aa339f21496c375de637ef447656fc66d98d3054a5b6e0a1d3c8dc612b6f` 与实际 `docs/framework.md` 一致；任何进一步规范修改必须重新计算。
- 未覆盖：`PublicReceipt`/`SubmissionManifest` 的 protocol/runtime 实现与测试、真实 verifier/DSH/模型验收、C-02/C-03/C-11 的 `proven` 证据、runtime host 分类执行、privateReceipt 运行时过滤；这些仍是后续工作。

Q1–Q11 已由 2026-10-30 的单一批准决定收敛；后续只需按 §9.2 的实现清单推进，不再逐项确认，也不得把批准本身当作实现或 conformance 证据。
