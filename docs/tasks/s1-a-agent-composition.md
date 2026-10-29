# S1-A 任务卡：DSH alpha2 Agent composition

- **状态**：已完成；fixture 与真实模型证据见“失败证据与运行记录”，S1 其余能力仍未验证。

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

使用官方 Node `24.9.0` 与 pnpm `11.18.0`：

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

真实模型复跑通过 `SINGULARITY_SPIKE_LIVE=1` 启用；凭据只通过进程环境传入，不写入仓库。环境限制与复跑结果见下节。

## 失败证据与运行记录

### 初始红证据（实现前）

```bash
pnpm --filter @singularity/app test
```

结果：失败，Node 报 `ERR_MODULE_NOT_FOUND`；当时 `apps/singularity/src/host-composition.ts` 尚不存在。

### 集成环境与仓库门禁

- Node：官方 Node `24.9.0`。
- pnpm：`11.18.0`。
- DSH package manifest：`0.2.2-alpha.2`。

```bash
pnpm install --frozen-lockfile
pnpm verify
```

结果：安装成功；`pnpm verify` 的 project、typecheck、lint、test、build 全部通过。测试路径使用真实 DSH profile，并通过 fixture 覆盖 agent turn 与 resume。

### 真实模型复跑

在父代理环境设置以下进程环境变量后运行同一 app test（凭据只存在于进程环境，未写入仓库或本文档）：

```bash
export SINGULARITY_SPIKE_LIVE=1
export SINGULARITY_SPIKE_BASE_URL=http://127.0.0.1:16660/v1
# SINGULARITY_SPIKE_API_KEY 由父代理进程环境提供，本文档不记录其值
pnpm --filter @singularity/app test
```

模型路由：`deepseek-v4.1-flash`，`reasoning=max`。结果：通过 `1/1`。

该路径覆盖：

- `agents.create` / `setup` / `agents.resume`；
- 首个模型请求前的 prompt、required context、skill catalog 与 tool schema 装配；
- global restrict 与 scoped guard 的声明/dispatch 一致性；
- `concludeTurn` 产生单一完成 step；
- 实际 usage 写入持久 session；
- resume 后不新增模型请求/turn；
- 凭据未写入 DSH home。

### 环境限制

buckyball/Nix 提供的 Node `24.18.0` 满足 `>=24.9.0`，但 `runProfile` 在 `node-addon-require-builtin` 报 `Unsupported` / `no-getter`，无法启动 profile。官方 Node `24.9.0` 可正常通过。该限制按环境问题记录，不对 DSH 打 patch。

### 仍未验证（S1 继续）

- MCP `stdio` 与 `streamable-http` 的挂载、server/tool guard 与 disposal；
- 失败、timeout、取消和 disposal 全链路；
- 稳定 wake/message ID 去重；
- compaction/context epoch 后 receipt 失效与重读义务；
- C-12、C-16、C-20 保持 unproven；`docs/conformance.md` 与 `spec-lock.json` 未改动。

结论：S1-A 完成；S1 整体继续。
