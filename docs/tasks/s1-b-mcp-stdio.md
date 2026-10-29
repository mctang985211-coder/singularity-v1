# S1-B 任务卡：DSH alpha2 MCP stdio

## Goal

通过真实 DSH `0.2.2-alpha.2` Agent scope 和官方 MCP server，验证 stdio transport 的挂载前 server 准入、工具声明/dispatch 一致性、tool guard、启动与工具失败、timeout、取消和完整子进程清理。

## Spec refs

- `docs/framework.md` §2、§3、§12、§14、§19、§19.1
- `docs/build-plan.md` S1
- 本片段不改变 C-16 或其他 conformance 场景的 unproven 状态。

## 允许修改范围

- `apps/singularity` 的 MCP client/测试 server 依赖、stdio fixture 与组合测试
- 上述依赖的 lockfile
- 与实际证据对应的 S1-B 任务卡、README 和构建计划

## 非目标

- 不实现 Singularity Task/Method runtime，不新增第二工具协议、TS MCP 转接层、可变 registry 或 DSH patch。
- 不使用旧 SSE transport，不声称 streamable-http、manifest/capability precheck、真实模型领域任务或 C-16 整体已完成。
- 不把 `dispose()` resolve 单独当作子进程已经退出的证据。

## Done when

- 未准入 server 在 mount 前拒绝且不启动进程；获准 server 通过 `agentCtx.plugin` 和 DSH 原生 MCP client 挂载。
- 实际 tool schemas、system prompt server instructions/resource surface 与 dispatch 一致；tool guard 拒绝时 server 收不到调用，resource tools 也受 server guard。
- 覆盖成功、server 返回 tool failure、startup failure、timeout、dispatch 前取消和调用中取消；结果按真实 alpha2 行为断言，不虚构结构化错误码。
- 验证 Agent/MCP scope disposal 后声明面移除且实际 server 子进程退出。
- 根 `pnpm verify` 全通过，未验证项明确保留。

## 检查命令

使用官方 Node `24.9.0`、pnpm `11.18.0`：

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

## 失败证据与运行记录

待首个 stdio 复现和实现后填写实际命令、结果、环境与未验证项。
