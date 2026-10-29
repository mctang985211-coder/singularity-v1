# S2-A 任务卡：protocol JSON、schema 与 digest 基础

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

待首个复现和实现后填写实际命令、结果、环境与未验证项。
