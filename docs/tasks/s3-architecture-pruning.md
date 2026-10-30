# S3 架构核对与精简

> **historical/superseded**：本卡是 S3 闭合前一次精简的历史证据；334/334 等数字和阶段结论不代表当前工作区。当前状态见 [S3 closure](s3-closure.md)、[build-plan](../build-plan.md) 和 [conformance](../conformance.md)。

## Goal / Spec refs

以 framework 为唯一权威，评估 S1–S3 进度和代码质量；删除没有当前消费者、重复实现或仅为不可达假想状态存在的补丁代码，不删除规范明文要求的 guard、恢复与负例。

- Spec refs：framework §2–§4、§9–§15.3、§19.1、§21、§23；build-plan S1–S3；conformance C-01/C-02/C-03/C-11/C-12。
- 允许范围：既有 runtime 实现、对应现有测试与当前审查记录。
- 非目标：不修改 framework/spec-lock/conformance 状态；不实现 child、RSI、evaluation；不引入替代抽象、兼容层或新依赖；不借精简放宽验收。
- Done when：每项删除都有当前消费者或重复实现证据；既有协议行为测试保持通过；根 `pnpm verify` 和 `git diff --check` 通过；最终 diff 与未验证边界有记录。
- 检查：指定 Node 24 下运行 `pnpm install --frozen-lockfile`、根 `pnpm verify`、`git diff --check`，复核生产/测试净删减与规范 digest。

## 已确认的精简项

- `CommandService.open` 不再对刚由 `DomainStore.open` 完整重放的 journal 立即重复读取和校验。
- command supporting objects 只保留实际消费者使用的有序数组，不保留平行的 `Map`/record 入口。
- Task/Run 与底层命令提交共用一个公开 `commit` 入口，不保留两个仅参数不同的写入口。
- verifier 不再接收从未读取的 `SubmissionManifest` 参数；`FrozenSubmission` 不再重复保存 manifest 已有的 checks/bytes。
- recovery 与 Run 执行共用同一宿主请求校验，删除平行 validator；合并相同的无 Agent usage/session 快照分支。
- CAS 引用遍历删除对内容寻址对象环的假想防护；保留真实存在的去重、缺失、损坏和错域检查。
- 删除只检查函数可导入及另一测试已覆盖 epoch 的导出烟测。

规范明确要求的 deadline、时钟回拨 fail-closed、symlink/no-follow、验收身份、Composition、稳定 wake、torn tail、CAS supporting refs 与恢复负例不属于本次删除对象。

## 进度与质量结论

- S0–S2 已完成；S3 已有单 Run、CAS/journal、retry/resume 和 DSH fixture 实现，但整体仍未完成。24 个 conformance 场景中只有 C-02 有既有真实 DSH + 真实模型证据；C-03/C-11/C-12 及其余场景保持 unproven。child、RSI、evaluation 和领域改进不在当前实现内。
- 本轮发现的问题主要是重复入口、重复校验、重复返回状态和无效测试，而不是框架规定的安全 guard 过多。`run.ts`、存储和恢复仍承担较多职责，但没有为追求行数继续拆分或改变既有控制流。
- 初次后台基线使用系统 Node 22，被项目门禁正确拒绝；改用指定 Node 24 后，精简前基线 335/335 通过。该失败不是产品代码回归。

## 最终验证与规模

- 环境：Node `24.22.2`、pnpm `11.18.0`、DSH `0.2.2-alpha.2`。
- `pnpm install --frozen-lockfile` 与根 `pnpm verify` 通过：project、build、typecheck、lint 和全部 **334/334** tests（protocol **225**、runtime **81**、app **28**），无失败、跳过或取消。减少的一个测试仅为已删除的导出烟测。
- 生产 TypeScript `+59/-192`，净删 **133** 行；测试 `+5/-66`，净删 **61** 行。没有新增生产文件、依赖、协议字段、fact、writer、registry 或模型 loop。
- `git diff --check` 通过；framework/spec-lock/conformance/AGENTS 和依赖 manifest/lockfile 未改。framework sha256 保持 `5f33aa339f21496c375de637ef447656fc66d98d3054a5b6e0a1d3c8dc612b6f`。
- 本轮只运行仓库与 DSH fixture 验证，没有购买真实模型请求，没有执行领域评测，也没有升级任何 conformance 状态。
