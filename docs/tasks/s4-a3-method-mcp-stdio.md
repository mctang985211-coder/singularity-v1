# S4-A3 — Method MCP stdio 装配、guard 与生命周期

- **状态**：已完成（仓库/真实 DSH fixture 证据；真实模型与 HTTP 未执行）。

## Goal

在 A2 的 Method/skill pin 上接通 S4-A3 的 stdio MCP 纵切：host 从同一冻结 `MethodRevision` 派生 `template.tools → Method.tools → contract.resources.mcpServers → Composition.mcpServers`；runtime 从 CAS 校验 manifest/bundle/sourceFiles/config/派生 schema，把 frozen bundle materialize 到 Run 专属目录，用 DSH 原生 `mcpClient` 在 Agent scope 挂载 stdio server；发布前验证实际 name/description/parameters、instructions/resource sections 和 `platformPrompt`；统一 guard 拒绝未绑定 server/tool/resource 调用。`streamable-http` 保持显式 `UNSUPPORTED_RESOURCES`，留 S4-A4。

## Spec refs

- `docs/framework.md` §2（DSH MCP client/setup/scope）
- §5（MethodRevision/ToolAsset）
- §12–§14（tool/resource 可见性、NodeView、guard、prompt 预算）
- §15.2（Composition.mcpServers）
- §19（manifest/capability/transport、resource limits）
- §19.1（启动失败、dispose、resume）
- `docs/tasks/s4-a1-method-guidance.md`、`docs/tasks/s4-a2-method-skills.md`、`AGENTS.md` §3/§4.1/§5
- 本片只提供仓库/类型/unit + 真实 DSH stdio fixture 证据，不购买真实模型，不升级 C-16/C-20。

## Allowed scope

- 新增 `runtime/src/mcp-resources.ts`：ToolAsset 解析、manifest/bundle/sourceFiles/config/派生 schema、public name、Composition equality、MCP prompt sections。
- 新增 `runtime/src/agent-mcp.ts`：stdio 原生挂载、bundle materialization、HOME/资源根、实际 surface 校验、cleanup。
- `resource-bundle.ts`：新增 materialization 辅助（若超出其只读职责，拆到 agent-mcp 内部 helper）；保持 tree/path/digest/cap 单一读取器。
- `resources.ts`：`loadMethodResources` 放行 `template.tools` 并返回 frozen MCP servers；`assertCompositionResources` 增加 `mcpServers` equality。
- `agent.ts`：创建/清理 Run MCP 资源根，调用 mount/surface；不承载解析。
- `tools.ts`：`RunToolControllerOptions` 增加 MCP dispatch plan；统一 guard。
- `run.ts`：NodeView tools 加入 MCP public names；controller 传入 plan；不承载解析。
- `host-composition.ts`：派生 `composition.mcpServers` 和含 MCP instructions/resource section 的 `platformPrompt`；base 不再接受 `mcpServers`。
- `runtime/package.json`/lockfile：加入已有 `@deepseek-ai/dsh-mcp-client@0.2.2-alpha.2` dependency edge；不新增包版本。
- 新增 stdio fixture 与测试；复用 S1 stdio fixture 的日志/进程/guard 形态，不改 S1 断言语义。
- 任务卡、build-plan、AGENTS、README 的本片证据。

## Non-goals

- 不实现 `streamable-http`（A4）；A3 对绑定 HTTP transport 显式 `UNSUPPORTED_RESOURCES`。
- 不实现 child/decompose、feedback、ancestor、Summary Worker、exploration、RSI/MethodPatch。
- 不新增 TS MCP transport adapter、第二 registry/writer/fold、自定义 MCP client。
- 不把 MCP server 作为 Cordis plugin 加载；只用 DSH 原生 `agentCtx.plugin(mcpClient, config)`。
- 不实现 secrets broker；config 含 raw secret 或 host 绝对路径显式拒绝。
- 不修改 framework/spec-lock/protocol schema；不改变 store/service/recovery 严格 CAS 校验。
- 不购买真实模型请求；不预建 HTTP fixture/headers。

## 当前消费者与不变量

消费者：

- host `buildSingleRunComposition`：从 `loadMethodResources` 派生 `composition.mcpServers`、写派生 schema、计算含 MCP sections 的 `platformPrompt`。
- create `openSingleRun`：`run/opened` 前完成 Method/MCP asset/contract/Composition 校验。
- resume/submitted：复用同一解析；缺失 CAS 由 strict store replay 拒绝；语义 invalid 由 `MethodResourceError` invalid closure。
- `agent.ts` setup：`mountMcpServers` → platformPrompt 复验 → controller/restrict → `assertMcpSurface`。
- `RunToolController`：server/tool/resource dispatch guard。
- `buildNodeView`：只列 MCP public tool 身份。

不变量：

1. 身份：`template.tools[i] → Method.tools 唯一 id → ToolAsset.server.bundle → contract.resources.mcpServers[i] → Composition.mcpServers[i]`。
2. contract 与 Method bundle refs 精确相等（template 顺序、长度、id/digest）；Composition 六字段 exact。
3. 整个 Method.tools catalog 先验 id/serverName/bundle 唯一、transport/capabilities/exposedTools 合法；未绑定非法资产也拒绝。
4. 只挂载 frozen complete server；不挂载额外 server/tool/resource。
5. `tools.restrict` 不隐藏 scoped MCP；dispatch guard 是必需的第二层。
6. `platformPrompt` 包含 frozen instructions/resource section；实际 scoped assembly 必须逐字节相等。
7. 启动/schema/instructions 失败不发布 Agent、不产生半套能力、不购买模型请求。
8. dispose 清理声明、进程、资源根和 HOME；resume 重新 materialize/mount，不产生部分能力面。
9. 缺失 CAS 走 strict store replay；语义 invalid 走 `MethodResourceError`；不新增 replay 容错。

## 内部契约（无需 amendment）

1. `contract.resources.mcpServers` = `ToolAsset.server.bundle` refs；`Composition.mcpServers` 由 manifest/bundle/schema/config/transport/capabilities 派生。
2. `manifest`、`config`、`schema` 是 opaque CAS 对象的内部 deployment strict shape；不新增公开字段/domain。`sourceFiles` 复用 sealed tree，且每个文件必须在 bundle 中相同存在。
3. `serverName` 存在 manifest/config；`schema` 由 `exposedTools` 派生。`Composition.mcpServers` 不另存 serverName。
4. config 逻辑路径：`command` 只允许 clean logical name（A3 为 `node`），`args`/`cwd` 相对 bundle 根；host materialize 后再派生绝对路径。raw secrets、host 绝对路径、`..` 拒绝。
5. `publicToolName` 未导出，A3 只接受 clean `serverName`/raw name；否则 `UNSUPPORTED_RESOURCES`。
6. 实际 output schema 不能从 DSH 公开 `tools.schemas` 观察；只验证 name/description/parameters，output schema 标为 unproven。
7. MCP instructions/resource section 由 host 按 DSH 固定 section name/order/text 投影；runtime 用 A1 `PLATFORM_PROMPT_SERVICE` 复验完整 scoped prompt。
8. HTTP 属 A4；A3 对绑定 HTTP transport 明确拒绝。

## Done when

- [x] Method tools catalog 与身份顺序通过；contract bundle refs、Composition 六字段和 template 顺序精确。
- [x] manifest/config/schema/bundle/sourceFiles strict 校验与 structured/tree digest、路径/entrypoint/ancestor/cap 正负例通过。
- [x] stdio 从 frozen bundle materialize，使用原生 `agentCtx.plugin(mcpClient, config)` 挂载；无 TS adapter。
- [x] 实际 name/description/parameters 与 frozen exposedTools 一致；extra/missing/mismatch 在 Agent/模型前失败。
- [x] platformPrompt 含 frozen instructions/resource section；实际 scoped assembly 与 digest 一致；instructions 不匹配/超限失败。
- [x] server/tool/resource guard 覆盖 bound/unbound、extra tool、undocumented server、wrong agent、self-read/plan/submitted/stopped。
- [x] 多 server 部分启动失败回滚、dispose 进程/声明/资源根/HOME 清理。
- [x] create/resume/submitted：resume 原 Composition 零新请求；缺失 CAS strict replay；语义 invalid invalid closure；无部分能力面。
- [x] 实际 system/catalog/tool schema/NodeView/request bytes 与 fixture usage 记录；NodeView 8 KiB、tool schema 12 KiB、instructions cap 有测试。
- [x] 定向/包测试/根 `pnpm verify`/`git diff --check` 通过；C-16/C-20 不整体升级。

## 必测负例

- Method tools 悬空/重复 id/serverName/bundle；未绑定非法 catalog；绑定 HTTP transport。
- contract refs 少/多/重排/错 digest/错 domain；Composition mcpServers 任一字段不匹配。
- manifest/config/schema missing/unknown/wrong v/transport/serverName/capabilities/instructions/limits；config 绝对路径/`..`/raw secret；public name 非 clean/冲突/保留名。
- bundle/sourceFiles missing/path/ancestor/entrypoint/bytes/digest/cap/tamper；sourceFiles 不在 bundle 中。
- 实际 server extra/missing/renamed tool；description/parameters 漂移；instructions 空/非空不匹配/超 cap；resource surface 缺失。
- startup failure、多 server 第一成功第二失败回滚、timeout/abort、dispose 后无声明/PID/新请求。
- guard：bound `mcp__server__echo` 成功；unbound server/tool、resource server、wrong agent、self-read/plan/submitted/stopped 拒绝。
- resume server 缺失/语义 invalid；缺失 CAS strict `OBJECT_MISSING`；无成功 closure。

## 检查命令

```bash
export PATH=/home/ROXY/code/singularity/.tooling/node-v24.22.2-linux-x64/bin:$PATH
export DSH_HOME="$PWD/.tmp/s4a3-dsh"
export TMPDIR="$PWD/.tmp"

node --test packages/singularity/runtime/test/mcp-resources.test.ts
node --test --test-name-pattern='S4-A3' apps/singularity/test/run-recovery.test.ts
pnpm --filter @singularity/runtime build
pnpm --filter @singularity/runtime test
pnpm --filter @singularity/app test
pnpm verify
git diff --check
```

不设置 `SINGULARITY_SPIKE_LIVE`；fixture 不是真实模型。

## Structure done when

- `mcp-resources.ts` 拥有 MCP 身份/preflight/capability/prompt；`agent-mcp.ts` 拥有 materialization/mount/surface/env/cleanup；`resources.ts` 只编排；`agent.ts` 只调用 helper 并管理 acquisition 生命周期；`run.ts` 只 NodeView/controller 投影；`tools.ts` 只 guard。
- `service.ts`/`recovery.ts` 零 diff；`recovery-execution.ts` 零 diff。`store.ts 993→997`：`ReferenceValidator` 对 Method/Contract/Composition 的 skill bundle、MCP bundle/sourceFiles 递归 `validateTree` 并缓存，缺叶在 replay/startup 直接 `OBJECT_MISSING`；保留在单一 store validator 内，不新增第二 validator/tolerance，>800 行按单一 CAS/replay authority 例外记录。
- `run.ts=756` 不堆解析；MCP 接入保持 <800；拆分发生在 `mcp-resources.ts`/`agent-mcp.ts`。
- package index 仅导出 host 当前消费者使用的 `mcpCompositionEntry`/`mcpPromptSections`/`MethodResourceError`；`mcpDispatchPlan`、`MCP_RESOURCE_TOOL_NAMES`、`FrozenMcpServer` 留在模块内部。
- 依赖仅增加已有 `@deepseek-ai/dsh-mcp-client@0.2.2-alpha.2`；lockfile 只新增 runtime importer edge，并把 MCP client 既有 `zod` 解析保持为基线 `4.4.3`（未随安装升级到 `4.6.7`）。
- 复用 S1 stdio fixture 的日志/进程/guard 形态；新 Method fixture 证明完整 server/tools/resources/template、expanded template read、env sentinel、双 server 路径与未绑定拒绝。
- 登记 before/after 行数、测试数、导出/依赖、证据边界与未覆盖项。

## Verification evidence（2026-10-31，复核修复后）

- 变更规模（before → after）：`resources.ts 281→312`、`agent.ts 368→443`、`tools.ts 520→545`、`run.ts 749→756`、`store.ts 993→997`、`index.ts 26→31`、`host-composition.ts 263→299`、`run-recovery.test.ts 3515→5012`、`cas-reference-validation.test.ts +82`、`recovery.test.ts +30`、`run-verification.test.ts +153`。新增 `mcp-resources.ts 565`、`agent-mcp.ts 166`、`mcp-resources.test.ts 548`、`mcp-s4a3-stdio-server.ts 196`。
- 测试数：runtime `139/139`（A2 基线 `131` + MCP unit `6` + guard `1` + nested tree `1`）；app `65/65`（A2 基线 `46` + S4-A3 `19`）；protocol `225/225`；根 `pnpm verify` 合计 `429` 通过。
- 定向证据：`mcp-resources.test.ts 6/6`；`--test-name-pattern='S4-A3' run-recovery.test.ts 19/19`；`cas-reference-validation.test.ts 21/21`。
- instructions：`mcpPromptSections` 使用 DSH 相同的 `trimEnd()`，全空正文不注册 `mcp:<server>`；manifest/config 预检按完整 section `### MCP server: <name>\n\n<body>` 的 UTF-8 bytes 计入 heading。unit 覆盖尾部空白、全空白、exact cap、manifest over cap（仅正文长度）、config over cap；真实 DSH platformPrompt digest 通过。
- capability：固定 allowlist `tools/resources/resource-templates`；未知值（含 `filesystem.read`）`UNSUPPORTED_RESOURCES`，空/重复/`exposedTools` 非空缺 `tools` `CONTRACT_INVALID`；`tools`-only 与 `resources+resource-templates` 空 surface 按实际 DSH 声明接受。`tools`-only server 仍由 DSH 注册 native resource tools/section（其 list 可能为空），这不表示 server 声明了 resources capability。没有声称 filesystem/network/license broker 或 sandbox enforcement。
- 子进程 env：`config.env` 仍为空；host 覆盖 `HOME`、`TMPDIR` 与 `XDG_*` 到 Run HOME，并以空串清除 `SSH_AUTH_SOCK`/`SSH_AGENT_PID`/`GPG_AGENT_INFO`/`KUBECONFIG`/`DOCKER_*`/`KRB5CCNAME`/云与包管理器 config 通道。真实 fixture 只记录这些指定 key 和 sentinel 清空结果，不 dump 完整 env；未覆盖通道仍不是完整 sandbox。
- 生命周期：真实 DSH deadline 在 MCP acquisition 期间触发时，host 在 5s bounded grace 内等待 late setup/handle、dispose 并删除 root，无 Agent/模型请求、PID 全退出；无法确认停止时保留/quarantine root 并挂 late cleanup，never-settling acquisition 观察 `MCP resource root quarantined`；late handle 在 deadline 后 resolve 且注入 `dispose()` 拒绝时，不再执行 root cleanup，断言 root 仍存在、`drainPending=true`、reason 含 quarantine 与注入错误，测试结束显式清理；successful late cleanup 与 never-settling 分支保持。正常 dispose、双 server 第二启动失败回滚、resume 零新请求、缺失 bundle/bundle 内 file 的 strict `OBJECT_MISSING`、语义 invalid MCP asset invalid closure、submitted recovery 均验证。
- 路径：所有 server bundle 先 materialize 再按顺序 mount；Run root 由 `mkdtemp` 拥有 0700，server root 0700、文件 `O_EXCL('wx')`/0600；双 server fixture 在第一个进程启动时观察到第二个 bundle 已存在，cwd 分别为 `0-<name>`/`1-<name>`，mode 断言 0700。
- host prompt：guidance 与 MCP sections 的注册/assemble 全部在同一 `try/finally` 中，重复 `mcp:calc` 注册失败后已注册 guidance 被 dispose；assembly 中只剩预注册 section。
- 资源/composition：真实资源 `resources/list`、static `resources/read`、`resources/templates/list` 与 expanded `s4a3://note/42` read 正文均成功；Composition 六字段逐字段篡改、contract 重排/错 digest、sourceFiles subset、public name/config 关键负例通过。MCP guard 覆盖 stopped/submitted。
- 实测 bytes（样例，不是稳定 digest）：system prompt `1261`、NodeView `1794`、tool schemas `4826`、首请求 `8672`；fixture usage `620 input / 72 output tokens, 9 steps, unknown=0`。NodeView 8 KiB 与 tool schema 12 KiB 断言通过；8 KiB instructions cap 由 unit 覆盖。
- 证据边界：未购买真实模型请求，未运行 `streamable-http`（A4），未验证真实 output schema（DSH 公开 `tools.schemas` 不暴露它），未实现 secrets broker、完整 env scrub 或 MCP child sandbox/filesystem/network 限制；test fixture 的 materialized bundle 依赖 app devDependencies 解析，生产 bundle 必须自含依赖；未绑定 HTTP 资产的 config 内容留 A4（其 ref 存在性仍由 store replay 校验）；动态 prompt/NodeView/request bytes 仅为本 fixture 样例。C-16/C-20 未升级。
