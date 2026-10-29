# Singularity 项目级 Agent 工作约束

## 1. 唯一规范与当前阶段

- 唯一 framework/protocol 权威是 `docs/framework.md`，状态为 **V1 发布规范**。旧草案、旧实现、handoff、蓝图和运行记录只作证据与反例。
- `spec-lock.json` 固定当前规范 digest。规范变化必须先有获批 amendment，再在同一变更中更新规范、lock、相关协议和 conformance。
- 当前仓库进入 V1 构建阶段，按 `docs/build-plan.md` 从 S1 推进。不得把文件骨架、类型核对或 CI 通过描述成 Task/RSI 功能已经实现。
- 不继承旧 Singularity、singularity-core、singularity-harness 的接口、状态、兼容层或包结构。不得用代码先形成行为，再回写规范追认。
- 规范冲突、字段缺失或行为未定义时，停止受影响部分并提出 amendment；独立且已定义的工作可以继续。

## 2. 不可绕过的架构边界

1. 业务概念只保留 Task、Run、Method、Evidence、RsiRound。Task 树是只读投影，不新增 Graph、Workflow、Campaign、Review、Release authority。
2. 一个 domain journal、一个 command writer、一个 fold、一个 Task wake authority。不得增加第二写入路径、第二事实账本或 transcript mirror。
3. DSH 拥有 Agent、Session、模型 loop、tool/skill registry、MCP client、prompt/context、persistence 和 sandbox。Singularity 不实现第二个通用模型 loop 或可变资源 registry。
4. 正式 child Task 使用独立 DSH Agent session。helper 只做有界只读工作，不创建 Task、不调度、不验收、不写合同或 Method。
5. root 及 descendants 固定同一 Method revision。运行中的合同不可变；新 revision 只影响未来 root。
6. root acceptance 由 operator/domain 拥有。模型不能自定 verdict/score，不能通过 required、role、output 或 verifier 字段弱化验收。
7. worker 只创建 direct children。PlanningSketch 不是 Task、Workflow 或调度依据。祖先摘要只是带来源的派生视图，原合同始终是权威。
8. 领域 Tool 只使用 DSH 原生 MCP server 接入。不得新增 TS 转接层、`entry.execute`、ProcessToolContext、TS process-tool runner 或第二套工具协议。
9. Method 绑定完整 MCP server；transport 只使用 `docs/framework.md` 冻结且目标 DSH 已验证支持的形式。
10. Proposer 只提交 MethodPatch。评测、比较、activation 由宿主执行；validation/holdout payload 通过独立视图和对象授权隔离。
11. 模型可见 prompt 使用正向引导；模型可见预算使用剩余百分比。精确计量只留在宿主。
12. Round 可连续执行，不引入 Campaign。source replay 只是 smoke evidence，不能单独证明领域改进或自动发布。

## 3. 变更分类与停止条件

### 需要规范 amendment 和用户确认

- 新增或改变公开协议字段、authority、状态、fact、命令、工具、模型角色；
- 改变验收所有者、读取授权、模型可见性、wake 来源、重试/join/replacement/取消语义；
- 新增 writer、fold、registry、transcript、自动 loop、兼容层或 DSH patch；
- 升级 DSH/Node、引入新的 MCP transport、改变生产权限或 activation 规则；
- 用 source replay 替代领域 validation，或把未验证行为写成已完成。

Amendment 至少包含：规范条目、最小复现、现有扩展点为何不足、拟改语义、权限与预算影响、兼容性、conformance 变化和用户确认记录。

### 可在已授权实现任务内完成

- 不改变语义的函数拆分、命名、存储实现、性能优化和缺陷修复；
- 已定义 DomainAdapter 的领域实现和 MethodPatch 范围内的资产变更；
- 为已定义行为补充测试、文档和诊断。

“临时 tool”“兼容 shim”“简单 fallback”“再开一个 driver”都不是豁免理由。受阻时保留可工作的其他部分，明确报告未实现项。

## 4. 每个编码任务的工作流程

1. **先写任务卡**：Goal、Spec refs、允许修改范围、非目标、Done when、检查命令。多包或行为变更先计划，再编辑。
2. **先读真实依赖**：检查公开类型、所有当前消费者、测试和最近的嵌套 AGENTS.md。不得仅凭旧经验推测接口。
3. **切最小垂直片段**：一次完成一个可验收行为或一个 conformance scenario。机械重命名与行为修改分开，不顺手重构无关代码。
4. **先建立失败证据**：优先增加能复现缺陷或违反协议的测试，再实现。不得删除断言、跳过测试、放宽验收或修改规范制造绿色结果。
5. **保持单一职责**：每个新 abstraction、状态、配置项和依赖都必须指出当前消费者及其保护的不变量；没有当前需要就不添加。
6. **禁止隐性扩张**：不新增 common/util 杂物层、循环依赖、重复 validator、平行类型体系、死代码、无人使用的 option 或预留扩展点。
7. **同步文档**：更新受影响的公开类型、README、JSDoc、规范、构建计划和本文件；删除描述旧行为的注释，不写变更历史式注释。
8. **审查最终 diff**：检查是否越界、是否引入第二权威、是否更新所有消费者、是否有真实执行证据。评审聚焦规范与正确性，不以增加 abstraction 回应所有风格意见。

并行 Agent 必须修改独立工作区，不共享可写 checkout、workspace、HOME、缓存或未提交变更；不得同时修改同一文件或同一协议切片。

## 5. TypeScript、依赖与 DSH 风格

- 目标宿主固定为 DSH `0.2.2-alpha.2`，Node `>=24.9.0`，pnpm `11.18.0`。不得使用旧 vendored DSH、全局 dsh 或旧 link 依赖冒充目标环境。
- 采用 `packages/<group>/<package>`、TS ESM、严格类型、`import type`、本地 `.ts` 导入、包 exports、tsconfig references、包级 tests、Cordis effects 和可验证 disposal。
- `src/types.ts` 只放类型。protocol 不依赖 DSH、FS、网络、进程、时钟或领域包；runtime 不出现领域算法或 suite 分支；app 只做 composition。
- 依赖方向保持 `runtime → protocol`、`app → runtime`、`domain → protocol public types`。不得反向依赖或跨层读取内部模块。
- schema 与 TS 类型只设一个权威来源，不得在多个文件手写平行 validator。
- 新生产依赖必须服务于当前消费者，优先复用 DSH 已有能力，并在 manifest/lockfile 中固定；不得因“常用”而假设依赖存在。
- 应用程序通过 DSH profile 启动，不另造 CLI、旁路 launcher 或脚本化第二运行时。

## 6. 验证命令与证据等级

当前统一入口：

```text
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` 是唯一根门禁，依次执行：

```text
pnpm verify:project   # node scripts/verify-project.mjs：规范、仓库、CI、架构与 protocol 纯度门禁
pnpm typecheck        # pnpm --recursive typecheck：所有 workspace 包，覆盖 src 与 test
pnpm lint             # pnpm --recursive lint：所有 workspace 包
pnpm test             # pnpm --recursive test：所有 workspace 包
pnpm build            # tsc -b tsconfig.json：经 references 构建 app 与 protocol
```

当前根入口已覆盖 app 与 protocol 的 typecheck、lint、test 和 build。不得新增绕过根入口的 CI 检查；交付前必须运行根 `pnpm verify`，不能只运行局部测试。

证据按以下等级区分：

1. **仓库/类型/单元证据**：规范 digest、架构检查、纯 protocol reducer、guard、schema 和负例。
2. **真实组合证据**：通过实际 Cordis/DSH profile 启动，验证声明与 dispatch 两层门禁、disposal 和持久状态。
3. **alpha2 集成证据**：真实验证 Agent setup/resume、MCP/skill 可见性、concludeTurn、wake 去重、compaction epoch、取消清理和 prompt/token 计量。
4. **真实模型证据**：执行普通 guided Task、递归探索、祖先查询、反馈后重规划和连续领域 Round。脚本 Agent 不能替代。
5. **领域改进证据**：冻结多 case、validation/holdout、baseline/candidate 隔离和完整成本；单题改善或 fixture pass 不属于此等级。

最终说明必须列出实际运行的命令、结果、覆盖的规范条目和未验证行为。测试失败、环境不满足或场景未执行时，明确标记未验证，不得宣布完成。

## 7. 安全、权限与不可逆操作

- 不读取、复制或传输 secrets、私有 validation payload、golden answers 或私有 verifier 数据。
- 候选 MCP server 在隔离环境运行，具有明确 filesystem/network/capability/resource limits、timeout 和 cleanup；启动或清理失败按协议结算，不静默降级。
- 构建者可在 `docs/build-plan.md` 范围内自主创建分支、提交和 PR，并运行已声明预算内的模型/领域验证；CI 全部成功后，由自动工作流批准，clean PR 直接 squash merge，其余符合条件的 PR 启用 squash auto-merge。不得直接 push main、force push、reset、rebase 或改写历史。
- 生产部署、Method activation、超出已声明预算的付费实验、其他外部写入或扩大权限仍需明确授权。
- 不通过破坏性清理绕过测试和环境问题。
- 标准检查受阻时先修复标准路径，不用旁路脚本替代，不擅自缩小交付范围。

## 8. 本文件的维护

保持本文件简短、当前、可执行。只有反复出现的摩擦、仓库无法自明的决定和必须强制的不变量才写入这里；详细协议留在规范，局部规则放在更靠近代码的嵌套 AGENTS.md。嵌套文件不能放宽本文件的架构、权限和证据要求。规范或命令变化时，在同一变更中更新本文件并删除过期规则。
