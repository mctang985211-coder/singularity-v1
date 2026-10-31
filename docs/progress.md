# Singularity V1 进度

更新：2026-11-01。协议见 `docs/framework.md`，施工约束见 `AGENTS.md`。

用户已授权核实架构审计并联动修改规范、约束、源代码和测试，作为 amendment 006/007/008 纳入框架与 spec-lock。随后授权 deepseek-flash 真实全流程验证、prompt 优化及 PR/合并；amendment 009 澄清 probe 后续批次复用。接手时的 S4–S7 成果保留，没有重置工作区。

当前运行契约：一个进程拥有一个执行根；退出后仅归档，下一次使用新根和 IDs。操作者提前固定可信资产、干净 env、provider/profile、预算、deadline 与所需隔离。公开可信任务可使用进程内 verifier；私有数据或不可信代码须先部署现成 OS/容器/broker。harness 不 crash resume/reconcile，不以目录/HOME/loopback 声明代替隔离。

本轮已完成：

- SQLite events/metadata 替换手写 NDJSON/torn-tail；事务内强制 reducer guard，command 唯一约束，同进程唯一 writer、跨进程旧根写入拒绝、只读归档查询。CAS 与 fact 复用串行写队列，投影和解析缓存；保留一个事实来源，没有第二组可变 tasks/runs 表。
- 标准 JSON.parse、json-canonicalize、Ajv2020 替换手写 parser/动态 schema interpreter；普通有效 JSON hash 向量保持不变。取消额外的重复键/JS 对象拒绝承诺，安全整数继续由领域 schema 约束；协议 schema 无 transform/default/coercion 在构造门禁检查。
- 删除退出后 recovery/closed reconcile；保留已观察 live parent yield 的同进程续接、业务 fresh retry、反馈/replan/replacement、多批次。输入在打开 Run 前 exclusive create；父续接只挂载新 child 输出。
- Task、Summary、Proposer、precheck、资源读取、输出 stat/open 的宿主异常保留原始原因，结束原生生命周期后抛出；不生成虚假 invalid/拒绝/Evidence/闭合。source Run 失败也取消并等待其摘要。真正无效 receipt 和合作 verifier timeout 仍按业务协议分类。
- 共用 tree codec、唯一生产 worker card；epoch 使用原生 firstLiveSeq/replaceGeneration，wake 使用 deriveMessages，不扫描 compaction/inbox 日志。同步 receipt/usage 保留 7 行 raw 读取边界，删除自建 WeakMap snapshot 缓存；原生替代的实际接入成本见审计 §10。
- 删除 skill 注册后的 provider/source/content/path 完整性复验和 loader availability helper；固定 profile 只挂原生 registry/skill tool。删除 MCP HOME/TMP/XDG 管理与 loopback/query/fragment policy；HTTP 配置复用 Zod。Summary/Proposer 删除 native restriction 之外的重复 allow guard。
- 修复 verifier 未收到 operator 取消信号，以及 verifier/Agent 按 TimeoutError 名称吞上游异常；复用现有原生取消和子树关闭。删除规范中的 evaluation slot 重启找回要求。保留项均给出具体原生调用路径与额外状态/适配成本，取消“暂不能证明等价”例外。
- app 在 profile boot 前拒绝无效/耗尽/unknown/过期累计预算并 exclusive create 输出根；verifier identity 前移到 Run preflight。故障测试检查原始错误、无新模型修复请求、无虚假闭合、原生资源结束。

amendment 007 的 `PATH=/tmp/node249/bin:$PATH pnpm verify` **全部通过，431/431**：protocol 205、runtime 135、app 78、domain 13；project/build/typecheck/lint 全通过，0 fail、0 skipped。该轮完整日志：`artifacts/architecture-audit-20261101-amendment007-verify.log`。验证包括验收期间 operator 取消、Verifier/Agent 上游 TimeoutError、原生 epoch/wake/skill/Summary、HTTP/stdio MCP、预算取消、业务 retry/join/多批次与 Round 评测。删除的坏 registry 自检测试按 amendment 007 退休；amendment 006 的 432 项不是当前用例数。`git diff --check` 通过。

amendment 007 生产源码 67 文件、15,454 行；相对 amendment 006 的 15,696 行，本轮净减 242 行；相对接手基线 18,208 行净减 2,754 行。逐文件 hash 和统计见 `artifacts/architecture-audit-20261101-metrics.json`；不把行数差当死代码覆盖率。保留层的原生调用路径及额外 owner/状态/适配成本见审计 §10。

amendment 008 的删改与核验：

- CAS append 通用引用扫描已不存在；对象生产者 await putObject 后才提交引用，guard 及业务消费处保留实际读取的 digest/身份校验。缺失 Method 的事务拒绝与 CAS 独立读取者原子可见性有直接测试。原先 exclusive create 最终文件名只能保护 writer 队列，已改成完整临时文件 + 原生 link 发布；无新恢复状态机。
- 删除 protocol command projection/decision 和 service 内存索引；重试同 commandId 直接读 SQLite events，保持同 digest 返回原 fact、不同 digest 冲突、UNIQUE 防重复和事务 rollback。
- 相对路径集中到单一 schema；删除 workspace ancestor walker、手写目录递归和每项重复 lstat，使用原生 recursive readdir/Dirent、fd leaf 检查、实际 bytes 上限与 CAS hash。非法路径在 admission/模板 schema 边界拒绝。部署提供真实祖先路径边界，可信本地用例不证明私有数据隔离；未增加容器检测器或 fallback。
- MCP 删除 capability allowlist、manifest/config exact-key 与交叉限制、source subset 复验。可信 bundle 的消费字段用 Zod 解析；标准 transport 直接交原生 client，实际工具名/description/parameters 对比保留。stdio command/args/env 使用冻结配置，支持可信领域的非 Node 工具。RSI 生成代码的评测同样要求部署事先提供隔离，不把自动 precheck 视为代码信任审批。
- 删除 tools 的 exact-key helper 和已由 defineTool 校验的参数检查；保留动态业务引用/epoch/授权规则。admission 删除字段级 copy helper，复用 schema 的复制结果和最终 seal；acceptance 删除固定 draft 排序已保证的重复集合检查；reducer 共用 failed/invalid closure 与终态赋值。
- 库存运行 harness 移到 app 的 examples，领域依赖改为 devDependency，产品 src 只保留通用 DSH 组合。删除 publicConfig 的递归敏感字段名黑名单，使用标准 JSON 序列化和 Cordis 原生 get；参数 schema 中的 password/token 等普通字段名不再触发虚假宿主失败。公开 profile 不携带秘密值，凭据由原生 launchEnvironment 注入。新 README 和 PR 模板指向单一规范及当前证据，不恢复旧任务卡。
- resources/decompose 已按实际消费者拆分；run/retry 共用 validateHostRequest、executeSingleRun 与资源加载/驱动路径。保留业务 retry、祖先摘要及具名 reducer handler；不为估算行数引入通用状态机 DSL 或第二存储后端。

保留层的具体原生接入比较（固定 DSH alpha2）：

| 消费者 | 原生替代路径与本项目新增成本 | 当前选择 |
|---|---|---|
| 祖先摘要 | subagent.create 要求 ctx.agents.get(parent.id) 是 live parent；Task parent yield 时已 dispose。替换需保留 parent handle、额外 preset/catalog 与取消 owner。compaction.compactNow 改写 source surface；direct llm.stream 则新增 session/usage 生命周期。 | 已用 agents.create/followup/whenIdle/dispose，保留合同 digest 缓存与 source Task usage；无额外 live parent。 |
| receipt/usage 读取 | sessionQuery.readSession/observeSession 是 Promise，query-sqlite 的 openAt:'never' 可不建 FTS，但仍新增 query 服务、Context 接口及 async guard 链；同步 projection 另需 schema/fold/ready owner。 | 保留 7 行 snapshotEvents 入口，复用原生缓存；epoch/wake 已用 firstLiveSeq/replaceGeneration/deriveMessages。 |
| UsageRecord fold | 原生 tokenUsage 只给四个 token 桶，不给 steps/unknown/pending/failure；固定 cut 和归档仍须 fold。切换会保留 fold并新增 live registry 与 cut 桥接两条路径。 | 一个纯 fold 同时服务 live 和最终 cut，不加第二账本。自动 compaction 继续关闭。 |
| bundle 物化 | skills.register 接受正文/resourceBase，不消费 CAS Ref；filesystem skill provider 仍需 CAS→文件复制，并新增 frontmatter/provider discovery。MCP native stdio 同样需要 cwd/files。 | 普通 mkdir/writeFile 物化，注册/loader/MCP 生命周期交 DSH。 |
| 冻结 MCP surface | 以 native 动态 surface 重新生成 Composition 需 intake 时额外建 Agent/连 server/dispose，或跨阶段转交 live handle owner。 | 同一已挂载 native surface 对比一次冻结身份，无第二 client。 |
| 事实/CAS/验收 | DSH session persistence 不能替代领域事务/条件提交。放入 session 仍需 schema/reducer/receipt/hash，另加 root session owner/flush。 | SQLite events + 单一业务 guard、Node 原生 FS 原子发布。小 JSON 再放 objects 表会新增按体积分流及双读写后端，不能减少现有大文件 FS 路径，因此不添加。 |
| 业务 retry/状态机 | DSH Agent loop 不提供 Task required binding、replacement winner、固定合同的新 attempt、paired Round。表驱动通用 DSL 仍要表达这些跨对象 guard，新增解释层。 | 保留实际业务规则与具名 handler，共用重复 closure/入口；没有 crash retry/reconcile。 |

amendment 008 最终 `pnpm install --frozen-lockfile`、`pnpm verify` 全通过：**428/428**（protocol 202、runtime 134、app 79、domain 13），0 fail、0 skipped；project/build/typecheck/lint 均通过，`git diff --cached --check` 通过。日志：`artifacts/architecture-audit-20261101-amendment008-final-verify.log`。CAS 独立读者原子可见性、缺失 CAS consumer 的事务拒绝、公开 schema 字段的 Composition 序列化均有直接回归测试。待发布文本检查未发现私钥/token 签名，artifacts/环境文件未进入暂存区；该检查不冒充通用秘密检测器。

amendment 008 完成时生产 src 为 65 文件、14,507 行，相对 amendment 007 净减 947 行，相对最初接手净减 3,701 行；其中库存 harness 294 行移到 examples，并非删除用例。逐文件统计见 amendment008-metrics artifact，不把净行数当行为覆盖率。

本次真实验证见 [validation-20261101.md](validation-20261101.md)。已完成从空 Method 建库、三级 Task 树、两批 probe 探索、祖先摘要、原生 skill/MCP、paired evaluation、连续赢家激活与发布后任务。432/432 本地门禁通过（protocol 203、runtime 134、app 82、domain 13）；真实失败和源码快照分开归档。runtime 修正已观察的空字段序列化、probe winner/replacement 和提示描述；RSI 工具直接使用 Zod JSON Schema 并删除手写形状转换器。产品/领域 src 净减 13 行，没有新增恢复层、状态或生产依赖。

S4–S7 的框架实现已完成，C-01–24 均有对应协议测试或原生 DSH fixture。下表区分本次真实证据、历史冻结版本及部署缺口；验证域中的真实 activation 不代表外部生产部署或复杂芯片任务收益。

DSH 平台原生 wake/resume 能力的 fixture 不代表 Singularity 支持退出后恢复；框架执行根拒绝重启，父 Run 续接仅限同一活跃进程。

Node SQLite 的 ExperimentalWarning 是固定宿主已知限制。真实隐藏数据隔离部署未交付；当前公开库存场景不证明该能力。

| 场景 | 实现位置 | 现有证据与缺口 |
|---|---|---|
| C-01 root 冻结 | protocol/admission、runtime/run | A–J 真实合同／CAS；冻结负例为协议测试 |
| C-02 submit／独立 receipt | workspace、verification、inventory | A–J 真实独立领域逻辑与 host 分类；公开可信进程内 adapter 已覆盖；私有部署/强停隔离未交付 |
| C-03 no-submission／fresh retry | retry、run-settlement | 早期 live no-submission；J 真实 child retry；新 workspace 与拒用旧 verdict 有 fixture |
| C-04 prepare／ack | decompose*、receipts | A–J 真实 prepare/commit；缺 ack／截断／epoch 负例有 fixture |
| C-05 固定绑定 | protocol/admission、tools | 真实沿绑定执行；拒绝模型绑定由协议／DSH fixture 证明 |
| C-06 required join／parent 验收 | children、task-pool | E–J 真实逐层独立验收；required winner/replacement 有 fixture |
| C-07 后续 direct batch | task-pool、wake | 本次 exploration-1 空 Method root 完成两批同 binding probe，父节点读取结果并自行汇总；required/probe/失败 probe 的显式输出传递有原生 fixture |
| C-08 递归／局部规划 | planning、decompose、task-pool | 本次 guided-1 真实 root→region→warehouse，34 Task verified；16 次成功 [0,1,2] sketch，26 次 [0,1] |
| C-09 空 Method／draft | global-resources、exploration、workspace | 本次 empty-2/exploration-2/3 从空 Method 建库并激活；exploration-3 新 skill 注册/绑定、评测与发布后原生消费已实跑；MCP 目录只有说明稿，可执行 MCP 演化链有完整原生 fixture |
| C-10 原生取消后 closure | cancellation、task-pool | 本次 request-boundary-1 只买 3 次请求后原生取消，subtree closure、最终 usage、无虚假 Evidence/RSI；fixture 验证保留已 terminal Evidence |
| C-11 事务 guard／幂等／归档 | store、service | 当前 SQLite rollback、UNIQUE、并发命令、缓存投影、CAS 负例和归档读取测试；旧 NDJSON replay 仅为历史证据 |
| C-12 live yield 续接／拒绝重启 | run、task-pool、store | 当前 DSH 多批次/replacement/retry；子进程退出后拒绝旧根 writer，底层 CAS 也拒绝，fresh root 可用；无 crash resume |
| C-13 capsule／隐藏读取边界 | workspace、视图授权 | fresh capsule 与 opaque/private CAS 拒读有 fixture；真实隐藏数据的进程／broker 读取隔离未交付；须在部署前建立 |
| C-14 sealed proposer／validation 拒读 | trace、proposer | 本次独立真实 proposer 消费封存轨迹；隐藏 refs、上一轮 slots/cases 拒读有 fixture；不是 OS 隔离证据 |
| C-15 patch 权限 | method-patch schema/precheck | 真实 accepted/rejected patch；task/verifier/scorer 编辑拒绝由协议负例证明 |
| C-16 MCP manifest／scope 调用 | mcp-resources、agent-mcp | 本次 guided-1 有 9 次真实原生库存 MCP 调用；stdio／streamable-http 与冻结 surface 对比有 fixture；不证明不可信代码部署隔离 |
| C-17 paired 独立 capsule | evaluation-case、evaluation | H–J 真实双 arm 多 case 普通 Task 与独立 workspace；同一非 Method case 的一致性有 fixture |
| C-18 invalid 不作零分 | evaluation、acceptance | A–G 真实 insufficient closure；slot 缺失／invalid 对比较器的限制有 fixture |
| C-19 expected-head activation | round、method-round | 本次 empty-2、guided-1、exploration-2/3 实际激活评测赢家，expectedPrevious 链及发布后 verified；初始化不计赢家 |
| C-20 体积／百分比／分页 | prompt、node-view、tools | 真实百分比／分页读；固定体积边界有 fixture，未证明任意规模历史 |
| C-21 direct feedback | task-feedback、run-settlement | G 真实 scheduler feedback；J 真实 worker feedback；只到 direct parent 有 fixture |
| C-22 replan／replacement | decompose-commit、reducer | G 真实失败 child→feedback→replacement；旧 Evidence 保留与 winner 规则有 fixture |
| C-23 连续 Round／CAS | round、proposer | 本次 guided-1 三轮沿前轮新 head 执行；empty-2 拒绝后实际读前轮反馈并成功改进；stale activation 拒绝有 fixture |
| C-24 validation 回退拒绝 | evaluation、domain comparator | evaluation fixture／纯比较测试；真实 H–J 没有触发 validation 回退 |

以下保留 A–J 历史证据入口，未在本轮重跑。H 两轮正确率目标均已饱和、no-improvement；I/J 在精确正确约束下的全子树 token 目标真实 improved，不能推成任意复杂任务的改进或生产升级。J 真实 child 失败后 retry 是保留业务 retry 的直接消费者。

| 真实尝试 | 结果与证据 |
|---|---|
| `artifacts/inventory-20261031-a` | 9 请求、93,821 tokens；PlanningSketch 字段展示不足导致反复纠错并耗尽 root 80k cap，已展开真实 DSH schema。partial trace `sha256:e73cebb5c6e08a89003ea3a241ddb3d983875328c48cde0736fb6ae359e20b50`；result/journal/CAS/原生 session log 均保留 |
| `artifacts/inventory-20261031-b` | 16 请求、163,722 tokens；empty Method 已 prepare/commit probe child、parent yield、maxActive=1 自动独立 child。child 尚未 submit，探索查询与长工具输出耗尽 root 160k cap。原生取消后单 cut `sha256:8fbd3390b48740f3593aaff7b0ab5c0ee9a6e73dc6c8e30a9ed7f813cee639be`，partial trace `sha256:b1c861cea66be56b717f4da70e0e8100d91f6f2eb49b6f0772fec0bc8a42d21b`，2 session 最终 usage/cut 可核对 |
| `artifacts/inventory-20261031-c` | 18 请求、179,059 tokens；required child verified，parent 自动 wake/read result 后耗尽 root 160k/12 steps。partial trace `sha256:edd685ffccbef50af2501303d10cd83fbc2d6e9081baab30899a7dda64fa25f7`；replay 11 facts、root failed/child verified |
| `artifacts/inventory-20261031-d` | 22 请求、243,509 tokens；child verified，parent 整合前跨 root 240k cap。partial trace `sha256:21d8b0032ff4fd0546d90bd8ced7817a60a7f55314334e949562ef83983900d5`；replay 保留真实结果 |
| `artifacts/inventory-20261031-e` | source 27 请求、395,287 tokens；maxActive=1 下 required child 与 parent 均独立 verified，自动 yield/wake、读取 frozen report 后整合。root Evidence `sha256:75b6b2bb80bab4dc44ec6f88f324cb94719e91eac3553cfa3057070883f2a0b5`，child Evidence `sha256:8a9e8629a9044b58864809ff81336dbc5c4482c7a202c7e4ed2a6f7d4974998b`，sealed trace `sha256:efac89cb158ddaad5ffd2aa06df8a6f1bc45c8c18c34ceb890d9a33bec9ce0b9`。独立 proposer 11 请求、218,006 tokens 后跨 192k 本地 cap，未交 patch；Round 诚实关闭 `insufficient-evidence/proposer-budget-exhausted`，未进入 paired evaluation。`replay.json` 重建 15 facts 与双验收；`credential-scan.json` 72 文件扫描 clean |
| `artifacts/inventory-20261031-f` | 展开 decompose schema 后 source 19 请求、201,788 tokens，父子 verified；proposer 10 请求、211,570 tokens，在 4096 单请求输出上限被原生 `max-tokens` 截断，Round `insufficient-evidence/no-proposal`。source trace `sha256:c955ae9bd838c72628ea04945f08f499ae758b1955be1497a0ad4d95aa37b179`；replay 15 facts。累计 132 请求／1,706,762 tokens，unknown=0；已将实际输出 cap 接入可调配置，未追加生命周期补偿 |
| `artifacts/inventory-20261031-g` | 同一 journal 两连续 Round，source 均 verified；第二棵树首 child 因 totals 写成 object 而独立验收失败，parent feedback/replan 后 replacement child 与 root verified；5 个普通 Task 为 4 verified／1 failed，全部 terminal，非三级树。两个独立 proposer 均真实提交 patch，单次输出达 23,353 tokens；第一轮 precheck 被旧 SKILL.md frontmatter 禁令拒绝，第二轮因 Skill.name 非 DSH kebab-case 拒绝，均未开始 evaluation。35 facts，累计 204 请求／2,917,830 tokens，unknown=0；`source-traces.json`、`replay.json`、`credential-scan.json`（145 文件 clean）保留。已移除该非规范禁令；Method 元数据仍是权威，frontmatter 仅为冻结文本，不赋予权限 |
| `artifacts/inventory-20261031-h` | 同一 journal 两个连续 Round：各 verified source → 独立真实 proposer → patch/precheck accepted → 原子 candidate → 三 case 两 arm 普通 Task → 独立 comparison → no-improvement closure。28 个 Task 全部 verified（14 root＋14 required child）、十二 slot 完整，无 missing/invalid；两个 Round 所有 case 正确率 baseline=candidate=1、delta=0，不 activation。第一轮 reported tokens baseline881,553／candidate823,450，第二轮901,470／818,842；成本下降不是本轮正确率目标的提升，且旧进程未消费冻结脚本，不归因为脚本效果。comparison digests `sha256:921d268b0d5f17b884445fcff3e507b302fe6f30bea9c310e14ad53602124d65`、`sha256:94746624e1b5ad44db48e3583d0490aeeb7d88f98f841a1738063a69cb11b180`。`replay.json` 重建152 facts、28 terminal Task、两次 closure 与原 productionHead；`source-traces.json`、两份 `round-*.json` 和 `credential-scan.json`（457文件 clean）保留。H新增303已结算模型步骤／4,384,897 tokens；累计507步骤／7,302,727，unknown=0。 |
| `artifacts/inventory-20261031-i` | 两个完整真实 Round，三 case 两 arm、全部精确正确；baseline 总 tokens 1,696,491／2,291,377，candidate 316,661／213,353，分别下降 81.3%／90.7%，worstRegression=0、complete=true，均 improved。RSI 根据源 usage 识别四节点重复计算并改写 entry、删除两个冗余模板；第二轮原生记录确认读取 previous-round 并在 hypothesis 引用首轮实测结果。38 Task 全 verified，三级树；194 facts replay 与原 head 一致，620 文件凭据扫描 clean。comparison digests `sha256:ece965f660a561dc6e290162341b920d7068364fe0154a85c8ac35babe02614a`、`sha256:270ac235b4914cf51cc9e70676d332142469beb3308c1367aa5a19217b60135e`；`mechanism-evidence.json` 保存深度、成功/拒绝 sketch、公开读取与 hypotheses。改进是小任务完整子树执行成本，不含发现 Method 的 proposer 成本，不代表复杂任务收益或生产 activation。 |
| `artifacts/inventory-20261031-j` | 2026-10-31 冻结版本的一个完整真实 Round，单 CSV 场景三 case 两 arm 全部精确正确，baseline 1,424,817／candidate 324,046 tokens，下降 77.3%，worstRegression=0、complete=true、improved。11 Task 最终 verified；一个 baseline child 因漏算失败后 retry 成功，该成本完整计入。65 facts replay、原 head 与初始化唯一 activation 一致；`source-hashes.json` 与 2026-10-31 冻结源码相符，`mechanism-evidence.json` 记录 16 次成功 [0,1]／4 次拒绝 [0]，不声称消除模型参数错误。comparison `sha256:9644ed6205e4fe7d0e88a798c8934b0bba3dc926cf9ed01d9aeb586223a82b3c`；凭据扫描 clean。新增 142 请求／2,332,305 tokens，沿 I 的窗口和账本续接。 |

I/J 最终累计 1068 请求边界／1067 已结算步骤／15,707,337 reported tokens，unknown=0；head 仅有初始化，不把它算生产 candidate activation。I 两轮都相对同一 base；第二轮读前轮反馈，不证明生产 Method 连续升级。收益不含发现 Method 的 proposer 成本。

以上 A–J 历史轨迹没有祖先查询/Summary Worker、领域 MCP 或 MCP 资产演化证据；H 的 skill 调用来自旧适配。本次已补齐祖先查询、Summary、原生 skill/MCP、三层 sketch 和新 skill 正式演化；MCP 目录只生成说明稿，可执行 MCP 演化由原生 fixture 证明。当前 profile 关闭自动 compaction；独立 compaction 请求的 usage 未计入，不能直接开启并声称预算完整。

后续领域工作包括芯片适配、真实私有部署与 MCP 可执行资产演化；不为制造计数添加恢复机制或无用工具。验证入口仍为根 `pnpm verify`；有界真实模型入口及配置见 README，前次计量只用于新执行根的累计预算，不续跑旧事实或会话。
