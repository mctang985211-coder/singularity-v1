# S4 前实现闭合与最薄审查

- Goal：按冻结 framework 完成 S1–S3 适用行为及证据，逐项核对已有代码是否由当前消费者需要；不以测试通过代替框架符合性。
- Spec refs：framework §2–§4、§9–§15.3、§19.1、§21；build-plan S1–S3；conformance C-01/C-02/C-03/C-11/C-12。
- 允许范围：既有 protocol/runtime/app 实现与对应现有测试、README/build-plan/conformance 证据登记；不修改 framework/spec-lock，不进入 S4，不升级依赖。
- 并行分工：独立 worktree/HOME/cache 下审查存储/纯协议、Run 生命周期/取消、实际 DSH composition；主代理负责工具/可见性、顺序整合及最终审查。任何同文件需求由主代理顺序接入。
- 非目标：child、祖先 Summary Worker、RSI/evaluation；不新增 authority、公开协议字段、通用 runner、registry、模型 loop、兼容层或 util 杂物层。
- Done when：适用规范有实现/负例/证据定位；缺口先红后绿；未定义或 DSH 不支持的边界有具体阻断说明；生产增减及全部抽象的当前消费者可审查；根验证通过；所有未运行的真实模型/领域场景仍如实登记。
- 检查：`pnpm install --frozen-lockfile`、根 `pnpm verify`、`git diff --check`、规范 digest 与依赖锁无变化；有预算的真实模型验证单独记录实际命令与 usage。
