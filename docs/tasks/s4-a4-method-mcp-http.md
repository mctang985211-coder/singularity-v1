# S4-A4 — Method MCP streamable-http 装配

- **状态**：已完成（仓库/真实 DSH fixture 证据；真实模型未执行）。

## Goal

在 S4-A3 的 Method/contract/Composition/MCP 身份链上增加 DSH 原生 `streamable-http` transport：host/runtime 复用同一 manifest/bundle/sourceFiles/schema/capability/guard/prompt/surface/recovery 解析，只为 HTTP 增加严格的无凭据 loopback URL 与空 headers 校验，并通过原生 `StreamableHttpConfig` + `agentCtx.plugin(mcpClient, config)` 挂载。stdio 全部行为保持 A3 回归；HTTP 不创建 materialization root、不继承 headers/secrets、不写第二 transport adapter。

## Spec refs

- `docs/framework.md` §2（DSH MCP client/setup/scope）
- §5（MethodRevision/ToolAsset）
- §12–§14（tool/resource 可见性、NodeView、guard、prompt 预算）
- §15.2（Composition.mcpServers）
- §19（manifest/capability/transport）
- §19.1（启动失败、dispose、resume）
- `docs/tasks/s4-a3-method-mcp-stdio.md`、`AGENTS.md` §3/§4.1/§5
- 只使用真实 DSH HTTP fixture 与现有 chat fixture；不购买真实模型请求，不升级 C-16/C-20。

## Allowed scope

- `runtime/src/mcp-resources.ts`：transport 分支复用现有 Method/contract/Composition 身份；HTTP 仍校验 bundle/sourceFiles/entrypoint/schema/capability，返回 HTTP config value。
- 新增 `runtime/src/mcp-http-config.ts`：HTTP config 的严格 closed-key URL/headers 校验；不解析 Method/catalog。
- `runtime/src/agent-mcp.ts`：仅为 stdio 分支 materialize；HTTP 分支直接构建原生 `StreamableHttpConfig`；mount/surface/cleanup 保持单一入口。
- `runtime/src/agent.ts`：仅当存在 stdio server 时创建 Run materialization root；HTTP-only 不创建宿主目录。
- 新增/扩展真实 DSH HTTP fixture 与 app/runtime tests；复用 S1 HTTP fixture 的 server/discover/initialize/initialized/tools/list/tools/call、closed-port、abort/dispose 记录形态。
- 任务卡、build-plan、AGENTS、README 的本片证据。

## Non-goals

- 不支持 TLS、远程 host、DNS、headers、query/hash/userinfo、raw secrets 或 secrets broker。
- 不实现第二 Method/MCP parser、TS transport adapter、自定义 HTTP client、第二 registry/writer/fold。
- 不把 HTTP bundle materialize 到宿主目录；HTTP 的 bundle/sourceFiles 只作为冻结来源/相等性证据。
- 不修改 framework/spec-lock/公开协议；不改变 store/service/recovery 严格 replay 或 tolerance。
- 不购买真实模型请求；不声称完整 sandbox/C-16/C-20 或真实 output schema。

## 当前消费者与不变量

消费者：

- host `buildSingleRunComposition`：从同一 `loadMethodResources` 派生 Composition，transport 由 frozen manifest 复制；HTTP 不改变 platform prompt/schema 投影。
- create/submitted/resume：复用 A3 的 Method/contract/Composition 严格校验；缺失 CAS 由 store replay 拒绝。
- `agent.ts` setup：仅 stdio 需要 materialization root；HTTP 直接 native mount。
- `RunToolController`/`buildNodeView`：transport 无关，继续使用同一 `McpDispatchPlan`。
- `assertMcpSurface`：transport 无关，验证实际 `mcp__`/resource tools、description/parameters。

不变量：

1. 身份链与 A3 完全相同；HTTP 不复制 `readMcpServers`/catalog/Composition equality。
2. HTTP config 只允许 `http://` + allowlist loopback host（`127.0.0.1`/`localhost`/`::1`），禁止 userinfo/query/hash；`headers` 必须为空对象；raw secret 形状/未知 key 拒绝。
3. HTTP 不创建 Run materialization root、HOME、XDG 或子进程；不继承请求 headers/secret。
4. stdout/stderr、toolCallTimeout、failOnStartupError=true、reconnect=false、maxInstructionBytes/instructions cap 沿用 A3 约束。
5. 真实 HTTP surface 仍由 DSH 原生 client 注册；guard/NodeView/platformPrompt 不因 transport 分叉。
6. dispose/resume/缺失 CAS/语义 invalid 的严格路径与 A3 相同；HTTP socket、声明和 Agent 生命周期可观察清理。
7. stdio A3 测试全部保持；混合 transport 只在同一 mount 入口按 template 顺序处理，HTTP 不触发 stdio root。

## HTTP config 内部契约（无需 amendment）

```json
{
  "v": 1,
  "serverName": "calc-http",
  "transport": "streamable-http",
  "url": "http://127.0.0.1:<port>/mcp",
  "headers": {},
  "toolCallTimeoutMs": 250,
  "maxInstructionBytes": 8192,
  "failOnStartupError": true,
  "reconnect": { "enabled": false },
  "digest": "sha256:..."
}
```

- 严格 closed keys；`serverName` 必须等于 manifest；`transport` 必须等于 manifest/asset。
- URL 解析必须成功、protocol `http:`、host 在 allowlist、无 username/password/search/hash；path 必须为 `/` 起始的相对服务路径。
- `headers` 必须恰为空对象；任何 header/secret/env 字段拒绝。
- timeout/instructions cap 与 A3 相同，且 `failOnStartupError=true`、`reconnect.enabled=false`。
- manifest/bundle/sourceFiles/entrypoint/schema/capability 校验仍走 A3 同一路径；entrypoint 是冻结来源的一部分，但 HTTP 不执行/不 materialize。

## Done when

- [x] HTTP bound server 通过同一 Method/contract/Composition 身份链，Composition transport 为 `streamable-http`。
- [x] 严格 URL/headers/config 负例通过；无凭据 loopback 配置成功。
- [x] 原生 `StreamableHttpConfig` mount，无 TS transport adapter；HTTP-only 不创建宿主目录/HOME/子进程。
- [x] 真实 DSH fixture 覆盖 server/discover→initialize→initialized→tools/list→tools/call、static resource、template expanded read、guard 和 disposal。
- [x] closed-port startup failure、schema/instructions mismatch、timeout/pre-abort/in-flight abort 按 S1 适配点验证。
- [x] dispose 后所有 HTTP sockets 关闭、声明移除；resume 原 Composition 零新模型请求。
- [x] stdio A3 全部回归；缺失 CAS/语义 invalid 严格路径不变。
- [x] 记录实际请求序列、socket/PID/清理、prompt/request bytes、fixture usage；C-16/C-20 不升级。
- [x] 定向/包测试/根 `pnpm verify`/`git diff --check` 通过。

## 必测负例

- URL：`https:`、非 loopback host、userinfo、query、hash、空/invalid URL；未知 config key、headers 非空、raw secret、wrong serverName/transport、failOnStartupError/reconnect/timeout/instructions cap。
- HTTP manifest/asset transport 不一致；HTTP-only 时无 materialization root。
- closed port startup failure；多 server 部分失败（若同一 fixture 可覆盖）；schema/instructions mismatch。
- 未绑定 public tool/resource server；stopped/submitted guard。
- HTTP socket 全部关闭、PID/声明/资源目录清理；resume 零新请求；缺失 CAS strict replay。

## 检查命令

```bash
export PATH=/home/ROXY/code/singularity/.tooling/node-v24.22.2-linux-x64/bin:$PATH
export DSH_HOME="$PWD/.tmp/s4a4-dsh"
export TMPDIR="$PWD/.tmp"

node --test packages/singularity/runtime/test/mcp-http-resources.test.ts
node --test --test-name-pattern='S4-A4' apps/singularity/test/run-recovery.test.ts
pnpm --filter @singularity/runtime build
pnpm --filter @singularity/runtime test
pnpm --filter @singularity/app test
pnpm verify
git diff --check
```

不设置 `SINGULARITY_SPIKE_LIVE`；fixture 不是真实模型。

## Structure done when

- `mcp-resources.ts` 仍拥有 Method/catalog/Composition/prompt；HTTP 只增加 `transport` 分支与 `FrozenMcpServer` union，不复制解析（`565→571`，+6）。
- `mcp-http-config.ts` 只拥有 HTTP config closed-key/URL/headers 校验；消费者是 `mcp-resources.ts`（新增 110 行）。
- `agent-mcp.ts` 仍是唯一 native mount 入口；stdio materialization 与 HTTP config 分支在同一函数（`166→192`，+15.7%，低于 20% 拆分阈值），保留理由是不引入第二 mount path，transport 分支共享同一 DSH plugin/surface/cleanup。
- `agent.ts` 只改变 root 创建条件（`443→436`，移除 stdio-only root 前置拒绝）；`run.ts=756`/`tools.ts=545`/`host-composition.ts=299` transport 无关，未改。
- `store.ts`/`service.ts`/`recovery.ts` 维持 A3 严格路径；本片无 diff。
- 无新依赖、无公开协议变更、无新导出给零消费者；HTTP fixture 扩展仅新增 `resources` 选项，S1 默认空 resource 行为保持。
- 复用 S1 HTTP fixture 适配点；登记 before/after 行数、测试数、requests/sockets/bytes、证据边界与未覆盖项。

## Verification evidence（2026-10-31）

- 变更规模：`mcp-resources.ts 565→571`、`agent-mcp.ts 166→192`、`agent.ts 443→436`；新增 `mcp-http-config.ts 110`、`mcp-http-resources.test.ts 303`；`run-recovery.test.ts +789`、`mcp-streamable-http.ts 488→515`。`mcp-resources.test.ts` 仅更新 A3 HTTP 负例预期。
- 测试数：runtime `142/142`（A3 基线 `139` + HTTP unit `3`）；app `74/74`（A3 基线 `65` + S4-A4 `9`）；protocol `225/225`；根 `pnpm verify` 合计 `441` 通过。
- 定向：`mcp-http-resources.test.ts 3/3`；`S4-A4` app 测试 `9/9`。
- 实际 HTTP 请求序列（fixture 记录）：`server/discover` → `initialize` → `notifications/initialized` → `null`（GET/SSE 适配）→ `tools/list` → `tools/call` → `resources/list` → `resources/read` → `resources/templates/list` → `resources/read`（expanded template）。`httpRequestCount=10`，`openedConnections=10`，`closedConnections=10`，dispose 后 `activeConnections=0`、`activeRequests=0`；HTTP 无 PID（in-process fixture）。
- 实测 bytes（样例，不是稳定 digest）：system prompt `1346`、NodeView `1865`、tool schemas `5505`、首请求 `9515`；fixture usage `620 input / 72 output tokens, 9 steps, unknown=0`。
- 成功场景：Composition transport `streamable-http`；prompt 含 `### MCP server: calc-http`、exact HTTP instructions、resource section；tool schemas 含四个 HTTP public tools 与三个 resource tools；echo、static resource、template list、expanded `s4a4://note/42` read 正文成功；dispose 后声明/`ctx.tools.get` 消失，HTTP-only 未创建 materialization root。
- 负例：https/non-loopback/userinfo/query/hash/非空 headers → `UNSUPPORTED_RESOURCES`；invalid URL/unknown key/headers array/wrong serverName/transport/failOnStartupError/reconnect/instruction cap/tool timeout > manifest cap/0/非整数 → `CONTRACT_INVALID`；closed port、instructions mismatch、exposedTools description mismatch 在 Agent/模型前失败。unbound resource server 在 Agent 内 dispatch 前被 guard 拒绝并作为 tool error 返回，不产生 `resources/list` traffic；它不属于 Agent/模型启动前失败。
- timeout：HTTP tool `hang` 在 200ms tool timeout 后 abort，fixture 记录 abort，后续模型请求收到 timeout/abort tool error，随后 stop 正常结算。pre-abort：直接 native DSH setup 下 `AbortSignal.abort()` 未产生 HTTP 请求。in-flight abort：直接 native DSH `tools.execute` 在 fixture 收到 hang 后 abort，fixture 记录 abort 且结果错误。后两项复用 S1 适配点，不经过 Method mount；Method mount 的 timeout/guard/resume 已覆盖。
- resume：`resumeSingleRun` 重新 mount HTTP server，原 Composition 零新模型请求；fixture 观察到 `tools/list` 与连接关闭；无 materialization root。
- 网络边界：当前只是“初始 URL loopback policy”，不是连接级网络隔离。DSH 默认 fetch 可能 follow redirect、`localhost` 由系统 resolver 解析、`NODE_USE_ENV_PROXY` 等代理环境也可能影响 egress；redirect/DNS/proxy 出站仍 unproven，后续需要 DSH 可注入 fetch/`redirect:error` 能力。`reconnect=false` 只覆盖 DSH supervisor，MCP SDK SSE reconnect 未验证（当前 fixture 的 GET 返回 405，不走 SSE）。动态 `list_changed` 同名 schema 漂移只在 setup 校验，运行中冻结重验仍未覆盖；本片不扩大实现。
- 证据边界：未购买真实模型请求；未实现 TLS/远程 host/headers/secrets broker；URL path 不是授权通道，不能用于携带 secret；未覆盖混合 stdio+HTTP 部分失败、真实 output schema、完整 sandbox；pre-abort/in-flight 是 direct native DSH 适配证据，不是 Method-mount 端到端；C-16/C-20 未升级。
