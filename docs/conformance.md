# Singularity V1 Conformance Registry

本文档是构建证据登记表，不增加协议语义。规范中的 C-01–C-24 必须分别形成可审查证据；仓库初始化阶段全部标记为 `unproven`。脚本 Agent、fixture pass 或静态配置检查不能替代真实 DSH、真实模型或领域评测证据。

| ID | 场景 | 主要规范范围 | 证据 owner | 状态 |
|---|---|---|---|---|
| C-01 | root contract freeze | §4、§11 | protocol/runtime | unproven |
| C-02 | one Run submit and external receipt | §9、§11、§15 | runtime/domain adapter | unproven |
| C-03 | no-submission and fresh retry | §9、§11、§19.1 | runtime | unproven |
| C-04 | first decompose prepare exposes example; commit without ack refused | §5、§8、§14 | runtime/tool guard | unproven |
| C-05 | child bindings cannot be model-supplied | §5、§8 | protocol/runtime | unproven |
| C-06 | parent required join and own verifier | §7、§11 | runtime/domain adapter | unproven |
| C-07 | parent can issue another direct batch after first terminal batch | §7、§11 | runtime | unproven |
| C-08 | child-level recursive exploration stays locally scoped; PlanningSketch may look 2–3 levels | §6、§12 | runtime/DSH adapter | unproven |
| C-09 | empty Method + explore-child + skill/MCP-server draft artifact | §5、§6、§15 | runtime/Method adapter | unproven |
| C-10 | cancellation closes live descendant Runs; terminal Evidence and tail usage preserved | §10、§15、§19.1 | runtime | unproven |
| C-11 | journal replay / torn tail / command idempotency | §10、§19.1 | protocol/runtime | unproven |
| C-12 | DSH resume composition mismatch | §2、§11、§19.1 | DSH adapter | unproven |
| C-13 | Capsule contamination / hidden read boundary | §15、§19 | domain adapter | unproven |
| C-14 | RSI proposer receives sealed trace only and validation payload is denied | §16、§17 | RSI/runtime | unproven |
| C-15 | MethodPatch rejects task/verifier/scorer edits | §4、§17 | protocol/RSI | unproven |
| C-16 | MCP draft/server manifest, transport and capability guards; DSH MCP scope invocation | §2、§5、§17、§19 | DSH/domain adapter | unproven |
| C-17 | paired base/candidate runs use distinct capsules | §15、§18、§19 | evaluation runtime | unproven |
| C-18 | missing/invalid evidence is insufficient, not zero | §11、§18 | comparator/domain adapter | unproven |
| C-19 | activation uses expected-head CAS | §18 | activation service | unproven |
| C-20 | prompt/tool/skill/NodeView percentage budget display; growing child history stays paginated | §12–§14 | DSH adapter/runtime | unproven |
| C-21 | child feedback and scheduler no-submission feedback reach direct parent | §7、§9、§14 | runtime | unproven |
| C-22 | feedback-driven replan creates new child contracts while retaining old Evidence | §7、§8、§11 | runtime | unproven |
| C-23 | two consecutive Rounds use active-head CAS and cannot overwrite each other | §18 | RSI/evaluation runtime | unproven |
| C-24 | single-case gain with validation regression is not improved | §18 | comparator/domain adapter | unproven |

每次状态更新必须同时记录实际命令、运行环境、规范条目、证据对象 digest、未覆盖部分和是否使用真实模型。没有证据的场景保持 `unproven`，不能仅因 `pnpm verify` 通过而改为 `proven`。
