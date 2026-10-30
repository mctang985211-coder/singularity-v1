# S4–S7 自主构建启动 prompt

本文件是非规范的整体派发入口。以下正文可直接交给构建主代理；协议语义以 `docs/framework.md` 为准。

---

你负责在 `/home/ROXY/code/singularity-v1` 连续完成 S4–S7，将已完成单 Run 闭环的项目构建为薄的、解耦的、以 Task 为中心的领域任务 RSI 框架。保持 TypeScript、包结构和语法风格与 DSH `0.2.2-alpha.2` 一致。

用户已授权本轮全部已定义构建任务自主推进。请直接实施，持续完成任务卡、代码、结构归位、测试、文档、必要的真实模型/领域验证和既有 PR/CI 流程。每片交付后直接选择下一片；把阶段完成、常规实现选择、同语义修复和必要重构记录下来，然后继续工作。持续推进到 S7 出口，或所有可独立完成的工作都已交付且剩余部分确有外部依赖。

## 1. 建立可追溯基线

依次读取 `AGENTS.md`、`docs/framework.md`、`spec-lock.json`、`docs/build-plan.md`、`docs/conformance.md`、`docs/tasks/s3-final-review.md`、当前任务卡和实际消费者。S4 的细化协议说明另见 `docs/tasks/s4-start-prompt.md`，整体授权与阶段衔接以本文件为准。

先检查工作区、分支、未提交差异、依赖版本和既有证据。保留当前成果，使用 Node >=24.9.0、pnpm 11.18.0、正式 DSH 0.2.2-alpha.2 和 frozen lockfile，取得当前根 `pnpm verify` 基线。将已核对成果纳入可追溯提交，再在既有协作流程内推进后续切片。

S1–S3 已交付；当前完整 conformance 证据为 C-02/C-03/C-11/C-12。其他场景按登记表推进。上轮结算拆分与 S3 执行卡完成 fixture/DSH 回归，全历史 retry workspace 检查已有专项回归；这些结果分别保持其证据等级。把 build-plan 的遗留项分配给下表阶段，在接入相应消费者时完成。

## 2. 每片采用同一施工循环

1. **确定一个可验收行为。** 选当前最早可实施的依赖项，写一张任务卡：Goal、Spec refs、Allowed scope、Non-goals、Done when、失败场景/所需证据、验证命令、Structure done when。阶段可以包含多张任务卡。
2. **先指定归属与消费者。** 写清事实来源、状态 owner、调用方向、最终模块、当前消费者和保护的不变量。让新函数、类型、配置、分支与其消费者在同片落地。
3. **取得必要的失败证据。** 对协议/缺陷使用最小负例，对宿主行为使用目标版本的真实 DSH 场景。测试证明业务边界及 observable behavior，复用现有 fixture 和证据读取方式。
4. **实现最小闭环。** 先完成阻碍本行为的同语义整理，再沿既有权威路径接入行为、拒绝路径、恢复、预算与清理。让模型看到的提示、schema、discovery 和 dispatch 同时反映实际能力。
5. **完成行为与结构出口。** 运行根 `pnpm verify` 和 `git diff --check`；审查最终 diff、所有消费者、公开导出、依赖和大文件变化；合并重复推导并删除失去消费者的代码。
6. **登记并继续。** 在当前任务卡补充命令、结果、证据、规模与未覆盖项，更新 build-plan/conformance；按既有提交、PR 和 CI 流程整合，然后直接进入下一片。

切片的交付单位是完整行为及其模块归属。测试转绿后继续完成结构审查，再关闭任务卡。使每次整理服务于当前消费者，详细领域内容进入领域包和 Method 资产。

## 3. 以职责和单一权威控制规模

保持 `runtime → protocol`、`app → runtime`、`domain → protocol public types`。protocol 拥有纯类型/schema/guard/fold；runtime 组合 DSH 与既有事实；app 负责启动装配；领域包拥有领域文档、技能、MCP server、case、验收与 comparator。

沿当前职责扩展：`agent.ts` 负责 DSH 生命周期与观察，`run.ts` 负责编排/预算/NodeView，`run-settlement.ts` 负责统一结算，`recovery-execution.ts` 负责已有 Run 的继续与恢复，`service.ts` 是唯一 command writer，`store.ts` 拥有 CAS/journal。正式 child 复用同一 Run 执行与结算路径。资源解析、batch 调度、trace、proposer、evaluation 随真实消费者引入清晰的内部模块，公开接口保持最小。

每个职责使用一个事实来源：业务事实进入唯一 journal，状态经唯一 fold 派生，对话留在 DSH session log，dispatch/skill/MCP 复用 DSH 原生能力。让新行为直接消费这些来源；共同逻辑在出现真实重复消费者时合并。保留单一 reducer/store 的集中权威，根据职责而非文件数量决定内部拆分。

按 AGENTS §4.1 审查规模：生产文件达到 800 行后，新增职责先在任务卡写明拆分计划或有依据的保留理由；已有大文件本片增加约 150 行或 20%（较小值）时，在本片拆出新增职责，或写明有消费者和不变量依据的保留理由。任务卡记录 before/after 行数、拆分结果、导出/依赖变化及清理项。已有单一 fold、CAS/journal 权威可以有依据地集中保存。

框架与领域保持解耦：常规领域扩展以新增领域包、Case 和 Method revision 完成；公共核心按冻结协议处理这些输入。给每项复杂性一个当前消费者和具体 conformance 依据，其余设计想法留在讨论记录，随实际需要再评估。

## 4. 按依赖推进 S4–S7

| 顺序 | 实施片段 | 本片交付重点 |
|---|---|---|
| S4-A | Method pin → guided guidance/skill → 原生 MCP 资源装配 | 分步接入固定 revision、冻结资源、Composition、声明/dispatch/读取授权和失败 disposal；stdio 与 streamable-http 采用已验证的 DSH 接口。 |
| S4-B | prepare/commit 与一个 direct batch 的执行闭环 | 完整固定用例持久交付，后续模型 step ack，原子 children-admitted，fact 后 dispatch，每 child 独立 session/workspace/预算；parent 正常 yield，batch terminal 后稳定 wake；失败路径有 scheduler feedback。 |
| S4-C | required/probe join、多批次与父整合 | 以当前 parent Run/binding 计算 obligation/winner；direct frozen outputs 的授权、只读挂载、后批输入和 Evidence/verifier 输入 snapshot 一致；parent 保留自身验收。 |
| S4-D | child retry、replacement、取消和恢复 | child 先结束自身 retry；terminal failure 的同 binding replacement 生成新 Task/证据链；当前 Run winner、旧证据、稳定 dispatch/wake、取消 drain 与尾部 usage 全部闭合。 |
| S4-E | child-worker feedback 与 parent replan | feedback 非阻塞；source closure、scheduler feedback、整批 Task terminal、parent wake/新 sketch/replacement 形成闭环。 |
| S4-F | Contract Summary 与 ancestor read | 按 contractDigest 派生的只读摘要、独立有界 Summary Worker、祖先链授权、SUMMARY_PENDING/版本/来源、ownerTask/root usage。 |
| S4-G | 空 Method、逐级探索与 prompt 整合 | 固定 explore-child、冻结全局公开资源、逐级 direct-child 分解、skill/MCP draft 产物；完整 worker card 与能力面同步，历史分页和提示体积有实测。 |
| S5-A | root eligibility、trace seal 与按页公开 trace | 全树 terminal、所有 Run 已结算、owned work drain、稳定 usage/session cuts 后 seal；公开 DSH 轨迹按 CAS refs/页读取，读取授权固定到 source root。 |
| S5-B | 独立 proposer composition 与读面 | 冻结 base Method、sealed trace、公开评测目标、预算百分比、rsi_read/rsi_submit_patch；隔离 validation/holdout/private payload。 |
| S5-C | MethodPatch schema、pure apply 与 candidate precheck | 一个 Round 一个正式 patch；模板/例子/skill/MCP server 及绑定生成新 revision；live contract、root acceptance 与平台权威由原 owner 保持。 |
| S5-D | MCP bundle/capability/部署预检与幂等恢复 | candidate-ready 形成固定候选与 receipt；复用原生 transport、manifest、能力边界、构建 recipe 和固定身份；失败返回明确 rejection。 |
| S6-A | 冻结 RoundPlan、slot 与隔离 Capsule | 成对 base/candidate、case 顺序/seed、deadline/预算/环境策略固定；可写环境与缓存按 slot 隔离，隐藏数据由 evaluator/verifier scope 提供。 |
| S6-B | evaluation 执行、恢复与完整成本 | 使用同一 Task runtime 执行固定 slots；保留 invalid/missing、全部尝试、summary、尾部费用与取消证据；从固定 slots/事实恢复同一轮。 |
| S6-C | 领域 comparator 与 Round decision | 从完整公开 Evidence 和领域固定规则比较；validation/holdout、质量/成本和证据不足均有真实路径；Round 正式结论由 host 生成。 |
| S6-D | active-head CAS 与连续 Round | 在隔离测试 head 验证 expected previous head、并发冲突、第二 Round 的新 sealed trace 和幂等恢复；生产 head 沿部署既有 activation 权限策略。 |
| S7-A | 普通 guided Task 与递归/空 Method 实跑 | 真实模型证明本级工作、必要分解、用例 ack、技能/领域工具、草稿、父整合及独立验收；使用有目标、验收和可冻结产物的现实任务。 |
| S7-B | 祖先查询、feedback replan、取消/恢复及压力实跑 | 补齐剩余 runtime 证据，包括自动 compaction 的预算/epoch/重读、不可停止 owned work 的隔离与最终计量、实际 MCP resource/template 成功内容。 |
| S7-C | 连续领域 Round 与冻结多 case 评测 | 真实 proposer 改进 Method，paired baseline/candidate、validation/holdout、回归及质量/成本标准形成冻结证据，追踪全部正式尝试。 |
| S7-D | 全部 conformance、结构与交付复核 | 逐项审查 C-01–C-24 和 build-plan 出口，核对实际 assembled prompt/token/费用、资源清理与领域解耦；交付可复现命令、refs/digests 和准确剩余项。 |

上表表达依赖和职责，实施时按一个可验收行为继续切小。必要的负例、恢复、结构归位及真实 DSH/模型验证随消费该能力的当前切片完成；下片消费已稳定的结果。S4 验收 C-04–C-09/C-21/C-22，S5 验收 C-14–C-16，S6 验收 C-13/C-17–C-19/C-23/C-24，C-01/C-10/C-20 与各片受影响的已有场景持续回归，S7 补齐跨阶段真实模型和领域等级证据。

## 5. 保持模型界面短而可执行

模型可见文字统一采用“当前目标 → 当前可用动作 → 结果/下一步 → 剩余预算百分比”的正向结构。冻结平台 card、NodeView、模板 guidance、skill discovery、tool schema 和按需正文各有明确位置，信息在所属位置交付一次；具体权限、状态和验收由 schema/guard/verifier 执行。

worker 只组织当前层的 direct children。PlanningSketch 的 level 0/1/2 分别是当前层、direct children、预期 grandchildren；join 来自固定 binding。TaskProposal 的模型字段保持 goal/localCriteria/授权 inputs/localOutputs；host 合并模板验收与固定资源。每个 required obligation 按当前 parent Run/binding 解析 terminal、未 supersede 的 verified winner，retry 和 replacement 复用统一规则。

首个 prepare 自动展示完整固定用例，后续模型 step 显式 ack 才准入。feedback 写入与 source Run closure 分开，parent 在整批 child Task terminal 后醒来。普通 worker、exploration worker、parent、retry、Summary Worker、proposer 与 verifier 分别得到规范定义的视图和工具面。

按 §14.3 实测并执行 worker card 2 KiB、NodeView 8 KiB、guidance 8 KiB、child example 12 KiB、prepare 32 KiB、全部 tool schema 12 KiB、skill discovery 8 KiB、单页 read/skill 16 KiB。大正文按稳定 cursor 读取；contextEpoch 与完整交付 receipt 支持 resume/compaction 后的重读。超限时先收敛资源与正文组织，保持冻结限额及完整摘要目录。

## 6. 证据、预算和领域接入

复用既有模型路由、凭据环境、DSH profile 和测试基础设施。为每张需要实跑的任务卡固定最小 case 集、请求/token/时间上限和清理条件，按用户本轮授权直接运行必要验证。先用小场景取得证据，定位失败并修复后再扩展；将每次正式尝试及失败费用如实登记，冻结 Round 的 slots 与重试策略保持稳定。

优先使用仓库已有领域 Case、Adapter 和可复用公开材料。若尚无完整领域包，按 §19 和已有验收要求接入一个现实、范围有界、可独立验收的参考任务，将领域算法、MCP server、verifier/comparator、cases 和资源集中放入领域包。通过公共接口验证新域接入，核心保持通用。领域结论按该域实际公开/validation/holdout 标准给出，分别报告协议通过、单题表现和多 case 收益。

证据按仓库/类型、真实 DSH、alpha2 集成、真实模型和领域评测分级。将真实命令、环境、规范条目、证据 refs/digests、usage、是否真实模型与未覆盖项一并写入任务卡/conformance；只有实际满足场景时更新 proven。模型结论使用冻结 acceptance/Evidence，费用使用真实 usage，trace 引用原 DSH 日志区间。

## 7. 自主处理分歧、阻塞与长线交接

实现选择依据冻结规范、当前消费者与失败证据决定。文字、引用和同语义缺陷可直接修订；编辑规范文本时记录 diff 和原因并同步 digest。公开协议、authority、验收权、可见性、预算上限与 DSH 版本沿现有冻结边界实施。确需超出这些边界时形成有最小复现的 amendment 候选，保持依赖入口明确拒绝，并继续全部已定义的独立工作；在最终交接列出差距和提案。

环境问题先检查已有 profile、路径、安装包和配置并修复标准入口。外部凭据、服务、数据或硬件确实缺失时，记录复现命令、已尝试的修复、受影响场景与解除条件，将这些场景保持 unproven，然后继续可独立完成的实现和验证。构建任务的自主推进与产品中的固定运行策略分别按各自授权执行。

让当前 build-plan 和任务卡承载短交接：当前已完成片段、正在处理的行为、下一依赖、未验证项、必要命令与证据引用。历史任务卡保留为历史证据，当前入口保持唯一。上下文压缩或会话恢复后从这些事实和最新 diff 继续，复用已完成成果；交接记录服务于下一步实施。

持续向用户提供简短进度：已经证明什么、当前在解决什么、下一步将验证什么。阶段结束后继续实施下一阶段。最终交付说明 S4–S7 实现与结构结果、根验证和 CI、真实模型/领域证据、实际成本、规范差异及所有未解决的外部依赖；按实际证据给出完成程度。
