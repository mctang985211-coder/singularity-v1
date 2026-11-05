# round8 RSI 成本、终止链与迁移范围审计

审计对象为 `artifacts/round8-mxmm-ball-20261104-224941/execution`，冻结执行源码 `a55421f`；本次修改前备份为 `a570302`。归档只读，本轮没有重启旧根，也没有新付费模型请求。

## 结论与责任边界

这是框架接口缺陷、模型合同错误和领域评测设计共同造成的失败。两个 source 已 verified、proposer 也已提交候选，问题不是始终没有进入 RSI；实际没有完成任何一轮有效的 baseline/candidate 比较。

| 现象 | 已确认的原因 | 修正归属 |
| --- | --- | --- |
| Skill 名字错误浪费正式提案 | 工具未说明机器名称，原生校验到 precheck 才拒绝 | Singularity：说明原生格式，在提交前返回可纠正参数错误 |
| 第二轮整个 campaign 中断 | 新 skill 工具与原有 Task/jobs/MCP 工具组合为 12607 bytes，超过既有 12288 cap，抛出普通异常 | Singularity：缩短重复说明，明确组合上限拒绝；candidate 先执行 |
| 同一子任务反复失败 | parent 冻结了不可满足或与源码冲突的检查，child/parent 未及时消费结果并纠正合同 | 模型的派发与反馈；平台应准确说明执行条件，不修改合同或替模型求解 |
| 费用大但没有领域收益证据 | 每个 arm 独立重建，review 成本接近 worker；候选偏向固定流程和单实例实现说明 | RSI 资产表述与领域实验设计；不得用减少验收冒充改进 |
| “跨 case”被理解成领域泛化 | 冻结 case 都是同一个 MXMM 问题的不同 shape/data | 领域 suite：只能证明 MXMM 输入迁移，不能证明跨算子能力 |

本次不存在以商业 EDA 或整芯片综合为当前终止原因的证据。范围已是 Ball packing/tiling/ISA/BEMU；换 EDA 不能修复命名、工具装配或错误合同。

## 实际用量与终止位置

原始用量来自 `requests.jsonl` 的 2062 个 `model-settled`。input 按既有 accounting 合计 inputTokens、cacheReadTokens、cacheWriteTokens；这是 reported tokens，不是未缓存 token 数或账单金额。unknown=0。

| 执行者 | 请求 | input（含缓存） | output | 总 tokens |
| --- | ---: | ---: | ---: | ---: |
| worker 与 children | 985 | 183063364 | 1353831 | 184417195 |
| reviewer | 1053 | 170393940 | 1220691 | 171614631 |
| proposer | 24 | 906743 | 110877 | 1017620 |
| 合计 | 2062 | 354364047 | 2685399 | 357049446 |

约 48% 用量在独立 reviewer，proposer 约 0.29%。不能把 3.57 亿全部归为 proposer 思考过久。大量费用发生在反复实现、重试、独立 checkout、重建和复核；统计本身不能证明所有这些验证都可省略。

1. round1 source verified；proposer 14 请求、698426 tokens。`MXMM Ball domain spec` 等展示标题作为 Skill.name，precheck 以非 DSH kebab-case 拒绝。第 21 条 fact 为 `rsi/round-closed(rejected)`，没有评测。
2. campaign 从仍为空的 incumbent 重新生成第二个 source；第一次因 delivery failed，第二次 verified。round2 proposer 10 请求、319194 tokens；第 33 条 fact 为 `rsi/candidate-ready`。
3. 旧顺序先跑 baseline long-k：完成 root 和多轮 child/review 后，root verified。其后 candidate admission/setup 在首次模型请求前抛出 schema cap 异常。
4. `execution/result.json` 的原始错误是 `visible tool schemas is 12607 bytes, above the 12288 byte budget`。执行于 `2026-11-05 05:06:38 +0800` 结束；无完整 comparison、无 winner、无新 activation。

旧记录中约 84.2M input 是 round1 全部累计用量，并非 proposer 消耗。blocked tiler 是 probe，非 required；源码装配异常也没有完成某种“子树取消结算”。这些误报已纠正。

## 冻结合同为何导致无效重试

### 第一轮 packing 合同不成立

`child:327623b2e36c17c96044b9f033cacf8b628e0c5f8622d5051c0fad2b29d847dd` 第一次 failed，第二次报告 blocked。冻结脚本让尾部 K 窗口越界，却同时要求固定 kc 的长度和与短尾片段严格相等；还对 16 行 panel 请求 `[4,20)`。这些不是通过修改合法 packer 就能同时满足的要求。独立 receipt 明确指出合同错误。

child 能反馈并阻塞，机制存在；框架不应削弱冻结检查、允许 reviewer 放行或自动修正合同。模型应由 dispatcher 消费证据，必要时用现有反馈、新合同和后续批次重新组织工作。

### 第二轮 shell 条件不匹配且数字语义冲突

baseline long-k 的两个 probe 各跑了三次：

- `child:a4cfcb3c78613e39a099ee85193532ec464388eb146161526f761bc2dd2702e2`
- `child:c0b28f0daee8502535602ff41a24066e7f4eed992ffcb8f24b755fec997f0508`

它们的五项冻结检查分别都用了 `... | tee /dev/stderr | grep -q ...`。host 实际以 `bash -e -o pipefail` 执行，stdout/stderr 为捕获流。所有 attempt 的冻结命令结果均失败，含 `tee: /dev/stderr: No such device or address`。reviewer 可以在自己的交互 shell 看到技术检查成功，但其文字判断不能覆盖原始冻结命令失败。六次重跑无法改变同一个不成立的前提。

本地零付费复现用 Node 捕获 shell 流，即使命令只打印 `CHECK-PASS`，同一管道仍 exit 1；见 `artifacts/rsi-repair-20261105/tee-stderr-report.json`。这不是 BEMU 或 EDA 故障。Singularity 的修正是公开真实运行条件；不加入 shell 字符串检查器、替换管道或自动修复领域代码。

其中数值 child 的 decode 合同还规定 E8M0 scale 0 为 `2^-105`，与 pinned BEMU/RTL 的 `2^-127` 冲突。child 曾为此编写双策略实现。正确做法是依据来源指出 acceptance concern，由派发者重定合同；把矛盾写成兼容分支会继续扩大实现与验证成本。

这些 children 都是 probe。root 后来自行整合并通过其独立验收，不等于子合同正确，也不表示其失败能被当作 required winner。派发模型对合同来源、前提测试和反馈消费的执行质量，仍须真实实验验证。

## RSI 为什么偏向单题固化

归档 patch 中可直接看到风险：

- round1 `SKILL.md` 固定“exactly two probe children”，并携带现成 child 合同/检查。
- round2 `references/runbook.md` 固定 `ball_impl.cli` 和某次实现布局；delivery 说明固定一份 patch。
- round2 `references/domain.md` 写入具体 shape、codes、scale 组合及答案 `0x11c40000`。

固定接口或 ISA 常量本身并非过拟合，shape 也可以是合法适用条件；但固定任务数、原样复制单次求解流程或存放已解实例答案，不能说明可迁移的方法变好了。本次没有添加词法/语义筛查器来替代迁移实测。

原来“implementation belongs in Task output”一类表述也划得过宽：它可能把通用可执行实现一并排除，诱导 proposer 只留下长篇 runbook，让后续 trial 重写同一份代码。现已明确：实例结果留在 Task；参数化算法、脚本/工具和可复用流程可以进入 Method，通过普通输入表达适用性。禁止按 case/suite 身份分派和复制答案；要求说明 unseen-input transfer 与风险。

现有 source、long-k、bank-crossing、output-tiling 全是同一 MXMM 的输入变化。重建和 target 数值复验是当前冻结领域 policy 的真实成本，但这套 suite 无法检验“学会做其他算子”。要做后续领域实验，应选择多个有实际 consumer 的算子族，冻结各自外部合同和独立输入，评估共享 Method 的参数化实现/工具能否迁移；无需预制子任务树或实现。**跨算子 suite 尚未实现或实测，当前任务集仍只有 MXMM 覆盖。**

## 对照 Singularity Core

只读对照 `/home/ROXY/code/singularity-core`，head `be7fc89`。

| Core 路径 | 可借鉴的具体点 | 本次处理 |
| --- | --- | --- |
| `assembly/src/protocol-skills.ts` | authoring 按需读取；区分模板、Skill、Tool 与实例产物；要求观察、假设和迁移证据 | 压缩 proposer card，支持通用 executable Method 资产 |
| `assembly/src/rsi-proposal.ts` | 提案格式简短；非法候选局部处理 | 完整 MethodPatch schema 通过 `rsi_read(authoring)` 返回；非法机器名可同 session 改正 |
| `assembly/src/driver-rsi.ts`、`docs/rsi-agent-contract.md` | 冻结同口径 arms、按真实评测反馈继续 | 保持现有冻结比较，先尝试 candidate，非 complete slot 停止后续购买 |
| `docs/rsi-minimal-reset-20261025.md` | 清楚区分 controlled 与 autonomous 证据 | 保留本轮“本地装配通过”与“真实领域收益未证实”的边界 |

Core 的 controlled 闭环已完成，但同一文档也记录 autonomous 90 分钟只完成 baseline 7/8 slots、无 candidate evaluation。不能从个别成功推成 Core 对此复杂领域已有成本保证。不照搬其平台 skill 挂载、多候选、恢复、自动 infrastructure retry 或 suite 语义筛查。

## 当前修复与验证

保留现有 Task/Run/Method/receipt authority、工具名称和字段结构；无新调度状态、领域算法、预制非 root 验收或自动重试。

| 修改 | 检查范围 |
| --- | --- |
| authoring schema 按需返回，小提交 schema | 原生 provider fixture 验证按需字段齐全、常驻工具 schema <4 KiB |
| Skill.name 使用 DSH `isSkillName` 在提交前检查 | 非法名返回后在同一 proposer session 成功提交，只有一个正式 proposal fact |
| 缩短重复工具 description | 原生 jobs + MCP + skill 组合 fixture；归档真实候选另作新根装配测试 |
| 明确 schema cap 超限保存 invalid ExecutionRecord | 首次请求前零请求拒绝；MCP surface 漂移等宿主异常测试仍要求抛出原始错误 |
| candidate-first；非 complete slot 停止后续 slots | no-submission candidate 只执行一个 slot，完整四 slot 计划保留、insufficient-evidence；普通独立 fail receipt 仍执行四 slots |
| worker 明确来源支撑的 pass rule 与真实 shell 条件 | prompt 与规范一致；未宣称模型已不再写错合同 |

真实候选装配复现只复制归档 CAS objects 至新根，使用新 Task/Run/session IDs，不复制 facts，不续跑旧 session。沿 native DSH + jobs + 原 Buckyball MCP + 原 skill，首次本地 HTTP fixture 请求成功：原生 schema **12210 bytes**（上限12288），provider 序列化 tools **12706 bytes**，两者是不同计量对象。原生 cap 未提高。fixture 故意不提交，结果 failed/no-submission，1 次本地请求、0 付费请求。证据为 `artifacts/rsi-repair-20261105/candidate-composition-4/report.json`；此测试不执行算法、BEMU 或比较收益。

最终根 `pnpm verify` 与行数审计结果见 [进度](progress.md)。真实模型的成本、合同纠错行为、候选执行与迁移收益仍未复测；本次没有新的比较或 activation。
