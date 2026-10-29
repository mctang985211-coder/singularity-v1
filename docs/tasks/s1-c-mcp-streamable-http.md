# S1-C 任务卡：DSH alpha2 MCP streamable-http

- **状态**：已完成；仅覆盖 streamable-http 垂直切片，S1 整体继续。

## Goal

通过真实 DSH `0.2.2-alpha.2` Agent scope、官方 `@modelcontextprotocol/server` `2.2.0` 与 `@modelcontextprotocol/node` `2.0.0` HTTP fixture，验证 streamable-http 的挂载前 server 准入、工具声明/dispatch 一致性、tool/resource guard、启动失败、timeout、取消、dispose 后声明移除与真实 HTTP 连接清理。

## Spec refs

- `docs/framework.md` §2、§3、§12、§14、§19、§19.1
- `docs/build-plan.md` S1
- 本片段不改变 C-16 或其他 conformance 场景的 unproven 状态。

## 允许修改范围

- `apps/singularity/package.json` 与根 `pnpm-lock.yaml`：添加官方 `@modelcontextprotocol/node` `2.0.0` app devDependency；`@deepseek-ai/dsh-mcp-client` 保持现有 `0.2.2-alpha.2`，未改版本。
- `apps/singularity/test/fixtures/mcp-streamable-http.ts`：官方 SDK Node HTTP fixture。
- `apps/singularity/test/mcp-streamable-http.test.ts`：真实 DSH profile 组合测试。
- 本任务卡。

## 非目标

- 不实现 Singularity Task/Method runtime，不新增第二工具协议、TS MCP 转接层、可变 registry、第二模型 loop、writer/registry/transcript 或 DSH patch。
- 不使用旧 SSE transport 或旧 SSE 端点，不新增旧 transport fallback。
- 不修改 S1-A/S1-B 的 fixture、测试、`src/host-composition.ts`、规范、`docs/conformance.md`、`spec-lock.json`、README、构建计划或 CI。
- 不发起真实模型请求；dummy chat URL/key 只用于 profile 启动。
- 不把 `dispose()` resolve 单独当作连接已清理的证据。

## Done when

- fixture 使用 Node `http`、官方 `McpServer` 和 `NodeStreamableHTTPServerTransport`，配置 `enableJsonResponse: true` 与 legacy `supportedProtocolVersions`；不提供旧 SSE 端点。
- DSH profile 中，未准入 server 在 `agentCtx.plugin` 前拒绝且 fixture 收不到请求；closed-port 启动失败不发布 Agent。
- 真实日志覆盖 `server/discover`（auto 探测后回落 legacy）、`initialize`、`notifications/initialized`、`tools/list`、`tools/call`。
- 声明、system prompt instructions、resource tools 与 dispatch 一致；echo/fail 行为符合 fixture；tool guard 拒绝时 server 收不到调用；resource tools 受 server guard。
- 实际 `resources/list` 为空列表；`read_mcp_resource` 与 resource template 成功路径明确未验证。
- `250ms` timeout 后 server 仍可响应；pre-abort 返回 `ABORTED_BEFORE_DISPATCH` 且不达 server；in-flight abort 已到 server，结果为 `isError`，随后仍可响应。
- dispose 后 MCP/resource 声明消失；后续调用失败且不产生新请求；fixture 记录的所有 HTTP 连接均已关闭（不仅凭 dispose resolve）。
- 根 `pnpm verify` 全通过；未验证项明确保留。

## 检查命令

使用官方 Node `24.9.0`、pnpm `11.18.0`，独立 worktree/HOME/store：

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

## 失败证据与运行记录

### 初始红证据

fixture 尚未实现时，新增组合测试真实失败：

```text
✖ alpha2 MCP streamable-http keeps admission, declarations, dispatch, cancellation, and connection cleanup aligned
  Error: S1-C streamable-http fixture is not implemented
      at startStreamableHttpFixture (.../apps/singularity/test/fixtures/mcp-streamable-http.ts)
      at TestContext.<anonymous> (.../apps/singularity/test/mcp-streamable-http.test.ts)
```

实现后首个真实集成失败为：取消后的 MCP 响应被 alpha2 protocol 层丢弃，两个 hang HTTP 请求在 dispose 前仍保持打开，`waitForIdle` 超时（`2 active requests, 2 sockets`）。该真实行为随后被用于断言：dispose 前连接仍打开，dispose 后必须归零。

### 集成环境与门禁

- Node：官方 `/tmp/node249/bin/node`，`v24.9.0`。
- pnpm：`11.18.0`。
- DSH package manifest：`0.2.2-alpha.2`。
- 独立 worktree：`/home/ROXY/code/singularity-v1-swarm-http`。
- 独立 HOME：`/home/ROXY/code/singularity-v1-swarm-http-home`。
- 独立 pnpm store：`/home/ROXY/code/singularity-v1-swarm-http-store`。

```text
pnpm install --frozen-lockfile
  -> Lockfile is up to date; Already up to date

pnpm verify
  -> verify:project passed
  -> typecheck passed
  -> lint passed
  -> test: 3/3 passed (S1-A host composition, S1-B MCP stdio, S1-C MCP streamable-http)
  -> build passed

git diff --check
  -> no output
```

### streamable-http 真实组合证据

使用官方 `@modelcontextprotocol/server` `2.2.0` + `@modelcontextprotocol/node` `2.0.0` fixture，通过真实 DSH `0.2.2-alpha.2` profile 验证：

- fixture 使用 Node `http` 与 `NodeStreamableHTTPServerTransport`，`enableJsonResponse: true`，`supportedProtocolVersions` 为 SDK legacy 列表（不含 2026 revision）；旧 `/sse` 返回 404，`GET /mcp` 返回 405，不建立 SSE。
- mount 前 server allowlist：未准入 server 在 `agentCtx.plugin` 前拒绝；fixture 请求数不变，Agent 未发布。
- closed-port startup failure：`failOnStartupError: true`、`reconnect.enabled: false`；`agents.create` 拒绝，fixture 请求数不变，Agent 未发布。
- 真实请求日志：`server/discover` 先于 `initialize`，随后 `notifications/initialized`、`tools/list`；每个 MCP 请求都携带配置的 `x-singularity-s1-c` header。
- tool schemas、system prompt `mcp:spike-http` instructions、resource tools 与 `mcp-resource-servers` section 一致。
- `echo` 成功；`fail` 返回 server-reported `isError`；`guarded` 被 tool guard 拒绝且 fixture 收不到调用。
- 实际 `list_mcp_resources` 调用 `resources/list`，返回空 `resources`；`list_mcp_resource_templates`/`read_mcp_resource` 的 denied-server guard 命中且不达 fixture。
- `250ms` timeout：调用失败为 `Request timed out`，fixture 收到 cancellation；随后 `echo` 成功。
- pre-abort：返回 `ABORTED_BEFORE_DISPATCH`，fixture 请求数不变，hang handler 未收到调用。
- in-flight abort：hang 调用已到 fixture，取消后结果为 `isError`；随后 `echo` 成功。
- dispose 前 timeout/in-flight cancel 的 HTTP 请求仍保持打开；dispose 后 MCP/resource 声明消失，后续 dispatch 失败且无新请求，fixture 所有 socket 关闭（opened === closed，active === 0），随后 fixture 正常关闭。
- 无 `DELETE` 请求；本切片不假设 DELETE/sessionclose。
- 全测试只启动一个 DSH profile，未发起真实模型请求。

### 仍未验证（S1 继续）

- `read_mcp_resource` 成功读取与 resource template 实际资源内容；
- 稳定 wake/message ID 去重；
- compaction/context epoch receipt 失效；
- C-16 manifest/capability precheck 与 C-16 整体；
- C-12、C-20 及其他 conformance 场景状态未改变；`docs/conformance.md` 与 `spec-lock.json` 未改动。
