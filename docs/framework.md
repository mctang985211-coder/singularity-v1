# Singularity 领域任务 RSI 框架与标准协议

版本：1.0 · 发布日期：2026-10-30（Asia/Shanghai）

**状态：V1 发布规范。本文是框架与协议的唯一权威；实现必须符合本文。**

本文从零定义框架。不继承 singularity-core、旧 Singularity、singularity-harness 或新 singularity 的接口和实现。旧研究只用于识别失败模式；DSH 安装包只用于核对宿主能力。

已由用户确认的基础决定：

- C1：只写全新规范，不采用现有实现。
- C2：首次调用某子模板的分解指令后，自动展示其预填写用例；模型确认阅读后才能准入。
- C3：没有 Method 指引时可用固定 explore-child 分解；新 skill/tool 先成为产物，由后续 RSI 注册。

本版本吸收 C1–C3、A–F 与已批准 amendment 001–013 的确认意见：多层 PlanningSketch 但只准创建 direct children；按需祖先查询；结构化 feedback 和 parent replan；原生 MCP server 工具；正向模型引导；模型侧百分比预算；可连续执行并提供有界公开反馈的 RSI Round；acceptance receipt 与 submission manifest 的 strict schema、host 分类和证据边界。其配套字段、状态、guard 和符合性场景在本文中一并冻结。

实现默认采用能完成当前任务的最短正常路径，直接组合 DSH 公开能力。内部复用已验证的类型、投影和结果；边界校验对应实际输入、合同、权限和验收。实现细节由施工者按现有职责完成；改变公开协议与 authority 时提出 amendment。模型/领域拒绝沿业务协议结束；宿主存储、会话、provider、资源或原生清理异常抛给调用方，结束本次进程尝试，不伪造业务 invalid。运行与隔离条件在启动前由操作者建立，见 §19.1。

---

## 0. 结论：保留预研究的经验，重新建立协议

不继续沿 singualrity_final 的具体五主体模型施工。保留以下研究结论：

1. Task 是责任和验收单位，Run 是一次尝试，DSH session 是运行载体。
2. DSH 完成消息和模型自述不构成领域验收。
3. 方法、输入、工具和 prompt composition 必须固定，才能解释 RSI 的变化来源。
4. prompt 增长、无提交、评测计划超过预算，是真实失败模式；增加状态机本身不能解决这些问题。
5. parent 只调度 direct children；模型可以建立 2–3 层 PlanningSketch 并按需查询祖先摘要，但不能创建或控制孙节点。
6. 不同候选的执行环境必须隔离，缺失证据不能被当作零分或通过。

不继承：五主体划分、既有 fact 数量、Graph/Workflow 实体、Campaign、默认 LLM review、旧 prompt、旧工具别名、旧日志兼容、历史状态记录。

本文规定的最小运行单位：

~~~text
固定协议层：Task + Run + Method + Evidence + 一个 RSI round 记录
宿主适配层：DSH agent composition + 有界 Task dispatch + verifier/workspace adapter
领域实现层：document / skill / MCP server / acceptance provider / case package
~~~

薄的判断不能只数状态机，也不能只数代码行。标准是：

- 每个事实只有一个作者；每种状态只有一个来源。
- 框架不包含领域名称、领域算法、EDA 选项或特定任务解法。
- Method 不包含调度代码、平台权限、verifier 或 production head 的写入能力。
- DSH 已提供的 loop、session、tool dispatch、skill loading、usage、compaction 均复用。
- 常规领域扩展只新增领域包或 Method 资产，不修改框架。
- Round 是可重复的协议单位；一次 source replay 可作为 smoke test，领域改进必须由领域声明的多 case、validation/holdout、质量和成本标准证明。连续 Round 不引入 Campaign authority。

## 1. 四个层与唯一写入路径

| 层 | 拥有 | 不拥有 |
|---|---|---|
| protocol/core | 业务对象、命令、事实、纯 reducer、guard、视图 | DSH、模型调用、工作目录、领域算法 |
| DSH adapter | agent 创建/同进程续接、scope、wake、MCP server 挂载、工具门禁、进程和预算协调 | Task 验收权威、Method 内容决策 |
| Method revision | 模板目录、模板局部指导、skill/tool 内容及绑定 | 平台 system card、scheduler、root 验收规则 |
| domain package | 文档、基础资源、MCP server、验收器、评测用例 | Task/Round 状态、fact writer、production head |

唯一领域写入路径：

~~~text
人/模型工具/运行时观察
    → trusted CommandContext（由宿主提供，不能从模型参数读取身份）
    → command guard(state, command, referenced frozen objects)
    → append 一个原子 fact
    → pure reduce
    → NodeView / task tree / RoundView
    → 当前进程按已提交事实派发后续工作
~~~

DSH session log 保存对话和工具轨迹；Singularity journal 保存领域事实。两者不互相复制。journal 通过 sessionId + 日志区间引用原轨迹。

首版采用一个 project process 独占执行根目录。领域事实保存在 SQLite events 表，journal 一词仅表示领域事实序列；DSH 独自持久化 session。并发模型命令经唯一 CommandService 串行提交；业务 guard 与 fact 写入处于同一事务。不构建分布式日志或多 writer 共识。进程退出后该目录仅供归档读取，下一次执行使用新目录。

## 2. DSH 0.2.2-alpha.2 边界

本规范绑定确切版本，不以旧版本补丁为前提。核对依据是本机安装包中的类型声明，不能把旧研究中的 API 假设当作当前事实。本机 dsh/agent/tools/skill/system-prompt 包均为 0.2.2-alpha.2；dsh 声明 Node >=24.9.0，实现环境须满足这个宿主要求。

| 已核对的 DSH 能力 | 接入方式 | 本规范增加的语义 |
|---|---|---|
| agents.create / agents.resume，带 setup | 创建 scoped AgentHandle；resume 仅用于当前进程已 yield 的父 Run | 每个 Run 对应一个明确 sessionId |
| setup 在 agent 发布前装配 scope | 注册 prompt、tools、skills、listeners | 第一模型请求前完成冻结能力装配 |
| agent.followup / inject / whenIdle / cancel | 唤醒、提供上下文、等待静止、取消 | Task 等待和结算不得从 idle 自动推断 |
| systemPrompt.section / context | 固定规则、局部 guidance、动态数据分别贡献 | NodeView 用 required context，避免常驻系统指令重复 |
| tools.register(def, { when }) / restrict / guard、DSH MCP client | 动态可见性、MCP server 挂载、工具筛选 | MCP server 及其工具调用都必须有 guard，不能仅靠 restrict |
| SkillRegistry.register / list / get | task scope 资产按需加载 | 普通层只暴露绑定资产；探索层暴露冻结 global snapshot |

需要特别区分：

- tools.restrict 不会自动限制当前 scope 自己注册的工具；adapter 只能挂载获准的完整 MCP server，并为 server 及其工具调用加 guard。Method 不重新实现 MCP transport。
- DSH skill registry 原生负责 scoped 注册、发现和读取。启动时固定 profile：只启用原生 registry/skill tool，不挂载任意 filesystem/global provider，不在执行中修改共享 registry；公开全局资源先冻结再注册到当前 Agent scope。运行时直接注册冻结 skills，读取入口按绑定 ID 分发，不重复核验 registry 返回的 provider/source/content/path。
- tool description、tool 专属 prompt、MCP server 提示都可能增加 prompt；只删 Singularity role card 不够。
- cwd 和 write sandbox 不等于 read isolation；隐藏评测数据需要实际 filesystem/process 边界。
- DSH 提供 MCP client 和进程内 trusted plugin 接口；RSI 生成的 MCP server bundle 通过部署许可的 MCP transport 挂载，不直接作为 Cordis plugin 加载进宿主。
- 本文的 create、guard 等示例是架构伪代码，字段精确签名在实现阶段按上述版本类型检查；未跑模型就不能声称行为已经验证。

正式 Task 的 wake 只由 Singularity runtime 发起。DSH goal、workflow、schedule、subagent 不挂到正式 Task profile。正式 child Task 由 agents.create 创建独立 session，不通过 DSH subagent 的深度/完成通知管理。后台 Contract Summary Worker 只生成只读摘要，不得创建 Task、调用领域工具、验收或写入合同。

## 3. 项目结构与 TS 风格

采用 DSH 常见的 packages/<group>/<package>、src/index.ts、类型与 runtime 分离、Cordis plugin apply、TS ESM、显式 import type、.ts 源码导入、包 exports、tsconfig references 和统一格式化。

包按责任组织：`packages/singularity/protocol` 定义纯业务协议，`runtime` 组合 DSH 和事务存储，`apps/singularity` 只做 profile/启动组合，`packages/domains/*` 提供案例、领域验收与比较。领域实现与 core 分包，runtime 不出现领域分支。内部文件拆分由实际消费者决定，不设文件数或行数目标。

文档入口为 `docs/framework.md`（协议）、`AGENTS.md`（施工约束）、`docs/progress.md`（状态与证据）。调研 artifact 只提供证据，不具有规范权威。

依赖方向：runtime → protocol；app → runtime；domain package → protocol 的公开类型。protocol 不访问 FS、网络、进程、DSH 或时钟。runtime 复用 DSH tool/skill registries，不建立可变的第二套 registry；Method 的 catalog 是冻结数据，不是运行时注册服务。

Schema 与 TS 类型只选择一个可维护的权威定义源；不要分别手写四套相似 validator。协议结构使用 Zod 单源；模板中的动态 instanceSchema 是另一种用户数据，使用 Ajv 2020 校验与编译，而不是手写 JSON Schema 解释器。向 DSH 发布的工具 schema 必须符合其接受的子集。禁止协议 schema 的 transform/default/coercion，在源码门禁检查，不在每次解析时做 canonical JSON 往返。框架冻结的是字段与行为，不是内部函数拆分或行数。

## 4. 身份、不可变引用与 Task 业务合同

以下接口定义协议字段；所有 Ref 的线形都是 `{ id, digest }`，`Digest` 为 `sha256:<lowercase hex>`。未知字段、未知版本拒绝，不静默忽略。

### 4.0 Digest domain 与 Ref 映射

~~~ts
interface Ref {
  readonly id: string
  readonly digest: Digest
}
type ObjectRef = Ref
type AssetRef = Ref
type MethodRef = Ref
type TemplateRef = Ref
type TaskRef = Ref
type PreviewRef = Ref
type EvidenceRef = Ref
type ExecutionRecordRef = Ref
type AcceptanceRef = Ref
type CompositionRef = Ref
type RoundPlanRef = Ref
~~~

`Digest = computeDigest(domain, payloadBytes)`，计算式固定为 `SHA256(UTF8("singularity/v1/" + domain + "\n") || payloadBytes)`，结果编码为 `sha256:<lowercase hex>`。结构化对象的 `payloadBytes` 是去掉其最外层 `digest` 字段后的 JCS UTF-8，嵌套引用的 digest 保留；原始文件对象使用原始 bytes；目录/bundle 使用排序 manifest 引用各文件对象，不哈希不稳定的 tar 时间戳。JCS 规则见 §10.1。

Ref 的 domain 由 schema 字段位置决定，线形不携带 domain：

| Ref 类型或字段 | Domain | 规则 |
|---|---|---|
| `ObjectRef`、`AssetRef`（inputs、resources、guidance、example、bundle、manifest、config、receipt、planningSketch、feedback 等） | `object` | CAS 原始 bytes；结构化对象为去掉最外层 digest 的 JCS |
| `MethodRef`（contract.method、method.parent、NodeView.method、RoundPlan.baseMethod 等） | `method` | MethodRevision 去掉最外层 digest 的 JCS |
| `TemplateRef`（contract.template） | `method` | 其所在 MethodRevision 的 method digest；`id` 在该 revision 的 templates 中存在 |
| contract refs（`contractDigest`、`ContractSummary.sourceContract`、`TaskRef.digest`、`Evidence.task.digest`、`task/admitted.contract`） | `contract` | TaskContract 去掉最外层 digest 的 JCS |
| `PreviewRef` / `ackPreview` | `preview` | preview 对象去掉最外层 digest；`ackPreview` 必须等于 `previewRef.digest` |
| `EvidenceRef`（run/closed、task/closed、NodeView evidenceRef） | `evidence` | Evidence 去掉最外层 digest；ExecutionRecord 不得冒充 |
| `ExecutionRecordRef` | `object` | ExecutionRecord 去掉最外层 digest |
| `AcceptanceRef`（`contract.acceptance`、`DomainAdapter.resolveAcceptance`） | `object` | 冻结的 acceptance policy/provider identity，线形仍为 `{ id, digest }`；不新增 acceptance domain |
| `CompositionRef` | `composition` | Composition 去掉最外层 digest |
| `RoundPlanRef` | `round-plan` | RoundPlan 去掉最外层 digest |
| `Fact.prev` / `Fact.digest` | `fact` | fact 去掉最外层 digest |
| `Fact.commandDigest` | `command` | NormalizedCommand 的 JCS |

- `PreviewRef`、`EvidenceRef`、`ExecutionRecordRef`、`AcceptanceRef`、`CompositionRef`、`RoundPlanRef` 都是 `Ref` 的语义别名；线形仍是 `{ id, digest }`，domain 由字段位置决定。
- `AcceptanceRef` 指向冻结的 acceptance policy/provider identity，使用 `object` domain；`DomainAdapter.resolveAcceptance` 返回同一形状。`PublicReceipt.provider` 是 `object` domain 的 `AssetRef`，必须与 host 从冻结合同解析出的 provider 及 `Evidence.verification.provider` 在 `id` 与 `digest` 上完全相等。不得用 `evidence`、`method` 或新 domain 承载 acceptance。
- 未列出的 ref 类型或裸 `Digest` 不猜默认 domain；按 `INVALID_ARGUMENT` 拒绝，直到 amendment 补充。
- `TemplateRef.digest == MethodRef.digest` 是有意的：template 的权威是冻结的 Method revision，不是独立 CAS 对象。
- digest domain 集合保持 9 个；`AcceptanceRef`、`PublicReceipt`、`SubmissionManifest` 及其对象引用复用 `object`，不新增 `acceptance`、`receipt` 或 `submission` domain。
- digest 匹配不是读取授权；即使 ref 验证通过，CAS 读取仍受 §12.3/§17.2 scope 限制。

### 4.1 把“业务义务”与“执行配置”分开

~~~ts
interface TaskSpec {
  readonly goal: {
    readonly summary: string
    readonly deliverable: string
    readonly scope: readonly string[]
    readonly constraints: readonly string[]
  }
  readonly criteria: readonly {
    readonly id: string
    readonly statement: string
    readonly required: boolean
  }[]
  /** Model-supplied local guidance; never an acceptance obligation. */
  readonly localGuidance?: readonly LocalCriterion[]
  readonly inputs: readonly InputRef[]
  readonly outputs: readonly OutputSpec[]
}

interface LocalCriterion {
  readonly id: string
  readonly statement: string
}

interface LocalOutput {
  readonly id: string
  readonly path: string
  readonly kind: 'file' | 'tree'
  readonly description: string
}

interface TaskProposal {
  readonly goal: TaskSpec['goal']
  readonly localCriteria?: readonly LocalCriterion[]
  readonly inputs: readonly InputRef[]
  readonly localOutputs?: readonly LocalOutput[]
}

interface TaskContract {
  readonly v: 1
  readonly taskId: string
  readonly spec: TaskSpec
  readonly origin:
    | { readonly kind: 'root'; readonly purpose: 'work' | 'evaluation'
        readonly requestRef: ObjectRef }
    | { readonly kind: 'child'; readonly parentId: string
        readonly parentRunId: string; readonly batchId: string
        readonly bindingId: string }
  readonly method: MethodRef
  readonly template: TemplateRef
  readonly resources: ResourceBinding
  readonly acceptance: AcceptanceRef
  readonly environment: { readonly seed: ObjectRef; readonly profile: AssetRef }
  readonly limits: TaskLimits
  readonly digest: Digest
}
~~~

TaskSpec 是模型可以理解的、已由宿主解析后的目标与验收义务；TaskProposal 是模型提交给分解工具的请求；TaskContract 是准入后的冻结实例。模型只能填写 TaskProposal，宿主依据模板的 requiredCriteria、requiredOutputs、acceptancePolicy 和固定资源生成 TaskSpec/TaskContract。模型附加的 `localCriteria` 经过 schema 校验后只能成为 localGuidance；未通过 domain policy 的内容不进入受信 root acceptance。`localOutputs` 只能成为 supporting 输出，不能产生 required deliverable；合并顺序与保留命名空间见 §4.2.1。

准入后任何字段变化都需要另一个 Task；同一 Task 的 retry 不改变目标或验收，也不悄悄读取“最新 Method”。整次 root 执行及 descendants pin 同一个 Method revision。新 revision 只影响新 root。

### 4.2 输入、输出、资源

~~~ts
interface InputRef {
  readonly id: string
  readonly object: ObjectRef
  readonly path: string
  readonly access: 'read' | 'copy-to-work'
}
interface OutputSpec {
  readonly id: string
  readonly path: string
  readonly kind: 'file' | 'tree'
  readonly role: 'deliverable' | 'supporting' | 'skill-draft' | 'mcp-draft'
  readonly required: boolean
}
interface ResourceBinding {
  readonly baseTools: readonly AssetRef[]
  readonly skills: readonly AssetRef[]
  readonly mcpServers: readonly AssetRef[]
  readonly exploration?: ObjectRef     // 冻结的全局公开资源目录
}
interface TaskLimits {
  readonly maxRuns: number
  readonly maxStepsPerRun: number
  readonly maxTokens: number           // 本 Task 及子树的总预算
  readonly deadlineAt: number          // Unix epoch ms；行动边界 now < deadlineAt
  readonly maxDepth: number
  readonly maxTasks: number            // 子树累计数量，不因 retry 归零
  readonly maxBatchChildren: number
}

interface ContractSummaryRef {
  readonly object: ObjectRef
  readonly sourceContract: Digest
  readonly schema: 'task-contract-summary/v1'
}

interface ContractSummary {
  readonly v: 1
  readonly sourceContract: Digest
  readonly goal: string
  readonly acceptance: readonly string[]
  readonly constraints: readonly string[]
  readonly outputs: readonly string[]
  readonly frozenDecisions: readonly string[]
  readonly sourceRefs: readonly { readonly field: string; readonly digest: Digest }[]
  readonly generatedBy: 'contract-summary-worker'
}
~~~

ContractSummaryRef 是按 `sourceContract` 索引的派生 CAS 对象引用，不是 TaskContract 的字段。TaskContract 只拥有自身 digest；Summary Worker 根据冻结合同生成摘要，祖先查询按 digest 查找它。摘要不存在时返回 `SUMMARY_PENDING`，不改变合同权威，也不反向写入合同。

Budget 不能在每个 child 重新放大。根预算覆盖整棵子树，子任务获准份额的预留和实际消耗均计入祖先。等待中的 parent 不占模型执行并发槽；child 使用预算不由 parent 模型重新估算。

maxTokens 计本 Task 子树所有尝试的 inputTokens + outputTokens；cache tokens 若已属于 inputTokens，不重复相加。steps 计实际模型请求，不把一次 tool batch 当成多个模型 step。deadlineAt 为绝对时间，同进程续接和 retry 不延长。

宿主在每次模型请求前按已报告的子树 usage 检查剩余 tokens、steps 和绝对 deadline；余额耗尽或 usage unknown 时停止购买下一请求。单请求输出上限使用 DSH `AgentOptions.maxTokens`。DSH alpha2 没有请求前精确输入 token 计量接口；在途请求可能跨越剩余额度，其真实尾部 usage 全部记账，不截断或伪称严格不超额。`contextWindow` 仅用于模型上下文容量，不作为下一请求的 token 预留，不因缺少该元数据拒绝合法任务。

`at`、`deadlineAt`、`asOf` 统一为 Unix epoch milliseconds（UTC）安全整数，`0 <= value <= Number.MAX_SAFE_INTEGER`，在协议边界校验。`deadlineAt` 是绝对时间，行动边界只允许 `now < deadlineAt`：`now >= deadlineAt` 不开始新行动，retry/同进程续接不延长。runtime 使用宿主时钟和原生 deadline signal，不增加逐工具调用的时钟回拨状态机。

首版固定 retry policy：failed 在剩余 maxRuns、根预算和 deadline 内可重试；invalid 仅对领域部署预先列明的可重试验收结果（例如合作取消的 verifier-timeout）重试；这里不包括抛出的宿主错误。cancelled、污染、composition mismatch 和证据损坏不重试。每次 retry 使用新 session，宿主提供未使用的 workspace 路径，由 runtime 独占创建新目录；新鲜性由本次创建直接保证，不依赖读取历史 session 的 cwd。模型不能修改这项策略。required-child failure 不直接关闭 parent Run：source child 先 terminal，scheduler 写 direct-parent feedback，parent 在 active batch 清空后可以为同一 binding 创建 replacement child。只有 parent 无法继续、显式 stop、no-submission、step limit 或预算终结时，当前 parent Run 才按上述 retry policy 关闭。新 parent Run 不自动复用旧 child verdict，必须重新解决本 Run 的 required obligations。

资源 binding 由模板、deployment policy 与 frozen global snapshot 决定。模型提供 skills/tools/method/parentId/verifier 等字段一律拒绝，不能“规范化覆盖掉”后继续。Contract Summary Worker 从冻结合同生成以 `contractDigest` 索引的 ContractSummary；摘要保留 sourceContract 和版本，作为祖先查询的只读便利视图，原合同始终是权威。

### 4.2.1 Output 合并顺序与保留命名空间

root 与 child 准入使用同一个纯函数；合并结果写入冻结 TaskContract，因此合同 digest 由该顺序确定：

~~~text
base outputs
→ localOutputs（仅 child；按 proposal 顺序转 role='supporting', required=false）
→ __skill-drafts（tree, role='skill-draft', required=false）
→ __mcp-drafts（tree, role='mcp-draft', required=false）
~~~

- base 顺序严格保留（root: operator/domain 授权 outputs；child: template.requiredOutputs）；local 顺序严格保留；drafts 永远最后，固定 skill 在前、MCP 在后。
- root 也追加两个 drafts，保持“每个 TaskContract”一致；`includeLearningDrafts` 只控制提交时是否冻结实际目录，不控制是否声明 drafts。
- 合并后 `id`、`path` 必须唯一；重复 → `INVALID_ARGUMENT`，不覆盖、不去重。base/local 不得使用保留 ID `__skill-drafts`/`__mcp-drafts` 或保留 path `learning-drafts`/`learning-drafts/`；template 使用 draft role/path 在 Method precheck/admission 拒绝。
- `spec.criteria`、`spec.localGuidance`、`spec.inputs` 保留各自声明/proposal 顺序；localCriteria 不合并进 criteria；acceptance 仍由 host 解析。
- 失败发生在 append fact 之前：不产生 child、fact 或预算预留。seal 不重排、不追加；admission guard 验证 tail 恰好是两个 drafts。

### 4.3 AcceptanceRef 的权威

Root 的 criteria、verifier、scorer 来自用户授权的 domain case/operator，不属于 Method。

Child 的 goal、inputs 以及模板允许的局部 guidance 可以由父模型提交 TaskProposal；模板 requiredCriteria、requiredOutputs 和 acceptancePolicy 由宿主强制合并，它们不是 root 的评分标准。`localCriteria` 只进入 TaskSpec.localGuidance，`localOutputs` 只能由 host 按 §4.2.1 转成 `required=false`、`role='supporting'` 的附加输出；二者都不能改变受信 acceptance。child 的验收 provider 由固定 domain acceptance policy 根据冻结业务 spec 解析，模型提供的是实例化数据，不是可执行代码或任意命令。

`TaskContract.acceptance` 是 `object` domain 的 `AcceptanceRef`，冻结 acceptance policy 与 provider identity；`resolveAcceptance` 不得返回未列 domain 或裸 digest。host 解析出的 provider 必须与 `PublicReceipt.provider`、`Evidence.verification.provider` 在 `id` 和 `digest` 上完全一致；不匹配按 `invalid` 结算，不能补写 closure。`AcceptanceRef` 的对象 schema 仍由领域发布声明，本规范只冻结 ref domain、身份比较和 receipt 绑定规则。

因此 RSI 可以改 child template 的目标、预填 criteria、输出结构和分解关系；**不能改已经准入的 Task，不能改 root case、root verifier 或 scorer**。不得把“不能修改 live contract”误解成“不能改未来 child template 的验收描述”。

Child contract 的 schema 合法不证明子任务自然语言目标一定足够支持父目标。最终仍由 parent 的独立验收负责，框架不声称能做语义蕴含证明。

## 5. Method 是可复用目录，不是另一棵树

~~~ts
interface MethodRevision {
  readonly v: 1
  readonly id: string
  readonly parent?: MethodRef
  readonly entryTemplateId?: string
  readonly templates: readonly TaskTemplate[]
  readonly skills: readonly SkillAsset[]
  readonly tools: readonly ToolAsset[]
  readonly digest: Digest
}
interface TaskTemplate {
  readonly id: string
  readonly brief: string
  readonly guidance: ObjectRef
  readonly example: ObjectRef
  readonly instanceSchema: JsonSchema       // 仅校验可填写的 TaskProposal
  readonly requiredCriteria: readonly {
    readonly id: string
    readonly statement: string
    readonly required: boolean
  }[]
  readonly requiredOutputs: readonly OutputSpec[]
  readonly acceptancePolicy: AssetRef
  readonly skills: readonly string[]
  /** MCP server asset IDs; each server may expose multiple domain tools. */
  readonly tools: readonly string[]
  readonly children: readonly {
    readonly bindingId: string
    readonly templateId: string
    readonly brief: string                 // 这条绑定在本级的目标说明
    readonly join: 'required' | 'probe'
  }[]
}
interface SkillAsset {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly bundle: ObjectRef               // SKILL.md + 引用资源一起冻结
}
interface ToolAsset {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly kind: 'mcp-server'
  readonly server: {
    readonly bundle: ObjectRef
    readonly manifest: ObjectRef
    readonly sourceFiles: ObjectRef
    readonly config: ObjectRef
    readonly transport: 'stdio' | 'streamable-http'
    readonly capabilities: readonly string[]
    readonly exposedTools: readonly {
      readonly name: string
      readonly description: string
      readonly parameters: JsonSchema
      readonly output?: JsonSchema
    }[]
  }
}
~~~

重要选择：

- 模板没有 parentTemplateId；一个模板可以被不同上级复用，也可以先入库再建立绑定。不存在 orphan 自动删除。
- children 是允许分解成什么的静态关系，不是要求宿主预执行的工作流。
- 允许有界递归引用，例如一般 design task 再分解成 design task；实际执行必受深度、Task 数和祖先预算约束。
- 实例 Task 总有唯一父节点，形成责任树；模板目录可以复用。两者不能混为一种 graph。
- 每层只有自己的 guidance；不设一段对所有 descendants 自动注入的全局 Method 长 prompt。公共方法说明应做 skill，显式绑定到需要的层。
- 一个模板的 skills/tools/children 都由 Method 固定。这里的 tools 是完整 MCP server asset 的绑定；server 自己呈现其工具集合。Task worker 不能改绑定，RSI proposer 可以通过下一 revision 修改。
- method-empty 是 templates/skills/tools 均为空、entryTemplateId 缺省的合法 Method。不是偷偷预装一个领域 workflow。
- 平台 fallback ID 和 Task/RSI/DSH 基础 tool 名称是保留命名空间；Method 资产不得重名覆盖，实际注册前拒绝冲突。

### 5.1 预填写 Task 用例

example 是完整业务用例，而不是占位 scaffold。必须包含真实可理解的 goal、criteria、输入样本说明和输出格式，不得只写空对象、TODO 或 ${variable}。

所有模型可见的 worker/RSI card、Method guidance、example、skill 正文、MCP tool description 和协议错误都采用正向结构：当前目标、可执行动作、下一步和剩余预算百分比。权限、边界和终结条件由 schema、guard、scope 与 verifier 执行；模型界面只展示完成当前动作所需的信息。

示例：仿真子任务模板的 example（**仅解释协议，不规定领域实现**）：

~~~json
{
  "goal": {
    "summary": "验证一个 4 位无符号加法器的功能",
    "deliverable": "生成 sim-result.json 和完整仿真日志",
    "scope": ["单个组合逻辑模块", "功能仿真"],
    "constraints": ["将被测 RTL 作为只读输入", "覆盖全部输入组合"]
  },
  "localCriteria": [
    {
      "id": "exhaustive",
      "statement": "对 256 对输入逐一检查 sum 等于 a+b 的低 4 位且 carry 等于第 5 位"
    },
    {
      "id": "traceable",
      "statement": "结果文件给出测试总数、失败数和日志 artifact 引用"
    }
  ],
  "inputs": [
    {
      "id": "rtl-example",
      "exampleText": "module add4(input [3:0] a,b,output [3:0] sum,output carry); assign {carry,sum}=a+b; endmodule"
    }
  ],
  "localOutputs": [
    { "id": "result", "path": "sim-result.json", "kind": "file", "description": "仿真统计与公开结果" },
    { "id": "log", "path": "simulation.log", "kind": "file", "description": "完整仿真日志" }
  ]
}
~~~

example 输入是嵌入式样本，不能伪造 ObjectRef 或读取授权。实际 commit 必须使用当前 parent 获准的 frozen InputRef。preview 外层自动附上本模板解析出的 skills/tools 摘要；模型不负责在用例中抄写 binding。

其类型为 TaskExample = Omit<TaskProposal, 'inputs'> & { inputs: readonly { id: string; exampleText: string }[] }。example 通过这份样本 schema 验证；真正准入的实例仍必须通过 TaskProposal、template required fields 与 domain policy，不能直接把 example 当成授权输入。示例中的 localCriteria/localOutputs 只展示模型可提交的局部指导；host 会另外合并模板固定的 required criteria、required outputs 和 acceptance policy。

Child preview 不展示该 child 自己可以继续分解的孙模板、内部 workflow 或 guidance；父模型看见的是该 child 的接口、目标和一个用例。child 开始时才得到自己的完整本级指导与下一级 brief。

## 6. 每个节点都支持局部探索

“没有本层 Method”包括整个 Method 为空，也包括 Method 某层没有本地 guidance/child bindings。宿主在 admission 时确定本层是否进入 exploration，模型不能自行选择一个更宽权限的模式。

固定规则：

~~~text
entryTemplateId 缺省                         → root 使用 platform explore-child
有普通模板                                  → 使用其绑定
模板 children 为空且 domain policy 允许探索    → 提供固定 explore-child fallback
模板已有 children                           → 只暴露其固定绑定，不额外加通用逃生门
explore-child 创建的 child                    → 开始时再独立获得同样的局部探索能力
~~~

所以“只一级”是**每个模型只组织自己的直接下一层**，不是“任务树总深度只能为一”。fallback 可递归，仍受根 maxDepth/maxTasks 限制。

平台 explore-child 固定一个 required criterion `task-goal`：提交的产物与可复现证据须完成本 Task 冻结的 goal、deliverable、scope 和 constraints。领域 verifier 按本地目标检验；不要求研究子任务实现整个 root，也不以空 criteria 或进程正常退出代表完成。模型 localCriteria 仍只作指导，不改变该标准。平台 explore-child 提供一个通用、填写完整的示例与固定简短说明；它不是可演化领域模板，执行时仍 pin method-empty 或所在 Method revision。

平台 `explore-child` fallback 的默认 join 是 `probe`；只有 root/domain admission 明确把该 fallback binding 固定为 required 时，才建立 required obligation。模型不能把 fallback 从 probe 改成 required。

### 6.1 全局资源怎样进入探索层

domain package/operator 指定公开资源根，可能包括用户所说的 .agent 下全局资源。框架不擅自改成只读取另一种目录，也不默认继承用户 HOME 下所有资源。

root admission 冻结 GlobalResourceSnapshot：

~~~text
文档 → { id, description, objectDigest }
skills → { name, description, frozen bundle digest }
MCP servers → { name, exposed tools, manifest digest, bundle digest }
基础 DSH tools → profile allowlist
~~~

探索层首次自动获得以上资源的摘要列表；正文按需读。这里的“未绑定”指没有绑定到 Method 模板，**并不等于任意宿主资源**。

普通层只获得自己的冻结 bindings；探索层额外获得 snapshot 中由部署许可的公开能力。探索层实际调用的 global skill/MCP server/tool ID 都进 DSH trace，供 RSI 决定下一版应绑定什么。

公开集合由 domain/operator 明确配置。静态资产在注册/precheck 时按各自上限校验；NodeView 在实际渲染时校验 8 KiB，不在 admission 模拟未来动态视图。渲染超限返回明确错误，调整公开集合后运行，不静默隐藏条目。

### 6.2 Task 内编写 skill/tool 的含义

每个 TaskContract 都有平台声明的可选 learning-drafts 目录产物。worker 可在这个 workspace 目录写 SKILL.md、MCP server manifest、tool schema、server configuration 和实现源码（例如 Python 或 TS）。

具体做法是在准入后的 spec.outputs 按 §4.2.1 的顺序追加两个固定可选 OutputSpec：__skill-drafts → learning-drafts/skills（role=skill-draft）和 __mcp-drafts → learning-drafts/mcp-servers（role=mcp-draft），kind=tree、required=false。原始 root/child 提案不能占用或覆盖这些 ID/path；它们不增加业务验收 criterion。includeLearningDrafts=true 时提交器冻结实际存在的目录，缺省不因没有草稿而失败；该 flag 只控制提交时是否冻结实际目录，不控制是否声明 drafts。

- 这些是本次 Task 的附加产物，不是 root 验收必须写的报告。
- worker 不可注册它们、修改当前 bindings 或把 draft 作为新的 DSH MCP server 挂载。
- 普通工作代码/脚本仍可在已授权 bash 等基础工具下执行；这不构成 Method tool 注册，也不授予新权限。
- draft 用于保留探索结果；RSI proposer 有权选择、改写、丢弃或纳入下一 Method。
- 现有 global skill/MCP server 可以使用；新草稿只能在 RSI 候选准入并通过部署能力检查后成为正式绑定能力。

### 6.3 PlanningSketch 与祖先查询

每个 worker 在第一次领域工作、调用领域工具或准入 child 之前，先提交一份轻量 PlanningSketch。草图的 `level=0` 是当前 Task，`level=1` 是当前 Task 的 direct children，`level=2` 是这些 children 可能组织的 grandchildren；因此视野是“当前层加未来两层”，最多三层。只有 level 1 能转化为本 Run 的 `singularity_decompose` child；level 2 只能是轻量预期，由对应 child 自己决定是否实现。草图不创建 Task、不改变 Method、不成为 Workflow/Graph authority。

初始草图允许记录待确认的假设。worker 随后阅读相关文档、skill 和源码，在持续实现前细化本级职责、产物、接口与检查边界；发现新阶段或原目标过宽时更新草图并组织直属任务。长链工作的独立阶段通过 child 承接，串行阶段通过后续 batch 衔接；分解服务于职责与接口边界，也服务于并行。只有目标已收敛为一个有界、可直接验证的工作单元时才直接作为叶节点完成。每层仍承担必要的本地分析、实现、检查和直属结果集成。此处是模型工作指引，host 不做自然语言复杂度判定、不强制树深或 child 数量。

~~~ts
interface PlanningSketch {
  readonly v: 1
  readonly taskId: string
  readonly runId: string
  readonly contextEpoch: string
  readonly objective: string
  readonly levels: readonly {
    readonly level: 0 | 1 | 2
    readonly purpose: string
    readonly likelyChildren: readonly string[]
    readonly expectedInputs: readonly string[]
    readonly expectedOutputs: readonly string[]
  }[]
  readonly directPlan: readonly {
    readonly bindingId: string
    readonly purpose: string
  }[]
  readonly assumptions: readonly string[]
  readonly sourceContract: Digest
}
~~~

`singularity_plan` 以普通 Task tool 提交或更新草图；host 校验 task/run/contextEpoch/sourceContract、层级只能是 0/1/2、directPlan 只引用可见 binding。`directPlan.join` 不属于模型输入；join 永远由当前 Method 中该 binding 的固定定义派生，并在 preview、children-admitted 和 NodeView 中呈现。草图写入 CAS 并作为持久 DSH tool result；后续 `decompose commit` 和 `submit` 必须引用当前 epoch 的 sketch receipt。它是模型计划，不是受信合同；host 只验证结构，不采纳模型写入的验收、资源或 join 字段。

worker 可按需调用 `singularity_read(kind='ancestor')` 查询祖先的 `ContractSummary`、公开 goal、criteria、constraints、outputs 和已冻结 decisions。读取范围只沿 parent 链向上，返回 sourceContract、summaryVersion 和 asOf；不返回祖先私有 transcript、兄弟、孙节点内部规划或隐藏验收数据。祖先查询不改变当前合同和预算。

Contract Summary Worker 是宿主拥有的独立后台模型 session。它只读冻结 TaskContract，输出带 sourceContract、schema 版本和生成 session 的摘要对象，并把对象放入 `contractDigest → summary` 索引；不能调用 Task/MCP tools、发送 wake、修改合同、验收或写 Method。摘要失效时宿主重新生成新版本，旧摘要保留，查询结果明确标注版本；它不是验收证据。查询在摘要尚未生成时返回 `SUMMARY_PENDING`，不能把缺失摘要解释成合同缺失。

其固定 system card 为：

~~~text
Summarize the supplied frozen TaskContract into a compact ContractSummary.
Preserve the contract digest, goal, acceptance statements, constraints, outputs,
and frozen decisions with their source references. Return the declared summary
schema and a concise next-use description for ancestor queries. The host stores
the summary as a read-only object and keeps the contract as authority.
~~~

Summary Worker 的工具面只有读取已注入合同和提交摘要对象；模型 route 和 session identity 由 host 固定，摘要结果校验 schema、source digest 和长度。生成前按已报告 usage 检查该合同所属 Task 子树的剩余预算和 deadline；tokens 余额大于 0 且 usage 已知即可调用。完成后将实际 usage 计入该 Task 的 `UsageRecord.summary` 并汇总至 root；不预留 summary allowance。预算耗尽时保持 `SUMMARY_PENDING`；摘要的 provider/CAS/原生生命周期异常传播给 source Run，不能伪装成缓存 miss。摘要 session 属于该 Task 的当前 Run，随原生生命周期在其关闭前结束并计入最终 usage；已 seal 的 root 不再购买摘要请求。

## 7. 一级 workflow：用局部批次表达顺序

静态“允许分解什么”和本次“先做什么、再做什么”分开：

- Method 固定 child template 选项、skill/tool 绑定、默认用例。
- 当前模型根据本次目标和 PlanningSketch 决定是否分解、选哪几个、怎样填写业务字段、何时追加下一批。
- 一次只准入一个 active child batch；同批 child 必须能独立执行，不含 sibling dependsOn。
- 顺序依赖通过批次表达：第一批返回结果，父节点将明确 frozen outputs 作为第二批 inputs。串行任务仍可有独立职责与产物，不以有无并行收益决定是否分解。
- 不需要独立 Workflow 对象、DAG scheduler、join node 或 edge 状态。
- 每个 Run 可依次发多批；禁止把“一批原子提交”写成“Task 一生只能分解一次”。

例如：

~~~text
当前层：分析 → 实现 → 验证 → 汇总
        batch1 batch2 batch3  parent integration
                     │
                     └─ 验证 child 自己怎样组织孙节点，是它的本级责任
~~~

### 7.1 required 与 probe

join 在 Method 的 child binding 上固定，Task worker 不能在 commit 中改。每一个 `required` binding 是当前 parent Run 的一个 obligation，按 `bindingId` 计算；模板若不需要该义务必须把 binding 声明为 `probe` 或不提供该 binding：

- required：该 binding 必须有一个 verified winner，parent 才能提交成功。
- probe：探索性尝试，失败不自动否定 parent；parent 仍要通过自己的验收。同一 probe binding 可在同一 batch 创建多个独立 Task，也可在后续 batch 承接新的子问题；多个实例可确认同一个已交付的 preview；已有 verified child 不锁定该入口，新 probe 不自动替换或 supersede 历史 child。winner 与自动 replacement 限制仅适用于 required obligation。
- 一个 required obligation 的 winner 是同一 parent Run 中、该 binding 下、已 terminal、`closed(verified)` 且未被 replacement supersede 的 child Task。一个 obligation 同时最多有一个 active child；替换只在旧 child terminal 后发生。
- 所有已准入 child Task 都须 terminal 后，parent 才能提交或成功关闭；失败/取消记录必须保留。

required child failure 不会直接结束当前 parent Run。source child Run 先按第 9.2 节进入 terminal；如果 child Task 的 retry policy 仍允许，它先完成自己的 retry。child Task terminal 后，scheduler 向 direct parent 写 `source='scheduler'` 的 feedback；parent 在当前 active batch 全部 child Task terminal 后醒来，可以读取失败 Evidence 并为同一 binding 创建 replacement child。replacement 是新 Task、新合同、新 Evidence 链；旧 child 不可编辑、reopen 或改成 probe。

replacement 的 `supersedesChildIds` 由 host 根据 binding、触发 replacement 的已 terminal failure/feedback 和当前 parent Run 派生，模型不能提交或伪造该字段。host 选择该 binding 下当前仍未 supersede 且没有 verified winner 的 terminal child；存在多个时全部列入，找不到可替换 predecessor 或仍有 active child 时拒绝 replacement。被 supersede 的 child 仍保留在 trace 中且不得作为 winner；verified winner 不得被 replacement supersede。新的 child verified 后，该 binding 的 obligation 才满足。

新 parent Run 不自动复用旧 parent Run 的 child verdict；它只能读取旧 failure、公开 Evidence 和获准 artifacts，并须重新建立本 Run 的 required obligations。旧 Run 的 children 必须 terminal，证据保留。若当前 parent Run 的预算、step policy 或 retry 终结条件已到达，parent 只能以 failed/invalid/cancelled 关闭，再由固定 retry policy决定是否创建新 parent Run；新 Run 不继承旧 child winner。

### 7.2 结构化反馈与 parent replan

反馈是只读的结构化记录，不能直接改合同：

~~~ts
interface TaskFeedback {
  readonly v: 1
  readonly id: string
  readonly source: 'scheduler' | 'child-worker'
  readonly sourceTaskId: string
  readonly sourceRunId: string
  readonly directParentTaskId: string
  readonly kind: 'needs-replan' | 'input-invalid' | 'acceptance-concern' | 'blocked'
  readonly summary: string
  readonly proposedChanges: readonly {
    readonly field: 'goal' | 'inputs' | 'outputs' | 'child-purpose' | 'order'
    readonly suggestion: string
  }[]
  readonly refs: readonly ObjectRef[]
  readonly sourceContract: Digest
  readonly createdAt: number
}
~~~

`singularity_feedback` 是非阻塞 Task tool。child 只能提交给自己的 direct parent；child Run 仍 open 时可以提交 feedback。feedback 写入 CAS，不结束 source Run，不立即唤醒 parent。scheduler 在 source Run 进入 terminal closure 后，针对 no-submission、step limit、required child terminal failure 或无效验收结果自动生成 `source='scheduler'` feedback，并引用已经存在的 ExecutionRecord/Evidence。反馈不授予跨树读取权限。

feedback refs 必须是 source Run 已拥有的 public outputs、public Evidence 或 ExecutionRecord；host 过滤 privateReceipt、validation payload 和未授权 CAS 引用。child-worker feedback 的 sourceTask/sourceRun/parentId 由 caller identity 派生，模型只提供 kind、summary、proposedChanges 和已授权 refs。

反馈生命周期固定为：

1. child Run open 时可写 feedback；CAS 记录不改变 Run 状态。
2. child 调用 submit/stop，或遇到 no-submission、step limit、无效验收结果时，source Run 先进入 terminal closure。
3. scheduler feedback 只在该 closure 已写入或与其处于同一原子终结协调点之后生成，并引用已存在的 ExecutionRecord/Evidence。
4. active batch 以 child Task 为成员；parent 只有在该 batch 的所有 child Task terminal（包括 child 自己的 retry 已结算）后才 wake。parent 等待期间不占模型执行槽。
5. parent wake 后读取 direct child results 与 feedback，可以更新本级 PlanningSketch、创建同一 binding 的 replacement batch，或结束当前 Run 进入固定 retry。
6. parent submit 前必须 active batch 为空、所有 required obligations 已有 winner、所有已创建 children terminal。parent 已 submitted/closed 后迟到 feedback 只进入 trace，不唤醒旧 Run；下一 retry Run 可读取它。

模型不能改旧 child、root acceptance、Method binding 或预算。旧 Evidence 始终进入 trace；新 child 仍须通过相同 acceptance provider，required join 以新的 verified child 满足。没有 feedback 的普通 parent 也可以依据 direct results 形成下一 batch。

Summary Worker 的实际 usage 按 `sourceContract` 归属拥有该合同的 Task，汇总至 root trace 和对应 evaluation slot；缓存命中与祖先查询本身不产生模型 usage。cache miss 只请求宿主生成缺失摘要，生成前复用 §6.3 的已报告子树预算检查，完成后记录实际消耗；查询方不转移预算，不建立跨节点预留、锁扣或借用账本。RSI proposer usage 归属于 Round proposer budget，不计入 source root。feedback tool 本身没有模型 usage，scheduler feedback 是 host record。

feedback 的模型参数/协议拒绝返回明确 tool error；宿主 CAS/存储错误沿 §19.1 抛出并结束本次尝试。feedback 不阻塞父节点；feedback 不能由 worker 伪造 scheduler 来源，不能传递给祖父节点，不能直接唤醒非 direct parent。

## 8. 分解的 preview → commit 协议

两个动作属于同一个 singularity_decompose 工具，不存在另一个可绕过的 spawn 入口。

### 8.1 第一次 prepare，只返回用例

~~~json
{ "action": "prepare", "bindingId": "functional-simulation" }
~~~

response：

~~~text
status = preview
previewRef = PreviewRef（线形仍为 { id, digest }，digest 使用 preview domain）
bindingId / templateRef / methodRef / parentRunId
derived join = binding.join（required 或 probe；模型不可改）
brief / 完整用例 / 本子任务公开接口
resolved skill/tool summaries
reminder = read the example, then commit on a later model step
current planningSketchRef / remaining budget percentages
~~~

prepare 不创建 Task，不消耗 child 数，不写 domain fact。预览保存在 DSH tool result；receipt 记录父 Run、Method/template digest、tool call ID 和 model step。

同一 Run 重复 prepare 同一 binding 可返回相同 previewRef，避免正文重复；主动重读或 compaction 后可重新获取全文。

### 8.2 commit 才原子准入

~~~json
{
  "action": "commit",
  "children": [
    {
      "bindingId": "functional-simulation",
      "ackPreview": "sha256:<preview object>",
      "task": {
        "goal": { "summary": "当前实例的目标", "deliverable": "本次结果", "scope": [], "constraints": [] },
        "localCriteria": [ { "id": "traceable", "statement": "结果应能追溯到本次输入" } ],
        "inputs": [],
        "localOutputs": [ { "id": "log", "path": "result.log", "kind": "file", "description": "辅助执行日志" } ]
      }
    }
  ]
}
~~~

core + adapter 的准入顺序：

1. active Run、当前 epoch 的 PlanningSketch receipt、预算、深度、Task 数和“当前无 active batch”检查。
2. 每个 bindingId 确实是本层可见 child binding 或已准入 fallback；同批 required binding 只出现一次，probe binding 可重复实例化。
3. ackPreview 必须等于当前 Run **已经持久交付**的 previewRef.digest，且对应同一 prepare result；必须在后续模型 step，不能在同一次 tool batch 中猜测 ack。
4. instanceSchema、proposal 输入授权、路径和资源总额检查；host 按 §4.2.1 合并 template requiredCriteria/requiredOutputs/acceptancePolicy，把 localCriteria 写入 `TaskSpec.localGuidance`，把 localOutputs 转成 `required=false`、`role='supporting'` 的输出，拒绝模型提交 `required`、acceptance provider/verifier/scorer、deliverable role、重复 ID/path、保留 ID/path 或 draft role/path。
5. 由宿主生成 TaskSpec、taskId、parentId、parentRunId、batchId、Method/template refs、bindings、acceptance；taskId 由 parentTaskId、batchId、bindingId 和 children 数组内的 index 确定，同命令重放稳定、同批实例不同；若该 batch 是 feedback replan，host 根据 binding 和已 terminal failure 派生 `feedbackRef` 与 `supersedesChildIds`，模型不能提交这两个字段。
6. append 一个 task/children-admitted fact，含完整 children contracts、join 规则、预算预留。
7. parent 进入 waiting-children 投影，当前 turn 结束；释放执行槽。
8. child dispatch 在 fact 已持久提交后发生，使用 fact 中已准入的 child 身份与合同。

**强制阅读**能机械保证的是“完整用例已交付、发生下一模型步、模型显式 ack”。PlanningSketch receipt 也只能证明结构化计划已提交，不能证明模型理解了正文。工具会同时返回可执行的下一步；这些 receipt 不被称为认知证明。

commit 中出现 binding 覆盖字段直接拒绝；没有任何分解 side effect。preview token 不携带权限，只证明这次冻结用例已交付。

## 9. 状态机：Task、Run、Round；其余是数据

状态数量不是目标；这里逐条定义状态、触发和拥有者，防止同一词在不同层有不同含义。

### 9.1 Task 状态

~~~text
open ── run/opened ──▶ active ── task/closed ──▶ closed
  └────────────────── task/closed ────────────▶ closed
~~~

Task closed outcome 为 verified / failed / invalid / cancelled。closed 不可重开。

| 当前状态 | 命令/事实 | guard | 下一状态 |
|---|---|---|---|
| 不存在 | admitRoot 或 children-admitted | contract 与冻结引用合法 | open |
| open | openRun | 无 active Run，预算足够 | active |
| active | closeRun | 引用对应 active Run 的证据；required child failure 本身不满足 closeRun | active 或 open（retry） |
| active | closeTask(verified) | 本次 own Run verified；每个 required binding 有 verified winner；所有 children terminal | closed |
| open/active | closeTask(failed) | 最后 Run failed，固定 retry policy 已耗尽或不允许继续，不由模型写 verdict | closed |
| open/active | closeTask(invalid) | 不可重试的无效验收结果 | closed |
| open/active | cancelTask | trusted operator/runtime context | closed(cancelled) |

active 的实时 phase 只是投影：

~~~text
waiting-capacity | provisioning | working | waiting-children
| integrating | verifying | stopping
~~~

waiting 不购买模型请求；不增加 Wait/Join/Workflow fact 主体。

### 9.2 Run 状态

~~~text
open ── run/submitted ──▶ submitted ── run/closed ──▶ closed
  └──────────────────── run/closed ────────────────▶ closed
~~~

Run open 是已记录的执行意图，包含 sessionId、workspace lease key、composition 和预算。记录后才创建/驱动 DSH agent；provisioning 和 working 由 runtime/DSH 状态与已提交 facts 推导。

Run closed 的 classification：

| outcome | 原因 | 能否推导 Task verified |
|---|---|---|
| verified | 固定 verifier 对全部 required criteria 返回 pass，且 receipt 身份/摘要匹配、`timedOut=false`、`exit={code:0,signal:null}` | 可进入 join guard |
| failed | 有效验收 fail；或模型 stop/no-submission/step-limit | 不可 |
| invalid | receipt 缺失/畸形、身份或 digest 不匹配、任一 required criterion 为 invalid、`timedOut=true`、signal 终止、全部 pass 但 exit code 非 0 | 不可；无领域分数 |
| cancelled | operator/祖先取消 | 不可 |

verified/failed/invalid 由 host 按 §15.3 从 strict `PublicReceipt`、冻结合同、`timedOut` 和原始 `exit` 派生；verifier 自报总 verdict 或 exit=0 本身不能决定分类。timeout 必须用独立 `timedOut` 表达，不得写成 signal 或特殊 exit code。

没有提交的 failed Run 可以有 execution record，但没有 acceptance receipt。不要伪造 verifier receipt 来统一数据外观。已提交但 receipt 缺失、畸形或含 invalid criterion 时，invalid receipt 仅作 operator 诊断，不作为 Evidence，closure 使用 `ExecutionRecord(invalid)`，且不扩展 ExecutionRecord 增加 receipt 字段。

失败 Run 不自动导致 Task terminal：按 root admission 时冻结的 maxRuns/retry policy 决定。新 Run 的方法、Task contract 和祖先总预算不变。

### 9.3 完成与 yield 约束

DSH idle 不是业务完成；runtime 必须对 turn/end 做分类：

~~~text
Run 已 submitted                              → 正常交给 verifier
当前 Run 有 active child batch                 → 正常暂停，不算 no-submission
模型显式 singularity_stop                      → closeRun(failed, declared reason)
否则正常 turn/end                              → closeRun(failed, no-submission) + scheduler feedback to direct parent
turn/end 为宿主/provider error                  → 原生清理后抛出；本次进程尝试结束，不补 closed
runtime 已在取消/超预算                          → 走那个唯一终结路径，不重复写 closed
~~~

child 发现输入不足时，通过 `singularity_feedback` 返回结构化建议；scheduler 在 source Run terminal 后，于 no-submission、step limit、无效验收结果或 required child Task terminal failure 时生成同样的 direct-parent feedback。required child failure 让 parent 保持 open/waiting，直到当前 active batch 的所有 child Task terminal；parent 随后读取反馈并形成新的 PlanningSketch，再创建同一 binding 的 replacement batch，或结束当前 Run 进入 retry。反馈不等待父节点、不改变合同，也不引入可能死锁的 ask-parent。

## 10. 最小 fact 协议与 side effect

### 10.1 Envelope、normalized command 与幂等

~~~ts
interface Fact {
  readonly v: 1
  readonly seq: number                 // genesis = 0；见 §10.3
  readonly commandId: string           // host 分配；模型不可提供
  readonly commandDigest: Digest       // command domain
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
~~~

- `commandDigest = computeDigest('command', NormalizedCommand)`；`NormalizedCommand` 不存 CAS，不是 `ObjectRef`。
- `input` 是 strict schema 校验后的原始输入；不得补默认值、重排或“修复”。host-resolved 的当前 state、contract/method digest、当前 PlanningSketch、batch、feedback、预算、`asOf`、`at`、cursor 不进入 digest；它们由 state guard 校验。
- `commandId` 由 host 绑定；DSH 命令使用同进程续接期间稳定的 `(sessionId, toolCallId)` 派生 ID；operator/runtime 命令由 trusted host 生成。模型和工具参数不能提供 `commandId`、actor、domain 或 digest。
- 一个成功 command 恰好提交一个 fact；SQLite `UNIQUE(command_id)` 约束保证同 ID 不产生第二条事实。
- 同 `commandId`、同 `commandDigest` 返回原 fact 的确定性结果，不重复冻结、预留预算、派 child 或 wake；同 ID 不同 digest 返回 `IDEMPOTENCY_CONFLICT`。
- 无记录时，在写事务内运行唯一 reducer guard，成功后插入 fact 并 COMMIT。`seq` 从 0 连续增长，`prev` 引用前一条 fact digest。并发操作由唯一 CommandService 与 DSH 原生 exclusive 工具顺序执行。
- 原结果中的 Task/Run/batch/child IDs、refs、classification 和 submission ref 来自 fact/CAS；`remainingBudgetPct` 和 `asOf` 可重新计算。已提交命令即使业务状态已 closed 仍可返回原结果，但不绕过身份和读取授权。CAS 缺失/损坏属于宿主异常，直接终止本次执行。

JSON 文本使用标准 `JSON.parse`，数据以 JSON 值和领域 schema 校验；模型工具参数由 DSH 解析，不再扫描原始文本。重复键遵循标准解析的末值语义，数值为 ECMAScript finite number；计数、时间等字段要求安全整数，精确大整数必须以 schema 声明的字符串表达。规范化使用锁定的 `json-canonicalize` 库：对象 key 排序、数组保序、无额外 Unicode normalization；有效普通 JSON 的现有 hash 向量保持不变。不再承诺手写 parser 对重复键、原始数值精度、JS accessor/prototype 或非法 Unicode 的额外拒绝。本文中的 JCS 指该受支持 JSON 数据域的规范化编码。

Digest domain 与计算式见 §4.0；`Fact.digest` 使用 `fact` domain，`Fact.commandDigest` 使用 `command` domain。domain 集合为 §4.0 表中的 9 个；现有 8 个不重排，`command` 追加到末尾。

### 10.2 事实与完整 payload 范围

下表是本版本的闭合事实集。Evidence、模板、工具代码等大对象存 CAS；fact 引用 digest，不把完整 transcript 重写进 journal。

| Fact | Payload 必备内容 | 唯一后续消费者 |
|---|---|---|
| method/registered | revision、parent?、sourceProposal? | admission/RSI |
| method/activated | expectedPrevious?、previous?、next、approval、evaluationRef? | 新 root 选 Method |
| task/admitted | taskId、contract（contract domain；完整 root contract） | dispatch/ancestor query |
| run/opened | taskId、runId、attempt、sessionId、composition、workspaceKey、workspaceSeed、budgetReservation | DSH create；同进程 yield 后续接 |
| task/children-admitted | parentRunId、batchId、children（完整 child contracts、join、budgetReservation、replacement?） | child dispatch/parent projection |
| run/submitted | runId、outputs（strict `SubmissionManifest` ref，§15.3）、transcriptOffset、previewReceipts、readReceipts、planningSketchRef、feedbackRefs | verifier/trace |
| run/closed | runId、classification、reason、evidenceRef?、executionRecordRef?、usage、planningSketchRef?、feedbackRefs | retry/parent join/trace |
| task/closed | taskId、outcome、reason、decisiveRunId?、evidenceRefs、scope?、cancellationCutRef? | parent/trace seal |
| rsi/trace-sealed | rootTaskId、trace、usage、sessionCuts | RSI input |
| rsi/round-opened | roundId、sourceTrace、baseMethod、plan、proposerSessionId | proposer |
| rsi/proposal-submitted | roundId、patch | precheck |
| rsi/candidate-ready | roundId、patch、precheckReceipt、candidateMethod | paired dispatch |
| rsi/round-closed | roundId、outcome、comparisonRef?、precheckReceipt?、reason? | operator/activation |

精确 payload 如下；`?` 表示既有语义允许缺失，不把 optional 改成 null。Payload 不重复 `v`，版本由 Fact envelope 拥有。`TaskContract`、`MethodRevision`、`Evidence`、`RoundPlan`、`MethodPatch` 沿用 §4/§5/§15/§17/§18，不在此重定义。未知字段、未知 type、错误 type/data 组合均拒绝。

~~~ts
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
  readonly composition: CompositionRef
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
  readonly evidenceRef?: EvidenceRef          // verified / criteria-failed
  readonly executionRecordRef?: ExecutionRecordRef // no-submission / stop / invalid / cancelled
  readonly usage: UsageRecord                  // 保留独立 usage，不只依赖 result 对象
  readonly planningSketchRef?: ObjectRef
  readonly feedbackRefs: readonly ObjectRef[]
}

interface TaskClosedPayload {
  readonly taskId: string
  readonly outcome: 'verified' | 'failed' | 'invalid' | 'cancelled'
  readonly reason: string
  readonly decisiveRunId?: string
  readonly evidenceRefs: readonly EvidenceRef[] // 保留名称；Evidence refs
  readonly scope?: 'subtree'                    // 仅级联关闭时出现
  readonly cancellationCutRef?: ObjectRef
}

interface TraceSealedPayload {
  readonly rootTaskId: string
  readonly trace: ObjectRef
  readonly usage: UsageRecord                   // 完整 source trace usage
  readonly sessionCuts: readonly SessionCut[]
}

interface RsiRoundOpenedPayload {
  readonly roundId: string
  readonly sourceTrace: ObjectRef
  readonly baseMethod: MethodRef
  readonly plan: RoundPlanRef
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
~~~

关键约束：

| Fact | 约束 |
|---|---|
| method/registered | `revision` 验证 method domain；`parent` 与 revision.parent 一致；candidate-ready 不写本 fact |
| method/activated | `expectedPrevious`/`previous` 在非首次 activation 出现；`next` 已在只读 catalog；approval 含 expected/next；不移动 live Task |
| task/admitted | root contract；taskId 与 contract 一致；同一 taskId 只准入一次 |
| run/opened | Task open、无 active Run；attempt 1-based 且不超过 maxRuns；budget/deadline 不超父预算 |
| task/children-admitted | parent Run active；children 非空且不超过 maxBatchChildren；完整 child contracts；replacement 仅 source child terminal failure；模型不能提供 binding/join/replacement |
| run/submitted | Run open；self read/PlanningSketch 有效；无 active child batch；`outputs` 是按 §15.3 构建并冻结的 `SubmissionManifest`，身份匹配；提交后 latch |
| run/closed | `evidenceRef` 与 `executionRecordRef` 恰好一个；verified 或带 Evidence 的 criteria-failed 引用 Evidence；no-submission/invalid/cancelled 引用 ExecutionRecord；invalid receipt 仅诊断，不得作为 Evidence 或扩展 ExecutionRecord；`usage` 独立保存且与 result 内嵌 usage canonical-equal |
| task/closed | verified 需 decisive Run verified + join；`evidenceRefs` 只放 Evidence；subtree cancellation 由本 fact 独占，不补写 run/closed |
| rsi/trace-sealed | 全树 terminal、所有 Run closed、agents/processes drained；same rootTaskId 只 seal 一次 |
| rsi/round-opened | plan 先冻结；base = active head；proposer 尚未发请求 |
| rsi/proposal-submitted | Round proposing；patch base 一致；每 Round 一个正式 patch |
| rsi/candidate-ready | precheck 成功；candidate 加入只读 catalog；不写 method/registered |
| rsi/round-closed | improved/no-improvement 必须有 comparison；rejected 必须有 precheck receipt/reason；不移动 production head |

不另写 verification/recorded + evidence/sealed + run/settled 三份终局。verifier 原始结果、artifact manifest 和 final usage 写成一个 Evidence 对象，run/closed 的 `evidenceRef` 引用它；`run/closed.usage` 仍独立保存最终快照，并与 result 内嵌 usage canonical-equal。

预览交付、PlanningSketch、feedback 和 own-guidance 阅读来自持久 DSH tool results/CAS objects，不增加新的 domain fact。同进程父 Run 续接时从对应 DSH session 的 tool-call/result 读取，receipt 不跨 Run；sealed trace 的 children 章节索引这些对象。

失败/取消时 task/closed 可带 scope='subtree'。单进程 scheduler 停止为该子树派发新工作，直接对受影响的非 terminal Runs 调用 DSH 原生 cancel、whenIdle 和 dispose；原生结束完成后读取最终 usage/sessionCut，写入完整 ExecutionRecord 与 CancellationCut，再提交一次 task/closed。reducer 同次关闭目标 Task、非 terminal descendants 及其未关闭 Runs；已 terminal 结果保留。该 fact 是这些取消结论的唯一来源，不再补写同义 run/closed。普通工具回调按原生取消顺序结束，不建立半关闭记录、后台尾部补账或 trace 时补差状态机。真实原生处置失败抛出原始错误，不写伪造的 CancellationCut 或 invalid closure；保留诊断轨迹。

这些是字段语义定义；正式 JSON Schema 与 TS fact union 必须从本文冻结的 payload 定义生成或校验。实现可以选择生成器和内部文件拆分，但不能改变字段、optional 语义或行为。

### 10.3 持久化与提交原则

- 使用 Node 24.9+ 的 `node:sqlite` DatabaseSync、WAL 和 `synchronous=FULL`；接受该固定宿主的 ExperimentalWarning。SQLite 拥有事务提交、回滚和唯一约束，不保留 NDJSON/torn-tail 修复机制。
- 唯一 CommandService 在 `BEGIN IMMEDIATE` 内验证 seq/prev 扩展并执行强制业务 guard，再 INSERT events 和 COMMIT；任何 guard/写入错误 ROLLBACK。retry policy 参数不能关闭 guard。存储类只要求调用 guard，不拥有业务判定。
- 事实是唯一状态来源。纯 reducer 投影按已提交事实截面及固定 retry policy 缓存，已解析 CAS 也复用；不再同时维护独立可变 tasks/runs 状态表。事实变化后重新 fold，未声称增量 reducer。
- CAS 先 exclusive create 同目录临时文件并完成写入，再用原生 link 原子发布 digest 文件名；已有对象核对 digest。独立读取者只能看到完整的最终文件。引用 fact 只在对象成功写入后提交。写入失败结束当前执行，未被事实引用的对象作为 orphan 归档；不做跨 DB/FS 事务、临时文件修复、append 通用引用扫描或启动递归引用扫描。对象生产者先 await putObject，业务 guard 和实际读取者校验所消费对象的内容身份；不重新遍历全部外链。
- COMMIT 后才能派发关联模型或 child。`run/submitted` 后 verifier 只读冻结 CAS；有效验收结果写 `run/closed`，宿主异常直接抛出。
- CAS 写入与 fact 共用 store 的串行写队列；文件可见性的保证来自原子发布。命令幂等只查询 events 的 UNIQUE(command_id) 索引，比较已存 commandDigest 并返回原 fact；不维护内存 command projection。SQLite 写锁只保护事务，不代表进程生命周期独占。执行根保留一次性的进程 owner 标记，其他进程只能读取归档；同进程同时存在的第二 writer 也被拒绝。进程退出不清除 owner、不恢复执行、不续跑旧根。
- `DomainStore.replay()` 仅按 seq 读取归档事实，不能修复、恢复会话或再次驱动副作用。旧 NDJSON 证据保留原格式；打开旧 NDJSON 根直接拒绝，不创建平行 SQLite 历史，不提供执行兼容层。
- root trace 只在全树 terminal、DSH 原生生命周期结束后 seal；宿主错误留下未闭合事实供诊断，不把本轮失败伪装成领域 failed/invalid。

## 11. 完整 Task 执行 procedure

### 11.1 Root intake

~~~text
原始现实需求 + 公开资料 + 固定 root acceptance provider
  1. 操作者确认 goal、criteria、输入、输出与预算；有歧义先澄清
  2. 冻结输入、公开资源 snapshot、领域 acceptance identity、seed
  3. 显式选择 MethodRef；无现有方法则选择 method-empty
  4. resolve 本层模板与 bindings；验证 profile 真实具备所需能力
  5. append task/admitted（只引用冻结 contract；不把摘要写回 contract）
  6. 按根预算进入本进程 dispatch
~~~

从自然语言形成 root contract 可以用模型辅助，但结果须由 intake policy/operator 确定；不能让工作中的 root 自己改验收。

### 11.2 准备和启动一个 Run

~~~ts
async function openRun(taskId: string) {
  const task = view(taskId)
  guardCanOpenRun(task)
  const intent = allocateRunIdsAndReservation(task)
  const composition = freezeComposition(task, intent)
  // 先准备冻结输入，发生冲突或 I/O 错误就不打开 Run。
  await workspace.prepare(intent.workspaceKey, task.inputs)
  await commit('run/opened', { ...intent, composition })
  const handle = await dsh.agents.create({
    sessionId: intent.sessionId,
    meta: { cwd: intent.cwd },
    agentOptions: frozenModelRoute,
    setup: (agentCtx, agent) => composeTask(agentCtx, agent, task, intent),
  })
  await deliverWakeOnceOrFail(handle.agent, {
    wakeId: intent.runId + ':start',
    reason: 'start',
  })
}
~~~

禁止在 create.setup 中驱动 agent 或等待 whenIdle；setup 只完成 scope 装配。正常启动不复制父对话，也不 fork 旧 Task transcript。

deliverWakeOnceOrFail 直接以确定性消息 ID 调用 DSH followup；start 使用 runId+start，完成批次使用 runId+batchId。同进程续接时使用 session.deriveMessages() 中的消息 ID 判重；当前批次只由 live scheduler 派发一次，旧消息被 compaction 移出消息面后不重新派发该批次；inbox 的排队、消费与存储格式由 DSH 负责，不重建 inbox reducer 或增加 interrupted 分支。DSH 自身报错抛给宿主并结束当前执行尝试。消息 ID 判重不承诺供应商请求恰好执行一次；不确定请求按实际观测计 unknown usage。

### 11.3 当前层工作循环

~~~ts
onPromptAssembly(run) {
  const local = projectOwnAndDirectChildren(state, run)
  return buildViewFromSameGuards(local)
}
onFirstWorkStep(run) {
  requireSelfRead(run)
  requirePlanningSketch(run)
}
onToolCall(run, name, args) {
  assertCallerMatchesRun(liveAgent, run)
  assertBudgetAndState(run, name)
  return dispatchThroughDsh(name, args)
}
onBatchChildrenTerminal(parentRun, batchId) {
  releaseChildReservations()
  enqueueParentContinuation(parentRun, batchId)  // 仅在该 batch 的 child Tasks 全部 terminal 后；不在无容量时立刻驱动模型
}
~~~

父级等待时不持有执行槽，避免 maxActive=1 时 parent 等 child 的死锁。并发子任务使用独立 workspace；同批不同 Task 不互写文件。

父节点醒来后读取 direct outputs，将需要的对象明确放进自己的工作区，再决定整合、发下一批或提交。不会自动把 child 的整个目录 overlay 到 parent；导入相同路径必须指定处理，冲突不得静默 last-write-wins。

### 11.4 Submission 的稳定快照

singularity_submit 只接收声明的 output IDs 和可选 learning drafts，不接收 verdict/score。提交还携带当前 PlanningSketchRef 和已读 feedback refs。

~~~text
validate Run still open + self read + current PlanningSketch + no active child batch
  → every required binding has a non-superseded verified winner
  → all admitted children of this Run are terminal
  → use schema-validated relative paths / check output leaves and size / freeze declared outputs
  → exclusive submission latch；后续写工具全部拒绝
  → freeze outputs into CAS
  → append run/submitted
  → end current turn
  → turn 外的 runtime 等 DSH whenIdle，调用 AgentHandle.dispose
  → run verifier on frozen inputs + frozen artifacts
~~~

等待 agent.whenIdle 由 turn 之外的 runtime 执行；在 submit 的 tool body 内等待自身 turn 结束会死锁。submit result 只说 submitted，不谎称 verifier 已通过。

提交冻结结果是 strict `SubmissionManifest`（§15.3）：`run/submitted.outputs` 和 submit 返回的 `submissionRef` 都引用同一 `object` domain 的 `ObjectRef`。模型只提供声明的非 draft output IDs 和 `includeLearningDrafts`，不能提供 `taskId`/`runId`/`contractDigest`/path/kind/role/required/object ref/digest/checks。非 draft `outputs` 严格按合同声明顺序；`learningDrafts` 固定 skill 在前、MCP 在后；`checks` 先按已冻结非 draft outputs、再按 learningDrafts。`checks` 为必填数组，每个已冻结输出恰好一条，记录 host 在冻结前观测到的 `bytes` 和 `symlinks:'none'`。数组顺序是 manifest digest 的一部分，不得排序、去重或补默认值；同一提交重放必须得到同一 digest。

部署先提供工作目录的真实文件/进程边界；`dsh-fs-sandbox` 允许读取宿主文件且保留祖先 symlink 竞争窗口，不能单独提供隐藏数据隔离。初始输入在模型创建前 exclusive create，失败即停止。父 Run 只在当前进程内挂载新出现的 child 输出一次，续接不重复覆盖已有挂载。submit 使用 DSH 原生 exclusive 工具，使用已由边界 schema 验证的相对路径，完成当前 workspace 的 leaf no-follow 文件检查与 CAS 冻结；不探测外部进程表、文件 mtime 静止或另设 in-flight job 锁。模型应在产物准备好后提交；CAS 固定本次读取到的 bytes，不宣称整个工作目录具有同一时刻的原子文件系统快照。缺失声明输出等模型可修正问题返回工具拒绝；实际存储读取异常抛出并停止当前执行。冻结后 verifier 只消费 CAS，绝不回读可变 agent workspace。缺失 required output、越界 path、file/tree 内 symlink 或超出部署 size cap 必须在 manifest 和 `run/submitted` 之前拒绝；已写入但未被 fact 引用的 CAS 对象是 orphan，不是业务成功。size cap 属于部署 policy，不是协议字段；manifest 只记录实际 bytes，`checks.symlinks='none'` 记录产物 leaf 和 tree 枚举项未发现 symlink；不证明祖先路径隔离。祖先路径边界由启动前已有的容器/OS 边界保证；可信本地任务依赖操作者控制的干净 workspace，不运行不可信代码，不声称私有数据隔离。框架不做 ancestor walker、沙箱嗅探或启动后补救。

### 11.5 验收和结算

~~~ts
async function verifyAndClose(runId: string, finalSessionSnapshot: SessionSnapshot) {
  const submitted = loadFrozenSubmission(runId)
  const receipt = await domain.verify({
    operationId: runId + ':verify',
    task: submitted.contract,
    inputs: submitted.inputObjects,
    outputs: submitted.outputObjects,
  })
  const verdict = validateReceipt(receipt, submitted)
  const usage = finalSessionSnapshot.usage // 原生 whenIdle/dispose 后的最终观测
  const evidence = sealEvidence(submitted, verdict, usage)
  await commit('run/closed', { runId, classification: verdict.kind, evidence })
  await reconcileTask(runId)   // verified join / retry / failed / invalid
}
~~~

`domain.verify` 接收 §15.3 的 `VerifyRequest` 并返回 strict `PublicReceipt`。`validateReceipt` 必须检查：provider 与 host 从冻结合同解析出的 acceptance provider 及 `Evidence.verification.provider` 在 `id`/`digest` 上完全相等；`operationId` 等于 `runId + ':verify'` 且与 request/Evidence 一致；`contractDigest` 等于冻结合同；`inputDigests`/`outputDigests` 与授权输入/冻结输出逐位相等；criteria ID 集合恰等于 required criteria 且每条一次；verdict 合法；`reason` 为公开安全文本；metric/score 满足 §15.3 规则；`exit`/`timedOut` 形状合法。

host 分类、exit 与 timeout 的完整规则见 §15.3；本 procedure 只消费 `validateReceipt` 的结果，不在 runtime 另写第二套判定。exit=0 本身不足以 verified，verifier 自报总 verdict 也不被接受。

`invalid` receipt 仅可作 operator 诊断：不得 seal 成 Evidence，不得扩展 `ExecutionRecord` 引用它，不进入 NodeView/ProposerView/公开 trace，也不产生领域分数。no-submission、显式 stop、无效验收结果、cancelled 使用现有 `ExecutionRecord`；`run/closed` 仍恰好引用一个结果：verified 或带 Evidence 的 criteria-failed 使用 `evidenceRef`，其余使用 `executionRecordRef`。verifier 的合作取消 timeout 必须结算为 `invalid`，不得伪造成 signal 或特殊 exit code；adapter 抛出的其他错误、provider 配置不匹配和原生清理失败是宿主错误，不生成 Evidence/ExecutionRecord/闭合 fact。DSH 结束和必要清理都须尝试；单个错误保留原对象，多个错误以 AggregateError 保留全部原因。

有效 required criterion fail 是领域 failed，可由固定 scoring policy 得出有限失败分；无提交、缺失/invalid trial 没有可比较分数，不能由 comparator 自行填零。

### 11.6 Parent join 与全树结束

Task 可以成功关闭，当且仅当：

~~~text
决定性 Run closed(verified)
AND 决定性 Run 的每个 required binding 都有一个非 superseded 的 verified winner
AND 决定性 Run 已创建的所有 children 均 terminal
AND Task 未取消
~~~

winner 只在决定性 Run 的 required obligations 中计算；旧 parent Run 的 child verdict 不自动成为 retry Run 的 winner。replacement 的旧 child 仍计入“已创建 children”并保持 terminal。probe 的失败记录必须保留。parent 自己的 verifier 不因为 child verified 而跳过，也不接收 child 对 root 的“自评分”。

Root closed 后停止/排空其所有 owned executions，确定 DSH 最终日志 cut、usage、child evidence refs，然后 append rsi/trace-sealed。这是“从现实任务到一次可供 RSI 消费轨迹”的完成点。

## 12. 每个模型确切能看到什么

### 12.1 固定层级

| 内容 | 放置位置 | 交付时机 | 是否可被 RSI 改 |
|---|---|---|---|
| DSH 基础身份、工具政策 | DSH system sections | 标准宿主装配 | 否 |
| Singularity worker card | 单个固定 system section | Run 全程 | 否 |
| NodeView | required dynamic context，interpolate=false | 每次模型请求按同一 state cut 刷新 | 否 |
| 当前 Task 完整合同和 own guidance | singularity_read(kind=self) | 首步强制读取；后续按需 | 下一 revision 可改 guidance |
| skill 名称/description | scoped DSH skill discovery | 第一次请求可见 | Method 资产可改 |
| skill 正文/资源 | DSH skill tool | 按需、初次加载；不反复主动注入 | 是 |
| child brief | NodeView 的 direct child catalog | 第一次请求可见 | 是 |
| child 完整用例/接口 | decompose prepare result | 第一次选择该 child 时 | 是 |
| 可调用 tools schema | DSH tools provider | 每步实际可调用集合 | 领域资产可改 |
| 子结果 | direct child summary +只读输出挂载 | child terminal 后 | 仅是事实 |

完整 TaskSpec 不被永久截成一句摘要。NodeView 只包含 goal 摘要时，obligations.readSelf=true，所有工作写工具/领域执行/分解/submit 都 gate 在 self read 后；读完仍保留 compact view，全文保存在 transcript，可按需重读。

读取证明在同进程 yielded-parent 续接中从原 DSH session 读取；contextEpoch 直接绑定 session identity、原生 firstLiveSeq 和 surface.replaceGeneration。原生 session 重新装配或消息面 replacement 后重新要求 self read；普通消息追加不改变 epoch。不自行配对 compaction/start/end 或 replay 日志。child preview 必须处于当前可见 epoch，不能使用被压缩掉的旧摘要冒充完整用例。

### 12.2 NodeView schema

~~~ts
interface RemainingBudgetPct {
  readonly tokensPct: number | null
  readonly stepsPct: number
  readonly wallClockPct: number
  readonly depthPct: number
  readonly taskSlotsPct: number
}

interface NodeView {
  readonly v: 1
  readonly asOf: number
  readonly contextEpoch: string
  readonly task: {
    readonly id: string
    readonly runId: string
    readonly parentId?: string
    readonly goalSummary: string
    readonly contractDigest: Digest
    readonly phase: 'working' | 'waiting-children' | 'integrating'
    readonly mode: 'guided' | 'exploration'
  }
  readonly method: MethodRef
  readonly ownTemplate: { readonly id: string; readonly brief: string }
  readonly documents: readonly { readonly id: string; readonly description: string }[]
  readonly skills: readonly { readonly id: string; readonly name: string }[]
  readonly tools: readonly { readonly name: string }[]
  readonly childOptions: readonly {
    readonly bindingId: string
    readonly templateId: string
    readonly brief: string
    readonly join: 'required' | 'probe'
  }[]
  readonly requiredObligations: readonly {
    readonly bindingId: string
    readonly status: 'unresolved' | 'winner'
    readonly winnerChildId?: string
    readonly replacementAllowed: boolean
  }[]
  readonly childBatch: {
    readonly id: string
    readonly total: number
    readonly terminal: number
    readonly detailsCursor?: string
  } | null
  readonly childHistory: {
    readonly total: number
    readonly outcomes: Readonly<Record<string, number>>
    readonly detailsCursor?: string
  }
  readonly recentChildResults: readonly {
    readonly id: string
    readonly batchId: string
    readonly outcome: string | null
    readonly publicReason: string | null
    readonly evidenceRef?: ObjectRef
    readonly outputsPath?: string
  }[]
  readonly obligations: {
    readonly readSelf: boolean
    readonly readPlanningSketch: boolean
    readonly requiredFailure: boolean
    readonly canDecompose: boolean
    readonly canSubmit: boolean
    readonly denialCodes: readonly string[]
  }
  readonly planningSketchRef: ObjectRef | null
  readonly feedback: { readonly count: number; readonly cursor?: string }
  readonly lastAttempt: { readonly runId: string; readonly reason: string } | null
  readonly budget: RemainingBudgetPct
  readonly workspace: { readonly cwd: string; readonly outputs: readonly OutputSpec[] }
}
~~~

obligations 与 dispatch guard 使用相同规则，不在 prompt renderer 再写一套 canSubmit。canSubmit 只承诺结构/状态允许尝试提交，不预测文件是否存在或 verifier 是否通过。模型看到的预算统一是 0–100 的剩余百分比；精确 token、step、deadline、Task 数和字节只在 host guard、日志和评测中保存。

documents 和 childOptions 的完整当层摘要列表随实际 NodeView 渲染校验体积；skills/tools 只列身份，不再复制 DSH discovery/schema 中的 description。skill 简介由 scoped DSH discovery 交付，tool 简介由工具 schema 交付，第一请求前装配完整集合；三处不能各注入一遍相同帮助。

动态增长的 child 历史用计数、当前批次和有界 recentChildResults 表示，完整 direct child 列表经 read(kind=children) 分页；本次 wake 涉及结果均可从该 cursor 找到。NodeView 不重复携带所有历史 child 记录，guard 始终检查完整 state。

没有事实依据时不强行生成“下一步必须 submit”。模型仍需自主进行领域工作，runtime 只决定读、分解、提交、等待这些动作是否合法。

### 12.3 direct child 的读取授权

父 Run 对其直接 children 的公开 Evidence 和声明 outputs 有天然读取权，来源是 children-admitted 中的 parentRunId。其他跨节点数据必须显式通过 TaskSpec.inputs 授权。

每次 child terminal，adapter 在 parent 的只读命名空间挂载 frozen outputs：

~~~text
children/<taskId>/<outputId>/...
~~~

不 overlay parent 代码，不导入 child 的临时文件或孙节点目录。需要整合时父模型复制或改写为自己的声明产物。挂载 refs 和 asOf 进入当次 context snapshot；最终 Evidence.inputs 包含初始输入及这些追加的 direct outputs。

`Evidence.inputs` 必须与 verifier 授权输入由同一 snapshot 派生，并逐位相等；不得加入未给 verifier 的 audit-only 输入，也不得让 verifier 只收到初始输入而 Evidence.inputs 记录 direct child outputs。`PublicReceipt.inputDigests` 与 `Evidence.inputs[].digest` 逐位相等；`PublicReceipt.outputDigests` 与 `Evidence.outputs[].digest` 逐位相等，后者按 §15.3 的冻结输出顺序派生。digest 相等不是读取授权。

### 12.4 每种模型视图

| 模型 | 能看到 | 不能看到 |
|---|---|---|
| 普通 Task worker | own 合同/指导、bound skills/MCP servers、direct child brief、direct results、按需祖先摘要 | 全 Method 库、兄弟/孙节点内部规划和 transcript |
| exploration worker | 上述内容 + frozen global public snapshot + explore-child | 真实宿主 HOME、即时修改 registry、隐私验收数据 |
| parent integration | 仍是原本级 worker，增加直接 child 结果和 feedback | 自动接管 child 的孙层 workflow |
| retry worker | 新 session、相同合同与 Method、上次公开 reason/receipt、获准产物 | 旧完整对话、重置预算、已更新 head |
| RSI proposer | 完整 Method、sealed source trace 的可分页索引与公开轨迹、能力资产 | 控制运行中的 Task、评测私有数据、改平台或主动跑实验 |
| verifier | 合同、固定输入、声明产物、固定规则 | executor 的自述和推理作为验收依据 |

## 13. System prompt：固定短 card，领域内容外置

下列 worker card 为 V1 规范的完整平台正文。它提供当前目标、可执行动作和下一步；schema、guard 和结算负责协议约束。模板 guidance 和 skill 与该 card 冲突时，平台义务优先。

~~~text
You own one Task's local workflow, technical work and direct-result integration.
Start with singularity_read(kind="self"); follow all nextCursor pages, then
submit an initial singularity_plan. Read relevant documents, skills and source
to refine it before sustained implementation. Plan levels [0,1] or [0,1,2]:
0=this Task, 1=direct children, 2=possible grandchildren. Create only level 1;
each child plans deeper work. Use current contextEpoch and visible bindingIds.

For a long chain, delegate stages with distinct outputs and checks to direct
children, including sequential stages in successive batches. Decomposition
sets responsibility and interfaces as well as parallelism. Do bounded local
analysis, implementation, checking and integration yourself. Work directly as
a leaf when the goal is one bounded, directly verifiable unit. Replan when
discovery exposes further stages or an overly broad scope.

Call singularity_decompose(action="prepare", bindingId=...) to read the full
frozen example. On a later model step commit children with bindingId,
ackPreview=previewRef.digest, and task goal/localCriteria/inputs/localOutputs.
Commit ends this turn; wait for the batch. Read direct results and feedback,
integrate, then prepare the next batch. Refresh stale previews via
singularity_read(kind="status"). Use authorized inputs, workspace, skills and
MCP tools. Public-resource work may use inputs:[].
Read ancestor summaries when useful; send direct-parent suggestions with
singularity_feedback and continue local work. Call singularity_submit when
declared outputs are ready for independent verification, or singularity_stop
with a concrete blocker when the goal cannot be completed.
~~~

探索模式只追加：

~~~text
Local exploration is enabled at every eligible level. Discover the local
workflow from frozen public resources, use explore-child for its direct
stages, and preserve useful skill/tool drafts. RSI registers later revisions.
~~~

首条 wake：

~~~text
Task <id>; Run <id>; reason=start; remaining-budget=<tokens>/<steps>/<time>/<tasks>%.
Read self, submit a planning sketch, then work toward this Task's goal.
~~~

parent wake：

~~~text
Task <id>; Run <id>; reason=children-terminal; batch=<id>;
remaining-budget=<tokens>/<steps>/<time>/<tasks>%.
Read direct child results and feedback, then resume this level's workflow.
~~~

不给每个节点注入 journal 历史、架构解释、RSI 规则全文、verifier 使用手册或整段 Method 库。平台不通过越来越长的“请遵守协议”文字来替代 guard。

## 14. 固定 Task 工具面与动态门禁

### 14.1 输入/输出合同

~~~text
singularity_read
  input: { kind: self | status | resource | children | evidence | ancestor | feedback,
           id?, cursor?, page? }
  output: { data, objectRef?, nextCursor?, asOf, remainingBudgetPct }
  self 返回完整 TaskSpec、acceptance 公开描述、own guidance、输入/输出路径
  ancestor 按祖先 contractDigest 返回 ContractSummary；摘要未生成时返回 SUMMARY_PENDING；feedback 返回 direct child 的结构化反馈

singularity_plan
  input: { sketch: PlanningSketch }
  output: { planningSketchRef, contextEpoch, remainingBudgetPct }
  effect: 保存当前 Run 的结构化计划；不创建 Task，不改变合同

singularity_decompose
  prepare: { action: prepare, bindingId }
  commit: { action: commit, children: [{ bindingId, ackPreview, task: TaskProposal }] }
  output: preview 或 admitted batch/task IDs + remainingBudgetPct
  每个字段在第 8 节定义；不接受任意完整 TaskContract。host 将 proposal 与 template required criteria/outputs/acceptancePolicy 合并为冻结 TaskSpec。

singularity_feedback
  input: { kind, summary, proposedChanges[], refs[] }
  output: { feedbackRef, directParentTaskId, remainingBudgetPct }
  effect: 写入供 direct parent 查询的非阻塞结构化反馈

singularity_submit
  input: { outputIds: string[], includeLearningDrafts: boolean }
  output: { submitted: true, runId, submissionRef, remainingBudgetPct }
  effect: 冻结声明产物并交给独立 verifier

singularity_stop
  input: { reason: blocked | unsolved, message: string }
  output: { stopped: true, runId, remainingBudgetPct }
  effect: 记录结构化 blocker，交给固定结算策略
~~~

不另造“平台 skill 工具”；复用 DSH skill tool。领域 Tool 全部是按 Method 绑定的 MCP server，DSH MCP client 负责 transport 和 server tool schema。基础 read/write/search/bash/jobs 等按 profile 名称装配，不在规范里为 DSH 工具造另一套别名。

MCP server/tool schema 与描述不携带本次 Run 的精确 token、step、wall-clock 或 Task 数；host 在 NodeView、wake 和 tool result 中提供统一剩余百分比，精确值留在 guard 和记录。

上述工具的 schema 均拒绝未知字段。协议拒绝通过 DSH 标准 tool failure 返回短 JSON：{ code, nextAction, remainingBudgetPct }；nextAction 是正向可执行动作。协议拒绝码固定为 INVALID_ARGUMENT、READ_SELF_FIRST、PLAN_FIRST、PREVIEW_REQUIRED、PREVIEW_STALE、NEXT_STEP_REQUIRED、CHILD_BATCH_ACTIVE、REQUIRED_FEEDBACK_REPLAN、INPUT_NOT_AUTHORIZED、BINDING_FIXED、LIMIT_EXCEEDED、ALREADY_SUBMITTED、RUN_CLOSED、COMPOSITION_MISMATCH、IDEMPOTENCY_CONFLICT。错误不创建 child、不提交产物；已经落盘的相同命令按 commandId + commandDigest 返回原结果。

模型已完成输出中的非法 JSON 或 schema 参数错误，交给 DSH 原生工具解析/校验并返回 `isError`；Singularity 工具保留原始错误内容，追加 `{status:"failed",example,nextAction}`，其中 example 是该工具完整、极简的格式用例，实际 ID 与目标取自当前视图。此规则同样适用于 RSI、Summary 和领域审查的提交工具。用例按需在失败结果或协议资源中展示，不重复注入 system prompt。模型可在同一 Run 的下一步修正，正常计入使用量；不修补 JSON、不匹配自然语言错误、不为参数错误重购 provider 请求或创建恢复会话。输出长度终止仍由 DSH 处理，不执行未完成的调用；宿主/provider/存储异常仍按 §19.1 抛出。

### 14.2 状态与工具交集

| 当前情形 | 可用 Task 工具 | 基础/领域工具 |
|---|---|---|
| 尚未 self read | read、stop；其他 Task tools 返回 read-self nextAction | 仅无副作用的说明读取 |
| 已 self read、尚未 plan | read、plan、stop；其他 Task tools 返回 plan-first nextAction | 仅无副作用的说明读取 |
| working/integrating | read、plan、prepare/commit（如允许）、feedback、submit、stop | profile∩bindings∩预算 |
| prepare 已返回 | 同上；commit 验证 ack、next-step 和当前 sketch | 同上 |
| waiting-children | 模型不被驱动；status 由宿主/UI 读取 | 无 |
| required child 已 failed | read、plan、feedback、prepare/commit（修正 batch）、stop | 领域工具在新 batch 中恢复 |
| submitted/closed/cancelling | 当前模型不得继续操作 | 无 |

提交/分解工具保持可发现；guard 返回短 nextAction 和剩余预算百分比，使模型能继续完成协议动作。

guard 同时覆盖 DSH scoped、global 和 MCP server tools。模型一次返回多个工具调用时，plan/decompose/feedback/submit/stop 是 exclusive、非 concurrency-safe；提交/暂停后的同批后续变更调用拒绝。

相同规则覆盖 native tool calls 与 DSH PTC 内嵌调用；实现统一把 MCP server call 绑定到当前 Run 和冻结 server asset。正式 profile 不启用无法纳入相同 guard 的调用通道。

### 14.3 Prompt 体积预算

| 内容 | 最大值 | 超限处理 |
|---|---:|---|
| 固定 worker card，含探索追加 | 2 KiB | 平台 build gate |
| NodeView，含所有当层资源/child briefs | 8 KiB | 实际渲染时校验，超限报告并调整公开配置；不丢失条目 |
| own guidance | 8 KiB | Method precheck 拒绝 |
| 单个 child example | 12 KiB | Method precheck 拒绝 |
| 一个 prepare result | 32 KiB | 单个 binding 逐个 prepare；不拼整库 |
| 全部可见 tools 的 schema/描述 | 12 KiB | 能力配置拒绝，长帮助移入资源 |
| 全部可见 skills 的 discovery 名称/简介 | 8 KiB | 资源配置拒绝，不重复放进 NodeView |
| 单个 read/skill result 页 | 16 KiB | 稳定 cursor 分页，不静默截断 |

首次 self read 和 prepare 将正文保存在当前上下文中；不每步重复追加。分页读完的 receipt 必须覆盖完整对象。大 skill 必须拆成短 SKILL.md + 按需引用资源，不能因为 skill 太大绕过单次输出上限。

DSH compaction、tool result pruning 保持宿主实现；runtime 只记录新的 contextEpoch 并重建 self/preview 阅读义务。epoch 直接取原生生命周期位置和 replacement 代数，不增加“未知 epoch”探测分支。

验收测量：实际 assembled system、dynamic context、tool schemas、history、每步 input/cache/output tokens分别记录。只报自己写的 prompt 字数不能证明没有膨胀。

## 15. 产物、执行环境与 Evidence

### 15.1 Workspace 和 Capsule

两种隔离不能混淆：

- Task Run workspace：当前节点的可写工作目录；同一节点的多个 parent wake 延续这个目录。
- evaluation attempt capsule：从固定 seed 构建的一次完整 root 执行环境；包含该次树中各 Run 的私有 workspace。
- verifier environment：只读取 frozen inputs/outputs，验证身份由 host 注入；不能把 agent 的可写 workspace 当作 trusted test directory。

baseline/candidate/case/repetition/attempt 的独立 capsule 由部署在启动前提供；禁止跨候选共享可写代码、HOME、TMP、依赖安装目录或 build cache。需要独立 HOME/TMP 时由启动器提供环境，不让 runtime 创建目录、重定向环境或探测隔离是否成立。固定只读依赖/cache可共享，必须进 seed identity。

独立 workspace、DSH_HOME 和临时目录隔离可写状态；ProposerView 裁剪和 CAS 读取授权限定框架公开数据。本地公开任务直接沿 DSH 原生能力运行，不增加容器/OS sandbox 自检或统一 unsupported-isolation 门禁。隐藏数据保留在 worker 的 bash/MCP 无法访问的 verifier/broker 或部署读取边界；同一用户下的独立目录不能单独提供这种保护。包含隐藏评测时，由部署提供实际读取隔离，框架不凭目录名宣称其成立。

DSH 本体凭据不进入工具子进程。固定 domain broker 可保管 EDA license/service secrets；Method tool 只拿到获准 service 的请求接口。

Capsule 是 host resource lease，不建立领域状态机；seed、mode、lease key、exit/cleanup status进入 Evidence。创建/销毁失败不改变已有结果为通过，也不可复用受污染环境。

### 15.2 Evidence schema 与 supporting CAS 对象

~~~ts
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

interface SessionCut {
  readonly sessionId: string
  readonly from: number  // inclusive
  readonly to: number    // exclusive；DSH sequence 语义在实现期验证
}

interface BudgetReservation {
  readonly tokens: number
  readonly steps: number
  readonly deadlineAt: number  // Unix epoch ms
}

interface Evidence {
  readonly v: 1
  readonly task: TaskRef
  readonly runId: string
  readonly contractDigest: Digest
  readonly method: MethodRef
  readonly inputs: readonly ObjectRef[]
  readonly outputs: readonly ObjectRef[]
  readonly composition: CompositionRef
  readonly verification: {
    readonly provider: AssetRef
    readonly operationId: string
    readonly publicReceipt: ObjectRef
    readonly privateReceipt?: ObjectRef
  }
  readonly usage: UsageRecord
  readonly sessionCut: SessionCut
  readonly environment: { readonly seed: Digest; readonly mode: string }
  readonly digest: Digest
}

interface ExecutionRecord {
  readonly v: 1
  readonly taskId: string
  readonly runId: string
  readonly contractDigest: Digest
  readonly method: MethodRef
  readonly composition: CompositionRef
  readonly inputs: readonly ObjectRef[]
  readonly outputs?: readonly ObjectRef[] // 可缺；partial outputs 不是 acceptance 依据
  readonly usage: UsageRecord
  readonly sessionCut: SessionCut
  readonly reason: string
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
~~~

privateReceipt 不返回 worker/RSI；publicReceipt 有 criterion ID、pass/fail/invalid、公开错误与可用 metric，不能携带隐藏用例答案。

ExecutionRecord 用于 no-submission、stop、cancel、预算终结或无效验收结果：有同样的身份、usage、sessionCut、reason，可缺 verification/outputs；它不能被冒充成 verified Evidence。

`run/closed.usage` 是该 Run closure 的最终 usage 快照；若同时引用 Evidence/ExecutionRecord，其内嵌 usage 必须与 fact.usage canonical-equal。两者由同一 writer 在同一 command 中产生，不是两套独立计量。

`UsageRecord` 必须把模型消耗按 owner 分类保存：普通 Task Run 的 input/output usage 归属该 Task，并向 root subtree 汇总；Contract Summary Worker 的消耗放在 `summary` 子记录中，带 `ownerTaskId`、`sourceContract` 和 known/unknown token counts，归属拥有该合同的 Task，并计入其 root trace 与 evaluation slot 成本；RSI proposer 的消耗归属 Round proposer budget；evaluation slot 内的摘要消耗归属该 slot。feedback tool 和 scheduler feedback 没有模型 usage。usage 已知计数与 unknownRequests 单独表达。未知不等于 0，不能据此宣称节约成本。预算按宿主已报告 usage 在请求边界控制；计量不可用时停止继续购买请求，保留 incomplete usage。在途请求的真实尾部消耗完整记账，contextWindow 不作 token 预留。`summary?` 是本节既有子记录；不增加 `ContractSummary.usage` 字段，不新增 usage fact。RSI proposer usage 仍留在 Round 预算/宿主记录，本规范不为 `rsi/round-closed` 增加 usage 字段。

composition 记录：DSH 确切包/配置 identity、platform prompt digest、Task contract、局部 template/guidance、skills 完整 bundle、MCP server manifest/bundle/schema/config、模型路由、资源 snapshot、初始 seed。后续 direct child input snapshot 用 asOf+refs记录，不伪装为启动前已知。

Receipt、preview/read receipt、precheck receipt、comparison、approval 一律是 CAS `ObjectRef`；fact 不内联 receipt 内容。`privateReceipt` 只在 Evidence 内，不进入 fact、NodeView、ProposerView 或模型输出。

`CancellationCut` 是 `task/closed` 引用的不可变 CAS 快照：它在受影响的 DSH 执行原生结束后，记录目标 Task、受影响的 descendants/Runs 与最终 ExecutionRecord refs。最终 usage/sessionCut 已在记录中；trace 只引用既有完整记录，不补写尾部费用，不覆写旧 Evidence。

### 15.3 Acceptance receipt 与 submission manifest

`PublicReceipt` 与 `SubmissionManifest` 是 `object` domain 的 strict CAS 对象，不是 authority、fact 或第二账本。它们分别由独立 verifier 和 host 产生；worker/模型不能提交其字段、总 verdict、digest 或 checks。两者均拒绝未知字段、未知版本、缺字段和以 `null` 代替 optional；结构化对象 digest 按 §4.0 去掉最外层 `digest` 后计算 JCS。

~~~ts
interface VerifyRequest {
  readonly operationId: string
  readonly task: TaskContract
  readonly inputs: readonly ObjectRef[]
  readonly outputs: readonly ObjectRef[]
}

interface PublicExitStatus {
  readonly code: number | null   // 进程退出码；signal 终止时为 null
  readonly signal: string | null // 原始 signal 名；正常退出时为 null
}

interface PublicCriterionResult {
  readonly id: string
  readonly verdict: 'pass' | 'fail' | 'invalid'
  readonly reason: string
  readonly metric?: {
    readonly name: string
    readonly unit: string
    readonly value: number      // finite number
  }
  readonly score?: number       // finite number；必须伴随 metric
}

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
  readonly digest: Digest       // object domain；最外层 CAS seal
}

interface SubmittedOutput {
  readonly id: string
  readonly path: string
  readonly kind: 'file' | 'tree'
  readonly role: 'deliverable' | 'supporting'
  readonly required: boolean
  readonly object?: ObjectRef   // required=true 时必填；可选输出未冻结时可缺
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
  readonly bytes: number        // 非负安全整数
  readonly symlinks: 'none'     // host 在冻结时检查产物 leaf 和 tree 枚举项的断言
}

interface SubmissionManifest {
  readonly v: 1
  readonly taskId: string
  readonly runId: string
  readonly contractDigest: Digest
  readonly includeLearningDrafts: boolean
  readonly outputs: readonly SubmittedOutput[]
  readonly learningDrafts: readonly SubmittedLearningDraft[]
  readonly checks: readonly SubmissionCheck[]
  readonly digest: Digest       // object domain；最外层 CAS seal
}
~~~

**PublicReceipt 规则**

1. `v` 只允许 `1`；未知字段、未知版本、缺字段拒绝。
2. `provider` 使用 `object` domain，且与 §4.3 解析出的 acceptance provider、`Evidence.verification.provider` 在 `id`/`digest` 上完全相等。
3. `operationId` 非空，必须等于 `VerifyRequest.operationId` 和 `Evidence.verification.operationId`；固定值 `runId + ':verify'`。同一活跃 Run 内命令幂等返回不得重新生成；新 Run 使用新的 `runId + ':verify'`。
4. `contractDigest` 必须等于冻结 `TaskContract.digest` 和 `Evidence.contractDigest`。
5. `inputDigests` 是 verifier 授权输入 `ObjectRef` 的 digest 有序数组，包含冻结合同输入及已授权的 direct child outputs，必须与 `Evidence.inputs[].digest` 逐位相等并来自同一 snapshot。`outputDigests` 是从 `SubmissionManifest` 派生给 verifier 的冻结输出 `ObjectRef` 的 digest 有序数组，必须与 `Evidence.outputs[].digest` 逐位相等。不排序、不去重、不补默认值。
6. `criteria` 的 ID 集合必须恰好等于 `TaskSpec.criteria` 中 `required=true` 的 ID 集合；每条恰好一次；缺项、重复、未知 ID、非 required criterion 均拒绝。空 required set 是否允许准入由既有 admission policy 决定；不得增加“空 criterion 自动 verified”的放宽。
7. `reason` 对所有 verdict 必填且必须是公开可读文本；不得包含隐藏用例答案、fixture 内部路径、golden data 或 private verifier recipe。
8. `metric`/`score` 只允许出现在 `pass`/`fail` criterion；`invalid` criterion 不得携带 `metric` 或 `score`。`metric.name`/`metric.unit` 非空，`metric.value` 与 `score` 必须是有限 number（拒绝 `NaN`、`Infinity`、字符串和超出 JSON 数值模型的输入）。`score` 必须同时出现 `metric`。
9. `exit` 是原始进程终止状态：`code` 为整数或 `null`，`signal` 为字符串或 `null`；对实际产生终止状态且未超时的进程，恰好一个非 `null`。`signal` 只记录真实 signal，不能用来表达 timeout。两者都为 `null` 且 `timedOut=false` 使 receipt 无效。
10. `timedOut` 是必填 boolean，独立于 `exit`。`timedOut=true` 表示 verifier 超时；此时 `exit` 可以是 `{ code: null, signal: null }` 或强制终止后的原始状态，但 host 必须按 `invalid` 结算，不得用 signal 模拟 timeout。
11. receipt 不包含 `at`/`asOf`/随机 ID/agent ID/usage；这些要么属于 Evidence/DSH 记录，要么会破坏内容寻址和重放幂等。
12. `digest` 是 `object` domain 的最外层 seal，不是新的业务字段；`PublicReceipt` 本身不是 Evidence，host 把它放入 `Evidence.verification.publicReceipt` 后才形成验收证据。
13. receipt 不设总 verdict 字段；`verified`/`failed`/`invalid` 只由 host 按本节规则派生，避免 verifier 用总 verdict 绕过逐 criterion 校验。

**Host 分类、exit 与 timeout**

| 条件 | host 结果 |
|---|---|
| receipt strict 有效；provider/operationId/contract/input/output digest 全匹配；required criteria 恰好一次且全部 `pass`；`timedOut=false`；`exit={code:0,signal:null}` | `verified` |
| receipt strict 有效；身份/digest 匹配；至少一条 required criterion 为 `fail`；没有 required criterion 为 `invalid`；`timedOut=false`；`exit.code` 非 null 且 `signal=null` | `failed`；exit code 可以是 0 或非 0，exit=0 不能覆盖 fail |
| 任一 required criterion 为 `invalid`；或 `timedOut=true`；或 `signal` 非 null；或 `exit` 两者皆 null 且未超时；或 receipt 缺失/畸形；或 provider/operationId/digest 不匹配；或 criteria 缺失/重复/未知/非 required；或 metric/score 非有限；或 `invalid` 携带分数；或全部 pass 但 exit code 非 0 | `invalid` |
| 没有 submit（no-submission/stop/预算终结） | 走 `ExecutionRecord`；不需要 acceptance receipt，也不因“没有 receipt”判 `invalid` |

- exit=0 是 `verified` 的必要但不充分条件：它只有在 receipt 完整、身份/digest 匹配、required criteria 全部 pass、`timedOut=false` 且 `signal=null` 时才成立。
- exit=0 不能把 fail 变成 verified；非 0 exit 也不能单独决定 failed：有完整 fail receipt 且进程未超时/未被信号终止时为 `failed`，receipt 不完整或全部 pass 却非 0 时为 `invalid`。
- `timedOut=true` 是基础设施/超时 invalid，不是领域 failed，不给领域分数；不得用 `signal` 或特殊 exit code 代替。
- `invalid` receipt 仅作诊断：不得 seal 成 Evidence，也不得扩展 `ExecutionRecord` 来引用它；closure 使用现有 `ExecutionRecord(invalid)`。`failed` 可以有有限失败分；`verified` 可以携带公开 metric/score，但不能由模型自报；`invalid` 没有领域分数。

**SubmissionManifest 规则**

1. `v` 只允许 `1`；未知字段、未知版本拒绝。
2. `taskId`、`runId`、`contractDigest` 必须与当前 open/submitted 的 Run 和冻结合同一致；不得由模型或 submit 参数提供。
3. `outputs` 包含 `TaskSpec.outputs` 中所有非 draft 输出（`role` 为 `deliverable` 或 `supporting`），顺序严格等于合同声明顺序；不得按 id/path 排序。每个 output 的 `id`/`path`/`kind`/`role`/`required` 原样来自冻结合同；id 与 path 均唯一。
4. `required=true` 必须有 `object`；可选 supporting 输出未产生时可以没有 `object`，且不得成为 acceptance 依据。
5. `learningDrafts` 是必填数组，不是 optional 字段。没有冻结 draft 目录时为空数组；有目录时只允许固定 `__skill-drafts`（skill 在前）与 `__mcp-drafts`（MCP 在后），各项必须 `kind='tree'`、`required=false` 且带 `object`。`learningDrafts` 中的 id/path 不得与 `outputs` 重叠。
6. `includeLearningDrafts` 是必填 boolean。`false` 时 `learningDrafts` 必须为空；`true` 时按实际存在的目录冻结，目录缺失不失败、对应数组为空或只含存在项。
7. `checks` 是必填数组，不是 optional 字段。每个已冻结输出（`outputs` 中带 `object` 的项，加上 `learningDrafts` 的项）各提供恰好一条，`outputId` 唯一；顺序先按 `outputs` 合同顺序，再按 `learningDrafts` 固定顺序。未冻结的可选输出没有 check 条目；没有冻结输出时 `checks=[]`。
8. `bytes` 是非负安全整数；`symlinks: 'none'` 表示 host 在冻结时对 file 本体、tree 根及原生目录枚举项做了 leaf 检查，未发现 symlink；不表示遍历 workspace 祖先。它不是对 CAS bytes 的密码学证明，见下文证据边界。
9. manifest 不包含 `at`/`asOf`/随机 ID/agent ID/私有 receipt/validation payload；同样是为了内容寻址和重放幂等。
10. `digest` 是 `object` domain 的最外层 seal；`run/submitted.outputs` 引用该 manifest 的 `ObjectRef`，`singularity_submit` 返回的 `submissionRef` 也指向同一 ref。manifest 不是新的 fact，也不是第二账本。

**稳定排序与 Evidence 输入**

- 非 draft `outputs`：严格按 `TaskSpec.outputs` 中非 draft 项的声明顺序；base 与 local supporting 的相对顺序不得改变。两个 draft 声明不进入 `outputs`，而是按固定 skill → MCP 顺序进入 `learningDrafts`；这不是对合同声明顺序的重新排序，因为 draft 在合同中本来就固定在最后。
- `learningDrafts`：固定 skill 在前、MCP 在后；无目录时为空数组。
- `checks`：先按 `outputs` 中有 `object` 的项，再按 `learningDrafts` 顺序；无冻结输出时为空数组。
- `PublicReceipt.inputDigests`：按 verifier 授权输入顺序，包含冻结合同输入和已授权的 direct child outputs；`Evidence.inputs` 必须由同一 snapshot 派生并逐位一致。
- `PublicReceipt.outputDigests`：按 manifest 派生给 verifier 的冻结输出顺序（`outputs` 中有 `object` 的项，再按 `learningDrafts`）；`Evidence.outputs` 必须逐位一致。
- 数组顺序是 JCS/digest 的一部分；同一组文件但顺序不同必须产生不同 manifest/receipt digest，并按身份不匹配拒绝，不能静默排序后接受。
- 所有 schema 不包含时间戳或随机值；同一合同、同一冻结 bytes、同一顺序应产生同一 manifest/receipt digest。

**Symlink、size 与证据边界**

Host 在写 manifest 和 `run/submitted` 之前必须完成：

1. 声明的 `path` 必须是 workspace 内相对路径，规范化后不得为绝对路径、不得含 `..`、不得命中保留 draft ID/path。
2. 对 `file` 使用原生 O_NOFOLLOW/O_NONBLOCK 打开并以 fd stat 确认普通文件和大小；对 `tree` 使用原生递归 readdir/Dirent 形成稳定排序清单，拒绝 symlink 和非普通文件/目录项，再按同一 leaf 读取路径冻结。无需 ancestor walker 或逐项重复 lstat。hardlink 是否拒绝由部署 policy 决定，不由 manifest digest 证明。
3. 按部署 policy 检查 size cap；框架不冻结 output size 上限，本规范不新增协议级 limit，也不在 manifest 中写 cap/policy。`checks.bytes` 只记录冻结时观测到的总 bytes。
4. 先在 workspace 中检查，再把 bytes 写入 CAS，重读并校验 object digest；manifest 只在所有 required 输出成功冻结后写入。
5. 冻结后 verifier 只读 CAS，不回读活动 workspace；因此 workspace 在冻结后的变化不能改变本次 submission。

证据边界：

- manifest digest 能证明 manifest 内容（包括 `checks`、refs、声明顺序）未被篡改，也能通过 object ref 重验冻结 bytes。
- `checks.symlinks='none'` 和 `bytes` 是 host 写入的断言，不是密码学证明；digest 不能证明 host 真的执行了正确遍历，也不能证明 traversal 与 freeze 之间没有 TOCTOU。可信度来自单一 trusted writer 和冻结前检查，不来自哈希本身。
- 检查结果放在 manifest 的 required `checks`，不另立 check receipt/账本。若未来需要独立检查 receipt，必须另提 amendment；当前把它作为替代实现会与本节不兼容。
- 缺失 required output、symlink、越界 path 或 size 超限必须在 manifest/fact 之前拒绝 submit；已写入但未被 fact 引用的 CAS 对象是 orphan，不是业务成功。

**Domain、privateReceipt 与 invalid receipt**

- `AcceptanceRef`、`PublicReceipt.digest`、`PublicReceipt.provider`、`SubmissionManifest.digest` 及 manifest 中输出对象引用都使用 `object` domain；`PublicReceipt.inputDigests`/`outputDigests` 只保存既有 object digest 值。`Evidence.digest` 使用 `evidence`；`ExecutionRecord.digest` 使用 `object`。domain 集合保持 §4.0 的 9 个，不新增 `receipt`、`submission` 或 `acceptance` domain；不得用 `evidence` domain 计算 receipt/manifest，否则会与 EvidenceRef 混淆并破坏“ExecutionRecord 不得冒充 Evidence”的边界。digest 匹配不是读取授权。
- `privateReceipt` 只作为 `Evidence.verification.privateReceipt?: ObjectRef` 存在，是 opaque CAS object，本规范不冻结其 schema；不进入 `PublicReceipt`、`SubmissionManifest`、fact、NodeView、ProposerView、模型输出、feedback refs 或 submit 结果。public `reason`/`metric`/`score` 必须是公开安全内容；隐藏用例、答案、golden data、private fixture 路径和 private verifier recipe 只能留在 private receipt 或受权 evaluator/verifier scope。一个 Run 可以只有 public receipt 而没有 private receipt；缺失不是失败。host 在生成 public receipt、feedback、祖先查询、RSI trace 和 direct child 结果时必须过滤 private refs；digest 相等不等于读取授权。
- no-submission、显式 stop、无效验收结果、cancelled 使用 `ExecutionRecord`，保留 taskId/runId/contractDigest/method/composition/inputs/usage/sessionCut/reason，可缺 outputs/verification；它不能被冒充成 verified Evidence。没有提交的失败 Run 可以有 ExecutionRecord，但没有 acceptance receipt；不得为了统一数据外观伪造 `PublicReceipt`。`run/closed` 仍恰好引用一个结果：verified 或带 Evidence 的 criteria-failed 使用 `evidenceRef`；no-submission/stop/invalid/cancelled 使用 `executionRecordRef`。
- 已 submit 但 verifier 合作取消超时或返回含 `invalid` criterion 的 receipt 时：host 按 `invalid` 结算，使用现有 `ExecutionRecord(invalid)`；invalid receipt 仅可作为 operator 诊断留存，不得写入 Evidence，也不得扩展 `ExecutionRecord` 增加 receipt 字段，不进入 NodeView/ProposerView/公开 trace。
- fresh retry 使用新 Run/session/workspace，合同与 Method 不变；旧 receipt/manifest 不复制、不覆盖、不自动成为新 Run 的验收结果。新 Run 只有重新 submit 并重新验收才可能 verified。
- `PublicReceipt` 与 `SubmissionManifest` 都是 CAS 对象；host 先写对象，再 append 引用它们的 fact。它们不新增 journal 行、fact type、writer 或 fold。同一 commandId + commandDigest 重放时返回原 `Fact` 及其原 manifest/receipt refs，不重新冻结、不重新验证、不追加 fact。
- verifier 直接消费冻结 inputs/outputs，返回 PublicReceipt；host 校验身份、digest 与验收结果后沿同一结算路径写 `run/closed`。固定 operationId 保留请求身份；不预建掉电查询、外部 receipt 核对或持久化两阶段执行机制。manifest/receipt 的稳定排序、无时间戳和独立 `timedOut` 定义可重复的 digest；闭合结果直接读取已有 refs。
- `seq`/`prev`/`commandDigest` 保留冻结事实身份；SQLite 事务和唯一约束负责提交。CAS 在实际读取时验证 domain/digest，不在归档打开时递归验证所有引用；不存在 torn-tail 修复或 crash reconcile。DB 主键/外键不能证明外部 receipt 绑定，§15.3 的验收身份检查保留。

## 16. 从 root terminal 到一个 RSI Round 结束

这是 v1 的完整业务时序；每一步都对应一个 owner、一个可见输入和一个允许的 side effect。

| 步 | owner | 输入 | 可见模型 | side effect / 结果 |
|---:|---|---|---|---|
| 0 | operator/domain | 现实 goal、验收、输入、输出、verifier | 无 worker | contract draft |
| 1 | intake service | contract draft、MethodRef、resource snapshot | 无 worker | 冻结 TaskContract；task/admitted |
| 1a | Contract Summary Worker | frozen contract digest | 无 worker | 异步写入 `contractDigest → ContractSummary` 索引；缺失时 ancestor query 返回 `SUMMARY_PENDING` |
| 2 | runtime | TaskView、budget、capsule seed | 当前 Task worker | run/opened、DSH Agent ready |
| 3 | worker | role card、NodeView、own template brief、bindings list | 当前层模型 | read self、submit PlanningSketch、按需读祖先/资源、工作 |
| 4a | worker/runtime | 一个 child binding | 当前层模型 | prepare 返回 full example；无 child fact |
| 4b | worker/runtime | ack + child TaskSpec | 当前层模型 | 生成 child contract；一次 children-admitted；父等待 |
| 5 | runtime | child contracts | child workers | 每 child 独立 Run、workspace、上下文和预算 |
| 6 | parent runtime | direct child Task terminal facts、TaskFeedback | parent worker | 审计挂载 outputs/feedback；active batch 完成后 parent wake |
| 7 | worker | own outputs + direct child outputs + feedback | 当前层模型 | revise sketch、replan、下一批或 submit |
| 8 | verifier runtime | frozen output/input objects | 无 worker | receipt / ExecutionRecord |
| 9 | task service | run outcome + child join | 无 worker | run/closed；task closed 或 retry |
| 10 | trace service | closed root + settled descendants | RSI proposer | rsi/trace-sealed；形成可重复的 RsiRound |
| 11 | RSI proposer | sealed trace、base Method、公开 registry | 仅 proposer | rsi/proposal-submitted；MethodPatch |
| 12 | precheck | patch + base digest + allowed scope | 无模型 | candidate Method 或 rejection |
| 13 | evaluator | candidate/base + frozen case plan | 无 proposer | paired candidate Runs |
| 14 | comparator | public Evidence + frozen validation/holdout policy | 无模型 | rsi/round-closed(improved/no-improvement/insufficient) |
| 15 | operator/activation | round outcome、CAS previous head | 无 worker | method/activated；新 root 才使用 |

### 16.1 Root task 完成的 precise 条件

Root 不能因为模型最后说 done 而进入 RSI。必须：

~~~text
all Task descendants terminal
every admitted Run closed, including historical failures/cancellations;
  retry/required-child policies resolved, not every historical Run successful
root decisive Run has a valid public verifier receipt, or a terminal failed/invalid
  ExecutionRecord accepted by the frozen RSI eligibility policy
if root outcome is verified, every required binding in the decisive Run has a
  non-superseded verified child winner and every admitted child is terminal
all owned DSH AgentHandles completed native whenIdle/dispose
final usage/session offsets recorded before closure
all artifact/object refs and digests readable
rsi/trace-sealed appended exactly once
~~~

如果任何一项不满足，状态是 not-sealed 或 invalid；proposer 不得消费部分轨迹。

### 16.2 trace 的内容与 prompt 负载

trace 对 RSI 是 CAS object，不是一次性巨型 prompt。proposer 首次看到：

~~~json
{
  "traceId": "trace-...",
  "rootTask": { "id": "...", "outcome": "verified", "method": "..." },
  "chapters": [
    { "id": "contract", "sizeClass": "small", "digest": "..." },
    { "id": "timeline", "sizeClass": "paged", "digest": "..." },
    { "id": "children", "sizeClass": "paged", "digest": "..." },
    { "id": "evidence", "sizeClass": "small", "digest": "..." },
    { "id": "tool-use", "sizeClass": "paged", "digest": "..." }
  ],
  "readPolicy": { "pageMode": "bounded-paged", "allow": ["contract", "timeline", "children", "evidence", "tool-use", "planning", "feedback"] }
}
~~~

模型按需调用 rsi_read page。source 读取只覆盖本次 root；轮间反馈只提供下述一个公开投影，不开放其他 root、validation 或 private objects。trace index 同时展示已封存的 subtree usage 和至多三个高成本 Run 的公开 usage 排序，base Method index 提供 entry template 的 guidance/example 引用与资产数量；大库正文按页读取。

children 章节索引整次 root 的全部 descendants，每个节点均能追到本次各 Run 的公开模型消息、tool call/result 和 acceptance/ExecutionRecord。这里的 transcript 是 DSH 实际持久的公开轨迹，不要求模型供应商提供内部推理。seal 固定 source resource snapshot，后续资源更新不扩大 proposer 权限。

~~~ts
interface ProposerView {
  readonly v: 1
  readonly roundId: string
  readonly sourceTrace: TraceRef
  readonly baseMethod: MethodRef
  readonly publicEvaluation: {
    readonly goal: string
    readonly metric: string
    readonly thresholds: readonly string[]
    readonly validationPolicy: 'none' | 'required-by-domain'
    readonly publicCases: readonly { readonly id: string; readonly description: string }[]
  }
  readonly previousRound?: {
    readonly roundId: string
    readonly outcome: 'improved' | 'no-improvement' | 'insufficient-evidence' | 'rejected' | 'cancelled'
    readonly readKind: 'previous-round'
  }
  readonly remainingBudgetPct: {
    readonly tokens: number
    readonly steps: number
    readonly wallClock: number
  }
  readonly readPolicy: { readonly kinds: readonly string[]; readonly pageMode: 'bounded-paged' }
}
~~~

ProposerView 是独立的读取授权结果。`publicCases` 只含领域公开描述和 case identity；validation/holdout 的 input、answer、hidden test、private verifier recipe 只在 evaluator/verifier scope。分页大小由 host guard 固定，ProposerView 内的预算字段只展示百分比。

`previousRound` 由当前 Round 开启之前的 journal 顺序确定：仅选择同一 base Method 最近一个已关闭 Round。`rsi_read(kind='previous-round')` 按页返回该轮的公开 hypothesis、outcome/reason，以及已有 comparison 的 complete、metric、aggregateDelta、worstRegression、cost。它不返回 per-case 数据、slot、case/trace/receipt 引用或私有 payload，不授予对上一轮对象的任意读取。没有上一轮时省略此索引。投影直接从既有 patch/closure/comparison 派生，无新 fact、状态机或跨轮执行 Agent；本次 proposer 使用同一开启前截面。

## 17. RSI proposer 协议

### 17.0 Round 状态机

~~~text
不存在 ─ rsi/round-opened ─▶ proposing
proposing ─ rsi/proposal-submitted ─▶ checking
checking  ─ rsi/candidate-ready ─▶ evaluating
proposing / checking / evaluating ─ rsi/round-closed ─▶ closed
~~~

checking 是固定 host procedure，不驱动 proposer 追加领域工作。closed outcome 为 improved、no-improvement、insufficient-evidence、rejected 或 cancelled。前两种必须有完整比较证据；rejected 是 proposal 未通过准入，不是假装评测过后输了。

没有 proposal 的正常 turn/end 记 insufficient-evidence/no-proposal；达到 deadline 记 insufficient-evidence；proposer 宿主/provider 失败抛出并终止本轮尝试，不伪造 Round closure；operator 取消记 cancelled。每 round 只提交一个正式 patch；无效工具参数可以在提交前纠正，但不反复购买一系列候选。

candidate-ready 同时把生成的冻结 Method 加入只读 revision catalog，并保存 precheck/MCP bundle manifest receipt。不再对同一候选另外写一条 method/registered。method/registered 仅用于初始化或人工导入既有方法。

### 17.1 proposer agent 的 composition

proposer 是 DSH Agent，但不是普通 Task worker：

~~~text
固定 RSI role card
+ trace index / base Method index
+ rsi_read / rsi_submit_patch
+ 允许的只读 public domain catalog
~~~

它可以先调用 rsi_read 获得完整某页，唯一工作产物是结构化 patch；没有不明确定义的“自动改库”或“临时执行实验”入口。

固定 RSI system card：

~~~text
You improve one pinned Method using one sealed root execution trace.
Read the pinned Method and the original guidance/example assets you will change.
Use the source contract, acceptance, subtree usage and relevant trace pages to
identify an observed bottleneck. Consult the public protocol resource for runtime
rules. Distinguish domain failures from infrastructure errors and protocol misuse.
Align one causal hypothesis with the frozen evaluation metric and thresholds.
If correctness is already saturated, extra correctness prose cannot raise it.
Read previous-round feedback when present; revise an unsuccessful hypothesis
using its measured result. Preserve useful assets and choose the smallest
executable change that addresses the evidence. Children own their local workflow.
Start with the indexed costliest Runs and read the trace pages that test your
hypothesis; submit when the evidence supports a concrete change. Keep the patch
concise: put each reusable instruction in one asset and refer to it from guidance.
Use short guidance naming operations and their inputs/outputs; keep detailed code
in one skill or MCP asset. Send one JSON object as the tool arguments.
Submit one reusable MethodPatch with rsi_submit_patch. Templates, guidance,
examples, skill/MCP assets and bindings may evolve; host precheck, evaluation
and activation approval determine the result.
~~~

工具定义：

~~~text
rsi_read
  input: { kind: proposer-view | trace-index | trace-page | method | asset | public-resources | previous-round,
           id?, cursor?, page? }
  output: { data, objectRef, nextCursor?, remainingBudgetPct }
  scope: 本次 source trace、base Method、source 中的 drafts、公开能力目录、公开 RoundPlan，以及同 base 最近一个 closed Round 的限定公开反馈
  proposer-view 不含 validation/holdout 的具体输入、答案、隐藏测试或 private verifier recipe

rsi_submit_patch
  input: { patch: MethodPatch }
  output: { submitted: true, proposalRef, remainingBudgetPct }
  guard: base 一致、无既有正式 proposal、schema/size 合法
  effect: 冻结 patch，append rsi/proposal-submitted，concludeTurn
  后续：runtime 在 turn 外排空 proposer，运行 precheck 和 paired evaluation
~~~

候选大小上限固定为 patch 256 KiB、最多 64 次资产操作。大库通过分页读取；单轮不要求重写全库。工具不接受模型给出的 output digest、score 或 approval。

### 17.2 Patch 结构与允许演化

~~~ts
interface MethodPatch {
  readonly v: 1
  readonly base: MethodRef
  readonly hypothesis: string
  readonly changes: readonly (
    | { readonly op: 'put-template'; readonly template: TemplateDraft }
    | { readonly op: 'remove-template'; readonly id: string }
    | { readonly op: 'put-skill'; readonly skill: SkillDraft }
    | { readonly op: 'remove-skill'; readonly id: string }
    | { readonly op: 'put-mcp-server'; readonly server: McpServerDraft }
    | { readonly op: 'remove-mcp-server'; readonly id: string }
    | { readonly op: 'set-entry'; readonly templateId: string | null }
  )[]
  readonly predictedRisks: readonly string[]
  readonly transferPlan: string
}
~~~

TemplateDraft 提供 guidance 文本、完整 example JSON 及全部 skills/MCP servers/children 绑定；put-template 是一个完整局部模板的替换，能够表达新增/删除绑定、修改下一级关系。SkillDraft/McpServerDraft 提供相对文件名到 UTF-8 源码的映射、server manifest、tool schemas 和配置。host 生成 ObjectRefs、bundle digests 与部署 receipts，模型不手填虚假的计算结果。

~~~ts
type TemplateDraft = Omit<TaskTemplate, 'guidance' | 'example'> & {
  readonly guidance: string
  readonly example: TaskExample
}
type SkillDraft = Omit<SkillAsset, 'bundle'> & {
  readonly files: Readonly<Record<string, string>>
}
type McpServerDraft = Omit<ToolAsset, 'server'> & {
  readonly server: {
    readonly files: Readonly<Record<string, string>>
    readonly manifest: JsonValue
    readonly config: JsonValue
    readonly transport: 'stdio' | 'streamable-http'
    readonly capabilities: readonly string[]
    readonly exposedTools: readonly {
      readonly name: string
      readonly description: string
      readonly parameters: JsonSchema
      readonly output?: JsonSchema
    }[]
  }
}
~~~

files 仅允许相对 bundle 路径，拒绝绝对路径、..、symlink 和保留宿主文件。SkillDraft 必须有 SKILL.md；McpServerDraft 必须有可解析 manifest、配置、transport、capability 列表和至少一个 exposed tool schema。MCP server 的语言、依赖和实现形式由 bundle 声明，patch 不能自行修改宿主级 transport 或部署权限。

同一 patch 可以同时新增 skill/MCP server/template 并建立引用；所有变更一次应用后再验证最终目录。保留未使用模板合法；悬空引用、重复 ID 和删除后仍被引用的资产拒绝。改变 entry 只影响未来 root 的模板选择，不改变 root 的真实业务合同。

set-entry(null) 清除入口，使未来 root 使用平台 exploration 入口；目录中的其他资产可以保留。固定平台 explore-child 不能被同名 Method 资产覆盖。

引用既有对象只能来自 base Method、获准 source artifacts/drafts 或公开资源；不能以“猜中 hash”为理由读取任意 CAS 对象。

patch 不支持 edit-live-task、set-verifier、set-scorer、set-input、set-model、set-platform-prompt、run-evaluation 或 activate。

ToolAsset 只有 MCP server 形态。RSI 可以新增或改进 server bundle、manifest、exposed tool schemas、配置和实现源码；host 校验 bundle 引用和所消费字段的 schema，生成 candidate 的 MCP server asset。MCP bundle 在启动前经操作者/领域部署信任；capabilities 是描述性 metadata，不作 OS 授权或防逃逸证明，不建立 capability allowlist、exact-key manifest/config policy 或源码扫描。正式绑定只发生在未来 Task 的 DSH MCP scope。新增宿主级 transport、broker 权限或秘密凭据属于独立领域部署变更，不由 MethodPatch 自动取得。工作中的 Task 仍只产出 MCP draft。

### 17.3 proposal precheck

确定性 precheck 检查：

~~~text
base digest == current round base
exact schema / size / canonical JSON
only allowed Method fields changed
template bindings form a finite reusable catalog
template instance schemas cannot add root verifier/scorer
skill content and MCP server bundle/manifest/config digests resolve
MCP consumed config fields satisfy schema; deployment fixes trusted bundles and actual OS permissions
every exposed MCP tool has a stable name and schema matching the manifest
asset paths are relative and remain inside their declared bundle
patch applies deterministically and is not no-op
~~~

precheck 只执行上述确定性校验。正向 guidance 是作者写作原则，不是关键词、否定词或句式门禁；MCP 源码与自然语言内容不作正则、字符串或 AST 语义黑名单扫描。合法 patch 的行为由实际执行与独立领域验收评估。

实际边界由 DSH 的原生 scope 工具注册、部署读取授权、独立冻结 verifier、隔离评测用例、固定预算和可追溯工具调用承担；不增加默认源码审查器或 LLM critic。

确定性候选结构/引用/权限 precheck 不通过时 append rsi/round-closed(rejected)，保存 precheck receipt 和公共 rejection reason；不写 Method head。宿主 CAS/存储异常直接抛出，不写 rejected 或伪造 precheck receipt。MCP bundle 的实际运行由 DSH MCP client 和部署 adapter 负责；本协议只解析所消费字段的 schema，保留冻结绑定与实际 native MCP surface 的身份比较，不重新定义 MCP transport。

## 18. Evaluation plan 与可重复 Round decision

Round 是一次 `sealed trace → proposal → candidate → evaluation → result` 的协议单位，不是整个 RSI 系统的轮数上限。每次 Round 只产生一个 candidate；外部可以在上一 Round 完成后用新的 sealed root trace 重复调用同一协议。连续 Round 不新增 Campaign authority。

~~~ts
interface RoundPlan {
  readonly v: 1
  readonly cases: readonly CaseRef[]
  readonly metric: MetricSpec
  readonly thresholds: {
    readonly minDelta: number
    readonly maxRegression: number
    readonly maxRelativeCostIncrease?: number
  }
  readonly trialsPerCase: number
  readonly proposerBudget: {
    readonly maxSteps: number
    readonly maxTokens: number
    readonly maxWallClockMs: number
  }
  readonly budget: {
    readonly maxRuns: number
    readonly maxTokens: number
    readonly maxWallClockMs: number
    readonly maxActiveRuns: number
  }
  readonly validation: 'none' | 'required-by-domain'
  readonly validationCases: readonly CaseRef[]
  readonly claim: 'source-replay' | 'domain-evaluation'
  readonly comparator: AssetRef
  readonly sourceSeed: ObjectRef
  readonly expectedPreviousActiveMethod: MethodRef
}
~~~

RoundPlan 在 rsi/round-opened 时冻结，必须先于 proposer 第一条请求。proposer 只能看到评价目标、资源限制和 source 的公开 proposer view；看不到 private case inputs/answers，也不能改 plan。模型可见的预算统一转换为 proposerBudget 的剩余百分比，精确数值留在 host。

CaseRef 引用的是不含 Method 的固定 root TaskSpec、acceptance、初始 seed、global resource snapshot 和 limits。source replay 必须从 source admission 时的原始 seed 重建，不能把 source 已解决的工作区作为候选输入。

base/candidate 每个 case 使用相同 goal、acceptance、inputs、verifier、model route、budget；只有 Method revision 不同。每个 trial 有新 capsule、新 session、新 workspace。trial root 仍是普通 Task，可按相同预算递归分解，不能在评测中一律关闭分解而让模板改进无法生效。

在 plan 中预列 case × arm × repetition 的全部 slot IDs 和确定顺序；task/admitted 的 evaluation purpose/requestRef 关联对应 slot。同一活跃进程内每个 slot 关联唯一 Task；执行退出后只归档，新的尝试使用新执行根和 IDs。未启动、cancelled、missing 和 invalid 均保留在分母，不能删除不利样本。每次执行失败是否重试由冻结 limits 决定，不重试到通过。

不复用 source 原得分代替一次 fresh baseline。paired 隔离、case 顺序和并发资源 policy 必须一致；需要噪声估计时由领域显式声明重复次数，不默认先购买两轮 A/A。

evaluation purpose 的 root 可以封存调试轨迹，但不会自动再触发 RSI；否则一次评测会递归产生无限改进任务。

比较至少产生：

~~~text
complete cases
per-case public verdict
metric value + direction/unit
median or domain aggregate delta
worst per-case regression
usage complete/unknown
missing/invalid evidence list
outcome = improved | no-improvement | insufficient-evidence
~~~

v1 不发明领域分数。MetricSpec、aggregate、minimum sample 和 threshold 由 domain package 提供；若 domain 没有明确比较器，Round 以 insufficient-evidence 关闭，reason=unsupported-comparator。source replay 只验证协议链路，不能作为领域改进或自动发布依据。

validation=required-by-domain 时，本轮必须按预先冻结的独立 validation/holdout cases 与预算完成验证；未完成则 insufficient-evidence，不产生可发布的 improved。validation=none 可以做 source replay，结论必须标注 claim=source-replay，只验证协议链路，不自动激活 production head。单题变好而领域 validation 退化、成本阈值失败或任一冻结回归条件不满足，不能判为 improved。

### 18.1 比较与 activation 伪代码

~~~ts
async function evaluateCandidate(roundId: string) {
  const round = readRound(roundId)
  const base = resolveMethod(round.base)
  const candidate = resolveMethod(round.candidate)

  // frozenSlots 包含主评测与必要 validation；每项均有确定 Task 身份
  for (const slot of frozenSlots(round.plan)) {
    await runPool.enqueue({
      key: slot.id,
      execute: () => admitOrResumeEvaluationRoot(slot, base, candidate),
    })
  }
  await runPool.drainRoundUntilDeadline(roundId)
  await cancelAndDrainUnfinishedSlots(roundId)

  const manifest = readAllPlannedSlotsIncludingMissing(roundId)
  const comparison = manifest.complete
    ? domain.compare(round.plan, manifest.evidence)
    : insufficientComparison(manifest)
  validateComparisonAgainstFrozenPlan(comparison, round.plan)
  await commit('rsi/round-closed', {
    roundId,
    outcome: classify(comparison),
    comparisonRef: putObject(comparison),
  })
  return comparison
}

function activate(candidate: MethodRef, round: RoundRef, approval: Approval) {
  const state = fold()
  guardRoundImprovedAndComplete(state, round)
  guardDomainClaimAndRequiredValidation(state, round)
  guard(refEquals(state.productionHead, round.plan.expectedPreviousActiveMethod))
  guard(refEquals(state.productionHead, approval.expectedPrevious))
  commit('method/activated', { previous: state.productionHead, next: candidate, approval })
}
~~~

activation 只移动 future root 的 MethodRef。live Task/Run 不被改写。rollback 是新的 activation command，由独立 trusted approval 发起，不是 proposer 工具。

费用判断：总成本含整棵任务树、失败尝试及工具调用，不只算 root。若目标是减少成本，unknown usage 使结论 insufficient；若纯质量目标且成本不是硬门槛，未知成本可以保留质量结论，但禁止声称省钱。规则在 plan 中冻结，不能看到结果后改变。

完整 round procedure：

~~~ts
async function improveOneRoot(sourceTrace: TraceRef, plan: RoundPlan) {
  assertTraceSealedAndEligible(sourceTrace)
  validatePlanAndBudgetBeforePurchase(plan)
  guard(refEquals(readActiveMethodHead(), plan.expectedPreviousActiveMethod))
  await commit('rsi/round-opened', freezeRound(sourceTrace, plan))
  const proposer = await createPinnedRsiAgent()
  await wakeWithStableId(proposer)
  await waitForProposalOrDeadline()
  await drainAndDispose(proposer)
  if (!hasProposal()) return closeRound('insufficient-evidence', 'no-proposal')

  const checked = await precheckAndBuildMethod(loadProposal(), sourceTrace)
  if (!checked.ok) return closeRound('rejected', checked.receipt)
  guard(refEquals(readRound(currentRoundId()).base, readRound(currentRoundId()).plan.expectedPreviousActiveMethod))
  await commit('rsi/candidate-ready', checked) // 同时注册不可变 candidate revision
  return evaluateCandidate(currentRoundId())
}
~~~

round outcome 是统计结果；report 只渲染这些事实。report 写入失败不反转结果，也不会导致重跑本轮。下一 Round 必须引用新的 sealed root trace，并把当前 active Method 作为 `expectedPreviousActiveMethod`；CAS 失败时保留候选和结果，要求重新规划并由 activation operator 决定，不能覆盖并发激活。

## 19. 领域 adapter contract

框架不定义 EDA 或仿真参数，但要求领域 adapter 实现以下边界：

~~~ts
interface DomainAdapter {
  readonly domainId: string
  readonly version: string
  describePublicResources(): Promise<GlobalResourceSnapshot>
  validateRoot(spec: TaskSpec): void
  validateChild(parent: FrozenTask, proposed: TaskProposal, binding: ChildBinding): void
  resolveAcceptance(task: FrozenTask): AcceptanceRef
  describeMcpServers(): Promise<readonly ToolAsset[]>
  mountMcpServers(scope: McpServerScope): void
  verify(request: VerifyRequest): Promise<PublicReceipt>
  compare(plan: RoundPlan, evidence: readonly PublicEvidence[]): Comparison
  seedFor(caseRef: CaseRef): Promise<SeedRef>
}
~~~

verify 的实现与可信级别由部署在启动前确定：公开可信案例可使用进程内领域函数；私有 fixtures、不可信 worker/MCP 或必须强停的 verifier，必须先用现成 OS/容器/固定 broker 建立真实读取、网络和进程边界，不能由 harness 的目录/HOME/metadata 检查替代。adapter 必须转发宿主 deadline 与 operator 取消合并后的 AbortSignal 并等待自己拥有的工作退出；外部取消复用子树取消结算，只有本次宿主 deadline 才分类 verifier-timeout，上游同名 TimeoutError 保留原异常；任意不合作进程内函数不在强停保证内。verify 接收 §15.3 的 `VerifyRequest` 并返回 strict `PublicReceipt`；receipt 中公开 criterion 与 metric，不公开 private fixtures。`resolveAcceptance` 返回 §4.0 `object` domain 的冻结 acceptance/provider identity，`PublicReceipt.provider` 必须与其及 `Evidence.verification.provider` 完全相等。host 校验 receipt 身份、digest、criteria、`exit`、`timedOut` 并按 §15.3 派生 outcome；verifier 自报总 verdict 或 exit code 不是验收权威。`privateReceipt` 保持 opaque，不进入 worker/RSI/模型视图。compare 只能读取 public Evidence；它不能发 journal fact、创建 Agent、修改 Method 或改变 plan；invalid/missing evidence 不得作为零分。

领域包发布要带：

~~~text
domain manifest
MCP server manifests and bundle digests
verifier/scorer digests
fixture/input object digests
public/private boundary declaration
real scenario conformance suite
~~~

每个 MCP server 由部署在启动前提供可信 bundle、transport 配置和真实 OS/broker 权限。领域 CLI 的环境激活与依赖由操作者或领域 MCP 准备；需要 Nix 的工具在目标项目目录内激活后执行，Task 模型只提交业务参数，runtime 不实现领域环境准备。capabilities 只描述领域能力；框架不将声明变成权限白名单，不校验 manifest/config 的精确键集合。边界 schema 解析实际消费字段；DSH MCP client 负责连接、原生配置校验、schema 暴露、timeout 和 teardown。挂载后只比较实际工具名、description、parameters 和冻结 Method surface。

### 19.1 启动条件、正常调度与同进程续接

操作者在启动前固定 Node >=24.9、DSH 0.2.2-alpha.2、provider/model/profile、凭据、可信资产、根合同、预算和绝对 deadline，并提供健康存储和所需部署隔离。supervisor 不自动重启本次执行；一个进程拥有一个执行根，退出后只归档。下一次尝试必须使用新的目录及 Run/Round IDs。可信公开任务可直接使用现有本地 profile；含隐藏数据或不可信执行则先配置现成 OS/容器/broker，harness 不构造备用安全系统。

app 在启动 profile 前拒绝耗尽/过期/unknown 的累计预算并独占创建输出根。Run 在打开前解析冻结 Method、Composition、工具能力、provider identity 和输入；Agent setup 在发布前完成实际 prompt/MCP surface 校验，首次模型请求前发现不匹配即退出；skills 使用已固定的原生 registry/loader 直接 scoped 注册，不在注册后重新加载并逐字段复验。结构验证只在对应输入边界完成，内部复用已解析值。host CAS/schema 载入错误不能返回“模型可修复”提示。

运行只组合 DSH `agents.create/resume`、`followup`、`whenIdle`、`cancel` 和 `AgentHandle.dispose`。创建回滚、job drain、MCP teardown、session persistence 交给 DSH。Method MCP client 已使用 DSH `scrubbedParentEnv()`，框架不重复维护 credential 清单；原生 scrub 只按 KEY/PASSWORD/SECRET/TOKEN 名称和 DSH_* 前缀处理，干净 launch env 由操作者保证。HOME/TMP/XDG 由操作者在启动环境中固定，框架不额外创建、重定向或清理这些目录。streamable-http 使用部署提供的 HTTP/HTTPS URL，DSH 负责连接；框架不维护 loopback、query 或 fragment 黑名单。公开 Method 资产不携带凭据。

parent 提交 child batch 后释放执行槽位，整批 terminal 后由同一活跃 CommandService 中实际观察到的 yield 继续；保持原 PreparedRun、Run/session、合同和 deadline，原生 resume 只是重新装配这个会话。`run.ts` 不向外提供从归档恢复 opened/submitted Run 的入口。原 session 缺失或资源/会话失败抛出原始错误，不重建对话、不 reconcile 旧结果。

业务 retry 独立于进程恢复：领域 failed 或预先允许的无效验收结果，在固定预算内用新 Run/session 和 exclusive create 的新 workspace 再尝试。child 失败反馈、parent replan/replacement 和多批次仍是正常工作流。不能因“不重启”而删除这些业务能力。

宿主存储、provider 断连/请求失败、Agent 创建/处置、Summary、Proposer 或 MethodPatch precheck 的未知异常抛给调用方，停止本轮执行；已提交 facts 与 DSH 日志保留，未发生的结果不补写。远程请求结果不明时原生日志可能计 unknown usage，不承诺供应商 exactly-once，不自动重购请求。环境修复后人工开启新的尝试，harness 不重启、不补账、不修复归档。

预算耗尽仍是业务边界：停止新请求与派发，调用 DSH 原生 cancel/whenIdle/dispose，取得最终 usage/sessionCut 后一次写完整记录并关闭非 terminal 子树，保留已 terminal Evidence。之后 seal partial trace，Round 记 insufficient-evidence。只有原生生命周期成功结束后才能声明该结论。

### 19.2 一个现实任务的完整例子（非实跑成绩）

目标：operator 要求修复一个 RTL 加法模块，并交付经功能仿真的 RTL 与仿真结果。root spec/验收和工具许可由独立领域包提供。

~~~text
T0  root admission
    pin method-empty、初始 RTL seed、公開仿真 skill/MCP server snapshot、root verifier
T1  root Run-1 首次 prompt
    固定 worker card + exploration card + root goal summary
    自动列出文档/skills/MCP servers + explore-child brief；显示剩余预算百分比
T2  root read(self)；提交 2–3 层 PlanningSketch；阅读 global skill；决定本级“修复→验证”
T3  decompose prepare(explore-child)
    工具展示完整通用用例；此时没有 child
T4  下一模型 step commit 第 1 批，目标为修复 RTL
    host 自动固定 child 的 Method、fallback、skills/MCP servers、acceptance、输入和预算
T5  child 形成自己的 PlanningSketch，可再分解；root 按需查询祖先摘要，不接管孙层
T6  child closed(verified)
    root 在本进程续接，获得直接 RTL output/receipt 和可能的 feedback 只读引用
T7  root prepare/commit 第 2 批，目标为仿真验证
    输入显式引用第 1 批 frozen RTL；child 不能改 root 验收
T8  验证 child 返回公开结果；root 整合 RTL 与结果，提交 outputs
    可选 learning-drafts 中记录仿真 skill 草稿、MCP simulator server bundle
T9  root 固定 verifier 独立检查 frozen RTL/结果；root 和全树 terminal
T10 封存整树公开轨迹/产物/usage；开启固定 round plan
T11 proposer 按页查看失败/重复工作，产出一个 MethodPatch：
    新增 rtl-repair、functional-simulation 模板；新增 skill/MCP server 资产；
    把两者绑定为 root template 的直接选项，并给每个模板独立 skills/MCP servers
T12 host apply/precheck/MCP manifest validation，注册 candidate；proposer 已结束
T13 fresh base/candidate roots 各从相同 seed 开始，允许各自按模板分解
T14 host 比较多 case 与 validation Evidence，rsi/round-closed 为 improved/no-improvement/insufficient-evidence
T15 若 domain evaluation 和发布门槛均满足，操作者以 CAS 授权 activation；下一 Round 以新 active head 为 base
~~~

这个例子不固定 child 数或树深。长链任务按职责、产物与检查边界组织直属 workflow；已收敛为有界、可直接验证单元的叶节点直接完成。它展示了从零发现 workflow、形成资产、下一版固定绑定的边界；实际 domain 不需要为此修改 core。

## 20. Protocol conformance 场景

随当前可运行路径验证对应 scenario，未覆盖项标为 unproven。以下清单用于记录协议证据，正常功能沿依赖继续推进；启动与同进程续接遵循 §19.1。

~~~text
C-01 root contract freeze
C-02 one Run submit and external receipt
C-03 no-submission and fresh retry
C-04 first decompose prepare exposes example; commit without ack refused
C-05 child bindings cannot be model-supplied
C-06 parent required join and own verifier
C-07 parent can issue another direct batch after first terminal batch
C-08 child-level recursive exploration stays locally scoped; PlanningSketch may look 2–3 levels
C-09 empty Method + explore-child + skill/MCP-server draft artifact
C-10 native cancellation finishes before subtree closure; terminal Evidence and final usage preserved
C-11 mandatory transactional guard / command idempotency / archive reads
C-12 live yielded-parent continuation / refuse cross-process writer
C-13 Capsule contamination / hidden read boundary
C-14 RSI proposer receives sealed trace only and validation payload is denied
C-15 MethodPatch rejects task/verifier/scorer edits
C-16 trusted MCP draft/server bundle, consumed-field schema and frozen surface identity; DSH MCP scope invocation
C-17 paired base/candidate runs use distinct capsules
C-18 missing/invalid evidence is insufficient, not zero
C-19 activation uses expected-head CAS
C-20 prompt/tool/skill/NodeView percentage budget display; growing child history stays paginated
C-21 child feedback and scheduler no-submission feedback reach direct parent
C-22 feedback-driven replan creates new child contracts while retaining old Evidence
C-23 two consecutive Rounds use active-head CAS and cannot overwrite each other
C-24 single-case gain with validation regression is not improved
~~~

真实模型场景至少需要：一个普通领域任务、一个会递归分解的任务、一个空 Method 探索任务、一个 Method improvement 任务；不能用 scripted agent 结果代替 real model evidence。fixture verifier 可用于协议 guard，但不能把 fixture pass 当领域收益。

验收、提交与重放相关场景的边界由 §15.3 冻结：提交只冻结 `SubmissionManifest` 并交给独立 verifier；`PublicReceipt` 由 host 校验身份、digest、required criteria、`exit` 和 `timedOut` 后派生 `verified`/`failed`/`invalid`；exit=0 不充分，timeout 不得伪造成 signal；invalid receipt 仅诊断，不写 Evidence、不扩 `ExecutionRecord`；no-submission 不生成 receipt，fresh retry 不复用旧 verdict；manifest/receipt 的稳定排序与固定 `operationId` 支持幂等重放。以上是协议语义，不提供实现或证据。真实 DSH、真实模型和领域验收证据出现前，全部场景保持 `unproven`；`pnpm verify`、schema 静态校验或文档 digest 一致不能升级状态。

## 21. 复杂度预算

| 维度 | v1 上限 | 约束 |
|---|---:|---|
| 业务 authority | 5 | Task、Run、Evidence、Method、RsiRound |
| domain journal | 1 | 不建 transcript mirror |
| fold | 1 | UI/RsiView 都是 projection |
| domain writers | 1 | command service |
| Task wake authority | 1 | runtime |
| RSI proposer | 1 | 每个 Round 一次；Rounds 可连续执行 |
| round candidates | 1 | base + one candidate |
| automatic search rounds | 0 | Round 由外部按新 sealed trace 重复调用；不做 Campaign |
| global Method instruction | 0 | 方法指导只在本级 guidance 和显式绑定 skill 中 |
| per-node permanent context | 1 | NodeView；大内容按需读 |
| runtime graph | 0 | Task tree 是 projection |
| default LLM review | 0 | verifier/scorer first |
| unregistered MCP servers | 0 | draft 不等于 live capability |

任何要突破一行预算的提案必须先说明：保护哪个不变量、谁消费、为何现有对象不能承载、哪一个 conformance scenario 会失败。

## 22. 发布冻结与版本治理

本 V1 发布版冻结 C1–C3、A–F、amendment 001–013 以及本文全部配套字段、状态、guard、预算和符合性场景。它是唯一的 framework/protocol 施工基线；实现阶段只能实现本文语义，不得把实现选择重新写成隐含架构。

### 22.1 冻结内容

| 冻结组 | 对应章节 | 规范内容 |
|---|---|---|
| 分层与宿主 | 0–3 | 四层、单 writer/fold/wake；DSH 0.2.2-alpha.2；MCP 原生挂载；无第二 Task loop |
| Task 与验收 | 4、9、11、15 | 冻结 Spec/Contract；`AcceptanceRef=object`；`PublicReceipt`/`SubmissionManifest` strict schema、host 分类与证据边界；按 contract digest 索引的 Contract Summary；root 独立验收；Task/Run 状态机；required replacement/retry/join；固定预算 |
| Method 与探索 | 5–6 | 可复用模板目录、有界递归、局部 guidance、公开资源冻结、PlanningSketch、draft 后注册 |
| 本级 workflow | 7–8 | 多批次、一批可并行；binding 派生 required/probe；preview/next-step ack；feedback replan；原子准入 |
| 事实与执行 | 10、19.1 | 13 种闭合 facts；CAS/单 writer；取消级联；稳定身份；原生取消与 disposal |
| 模型界面 | 12–14 | 正向 worker/RSI cards；本层 direct children + 祖先摘要查询；Read/Plan/Decompose/Feedback/Submit/Stop；百分比预算 |
| RSI 演化 | 16–17 | 全树公开 trace 按页读；独立 proposer；MCP server patch；每 Round 一个原子 candidate |
| 评测与启用 | 18 | 可重复 Round；paired plan；全 slot；validation/holdout；active-head CAS |
| 领域边界 | 19、19.2 | 领域包提供 MCP servers、验收、seed、comparator；示例不进入 core |
| 施工与证据 | 20–21、23–24 | 24 个 conformance 场景、复杂度预算、规范 amendment、DSH 实跑证据 |

### 22.2 当前发布状态

~~~text
版本：V1 发布规范
修订：2026-11-02 纳入 amendment 006–013（前置条件、原生优先、错误身份、单一幂等索引、CAS 原子发布、probe 多实例、原生工具参数失败、局部 workflow 与探索目标验收）
权威文件：docs/framework.md
实现边界：只实现本文已冻结的协议；新增架构语义必须走 amendment
历史文件：旧草案、旧实现和研究记录仅作参考，不拥有规范权威
~~~

## 23. 实施边界与规范变更

本节固定“实现不能顺手重新设计框架”的界限。

### 23.1 唯一权威与变更分类

本文是唯一 framework/protocol 规范；实现记录版本、文档 digest 和所实现的章节范围。旧蓝图、旧仓库、历史日志属于参考证据，不拥有同等规范地位。代码施工仍以具体实现任务为边界，不得借施工名义迁移旧接口或恢复旧语义。

| 后续工作 | 是否可在既有规范内实施 | 必须遵守的边界 |
|---|---|---|
| 内部函数拆分、schema 库选择、性能优化、同语义缺陷修复 | 可以 | 保持字段、guard、可见内容、状态与副作用语义 |
| 新增领域文档、case、MCP server、verifier/comparator 实现 | 可以 | 走本文定义的 DomainAdapter，不添加领域专用 core 分支；真实权限由部署授权 |
| 新增/修改 Method 模板、skill、MCP server 和绑定 | 可以 | 走 MethodPatch/revision；不改 live contract、平台权限与验收权威 |
| 新增公开字段、状态、fact、工具、跨层读取、wake 来源或自动 loop | 不可以直接施工 | 先提出规范 amendment，用户确认后再实现 |
| 调整体积/复杂度上限、加入默认 LLM review、将 source replay 升格为发布依据 | 不可以直接施工 | 这是架构变更，不能伪装成配置修复 |
| DSH 升级、宿主补丁、第二 registry/writer/transcript、日志兼容层 | 不可以直接施工 | 先说明现有宿主接口为何不能承载，再确认新边界 |

这里的“可以”只定义变更类别，不能替代具体工作的授权。常规实现选择在已授权任务内自主推进，不为每个局部函数命名重复询问用户。

### 23.2 Amendment 最小内容

~~~text
现有规范版本与对应条目
实际问题、最小复现或失败的 conformance scenario
为何既有协议/领域扩展点无法表达
拟改字段、状态、事实、模型可见性与权限
预算和复杂度影响；数据兼容或明确不兼容
用户确认记录
之后才是实现与验证
~~~

实现默认沿 DSH 公开接口或现成库完成。保留自定义层必须提供具体原生调用路径，并比较本项目实际接入后的状态、分支和适配；只有明确证明原生方案更复杂时才保留。“暂不能证明等价”“库存在不代表可替代”都不能单独充当保留理由。可由操作者保证的条件在启动前固定，runtime 不为环境违约另建探测、恢复或兜底系统。输入不符合合同或权限时返回对应错误，普通执行失败按现有分类结束。改变公开字段、状态或 authority 时提出 amendment；独立正常功能继续推进。

当前已批准并纳入的 amendment（后续修订覆盖相冲突的历史实现约定，当前运行边界以 006/007/008/009/010/011/012/013 为准）：

| Amendment | 状态 | 纳入内容 |
|---|---|---|
| 001 | 已批准并纳入 | S2 protocol closure（K1–K5）；K6 证据规则不变 |
| 002 | 2026-10-30 用户批准 A0–A9；已纳入本文与 `spec-lock.json` | `AcceptanceRef=object`、`PublicReceipt`/`SubmissionManifest` strict 字段、host 分类、digest 顺序、`exit`/`timedOut`、`checks`、opaque `privateReceipt`、invalid receipt 仅诊断 |
| 003 | 2026-10-31 用户要求尽快删减并以正向引导替换过度防御；已纳入本文 | 保留强制等待；直接使用 DSH 生命周期；按已报告子树 usage 检查预算；独占创建 retry workspace；恢复按真实失败扩展 |
| 004 | 2026-10-31 用户要求核实八项诱导并直接修正成立部分；已纳入本文 | wake 仅消息 ID 判重；exclusive submit 直接冻结；summary 按实际 usage；原生取消后一次结算，移除 drainPending；确定性 precheck；删除 verifier 外部恢复查询和动态视图预估；本地公开任务直接运行，私有数据保持实际读取边界 |
| 005 | 2026-10-31 用户确认最小 RSI 修订；已纳入本文 | proposer 可读同 base 最近一个 closed Round 的公开假设、结果和聚合指标；固定指引按轨迹证据定位瓶颈、对齐冻结指标、提出最小可执行改动；隐藏 validation 内容保持原读取边界 |
| 006 | 2026-11-01 用户要求核实审计、前置约束、移除 harness 兜底并直接修改规范/约束/源码/测试；已纳入本文 | SQLite 强制事务 guard；标准 JSON/Ajv；单进程新根、归档只读；保留 live yield 和业务 retry；宿主异常退出；部署负责真实隔离；保留外部 receipt/digest 绑定 |
| 007 | 2026-11-01 用户要求修复审查问题，并规定只有明确证明原生接入更复杂才可保留自定义层；已纳入本文 | 原生生命周期/surface epoch 与消息面 wake 判重；删除 skill 事后逐字段复验、MCP HOME/XDG 管理和 loopback URL policy；schema 复用 Zod；保留项给出具体接入比较；operator 取消传入 verifier，仅本次 deadline 分类超时 |
| 008 | 2026-11-01 用户要求完成剩余删改、核验完整框架并提交/合并 PR；已纳入本文 | events 唯一幂等索引；CAS 完整临时文件后原子发布，append 无通用引用扫描；schema 路径、原生 readdir 与 leaf hash；可信 MCP metadata 不作权限门禁；删重复 args/copy；领域运行入口移入 examples；保留业务 retry 与祖先摘要 |
| 009 | 2026-11-01 用户授权补齐真实全流程测试并优化架构/prompt；落实既有 required/probe 区分 | winner 与自动 replacement 限制只用于 required；probe 后续 batch 可创建新子问题且保留旧结果；空 Method 的 ProposerView 省略不存在的 entry；摘要工具明确既有字段类型；proposer 按假设读取相关轨迹并集中表达复用指令，DSH 直接消费 Zod 派生的 MethodPatch JSON Schema。无新增协议字段、恢复机制或验收权限 |
| 010 | 2026-11-01 用户要求 bbdev 使用标准 MCP、前置 Nix 环境并复用 DSH 参数失败；已纳入本文 | 领域 MCP 在所选 checkout 内激活环境；完成的非法工具参数走原生校验，保留错误并附 failed/极简完整用例；不修复 JSON、不做文字匹配或 provider 重试。锁定 alpha2 适配器补丁修正该错误分类，不新增 Task 状态或恢复层 |

| 011 | 2026-11-02 用户要求停止浅层 BB 轮次、修改 workflow 引导并重开；已纳入本文 | 初始草图经资源探索后细化；长链按职责、产物和检查边界分解，串行阶段用后续批次；每层只组织直属任务并承担本地技术工作和集成；叶节点为有界可直接验证单元。保留结构校验与既有预算，无语义门禁、固定分解树或新增状态 |

| 012 | 2026-11-02 用户要求继续修复并持续监测，授权修改框架 | 同一 probe binding 可在同批创建多个独立 Task，共用已读 preview；required 每批仍一实例、每 obligation 一 winner。宿主以 parentTaskId/batchId/bindingId/index 派生稳定实例 ID，不增加模型输入字段或运行状态 |

| 013 | 2026-11-02 用户授权修正框架、要求所有机制得到有效使用；修复实跑发现的空验收 | explore-child 固定 required `task-goal` 标准，由领域 provider 验证冻结本地目标；localCriteria 不获验收权。空 criterion receipt 不可作为探索 child 完成证据，无新增状态或工具 |

用户于 2026-10-30 对 amendment 002 回复：“全部确定，以后不需要向我确认任何事，自行推进”。该批准冻结 A0–A9 语义；`PublicReceipt`/`SubmissionManifest` 的 protocol/runtime 实现、真实 verifier/DSH/模型证据和 §20 中 acceptance/submission/replay 场景的状态由实现变更独立证明，当前记录见 `docs/progress.md`。规范、lock、相关协议和进度的更新必须与本次批准保持同一语义。

### 23.3 实现与验证

- protocol package 不依赖 DSH、FS、进程、时钟或领域包；runtime 不出现领域算法与 suite 分支。
- 公开 schema、facts、MCP server schemas、NodeView、role cards 与本文规范逐项对应；门禁复用同一 guard。
- MethodPatch 只能产生新 revision，不能持有平台 writer、root 验收或 activation 能力。
- 随当前可运行路径验证第 20 节对应场景和实际 prompt；尚无真实 DSH/模型证据的行为标 unproven，继续推进正常功能。
- 检查通过只证明实现符合本文合同；不能反向产生新架构。实现无法满足规范时报告具体差距，不重写规范来让测试通过。

## 24. 来源、证据与当前交付范围

以下是规范发布时使用的外部资料身份。历史研究位于外部 `singualrity_final` 资料集；DSH 类型来自固定版本安装包。它们用于追溯设计依据，当前施工使用本仓库的 `docs/framework.md`、`AGENTS.md` 与 `docs/progress.md`。

| 来源 | 本文使用方式 |
|---|---|
| `SINGULARITY_FRAMEWORK_V1_REVISION_NOTES.md` | A–F 用户确认修改与配套设计输入；本发布版将其冻结为统一规范 |
| `SINGULARITY_HANDOFF.md`、`SINGULARITY_BLUEPRINT.md` | 研究入口与候选结构；没有继承其接口或规范状态 |
| `analysis/01-core-protocol-state-machines.md`、`02-core-assembly-rsi-runtime.md`、`03-legacy-vs-core-domain-rsi.md` | 理解旧责任边界、模型界面和具体膨胀来源 |
| `analysis/04-failure-diagnosis.md`、`analysis/adversarial-review.md` | 区分评测经济、模型完成合同与状态/恢复问题；不把模型陈述当实跑结论 |
| `analysis/evidence/v8-2-cut-20261028T1725/cut.json` | 固定研究所据的历史记录；本文没有重新购买实验或使用活跃日志数字 |
| `@deepseek-ai/dsh-agent@0.2.2-alpha.2` 的 `lib/types/index.d.ts`、`runtime-types.d.ts` | 核对 create/resume/setup、inbox、wake、idle 和 handle ownership |
| 同版本 `@deepseek-ai/dsh-tools/lib/types/contracts.d.ts`、`dsh-skill/lib/types/index.d.ts`、`dsh-system-prompt/lib/types/index.d.ts` | 核对工具 guard/并发、concludeTurn、资源继承与 prompt contribution 边界 |

DSH 类型核对提供接口依据；实现沿当前路径验证 wake、compaction 后阅读义务、工具权限、sandbox/read isolation、原生取消与实际 prompt 大小。启动前置条件、宿主错误退出和同进程续接遵循 §19.1。第 19.2 节是协议演示，真实领域运行结果见 `docs/progress.md`。

本节记录 V1 规范发布时的交付范围：规范及文档一致性检查。当前实现进度、运行证据和未验证项统一见 `docs/progress.md`；历史通过 Git 追溯。
