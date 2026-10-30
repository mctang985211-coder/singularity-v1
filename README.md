# Singularity V1

Singularity 是一个基于 DeepSeek Harness `0.2.2-alpha.2`、以 Task 为中心的领域任务 RSI 框架。S1–S3 已完成，S4-A1/A2 已完成；下一阶段为 S4-A3/S4-B。C-02/C-03/C-11/C-12 已有真实 DSH + 真实模型证据；child、RSI 和领域改进尚未实现。

## 权威入口

- 施工规范：[`docs/framework.md`](docs/framework.md)
- 符合性登记：[`docs/conformance.md`](docs/conformance.md)
- 构建流：[`docs/build-plan.md`](docs/build-plan.md)（非规范，可按构建证据调整）
- Agent 工作约束：[`AGENTS.md`](AGENTS.md)
- 规范身份：[`spec-lock.json`](spec-lock.json)
- S4–S7 连续自主构建：[`docs/tasks/s4-s7-start-prompt.md`](docs/tasks/s4-s7-start-prompt.md)

旧草案、旧实现和研究记录不属于本仓库的施工接口。任何新增协议语义都先经过 amendment 和用户确认。

## 环境

- Node `>=24.9.0`
- pnpm `11.18.0`
- DSH `0.2.2-alpha.2`（S1-A–S1-E 与 S2/S3 全部完成，S4-A1/A2 完成；C-02/C-03/C-11/C-12 proven，下一阶段为 S4-A3/S4-B）
- 默认真实模型路由：OpenAI-compatible chat `http://127.0.0.1:16660/v1`，`deepseek-v4.1-flash`，`reasoning=max`；可用 `SINGULARITY_SPIKE_BASE_URL` 覆盖 endpoint，API key 只通过 `SINGULARITY_SPIKE_API_KEY` 进程环境提供，不写入仓库。

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

CI 只保留一个 `verify` job。S3-C 的 fresh retry、完整 Composition、稳定 wake、真实 journal replay/torn-tail 和 workspace freshness 已完成；C-02/C-03/C-11/C-12 均有真实模型证据。最终复核与后续遗留项见 [`docs/tasks/s3-final-review.md`](docs/tasks/s3-final-review.md)，Run/Agent/恢复及统一结算的当前职责见 [`docs/tasks/s3-s4-structure-handoff.md`](docs/tasks/s3-s4-structure-handoff.md)，模块边界以 [`AGENTS.md`](AGENTS.md) 为施工入口。

当前 profile 关闭自动 compaction，避免尚未预留的独立 summarizer 请求绕过 Task 预算。普通请求使用 DSH 原生 hook，并按 route 声明的完整上下文容量保守预留；缺失容量、剩余不足或 usage 未知时停止购买。模型仅看到预算百分比；NodeView 与 dispatch 共用提交门禁，self-read/tool schema 有固定分页和大小上限。retry 通过 DSH `SessionHeader.cwd` 核对本 Task 全部历史 attempt 的 canonical workspace freshness；三次尝试的复用、别名和缺失 cwd 已有专项回归，真实模型仍为既有两次尝试证据。自动压缩计量、不可停止进程的实际 sandbox quarantine 和完整 evaluation Capsule 归后续切片。

## 协作流程

用户已授权 S4–S7 连续自主施工。按整体启动 prompt 逐片完成行为、结构和证据出口，然后继续下一片；必要的小规模真实验证在任务卡固定预算后直接执行。

1. 从最新 `main` 创建单一目的分支。
2. 在任务卡或 PR 中写明 Goal、规范条目、范围、非目标、Done when 和 Structure done when。
3. 实现一个最小垂直切片，运行根 `pnpm verify`，并完成模块归位、导出/依赖与大文件增长审查；行为和结构出口同时满足后再结束切片。
4. 提交非草稿 PR，完成 conversation 和最新 `verify` 后，自动工作流批准；clean PR 直接 squash merge，其余符合条件的 PR 启用 squash auto-merge。

自动流程只处理同一私有仓库内、任务卡完整且 `ci/verify` 成功的 PR；授权工作流不 checkout PR 代码。自动批准不代表未执行的 DSH、模型或领域证据已经成立。

`main` 禁止直接 push、force push 和删除。规范变更必须在 PR 中同时更新 `docs/framework.md`、`spec-lock.json` 及所有受影响实现。
