# Singularity V1

Singularity 是一个基于 DeepSeek Harness `0.2.2-alpha.2`、以 Task 为中心的领域任务 RSI 框架。本仓库已进入 V1 构建阶段。S1 宿主 spike 已完成（S1-A 宿主 composition、S1-B MCP stdio、S1-C MCP streamable-http、S1-D 稳定 wake 去重、S1-E compaction/context epoch）；S2-A（protocol JSON/JCS/digest/schema 基础）、S2-B（Task+Method schema、seal 与 tool errors）、S2-C1（获批闭合 fact payload）、S2-C2（pure command/journal replay）、S2-C3（纯 root/child admission）与 S2-C4（纯 Task/Run reducer）已完成，S2 完成，下一步 S3 单 Task/Run 闭环，Task/RSI 业务实现尚未开始。

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
- DSH `0.2.2-alpha.2`（S1-A–S1-E 已完成真实 DSH 组合验证；S2-A/S2-B/S2-C1/S2-C2/S2-C3/S2-C4 protocol 基础已完成）

## 验证

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`verify` 是本地与 CI 共用的唯一稳定入口，依次执行项目门禁、typecheck、lint、test 和 build：

- `pnpm verify:project`：规范 digest、conformance 登记、仓库/CI 配置、架构禁用项与 protocol 纯度检查；
- `pnpm typecheck`（`pnpm --recursive typecheck`）：所有 workspace 包的严格 TypeScript 检查，覆盖 app 与 protocol 的 `src`/`test`；
- `pnpm lint`（`pnpm --recursive lint`）：所有 workspace 包的 ESLint；
- `pnpm test`（`pnpm --recursive test`）：所有 workspace 包的测试，包括 app 宿主组合与 protocol 单元/负例；
- `pnpm build`（`tsc -b tsconfig.json`）：按根 references 构建 app 与 protocol，输出各自 `dist`。

CI 只保留一个 `verify` job。S1-A–S1-E 已完成；S2-A、S2-B、S2-C1、S2-C2、S2-C3、S2-C4 已完成，frozen install 与根 `pnpm verify` 的 project/typecheck/lint/test/build 全通过（protocol tests 178/178、app tests 6/6，合计 184），`git diff --check` 通过。用户 2026-10-30 已确认 K1–K5，K6 仍未证明；framework/spec-lock/amendment/conformance 已在同一变更更新（spec sha256=`6f4a57e7987c8def2b5e12504fb8a6e2599968161f94115a473b8b98ed29fd91`）。S2 完成（C-01/C-05/C-11 纯协议正负例已覆盖）；conformance 整体仍 unproven（CAS 内容/FS/runtime/DSH/真实模型未验证）。下一步 S3 单 Task/Run 闭环；Method/RSI reducer 属后续，Task/RSI 业务功能尚未实现。领域 RSI 收益需要独立证据，不能由仓库检查推断。

## 协作流程

1. 从最新 `main` 创建单一目的分支。
2. 在任务卡或 PR 中写明 Goal、规范条目、范围、非目标和 Done when。
3. 实现一个最小垂直切片，运行根 `pnpm verify` 并审查最终 diff。
4. 提交非草稿 PR，完成 conversation 和最新 `verify` 后，自动工作流批准；clean PR 直接 squash merge，其余符合条件的 PR 启用 squash auto-merge。

自动流程只处理同一私有仓库内、任务卡完整且 `ci/verify` 成功的 PR；授权工作流不 checkout PR 代码。自动批准不代表未执行的 DSH、模型或领域证据已经成立。

`main` 禁止直接 push、force push 和删除。规范变更必须在 PR 中同时更新 `docs/framework.md`、`spec-lock.json` 及所有受影响实现。
