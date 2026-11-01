# Singularity V1 进度

更新：2026-11-02。协议见 `docs/framework.md`，施工约束见 `AGENTS.md`。

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
| UsageRecord fold | 原生 tokenUsage 只给四个 token 桶，不给 steps/unknown/pending/failure；固定 cut 和归档仍须 fold。切换会保留 fold并新增 live registry 与 cut 桥接两条路径。 | 一个纯 fold 同时服务 live 和最终 cut，不加第二账本。inventory 当时关闭自动 compaction；Buckyball 后续已接入原生 compaction 计量，见下文。 |
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
| C-08 递归／局部规划 | planning、decompose、task-pool | guided-1 真实 root→region→warehouse，34 Task verified；16 次成功 [0,1,2] sketch，26 次 [0,1]。该 Method 已指定 required 层级，证明递归执行，不证明空 Method 在复杂领域自主发现多层 workflow；BB 浅层失败与引导修订见下文 |
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

以上 A–J 历史轨迹没有祖先查询/Summary Worker、领域 MCP 或 MCP 资产演化证据；H 的 skill 调用来自旧适配。本次已补齐祖先查询、Summary、原生 skill/MCP、三层 sketch 和新 skill 正式演化；MCP 目录只生成说明稿，可执行 MCP 演化由原生 fixture 证明。这些 inventory profile 当时关闭自动 compaction；Buckyball 后续已通过原生 llm/stream 计量与 compaction/summary fold 覆盖辅助请求，再开启长任务压缩，见下文。

后续领域工作包括芯片适配、真实私有部署与 MCP 可执行资产演化；不为制造计数添加恢复机制或无用工具。验证入口仍为根 `pnpm verify`；有界真实模型入口及配置见 README，前次计量只用于新执行根的累计预算，不续跑旧事实或会话。

### Buckyball / CosyVoice3 前端准备（2026-11-01）

用户将真实项目范围明确为芯片 frontend，排除所有全芯片仿真、P2E 和物理后端。[准备说明](buckyball-cosyvoice3-frontend.md) 固定源码/checkpoint、空 Method 资源视图、根任务五项验收和较高的节点限制；示例 TaskSpec 工厂与预算只在 examples，不向 runtime 添加芯片逻辑。每轮累计上限为 3 小时 / 4 亿 tokens / 4000 请求，单 Run 与 proposer 均为 4096 步、树深 8、256 Task、单批 8 child。proposer/评测也显式使用高额度并受整轮累计预算和剩余 deadline 约束，不沿用 inventory 的低默认值。

已创建独立源码副本并保留原仓库已有修改，下载固定公开模型资产并核对 6 个大文件与官方 SHA-256；现有 bbdev 原生配置安装成功，裁剪的 FastMCP stdio surface 为 9 tools / 4620 bytes，真实 `validate(toy)` 返回 passed。VCS `-full64 -ID` 与 DC `-version`、license 状态读取完成。官方 CosyVoice3 CPU 原始软件推理完成单输入 smoke，生成 24kHz / 21120 样本的有限 FP32 音频，未声称听感、额外文本规范化或数值等价。这些是启动环境证据，不能升级为 RTL/芯片验收。原始文件位于本地忽略目录 `artifacts/buckyball-cosyvoice3-20261101/`。

准备时因上游 bbdev MCP 路径固定，曾选择模型通过原生 shell 调用 CLI；该决定遗漏环境激活，已由下文 amendment 010 的标准领域 MCP 替换。TaskSpec/TaskLimits schema 检查通过；使用已验证的官方 Node 24.9.0 完成根 `pnpm verify`，432/432、0 fail/skip。Buckyball Nix Node 24.18.0 的 DSH 原生 addon 启动失败日志保留，未添加产品兼容分支。

此准备阶段尚未启动付费模型 campaign。后续独立 verifier、冻结 case、原生 compaction 计量与首次实跑见下文；环境准备不作为芯片 Evidence、comparison 或 activation。


### Buckyball 自主实跑接入（2026-11-01）

用户授权按 Buckyball skill 实施领域验收、自主选择 PPA 权重，并在启动确认后结束人工操作。新增 example campaign 与独立 review：读取冻结 CAS 输出、独立 checkout/patch 与真实组件工具复跑；这是模型领域审查及工具证据，不宣称形式化签核。PPA 用功耗/延迟/面积 0.30/0.40/0.30 加权几何改进，功能全通过、条件相同、均值至少 1% 改善且无 case 回退才发布。LLM prefill、Flow streaming 与 HiFT 边界为冻结 workload 定义，不预设求解树。

原生 llm/stream 统一计量覆盖普通、Summary/review/proposer、compaction 与辅助请求；既有 usage fold 增加带 llmStreamCall 的原生 compaction/summary，模型无关摘要不计请求。本实验原生压缩启用，输出 cap 40k、75% 压力。DSH 原生 bash/jobs 承担长编译等待与生命周期，没有芯片 runtime 分支或新恢复管理器。实际启动时间、PID、绝对 deadline 和消费以 execution root 的 launch.json / requests.jsonl 为准。

本次最终 `pnpm verify` 全通过：435/435（protocol 203、runtime 134、domain 13、app 85），0 fail/skip；含新增三个原生/领域 fixture。日志 `artifacts/buckyball-cosyvoice3-20261101/campaign-verify.log`。fixture 证明计量、准入、独立审查接线、真实失败保留和比较拒绝；不提升为芯片实现或 PPA 成果。


### 首次芯片实跑诊断与 amendment 010（2026-11-01）

归档 `artifacts/buckyball-cosyvoice3-live-20261101-1502/execution` 的真实运行在北京时间 15:02:14.806—15:04:52.594 共 157.788 秒内产生 21 次请求、746746 reported tokens，随后退出。只留下 method registered/activated、root admitted/opened 四条事实；没有 child admission、芯片提交、验收或 RSI。模型自主浏览了仓库并复制 baseline；直接运行 bbdev 找不到命令，后台 mill 探测被原生 teardown 停止，均不能算构建通过。

commit 的原始 6363 字符参数缺少 children 数组的闭合 `]`；该次输出 2170 tokens，未触达 40k 上限。DSH pi-ai adapter 在工具调度前将其记为 `MALFORMED_RESPONSE` / assistant/attempt，没有 commit tool/call。这是已完成参数的错误分类：原生 dsh-tools 已有 JSON.parse → INVALID_ARGS → tool/result(isError) → 下一步纠正的路径，adapter 提前退出使其不可达。锁定的 alpha2 pnpm patch 仅转交原始畸形参数并保留 finish/usage；没有 JSON 修复器、文字匹配、request 重试、恢复会话或新状态。更换 adapter/升级依赖时须跑原始参数回归，再决定移除补丁。

参数格式呈现由一个共享的 finalizeContent 包装处理，保留原生错误内容并追加 failed、完整极简用例和下一动作，复用于六个 Task 工具、RSI、Summary 与领域 review。大用例只在失败或按需协议资源中读取，system card 不扩充；已有 12 KiB 工具上限保留，重复描述已精简。

bbdev 现在作为标准冻结 ToolAsset 进入公共 exploration catalog，空 Method 的 Run 和独立 reviewer 均通过 DSH 原生 MCP client 调用。领域 example 仅把 project/argv 转交项目内 `nix develop --command bash`，操作者预装依赖/配置；runtime 没有 Nix 或芯片业务代码。独立新副本的真实 MCP/Nix/CLI help smoke exit=0，激活日志中的 bbdev 路径指向该副本。证据：`artifacts/buckyball-cosyvoice3-20261101/native-tool-smoke/{probe.py,result.json,probe.log}`。这不是编译、仿真或 PPA 成果。

此前测试的缺口有两个：JSON.stringify 构造的工具参数永远语法完整；领域 fixture 不走 bbdev，因此握手与纯协议成功掩盖了环境缺失。当前新增本地 SSE → 真实 pi-ai adapter → 原生 loop/tool 的畸形参数测试；六个 Task 工具失败后，在同一 Run 修正 decompose，只有一次 child admission。RSI、Summary、独立 review 同样先失败后纠正；保留长度终止不执行工具、宿主/provider 失败不重购请求的测试。campaign fixture 实际调用冻结 MCP，以 fake nix 精确核对 cwd/argv（含 shell 字面字符），与上述真实 Nix smoke 分别记录，不混淆证据等级。

此次没有启动或续跑付费 campaign，原归档保持不变；芯片设计、frontend 验收和 PPA 赢家仍未获得。

最终 `pnpm install --frozen-lockfile`、根 `pnpm verify` 均通过：**438/438**（protocol 203、runtime 134、domain 13、app 88），0 fail/skip；project/build/typecheck/lint 全部通过。日志：`artifacts/native-tool-arguments-verify.log`；定向 8/8 日志：`artifacts/native-tool-arguments-targeted.log`。


## 2026-11-02：BB 阻塞定位与重跑前预检

上一轮 `buckyball-cosyvoice3-live-20261101-213725` 在 source 提交后卡在 review 的 config install；3 小时截止时共 182 次请求、32,302,520 reported tokens，没有完成验收/RSI。独立重现证明候选 cosy 配置缺少 `[main_tile]`，config queue handler 抛 `ValueError` 而未写 failure；CLI 因此等待原有 24 小时轮询。review 手工 clone 也丢失 `.venv`/子模块准备资产。此前 help smoke 和 fake nix fixture 没有证明真实队列终态。

领域 example 增加标准 `checkout(project)`，原生 cp 复制操作者准备副本并安装本地 configs；worker/reviewer 使用同一工具。bbdev 领域补丁只修实际故障：config 异常沿现有 failure 结果返回，TOML 库失败不退出 worker，SIGTERM 进入已有 finally。补丁见 `apps/singularity/examples/buckyball-bbdev.patch`，准备副本的 bbdev 为 `a9bd1cb4c4b9948b29ac6323b63a450fbfbb1d4a`，Buckyball 为 `7510fbaa6c4d8dc435b9b39e645055fe415bed09`；原用户仓库和旧 trace 未修改。新 `.venv` 使用 uv relocatable，复制后实际从各自副本加载。Singularity 未添加恢复状态、watchdog 或领域进程管理器；仅压缩 Task 工具描述以遵守原 prompt 预算。app 在 source 结算后检查整轮预算，截止即结束，不再尝试为预算终止 source 打开 RSI。

真实 DSH MCP 预检（无模型请求）：全部两个工具实际调用；19 个 CLI/帮助入口成功；上一轮原始坏配置和缺失 TOML 都约 10 秒返回失败，移除后 config 安装成功；AXIS arbiter 完成真实 elaboration、VCS 编译和 UVM，`UVM_ERROR=0`、`UVM_FATAL=0`；长服务调用在 25 秒被原生 AbortSignal 取消，8 秒后该副本 bbdev/iii/motia 残留进程为零。未运行全芯片仿真、P2E 或物理后端；没有把组件 smoke 视为 CosyVoice3/PPA 验收。

原始预检脚本、逐调用结果和原生 session 保存在 `artifacts/buckyball-cosyvoice3-20261102/`，目录 `mcp-preflight`、`mcp-preflight-business`、`mcp-preflight-cancel`、`mcp-preflight-native-cancel` 分别保留帮助/初次断言失败、组件业务、原始配置复现和真实取消证据；脚本中错误的预期断言和固定端口占用已分别记录并用实际复现/动态空闲端口重新核实，不把失败预检计作通过。根 `pnpm verify` 439/439（protocol 203、runtime 134、app 89、domain 13），0 fail/skip；新增 fixture 同时检查独立依赖复制、已有目录拒绝合并、CLI 失败与原生取消；fixture 与真实预检分别报告。

### BB 浅层分解实跑与 workflow 引导修订（2026-11-02，amendment 011）

用户要求停止 `artifacts/buckyball-cosyvoice3-live-20261102-010855` 并修改后用新根重开。操作者在北京时间 02:35:27 停止该进程及其工作子进程，旧根保留归档；最后计量 442 次已结算请求、51,227,888 reported tokens、unknown=0。该轮只有 root→LLM/Flow/HiFT 一层分解；root 没有提交、没有 root 验收或 RSI 结果。三个探索 child 的 criteria 均为空，其 `verified` 不代表芯片前端验收通过。

原生 session 证明三个 child 都有 fallback、剩余深度 7，规划后 `canDecompose=true`，没有调用过 decompose。三个节点均在读取 skill/源码前只提交一次初始规划，以串行、紧耦合或无并行收益为由直接承接 reference→kernels→numerics→workload→mapping 长链；root 还自行写入了较短的 child 时间要求。实际卡片只写 when useful、无 useful child 时直接工作，没有讲清职责分解与并行的区别。旧 guided inventory 层级由 Method 的 required bindings/guidance 指定，不升级为空 Method 自主发现层级的证据。

现有 worker card、exploration guidance、Task 协议资源、BB guide/TaskSpec 与框架 §6.3/§7/§13 同步为：资源探索后细化初始草图；长链按职责、产物与检查边界组织直属 workflow；串行阶段用后续批次；每层承担有界本地技术工作与集成；叶目标为有界可直接验证单元。没有增加状态、语义复杂度校验器、树深/child 数门禁或预置芯片分解树。worker+exploration card 共 1918 bytes，保持 2 KiB 原上限。实际自主递归和芯片实现收益仍需新轮次证明，不以文本或 fixture 通过替代实跑。

本次最终根 `pnpm verify` 全通过：439/439（protocol 203、runtime 134、app 89、domain 13），0 fail、0 skipped，project/build/typecheck/lint 通过；原生 fixture 的 prompt/tool surface 上限与递归执行保持通过。日志 `artifacts/workflow-guidance-20261102-final-verify.log`；没有为文本改动增加实现镜像测试。


### BB 同批 probe 实例修复（2026-11-02，amendment 012）

`artifacts/buckyball-cosyvoice3-live-20261102-025241` 的 root 自主提出 reference、芯片拓扑、HiFT IP、model recipe 四路分解，但同一 fallback binding 被 admission 的重复 binding 检查拒绝；root 随后只创建一个 reference child，自行承担剩余长链。prompt 修订未解决此真实协议限制，旧测试也错误要求拒绝同批多个 probe。停止时计量为 252 次已结算请求、35,513,418 reported tokens、unknown=1（操作者取消了进行中的请求）；未得到完整 root 验收或 RSI 结果，组件软件检查与 RTL elaboration 不升级为芯片成功。旧根保留归档，后代进程已停止。

修订 admission/reducer：required 仍每批一实例；probe 可同批多实例并共用已交付 preview。runtime 的稳定 Task ID 加入数组 index，命令重放保持原实例与单事实，没有新模型字段、状态或恢复 helper。回归覆盖重复 required/Task ID 拒绝、同 probe 多实例预算与幂等，以及原生 DSH 的单槽逐 child 执行、整批 terminal 唤醒和 parent 集成验收。完整验证与新轮次结果随后以实际记录补充。

本次根 `pnpm verify` 443/443（protocol 205、runtime 135、app 90、domain 13），0 fail/skip；project/build/typecheck/lint 通过。日志 `artifacts/probe-batch-20261102-verify.log`，原生两子任务单槽回归见 `artifacts/probe-batch-native-20261102.log`。尚不以 fixture 代表新 BB 实跑成功。


### 探索 child 的本地目标验收（amendment 013）

实跑中 fallback 的 requiredCriteria 为空，导致 child 正常提交后可获得空 criteria 的 verified，这只能证明协议退出，不能证明完成局部目标。固定 explore-child 现继承 required `task-goal`，领域 verifier 根据冻结 goal/deliverable/scope/constraints 检查实际输出；BB reviewer 同步说明。localCriteria 保持指导用途。协议回归同时检查空 receipt invalid、目标未完成 failed 和完成 verified；原生三级探索回归检查 child/grandchild 实际继承同一标准。无新工具、字段、状态或 runtime 语义判定器。

本次根 `pnpm verify` 444/444（protocol 206、runtime 135、app 90、domain 13），project/build/typecheck/lint 通过，0 fail/skip；日志 `artifacts/explore-goal-20261102-verify.log`。该检查验证当前协议与原生接线，不替代新 BB 轮次的目标验收。


### 领域依赖前置准备与真实 MCP 复测（2026-11-02）

准备副本预编译 LLVM/MLIR 与 toy compiler 成功。领域 bbdev 的 build_llvm 支持操作者明确提供的 `BUCKYBALL_LLVM_BUILD`；MCP 传入准备副本路径。LLVM build 移至准备目录并在基线保留 symlink，原生 cp 复制引用；芯片专用 compiler、RTL、验证产物仍各自构建。没有将安装、恢复或进程管理放回 runtime。固定 Buckyball `974e7e6d`、bbdev `d0795ad`、verify `636e311`，源码补丁随 examples 提供，原用户 BB 仓库未改。

真实原生 DSH MCP 复测：checkout 15.820 秒成功；新副本 compiler build 273.646 秒成功，零 LLVM rebuild；前次 libnovas 的缺失依赖被精确复现为 libz.so.1，verify Nix shell 声明 zlib rpath。带 VERDI_HOME 的 AXIS arbiter VCS/UVM 43.808 秒成功，UVM_ERROR/UVM_FATAL 均 0，libnovas 动态依赖解析成功。首次 UVM 预检遗漏操作者 EDA PATH，实际报 vcs-not-found，按指南补齐后重测；未为此增加产品探测或 fallback。证据 `artifacts/buckyball-cosyvoice3-20261102/{compiler-preparation.log,mcp-preflight-toolchain,mcp-preflight-verdi,toolchain-readiness.json}`，0 模型请求；不作为 CosyVoice3/PPA 验收。

最终根 `pnpm verify` 444/444，project/build/typecheck/lint 全通过、0 fail/skip；日志 `artifacts/goal-toolchain-final-20261102-verify.log`。原生 MCP fixture 同时检查工具链路径从领域 MCP 传入。全流程实跑及 PR/合并仍以实际结果为条件。


### 当前 BB 重开（2026-11-02 04:08:09 +08）

修复代码 `a96b48f` 从新根 `artifacts/buckyball-cosyvoice3-live-20261102-040756` 启动，PID 1162439，绝对截止 07:08:09 +08。保持整轮 3 小时、4 亿 reported tokens、4000 请求、单 Run 4096 步、depth 8、256 Task、batch 8、maxActive 2；模型 deepseek-flash/max/40k 输出，原生 compaction。启动阶段模型请求与 MCP setup 正常。操作者按半小时巡检实际树、产物、验收、RSI 与计量；未取得全流程证据前不提交 PR 或合并。


### 固定探索交付出口（2026-11-02，amendment 014）

04:08 轮于 05:43 停止并保留归档，原因是探索 child 省略 localOutputs 后没有普通产物出口；其文件路径提交被正确拒绝，空 outputIds 提交却没有把实际研究文件带给 verifier/parent。一个 reviewer 越过 frozen outputs 读取 worker 文件，故该条 verified 不作为独立冻结交付证据。最终 897 次已结算请求，input 91,525,462 / output 1,126,059，unknown=1（操作者取消）；四层树、自主多实例 probe、fresh retry、真实失败验收等已发生，但没有 root 验收、RSI 或 PPA 赢家。所有所属进程已退出（主 PID 仅剩已退出 zombie）。

平台 explore-child 静态增加 required result/ tree；指导与预填示例明确 output ID result，localOutputs 仍仅追加 supporting，不改变 root 输出。未增加动态合同修改、输出恢复或新 guard。协议回归覆盖 omitted/empty localOutputs 与 result 不可覆盖；原生三级 fixture 真正冻结 tree 文件并逐层消费。BB guide/reviewer 同步，部署并发改为 4（整轮时间/tokens/请求不变）。根 pnpm verify 全通过：444/444（protocol 206、runtime 135、app 90、domain 13），project/build/typecheck/lint 通过、0 fail/skip。日志 artifacts/explore-result-20261102-verify.log。新的 BB 全流程证据仍待实跑。


### 当前 BB 实跑（2026-11-02 05:48:38 +08）

以提交 a30b254 从新根 artifacts/buckyball-cosyvoice3-live-20261102-0552 启动，PID 1280450，绝对截止 08:48:38 +08。maxActive=4，空 Method、独立 checkout、固定 result/ 输出及 task-goal 验收；其余总预算与模型参数不变。原生启动和模型请求正常，按半小时巡检。启动本身不构成 root 验收或 RSI/PPA 赢家证据，尚未提交 PR/合并。
