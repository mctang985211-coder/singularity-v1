# S4 启动构建派发 prompt

本文是非规范的主代理派发指令。复制下文给负责 S4 的构建代理；协议始终以 `docs/framework.md` 为准。

S4–S7 的连续自主构建采用 [整体启动 prompt](s4-s7-start-prompt.md)；本文件保留 S4 的专项细化说明，整体授权、预算执行与阶段衔接以整体启动指令为准。

---

在 `/home/ROXY/code/singularity-v1` 推进 S4：Method、资源装配、分解、replacement 与祖先反馈。直接实施已定义行为，以逐片交付完成 S4。先完成 S4-A 的任务卡与实现，再依赖顺序推进后续切片；每片必须同时满足行为出口与结构出口，不能以阶段规划或测试转绿代替交付。

## 先核对基线

读取 `AGENTS.md`、`docs/framework.md`、`spec-lock.json`、`docs/build-plan.md`、`docs/conformance.md`、`docs/tasks/s3-s4-structure-handoff.md`，以及受影响模块的实际类型、消费者、测试和最近的嵌套 AGENTS。旧任务卡中的测试数字、旧状态和建议只作历史证据。

S1–S3 已完成；C-02/C-03/C-11/C-12 已有证据。S4 仍待实现。当前 profile 关闭自动 compaction；当前 S3 执行卡只描述 read/plan/submit/stop，完整规范 worker card 保留在源码。先检查工作区已有变更，保留它们；核对 Node >=24.9.0、pnpm 11.18.0、正式 DSH 0.2.2-alpha.2 和 frozen lockfile。根 `pnpm verify` 是统一门禁。

本 prompt 只安排实现，不授予规范演进权。framework/spec-lock、公开协议、authority、状态、fact、工具输入和验收权的变化先走 amendment；遇到真正缺口只暂停受影响部分，继续独立且已定义的工作。

## 施工方式与职责边界

把 S4 分为下表的独立切片，不作为一次单文件“最小纵切”。主代理负责依赖顺序、集成和状态登记。可将独立只读核对或边界清楚的实现派给子代理；并行实现使用包含同一基线的独立 worktree、独立 DSH_HOME、workspace 和缓存，不共享可写 checkout 或实验资源。涉及同一 writer、fold、公共类型或装配点的变更顺序整合。

每片动手前写一张任务卡，包含 Goal、Spec refs、Allowed scope、Non-goals、Done when、失败场景及所需证据、检查命令、Structure done when。结构出口写明最终模块归属、真实消费者、公开导出/依赖变化、触发大文件规则的处理；完成后补充实际 diff 规模与结果。只为本片消费者引入实现，后续模块不预建骨架。

下表是依赖顺序，不要求每行恰好只有一张任务卡。S4-A 先接 Method pin 与最小 guided resource，再分别接 skill、原生 stdio/streamable-http 的装配和失败清理；任一步触发职责混合或大文件增长规则，就在该阶段内继续切小。每张实施卡仍须独立闭环验证。

- 复用现有 `agent.ts` 的 DSH 生命周期、`run.ts` 的 Run 编排、`run-settlement.ts` 的统一结算、`recovery-execution.ts` 的继续与恢复；child 不另建模型 loop 或复制整套 root driver。
- Method 资源解析与授权装配形成清晰边界，随 S4-A 的消费者引入；child batch 调度随 S4-B/C 引入最小职责模块。`tools.ts` 负责声明与统一 dispatch guard，领域生命周期不堆进工具执行体。
- `service.ts` 仍是唯一 command writer，protocol 仍是唯一 fold，CAS/journal 沿用 `store.ts`；同语义 helper 不成为第二状态源。
- `store.ts` 与 `protocol/reducer.ts` 可保持各自单一权威；大文件治理按职责和真实变化执行，不为缩短行数机械拆成碎片。
- 不新增通用 util/common 层、Graph/Workflow authority、第二 registry/transcript、TS MCP adapter、领域算法或 suite 分支。

## 顺序切片

| 切片 | 范围及规范引用 | 行为出口与证据重点 |
|---|---|---|
| S4-A Method pin 与资源装配 | §4–§6、§11–§14、§19 | root 固定 revision，后续 child 沿用该 pin；冻结的 guidance、skill、完整 MCP server 通过原生 DSH 装配，声明与 dispatch 一致，Composition 可复验；失败/越权与 disposal 有真实 DSH 证据。先接通 guided 资源，探索 fallback 留到 G。 |
| S4-B prepare/commit 与 direct batch 生命周期 | §5、§8–§11、§14 | C-04/C-05：完整固定用例先交付，后续模型 step 显式 ack 后才原子准入；fact 后 dispatch，每 child 独立 session/workspace/预算；active batch 正常 yield，不算 no-submission；最后 child Task terminal 后恢复 parent。 |
| S4-C required/probe join 与多批整合 | §7、§11–§12 | C-06/C-07：按 binding 解析 obligation/winner，所有已创建 child terminal 后才可 submit；父仍经自身 verifier；先批次结果可授权给后批次，frozen direct outputs 与 Evidence/verifier inputs 来自同一 snapshot。 |
| S4-D child retry、replacement 与恢复 | §4.2、§7.1、§9–§11、§19.1 | child 先完成自身 retry，Task terminal failure 与最小 scheduler feedback 路径闭合后才可 replacement；新 Task/合同/证据链，旧证据保留；同一 parent Run 的 winner 不跨 Run 复用。覆盖持久化边界、重复 dispatch/wake 和 descendant 取消。 |
| S4-E direct-parent feedback 与 replan | §7.2、§8、§9.3、§14 | C-21/C-22：非阻塞 feedback、source Run closure、scheduler 记录、batch terminal 和 parent wake 闭合；parent 更新本级 sketch 后建立 replacement，保留旧 Evidence。 |
| S4-F Contract Summary 与 ancestor read | §4.2、§6.3、§7.2、§12 | 摘要按 contractDigest 索引、不回写合同；独立只读 Summary Worker；沿祖先链授权、SUMMARY_PENDING、版本和来源明确；usage 归 ownerTask/root 或对应 evaluation slot，查询不偷用 child/RSI 预算。 |
| S4-G 局部探索、空 Method 与整合验收 | §5–§6、§12–§15 | C-08/C-09：固定 explore-child、冻结全局公开资源、逐级独立分解；draft skill/MCP server 作为产物，等待 RSI 注册；跨层可见性、prompt 体积与历史分页有证据。 |

B 的调度和 yield 是本片可运行闭环，不能推到后片后把 B 宣称完成；其 child 失败路径须按规范记录 scheduler feedback，不等 E 再补。D 使用相同结果/反馈路径实现 replacement；E 补齐 child-worker feedback 工具及完整 replan 证据。最终按 `build-plan` 验收 C-04–C-09/C-21/C-22，同时回归受影响的 C-01/C-02/C-03/C-10/C-11/C-12/C-20；未覆盖的完整场景继续保留 unproven。

## 必须保持一致的协议规则

1. **模型输入与验收权**：worker 只填写 TaskProposal 的 goal、localCriteria、授权 inputs、localOutputs。required、OutputSpec.role、binding、join、acceptance/verifier/scorer、资源、parentId、supersedesChildIds、feedbackRef 等权威字段由 host 派生；未知或越权字段直接拒绝，不覆盖后继续。
2. **计划与用例**：PlanningSketch level 0 是当前层、1 是 direct children、2 是预期 grandchildren；只有 level 1 可由本 worker 准入。directPlan 只引用可见 binding，join 来自 Method。prepare 不创建 Task/fact/预算预留；commit 验证持久 DSH tool result、同 Run/Method/template、当前 contextEpoch 与 sketch、完整用例及后续模型 step 的 ack。同 tool batch 猜 ack、缺页、旧 epoch 均拒绝。
3. **join、retry、replacement**：required obligation 以当前 parent Run 的 bindingId 为单位；每 obligation 最多一个 active child，verified 且未 supersede 的 terminal child 才是 winner。child Task 的失败不直接关闭 parent Run。host 只替换同 binding、同 parent Run、已 terminal 且未 supersede 的失败 predecessor，不替换 verified winner。新 parent Run 重新解决全部 required obligations。
4. **batch 与 feedback**：一次只有一个 active batch；成员是 child Task，含各自 retry。feedback 写入本身不终结 source Run、不立即 wake parent；scheduler feedback 引用已存在的 Evidence/ExecutionRecord。batch 全部 Task terminal 后 parent 才醒，等待不占模型执行槽。parent submitted/closed 后的迟到 feedback 只留 trace，不唤醒旧 Run。
5. **授权与结算**：parent 只自动读取自己的 direct results；其他数据须显式 inputs 授权。不读取兄弟、孙节点内部计划或 privateReceipt。child 输出挂到父只读命名空间，不 overlay 父 workspace；提交、verifier 和 Evidence 的输入 snapshot 保持逐位一致。取消、drain、tail usage、retry 预算沿已有权威闭合。
6. **探索与资源**：本层模式由 host 决定；已有 children 绑定不再补通用逃生门。空 Method 用固定 explore-child，默认 probe；只有 admission/domain 固定时才为 required。.agent 等资源来自冻结公开 snapshot，不继承真实宿主 HOME。run 中新建 SKILL.md/MCP server 是 draft artifact，不能即时注册或改变绑定。
7. **DSH 与 prompt**：领域工具通过 DSH 原生 MCP，transport 仅 stdio/streamable-http。按规范保持声明与执行两层 guard，含 native/PTC 路径。完整规范 card 只随能力面接通后装配；逐片保持当前执行提示与实际工具一致，移除临时 S3 卡时同步 Composition 与恢复测试。NodeView/工具页/skill discovery 按 §14.3 的限额及稳定 cursor 验证，避免重复注入。开启自动 compaction 前先接 summary 预算、usage 与 epoch/重读失效路径。

## 每片完成和 S4 交付

每片先用能证明不变量的最小负例或真实 DSH 场景实施，再运行根 `pnpm verify` 与 `git diff --check`。补齐结构出口、清理重复 helper/导出/旧文档后才进入下一片；不把所有整理推到 S4 末尾。

真实模型实验沿仓库既定路由执行，先在任务卡固定最小 case 集、请求/token/时间预算与清理条件，再按本轮自主构建授权运行必要验证。key 使用既有进程环境。fixture 保持对应证据等级，conformance 的 proven 更新同时记录实际命令、环境、规范条目、证据 digest、usage、是否真实模型及未覆盖项。

最后更新 build-plan、conformance 和当前任务卡，报告每片完成项、实际验证、文件职责/规模变化、真实模型成本及剩余 unproven。S4 不包含 trace/proposer、MethodPatch 演化、evaluation Capsule、Round procedure 或 activation，这些仍归 S5/S6。遇到规范缺口形成 amendment，不用实现先造出新的协议。
