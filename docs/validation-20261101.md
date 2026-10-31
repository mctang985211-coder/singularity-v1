# 2026-11-01 真实模型全流程验证

本次验证使用 DSH `0.2.2-alpha.2`、Node 24.9、pnpm 11.18，原生 pi-ai adapter 访问操作者指定的 `https://api.agicto.cn/v1`。配置模型为 `deepseek-flash`、reasoning `max`、700000 context、40000 最大输出。凭据只在 launch environment 注入。

授权上限为每轮 3 小时、4 亿 token、4000 次调用；实际采用更小的一个累计窗口，所有场景共用截止时间和累计调用/token 计数。原始证据在本地 `artifacts/live-20261101/`，不提交会话、凭据或大体积 CAS。每次执行使用新根；退出后的根通过只读 `DomainStore.replay()` 检查，未恢复旧 writer/session。

最终付费窗口从 2026-10-31 19:46:25 UTC 到 21:02:34 UTC（上海时间 2026-11-01 03:46:25–05:02:34），约 76 分钟。总计 869 次尝试，已报告 17706505 tokens；首次 DNS preflight 失败及两次工具 JSON 失败共 3 次 usage 未知，各按 700000+40000 预留，合计保守用量 19926505 tokens。未知请求保留在原归档结果中；预算 carry 仅把计量传给新根，并从后续总额上限扣掉预留，未伪造已知 usage。账本为 `budget-accounting.json`，之后未再购买模型请求。

## 实际结果

| 新执行根 | 观察结果 |
|---|---|
| `empty-1` | 空 Method 的源任务通过验收，实际读取 skill、调用 MCP、提交 skill draft；proposer 在首次请求前因可选 `entryTemplateId: undefined` 无法 canonicalize 而退出。保留失败归档。 |
| `empty-2` | 两轮 RSI：第一轮 patch 引用了未注册的 global skill，被 precheck 正确拒绝；第二轮读取前轮反馈，建成新 Method、完成三 case 双 arm 精确评测并激活。8 个 Task verified。 |
| `guided-1` | 三轮 RSI 全部 improved 并激活；下一轮 source 使用前轮赢家，最终发布后 Task verified。34 个 Task 全 verified，最大深度 2（root→region→warehouse）。父节点实际检查、汇总和发布。 |
| `exploration-1` | 空 Method 的 root 完成两批相同 `explore-child` binding 的独立探测，父节点自行整合；3 个 Task verified。Summary 首次提交成功。随后 proposer 返回格式错误的工具 JSON，DSH 原生报错退出；没有生成候选或虚假 Round closure。 |
| `exploration-2` | 空 Method 第一轮完成 paired evaluation 并激活，第二轮 source 消费新 head 且 verified，第二轮 proposer 再次返回格式错误 JSON 后原生退出。16 个 Task verified，8 份 probe 报告离线精确核对，实际生成 10 份 skill draft，以及 2 份 MCP 目录说明稿（只有 README，无 server 实现）。 |
| `exploration-3` | 空 Method 完整一轮：两批 probe→sealed trace→新建并绑定 inventory-consolidate skill→三 case paired evaluation→赢家激活→发布后任务 verified。新 skill 在独立评测和发布后任务中原生加载；8 份 probe 报告离线精确核对。 |
| `native-schema-1` | 最终原生 MethodPatch JSON Schema 接口：空 Method source verified，proposer 返回合法 JSON；instanceSchema 混入任务数据，Ajv precheck 按 unknown keyword 正确拒绝。Round 正常 rejected，未激活。 |
| `request-boundary-1` | 在累计上限 868 处只允许 3 次新调用；原生取消/清理后写入 subtree cancelled closure，无验收 Evidence。取消 source 被 frozen RSI eligibility 拒绝，driver 按预期退出，没有继续购买请求或伪造 Round。 |

`guided-1` 有 20 次成功 decompose prepare/commit、42 次成功 plan，其中 16 次 `[0,1,2]`、26 次 `[0,1]`；15 次祖先读取包括 12 次 pending 和 3 次摘要命中，4 次 Summary 提交，9 次原生 skill 加载与 9 次原生库存 MCP 调用。`exploration-1` 另有 3 次原生 skill/MCP 调用、两份 skill draft。上述计数来自会话中的成功 tool result，不把尝试数或 fact 数视为分支覆盖率。

两份 probe 报告另用冻结 CSV 和领域算法离线核对，均精确一致；这项检查没有把 LocalCriterion 改成 required 验收权。原生 request/header 也确认了各次会话的模型、max reasoning 和 40000 输出配置。

## 评测与激活

每轮固定三 case，两个 evaluation case、一个 validation case，各 baseline/candidate 一次。验收独立检查精确行数、带符号 SKU 总量和排序，所有完成对比的 case 均正确，worstRegression=0。

| 执行根／轮次 | baseline 子树 tokens | candidate 子树 tokens | 减少 |
|---|---:|---:|---:|
| empty-2／2 | 433552 | 111820 | 74.2% |
| guided-1／1 | 2599761 | 123692 | 95.2% |
| guided-1／2 | 108186 | 72248 | 33.2% |
| guided-1／3 | 72338 | 45653 | 36.9% |
| exploration-2／1 | 2744018 | 112463 | 95.9% |
| exploration-3／1 | 2685212 | 215151 | 92.0% |

这是公开小领域、每 case 单次 trial 的完整 Task 子树成本，包含相应 Summary/child usage，不包含发现 Method 的 proposer 成本。它证明该任务上的实测改善，不证明统计显著性或芯片适配收益。激活发生在独立验证域，并非修改外部生产系统。

例如 guided-1 三轮 proposer 本身分别消费 461972、777747、490466 tokens；exploration-2 第一轮为 701558 tokens。搜索成本计入整个测试窗口，未被算作 candidate 执行成本下降。

`guided-1` 的三份 comparison：

- `sha256:2ff36a098130b0ca150d57b26cfb7db4c34c4144def51c188a4d093078f400f3`
- `sha256:b2b5c6fdd94e2e030dcff8f01202d5b2f1a50f3ea0b5e221fee58b970bdb74c6`
- `sha256:f331df8d4fdc5141189270d4f727a7dce3d0e0c4005cc81859c1ac0a79e7b151`

最终 Method 为 `sha256:90bab4af451b713f7e4852516fbdcb89407482314b4435627f2e17ff0281ef03`，发布后 Evidence 为 `sha256:8e85f48461c36768f50bcc78788f72d8c30007e36fd458a853315cada3db2553`。只读独立检查验证了所有 4 个 Summary 的 source Run/contract/native usage、18 个 slot 的完整子树汇总、三次 expected-head 链与发布后消费；证据见各根的 `independent-checks.json`。

`exploration-3` 的新 skill 成功原生加载 4 次；其 comparison 为 `sha256:7ada0b5d1a0a7b847da3eba27552a4eea1612414354ab53167984e6e2ebf078b`，最终 Method 为 `sha256:de39813953ca777edef30c4ad07e3d6bfa5a839dcad65a9ec0b5c4f82da5136c`，发布后 Evidence 为 `sha256:2d46d652567dd934628d49d2c8b97363216f094132e590839ba32cd4a46ed691`。赢家及可达 assets 导出到该根的 `published-method-export.json`。

## 由实跑修正的问题

- ProposerView 省略不存在的 entryTemplateId，保持空 Method 的有效 JSON；未增加默认值或兼容别名。
- required winner 规则仅用于 required binding；probe 可在后续 batch 问新问题，失败 probe 不自动附加 required replacement。保留 required join、fresh retry、显式 replacement 和强制等待。
- Summary 参数描述明确 digest/string/array 类型。实跑首次提交通过；未增加 coercion、重试或备用摘要器。
- Task 协议说明区分 Method 资产与 public exploration catalog；proposer card 引导按假设读取相关轨迹、集中表达复用指令。格式错误的模型工具 JSON 仍按 DSH 原生失败结束，没有自建 JSON 修复器。
- 删除手写的 schema→“字段形状字符串”递归转换器，rsi_submit_patch 直接使用 Zod 派生的完整 JSON Schema，与 plan/decompose 的 DSH 接入一致。完整 MethodPatch schema 约 6.1 KiB，原生 setup 检查确认全部 RSI tool schemas 仍在 12 KiB 上限内。

新代码集中在 examples 的原生 skill/MCP、空 Method 组合和真实 expected-head 激活。新增的完整原生 fixture 还把 put-skill/put-mcp-server、模板绑定、双臂评测、赢家激活、下一轮与发布后消费串在同一执行中。产品层没有新增 manager、恢复状态或生产依赖。

本次全部根合计 79 个 verified Task、1 个 cancelled Task；8 个已闭合 Round，其中 6 个评测赢家实际激活、2 个 precheck rejected。另有两次 malformed JSON 后未闭合的 proposer 和一次请求前空字段错误，均单列失败，不冒充正常 Round。

## 覆盖边界与复现

根门禁 `pnpm install --frozen-lockfile`、最终 `pnpm verify` 全部通过，432/432（protocol 203、runtime 134、app 82、domain 13），0 fail、0 skipped；proposer/runner/多批次相关检查另有 9/9 通过。日志位于 `install.log`、`verify-final.log`、`final-targeted.log`。C-01–24 的逐项位置与证据见 [progress.md](progress.md)。

业务失败后的 fresh retry/replacement 有历史真实模型证据和当前原生 fixture；本次另有真实请求预算取消。stale activation、validation 回退拒绝、隐藏引用拒读等负路径以 fixture/协议测试验证。真实 accepted patch 已演化模板/guidance 和 skill 注册/绑定；MCP 目录产物只有说明稿，可执行 MCP 注册与绑定演化由完整原生 fixture 证明，没有为计数强迫生成无用工具。当前 profile 关闭自动 compaction；本次会话未出现 compaction 事件，未声称其独立请求已计入。

已只读查看 Buckyball 的 `.agents` 和既有 MCP/工具链。当前场景已覆盖三级调度和闭环 RSI，未另建芯片领域 adapter，未运行或修改 Buckyball；芯片功能、P2E 和私有数据 OS 隔离均不属于本报告已完成证据。

按 [README](../README.md) 设置 launch environment，然后使用新目录运行：

```bash
pnpm --filter @singularity/app exec node --use-env-proxy \
  examples/inventory-validation.ts <fresh-root> 3 <previous-counter-root> \
  --config <config.json>
```

配置选择 `scenario: "warehouse-network"`、`initialMethod: "empty"` 或 `"guided"`、`publicResources: true`、`activateWinners: true`、`objective: "reported-tokens"`，提前固定 deadline 与预算。旧根仅提供累计计量，不恢复执行。原生会话与 `executed-code-hashes.json` 绑定各次已执行快照；guided-1 启动早于 probe/Summary 描述修正，exploration-3 使用简短形状描述，native-schema-1 使用最终完整 JSON Schema。它们分别证明自己的执行快照，不冒充全部最终源码重跑；最终闭环由根门禁中的原生 fixture 验证。
