# S2-A 任务卡：protocol JSON、schema 与 digest 基础

- **状态**：已完成；S2 继续。

## Goal

建立纯 `packages/singularity/protocol`，以 zod `4.4.3` 作为对象 schema 与 TS 类型的单一来源，实现严格 JSON 文本解析、RFC 8785/JCS 规范化、冻结 digest 域与 seal/verify，为后续已冻结合同和事实提供无宿主副作用的基础。

## Spec refs

- `docs/framework.md` §3、§4 开头 Ref/Digest、§10.1
- `docs/build-plan.md` S2
- 本片段不证明任何 conformance 场景，所有条目保持 unproven。

## 允许修改范围

- 新 `packages/singularity/protocol` 的 manifest、TS/ESLint 配置、src 与 package tests
- 根验证脚本、tsconfig references、lockfile 和对应文档
- 只允许 `node:crypto` 的纯 SHA-256 计算；禁止 DSH、FS、网络、进程、时钟和领域包。

## 非目标

- 不实现 Task/Run admission、闭合 fact payload、journal FS、reducer 或 DSH runtime。
- 不发明未冻结的 fact payload、command identity、digest domain 映射或数组合并顺序。
- 不手写平行 TS 接口/validator，不用 `JSON.parse` 静默折叠重复键，不用 `JSON.stringify` 代替完整 JCS。

## Done when

- 所有 protocol 对象经 strict schema 拒绝未知字段；类型由 schema 推导。
- JCS 保留数组顺序、按 UTF-16 键排序、不做 Unicode normalization；覆盖标准数字/字符串向量。
- 严格文本入口拒绝重复键（含转义键）、非有限数、非 JSON 值、lone surrogate、sparse/accessor/array extra property 和 plain unsafe integer literal；精确大整数只能用字符串。
- 8 个冻结 digest domain 使用规定前缀；seal 仅移去最外层 digest，嵌套 digest 保留；篡改/错域可检测。
- 根 `pnpm verify` 同时覆盖 app 与 protocol 的 typecheck、lint、test、build。
- 未冻结协议缺口单独记录，不通过实现补语义。

## 检查命令

使用官方 Node `24.9.0`、pnpm `11.18.0`：

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

## 失败证据与运行记录

### 初始红证据

- JSON tests：`ERR_MODULE_NOT_FOUND`，strict JSON text parser/JCS 实现尚不存在。
- digest tests：seal/verify 等实现缺失，测试失败。

### 集成环境与门禁

- Node：官方 Node `24.9.0`。
- pnpm：`11.18.0`。
- DSH：`0.2.2-alpha.2`（app 组合测试）。

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

结果：frozen install 通过；根 `pnpm verify` 的 project、typecheck、lint、test、build 全部通过；protocol tests `49/49`、app tests `6/6`；`git diff --check` 通过。

### 覆盖摘要

- 严格 JSON 文本入口：拒绝重复键（含转义键）、非有限数、非 JSON 值、lone surrogate、sparse/accessor/array extra property 和 plain unsafe integer；指数/小数遵循 IEEE/JCS；未新增未冻结的深度限制。
- JCS：保留数组顺序、按 UTF-16 键排序、不做 Unicode normalization；`JSON.stringify` 只用于标量序列化，不冒充完整 JCS。
- digest：8 个冻结 domain 使用规定前缀；seal 只移除最外层 digest，嵌套 digest 保留；篡改与错域可检测；`node:crypto` 仅用于纯 SHA-256 hash。
- schema：zod `4.4.3` 为单一权威源；`closedObject`/`z.strictObject` 拒绝未知字段；`parseProtocolValue` 拒绝 transform/default；input/output JSON Schema 一致。
- 静态纯度：`protocol` 的 `dependencies.zod` 固定为 `4.4.3`，无 `@deepseek-ai` 依赖；`src` 禁止 `JSON.parse`、`z.object`/`z.looseObject`、`Date.now`/`new Date`/`Math.random`/`process.`/`fetch` 及 FS/网络/进程/时钟导入；允许 `node:crypto` 纯 hash。检查只覆盖 `src`，不误伤测试与 `JSON.stringify` 标量序列化。

### zod 版本

集成中曾出现 MCP server/core 的 zod peer 混用；已显式固定 app devDependency `zod` `4.6.7` 与 protocol dependency `zod` `4.4.3`，不跳过检查、不删除断言。

### 仍未验证

- 闭合 fact payload、command guard、纯 reducer、journal/FS、runtime/DSH 业务执行；
- 真实模型请求与领域任务；
- 所有 conformance 场景保持 unproven；`docs/conformance.md` 与 `spec-lock.json` 未改。

结论：S2-A 完成；S2 继续。
