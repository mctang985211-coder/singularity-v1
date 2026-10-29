# S1-A 任务卡：DSH alpha2 Agent composition

## Goal

在未来 app/runtime 的真实组合位置，用 DSH `0.2.2-alpha.2` 验证 Agent create/resume/setup、第一请求前的 scoped prompt/tool/skill 装配、global restrict 与 scoped guard 的声明/dispatch 一致性，以及 `concludeTurn`。建立后续 S1 片段复用的可重复宿主测试入口。

## Spec refs

- `docs/framework.md` §2、§3、§12、§14、§19.1
- `docs/build-plan.md` S1
- 本片段只提供宿主 spike 证据，不将 C-12、C-16 或 C-20 整体标为 proven。

## 允许修改范围

- `apps/singularity/` 的 DSH profile、宿主 spike 组合与测试资源
- 根 TypeScript/验证工具链和 lockfile
- 与上述实际命令、证据和状态对应的 README、构建计划、AGENTS.md 与任务卡

## 非目标

- 不实现 Task/Run/Method/RSI 业务协议或第二个模型 loop。
- 不修改或补丁 DSH，不引入兼容层、旧实现或 TS MCP 转接层。
- 本片段不声称完成 MCP transport、稳定 wake 去重、compaction epoch、取消/disposal 全链路或领域改进。

## Done when

- 真实 alpha2 Cordis/DSH 组合在首个模型请求前完成声明的 prompt/tool/skill 装配。
- 声明面与实际 dispatch 的正负例一致，未获准调用被拒绝；`concludeTurn` 经真实 Agent turn 验证。
- create/resume/setup 有实际运行证据；记录实际 assembled prompt、context、tool schema 与宿主 usage 可观测性，不能观测的部分明确保留未验证。
- 根 `pnpm verify` 同时执行 typecheck、lint、test、build 和原有项目门禁。
- PR 如实列出本片段未覆盖的 S1 行为。

## 检查命令

```bash
export PATH="/home/ROXY/code/bb_work/env/BB/buckyball/result/bin:$PATH"
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

真实模型复跑使用本地已授权的 OpenAI chat-compatible endpoint，凭据只通过进程环境传入，不写入仓库。

## 失败证据与运行记录

待首个复现和实现后填写实际命令、结果、包版本与未验证项。
