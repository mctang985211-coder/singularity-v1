# Singularity V1

Singularity 是一个基于 DeepSeek Harness `0.2.2-alpha.2`、以 Task 为中心的领域任务 RSI 框架。S1 与 S2 已完成；S3 已实现单 Run、CAS/journal 和恢复，当前修正覆盖状态、路径、验收身份及单 Agent 预算，但 S3 整体仍未完成。C-02 已有真实 DSH + 真实模型证据；C-03/C-11/C-12 保持 unproven。child、RSI 和领域改进尚未实现。

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

CI 只保留一个 `verify` job。S3-C 已有 fresh retry、完整 Composition 比较、稳定 wake 去重及提交后 CAS 恢复的 DSH fixture；CAS domain-aware 校验已有正负例，C-11 完整重放符合性仍未证明。本轮状态/路径/验收身份/预算与 deadline 修正及检查证据见 [`docs/tasks/s3-minimal-corrections.md`](docs/tasks/s3-minimal-corrections.md)。C-02 的既有真实模型证据见 [`docs/tasks/s3-b2-single-run.md`](docs/tasks/s3-b2-single-run.md)；本轮没有购买模型请求或升级 conformance。

当前 profile 关闭自动 compaction，避免尚未预留的独立 summarizer 请求绕过 Task 预算。普通请求使用 DSH 原生 hook，并按 route 声明的完整上下文容量保守预留；缺失容量、剩余不足或 usage 未知时停止购买。模型仅看到预算百分比。自动压缩计量、不可停止作业的 quarantine、完整取消 drain 与实际配置的 Composition 来源核对仍需 S3 后续切片。

## 协作流程

1. 从最新 `main` 创建单一目的分支。
2. 在任务卡或 PR 中写明 Goal、规范条目、范围、非目标和 Done when。
3. 实现一个最小垂直切片，运行根 `pnpm verify` 并审查最终 diff。
4. 提交非草稿 PR，完成 conversation 和最新 `verify` 后，自动工作流批准；clean PR 直接 squash merge，其余符合条件的 PR 启用 squash auto-merge。

自动流程只处理同一私有仓库内、任务卡完整且 `ci/verify` 成功的 PR；授权工作流不 checkout PR 代码。自动批准不代表未执行的 DSH、模型或领域证据已经成立。

`main` 禁止直接 push、force push 和删除。规范变更必须在 PR 中同时更新 `docs/framework.md`、`spec-lock.json` 及所有受影响实现。
