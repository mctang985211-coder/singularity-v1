# S4 前实现闭合与最薄审查

- Goal：按冻结 framework 完成 S1–S3 适用行为及证据，逐项核对已有代码是否由当前消费者需要；不以测试通过代替框架符合性。
- Spec refs：framework §2–§4、§9–§15.3、§19.1、§21；build-plan S1–S3；conformance C-01/C-02/C-03/C-11/C-12。
- 允许范围：既有 protocol/runtime/app 实现与对应现有测试、README/build-plan/conformance 证据登记；不修改 framework/spec-lock，不进入 S4，不升级依赖。
- 并行分工：独立 worktree/HOME/cache 下审查存储/纯协议、Run 生命周期/取消、实际 DSH composition；主代理负责工具/可见性、顺序整合及最终审查。任何同文件需求由主代理顺序接入。
- 非目标：child、祖先 Summary Worker、RSI/evaluation；不新增 authority、公开协议字段、通用 runner、registry、模型 loop、兼容层或 util 杂物层。
- Done when：适用规范有实现/负例/证据定位；缺口先红后绿；未定义或 DSH 不支持的边界有具体阻断说明；生产增减及全部抽象的当前消费者可审查；根验证通过；所有未运行的真实模型/领域场景仍如实登记。
- 检查：`pnpm install --frozen-lockfile`、根 `pnpm verify`、`git diff --check`、规范 digest 与依赖版本无变化；有预算的真实模型验证单独记录实际命令与 usage。lock 只新增已安装 alpha2 jobs 的直接类型依赖引用。

## 当前实现与最薄审查

| 范围 | 实现与验证入口 | 判断 |
|---|---|---|
| S1 固定 alpha2 宿主 | 既有 S1-A–E 真实 DSH 组合证据；版本未升级 | 保留既有范围，不将宿主 spike 扩成运行时 |
| S2 schema/digest/reducer | 唯一 protocol schema/fold；生产 writer/recovery 已接通既有 reducer | 不增加 validator、事实或 authority |
| CAS supporting refs | 既有 ReferenceValidator 解析 manifest/Evidence/public receipt 和声明的 tree leaves；缺失、错域和损坏均拒绝 | 仅补被冻结 schema 引用的对象，不猜测未冻结内容 |
| 生命周期与提交 | 原生 create/whenIdle/dispose 有界；失败或 drain 未完成不调用 verifier；私有预算 latch 拒绝晚到提交 | 删掉重复 flush、转发和 invalid 结算分支 |
| NodeView/dispatch | controller 的同一 denialCode 决定实际提交与 canSubmit；读取 DSH 原生 jobs 的 running/stopping | 不建立自己的作业 registry；仅新增固定 alpha2 的直接类型依赖，无新安装包或版本升级 |
| Prompt 上限 | worker/NodeView 既有 2/8 KiB；实际 scoped tool schemas 12 KiB；self-read 使用既有 cursor/nextCursor 连续分页，完整覆盖后才开启计划 | 未读页不能跳过；重读不推进覆盖；每个完整编码响应 <=16 KiB；仅保留当次 epoch 的前缀覆盖位置 |
| Composition | app 从真实 loader、route、prompt 和 tool schemas 写入既有 CAS；恢复前重建；变更拒绝恢复 | 不增加 runtime wrapper/callback 或第二配置系统 |
| 干净构建 | build 配置显式声明 app → runtime/protocol、runtime → protocol references；TS extends 不继承 references | 修复独立 worktree 首次 build 缺 dist 失败，不新增构建入口 |

新增生产逻辑均在既有文件内：没有新生产文件、循环、公共协议字段、工具名或 registry。self 的大对象沿既有 `data` 返回可拼接 JSON 文本页；小对象仍直接返回结构化值。cursor 绑定合同和 context epoch，只接受已覆盖前缀内的页；context 更新清空读取覆盖。状态/计划通过既有 status/NodeView 查询，self 页面只包含稳定合同视图。

先红后绿：native ACTIVE_JOB 门禁（此前允许提交）、大 self-read（此前 >16 KiB 且立即授予 readSelf）、超限 visible tool schemas（此前实际购买一次 fixture 请求）。既有 malformed-manifest 恢复测试同步为提交前拒绝，再对合法提交删除 supporting CAS，验证恢复零 Agent/wake/verifier、journal 无新闭合或 Evidence。

## S4 入口阻断

- §19.1：原生 disposal 可以等待守约生产者；取消抛错时 DSH 可只终结作业记录。`invalid + drainPending` 不是已释放外部资源的证明，当前 `workspaceKey` 也没有与实际 cwd 建立可验证的隔离 lease。仍不能保证不合作进程停止后才复用可写路径。需要可撤销的部署隔离或 DSH 原生支持；不新增 Singularity process runner/账本，不擅改框架。
- C-03/C-12：本轮尚无对应真实模型 retry/resume 证据；未找到本轮明确费用/token 预算，没有购买真实模型请求。C-11 完整符合性仍未证明。保持 unproven。
- S4 的 Method 资源挂载、guidance/example/skill 上限与分页、preview/read receipts、child 和祖先摘要不在本轮实现；不得把当前单 Task 子集描述成完整 V1。

因此本轮可修复并验证已定义的 S3 子集，但尚不能确认 S4 前全部代码完全满足框架，也不进入 S4。
