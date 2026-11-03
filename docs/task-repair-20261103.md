# Task 修复审计（2026-11-03）

以 `dac8c0e` 为比较基线；修改前的工作区已备份为 `7e75517`。本次选择撤除首轮新增体系，再沿原 Task 路径修复。真实模型测试保持停止，未启动新的真实模型请求。

## 偏离发生在哪里

规划与施工均有偏离。主规划的职责分解、输入接口、本层集成与及时验收方向有效，但 §9、§11.1–11.2 明确把 parent 任意新检查代码延后，限定为领域配方及参数，localCriteria 仍无正式验收权；配套范例也要求原生加载项目 skills。这些约定与当前“模型编写 child 验收、项目 skill 仅作参考文档”的要求冲突，不能继续照原规划实现。

实现随后围绕配方授权、schema、检查报告、数值 oracle、固定 case suite 和预检持续扩张。真实数值误放行需要如实记录，但修复这些领域测试缺口并不能证明模型理解了 Task 工作流；项目旧 skills 仍被挂载，固定流程继续干扰当前角色。

- 11 月 2 日 13:55 轮（`artifacts/model-workflow-audit-20261102.json`）：9 Tasks、8 个 child 局部 verified，root 的 design-contract/implementation 仍失败；组件、数值与文档交付没有形成完整 compiler/recipe/RTL 集成。此前进度声称“显式传递冻结 seed”过强：proposal 并未完整传递，`read(self)` 丢失 `InputRef.object`，模型转而读取祖先路径。局部通过不能升级为接口正确或整体通过。
- `artifacts/takeover-full-real-20261103-0750/operator-stop.json`：reviewer 复现 FP32 不匹配后以 FP64 替代解释放行；`takeover-full-native-oracle-20261103-0858/operator-stop.json`：修好 oracle 后，仍把有效失败输入排除出正式三 case 分母。CAM++ 的 seed20261103/T16 有 6 处、seed20261108/T8 有 8 处不匹配。这两轮均为错误放行，不能当成功证据。
- `takeover-full-fixed-suite-20261103-1023` 的 SQLite 只有 root admission、1 次提交、0 child、0 RSI。root 原生 `session.v4.jsonl` 第 110 行已有分解计划；第 390 行（seq388）明确返回 `decompose prepare result is 34024 bytes, above the 32768 byte budget`。固定 preview 因新增配方/schema 超限，parent 无法通过缩小任务修正；三次尝试后模型改为独自实现。这里直接堵住分解的是实现膨胀，不能归咎为模型不愿使用 Task。

最后一轮 `result.json` 汇总此前根共 2426 次请求、356410053 reported tokens、6 次 unknown；其中最新根 200 次请求、42753023 reported tokens、1 次 unknown，outcomes 为空。消费量不证明修复有效。

## 本次保留的修改

worker/summary/proposer/reviewer 使用各自原生 scoped 角色；worker 指引围绕完成路径、依赖接口、直属职责、分批交接和本层集成。`self` 返回完整 InputRef。parent 编写非空 `acceptanceCriteria: {id,statement,check}[]`，准入冻结为 required 条目；explore-child 不再预制 task-goal 验收，只保留 result/ 交付接口。

host 复用 DSH 原生 shell，在 fresh 目录物化 CAS 合同输入和冻结输出，执行合同中的自包含 check；失败不能由 reviewer 放行，reviewer 的失败也不能被命令成功覆盖。结果写入现有 receipt.reason。删除被替代的 localCriteria/localGuidance、配方/check 报告及固定 suite 路径，不保留兼容入口，不增 authority、调度器或状态账本。

Buckyball 撤除项目旧 skill 的打包、改写和注册；root 合同只给出 `.agents/skills/` 的参考文档绝对路径。root 领域验收继续由 operator/domain 固定；child 目标、接口和验收由 parent 自己写。Singularity 自产 Method skill 的现有机制保留。

验证包括协议与原生 DSH 脚本化集成：真实 tool self 返回二进制 Ref 并向 child/grandchild 传递、跨批冻结交接、独立命令拒绝 reviewer 误报通过、失败后的 replan/replacement、本层集成及 deadline 取消。最终检查与行数记录见 [进度](progress.md)。这些证据验证机制可用，尚不能证明真实模型已自主正确使用 Task；按最新停止要求，本次不重跑真实模型。
