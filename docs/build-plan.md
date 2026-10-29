# Singularity V1 构建计划

本文件是非规范构建流。切片顺序可以依据证据调整，但不得改变 `docs/framework.md` 冻结的字段、guard、可见性、权限或完成语义。每个切片单独形成可审查变更，未完成对应证据前不宣称下一阶段能力已经成立。

## S0 — 仓库与规范门禁

- **状态**：已完成；后续构建从 S1 推进。
- **范围**：正式规范、spec digest、conformance registry、统一 `pnpm verify`、GitHub CI、验证后自动批准与 auto-merge、main 分支保护。
- **出口**：本地与远程 `verify` 通过；私有仓库、保护配置和后续 PR 自动合并链路均已核对。
- **边界**：不包含 protocol/runtime 业务实现。

## S1 — DSH 0.2.2-alpha.2 宿主 spike

- **状态**：进行中，S1-A 已完成。
- **S1-A 出口证据**：真实 DSH `0.2.2-alpha.2` profile 的 fixture 与真实模型路径各通过 1/1；覆盖 create/setup/resume、首请求前 prompt/context/skill/tool 装配、restrict/guard dispatch、concludeTurn、usage 持久化、resume 无新请求和凭据未写入 DSH home。详见 `docs/tasks/s1-a-agent-composition.md`。
- **剩余未验证**：MCP `stdio`/`streamable-http` 及 server/tool guards、失败/timeout/取消/disposal、稳定 wake/message ID 去重、compaction/context epoch receipt 失效；C-12/C-16/C-20 保持 unproven，`docs/conformance.md` 与 `spec-lock.json` 未改。
- **规范引用**：§2、§3、§12、§14、§19.1。
- **实现位置**：优先放在未来 runtime 的真实组合测试和 app profile，不新增独立产品包。
- **工作**：验证 Agent create/resume/setup、scoped prompt/tool/skill、global tool restrict、MCP `stdio` 与 `streamable-http` 挂载及 disposal、concludeTurn、wake 去重、compaction epoch、取消/disposal、实际 prompt/token 计量；两种 transport 均须通过 server/tool guard，不得只验证连接成功。
- **Done when**：目标 alpha2 的真实组合运行证明声明与 dispatch 两层能力面一致，恢复不重复购买请求，MCP/server disposal 完整；所有未覆盖行为仍标为 unproven。
- **禁止**：修改 DSH 本体、引入 patch/shim、使用旧 vendored DSH 或全局 dsh 替代目标版本。

## S2 — Protocol 类型、schema、digest 与纯 reducer

- **规范引用**：§4、§5、§9、§10。
- **工作**：建立 `packages/singularity/protocol`，选择单一 schema 权威源，实现冻结对象、闭合 facts、命令 guard、纯 projection、JCS/digest 和错误 union。
- **Done when**：C-01、C-05 及 C-11 的纯协议部分有正负例；protocol 不依赖 DSH、FS、网络、进程、时钟或领域包；根 `pnpm verify` 已纳入 typecheck、lint、test、build。
- **禁止**：第二套平行类型、手写重复 validator、runtime 副作用进入 protocol。

## S3 — 单 Task/Run 执行闭环

- **规范引用**：§9、§10、§11、§15、§19.1。
- **工作**：建立 runtime 的单 writer/journal/CAS、workspace、Agent 驱动、submit/stop、独立 verifier、Evidence、usage 和恢复。
- **Done when**：C-02、C-03、C-12 通过真实 DSH 组合；模型自述和 idle 不会完成 Task；提交只消费冻结 CAS；失败与基础设施 invalid 不混淆。
- **禁止**：第二 writer、第二模型 loop、报告决定验收、从活动 workspace 复验。

## S4 — Method、分解、replacement 与祖先反馈

- **规范引用**：§4–§8、§12–§14。
- **工作**：实现 Method pin、资源绑定、PlanningSketch、preview/commit、required/probe obligation、replacement、direct-parent feedback、Contract Summary 和只读祖先查询。
- **Done when**：C-04–C-09、C-21、C-22 通过；旧合同与 Evidence 不可变；每个 required binding 的 winner/supersession/retry 语义一致；summary usage 归属可核对。
- **禁止**：Graph/Workflow authority、孙节点直建、跨兄弟读取、模型修改 binding 或验收。

## S5 — Trace seal 与 RSI proposal

- **规范引用**：§16、§17。
- **工作**：物化公开 trace chapters、分页 ProposerView、MethodPatch、MCP bundle precheck 和 candidate revision。
- **Done when**：C-14–C-16 通过；Proposer 无法读取 validation payload；每 Round 只有一个正式 patch；MCP 使用 DSH 原生接入，无 TS 转接层。
- **禁止**：Proposer 运行实验、写分数、activation、读取其他 root 或私有对象。

## S6 — Evaluation、Capsule 与连续 Round

- **规范引用**：§15、§18、§19。
- **工作**：实现冻结 slot、隔离 capsule、paired baseline/candidate、领域 comparator、validation/holdout 和 active-head CAS。
- **Done when**：C-13、C-17–C-19、C-23、C-24 通过；missing/invalid 不填零；source replay 不自动发布；连续 Round 不覆盖并发 activation。
- **禁止**：Campaign authority、共享可写评测环境、重试到通过、无比较器时由模型给分。

## S7 — 真实模型与领域证据

- **规范引用**：§20 及对应领域包合同。
- **工作**：执行普通 guided Task、递归探索、空 Method、祖先查询、反馈后重规划、连续领域 Round，并测量实际 prompt、token、成本与清理。
- **Done when**：真实模型场景及领域声明的验收全部有冻结证据；C-20 和剩余未验证项有明确状态；单题或 fixture 成绩不被表述为领域泛化。
- **禁止**：未经单独授权的大规模付费实验、以脚本 Agent 替代真实模型、删减不利样本。

## 每片共同出口

- PR 中的 Goal、规范引用、范围和 Done when 完整；
- 根 `pnpm verify` 通过，且已纳入项目门禁、typecheck、lint、test 和 build；
- 最终 diff 无越界、第二权威或无关重构；
- 文档、测试、证据等级和未验证项同步更新；
- 不通过删减验收、跳过测试或缩小交付来结束切片。
