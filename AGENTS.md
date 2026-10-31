# Singularity 项目级 Agent 工作约束

## 1. 以唯一规范推进当前阶段

- 以 `docs/framework.md` 作为 framework/protocol 的唯一权威，其状态为 **V1 发布规范**；旧草案、旧实现、handoff、蓝图和运行记录仅用于提供证据与反例。
- 使用 `spec-lock.json` 固定规范 digest。规范演进先形成获批 amendment，再在同一变更中同步规范、lock、相关协议和 conformance。
- 按 `docs/build-plan.md` 的切片推进，并以真实行为、证据等级和 Done when 描述进度。文件骨架、类型核对和 CI 通过分别代表其自身证据等级。
- 用户已授权 S4–S7 连续施工。以 `docs/tasks/s4-s7-start-prompt.md` 为本轮派发入口，完成每片出口后直接推进下一片；任务拆分、同语义修复、文档整理、必要验证与已有协作流程在该授权内自主完成。
- 当前施工状态由 `docs/build-plan.md`、`docs/conformance.md` 和当前切片任务卡共同给出；标为 historical/superseded 的任务卡保留当时证据，不再下达工作、权限或阶段阻断要求。
- 新实现从当前规范出发，保持旧 Singularity、singularity-core、singularity-harness 的接口、状态、兼容层和包结构独立于本仓库。
- 遇到规范冲突、字段缺失或未定义行为时，暂停受影响切片并提交 amendment；继续推进其他已定义且独立的工作。

## 2. 保持架构边界

1. 业务概念使用 Task、Run、Method、Evidence、RsiRound；Task 树保持只读投影。
2. 每个 domain 使用一个 journal、一个 command writer、一个 fold 和一个 Task wake authority；领域事实只进入 journal，对话轨迹留在 DSH session log，并通过 sessionId 与日志区间关联。
3. DSH 拥有 Agent、Session、模型 loop、tool/skill registry、MCP client、prompt/context、persistence 和 sandbox；Singularity 通过宿主接口组合这些能力。
4. 正式 child Task 使用独立 DSH Agent session；helper 执行有界只读工作，其产物保持只读。
5. root 及 descendants 固定同一 Method revision；运行中的合同保持不可变，新 revision 只影响未来 root。
6. root acceptance 由 operator/domain 拥有；模型提供声明产物，host 根据冻结合同与独立 receipt 分类。
7. worker 只创建 direct children；PlanningSketch 仅作为模型计划，祖先摘要仅作为带来源的派生视图，原合同始终提供权威内容。
8. 领域 Tool 通过 DSH 原生 MCP server 接入，Method 绑定完整 server；transport 使用 framework 已冻结且目标 DSH 已验证的形式。
9. Proposer 只提交 MethodPatch；评测、比较和 activation 由宿主执行，validation/holdout payload 通过独立视图与对象授权隔离。
10. 模型可见 prompt 使用正向引导，模型可见预算使用剩余百分比；精确计量保留在宿主。
11. Round 可连续执行，并继续使用 RsiRound 表达；source replay 仅作为 smoke evidence，领域改进由独立多 case 证据证明。

## 3. 按职责放置代码

保持依赖方向 `runtime → protocol`、`app → runtime`、`domain → protocol public types`。protocol 保持纯 TS，仅允许规范的纯 hash 能力；runtime 复用 DSH，app 只做 composition。

| 模块 | 负责的职责 | 调用关系 |
|---|---|---|
| `protocol/src/*` | 业务类型、schema、guard、纯 reducer、digest、纯视图 | 由 runtime 与 domain 调用 |
| `runtime/src/store.ts` | 单 journal、CAS、字节级 replay；`ReferenceValidator` 递归校验 Method/Contract/Composition 的 skill/MCP tree leaf | 由 service 调用；>800 行保留单一 CAS/replay authority，不拆第二 validator |
| `runtime/src/service.ts` | normalized command → 单 fact append、唯一 writer、fold 入口 | 由 Run/RSI 命令路径调用 |
| `runtime/src/errors.ts` | 跨执行模块共享的稳定内部错误与错误码，包括 `MethodResourceError` | 由 agent/agent-skills/agent-mcp/run/recovery/resources/skill-resources/mcp-resources 调用 |
| `runtime/src/agent.ts` | DSH create/resume/setup、bounded wait、wake、job drain、session usage/cut；调用 `agent-mcp.ts` 完成 MCP 资源根、mount/surface 与 cleanup，并在 acquisition timeout 时 bounded grace/quarantine root（late dispose 拒绝保留 root） | 返回宿主观察，由 Run 编排决定结算 |
| `runtime/src/agent-skills.ts` | Agent scope 原生 skill 注册、`skill` tool 可用性、discovery/definition 的 runtime+opaque winner 校验 | 由 `agent.ts` setup 调用；不拥有 registry |
| `runtime/src/run.ts` | Run admission/open/drive、预算/controller、NodeView 与执行编排 | 调用 agent/service/workspace/run-settlement |
| `runtime/src/run-settlement.ts` | 提交与执行记录的统一结算、CAS/fact commit、结果封存与返回值构造 | 由 run 与 recovery-execution 调用；不拥有 Run admission 或 DSH loop |
| `runtime/src/recovery-execution.ts` | 既有 Run 的继续、关闭、恢复，以及 frozen journal/Composition/submission 读取 | 复用 run-settlement 与 agent 观察 |
| `runtime/src/recovery.ts` | retry/resume 宿主入口、固定 retry policy、fresh workspace 检查 | 调用 recovery-execution |
| `runtime/src/tools.ts` | DSH scoped Task tools 与共享 dispatch guard（含未绑定 skill/MCP server/tool/resource 拒绝） | 由 Run setup 注册 |
| `runtime/src/prompt.ts` | 固定 cards、NodeView 类型与模型可见预算展示 | 由 Run/agent composition 调用 |
| `runtime/src/resources.ts` | Method/template/guidance/skill/MCP 冻结资源编排与授权视图、structured digest、own guidance 8 KiB、Composition resource equality 与 platform prompt 校验 | 由 run/recovery/agent 调用；app 通过 host 组合注入 `PLATFORM_PROMPT_SERVICE` renderer |
| `runtime/src/skill-resources.ts` | Method skill 资产解析、bundle/SKILL.md/引用文件校验、discovery 8 KiB 与 result 16 KiB 上限、contract bundle refs 相等 | 由 `resources.ts` 调用；agent 只消费冻结结果 |
| `runtime/src/mcp-resources.ts` | Method MCP 资产解析、manifest/config/schema/bundle/sourceFiles 校验、deployment capability allowlist、public name、Composition 六字段相等、DSH instruction/resource section 投影 | 由 `resources.ts`/`run.ts`/`agent-mcp.ts` 调用；不挂载或写宿主目录 |
| `runtime/src/agent-mcp.ts` | frozen MCP bundle 先全量 materialize（0700 root、`O_EXCL` 0600）、Run 专属 HOME/XDG/credential-channel env、DSH 原生 stdio mount、实际 scoped surface 校验与 cleanup | 由 `agent.ts` setup 调用；不解析 Method 身份；不是完整 sandbox |
| `runtime/src/resource-bundle.ts` | 只读 sealed tree manifest/CAS 文件读取、路径/排序/structured digest/字节数校验 | 由 `skill-resources.ts`/`mcp-resources.ts` 调用；不写 workspace 或宿主目录 |
| `runtime/src/workspace.ts` | workspace 准备、no-follow 遍历、输出冻结 | 由 Run 提交路径调用 |
| `runtime/src/verification.ts` | 独立 verifier、receipt 校验、Evidence/ExecutionRecord 值构建 | 由 run-settlement 结算调用 |
| `runtime/src/round.ts` | 固定 RsiRound procedure | **planned（S5/S6+；当前树中尚不存在）**，由未来 trace/proposer/evaluation 切片调用 |

新增文件时先将其放入上表对应职责；新职责先核对 framework 的既有对象和模块，再确定最小归属。

### 正确的结构示例

以下伪代码展示依赖方向，而不是新增公开接口：

```ts
// agent.ts：形成宿主观察，不决定业务 verdict。
const observation = await driveAgent({ prepared, request, service, mode, controller, ...options })

// run.ts / recovery-execution.ts：根据冻结合同、工具事实和宿主观察，
// 调用 run-settlement.ts 的同一结算入口。
const settlement = tools.submission && observation.drainPending === false
  ? await settleSubmitted(...)
  : await settleExecutionRecord(...)

// run-settlement.ts：按既有事实和 receipt 完成封存与关闭。
return finalizeSettlement(...)
```

扩展 child、proposer 或 evaluation 时，沿用这条调用链，让每种状态继续由原有事实和唯一 writer 产生。

## 4. 用正向工作法保持薄实现

1. **先写任务卡**：包含 Goal、Spec refs、允许范围、非目标、Done when、Structure done when 和检查命令；多包或行为变更先形成最小垂直切片计划。
2. **先指定当前消费者**：为每个新函数、字段、配置项和分支写明真实调用方、保护的不变量及对应 conformance 场景；候选项先留在任务卡，成熟后随消费者一起引入。
3. **先读取真实依赖**：核对公开类型、所有当前消费者、测试、DSH 声明和最近的嵌套 AGENTS.md。
4. **先同语义整理，再接新行为**：当一个文件承载多个独立场景时，先按上表职责做小步拆分，保持协议与运行行为一致，再加入下一场景。
5. **先建立失败证据**：使用最小复现或 conformance 负例驱动实现，保持原有断言、验收强度和测试启用状态。
6. **让负例锚定证据**：新失败场景引用 framework、conformance 或已复现日志；真实模型证据用于确定必要行为，fixture 用于高效回归，推测性防护先经过最小复现验证。
7. **优先复用已有事实**：从 journal、CAS、DSH session/header/tool result 和原生 job/usage 事件派生视图。preview/read receipt 沿用 DSH tool result/CAS，trace 引用 session cut，summary/evaluation usage 沿用 UsageRecord。
8. **保持测试资产共享**：新模型场景复用现有 profile、chat fixture、wake adapter 和证据读取方式；场景差异留在输入与预期结果。
9. **以净简化结束切片**：删除零消费者导出、重复投影、平行输入形式、替代写路径和重复 helper，并同步清理旧注释、公开类型、README、构建计划和证据边界。
10. **审查最终 diff**：确认单一权威、完整消费者、单向运行时依赖和真实执行证据；使用风格评论改善清晰度，而不制造额外 abstraction。

并行 Agent 使用独立 worktree、独立 `DSH_HOME`、缓存和未提交变更，并按文件与协议切片划分修改范围；宿主 HOME 不作为隔离边界。

### 4.1 结构完成门禁

- **最小纵切以完整行为与清晰模块归属交付。** 每片同时完成行为验证、职责归位、公开导出审查和依赖方向审查；新职责进入其明确的所属模块。
- 每张可执行任务卡写出 `Structure done when`，至少包含最终模块归属、公开导出或依赖变化、涉及的超大文件，以及拆分或保留的理由。
- 生产文件达到 **800 行** 后，新增职责必须在任务卡中给出拆分计划或明确例外；单个切片在已有大文件中增加约 **150 行或 20%**（取较小触发值）时，必须拆出职责，或记录消费者、不变量和暂不拆分的理由。仅增加测试不能替代该记录。
- 结构整理以净简化和边界清晰为出口：删除无消费者导出、平行入口和重复状态；根据消费者与不变量决定拆分，保持单一 fold、writer 和验收权威。

## 5. 保持 TypeScript、依赖与 DSH 风格一致

- 使用 DSH `0.2.2-alpha.2`、Node `>=24.9.0`、pnpm `11.18.0`；目标环境使用正式安装包和固定 lockfile。
- 使用 `packages/<group>/<package>`、TS ESM、严格类型、`import type`、本地 `.ts` 导入、包 exports、tsconfig references、包级 tests、Cordis effects 和可验证 disposal。
- `src/types.ts` 仅承载类型；protocol 与 FS、网络、进程、时钟、DSH 和领域包保持隔离，runtime 与领域算法和 suite 分支保持隔离。
- schema 与 TS 类型使用一个权威来源，并复用同一 validator。
- 新生产依赖服务于当前消费者，优先复用 DSH 能力，并在 manifest/lockfile 中固定。
- 应用通过 DSH profile 启动，组合入口保持在 app。

## 6. 使用统一验证与证据等级

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` 依次执行 `verify:project`、build、typecheck、lint 和 test，是本地与 CI 的唯一根门禁。build 先按 references 生成 protocol 产物，再构建 runtime/app，保证干净 checkout 可验证。

证据按以下等级记录：

1. 仓库、类型、schema、reducer、guard 和协议负例。
2. 真实 Cordis/DSH profile 的声明、dispatch、disposal 和持久状态。
3. alpha2 的 Agent setup/resume、MCP/skill、concludeTurn、wake、compaction、取消和计量。
4. 真实模型的 guided Task、递归探索、祖先查询、反馈重规划和连续 Round。
5. 冻结多 case、validation/holdout、baseline/candidate 隔离及完整成本的领域改进。

最终说明列出实际命令、结果、规范条目、证据 digest 和未验证行为；环境缺失或未执行的场景保持 unproven。

## 7. 保护权限、数据与不可逆操作

- secrets、私有 validation payload、golden answers 和私有 verifier 数据仅进入其授权边界；文档、Composition、日志和证据使用公开引用。
- 候选 MCP server 在隔离环境运行，配置明确的 filesystem/network/capability/resource limits、timeout 和 cleanup；启动与清理结果按协议结算。
- 构建任务可在 build-plan 范围内创建分支、提交和 PR，并运行已声明预算内的验证；CI 通过后使用既定自动批准与 squash merge 流程，main 历史保持线性且受保护。
- S4–S7 必要的小规模模型/领域验证按本轮授权执行：先在任务卡固定 case、请求/token/时间上限和清理条件，再运行并登记全部尝试及费用。更大规模实验按其单独授权执行。
- 生产部署、生产 Method activation、构建协作流程以外的外部写入和权限扩张按明确的对应授权执行。
- 环境问题先修复标准路径，并保留可工作的独立切片与明确未验证项；标准检查继续使用根入口。

## 8. 规范演进与本文件维护

公开协议字段、authority、状态、fact、命令、工具、模型角色、验收所有者、读取授权、wake 来源、重试/join/replacement/取消语义、writer/fold/registry/transcript、自动 loop、DSH/Node/transport、生产权限和 activation 规则的演进，先形成 amendment 和用户确认。Amendment 包含规范条目、最小复现、既有扩展点分析、拟改语义、权限与预算影响、兼容性和 conformance 变化。

内部函数拆分、同语义命名/存储/性能/缺陷修复、已定义 DomainAdapter 实现、MethodPatch 资产和已定义行为的测试文档，可沿现有授权切片完成。

保持本文件简短、当前、可执行。反复出现的摩擦、仓库无法自明的决定和必须强化的职责边界记录在这里；详细协议留在 framework，局部规则放在更近的嵌套 AGENTS.md。规范或命令变化时同步更新，并及时移除过期规则。
