# Singularity 动态 workflow 与可信验收重建计划

日期：2026-11-08
审计基线：`ba5f1644533bf6afea8460b4fe41c72faf0eb351`
状态：2026-11-08 用户已要求按本文实施；第 14 节 1–4 形成 amendment 027，实际进度与验证见 docs/progress.md。

本文记录 Git 与真实执行证据、重建目标、建议的公开协议变化和分阶段验证方法。`docs/framework.md` 仍是唯一协议权威，`docs/progress.md` 仍记录实际实施与证据。本文不是平行协议、任务卡或已完成修复的证明；文中标为“建议”的字段、模型可见性与权限变化，已由本次实施指令授权进入 amendment 027、规范和代码。

## 1. 不可动摇的核心决定

**parent 在派发 child 前，根据当前目标、输入和消费者编写并冻结 child 验收脚本，是 Task 作为自主 workflow 节点的必要能力，必须保留。**

领域只提供：

1. 根任务的最终验收脚本；
2. 资料中可选的通用验收工具，例如 decoder、独立参考实现、BEMU runner、比较库；
3. 目标、接口、案例和环境说明。

领域不得提供预写的 child 验收脚本、固定分解树、reviewer 生命周期、重试策略或 RSI 控制流。

要删除的是 proposer 把某一次 source 的验收脚本、固定检查布局和完整解题流程固化成未来 Task 的预制 workflow，**不是删除模型在每个实际 Task 中设计验收的责任**。

模型编写验收会出错。出错本身是 RSI 可以改进的对象；正确目标是提高验收可信度、让错误尽早暴露并被修正，而不是因噎废食地收回模型的 workflow 能力。

## 2. 审计证据与引入时间线

### 2.1 独立 review 与脚本验收都曾真实存在

`01124e9` 在 11 月 1 日引入 Buckyball 独立 review Agent：独立 session、冻结 CAS 输入输出、独立 checkout，并明确禁止修复候选。当前通用实现仍在 `packages/singularity/runtime/src/reviewer.ts`。

最新 Buckyball root 则按后来批准的确定性 checks 路径运行：

- `domain-tasks/buckyball/domain.json` 选择 `checks`；
- `apps/singularity/src/experiment.ts` 选择 `checksOnly`；
- `packages/singularity/runtime/src/verification.ts` 由 host 执行冻结命令，不创建 reviewer。

所以当前不是“写模型兼任 review 模型”。当前需要修正的是领域脚本检查执行证据的方式，不是推翻已有的角色隔离。

### 2.2 主要设计问题的引入提交

| 提交 | 引入内容 | 审计判断 |
|---|---|---|
| `01124e9` | Buckyball 独立 review Agent | 角色隔离原本存在 |
| `1839380b` | 叶模板继承公共资源，带 children 的模板只使用自身绑定 | 当前公共 MCP 丢失的早期结构根源 |
| `0a0d280` | 检查配方、报告 schema、固定领域套件、预检和大量角色 skill | 126 文件，`+4397/-674`，明显超出单点修复 |
| `b0bbdbe`、`e766a07` | 固定 oracle、case suite、CAS 检查执行 | 继续扩张同一验收体系 |
| `7e75517` | 大规模撤回上述实现，`+692/-4913` | 多数 `0a0d280` 的直接产物已退出当前代码 |
| `16fd4ff` | parent 编写 `{id,statement,check}`，host 用原生 shell 验收 | 当前动态 child 验收的直接来源，应保留其职责 |
| `a55421f` | MXMM 独立 review、真实 consumer 和 token 成本比较 | 领域方向有效，成本不能代替通用能力 |
| `30a6b54` | 通用 reviewer 与实验宿主抽取 | 保留可用的角色边界，警惕宿主继续膨胀 |
| `3c2092f` | 新 scale `%255`、proposer 学习 `consumer checks` | 重新引入不可达输入和验收导向学习 |
| `82e0a41` | 确定性根脚本、命令记录检查、迁移 case、verified-fraction | 当前领域脚本与判据问题的直接来源 |
| `53ee50e` | 要求复制公共 MCP 或省略绑定 | 提示补丁没有消除结构性绑定负担 |

### 2.3 `0a0d280` 同批问题不是推测

当时已经证实：

- 34,024-byte preview 超过 32,768-byte 上限，直接阻止 parent 分解；
- 数值 oracle 曾错误解释 FP32 不匹配，并排除真实失败输入；
- 固定 skills、角色和流程门禁干扰当前 Task 职责；
- 配方、参数 schema、报告、领域执行器和固定 suite 形成另一套复杂体系。

`7e75517` 与 `16fd4ff` 已撤回其中大部分实现。现在不应恢复它们，也不应把当前所有问题错误归因于已经删除的文件。真正延续的是“围绕验收不断扩体系”的设计倾向，它又在 `3c2092f`、`82e0a41` 中以新形式出现。

## 3. 根因必须分层，不能归结为“模型太傻”

| 已观察事实 | 可以确认的归因 | 不能据此确认的结论 |
|---|---|---|
| 分页错误、长文件名、工具 schema 超限、宿主终端退出 | 宿主或启动方式缺陷 | 模型不理解 workflow |
| scale 导致冻结输入非有限 | 领域合同不可达成 | 需要更多模型引导或更多重试 |
| 正确技术分解、parent 集成、retry 后 source 成功 | 模型能够承担 workflow 节点职责 | 模型完全没有 workflow 意识 |
| 错误局部检查、遗漏可执行 BEMU、错误路径 | 模型会犯普通实现与验收错误，框架让错误过晚、过贵地暴露 | 必须收回模型编写验收的能力 |
| proposer 固定 selfcheck、child 布局和检查脚本 | 模型泛化不足与接口/提示激励共同存在 | 只增加“要泛化”提示即可解决 |
| 最新 candidate long-k verified、baseline 中断 | 局部 source→proposal→candidate 链已走通 | 完整 RSI、迁移或 winner 已成立 |

最新证据表明，框架问题和模型问题同时存在。 rebuild 的目标是：去除框架制造的低级负担，让剩余错误更直接地反映模型能力，并使这些错误能够成为 RSI 的学习信号。

## 4. 重建后的最短正常路径

```text
operator/domain 冻结根目标、最终验收和环境
                    │
                    ▼
worker 阅读当前合同，完成本级技术工作并规划直属职责
                    │
                    ▼
parent 为实际 child 编写验收，host 在准入前冻结完整合同
                    │
                    ▼
child 先检查合同是否有歧义，再实现；必要时立即 feedback
                    │
                    ▼
host 在 fresh CAS-only 目录执行 child 验收并生成 receipt
                    │
                    ▼
parent 读取直属结果，真实消费产物并完成本级集成检查
                    │
                    ▼
host 执行领域冻结的根最终验收
                    │
                    ▼
sealed trace → proposer 提炼可迁移能力 → 同环境 paired evaluation
```

完整性门禁只保护冻结身份、真实输入输出、验收 receipt、required join 和预算，不判断模型是否写出了“看起来正确”的自然语言计划。

## 5. 领域任务与最终验收重建

### 5.1 领域只提供三类材料

1. **根任务和最终验收**
   - 根目标、交付物、输入输出路径；
   - 最终冻结验收命令；
   - source/public/validation cases 及其输入；
   - 脚本只通过退出状态表达通过或失败，host 不做领域语义翻案。

2. **可选验收工具**
   - decoder、独立参考实现、BEMU/编译器 runner、比较库；
   - 供 parent 编写 child 验收时组合使用；
   - 不是预写的 child 验收，不读取 Task、Method、transcript 或 scheduler。

3. **简短接口资料**
   - CLI、输入输出布局、必要环境约束、core/chip/runner 信息；
   - 正确和错误示例；
   - 不规定 workflow、RSI、Method 修改范围或 reviewer 生命周期。

### 5.2 根脚本的职责

Buckyball 根脚本必须自行验证根合同要求的真实执行，包括真实 consumer、原始 bytes、数值、guard 和 regression。不能只因为候选返回一份形式正确的命令记录，就认定设备执行已经发生过。

这不意味着写模型有意伪造证据，也不需要再增加一个 LLM reviewer。验收复杂度属于领域脚本，host 只负责物化冻结输入输出、执行命令和记录退出状态。

### 5.3 启动前的领域预检

预检是 operator/domain 的准备条件，不是运行期新增调度器：

- 已知正确实现通过最终脚本；
- 缺失输出、错误数值、错误 guard、缺少真实执行分别失败；
- 每个冻结 case 都通过有限性和可达成性检查；
- MCP 的全部公开工具实测业务成功、参数失败和取消退出；
- 不将帮助、握手或测试替身当成真实 consumer 证据。

预检失败时不购买模型请求。

## 6. 动态 child 验收的信任机制

### 6.1 保留验收先于实现

当前最重要的信任机制必须保留：

- parent 在看到 child 实现之前编写验收；
- 验收随 child 合同冻结；
- child 不能修改验收；
- host 而不是 child 决定验收结果；
- child selfcheck 可以辅助开发，但不能代替 parent 编写的验收。

### 6.2 验收异议应在实施前发生

worker 的引导顺序调整为：

1. 读取当前目标、交付物和验收；
2. 判断检查是否测量 parent 真正需要的结果；
3. 有歧义时先反馈，不在错误合同上持续实现；
4. 前提解决后再实施和分解。

`singularity_feedback(kind="acceptance-concern")` 的 summary 只需自然语言说明：

- 当前检查实际测量了什么；
- parent 目标真正需要什么；
- 可复现差异；
- 建议的检查方式。

不新增反馈字段、消息副本或 broker。

### 6.3 澄清与改合同严格分开

- `replyTo` 只澄清现有合同，不能修改它；
- 检查本身错误时，child `stop(blocked)`，不自动 retry；
- parent 创建带修正验收的新 Task；
- 已完成的旧产物以完整 InputRef 传给新 Task；
- 不重复实现，不从旧 workspace 或 transcript 恢复。

probe 一次 Run 后 terminal 的规则保留；parent 决定本地集成或显式创建修正 probe。required retry/replacement 和 required join 不变。

### 6.4 用良好范例提高验收质量

范例只说明写作方法，不成为未来 Task 的冻结合同。

基本形式：

```bash
set -euo pipefail

# tools/ 来自冻结输入；result/ 来自 child 的冻结输出。
python3 tools/check_consumer.py \
  --input project.json \
  --output result/response.json
```

适用时由 parent 自行增加负例：

```bash
cp result/response.json bad-response.json
python3 tools/mutate_response.py bad-response.json

if python3 tools/check_consumer.py \
  --input project.json \
  --output bad-response.json
then
  echo "checker accepted a known-invalid result" >&2
  exit 1
fi
```

负例用于发现空检查、错误比较、错误路径和错误脚本逻辑，不用于假定模型有作弊动机。不要强制固定负例数量，也不要新增自然语言门禁。

良好范例应体现：

- 检查真实消费者，而不是只检查报告文件存在；
- 独立重跑或独立推导，而不是只相信候选 selfcheck；
- 输入原始 bytes 不被替换；
- 脚本只依赖冻结合同声明的文件和环境；
- 失败信息能指出具体差异；
- 不将 `grep PASS`、退出码或自报指标单独当作完整正确性证明。

### 6.5 逐层验证真实消费者，而不是重复复核

- child 验收验证局部交付；
- parent 实际消费 child 产物并验证本级集成；
- parent 不应原样复制 child 验收，也不应再创建“审查 child 验收”的 reviewer child；
- root 最终验收验证完整业务目标。

这条层次关系能避免 round10 的复核树，也比每层增加独立 LLM 更便宜。独立 review Agent 只用于确实无法确定性判定的任务，不是默认验收层。

## 7. 公共资源和 Method 的减量方案

### 7.1 公共领域环境由 host 组合

公共领域 MCP、基础工具和公开资料属于运行环境，不应要求 proposer 复制到每个 candidate Method。

建议规则：

- baseline/candidate 默认获得同一公共领域环境；
- Method 只表达新增或修改的自有能力；
- `tools:[]` 不再意外移除公共 MCP；
- 删除公共环境属于 operator/deployment 变化，不属于普通 MethodPatch；
- Method 自有工具与公共工具发生身份冲突时显式报组合错误，不静默覆盖。

这直接替代 `53ee50e` 的“复制公共资产或省略绑定”提示补丁。

### 7.2 TemplateDraft 建议字段表

| 字段 | 建议 | 原因 |
|---|---|---|
| `id`、`brief` | 保留 | 稳定引用和简短职责说明 |
| `guidance` | 保留 | 可迁移的本层工作指导 |
| `example` | 保留但只作示例 | 提供良好接口与验收写法，不形成实际义务 |
| `children` | 保留 | 表达可选直属职责与 required/probe 完整性 |
| `skills` | 保留 | 绑定实际可复用能力 |
| `tools` | 仅保留 Method 自有工具的必要引用 | 公共环境不再复制绑定 |
| `requiredCriteria` | 建议从 Method Template/Patch 删除 | 实际验收由 parent 针对当前 child 编写 |
| `requiredOutputs` | 建议删除并统一简单 `result/` 交付 | 避免把一次文件布局固化成通用 workflow |
| `instanceSchema` | 已由 host 派生 | 不回到模型抄写 |
| `acceptancePolicy` | 已由 host 派生 | 不回到模型抄写 |
| learning outputs | 已由 host 派生 | 不作为 proposer 业务资产重复声明 |

`TaskSpec.criteria` 和 `TaskProposal.acceptanceCriteria` 不受上述删除影响。root 的输出仍由领域合同决定，parent 的 supporting 输出仍按实际 Task 添加。

`children` 只是可选职责目录，不要求 parent 必须创建固定树。`required` 只约束已经选择该职责时的 winner/join，不替 parent 决定何时分解。

### 7.3 不保留双格式兼容分支

如果批准删除 `requiredCriteria/requiredOutputs`，应同步迁移 Method schema、patch、preview、准入、示例和测试，而不是增加第二套解释路径。

历史 Method/CAS 只作归档证据，不自动激活到新协议。现有 guided fixtures 应迁移为“示例职责 + parent 实际编写验收”，不能通过删除断言来掩盖义务丢失。

## 8. 模型可见信息与注意力管理

### 8.1 当前 worker

长 transcript 不能成为当前责任的唯一载体。建议从冻结合同直接派生简短的当前节点视图，持续展示：

- `goalSummary` 和 `deliverable`；
- 当前 required criteria 的文字陈述；
- 当前输入输出路径；
- 实际工具名称及必要的一句使用提示；
- 当前直属结果和待消费输出。

不包含完整长脚本、重复 Method 文档或历史流水账。CLI、BEMU、路径和 core 等低级但必须稳定可见的事实，应写入根任务的简洁接口资料和当前验收陈述，不能埋在长 skill 中等待模型偶然发现。

该视图只复用冻结合同已有信息，不再购买一个“当前合同总结模型”。模型可见字段变化进入 amendment 027。

### 8.2 proposer

proposer 应学习：

- 如何定义可独立验证的结果；
- 如何选择真实消费者；
- 如何避免空检查、错误路径和自证 PASS；
- 何时使用负例；
- 如何发现并修正错误合同；
- 可复用 decoder、runner、比较器、Skill 和职责接口。

删除或替换以下导向：

- 把 root failed criteria 当成唯一阅读起点；
- 默认提取 source-specific consumer checks；
- 通过复制公共资产完成绑定；
- 以固定 selfcheck 和固定 child 树证明 workflow 改进。

proposer 必须读取的有价值链条包括：

- 错误合同 → feedback → 修正合同 → 成功；
- 正确实现被错误验收拒绝；
- 错误实现被局部验收放行、最终 root 拒绝；
- 重复实现和重复检查的总量成本。

不增加“不要过拟合”的新段落来抵消旧指令，应直接删除冲突指令。

## 9. 怎样判断框架问题、领域问题和模型问题

### 9.1 零模型领域验证

验证根脚本的正确/错误实现判定、case 可达成性、真实 MCP/BEMU/checkout 和取消。

失败归领域或环境，不启动模型。

### 9.2 零模型宿主验证

验证：

- candidate/baseline 获得相同公共 MCP；
- parent 编写的验收在 fresh CAS-only 环境执行；
- 错误验收可通过 feedback/blocked/新 Task 修正；
- 旧 CAS 产物能被新 Task 消费；
- 无强制 reviewer 和预制 child workflow；
- Method 不携带公共资产副本或 source-specific 固定验收。

失败归框架。

### 9.3 小规模验收编写迁移测试

这是离线评测，不是生产运行门禁：

1. 给模型目标和输入；
2. 由模型编写验收脚本；
3. 分别在正确产物和多种错误产物上执行；
4. 记录错误接受、错误拒绝、路径依赖和修正次数。

对比同一模型的：

- 当前复杂界面；
- 精简界面；
- 精简界面加良好范例。

精简界面显著减少错误，说明框架/上下文是主要原因；仍然反复写错同类检查，才说明模型能力或示例本身存在更大问题。单次试验不能下确定结论。

### 9.4 RSI 迁移验证

base/candidate 使用相同公共环境和根最终脚本，分别报告：

- 根最终验收结果；
- 正确产物的接受率；
- 错误产物的拒绝率；
- 错误合同的反馈和修正情况；
- parent 是否真实消费 child 产物；
- 不同算子和不同任务的结果；
- 总 tokens 和总耗时。

只看总量，不扩展 cacheWrite 等用量分类。token 下降单独不宣称通用能力提升；同质量的效率改善与质量/迁移改善分开报告。

validation 作为独立不回退检查，不与 public 提升混为一个平均数。单次二值 trial 不能证明稳定提升，必要时按预先冻结的噪声估计增加重复次数。

## 10. 分阶段实施计划

### 阶段 0：冻结重建边界

- 用户确认本文的核心动态验收原则和公开协议变化；
- 形成 amendment 027，更新 `docs/framework.md`、`spec-lock.json`、`AGENTS.md`；
- 将当前行为列为对照，不删除历史证据；
- 不新建平行 scheduler、验收协议或恢复机制。

退出条件：动态 child 验收、公共资源组合、TemplateDraft 收缩和兼容策略都有明确决定。

### 阶段 1：修正领域最终验收与预检

主要消费者：operator/domain、root host check runner。

工作内容：

- 修正 Buckyball 根脚本的真实执行证明；
- 保留最终布尔验收，不增加 root LLM review；
- 将中间可用能力整理为可选工具，而非 child 预写脚本；
- 用正确/错误实现和全部冻结 case 做零模型预检；
- 精简模型接口资料，使 CLI、BEMU、路径和环境约束稳定可见。

退出条件：根脚本正确通过/拒绝，全部 case 可达成，真实 MCP/BEMU 预检完成。

### 阶段 2：组合公共资源，删除复制绑定

主要消费者：`contractFor`、Task composition、paired evaluation、MethodPatch precheck。

工作内容：

- 公共环境由 host 自动组合；
- Method 只携带自有增量；
- 检查 candidate/baseline 公共环境一致；
- 删除 proposer 复制公共 MCP 的指引；
- 保留真实 scope 和实际 MCP surface 对比。

退出条件：带 children 的 candidate 与 baseline 均实际挂载同一公共 MCP，candidate 不再因 `tools:[]` 丢失领域能力。

### 阶段 3：收缩 Method 和 proposer

主要消费者：MethodPatch、decompose prepare/commit、worker NodeView、RSI proposer。

工作内容：

- 按批准结果删除 `requiredCriteria/requiredOutputs`；
- 保留 parent 的 `acceptanceCriteria`；
- 统一 child 的简单 `result/` 交付；
- 示例只作写法参考，不自动成为冻结合同；
- 删除 source-specific consumer checks 和复制公共资产的引导；
- 不增加语义筛查或固定树门禁。

退出条件：proposer 能提交通用能力和职责接口，实际 child 验收仍完全由 parent 编写并冻结。

### 阶段 4：强化验收范例和父子对话

主要消费者：worker、parent、child、feedback/retry/replacement。

工作内容：

- 将验收歧义检查前置到实施前；
- 提供简洁正例、负例和真实消费者示例；
- 验证 `replyTo` 澄清不改合同；
- 验证错误验收通过 blocked/新 Task 修正；
- 验证旧冻结产物复用和 parent 集成；
- 不添加新反馈字段、reviewer 链或消息系统。

退出条件：错误合同能够在大量实现前暴露并修正，不需要重新购买整棵子树。

### 阶段 5：建立验收编写与迁移评测

主要消费者：实验宿主、RSI comparison、后续 proposer。

工作内容：

- 增加正确/错误产物的离线验收编写 fixtures；
- 区分错误接受、错误拒绝、实现失败、合同失败和宿主失败；
- public 提升与 validation 不回退分开；
- 成本只看总量并单独报告；
- 不以同一 MXMM 的 token 下降代表通用能力。

退出条件：能够用有限实验区分框架引导、模型验收能力和真实迁移，而不是只报告整轮消耗。

### 阶段 6：完整验证与受限真实实验

先运行相关定向回归，再执行：

```bash
export PATH="/home/ROXY/.local/node-v24.9.0-linux-x64/bin:$PATH"
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm verify
```

要求 Node 24.9.0、pnpm 11.18.0，project/build/typecheck/lint/test 全通过，并执行真实领域预检。

只有上述检查全部通过，才另行确认真实模型实验的窗口、总预算和绝对 deadline。先做小规模对照，不直接重启 12 小时 campaign。新运行使用全新根和 IDs、独立 OS session、持久 stdout/stderr，不恢复旧执行根。

## 11. 必须保留的回归场景

1. root 冻结最终脚本，host 只按退出状态结算；
2. parent 编写的 child 验收在准入后冻结，child 不能修改；
3. fresh CAS-only 检查环境不包含 worker checkout/build；
4. 正确结果被接受，错误结果被拒绝；
5. 错误验收可通过 feedback/blocked/新 Task 修正；
6. 澄清回复不改变合同，blocked 不自动 retry；
7. probe 一次后由 parent 决定本地集成或新 probe；
8. required retry/replacement/winner/join 保持；
9. parent 实际消费 child 产物，不只消费 verdict；
10. root 验收失败不能被 child verified 覆盖；
11. candidate/baseline 公共环境一致、workspace/session 独立；
12. Method 新增能力实际 entry-reachable；
13. 无 source-specific 固定验收被当成通用 workflow 证据；
14. CAS、provider、会话、MCP 漂移和清理异常保留原始原因；
15. 不生成虚假 Evidence、闭合 fact、comparison 或 activation。

新增离线 fixtures 只用于测量验收编写能力，不在生产 admission 增加语义判定器。

## 12. Git 与提交策略

- 保留当前 HEAD 中已经验证的有效修复，不全盘 revert。
- 从当前 HEAD 新建重建分支；PR38/39 不再继续堆叠补丁，旧分支作为对照。
- 不按顺序合并当前 PR38 和分叉的 PR39。
- 每阶段形成小而非 126 文件的语义提交，并同步规范、测试和进度。
- 不用 checkpoint 提交掩盖设计摇摆；每次提交说明对应失败证据、删除内容和真实消费者。
- 净行数只作辅助信息，不能把删除测试或转移文件当作架构改善。

## 13. 完成定义

### 工程重建完成

- 上述协议和代码边界已落地；
- 动态 child 验收完整保留；
- 公共资源不再由 proposer 复制；
- 根脚本正误路径与全部 case 预检通过；
- 定向回归和根 `pnpm verify` 全通过；
- 进度明确列出未覆盖项。

### RSI 研究结论成立

必须另有完整真实 paired evaluation：

- base/candidate 都执行完计划内 cases；
- 验收可信度和真实消费者结果可比较；
- validation 完成且没有隐藏回退；
- 总成本完整报告；
- 有明确 improved/no-improvement/insufficient-evidence 结论。

工程重建完成不要求伪造一个正向 RSI 结果。若实验无改善，应诚实保留 no-improvement，并继续从具体失败链分析，而不是扩大门禁或 prompt。

## 14. 公开协议授权与实验边界

2026-11-08 用户已要求按本文实施，以下 1–4 已进入 amendment 027；第 5 项仍按阶段 6 在工程检查完成后固定。

1. **TemplateDraft**：删除 `requiredCriteria/requiredOutputs`，同时保留 `TaskProposal.acceptanceCriteria`，并统一 child 的简单 `result/` 交付。本轮已授权。
2. **公共资源**：公共领域 MCP 始终由 host 组合，Method 只携带自有增量。本轮已授权。
3. **模型可见视图**：把当前 deliverable、required criteria 和待消费结果持续放入精简的当前节点视图。本轮已授权，复用冻结合同，不新增摘要模型。
4. **兼容策略**：旧 Method 只归档、不为删除字段保留双格式输入。本轮已授权。
5. **真实实验**：窗口、预算、case 数和 deadline 另行确认，本次文档不授权新付费 campaign。

动态编写 child 验收、领域只提供根最终验收和可选工具、不恢复预制 workflow，是本文已经明确固定、不再反复询问的重建前提。
