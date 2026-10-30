# S3 最小修正

> **historical/superseded**：本卡保留 S3 闭合前一轮修正的范围与 fixture 证据；其中“进入 S4 前”的阻断结论已由 [S3 closure](s3-closure.md) 取代。当前阶段与未验证项见 [build-plan](../build-plan.md) 和 [conformance](../conformance.md)。

## Goal / Spec refs

按 framework §4.2–4.3、§9–§11、§15.3、§19.1 修复只读审查发现的状态、输出路径、验收身份、预算和恢复缺口。复用既有 reducer、DSH scope 与 CAS，删除被替代的重复推导；不新增 authority、事实、协议字段、依赖或运行时。

## 范围与分工

- 独立 workspace worktree：`workspace.ts` 与现有 workspace 测试，覆盖中间目录 symlink 和恢复输入保留。
- 独立 state worktree：`run.ts`、`recovery.ts`、`service.ts` 及对应测试，接通既有 Task/Run reducer，拒绝 closed/active/maxRuns 违规准入，消除重复状态判断。
- 独立 guard worktree：`verification.ts`、`tools.ts` 及对应测试，核对冻结验收身份与预算 dispatch。
- 主工作区顺序整合：DSH 原生请求边界预算、必要清理、文档与完整验证。并行任务使用各自 HOME、缓存、安装与输出目录；不共享可写 checkout。

## 非目标

不实现 S4、RSI、领域算法或新框架；不改 framework/spec-lock，不升级依赖，不增加兼容层或通用调度器。生产代码净增量必须单独审查，优先删除重复逻辑；必要负例合并进现有测试。

## Done when

1. 先取得具体行为负例，再修复；已关闭 Task 不开启新 Run，实际 journal 能由既有 reducer 验证。
2. 输出与 drafts 的中间路径 symlink 在冻结前拒绝；恢复不覆盖已修改输入。
3. 未匹配冻结 acceptance 的 verifier 不生成 Evidence。
4. deadline、step/token 和 unknown usage 在行动边界约束实际执行；使用 DSH 现有扩展点，不增加模型 loop。
5. 更新 README/build-plan 的实现与证据边界；不借 fixture 升级真实模型或领域 conformance。
6. 审查代码净增减与最终 diff，执行 `pnpm install --frozen-lockfile`、根 `pnpm verify`、`git diff --check`。

## 实现与失败证据

- 状态：新负例在旧实现中允许 active Task、新 Run 超 `maxRuns` 或过量 reservation；resume 会把修改后的输入覆盖成原始 bytes。生产 Task/Run 提交和恢复现已共用既有 writer、CAS 和唯一 reducer，删除手写 run-count/closure/find 推导。`run/opened` 持久化后才准备输入；仅 session 缺失时初始化同一 intent。最终恢复负例又复现 persisted session 存在但 workspace 丢失时重建空目录并发送 wake；现于原生 resume setup 拒绝，结算 invalid，且不创建目录、不购买请求；session 与 workspace 均缺失时仍可初始化输入。
- 路径：file/tree/draft 三个祖先 symlink 负例先失败；冻结时复用既有 no-follow 检查，不另建路径安全层。
- 验收：provider id/digest 不匹配冻结 acceptance 时不调用 verifier；精确预算拒绝以既有 `LIMIT_EXCEEDED` 返回，不使用取整百分比决定权限。
- 预算：先取得 step/token/reservation/unknown/deadline/时钟回拨行为负例，再接 DSH 原生 `agent/pre-step`、`agent/request-error` 与 create/resume signal。route 的 combined contextWindow 只用于保守预留，不当作实际 usage 扣账；缓存 input 计入 token，未知请求不自动 retry。最后一个允许请求仍可 submit。
- 终止：hanging HTTP fixture 在原 deadline 取消；verifier 永不返回的负例先超时失败，现有宿主等待边界结算 `verifier-timeout`。最终复核又复现 verifier 在 deadline 返回仍被接受（`verified != invalid`）；返回后复核绝对时刻，同时拒绝回拨和非法时钟，两个 deadline 用例均通过。从既有 `turn/end` 读取基础设施错误，避免将其误记为普通 no-submission。未增加事实、公开状态或错误码。
- profile 关闭自动 compaction，避免尚未预留预算的 summarizer 购买；既有手动 compaction 集成测试继续通过。

## 证据边界与后续顺序

本轮只证明单 root/Run 的实现和 DSH fixture 行为，没有调用付费模型或执行领域 RSI，也不修改 conformance。先补齐 S3 的真实模型 retry/resume、完整 replay/实际 Composition 来源核对、summary 独立预算、不可停止 job 的 quarantine 与取消 drain，再进入 S4。当前保守预留可能在余额不足一个完整 route contextWindow 时提前停止，不把这种拒绝称为成本改善。

## 最终检查与规模

- 环境：Node `24.22.2`、pnpm `11.18.0`、DSH `0.2.2-alpha.2`。
- `pnpm install --frozen-lockfile`：通过；没有 manifest/lockfile 或依赖变动。
- 最终根 `pnpm verify`：通过项目门禁、build、typecheck、lint 和全部 `318/318` tests（protocol `225`、runtime `68`、app `25`）；没有失败、跳过或取消。覆盖 framework §4.2–4.3、§9–§11、§15.3 与 §19.1 的本卡范围。
- `git diff --check`：通过。`docs/framework.md`、`spec-lock.json`、`docs/conformance.md` 与 `AGENTS.md` 均未修改；framework sha256 保持 `5f33aa339f21496c375de637ef447656fc66d98d3054a5b6e0a1d3c8dc612b6f`。
- 相对基线 `ba3d79f`，生产 TypeScript 新增 `275` 行、删除 `270` 行，净增 **5 行**；profile 增加 `5` 行以关闭自动 compaction。没有新增生产文件、包、抽象层、模型 loop、registry 或 writer；测试复用既有文件。
- 低层 `CommandService.commit` 保留为存储/fixture 入口，与 `commitTaskRun` 共用同一私有提交队列和 append；生产 Task/Run 调用统一经过 reducer，不把业务 guard 移入存储类。
