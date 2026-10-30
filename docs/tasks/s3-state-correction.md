# S3 状态约束最简修正

- **Goal**：生产 Task/Run 提交及恢复复用 protocol 唯一 reducer；拒绝 terminal/active Task 的新 Run、非法 attempt/reservation，并保持 resume 工作区改动。
- **Spec refs**：framework §9、§10.3、§11.2–11.5、§19.1。
- **允许修改范围**：runtime `run.ts`、`recovery.ts`、`service.ts` 及对应现有 runtime/app 测试；本任务卡。
- **非目标**：不改变规范、协议、依赖、预算 hook、child/RSI；不增 authority、公共配置、类或工具文件；storage 不承担业务 guard。
- **Done when**：先红后绿的回归覆盖 closed/active/非法 reservation，生产提交与恢复通过既有 reducer，resume 保持输入修改；替代的手工推导删除，生产净行数不增加。
- **检查命令**：Node 24.22.2 + pnpm 11.18.0；独立 HOME/cache/store 下 `pnpm install --frozen-lockfile`、相关测试、根 `pnpm verify`、`git diff --check`。

## 验证记录

- 失败证据：新增 active/maxRuns/over-reservation 用例在旧实现均为 `Missing expected rejection`；既有 resume 用例增加输入改动后，旧实现将 `work in progress` 覆盖为原始 bytes。
- 生产 `commitFact` 统一进入现有 writer 的 `commitTaskRun`，与 generic `commit` 共享序列化/幂等/CAS/append 路径；在提交候选的真实 `at`/`seq` 下调用唯一 `reduceTaskRunFacts`。generic 存储测试入口不新增业务职责。
- 恢复读取同样从 CAS 构建 `ReplayContext` 并 fold；删除五个 find 扫描函数、run-count 和从 facts 重新拼 closure 的推导。projection 不持久化、不新增 ledger。
- `run/opened` fsync 后才初始化工作区；存在 session 的 resume 保持输入修改，session 不存在时在 create 同一 intent 前初始化输入。两个旧 Evidence fixture 补齐协议要求的 `run/submitted`，保留原验收断言。
- 独立环境：`HOME=/tmp/singularity-state-home`、`XDG_CACHE_HOME=/tmp/singularity-state-cache`，pnpm store `/tmp/singularity-state-store`，Node `24.22.2`、pnpm `11.18.0`。
- `pnpm install --frozen-lockfile --store-dir /tmp/singularity-state-store`：通过。
- 根 `pnpm verify`：通过；protocol 225、runtime 60、app 15，合计 300/300；含六个准入/恢复边界回归与同 session 输入保持回归。
- `git diff --check`：通过。fixture 不作为真实模型或领域 RSI 证据；未实现预算 hook/timeout、children 或 RSI。
