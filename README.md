# Singularity V1

Singularity 是一个基于 DeepSeek Harness `0.2.2-alpha.2`、以 Task 为中心的领域任务 RSI 框架。本仓库已进入 V1 构建阶段。S1 宿主 spike 已完成（S1-A 宿主 composition、S1-B MCP stdio、S1-C MCP streamable-http、S1-D 稳定 wake 去重、S1-E compaction/context epoch）；S2-A（protocol JSON/JCS/digest/schema 基础）、S2-B（Task+Method schema、seal 与 tool errors）、S2-C1（获批闭合 fact payload）、S2-C2（pure command/journal replay）、S2-C3（纯 root/child admission）与 S2-C4（纯 Task/Run reducer）已完成，S2 完成；S3-A（单 writer journal 与 CAS）、PlanningSketch schema、S3-B1 acceptance/submission schema、S3-B2 单 Run 执行闭环与 S3-C runtime fresh retry/resume 恢复已完成。C-02 已由真实 DSH + 真实模型证据标为 proven；C-03/C-11/C-12 保持 unproven。下一真实模型 retry/resume 证据与 S3 其余切片，Task/RSI 业务实现尚未开始。

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
- DSH `0.2.2-alpha.2`（S1-A–S1-E 已完成真实 DSH 组合验证；S2、S3-A、PlanningSketch schema、S3-B1、S3-B2 与 S3-C runtime retry/resume 已完成；C-02 proven，下一真实模型 retry/resume 证据）

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

CI 只保留一个 `verify` job。S1-A–S1-E 与 S2（S2-A–S2-C4）已完成；S3-A、PlanningSketch schema、S3-B1、S3-B2 与 S3-C runtime retry/resume + app 恢复集成已完成。frozen install 与根 `pnpm verify` 全通过（protocol tests 225/225、app tests 15/15、runtime tests 54/54，合计 294），`git diff --check` 通过；spec digest 以 `spec-lock.json` 为准。S3-B2 的 5 个 DSH 场景覆盖 verified、no-submission、invalid criterion、verifier timeout、symlink；真实模型使用 `http://127.0.0.1:16660/v1`、`deepseek-v4.1-flash`、`reasoning=max`，live verified 通过，Evidence digest `sha256:2cf1acd25b5f46ca5289bab9ccb238502b36d52bc195a7944b3c49bfcd059ec4`。verifier 只读 CAS，workspace 被篡改仍读冻结 bytes；self-read/plan/bash/submit、稳定 wake、fact 顺序、manifest/receipt/usage/sessionCut 均验证；无提交与 invalid 不冒充 Evidence。S3-C runtime 增加 fresh retry、完整 Composition 比较的 resume mismatch（零 Agent/模型请求）、真实 `agents.resume` 稳定 wake 去重与提交后同 CAS snapshot/operationId 恢复；app 集成 4 个真实 DSH fixture 场景通过，但未升级 conformance。C-02 已标为 proven；C-03/C-11/C-12 保持 unproven（C-03 尚无真实模型 fresh retry，C-11 尚无完整 replay/CAS domain-aware 证据，C-12 尚无真实模型 composition mismatch 实跑）。下一真实模型 retry/resume 证据。领域 RSI 收益需要独立证据，不能由仓库检查推断。

## 协作流程

1. 从最新 `main` 创建单一目的分支。
2. 在任务卡或 PR 中写明 Goal、规范条目、范围、非目标和 Done when。
3. 实现一个最小垂直切片，运行根 `pnpm verify` 并审查最终 diff。
4. 提交非草稿 PR，完成 conversation 和最新 `verify` 后，自动工作流批准；clean PR 直接 squash merge，其余符合条件的 PR 启用 squash auto-merge。

自动流程只处理同一私有仓库内、任务卡完整且 `ci/verify` 成功的 PR；授权工作流不 checkout PR 代码。自动批准不代表未执行的 DSH、模型或领域证据已经成立。

`main` 禁止直接 push、force push 和删除。规范变更必须在 PR 中同时更新 `docs/framework.md`、`spec-lock.json` 及所有受影响实现。
