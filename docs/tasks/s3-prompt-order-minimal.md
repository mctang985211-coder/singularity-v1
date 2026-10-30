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
