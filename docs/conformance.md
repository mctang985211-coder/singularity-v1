# Singularity V1 Conformance Registry

本文档是构建证据登记表，不增加协议语义。规范中的 C-01–C-24 必须分别形成可审查证据；仓库初始化阶段全部标记为 `unproven`。脚本 Agent、fixture pass 或静态配置检查不能替代真实 DSH、真实模型或领域评测证据。

Amendment 001（[docs/amendments/001-s2-protocol-closure.md](amendments/001-s2-protocol-closure.md)）已获批准并纳入正式规范；本表只登记证据，不因 amendment 批准而改变任何状态。C-01/C-05/C-10/C-11/C-14/C-19/C-23 的实现证据必须覆盖该 amendment 的 K1–K5 语义；真实证据出现前不得标记 `proven`。

Amendment 002（[docs/amendments/002-acceptance-and-submission.md](amendments/002-acceptance-and-submission.md)）已获用户于 2026-10-30 批准并纳入正式规范；`AcceptanceRef=object`、`PublicReceipt`/`SubmissionManifest` strict schema、host 分类、digest 顺序、`exit`/`timedOut`、`checks`、opaque `privateReceipt` 和 invalid receipt 边界见 `docs/framework.md` §4.0、§4.3、§11.4–§11.5、§15.3、§19.1。本表只登记证据，不因 amendment 批准而改变状态；C-02/C-03/C-11/C-12 已由真实 DSH + 真实模型证据标为 `proven`。

| ID | 场景 | 主要规范范围 | 证据 owner | 状态 |
|---|---|---|---|---|
| C-01 | root contract freeze | §4、§10.2、§11 | protocol/runtime | unproven |
| C-02 | one Run submit and external receipt | §4.3、§9、§11–§11.5、§15、§15.3、§19 | runtime/domain adapter | proven |
| C-03 | no-submission and fresh retry | §9、§11、§15.3、§19.1 | runtime | proven |
| C-04 | first decompose prepare exposes example; commit without ack refused | §5、§8、§14 | runtime/tool guard | unproven |
| C-05 | child bindings cannot be model-supplied | §5、§8、§10.2 | protocol/runtime | unproven |
| C-06 | parent required join and own verifier | §7、§11 | runtime/domain adapter | unproven |
| C-07 | parent can issue another direct batch after first terminal batch | §7、§11 | runtime | unproven |
| C-08 | child-level recursive exploration stays locally scoped; PlanningSketch may look 2–3 levels | §6、§12 | runtime/DSH adapter | unproven |
| C-09 | empty Method + explore-child + skill/MCP-server draft artifact | §5、§6、§15 | runtime/Method adapter | unproven |
| C-10 | cancellation closes live descendant Runs; terminal Evidence and tail usage preserved | §10、§15.2、§19.1 | runtime | unproven |
| C-11 | journal replay / torn tail / command idempotency | §10、§15.2–§15.3、§19.1 | protocol/runtime | proven |
| C-12 | DSH resume composition mismatch | §2、§11、§19.1 | DSH adapter | proven |
| C-13 | Capsule contamination / hidden read boundary | §15、§19 | domain adapter | unproven |
| C-14 | RSI proposer receives sealed trace only and validation payload is denied | §15.2、§16、§17 | RSI/runtime | unproven |
| C-15 | MethodPatch rejects task/verifier/scorer edits | §4、§17 | protocol/RSI | unproven |
| C-16 | MCP draft/server manifest, transport and capability guards; DSH MCP scope invocation | §2、§5、§17、§19 | DSH/domain adapter | unproven |
| C-17 | paired base/candidate runs use distinct capsules | §15、§18、§19 | evaluation runtime | unproven |
| C-18 | missing/invalid evidence is insufficient, not zero | §11、§18 | comparator/domain adapter | unproven |
| C-19 | activation uses expected-head CAS | §10.2、§18 | activation service | unproven |
| C-20 | prompt/tool/skill/NodeView percentage budget display; growing child history stays paginated | §12–§14 | DSH adapter/runtime | unproven |
| C-21 | child feedback and scheduler no-submission feedback reach direct parent | §7、§9、§14 | runtime | unproven |
| C-22 | feedback-driven replan creates new child contracts while retaining old Evidence | §7、§8、§11 | runtime | unproven |
| C-23 | two consecutive Rounds use active-head CAS and cannot overwrite each other | §10.2、§18 | RSI/evaluation runtime | unproven |
| C-24 | single-case gain with validation regression is not improved | §18 | comparator/domain adapter | unproven |

S4-B1（2026-10-31）只登记局部回归：真实 DSH fixture 覆盖 prepare 的完整 `TaskExample`（app 对冻结 example 做 deepEqual）、`interface.instanceSchema`、host 派生 join/brief/template 身份、A2 skill summary、持久 `tool/result` 后的 status `current`、无 child/fact/预算副作用，以及 commit action 的 `INVALID_ARGUMENT` 拒绝。`next-step-required`/`stale`、preview/receipt domain 互读、example/result 12/32 KiB、result refs/order/source/tamper、NodeView 8 KiB preflight、no-child guard 与 directPlan 可见性由 runtime unit 覆盖，不冒充真实 DSH 场景。未实现 commit admission、child dispatch、required/probe join 或 parent yield，因此 C-04/C-05 保持 `unproven`，不因本片 prepare 或 `pnpm verify` 通过而升级。

## C-02 证据（proven）

- **状态**：`proven`（2026-10-30，S3-B2 单 Run 执行闭环）。
- **真实模型**：`true`。`SINGULARITY_SPIKE_LIVE=1`，endpoint `http://127.0.0.1:16660/v1`，model `deepseek-v4.1-flash`，`reasoning=max`。
- **环境**：官方 Node `24.9.0`、pnpm `11.18.0`、DSH `0.2.2-alpha.2`。
- **规范条目**：§9、§11、§15、§15.3（并覆盖 §4.3、§19）。
- **实际命令**：

```bash
pnpm install --frozen-lockfile
pnpm verify
# project → build → typecheck → lint → test all passed
# protocol 225/225, app 11/11, runtime 44/44 (280 total)
git diff --check

export SINGULARITY_SPIKE_LIVE=1
export SINGULARITY_SPIKE_BASE_URL=http://127.0.0.1:16660/v1
# SINGULARITY_SPIKE_API_KEY 仅由进程环境提供，不写入仓库
pnpm --filter @singularity/app test
```

- **Evidence digest**：既有 `sha256:2cf1acd25b5f46ca5289bab9ccb238502b36d52bc195a7944b3c49bfcd059ec4`；2026-10-31 最终复跑 `sha256:e78abbf37462eb639a0fead42b5dee4ccab3dc9d9ab25da115ac350fe6154af7`。
- **覆盖**：真实 DSH 的 verified、no-submission、invalid criterion、verifier timeout、symlink 场景；verified 路径包含 self-read、plan、native bash、submit、稳定 wake、fact 顺序、manifest/receipt/usage/sessionCut；verifier 只读冻结 CAS，活动 workspace 被篡改后仍读取冻结 bytes；no-submission 与 invalid 使用 ExecutionRecord，不冒充 Evidence。最终复跑还使用真实 scoped Composition，并关联成功 tool result。
- **未覆盖**：C-03/C-11/C-12 见各自证据；领域评测或 RSI 收益不属于 C-02。

## C-03 证据（proven）

- **状态**：`proven`（2026-10-31，S3-C fresh retry）。**真实模型**：`true`；默认 chat `http://127.0.0.1:16660/v1`、`deepseek-v4.1-flash`、`reasoning=max`；Node `24.22.2`、pnpm `11.18.0`、DSH `0.2.2-alpha.2`。
- **实际命令**：`SINGULARITY_SPIKE_LIVE=1 pnpm --filter @singularity/app test`；API key 仅由进程环境提供，未设置 BASE_URL。全部 live app 场景 `31/31` 通过。
- **规范条目**：§9、§11、§15.3、§19.1。首 Run `no-submission`，ExecutionRecord `sha256:d7693e1fcdf7d4ba0632b297e04f9ff7f79aa0f0e0b9739459b4b378c93ee236`，usage `2198/47 tokens, 1 step, unknown=0`；fresh Run/session/workspace 重新 submit/verify，manifest `sha256:c40e8220a6f37bd809adeb64020171752a7931fb1cfb580011f3830d65fd3069`，receipt `sha256:7c246c6737947bc2ccd6f2236ce0c419d57770268efb529c1e4a71305c7e5b77`，Evidence `sha256:e44ca08d5a95cf1e0165b95043b1b3a4ec696f2994f5db24f8ae06daf1a9d5fd`，usage `39380/2110 tokens, 6 steps, unknown=0`。
- **覆盖**：旧 ExecutionRecord 保留，新 Run 不复用旧 verdict/receipt；retry worker 收到公开 `lastAttempt`；DSH `SessionHeader.cwd` 支持 canonical workspace freshness，相同路径和 symlink 别名回归拒绝。
- **后续专项回归**：全历史 attempt 路径比较已在 [S1–S3 最终复核](tasks/s3-final-review.md)修复并通过 fixture：第三次尝试拒绝复用第一次目录及 symlink，历史 cwd 缺失时拒绝；没有新增真实模型请求，本条保留原有 live 证据范围。
- **未覆盖**：不可停止进程的实际 sandbox quarantine、真实模型的三次尝试隔离和完整 evaluation Capsule；这些不属于本次 C-03 live 证明。

## C-11 证据（proven）

- **状态**：`proven`（2026-10-31，真实 C-03 journal 的关闭恢复与重放）。**真实模型**：`true`，来自上述同一 C-03 两次 Run；closed resume/replay 不再购买模型请求。
- **实际命令**：`SINGULARITY_SPIKE_LIVE=1 pnpm --filter @singularity/app test`，与 C-03 同次执行。
- **规范条目**：§10、§15.2–§15.3、§19.1。closed resume 返回原 manifest/receipt/Evidence/run/task refs，零重复 verifier、模型或 CAS 冻结；全量 replay `7` facts，完整无 LF tail 被截断且 journal/CAS 不变。Run closed `sha256:474009f63b28a62a3c1fd0e764ffce63ca47e822f36449ca9af06bd1c9cb934e`，Task closed `sha256:ce34a480b29f6a50d59cca81b90a9bdea04287ef93ae4c34a56d6a70ebc682d8`。
- **覆盖**：真实对象身份、稳定 refs、关闭后幂等恢复、torn tail；commandId 冲突及不同顺序/refs 的负例由 runtime `85/85` 中的联合重放测试补充，不冒充真实模型场景。
- **未覆盖**：OS 进程强杀/掉电和跨进程 writer lock；本次是真实 FS journal/CAS 的重开与重放。

## C-12 证据（proven）

- **状态**：`proven`（2026-10-31，真实 DSH session 的 Composition resume）。**真实模型**：`true`，seed 使用上述默认路由；resume/mismatch 不新增模型请求。
- **实际命令**：`SINGULARITY_SPIKE_LIVE=1 pnpm --filter @singularity/app test`，与 C-03 同次执行。
- **规范条目**：§2、§11、§19.1。原 Composition 得到 `wakeOutcome=already-admitted`，零新 turn/request，ExecutionRecord `sha256:747218380f262e2e5d2147c052419ba9726ff27dfc7dc1c0183d9e8a330e5bb4`，usage `1312/1 tokens, 1 step, unknown=0`。完整 Composition 变化在 Agent/verifier/模型前结算 invalid，ExecutionRecord `sha256:47059755eaae09d696f68085242e1c89d4d13ac4d5babbd652f6b29618b847c8`，usage `unknownRequests=1`。
- **未覆盖**：非目标 DSH 版本、动态更新 live Task contract 或绕过 Composition 的恢复；这些均不由本场景授权。

## 验收、提交与重放证据边界

- **C-02**：必须证明 submit 只接收非 draft output IDs 与 `includeLearningDrafts`，不接收 verdict/score/ref/role/required/timedOut；`SubmissionManifest` 与 `PublicReceipt` 绑定同一冻结合同、同一授权输入 snapshot（含 direct child outputs）和同一输出 snapshot；required criteria 恰一次；exit=0 只在 receipt 完整、身份/digest 匹配、全部 pass、`timedOut=false` 且 `signal=null` 时为 verified；invalid receipt 不是 acceptance Evidence。规范：[§11.4–§11.5、§15.3](../framework.md)。
- **C-03**：必须证明 no-submission/stop/cancelled 不生成 `SubmissionManifest` 或 `PublicReceipt`，缺 receipt 是定义行为而不是零分；timeout 不伪造成 signal；fresh retry 使用新 Run/session/workspace，重新 submit、重新冻结、重新生成 receipt，旧 verdict 不复制、不覆盖；invalid receipt 仅诊断，不扩展 `ExecutionRecord`。规范：[§9、§11.5、§15.3、§19.1](../framework.md)。
- **C-11**：必须证明 manifest/receipt 的稳定排序、无时间戳、固定 `operationId` 和对象不可变性支持 journal replay、torn-tail 恢复与 commandId 幂等；同一 commandId + commandDigest 重放返回原 fact 和原 refs，不重新冻结、不重新验证；不同顺序/不同 refs 产生不同 digest 并按身份不匹配拒绝。真实 journal 的完整证据见 [`s3-closure`](tasks/s3-closure.md)，顺序/refs 负例由联合回归补充。规范：[§10、§15.3、§19.1](../framework.md)。

C-02/C-03/C-11/C-12 已有真实 DSH + 真实模型证据；其余场景保持 `unproven`。协议 schema 通过、`pnpm verify` 通过、文档 digest 一致或 fixture verifier pass 都不能单独升级状态。

每次状态更新必须同时记录实际命令、运行环境、规范条目、证据对象 digest、未覆盖部分和是否使用真实模型。没有证据的场景保持 `unproven`，不能仅因 `pnpm verify` 通过而改为 `proven`。
