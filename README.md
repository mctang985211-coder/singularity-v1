# Singularity V1

Singularity 是一个基于 DeepSeek Harness `0.2.2-alpha.2`、以 Task 为中心的领域任务 RSI 框架。本仓库已进入 V1 构建阶段。S1-A（DSH alpha2 宿主 composition）与 S1-B（DSH 原生 MCP stdio）已完成；S1 其余宿主能力仍在推进，protocol/runtime 业务实现尚未开始。

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
- DSH `0.2.2-alpha.2`（S1-A/S1-B 已完成真实 DSH 组合验证；S1 其余能力进行中）

## 验证

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`verify` 是本地与 CI 共用的唯一稳定入口，依次执行项目门禁、typecheck、lint、test 和 build：

- `pnpm verify:project`：规范 digest、conformance 登记、仓库/CI 配置和架构禁用项；
- `pnpm typecheck`：app `src` 与 `test` 的严格 TypeScript 检查；
- `pnpm lint`：app ESLint；
- `pnpm test`：app 宿主组合测试；
- `pnpm build`：按根 `tsconfig.json` references 构建 app，输出 `apps/singularity/dist`。

CI 只保留一个 `verify` job。S1-A 与 S1-B 已完成并通过上述门禁（S1-A fixture/真实模型与 S1-B stdio fixture 均通过，tests 2/2；S1-B 无真实模型请求）；S1 整体仍在进行，streamable-http、wake 去重、compaction/context epoch 与 C-16 整体仍未验证（C-12/C-16/C-20 保持 unproven）。领域 RSI 收益需要独立证据，不能由仓库检查推断。

## 协作流程

1. 从最新 `main` 创建单一目的分支。
2. 在任务卡或 PR 中写明 Goal、规范条目、范围、非目标和 Done when。
3. 实现一个最小垂直切片，运行根 `pnpm verify` 并审查最终 diff。
4. 提交非草稿 PR，完成 conversation 和最新 `verify` 后，自动工作流批准；clean PR 直接 squash merge，其余符合条件的 PR 启用 squash auto-merge。

自动流程只处理同一私有仓库内、任务卡完整且 `ci/verify` 成功的 PR；授权工作流不 checkout PR 代码。自动批准不代表未执行的 DSH、模型或领域证据已经成立。

`main` 禁止直接 push、force push 和删除。规范变更必须在 PR 中同时更新 `docs/framework.md`、`spec-lock.json` 及所有受影响实现。
