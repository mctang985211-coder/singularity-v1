# S3 platform prompt identity 最简修正

## Goal

让 single-Run Composition 的 platformPrompt 与目标 DSH 实际 scoped assembly 一致，消除手工追加 worker card 造成的顺序和 complete-section 偏差。

## Spec refs

`docs/framework.md` §13、§15.1、§19.1、C-12；`AGENTS.md` §2、§4–§6。

## 允许修改范围与非目标

仅修改 app `host-composition.ts`、`run-recovery.test.ts` 和本任务卡。不改 runtime、规范、协议、依赖或其他测试；不增加 Agent、registry、loop 或自写 prompt 排序。

## Done when

先用真实 profile、已有 Run Agent 的 scoped assembly 建立失败负例，覆盖普通顺序与 complete section；随后直接复用 alpha2 assembly/render 通过。完整根 `pnpm verify`、`git diff --check` 通过，并记录未验证行为。

## 检查命令

```text
pnpm verify
node --test --test-name-pattern='composition freezes the actual scoped platform prompt' apps/singularity/test/run-recovery.test.ts
git diff --check
```

## 实现与验证

固定 singularity profile 通过既有 DSH `systemPrompt.section` 注册 order=100 的 worker card；runtime 原有 scoped 同名贡献会覆盖它。Composition 直接使用 alpha2 `assemble` 和 `renderPrompt`，删除手工追加，不复制排序、complete-section 或 scope 规则。生产代码 +11/-1 行，无新增依赖、类型体系、Agent、registry 或 loop。

两个负例均在真实 `executeSingleRun` setup 完成后的 `agent/created` 读取 `assemble({ scope: agent })`，比较实际 `renderPrompt` 的 digest。普通场景有 order=200 的 host section，complete 场景使用原生 `complete: true`；基线两项均因 digest 不符失败，修正后 2/2 通过。动态 NodeView 不计入固定 platform prompt digest。

接入主线 `d7a4d8a` 的构建 references 与 guard 修复后，根 `pnpm verify` 全通过：protocol 225/225、runtime 82/82、app 28/28，共 335/335；project/build/typecheck/lint 和 `git diff --check` 通过。日志：`/tmp/singularity-s3-prompt-red.log`、`/tmp/singularity-s3-prompt-final-verify.log`。更早基线根检查曾因已由主线修正的畸形 submission fixture 失败，未放宽断言。

该证据仅覆盖当前固定 profile、普通 scoped worker 与 complete prompt 两个场景，不证明任意 scope、未来 profile 或 S4 MCP/skill 装配身份完整。未读取 secrets、未调用付费模型；不升级 S3/conformance 完成状态。
