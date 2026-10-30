# 任务卡：S2 protocol closure amendment

> **historical/superseded**：amendment 001 已获批准并纳入正式规范；下文是提案阶段的任务范围与历史证据，不再要求重复确认。确认与纳入记录见 [amendment 001](../amendments/001-s2-protocol-closure.md) 和 [build-plan](../build-plan.md)。

- **状态**：提案阶段已结束；已批准并纳入正式规范。
- **分支**：`s2-amendment-closure`
- **基线**：`main` @ `5b5f258`；`docs/framework.md` V1 1.0；protocol tests `86/86`。
- **范围**：把 fact payload 与 command/admission 两份草案合并为一份最小 S2 amendment。

## Goal

新增 `docs/amendments/001-s2-protocol-closure.md`，为 S2 关闭提供一份内部一致、可供用户确认的规范提案：13 种闭合 fact 的精确 payload、supporting UsageRecord/ExecutionRecord/Composition/receipt 边界、command 内容身份、journal framing/time、ref domain 和 output 合并顺序。只提案，不实现。

## Spec refs

- `docs/framework.md` §4、§6、§8、§10、§15.2、§17–§20、§21、§23.2
- `docs/conformance.md` C-01、C-05、C-10、C-11、C-14、C-19、C-23
- `docs/build-plan.md` S2“实现闭合 facts 前先完成所需规范 amendment”

## 允许修改范围

- 新增 `docs/amendments/001-s2-protocol-closure.md`
- 新增本任务说明 `docs/tasks/s2-amendment.md`

不修改 `docs/framework.md`、`spec-lock.json`、`docs/conformance.md`、`docs/build-plan.md`、`README.md`、任何源码、锁文件或构建配置。

## 非目标

- 不实现 `FactType`/`FactPayloadMap`、command guard、journal/FS、reducer、runtime/DSH 或 RSI。
- 不新增 fact 类型、authority、writer、fold、wake 来源、registry、transcript mirror、model loop 或兼容层。
- 不把提案写成已批准或已实现；不修改 conformance 状态；不更新 spec-lock。
- 不扩张 ContractSummary/usage 存储；不把现有 optional 字段统一改 null；不改变冻结 authority。

## 合并原则

- 只保留一个 command 推荐：`Fact.commandDigest` + `command` domain；`commandRef`+CAS 仅列备选。
- 对齐 `seq=0`、JCS NDJSON/LF、epoch ms、ref domain、output 顺序。
- `task/children-admitted` 保留完整 child contracts；`run/closed` 保留独立 usage 与 Evidence/ExecutionRecord 区分；`task/closed` 保留 `evidenceRefs` 名称。
- 只保留 K1–K6 六项关键用户选择，删除大规模开放清单。

## Done when

- 提案明确“待用户确认，未批准，未实现”，并包含规范条目、最小复现、现有扩展点不足、拟改语义、权限预算、兼容性、conformance 影响和确认记录。
- 13 种 fact payload 与 supporting 对象边界精确、内部一致；不新增 writer/fold/wake/registry/transcript。
- 只新增指定 docs 文件；`git diff --check` 通过；根 `pnpm verify` 不因文档变更失败。

## 检查命令

在独立 worktree 运行：

```bash
git status --short
git diff --check
pnpm verify
```

## 结果记录

- 新增 2 个 docs 文件；未修改 framework/spec-lock/conformance/源码。
- `git diff --check`：通过。
- `pnpm verify`：project/typecheck/lint/test/build 全部通过；protocol tests `86/86`、app tests `6/6`。
- 所有 fact、command guard、journal、reducer、C-01/C-05/C-11 实现仍为阻塞项；conformance 状态保持 `unproven`。
