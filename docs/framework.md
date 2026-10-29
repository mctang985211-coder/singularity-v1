# Singularity 领域任务 RSI 框架与标准协议

版本：1.0 · 发布日期：2026-10-30（Asia/Shanghai）

**状态：V1 发布规范。本文是框架与协议的唯一权威；实现必须符合本文。**

本文从零定义框架。不继承 singularity-core、旧 Singularity、singularity-harness 或新 singularity 的接口和实现。旧研究只用于识别失败模式；DSH 安装包只用于核对宿主能力。

已由用户确认的基础决定：

- C1：只写全新规范，不采用现有实现。
- C2：首次调用某子模板的分解指令后，自动展示其预填写用例；模型确认阅读后才能准入。
- C3：没有 Method 指引时可用固定 explore-child 分解；新 skill/tool 先成为产物，由后续 RSI 注册。

本版本吸收 C1–C3 与 A–F 的确认意见：多层 PlanningSketch 但只准创建 direct children；按需祖先查询；结构化 feedback 和 parent replan；原生 MCP server 工具；正向模型引导；模型侧百分比预算；可连续执行的 RSI Round。其配套字段、状态、guard 和符合性场景在本文中一并冻结。

实现遇到未定义行为必须回到规范，不能自行补出新机制。

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
| DSH adapter | agent 创建/恢复、scope、wake、MCP server 挂载、工具门禁、进程和预算协调 | Task 验收权威、Method 内容决策 |
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
    → reconcile 必要的宿主副作用
~~~

DSH session log 保存对话和工具轨迹；Singularity journal 保存领域事实。两者不互相复制。journal 通过 sessionId + 日志区间引用原轨迹。

首版采用一个 project process 独占 journal。并发模型的命令经一个写队列串行提交。首版不设计分布式日志、分布式锁或多 writer 共识。

## 2. DSH 0.2.2-alpha.2 边界

本规范绑定确切版本，不以旧版本补丁为前提。核对依据是本机安装包中的类型声明，不能把旧研究中的 API 假设当作当前事实。本机 dsh/agent/tools/skill/system-prompt 包均为 0.2.2-alpha.2；dsh 声明 Node >=24.9.0，实现环境须满足这个宿主要求。

| 已核对的 DSH 能力 | 接入方式 | 本规范增加的语义 |
|---|---|---|
| agents.create / agents.resume，带 setup | 创建和恢复 scoped AgentHandle | 每个 Run 对应一个明确 sessionId |
| setup 在 agent 发布前装配 scope | 注册 prompt、tools、skills、listeners | 第一模型请求前完成冻结能力装配 |
| agent.followup / inject / whenIdle / cancel | 唤醒、提供上下文、等待静止、取消 | Task 等待和结算不得从 idle 自动推断 |
| systemPrompt.section / context | 固定规则、局部 guidance、动态数据分别贡献 | NodeView 用 required context，避免常驻系统指令重复 |
| tools.register(def, { when }) / restrict / guard、DSH MCP client | 动态可见性、MCP server 挂载、工具筛选 | MCP server 及其工具调用都必须有 guard，不能仅靠 restrict |
| SkillRegistry.register / list / get | task scope 资产按需加载 | 普通层只暴露绑定资产；探索层暴露冻结 global snapshot |

需要特别区分：

- tools.restrict 不会自动限制当前 scope 自己注册的工具；adapter 只能挂载获准的完整 MCP server，并为 server 及其工具调用加 guard。Method 不重新实现 MCP transport。
- DSH skill registry 会合并 inherited/global provider。仅注册本任务 skills，**不能证明其他 skills 被隐藏**。Task profile 必须避免挂载未经筛选的 filesystem/global provider；只挂载冻结资源 snapshot，skill 读取入口再次校验 ID。
- tool description、tool 专属 prompt、MCP server 提示都可能增加 prompt；只删 Singularity role card 不够。
- cwd 和 write sandbox 不等于 read isolation；隐藏评测数据需要实际 filesystem/process 边界。
- DSH 提供 MCP client 和进程内 trusted plugin 接口；RSI 生成的 MCP server bundle 通过部署许可的 MCP transport 挂载，不直接作为 Cordis plugin 加载进宿主。
- 本文的 create、guard 等示例是架构伪代码，字段精确签名在实现阶段按上述版本类型检查；未跑模型就不能声称行为已经验证。

正式 Task 的 wake 只由 Singularity runtime 发起。DSH goal、workflow、schedule、subagent 不挂到正式 Task profile。正式 child Task 由 agents.create 创建独立 session，不通过 DSH subagent 的深度/完成通知管理。后台 Contract Summary Worker 只生成只读摘要，不得创建 Task、调用领域工具、验收或写入合同。

## 3. 项目结构与 TS 风格

采用 DSH 常见的 packages/<group>/<package>、src/index.ts、类型与 runtime 分离、Cordis plugin apply、TS ESM、显式 import type、.ts 源码导入、包 exports、tsconfig references 和统一格式化。

~~~text
singularity/
  packages/singularity/
    protocol/                  # 纯 TS：业务类型、guards、reducers、views
      src/{index,types,task,method,round,view,errors}.ts
    runtime/                   # 一个 DSH plugin；不含自己的 LLM loop
      src/index.ts
      src/store.ts             # 单 journal / object store / replay
      src/service.ts           # command → append；唯一 writer
      src/agent.ts             # DSH create/resume/wake
      src/prompt.ts
      src/tools.ts
      src/resources.ts
      src/workspace.ts
      src/verification.ts
      src/round.ts             # 固定 round procedure
  apps/singularity/
    package.json
    cordis.patch.yml           # DSH profile composition，无业务状态
  examples/reference/          # 唯一最小协议参考；非默认领域
  docs/
    framework.md               # 本发布规范的唯一规范入口
    conformance.md             # 协议符合性场景
~~~

实际领域工程独立于框架仓库；不把 NPBench、EDA 或业务 suite 放进产品源码。

依赖方向：runtime → protocol；app → runtime；domain package → protocol 的公开类型。protocol 不访问 FS、网络、进程、DSH 或时钟。runtime 复用 DSH tool/skill registries，不建立可变的第二套 registry；Method 的 catalog 是冻结数据，不是运行时注册服务。

Schema 与 TS 类型只选择一个可维护的权威定义源；不要分别手写四套相似 validator。具体 schema 库与构建器属于实现选择，必须符合 DSH 工具可接受的 JSON schema 子集。框架冻结的是字段与行为，不是内部函数拆分或行数。

## 4. 身份、不可变引用与 Task 业务合同

以下接口定义协议字段；未展开的 Ref 都是 { id, digest }，Digest 为 sha256:<hex>。未知字段、未知版本拒绝，不静默忽略。

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

TaskSpec 是模型可以理解的、已由宿主解析后的目标与验收义务；TaskProposal 是模型提交给分解工具的请求；TaskContract 是准入后的冻结实例。模型只能填写 TaskProposal，宿主依据模板的 requiredCriteria、requiredOutputs、acceptancePolicy 和固定资源生成 TaskSpec/TaskContract。模型附加的 `localCriteria` 经过 schema 校验后只能成为 localGuidance；未通过 domain policy 的内容不进入受信 root acceptance。`localOutputs` 只能成为 supporting 输出，不能产生 required deliverable。

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
  readonly deadlineAt: number
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

Budget 不能在每个 child 重新放大。根预算是最终上限，子任务获准份额的预留和实际消耗均计入祖先。等待中的 parent 不占模型执行并发槽；child 使用预算不由 parent 模型重新估算。

maxTokens 计本 Task 子树所有尝试的 inputTokens + outputTokens；cache tokens 若已属于 inputTokens，不重复相加。steps 计实际模型请求，不把一次 tool batch 当成多个模型 step。deadlineAt 为绝对时间，恢复和 retry 不延长。

首版固定 retry policy：failed 在剩余 maxRuns、根预算和 deadline 内可重试；invalid 仅对领域部署预先列明的 transient infrastructure reasons 重试。cancelled、污染、composition mismatch 和证据损坏不重试。每次 retry 使用新 session/workspace；模型不能修改这项策略。required-child failure 不直接关闭 parent Run：source child 先 terminal，scheduler 写 direct-parent feedback，parent 在 active batch 清空后可以为同一 binding 创建 replacement child。只有 parent 无法继续、显式 stop、no-submission、step limit 或基础设施终结时，当前 parent Run 才按上述 retry policy 关闭。新 parent Run 不自动复用旧 child verdict，必须重新解决本 Run 的 required obligations。

资源 binding 由模板、deployment policy 与 frozen global snapshot 决定。模型提供 skills/tools/method/parentId/verifier 等字段一律拒绝，不能“规范化覆盖掉”后继续。Contract Summary Worker 从冻结合同生成以 `contractDigest` 索引的 ContractSummary；摘要保留 sourceContract 和版本，作为祖先查询的只读便利视图，原合同始终是权威。

### 4.3 AcceptanceRef 的权威

Root 的 criteria、verifier、scorer 来自用户授权的 domain case/operator，不属于 Method。

Child 的 goal、inputs 以及模板允许的局部 guidance 可以由父模型提交 TaskProposal；模板 requiredCriteria、requiredOutputs 和 acceptancePolicy 由宿主强制合并，它们不是 root 的评分标准。`localCriteria` 只进入 TaskSpec.localGuidance，`localOutputs` 只能由 host 转成 `required=false`、`role='supporting'` 的附加输出；二者都不能改变受信 acceptance。child 的验收 provider 由固定 domain acceptance policy 根据冻结业务 spec 解析，模型提供的是实例化数据，不是可执行代码或任意命令。

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

平台 explore-child 提供一个通用、填写完整的示例与固定简短说明；它不是可演化领域模板，执行时仍 pin method-empty 或所在 Method revision。

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

catalog 超过局部 prompt 上限时必须在 admission 阶段收敛公开集合或拒绝过大的配置；不能悄悄隐藏若干条，也不能把全库全文注入 prompt。

### 6.2 Task 内编写 skill/tool 的含义

每个 TaskContract 都有平台声明的可选 learning-drafts 目录产物。worker 可在这个 workspace 目录写 SKILL.md、MCP server manifest、tool schema、server configuration 和实现源码（例如 Python 或 TS）。

具体做法是在准入后的 spec.outputs 追加两个固定可选 OutputSpec：__skill-drafts → learning-drafts/skills（role=skill-draft）和 __mcp-drafts → learning-drafts/mcp-servers（role=mcp-draft），kind=tree、required=false。原始 root/child 提案不能占用或覆盖这些 ID/path；它们不增加业务验收 criterion。includeLearningDrafts=true 时提交器冻结实际存在的目录，缺省不因没有草稿而失败。

- 这些是本次 Task 的附加产物，不是 root 验收必须写的报告。
- worker 不可注册它们、修改当前 bindings 或把 draft 作为新的 DSH MCP server 挂载。
- 普通工作代码/脚本仍可在已授权 bash 等基础工具下执行；这不构成 Method tool 注册，也不授予新权限。
- draft 用于保留探索结果；RSI proposer 有权选择、改写、丢弃或纳入下一 Method。
- 现有 global skill/MCP server 可以使用；新草稿只能在 RSI 候选准入并通过部署能力检查后成为正式绑定能力。

### 6.3 PlanningSketch 与祖先查询

每个 worker 在第一次领域工作、调用领域工具或准入 child 之前，先提交一份轻量 PlanningSketch。草图的 `level=0` 是当前 Task，`level=1` 是当前 Task 的 direct children，`level=2` 是这些 children 可能组织的 grandchildren；因此视野是“当前层加未来两层”，最多三层。只有 level 1 能转化为本 Run 的 `singularity_decompose` child；level 2 只能是轻量预期，由对应 child 自己决定是否实现。草图不创建 Task、不改变 Method、不成为 Workflow/Graph authority。

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

Summary Worker 的工具面只有读取已注入合同和提交摘要对象；模型 route、预算和 session identity 由 host 固定，摘要结果需要 schema、source digest 和长度校验。调用前由拥有该 Task 的预算预留 summary allowance；预算不足时保持 `SUMMARY_PENDING`，不得从 parent 或 Round proposer 预算借用。

## 7. 一级 workflow：用局部批次表达顺序

静态“允许分解什么”和本次“先做什么、再做什么”分开：

- Method 固定 child template 选项、skill/tool 绑定、默认用例。
- 当前模型根据本次目标和 PlanningSketch 决定是否分解、选哪几个、怎样填写业务字段、何时追加下一批。
- 一次只准入一个 active child batch；同批 child 必须能独立执行，不含 sibling dependsOn。
- 顺序依赖通过批次表达：第一批返回结果，父节点将明确 frozen outputs 作为第二批 inputs。
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
- probe：探索性尝试，失败不自动否定 parent；parent 仍要通过自己的验收。
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

`singularity_feedback` 是非阻塞 Task tool。child 只能提交给自己的 direct parent；child Run 仍 open 时可以提交 feedback。feedback 写入 CAS，不结束 source Run，不立即唤醒 parent。scheduler 在 source Run 进入 terminal closure 后，针对 no-submission、step limit、required child terminal failure 或基础设施终结自动生成 `source='scheduler'` feedback，并引用已经存在的 ExecutionRecord/Evidence。反馈不授予跨树读取权限。

feedback refs 必须是 source Run 已拥有的 public outputs、public Evidence 或 ExecutionRecord；host 过滤 privateReceipt、validation payload 和未授权 CAS 引用。child-worker feedback 的 sourceTask/sourceRun/parentId 由 caller identity 派生，模型只提供 kind、summary、proposedChanges 和已授权 refs。

反馈生命周期固定为：

1. child Run open 时可写 feedback；CAS 记录不改变 Run 状态。
2. child 调用 submit/stop，或遇到 no-submission、step limit、基础设施终结时，source Run 先进入 terminal closure。
3. scheduler feedback 只在该 closure 已写入或与其处于同一原子终结协调点之后生成，并引用已存在的 ExecutionRecord/Evidence。
4. active batch 以 child Task 为成员；parent 只有在该 batch 的所有 child Task terminal（包括 child 自己的 retry 已结算）后才 wake。parent 等待期间不占模型执行槽。
5. parent wake 后读取 direct child results 与 feedback，可以更新本级 PlanningSketch、创建同一 binding 的 replacement batch，或结束当前 Run 进入固定 retry。
6. parent submit 前必须 active batch 为空、所有 required obligations 已有 winner、所有已创建 children terminal。parent 已 submitted/closed 后迟到 feedback 只进入 trace，不唤醒旧 Run；下一 retry Run 可读取它。

模型不能改旧 child、root acceptance、Method binding 或预算。旧 Evidence 始终进入 trace；新 child 仍须通过相同 acceptance provider，required join 以新的 verified child 满足。没有 feedback 的普通 parent 也可以依据 direct results 形成下一 batch。

Summary Worker 的模型 usage 归属于拥有该 Task 的 Task budget，并计入 root subtree usage；summary cache miss 的后台调用进入该 root trace 和 evaluation slot 成本统计，命中已有摘要不产生模型 usage。祖先查询本身没有模型 usage；若查询触发 cache miss，host 在被查询祖先的 ownerTask 预算下运行 Summary Worker，不能把费用转给发起查询的 child。RSI proposer usage 归属于 Round proposer budget，不计入 source root；evaluation 中的 summary usage 归属于对应 evaluation slot。feedback tool 本身没有模型 usage，scheduler feedback 是 host record。

feedback 失败只记录明确 tool error，不阻塞父节点；feedback 不能由 worker 伪造 scheduler 来源，不能传递给祖父节点，不能直接唤醒非 direct parent。

## 8. 分解的 preview → commit 协议

两个动作属于同一个 singularity_decompose 工具，不存在另一个可绕过的 spawn 入口。

### 8.1 第一次 prepare，只返回用例

~~~json
{ "action": "prepare", "bindingId": "functional-simulation" }
~~~

response：

~~~text
status = preview
previewRef = ObjectRef
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
2. 每个 bindingId 确实是本层可见 child binding 或已准入 fallback。
3. ackPreview 对应当前 Run **已经持久交付**的 prepare result；必须在后续模型 step，不能在同一次 tool batch 中猜测 ack。
4. instanceSchema、proposal 输入授权、路径和资源总额检查；host 合并 template requiredCriteria/requiredOutputs/acceptancePolicy，把 localCriteria 写入 `TaskSpec.localGuidance`，把 localOutputs 转成 `required=false`、`role='supporting'` 的输出，拒绝模型提交 `required`、acceptance provider/verifier/scorer、deliverable role 或 draft 路径覆盖。
5. 由宿主生成 TaskSpec、taskId、parentId、parentRunId、batchId、Method/template refs、bindings、acceptance；若该 batch 是 feedback replan，host 根据 binding 和已 terminal failure 派生 `feedbackRef` 与 `supersedesChildIds`，模型不能提交这两个字段。
6. append 一个 task/children-admitted fact，含完整 children contracts、join 规则、预算预留。
7. parent 进入 waiting-children 投影，当前 turn 结束；释放执行槽。
8. child dispatch 在 fact 已持久提交后发生；崩溃恢复可补发未启动的 child。

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
| open/active | closeTask(invalid) | 无法继续的基础设施/证据错误 | closed |
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
| verified | 固定 verifier 对全部 required criteria 返回 pass | 可进入 join guard |
| failed | 有效验收 fail；或模型 stop/no-submission/step-limit | 不可 |
| invalid | provider/tool/verifier 基础设施异常、污染、composition mismatch | 不可；无领域分数 |
| cancelled | operator/祖先取消 | 不可 |

没有提交的 failed Run 可以有 execution record，但没有 acceptance receipt。不要伪造 verifier receipt 来统一数据外观。

失败 Run 不自动导致 Task terminal：按 root admission 时冻结的 maxRuns/retry policy 决定。新 Run 的方法、Task contract 和祖先总预算不变。

### 9.3 完成与 yield 约束

DSH idle 不是业务完成；runtime 必须对 turn/end 做分类：

~~~text
Run 已 submitted                              → 正常交给 verifier
当前 Run 有 active child batch                 → 正常暂停，不算 no-submission
模型显式 singularity_stop                      → closeRun(failed, declared reason)
否则正常 turn/end                              → closeRun(failed, no-submission) + scheduler feedback to direct parent
turn/end 为基础设施 error                       → closeRun(invalid, infrastructure)
runtime 已在取消/超预算                          → 走那个唯一终结路径，不重复写 closed
~~~

child 发现输入不足时，通过 `singularity_feedback` 返回结构化建议；scheduler 在 source Run terminal 后，于 no-submission、step limit、基础设施终结或 required child Task terminal failure 时生成同样的 direct-parent feedback。required child failure 让 parent 保持 open/waiting，直到当前 active batch 的所有 child Task terminal；parent 随后读取反馈并形成新的 PlanningSketch，再创建同一 binding 的 replacement batch，或结束当前 Run 进入 retry。反馈不等待父节点、不改变合同，也不引入可能死锁的 ask-parent。

## 10. 最小 fact 协议与 side effect

### 10.1 Envelope

~~~ts
interface Fact {
  readonly v: 1
  readonly seq: number
  readonly commandId: string
  readonly type: FactType
  readonly actor: { readonly kind: 'operator' | 'runtime'; readonly id: string }
  readonly at: number
  readonly data: FactPayload
  readonly prev: Digest | null
  readonly digest: Digest
}
~~~

commandId 相同且规范化 command 相同，返回原结果；相同 ID、不同 payload，拒绝 IDEMPOTENCY_CONFLICT。身份由 runtime 绑定到 live Agent/Run，不能相信工具参数中的 actor 字符串。

canonical JSON 采用 RFC 8785/JCS：数组保留顺序，字符串不作额外 Unicode normalization；拒绝非有限数、重复键和非 JSON 值，不能静默四舍五入超出数值模型的输入。精确的大整数须用 schema 声明的字符串表达。

digest 域分别为 fact、contract、method、object、composition、evidence、preview、round-plan。计算式固定为 SHA256(UTF8("singularity/v1/" + domain + "\n") || payloadBytes)，结果编码为 sha256:<lowercase hex>。结构化 payloadBytes 是去掉其最外层 digest 字段后的 JCS UTF-8；嵌套引用的 digest 保留。原始文件对象使用原始 bytes，目录/bundle 使用排序 manifest 引用各文件对象，不哈希不稳定的 tar 时间戳。

### 10.2 事实与完整 payload 范围

下表是本版本的闭合事实集。Evidence、模板、工具代码等大对象存 CAS；fact 引用 digest，不把完整 transcript 重写进 journal。

| Fact | 必备业务内容 | 唯一后续消费者 |
|---|---|---|
| method/registered | 冻结完整 revision 对象引用、parent、来源 proposal | admission/RSI |
| method/activated | expectedPrevious、previous、next、approval、evaluationRef | 新 root 选 Method |
| task/admitted | 完整 root contract 引用；summary 由独立索引异步关联 | dispatch/ancestor query |
| run/opened | taskId、runId、attempt、sessionId、composition、workspace seed、budget reservation | DSH create/resume |
| task/children-admitted | parentRunId、batchId、所有 child contracts、由 binding 派生的 join、replacement 的 feedbackRef/`supersedesChildIds`、预算预留 | child dispatch/parent projection |
| run/submitted | runId、冻结 outputs manifest、提交时 transcript offset、preview/read receipts、planningSketchRef、feedbackRefs | verifier/trace |
| run/closed | runId、classification、reason、EvidenceRef/ExecutionRecordRef、usage、planningSketchRef、feedbackRefs | retry/parent join/trace |
| task/closed | taskId、outcome、reason、decisiveRunId?、evidenceRefs；subtree cancellation 时含 cancellationCutRef | parent/trace seal |
| rsi/trace-sealed | rootTaskId、traceRef、完整 usage、最终 session offsets | RSI input |
| rsi/round-opened | roundId、sourceTrace、baseMethod、冻结 plan、proposerSessionId | proposer |
| rsi/proposal-submitted | roundId、结构化 patchRef | precheck |
| rsi/candidate-ready | patchRef、precheck receipt、candidateMethod | paired dispatch |
| rsi/round-closed | roundId、outcome、comparisonRef 或 rejected/interrupted 原因 | operator/activation |

不另写 verification/recorded + evidence/sealed + run/settled 三份终局。verifier 原始结果、artifact manifest 和 final usage 写成一个 Evidence 对象，run/closed 引用它。

预览交付、PlanningSketch、feedback 和 own-guidance 阅读来自持久 DSH tool results/CAS objects，不增加新的 domain fact。恢复从对应 session 的 tool-call/result 重新解析，receipt 不跨 Run；sealed trace 的 children 章节索引这些对象。

失败/取消时 task/closed 可带 scope='subtree'：reducer 同一次提交关闭目标 Task，将非 terminal descendants 及其未关闭 Runs 置 cancelled；目标自身若仍有未关闭 Run，也以相同 cancellation cause 关闭。已终态节点/Run 保留。这个 fact 是这些取消结论的唯一来源，不再补写同义的 run/closed。取消时的 ExecutionRecord 引用已知 session cut/usage，并标记尚需 drain；runtime 随后取消受影响 Agent/process，晚到结果不得改变 verdict。最终 cut、取消后的尾部 usage 和 cleanup receipt 由 rsi/trace-sealed 统一引用，不覆写旧 Evidence。

这些是字段语义定义；正式 JSON Schema 与 TS fact union 必须从本文冻结的本表生成或校验。实现可以选择生成器和内部文件拆分，但不能改变字段或行为。

### 10.3 原子性与恢复原则

- 一个 fact 的 append、fsync 是命令提交点；children-admitted 一行只在 children count/bytes 上限内使用。
- CAS 先写临时对象，校验 digest，原子 rename，再写引用 fact。未被事实引用的对象是可回收 orphan，不是业务成功。
- fsync 后才能发模型请求、派 child 或宣布成功。
- torn 最后半行可截去；中间损坏拒绝启动，不能跳过。
- 一次性 verifier 过程可能因进程崩溃无法区分“已跑完但未记录”；外部副作用必须使用确定 operationId 查询，无法核对时结算 invalid，不宣称恰好一次。
- root trace 只在全树 terminal、所有模型/进程静止后 seal，不因为 UI 显示 closed 就提前冻结不完整 usage。
- single writer 是领域 authority；存储类不自行实现 business guards。

## 11. 完整 Task 执行 procedure

### 11.1 Root intake

~~~text
原始现实需求 + 公开资料 + 固定 root acceptance provider
  1. 操作者确认 goal、criteria、输入、输出与预算；有歧义先澄清
  2. 冻结输入、公开资源 snapshot、领域 acceptance identity、seed
  3. 显式选择 MethodRef；无现有方法则选择 method-empty
  4. resolve 本层模板与 bindings；验证 profile 真实具备所需能力
  5. append task/admitted（只引用冻结 contract；不把摘要写回 contract）
  6. reconcile 按根预算进入 dispatch
~~~

从自然语言形成 root contract 可以用模型辅助，但结果须由 intake policy/operator 确定；不能让工作中的 root 自己改验收。

### 11.2 准备和启动一个 Run

~~~ts
async function openRun(taskId: string) {
  const task = view(taskId)
  guardCanOpenRun(task)
  const intent = allocateRunIdsAndReservation(task)
  const composition = freezeComposition(task, intent)
  await commit('run/opened', { ...intent, composition })

  // 下列是副作用；崩溃后由事实和 DSH session 状态协调
  await workspace.prepare(intent.workspaceKey, task.inputs)
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

deliverWakeOnceOrFail 是 adapter procedure：为 input 使用稳定消息 ID；发送前读取 DSH session 中该 wake 是否已持久入队/消费。不能靠一个内存 boolean 去重。完成的批次 wake 使用 runId+batchId。未知/损坏 inbox 状态不重复购买模型请求，按 interrupted 处理。它不承诺网络供应商的请求恰好执行一次；不确定请求计 unknown usage。

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
  → validate required paths / symlinks / size / declared outputs
  → require owned jobs and mutations quiescent
  → exclusive submission latch；后续写工具全部拒绝
  → freeze outputs into CAS
  → append run/submitted
  → end current turn
  → runtime 等 DSH idle，drain owned processes，dispose AgentHandle
  → run verifier on frozen inputs + frozen artifacts
~~~

等待 agent.whenIdle 由 turn 之外的 runtime 执行；在 submit 的 tool body 内等待自身 turn 结束会死锁。submit result 只说 submitted，不谎称 verifier 已通过。

若存在后台任务，返回 ACTIVE_JOB 以及可执行的 wait/stop nextAction；如果部署无法保证写入已静止，则不产生可信快照。冻结后 verifier 只消费 CAS，绝不回读可变 agent workspace。

### 11.5 验收和结算

~~~ts
async function verifyAndClose(runId: string) {
  const submitted = loadFrozenSubmission(runId)
  const receipt = await domain.verify({
    operationId: runId + ':verify',
    task: submitted.contract,
    inputs: submitted.inputObjects,
    outputs: submitted.outputObjects,
  })
  const verdict = validateReceipt(receipt, submitted)
  const usage = await finalizeDshUsageAndOwnedJobs(runId)
  const evidence = sealEvidence(submitted, verdict, usage)
  await commit('run/closed', { runId, classification: verdict.kind, evidence })
  await reconcileTask(runId)   // verified join / retry / failed / invalid
}
~~~

validateReceipt 必须检查：verifier ID/digest、contract/input/output digests、每条 required criterion 恰一次、verdict 合法、score 的 metric/unit/finite number、operationId 和原始退出状态。exit=0 本身不足以 verified。

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

读取证明在恢复中从原 session 重建；compaction/resume 后开启新的 contextEpoch，重新要求 self read。child preview 必须处于当前可见 epoch，不能使用被压缩掉的旧摘要冒充完整用例。

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

documents 和 childOptions 的完整当层摘要列表在 admission 时保证放得下；skills/tools 只列身份，不再复制 DSH discovery/schema 中的 description。skill 简介由 scoped DSH discovery 交付，tool 简介由工具 schema 交付，第一请求前装配完整集合；三处不能各注入一遍相同帮助。

动态增长的 child 历史用计数、当前批次和有界 recentChildResults 表示，完整 direct child 列表经 read(kind=children) 分页；本次 wake 涉及结果均可从该 cursor 找到。NodeView 不重复携带所有历史 child 记录，guard 始终检查完整 state。

没有事实依据时不强行生成“下一步必须 submit”。模型仍需自主进行领域工作，runtime 只决定读、分解、提交、等待这些动作是否合法。

### 12.3 direct child 的读取授权

父 Run 对其直接 children 的公开 Evidence 和声明 outputs 有天然读取权，来源是 children-admitted 中的 parentRunId。其他跨节点数据必须显式通过 TaskSpec.inputs 授权。

每次 child terminal，adapter 在 parent 的只读命名空间挂载 frozen outputs：

~~~text
children/<taskId>/<outputId>/...
~~~

不 overlay parent 代码，不导入 child 的临时文件或孙节点目录。需要整合时父模型复制或改写为自己的声明产物。挂载 refs 和 asOf 进入当次 context snapshot；最终 Evidence.inputs 包含初始输入及这些追加的 direct outputs。

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
You execute one Singularity Task as one level of a larger workflow.
Start with singularity_read(kind="self"), then singularity_plan with a light
2–3-level sketch. Work toward the current goal using the listed skills and
MCP servers. Query an ancestor summary when its frozen goal or decision helps.

Organize useful direct children with singularity_decompose. Read each complete
example, then commit on a later step with its preview receipt and current sketch.
Each child owns its own level. After a batch finishes, read direct results and
feedback, revise the sketch when useful, then integrate, create another direct
batch, or submit.

Preserve reusable SKILL.md or MCP server drafts under learning-drafts when they
help future work. When the declared outputs are ready, call singularity_submit;
the independent verifier records acceptance. When progress needs a parent
decision, call singularity_feedback with a structured suggestion, then continue
the current level or submit a concrete blocker with singularity_stop.
~~~

探索模式只追加：

~~~text
Local exploration is enabled at this level. Follow supplied local guidance and
explore with the frozen public documents, skills and MCP servers in resources.
Use the fixed explore-child example for a direct child and preserve useful
discoveries as drafts. Registering and binding capabilities belongs to a later
Method revision.
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

上述工具的 schema 均拒绝未知字段。错误通过 DSH 标准 tool failure 返回短 JSON：{ code, nextAction, remainingBudgetPct }；nextAction 是正向可执行动作。协议拒绝码固定为 INVALID_ARGUMENT、READ_SELF_FIRST、PLAN_FIRST、PREVIEW_REQUIRED、PREVIEW_STALE、NEXT_STEP_REQUIRED、CHILD_BATCH_ACTIVE、REQUIRED_FEEDBACK_REPLAN、INPUT_NOT_AUTHORIZED、BINDING_FIXED、LIMIT_EXCEEDED、ACTIVE_JOB、ALREADY_SUBMITTED、RUN_CLOSED、COMPOSITION_MISMATCH、IDEMPOTENCY_CONFLICT。错误不创建 child、不提交产物；已经落盘的相同命令按 commandId 返回原结果。

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

相同规则覆盖 native tool calls 与 DSH PTC 内嵌调用；实现统一把 MCP server call 绑定到当前 Run、server asset 和 capability。正式 profile 不启用无法纳入相同 guard 的调用通道。

### 14.3 Prompt 体积预算

| 内容 | 最大值 | 超限处理 |
|---|---:|---|
| 固定 worker card，含探索追加 | 2 KiB | 平台 build gate |
| NodeView，含所有当层资源/child briefs | 8 KiB | admission 收敛目录或拒绝；不丢失条目 |
| own guidance | 8 KiB | Method precheck 拒绝 |
| 单个 child example | 12 KiB | Method precheck 拒绝 |
| 一个 prepare result | 32 KiB | 单个 binding 逐个 prepare；不拼整库 |
| 全部可见 tools 的 schema/描述 | 12 KiB | 能力配置拒绝，长帮助移入资源 |
| 全部可见 skills 的 discovery 名称/简介 | 8 KiB | 资源配置拒绝，不重复放进 NodeView |
| 单个 read/skill result 页 | 16 KiB | 稳定 cursor 分页，不静默截断 |

首次 self read 和 prepare 将正文保存在当前上下文中；不每步重复追加。分页读完的 receipt 必须覆盖完整对象。大 skill 必须拆成短 SKILL.md + 按需引用资源，不能因为 skill 太大绕过单次输出上限。

DSH compaction、tool result pruning 保持宿主实现；runtime 只记录新的 contextEpoch 并重建 self/preview 阅读义务。若无法识别 epoch 或不能确保重读，拒绝复用旧 receipt，不靠“应当还记得”继续运行。

验收测量：实际 assembled system、dynamic context、tool schemas、history、每步 input/cache/output tokens分别记录。只报自己写的 prompt 字数不能证明没有膨胀。

## 15. 产物、执行环境与 Evidence

### 15.1 Workspace 和 Capsule

两种隔离不能混淆：

- Task Run workspace：当前节点的可写工作目录；同一节点的多个 parent wake 延续这个目录。
- evaluation attempt capsule：从固定 seed 构建的一次完整 root 执行环境；包含该次树中各 Run 的私有 workspace。
- verifier environment：只读取 frozen inputs/outputs，验证身份由 host 注入；不能把 agent 的可写 workspace 当作 trusted test directory。

baseline/candidate/case/repetition/attempt 各自独立 capsule；禁止跨候选共享可写代码、HOME、TMP、依赖安装目录或 build cache。固定只读依赖/cache可共享，必须进 seed identity。

普通节点 workspace 的作用是工程隔离；对隐藏数据的读取隔离须由实际 sandbox/container 等适配器保证。首版可以选择一个有效实现，但不能以目录名或 git worktree 冒充安全边界。所需隔离能力缺失时 attempt=invalid，reason=unsupported-isolation。

DSH 本体凭据不进入工具子进程。固定 domain broker 可保管 EDA license/service secrets；Method tool 只拿到获准 service 的请求接口。

Capsule 是 host resource lease，不建立领域状态机；seed、mode、lease key、exit/cleanup status进入 Evidence。创建/销毁失败不改变已有结果为通过，也不可复用受污染环境。

### 15.2 Evidence schema

~~~ts
interface Evidence {
  readonly v: 1
  readonly task: TaskRef
  readonly runId: string
  readonly contractDigest: Digest
  readonly method: MethodRef
  readonly inputs: readonly ObjectRef[]
  readonly outputs: readonly ObjectRef[]
  readonly composition: ObjectRef
  readonly verification: {
    readonly provider: AssetRef
    readonly operationId: string
    readonly publicReceipt: ObjectRef
    readonly privateReceipt?: ObjectRef
  }
  readonly usage: UsageRecord
  readonly sessionCut: { readonly sessionId: string; readonly from: number; readonly to: number }
  readonly environment: { readonly seed: Digest; readonly mode: string }
  readonly digest: Digest
}
~~~

privateReceipt 不返回 worker/RSI；publicReceipt 有 criterion ID、pass/fail/invalid、公开错误与可用 metric，不能携带隐藏用例答案。

ExecutionRecord 用于 no-submission、stop、cancel、基础设施异常：有同样的身份、usage、sessionCut、reason，可缺 verification/outputs；它不能被冒充成 verified Evidence。

`UsageRecord` 必须把模型消耗按 owner 分类保存：普通 Task Run 的 input/output usage 归属该 Task，并向 root subtree 汇总；Contract Summary Worker 的消耗放在 `summary` 子记录中，带 `ownerTaskId`、`sourceContract` 和 known/unknown token counts，归属拥有该合同的 Task，并计入其 root trace 与 evaluation slot 成本；RSI proposer 的消耗归属 Round proposer budget；evaluation slot 内的摘要消耗归属该 slot。feedback tool 和 scheduler feedback 没有模型 usage。usage 已知计数与 unknownRequests 单独表达。未知不等于 0，不能据此宣称节约成本。硬预算以宿主计量/保守预留控制；计量不可用时停止继续购买请求，保留 incomplete usage。

composition 记录：DSH 确切包/配置 identity、platform prompt digest、Task contract、局部 template/guidance、skills 完整 bundle、MCP server manifest/bundle/schema/config、模型路由、资源 snapshot、初始 seed。后续 direct child input snapshot 用 asOf+refs记录，不伪装为启动前已知。

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
all owned DSH agents/processes stopped or drained
usage/session offsets stable enough to seal
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

模型按需调用 rsi_read page。读取没有给它新的权限，也不让它读取其他 root、validation 或 private objects。

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
  readonly remainingBudgetPct: {
    readonly tokens: number
    readonly steps: number
    readonly wallClock: number
  }
  readonly readPolicy: { readonly kinds: readonly string[]; readonly pageMode: 'bounded-paged' }
}
~~~

ProposerView 是独立的读取授权结果。`publicCases` 只含领域公开描述和 case identity；validation/holdout 的 input、answer、hidden test、private verifier recipe 只在 evaluator/verifier scope。分页大小由 host guard 固定，ProposerView 内的预算字段只展示百分比。

## 17. RSI proposer 协议

### 17.0 Round 状态机

~~~text
不存在 ─ rsi/round-opened ─▶ proposing
proposing ─ rsi/proposal-submitted ─▶ checking
checking  ─ rsi/candidate-ready ─▶ evaluating
proposing / checking / evaluating ─ rsi/round-closed ─▶ closed
~~~

checking 是固定 host procedure，不驱动 proposer 追加领域工作。closed outcome 为 improved、no-improvement、insufficient-evidence、rejected 或 cancelled。前两种必须有完整比较证据；rejected 是 proposal 未通过准入，不是假装评测过后输了。

没有 proposal 的正常 turn/end 记 insufficient-evidence/no-proposal；达到 deadline 或 proposer 基础设施失败记 insufficient-evidence；operator 取消记 cancelled。每 round 只提交一个正式 patch；无效工具参数可以在提交前纠正，但不反复购买一系列候选。

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
Read the source contract, final acceptance and the trace pages that explain a
reusable change. The trace index includes descendants and the public proposer
view includes evaluation goals, metrics, thresholds and budget percentages.
Your deliverable is one MethodPatch containing reusable templates, local
guidance and examples, skill assets, MCP server assets, and their bindings.
Use rsi_submit_patch when the patch is complete; the host performs precheck,
evaluation and activation approval.
~~~

工具定义：

~~~text
rsi_read
  input: { kind: proposer-view | trace-index | trace-page | method | asset | public-resources,
           id?, cursor?, page? }
  output: { data, objectRef, nextCursor?, remainingBudgetPct }
  scope: 本次 source trace、base Method、source 中的 drafts、公开能力目录、公开 RoundPlan
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

ToolAsset 只有 MCP server 形态。RSI 可以新增或改进 server bundle、manifest、exposed tool schemas、配置和实现源码；host 校验 bundle、transport、capability manifest 与部署 allowlist，生成 candidate 的 MCP server asset。正式绑定只发生在未来 Task 的 DSH MCP scope。新增宿主级 transport、broker 权限或秘密凭据属于独立领域部署变更，不由 MethodPatch 自动取得。工作中的 Task 仍只产出 MCP draft。

### 17.3 proposal precheck

确定性 precheck 检查：

~~~text
base digest == current round base
exact schema / size / canonical JSON
only allowed Method fields changed
template bindings form a finite reusable catalog
template instance schemas cannot add root verifier/scorer
skill content and MCP server bundle/manifest/config digests resolve
MCP transport and capability manifest use only deployment-approved capabilities
every exposed MCP tool has a stable name and schema matching the manifest
model-visible guidance/descriptions provide goal, action and next step structure
patch applies deterministically and is not no-op
~~~

已知私有标识、golden data、跨 Run 记忆、针对 grader 的分支和不受限工作循环是禁止行为，但不能仅靠文本扫描证明任意 TS/自然语言资产永远不包含它们。扫描只能产生拒绝信号；不得声称完成普遍语义证明。

实际边界由受限子进程、独立冻结 verifier、隔离评测用例、固定预算和可追溯工具调用共同承担。领域需要语义审核时可以提供独立审核 policy；不是每个确定性领域都默认付费给 LLM critic。

precheck 失败直接 append rsi/round-closed(rejected)，保存 precheck receipt 和公共 rejection reason；不写 Method head。MCP bundle 的实际运行由 DSH MCP client 和部署 adapter 负责；本协议只检查其 manifest、schema、transport 和 capability 绑定，不重新定义 MCP transport。

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

在 plan 中预列 case × arm × repetition 的全部 slot IDs 和确定顺序；task/admitted 的 evaluation purpose/requestRef 关联对应 slot。重启按这个 ID 找既有 Task，不创建第二份。未启动、cancelled、missing 和 invalid 均保留在分母，不能删除不利样本。每次执行失败是否重试由冻结 limits 决定，不重试到通过。

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

verify 必须在进程外或固定 broker 中执行，receipt 中公开 criterion 与 metric，不公开 private fixtures。compare 只能读取 public Evidence；它不能发 journal fact、创建 Agent、修改 Method 或改变 plan。

领域包发布要带：

~~~text
domain manifest
MCP server manifests and bundle digests
verifier/scorer digests
fixture/input object digests
public/private boundary declaration
real scenario conformance suite
~~~

每个 MCP server manifest 必须声明 capabilities（filesystem roots、network、license broker、resource limits、transport）。未声明能力或超出部署 allowlist 的 server 拒绝准入。DSH MCP client 负责实际连接、schema 暴露和 transport 生命周期。

### 19.1 并发、恢复和终止的固定规则

RunPool 只分配执行资源，不决定 workflow。按 admission/ready 顺序排队；waiting parent 释放模型槽，children 全部 terminal 后重新排 parent。baseline/candidate 使用同一容量 policy，不能让一个候选因共享可写缓存或额外并发获得优势。

所有等待都有 deadline，包括创建 Agent、外部工具、verifier、取消 drain。不能在 timeout 后直接复用仍可能写入的 workspace；无法停止的进程/外部 job 被 quarantine，该 attempt invalid。

| 恢复位置 | 从什么重建 | 必须采取的动作 |
|---|---|---|
| run/opened 已写、Agent 未创建 | run/session/workspace 的确定 ID | 若 session 不存在则创建同一 intent，存在则校验后 resume；不另开 attempt |
| start wake 已入队或消费、回执未到 | DSH 持久 message/inbox/turn 边界 | 复用已有 wake，不重发同一普通消息 |
| children-admitted 后尚未 dispatch | fact 中全部 children contracts | 仅调度缺少 Run 的 child，不能重新准入 |
| parent 在等待 children | 子树事实和原 parent session | children 尚未全部 terminal 时不唤醒；完成后的 wake 使用稳定 batch key |
| prepare 后未 commit | 原 DSH tool result、contextEpoch | 重读即可；无 Task 创建，不需要撤销 |
| submitted 后未验证 | CAS submission、acceptance identity、operationId | 用固定操作 ID查询/验证同一 snapshot，禁止回读活动 workspace |
| verifier 完成但 closure 未写 | 固定 verifier receipt 对象 | 身份和摘要可核对则补写；结果不可核对则 invalid，不盲目重复有外部副作用的调用 |
| run/closed 后 task 未关闭 | reducer state + join + retry policy | 幂等补做 Task reconcile，不能重新购买该 Run |
| Task 全终态但 trace 未 seal | 所有 session cuts、尾部 usage | 排空 owned processes，补 seal；缺日志则明确 invalid |
| proposal 已交付但 candidate 未 ready | patchRef/base digest/固定 build recipe | 重放 pure apply，幂等构建/校验相同 revision |
| round 中断，部分 slots 完成 | frozen slots 及既有 root Task refs | 继续同一 slots 到原 deadline；不重置预算和挑选已通过结果 |
| round closed 后 activation 未执行 | closed comparison + expected previous head | 保留候选，等待 activation operator 的授权；不把 result 存在当成 activation |

resume 必须重新装配并比较 composition，不能只比较 preset 名。DSH compaction/clear 若改变 session 身份或丢失必要 receipt，当前 Run 进入 interrupted/context-limit 路径；不擅自构造“同一 Run 已恢复”。这一行为须用确切 DSH 版本验证。

budget exhaustion：先记录不可继续的原因、禁止新动作，再取消/排空 owned work；关闭非 terminal 子树，保留已 terminal Evidence。之后 seal partial trace，round 记 insufficient-evidence。尾部实际费用继续计入，不能用 deadline 前的粗略数值冒充最终 usage。

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
    root 恢复，获得直接 RTL output/receipt 和可能的 feedback 只读引用
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

这个例子不要求新方法总有两个 child，也不要求所有节点必须分解。它展示了从零发现 workflow、形成资产、下一版固定绑定的边界；实际 domain 不需要为此修改 core。

## 20. Protocol conformance 场景

实现必须逐一验证以下 scenario；未跑过就标为 unproven：

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
C-10 cancellation closes live descendant Runs; terminal Evidence and tail usage preserved
C-11 journal replay / torn tail / command idempotency
C-12 DSH resume composition mismatch
C-13 Capsule contamination / hidden read boundary
C-14 RSI proposer receives sealed trace only and validation payload is denied
C-15 MethodPatch rejects task/verifier/scorer edits
C-16 MCP draft/server manifest, transport and capability guards; DSH MCP scope invocation
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

本 V1 发布版冻结 C1–C3、A–F 以及本文全部配套字段、状态、guard、预算和符合性场景。它是唯一的 framework/protocol 施工基线；实现阶段只能实现本文语义，不得把实现选择重新写成隐含架构。

### 22.1 冻结内容

| 冻结组 | 对应章节 | 规范内容 |
|---|---|---|
| 分层与宿主 | 0–3 | 四层、单 writer/fold/wake；DSH 0.2.2-alpha.2；MCP 原生挂载；无第二 Task loop |
| Task 与验收 | 4、9、11、15 | 冻结 Spec/Contract；按 contract digest 索引的 Contract Summary；root 独立验收；Task/Run 状态机；required replacement/retry/join；固定预算 |
| Method 与探索 | 5–6 | 可复用模板目录、有界递归、局部 guidance、公开资源冻结、PlanningSketch、draft 后注册 |
| 本级 workflow | 7–8 | 多批次、一批可并行；binding 派生 required/probe；preview/next-step ack；feedback replan；原子准入 |
| 事实与恢复 | 10、19.1 | 13 种闭合 facts；CAS/单 writer；取消级联；稳定身份恢复；有界 drain |
| 模型界面 | 12–14 | 正向 worker/RSI cards；本层 direct children + 祖先摘要查询；Read/Plan/Decompose/Feedback/Submit/Stop；百分比预算 |
| RSI 演化 | 16–17 | 全树公开 trace 按页读；独立 proposer；MCP server patch；每 Round 一个原子 candidate |
| 评测与启用 | 18 | 可重复 Round；paired plan；全 slot；validation/holdout；active-head CAS |
| 领域边界 | 19、19.2 | 领域包提供 MCP servers、验收、seed、comparator；示例不进入 core |
| 施工与证据 | 20–21、23–24 | 24 个 conformance 场景、复杂度预算、规范 amendment、DSH 实跑证据 |

### 22.2 当前发布状态

~~~text
版本：V1 发布规范
权威文件：SINGULARITY_FRAMEWORK_V1.md
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

遇到未定义行为，先尽量在既有不变量内拒绝/给出明确错误；不能静默添加“临时”行为并回头将其写成事实。确需新语义时暂停依赖该语义的部分，提交 amendment；独立实现工作仍可继续。

### 23.3 实现的 review gates

- protocol package 不依赖 DSH、FS、进程、时钟或领域包；runtime 不出现领域算法与 suite 分支。
- 公开 schema、facts、MCP server schemas、NodeView、role cards 与本文规范逐项对应；门禁复用同一 guard。
- MethodPatch 只能产生新 revision，不能持有平台 writer、root 验收或 activation 能力。
- 第 20 节符合性场景和实际 prompt 测量必须给出 evidence；未跑真实 DSH/模型的行为仍标 unproven。
- 检查通过只证明实现符合本文合同；不能反向产生新架构。实现无法满足规范时报告具体差距，不重写规范来让测试通过。

## 24. 来源、证据与当前交付范围

| 来源 | 本文使用方式 |
|---|---|
| [SINGULARITY_FRAMEWORK_V1_REVISION_NOTES.md](/home/ROXY/code/singualrity_final/SINGULARITY_FRAMEWORK_V1_REVISION_NOTES.md) | A–F 用户确认修改与配套设计输入；本发布版将其冻结为统一规范 |
| [SINGULARITY_HANDOFF.md](/home/ROXY/code/singualrity_final/SINGULARITY_HANDOFF.md)、[SINGULARITY_BLUEPRINT.md](/home/ROXY/code/singualrity_final/SINGULARITY_BLUEPRINT.md) | 研究入口与候选结构；没有继承其接口或规范状态 |
| [core protocol 研究](/home/ROXY/code/singualrity_final/analysis/01-core-protocol-state-machines.md)、[assembly/RSI 研究](/home/ROXY/code/singualrity_final/analysis/02-core-assembly-rsi-runtime.md)、[legacy 对照](/home/ROXY/code/singualrity_final/analysis/03-legacy-vs-core-domain-rsi.md) | 理解旧责任边界、模型界面和具体膨胀来源 |
| [失败诊断](/home/ROXY/code/singualrity_final/analysis/04-failure-diagnosis.md)、[对抗审查](/home/ROXY/code/singualrity_final/analysis/adversarial-review.md) | 区分评测经济、模型完成合同与状态/恢复问题；不把模型陈述当实跑结论 |
| [冻结 V8.2 cut](/home/ROXY/code/singualrity_final/analysis/evidence/v8-2-cut-20261028T1725/cut.json) | 固定研究所据的历史记录；本文没有重新购买实验或使用活跃日志数字 |
| [DSH Agent types](/home/ROXY/code/singularity/.tooling/dsh-022/node_modules/@deepseek-ai/dsh-agent/lib/types/index.d.ts)、[runtime types](/home/ROXY/code/singularity/.tooling/dsh-022/node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts) | 核对 create/resume/setup、inbox、wake、idle 和 handle ownership |
| [DSH tool contracts](/home/ROXY/code/singularity/.tooling/dsh-022/node_modules/@deepseek-ai/dsh-tools/lib/types/contracts.d.ts)、[skill registry](/home/ROXY/code/singularity/.tooling/dsh-022/node_modules/@deepseek-ai/dsh-skill/lib/types/index.d.ts)、[system prompt](/home/ROXY/code/singularity/.tooling/dsh-022/node_modules/@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts) | 核对工具 guard/并发、concludeTurn、资源继承与 prompt contribution 边界 |

DSH 类型核对不等于 runtime conformance。持久 wake 去重、compaction 后阅读义务、完整工具门禁、sandbox/read isolation、取消/恢复与 prompt 实际大小仍必须在实现阶段针对确切版本验证。第 19.2 节只是协议演示，没有任何新领域收益成绩。

本次交付是 V1 发布规范及其文档一致性检查；本轮未实现、迁移、激活 Method 或修改旧项目源码。原始 0.1 草案和修订草案保留作历史参考，不能与本发布版混用。
