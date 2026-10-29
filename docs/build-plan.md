# Singularity V1 构建计划

本文件是非规范构建流。切片顺序可以依据证据调整，但不得改变 `docs/framework.md` 冻结的字段、guard、可见性、权限或完成语义。每个切片单独形成可审查变更，未完成对应证据前不宣称下一阶段能力已经成立。

## S0 — 仓库与规范门禁

- **状态**：已完成；后续构建从 S1 推进。
- **范围**：正式规范、spec digest、conformance registry、统一 `pnpm verify`、GitHub CI、验证后自动批准与 auto-merge、main 分支保护。
- **出口**：本地与远程 `verify` 通过；私有仓库、保护配置和后续 PR 自动合并链路均已核对。
- **边界**：不包含 protocol/runtime 业务实现。

## S1 — DSH 0.2.2-alpha.2 宿主 spike

- **状态**：已完成；S1-A–S1-E 全部完成，S1 Done when 已满足。
- **S1-A 出口证据**：真实 DSH `0.2.2-alpha.2` profile 的 fixture 与真实模型路径各通过 1/1；覆盖 create/setup/resume、首请求前 prompt/context/skill/tool 装配、restrict/guard dispatch、concludeTurn、usage 持久化、resume 无新请求和凭据未写入 DSH home。详见 `docs/tasks/s1-a-agent-composition.md`。
- **S1-B 出口证据**：真实 DSH profile 与官方 `@modelcontextprotocol/server` `2.2.0` stdio fixture 通过；覆盖 mount 前 allowlist、startup failure 不发布 Agent、agent-scoped 原生挂载、schema/prompt instructions/resource tools、echo/fail/tool guard、resource server guard、`250ms` timeout、pre-abort/in-flight abort、dispose 后声明移除及所有 fixture PID exit。无真实模型请求；resource 成功路径仅空 `resources`，`read_mcp_resource`/template 未验证。详见 `docs/tasks/s1-b-mcp-stdio.md`。
- **S1-C 出口证据**：真实 DSH profile 与官方 `@modelcontextprotocol/server` `2.2.0` + `@modelcontextprotocol/node` `2.0.0` streamable-http fixture 通过；覆盖 mount 前 allowlist、closed-port startup failure、`server/discover`→`initialize`→`initialized`→`tools/list`→`tools/call`、每请求配置 header、schema/prompt/resource surface、echo/fail/tool/resource guards、`250ms` timeout、pre-abort/in-flight abort、dispose 后声明消失、无新请求及所有 HTTP sockets 关闭。无真实模型请求。根 `pnpm verify` tests `3/3`；详见 `docs/tasks/s1-c-mcp-streamable-http.md`。
- **S1-D 出口证据**：真实 DSH profile + chat fixture 验证稳定 `MessageId`：首次发送 1 请求；完成后与 resume 后 already-admitted 不新增请求/turn；raw DSH 同 ID followup 对照会第二次购买；pending/removed/unknown/corrupt 全部 fail closed；独立子进程 provider 收到 hanging 请求后 SIGKILL，父 resume 为 interrupted、无 assistant settlement/usage unknown、deliver 不重发且外部请求仍为 1。请求数以 chat fixture 实际 HTTP 计数，不用 `request/header`；仅 test-local helper，无生产 wake authority 或新账本。根 `pnpm verify` tests `5/5`；详见 `docs/tasks/s1-d-wake-delivery.md`。
- **S1-E 出口证据**：真实 DSH profile + chat fixture 验证 self-read/preview tool result 原 receipt 为 current；dispose/resume 后 surface 仍可见，但 `session/end-seed` 改变 epoch 使 receipt stale；真实 `ctx.compaction.compactNow()` 增加恰好一次 summarizer fixture 请求，`compaction/start`/`summary`/`end` 与 `shadowedSeqs` 齐全，surface/`deriveMessages` 不含旧正文，receipt epoch+surface 双失效；`inbox.clear` 不改变 epoch/surface。helper 直接复用 `@deepseek-ai/dsh-compaction` 公开类型，无平行事件声明。根 `pnpm verify` tests `6/6`；详见 `docs/tasks/s1-e-compaction-epoch.md`。
- **剩余未验证**：自动 pressure compaction/prune、失败/取消 compaction、pending/removed wake 成功恢复、provider exactly-once、resource read/template 成功内容、C-12 composition mismatch、C-16 manifest/capability precheck 与 C-20 等后续场景；这些不阻挡 S1 已完成的范围，但保持 unproven，C-12/C-16/C-20 整体亦未改为 proven；`docs/conformance.md` 与 `spec-lock.json` 未改。
- **下一步**：S2 protocol；S2-A（JSON/JCS/digest/schema 基础）已完成，S2 继续。
- **规范引用**：§2、§3、§12、§14、§19.1。
- **实现位置**：优先放在未来 runtime 的真实组合测试和 app profile，不新增独立产品包。
- **工作**：验证 Agent create/resume/setup、scoped prompt/tool/skill、global tool restrict、MCP `stdio` 与 `streamable-http` 挂载及 disposal、concludeTurn、wake 去重、compaction epoch、取消/disposal、实际 prompt/token 计量；两种 transport 均须通过 server/tool guard，不得只验证连接成功。
- **Done when**：目标 alpha2 的真实组合运行证明声明与 dispatch 两层能力面一致，恢复不重复购买请求，MCP/server disposal 完整；所有未覆盖行为仍标为 unproven。
- **禁止**：修改 DSH 本体、引入 patch/shim、使用旧 vendored DSH 或全局 dsh 替代目标版本。

## S2 — Protocol 类型、schema、digest 与纯 reducer

- **状态**：进行中，S2-A 已完成。
- **S2-A 出口证据**：JSON/JCS/digest/schema 基础通过 protocol tests `49/49`，app 组合 tests `6/6`，根 `pnpm verify` 全通过；严格 parser、JCS、8 个 digest domain 与 closed schema 已实现。zod 固定为 protocol `4.4.3`、app dev `4.6.7`；protocol 无 `@deepseek-ai` 依赖，`src` 不访问 FS/网络/进程/时钟，仅允许 `node:crypto` 纯 hash。详见 `docs/tasks/s2-a-protocol-foundation.md`。
- **剩余未验证**：闭合 fact payload、command guard、纯 reducer、journal/FS、runtime/DSH 业务执行与真实模型；所有 conformance 场景保持 unproven，`docs/conformance.md` 与 `spec-lock.json` 未改。
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
