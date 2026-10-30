# Singularity V1 Conformance Registry

本文档是构建证据登记表，不增加协议语义。规范中的 C-01–C-24 必须分别形成可审查证据；仓库初始化阶段全部标记为 `unproven`。脚本 Agent、fixture pass 或静态配置检查不能替代真实 DSH、真实模型或领域评测证据。

Amendment 001（[docs/amendments/001-s2-protocol-closure.md](amendments/001-s2-protocol-closure.md)）已获批准并纳入正式规范；本表只登记证据，不因 amendment 批准而改变任何状态。C-01/C-05/C-10/C-11/C-14/C-19/C-23 的实现证据必须覆盖该 amendment 的 K1–K5 语义；真实证据出现前不得标记 `proven`。

Amendment 002（[docs/amendments/002-acceptance-and-submission.md](amendments/002-acceptance-and-submission.md)）已获用户于 2026-10-30 批准并纳入正式规范；`AcceptanceRef=object`、`PublicReceipt`/`SubmissionManifest` strict schema、host 分类、digest 顺序、`exit`/`timedOut`、`checks`、opaque `privateReceipt` 和 invalid receipt 边界见 `docs/framework.md` §4.0、§4.3、§11.4–§11.5、§15.3、§19.1。本表只登记证据，不因 amendment 批准而改变状态；C-03/C-11 仍为 `unproven`，C-02 已由 S3-B2 真实 DSH + 真实模型证据标为 `proven`。

| ID | 场景 | 主要规范范围 | 证据 owner | 状态 |
|---|---|---|---|---|
| C-01 | root contract freeze | §4、§10.2、§11 | protocol/runtime | unproven |
| C-02 | one Run submit and external receipt | §4.3、§9、§11–§11.5、§15、§15.3、§19 | runtime/domain adapter | proven |
| C-03 | no-submission and fresh retry | §9、§11、§15.3、§19.1 | runtime | unproven |
| C-04 | first decompose prepare exposes example; commit without ack refused | §5、§8、§14 | runtime/tool guard | unproven |
| C-05 | child bindings cannot be model-supplied | §5、§8、§10.2 | protocol/runtime | unproven |
| C-06 | parent required join and own verifier | §7、§11 | runtime/domain adapter | unproven |
| C-07 | parent can issue another direct batch after first terminal batch | §7、§11 | runtime | unproven |
| C-08 | child-level recursive exploration stays locally scoped; PlanningSketch may look 2–3 levels | §6、§12 | runtime/DSH adapter | unproven |
| C-09 | empty Method + explore-child + skill/MCP-server draft artifact | §5、§6、§15 | runtime/Method adapter | unproven |
| C-10 | cancellation closes live descendant Runs; terminal Evidence and tail usage preserved | §10、§15.2、§19.1 | runtime | unproven |
| C-11 | journal replay / torn tail / command idempotency | §10、§15.2–§15.3、§19.1 | protocol/runtime | unproven |
| C-12 | DSH resume composition mismatch | §2、§11、§19.1 | DSH adapter | unproven |
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

- **Evidence digest**：`sha256:2cf1acd25b5f46ca5289bab9ccb238502b36d52bc195a7944b3c49bfcd059ec4`。
- **覆盖**：5 个真实 DSH 场景（verified、no-submission、invalid criterion、verifier timeout、symlink）；verified 路径包含 self-read、plan、native bash、submit、稳定 wake、fact 顺序、manifest/receipt/usage/sessionCut；verifier 只读冻结 CAS，活动 workspace 被篡改后仍读取冻结 bytes；no-submission 与 invalid 使用 ExecutionRecord，不冒充 Evidence。
- **未覆盖**：C-03 fresh retry、C-11 完整 replay/CAS domain-aware 证据、C-12 composition mismatch 实跑；领域评测或 RSI 收益不属于 C-02。

## 验收、提交与重放证据边界

- **C-02**：必须证明 submit 只接收非 draft output IDs 与 `includeLearningDrafts`，不接收 verdict/score/ref/role/required/timedOut；`SubmissionManifest` 与 `PublicReceipt` 绑定同一冻结合同、同一授权输入 snapshot（含 direct child outputs）和同一输出 snapshot；required criteria 恰一次；exit=0 只在 receipt 完整、身份/digest 匹配、全部 pass、`timedOut=false` 且 `signal=null` 时为 verified；invalid receipt 不是 acceptance Evidence。规范：[§11.4–§11.5、§15.3](../framework.md)。
- **C-03**：必须证明 no-submission/stop/cancelled 不生成 `SubmissionManifest` 或 `PublicReceipt`，缺 receipt 是定义行为而不是零分；timeout 不伪造成 signal；fresh retry 使用新 Run/session/workspace，重新 submit、重新冻结、重新生成 receipt，旧 verdict 不复制、不覆盖；invalid receipt 仅诊断，不扩展 `ExecutionRecord`。规范：[§9、§11.5、§15.3、§19.1](../framework.md)。
- **C-11**：必须证明 manifest/receipt 的稳定排序、无时间戳、固定 `operationId` 和对象不可变性支持 journal replay、torn-tail 恢复与 commandId 幂等；同一 commandId + commandDigest 重放返回原 fact 和原 refs，不重新冻结、不重新验证；不同顺序/不同 refs 产生不同 digest 并按身份不匹配拒绝；CAS 引用内容的 domain-aware replay 校验仍需实现证据。规范：[§10、§15.3、§19.1](../framework.md)。

C-02 已有真实 DSH + 真实模型证据；C-03/C-11/C-12 及其余场景在 fresh retry、composition mismatch、完整 replay/CAS domain-aware 等证据出现前保持 `unproven`。协议 schema 通过、`pnpm verify` 通过、文档 digest 一致或 fixture verifier pass 都不能升级状态。

每次状态更新必须同时记录实际命令、运行环境、规范条目、证据对象 digest、未覆盖部分和是否使用真实模型。没有证据的场景保持 `unproven`，不能仅因 `pnpm verify` 通过而改为 `proven`。
