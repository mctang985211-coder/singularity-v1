# Singularity V1

Singularity 是一个基于 DeepSeek Harness `0.2.2-alpha.2`、以 Task 为中心的领域任务 RSI 框架。本仓库目前包含正式规范、构建计划和工程门禁；protocol/runtime 业务实现尚未开始。

## 权威入口

- 施工规范：[`docs/framework.md`](docs/framework.md)
- 构建流：[`docs/build-plan.md`](docs/build-plan.md)（非规范，可按构建证据调整）
- Agent 工作约束：[`AGENTS.md`](AGENTS.md)
- 规范身份：[`spec-lock.json`](spec-lock.json)

旧草案、旧实现和研究记录不属于本仓库的施工接口。任何新增协议语义都先经过 amendment 和用户确认。

## 环境

- Node `>=24.9.0`
- pnpm `11.18.0`
- DSH `0.2.2-alpha.2`（首个宿主集成切片安装并验证，当前未声明已完成）

## 验证

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`verify` 是本地与 CI 共用的唯一稳定入口。当前它检查规范 digest、conformance 完整性、项目配置和架构禁用项；首个 TypeScript 实现切片必须把 typecheck、lint、test 和 build 纳入同一入口。

CI 通过只代表当前已执行门禁通过。真实 DSH 行为、真实模型任务和领域 RSI 收益分别需要独立证据，不能由仓库检查推断。

## 协作流程

1. 从最新 `main` 创建单一目的分支。
2. 在任务卡或 PR 中写明 Goal、规范条目、范围、非目标和 Done when。
3. 实现一个最小垂直切片，运行根 `pnpm verify` 并审查最终 diff。
4. 提交 PR，完成 conversation 和最新 `verify` 后由人执行 squash merge。

`main` 禁止直接 push、force push 和删除。规范变更必须在 PR 中同时更新 `docs/framework.md`、`spec-lock.json` 及所有受影响实现。
