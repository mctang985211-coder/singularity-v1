# S3 Composition 来源核对任务卡

## Goal

从真实 DSH profile 的当前公开装配信息重建 single-Run Composition，替换恢复测试中的伪配置对象。冻结合同、局部模板、资源引用和 seed 沿用现有 CAS 身份；DSH 配置、model route、固定 worker card 从当前实际消费者取得。保持可信宿主值 API，不增加 callback、registry 或 wrapper。

## Spec refs

- `docs/framework.md` §2、§11、§15.1、§19.1、C-12、§21。
- `AGENTS.md` §2、§4–§6；`docs/build-plan.md` S3。

## 允许修改范围

- `apps/singularity/src/host-composition.ts`、profile、`apps/singularity/test/run-recovery.test.ts`。
- 本任务卡；不修改 runtime、framework、spec-lock、conformance、single-run 或 S1 测试。

## 非目标

- 不实现 S4 skills/MCP/exploration mount、child、summary 或 RSI。
- 不读取 secrets 或付费实跑；现有 live 开关和预算仅作调查，不沿用过去某次调用授权。
- 不宣称可信宿主不能伪造自身输入；不增加第二配置系统。

## Done when

- 先记录失败负例：真实公开装配变化时不复用旧 Composition，恢复在 Agent/request/verifier 之前 invalid。
- 既有 run-recovery fixture 全部通过，使用真实 profile 的 Composition builder。
- 类型核对来自 alpha2 公开 API；根 `pnpm verify`、`git diff --check` 通过。
- 记录不能由公开 API 完全核对的组成与未运行真实模型证据。

## 实现与证据

`buildSingleRunComposition` 保持 app 层单一宿主入口：它读取已启动 DSH 的 loader `effectiveConfig`（只递归公开值）、`resolveCallConfig`/`resolveModelInfo`、system-prompt assembly、固定 worker card 和当前工具 schema，并把三个快照写入既有 CAS，再返回协议 `CompositionPayload`。它不会读取 credential 值；`apiKeyEnv` 被省略，非空敏感 headers/API key/secret 字段直接拒绝。没有新增 runtime registry、DSH loop 或配置类型体系。

run-recovery 的四个 app 场景都先由该 builder 生成 Composition。composition mismatch 场景在已 admitted Run 后修改真实 prompt、loader 配置和 route options，重建的 platform/config/route digest 均改变，旧 payload 保持不变；恢复在 Agent、模型请求和 verifier 之前写 invalid closure。该测试还检查 CAS 不含 fixture credential/env 名称，并用敏感 getter 证明 builder 不会读取受保护字段。

验证命令：

```text
pnpm verify
```

结果：project/build/typecheck/lint 全部通过；protocol 225/225、runtime 68/68、app 25/25，共 318/318；`git diff --check` 通过；`docs/framework.md` digest 仍为 `5f33aa339f21496c375de637ef447656fc66d98d3054a5b6e0a1d3c8dc612b6f`。

## 边界

这是当前固定 singularity profile 的公开组合核对，不是任意未来 profile 的通用配置审计。DSH 未提供完整无 secret 的 route/config 重建 API；credential-bearing fields 只能拒绝，不能声称已核对。runtime 仍接收可信宿主传入的 Composition 值；本切片不增加 callback 或第二 registry。没有运行真实模型，也没有消费新的付费预算；C-03/C-12/conformance 状态不升级。

## 检查命令

```bash
HOME=/tmp/singularity-s3-composition-home XDG_CACHE_HOME=/tmp/singularity-s3-composition-cache \
PATH=/home/ROXY/code/singularity/.tooling/node-v24.22.2-linux-x64/bin:$PATH \
pnpm install --frozen-lockfile --store-dir /tmp/singularity-s3-composition-store
pnpm verify
git diff --check
```
