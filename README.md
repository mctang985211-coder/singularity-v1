# Singularity V1

Singularity 是一个基于 DeepSeek Harness `0.2.2-alpha.2`、以 Task 为中心的领域任务 RSI 框架。本仓库已进入 V1 构建阶段。S1 宿主 spike 已完成（S1-A 宿主 composition、S1-B MCP stdio、S1-C MCP streamable-http、S1-D 稳定 wake 去重、S1-E compaction/context epoch）；S2-A（protocol JSON/JCS/digest/schema 基础）、S2-B（Task+Method schema、seal 与 tool errors）、S2-C1（获批闭合 fact payload）、S2-C2（pure command/journal replay）、S2-C3（纯 root/child admission）与 S2-C4（纯 Task/Run reducer）已完成，S2 完成；S3-A（单 writer journal 与 CAS）与 PlanningSketch schema 已完成，acceptance/submission amendment 仍待用户确认，S3 验收前规范阻断，不宣称 S3-B 开始或完成。Task/RSI 业务实现尚未开始。

## 权威入口

- 施工规范：[`docs/framework.md`](docs/framework.md)
- 符合性登记：[`docs/conformance.md`](docs/conformance.md)
- 构建流：[`docs/build-plan.md`](docs/build-plan.md)（非规范，可按构建证据调整）
- Agent 工作约束：[`AGENTS.md`](AGENTS.md)
- 规范身份：[`spec-lock.json`](spec-lock.json)

旧草案、旧实现和研究记录不属于本仓库的施工接口。任何新增协议语义都先经过 amendment 和用户确认。

## 环境

- Node `>=24.9.0`
- pnpm `11.18.0`
- DSH `0.2.2-alpha.2`（S1-A–S1-E 已完成真实 DSH 组合验证；S2、S3-A 与 PlanningSketch schema 已完成；acceptance amendment 待确认）

## 验证

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`verify` 是本地与 CI 共用的唯一稳定入口，依次执行项目门禁、build、typecheck、lint 和 test：

- `pnpm verify:project`：规范 digest、conformance 登记、仓库/CI 配置、架构禁用项与 protocol 纯度检查；
- `pnpm build`（`tsc -b tsconfig.json`）：先按根 references 构建 protocol、runtime 与 app；干净 checkout 不依赖未提交的 `dist`；
- `pnpm typecheck`（`pnpm --recursive typecheck`）：所有 workspace 包的严格 TypeScript 检查，覆盖 app、protocol 与 runtime 的 `src`/`test`；
- `pnpm lint`（`pnpm --recursive lint`）：所有 workspace 包的 ESLint；
- `pnpm test`（`pnpm --recursive test`）：所有 workspace 包的测试，包括 app 宿主组合、protocol 单元/负例与 runtime 存储测试。

CI 只保留一个 `verify` job。S1-A–S1-E 与 S2（S2-A–S2-C4）已完成；S3-A 与 PlanningSketch schema 已完成，frozen install 与根 `pnpm verify` 全通过（protocol tests 189/189、app tests 6/6、runtime tests 20/20，合计 215），`git diff --check` 通过。PlanningSketch 只接受有序 `[0,1]`/`[0,1,2]` levels 并严格拒绝 authority 字段。acceptance/submission amendment 仍为草案，Q1–Q11 待用户决定（AcceptanceRef domain、PublicReceipt verdict/digests/metric/exit、SubmissionManifest 拆分/checks、invalid receipt 去向、privateReceipt opaque、conformance 不变）；确认前不实现 receipt/manifest，S3-B 未开始。C-11 仍缺完整场景证据，所有 conformance 保持 unproven。领域 RSI 收益需要独立证据，不能由仓库检查推断。

## 协作流程

1. 从最新 `main` 创建单一目的分支。
2. 在任务卡或 PR 中写明 Goal、规范条目、范围、非目标和 Done when。
3. 实现一个最小垂直切片，运行根 `pnpm verify` 并审查最终 diff。
4. 提交非草稿 PR，完成 conversation 和最新 `verify` 后，自动工作流批准；clean PR 直接 squash merge，其余符合条件的 PR 启用 squash auto-merge。

自动流程只处理同一私有仓库内、任务卡完整且 `ci/verify` 成功的 PR；授权工作流不 checkout PR 代码。自动批准不代表未执行的 DSH、模型或领域证据已经成立。

`main` 禁止直接 push、force push 和删除。规范变更必须在 PR 中同时更新 `docs/framework.md`、`spec-lock.json` 及所有受影响实现。
