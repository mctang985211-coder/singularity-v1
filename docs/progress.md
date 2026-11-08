# Singularity V1 进度

更新：2026-11-07。协议见 `docs/framework.md`，施工约束见 `AGENTS.md`。

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

领域 example 增加标准 `checkout(project)`，原生 cp 复制操作者准备副本并安装本地 configs；worker/reviewer 使用同一工具。bbdev 领域补丁只修实际故障：config 异常沿现有 failure 结果返回，TOML 库失败不退出 worker，SIGTERM 进入已有 finally。补丁见 `domain-tasks/buckyball/patches/bbdev.patch`，准备副本的 bbdev 为 `a9bd1cb4c4b9948b29ac6323b63a450fbfbb1d4a`，Buckyball 为 `7510fbaa6c4d8dc435b9b39e645055fe415bed09`；原用户仓库和旧 trace 未修改。新 `.venv` 使用 uv relocatable，复制后实际从各自副本加载。Singularity 未添加恢复状态、watchdog 或领域进程管理器；仅压缩 Task 工具描述以遵守原 prompt 预算。app 在 source 结算后检查整轮预算，截止即结束，不再尝试为预算终止 source 打开 RSI。

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


### bbdev 空路由声明修正与预检（2026-11-02 07:25 +08）

当前 BB 轮的独立 review 多次调用 bbdev uvm --verilog，120 秒后报告 Routes failed to register。源码核对确定 CLI 宣称的 /uvm/verilog 后端不存在；对 50 个声明做操作者静态清单比较还发现 /verilator/cosim 同样不存在。领域补丁删除这两个过时操作，两个 API 错误提示改为已有的 uvm --build（chip/ball）。无运行时探测、重试、路由 alias 或恢复 manager；不修改当前轮冻结 baseline。

单独准备副本 artifacts/buckyball-cosyvoice3-20261102-routes：base 82533d89 / bbdev bc83fe53。补丁对上游 06d35a79 可完整应用；48 个剩余 CLI 操作都有对应 route（静态清单不冒充全部业务成功）。原生 DSH MCP 实测 checkout/config 15.593 秒；两个已删除参数分别 2.090/2.040 秒由既有 argparse 拒绝；uvm help 与总 help 成功；已有 AXIS arbiter VCS/UVM 63.355 秒成功。0 模型请求。证据 route-inventory.json 与 mcp-preflight-routes/；准备环境仅用于下一新根。


### retry 公开验收反馈与累计预算（2026-11-02，amendment 015）

05:48 BB 轮的失败定位发现两处真实缺口。规范 §12.4 要求 retry 得到上次公开 receipt，但实现只在 lastAttempt 给通用 reason，evidence 读取仅允许 direct child；parent 即使拿到 child Evidence 也读不到其中的 publicReceipt body。新 Run 因而难以针对具体失败修正。另一个问题是 start wake 用 zero usage、本次 retry reservation/time origin 作百分比分母，导致已消耗大半时间的 retry 仍显示接近 100%；taskSlots/depth 也没有反映已创建子树与剩余深度。

现有 evidence 读取授权扩展到本 Task 最近 closed Run，返回分页 JSON text {result,publicReceipt?}，真实 criteria/reason 按需读取，privateReceipt 仍不公开。child 与 retry 共用一个提交加载器和输出挂载器；旧产物仅从 CAS 冻结提交挂载到 lastAttempt.outputsPath，不复制旧 workspace/transcript。其 refs 保留输入与 verifier lineage。预算直接复用已有 facts/Task 投影，start/batch/tool 共用当前计算；删除单独 startBudget 路径和旧 computeBudget，不新增预算账本、fact、工具或恢复状态。BB example 在 source terminal 后先 seal trace，再决定剩余预算是否允许打开 RSI；截止不再购买模型请求。

定向原生 DSH 回归覆盖：200k/1M usage 后 retry 的 NodeView 为 80%、五分钟/十分钟为 50%，self 工具结果继续扣本次 usage；leaf depth=0，parent 在两 child 与 replacement 后实际扣除 Task 槽位；retry 模型读到真实逐项失败意见，使用冻结旧文件完成新提交，旧 workspace 中被 verifier 改写的内容不被复用。长 child findings 分页完整重组、单页小于 16 KiB、private/无关 Run 拒读。固定 worker+exploration card 为 1983 bytes；精简重复工具描述保持原 12 KiB surface 上限。初次检查暴露的类型 lint 与 surface 超限均已修正，失败日志保留。

根 pnpm verify 全通过：445/445（protocol206、runtime135、app91、domain13），0 fail/skip，project/build/typecheck/lint 全通过；日志 artifacts/attempt-feedback-20261102-release-verify.log。补充 start wake 对累计百分比的 wire 断言在定向回归验证，日志 artifacts/attempt-feedback-wake-20261102.log。fixture 不冒充 BB 完整 frontend、RSI 或 PPA 赢家；真实修复效果由后续新根证明。当前 05:48 进程保留已加载版本，运行资产未中途替换。


### 05:48 BB 轮最终结果（2026-11-02 08:48 +08）

该轮在三小时窗口结束并退出，清理后未发现命令行指向此 execution root 的活动所属进程。最终1779次已结算请求，input268759596/output1872968，unknown=1（deadline取消了最后一个 proposer 请求）；七Task为五verified/两failed，最大depth3、十二Run与十二提交全部结算。三次root独立验收均failed，首次只通过model-reference/delivery；最后一次连参考交付也丢失。已封存trace sha256:28f2b5fd228e09a7728be1b84406cc7da76d680393a403d3c6537dd8917af7e6；RSI确实打开并读取25次公开资源，但只剩约30秒，未交patch，Round以insufficient-evidence/proposer-failure关闭。没有candidate、paired evaluation、PPA赢家或发布，不把初始化activation算赢家。

公开receipt明确指出：单独ActLut/Cv3Dot32/Sfu未接入完整chip/core/compiler/recipe；Q3.12饱和和固定Snake alpha不能代表原模型；第三次输出缺失已生成的原始参考张量。amendment015补齐按需公开失败反馈、CAS旧输出与累计预算；领域guide补充先用现有core/Ball/compiler打通集成路径，明确host/accelerator归属，再按证据增加IP。没有指定分解树、放宽验收、增加语义门禁或运行管理器。下一轮使用routes准备副本，仍守原3h/400M/4000限制。


### 新 BB 轮（2026-11-02 08:52:24 +08）

代码bef5907（含fe3caa0公开反馈/累计预算修复），新根artifacts/buckyball-cosyvoice3-live-20261102005224（目录时间为UTC），PID1608191，截止11:52:24 +08。使用routes准备副本82533d89/bbdev bc83fe53；原3h/400M/4000、maxActive4、depth8/256Tasks/4096steps、deepseek-flash/max/40k保持。独立领域MCP准备与445项根检查均完成，领域guide现有原生fixture4/4通过（artifacts/integration-guide-20261102.log）；首批真实模型请求正常。下一次巡检约09:22 +08。启动不作为验收或发布证据，仍不提交PR/合并。


09:23首次巡检：8Tasks、depth2（三层树）、两批自主分解；root四路reference/recipes/IP/PPA，reference再分LLM/Flow/HiFT。660请求/658已完成，input102394354/output765753/unknown0，四提交、两Run因真实领域验收失败而闭合，尚无terminal Task/root验收/RSI。PPA reviewer独立复现发现未固定源文件读取顺序导致mapped结果变化；LLM reviewer重跑原始权重fixtures成功，但发现合同要求的name-sorted权重fingerprint不匹配。当前执行槽由另外两审查与Flow/HiFT占用，失败Run等待既有retry调度；未发现框架异常。下一次约09:53，继续查公开反馈消费与修正，未把失败/调用次数当作覆盖通过。证据execution root的operator-monitor-20261102-0923.json及公开receipts。


09:53巡检：9Tasks、depth3（四层树）、三批自主分解；1244请求全结算，input187076863/output1462445/unknown0。LLM reference Task在Run2 verified：真实模型先以旧runId读取公开evidence、再读CAS挂载attempts/，修正name-sorted fingerprint等发现；独立review重新推导115项/0失败、原始权重fixtures全等且逐文件再生一致。PPA/IP/recipes的Run2也已真实读取公开receipt和旧冻结产物（长receipt跟进4096 cursor），未读取旧workspace；原生工具结果显示tokens73%/time77%等累计预算，未重置成100%。这些是amendment015真实效果，尚不是root成功。Flow节点实际发出input-invalid feedback，指出共享合同里三处维度/缓存事实错误并给出测量；HiFT进一步创建window/phase探测child等待容量。七次提交、五Run结算、一个Task terminal verified；root仍等待直属批次，无RSI/比较/赢家。证据operator-monitor-20261102-0953.json和对应原生session/公开receipt；继续约10:23巡检。


10:24巡检：1573请求/1572结算，input249985268/output1904410/unknown0；9Tasks四层树，4Task verified（LLM、Flow、Conv1d IP、PPA），没有failed terminal Task，root仍等批次。PPA Run2根据公开意见修正源列表排序，独立driver与标准MCP重跑均得到六报告逐字节一致；Conv1d Run2修正ISA/decoder可达性，独立review复现UVM，并额外跑54配置/3795行bit-exact、backpressure/reset、故意删除rounding的mutation失败。它们是组件/域子任务证据，不代表全芯片仿真或root前端完成。model recipe Run2与HiFT window probe在独立审查，HiFT/reference两级parent等待；下一次约10:54。证据operator-monitor-20261102-1024.json及对应公开receipts。


10:54巡检：1926请求全结算，input307062688/output2596345/unknown0；12Tasks、四层树、四个batch、十一次提交，6Task verified（新增HiFT reference和window-only probe），尚无failed terminal Task。recipe Run2的真实编译/权重导入成功，但独立review发现HiFT magnitude/phase/ISTFT/clamp与Flow normalization/RoPE等语义不保真，拒绝通过；Run3根据公开意见自主创建HiFT/Flow/LLM三路semantics子任务，未放宽验收。HiFT child实际查询ancestor并得到SUMMARY_PENDING；原生Summary Worker随后提交并被接受，reported8652 tokens，归recipe owner session。child尚未再次读取已生成摘要，owner Run尚未结算，故摘要返回/最终UsageRecord.summary归属仍待核对。root仍等直属批次，无root提交/RSI/比较/赢家；下一次约11:24，截止11:52:24。证据operator-monitor-20261102-1054.json及对应原生session/公开receipts。


11:24巡检：2280请求全结算，input355109522/output2993937/unknown0；仍为12Tasks四层树，8Task verified、1Task failed。新增HiFT/LLM exact-semantics两child通过；Flow child预算耗尽后submit被拒，形成no-submission ExecutionRecord并terminal failed，未伪造领域Evidence。recipe parent已被整批terminal唤醒、读取直属结果并提交Run3；reference parent也完成整合提交，两个父任务都在独立review。root仍等直属批次，尚无root验收或RSI；剩余约27分钟/42M reported tokens，继续截止附近核对结算和trace。证据operator-monitor-20261102-1124.json及原生sessions。


### 后续实验的公开冻结产物输入（2026-11-02）

连续BB轮次从零重复参考/组件工作，source已占据大部分共享窗口，尚未留出完整paired evaluation。示例入口允许操作者在准备project.json提供publicSeed归档；原始字节只通过既有CAS/Task input固定，source与三个case用相同Ref，baseline/candidate仍独立实现和验收。归档须记录来源Run/digest/verdict/缺口，只含公开冻结产物和公开receipt，不导入旧事实、session、可写workspace或旧验收结论；没有runtime字段、恢复逻辑或预置workflow。首次从零与后续复用实验应分别报告；当前08:52轮仍使用bef5907已加载版本，没有中途替换资产或扩大3h/400M/4000。

原生领域fixture核对三次fresh retry均读取冻结seed、所有评测定义与source的seed Ref完全一致；旧的failed/no-proposal语义保持。定向4/4、类型/lint通过；根pnpm verify **445/445**（protocol206、runtime135、app91、domain13），project/build/typecheck/lint通过、0fail/skip，日志artifacts/public-seed-20261102-verify.log。真实seed整理与下一根使用待当前轮结算。


### 08:52 BB 轮最终结果与归档策略修正（2026-11-02 11:52 +08）

最终2507请求全部结算，input388247338/output3132633，unknown1为截止时取消的最后一个review请求。使用协议原生reduceDomainFacts只读核对71facts：12Tasks全部closed（9verified/3failed）、18Runs全部closed（9verified/8failed/1cancelled）；其中一个Run由CancellationCut关闭，没有额外合成run/closed。无活动所属进程，主PID只剩已退出zombie。证据operator-final-projection.json；普通monitor只数run/closed的running残项不是实际活动Run。

root Run1真实验收仅model-reference/delivery通过，其余失败：recipes仍与原模型不保真、Conv1d只挂toy而recipes目标为poly、compiler无法发出CONV1D、无实际CosyVoice拓扑、当前设计缺匹配PPA。52原始reference fixtures逐字节重生、组件UVM和mutation控制仍成立，但不能替代完整frontend。Run2读取公开意见和CAS旧产物后提交，独立review被deadline取消，保留完整ExecutionRecord。recipe Run3的Summary usage已核对为ownerTaskId=recipe、sourceContract匹配，input3020/output5632/steps1/unknown0；child未再次读取生成的祖先摘要，不声称完成返回/cache消费覆盖。reference parent确实在batch wake后读取Flow的input-invalid feedback。

该轮随后sealPublicTrace被缺省ExecutionRecord资格策略拒绝，result保留原始错误，没有trace-sealed、RSI、candidate、比较或赢家。规范§16.1已有领域冻结策略接口，BB示例遗漏配置；现将terminal ExecutionRecord作为失败学习轨迹的策略写入冻结provider并传入既有接口，额度耗尽后仍不打开RSI。无runtime/协议修改、无恢复逻辑，旧根保持归档不补写。原生fixture真实在review中耗尽预算，验证subtree一次结算、唯一trace seal、无host failure、无新proposer请求；定向4/4与根verify **445/445**通过（0fail/skip，project/build/typecheck/lint通过），日志artifacts/terminal-trace-20261102-{targeted,verify}.log。

下一轮公开seed由一次性操作者脚本仅从旧CAS导出11个有冻结提交的Task、627文件，包含各自公开receipt/原verdict和缺口；无session/可写workspace导入。归档43,743,003bytes，sha256=0c6b68b65a38892471549c9acaec460febe732da1aee2cb4d67ff401a0b54b3b，无symlink/绝对或越界路径。准备目录artifacts/buckyball-cosyvoice3-20261102-seed仍指向同一82533d89/bbdev bc83fe53环境；它是后续公开复用实验，不再声称首次从零。新根维持原3h/400M/4000、独立验收和全部功能/PPA门槛。


### 公开seed BB 轮启动（2026-11-02 11:59:07 +08）

代码6548240，新根artifacts/buckyball-cosyvoice3-live-20261102-1159-seeded，PID1353425，截止14:59:07 +08。首次从零探索已经归档，本轮使用上述公开冻结seed继续设计；source与全部case的seed Ref一致（object-domain digest c10e2f6c2ae6e715c73f03ca30085dcf5f5da5d80a741c5fcbd30e6ae131df00）。空Method、高节点限制、模型/compaction、原3h/400M/4000和独立验收保持。启动及首批真实请求正常；约12:29巡检，当前仍无本轮验收、RSI或赢家。


### 二进制资源读取边界与巡检修正（2026-11-02 13:54 +08）

11:59 seed轮实际在12:01:26因host异常退出：17请求全部结算，input623948/output12910/unknown0，只有root admitted/opened，没有child/提交/验收/RSI。模型已用bash解包并阅读公开产物，随后试图用singularity_read(resource)读取gzip输入；readChildData错误地对所有合法CAS bytes做fatal UTF-8解码，使模型可修正的文本接口误用升级为host失败。原始异常与未闭合事实保留，归档不续跑。计划12:29的对话巡检实际延迟至13:49，未及时处理退出；后续在artifacts运行独立只读操作者定时快照（每次sleep至多60秒、每30分钟写checkpoint），不依赖模型消息周转、不自动重启，不加入产品runtime。

实际边界仅增加Node原生isUtf8：resource文本分页拒绝二进制并返回INVALID_ARGUMENT、declared path和copy-to-work/原生文件工具用法；CAS读取异常仍原样退出，无格式猜测/自动解包/恢复。framework§14同步明确此文本接口边界并更新spec-lock，AGENTS同步。领域原生fixture改用真实gzip字节，模拟模型误读后沿同Run原生bash解包、fresh retry和提交继续，并保持冻结seed所有case同Ref、预算取消唯一封存/不买RSI等断言。初次未build的定向测试复现旧错误并保留日志；build后定向4/4，最终根pnpm verify **445/445**（protocol206/runtime135/app91/domain13）、0fail/skip、project/build/typecheck/lint通过；日志artifacts/binary-resource-20261102-{targeted-fixed,final-verify}.log。


### 公开seed轮重开（2026-11-02 13:55:05 +08）

代码673bba1，新根artifacts/buckyball-cosyvoice3-live-20261102-1355-seeded，PID3632562，截止16:55:05 +08；使用同一冻结seed/准备环境与全部原预算、模型、验收。首批真实请求正常。独立操作者只读watch已启动，每30分钟写operator-monitor与operator-watch.log，首次约14:25；它只做快照，不重启或改变运行。继续核对分解、完整frontend、RSI比较及发布后消费，未满足前不提交PR/合并。


14:25:06独立快照按时落盘：9Tasks、depth2（三层树）、两批自主分解，8Run opened/4提交/2Task verified；606请求/605结算，input68254723/output622704/unknown0。root以旧公开失败为输入，自主分解Flow精确语义、recipe修正、专用cosyvoice拓扑与实际Ball的匹配PPA；recipe再分LLM/Flow/HiFT/host四路，显式传递冻结seed。Flow精确语义子任务已独立验证99 tensors、补充11组非预设输入、负控均通过；LLM修正11fixtures/56outputs及独立134checks通过，真实checkpoint而非随机权重。二进制seed已用原生bash解包消费，未再因UTF-8接口误用退出，框架仍正常运行。

随后14:30读取到拓扑child的公开receipt：其局部config/elaboration目标verified，实际创建cosyvoice双tile/7core并生成447个SV；review同时实测发现异构chip的UVM filelist选错BallDomainDecoder，且depthwise Conv1d不等同于原HiFT/Flow grouped conv，明确留给parent修正，不能把该child通过说成完整frontend实现。MCP首次checkout因模型未建work父目录返回ENOENT，模型创建后成功；后两工具失败为上述真实领域测试，工具均正常返回，无harness兜底。root仍等直属批次，尚无root提交/RSI/比较/赢家。下一快照14:55。证据operator-monitor-20261102-1425.json及对应公开receipts/原生sessions。


14:55、15:25独立快照均按时落盘。15:25为1196请求全结算，input146425733/output1251870/unknown0；9Tasks三层树、11Run opened/10提交/9Run closed，7Task verified，recipe Run2在独立review、root仍等待直属批次。Flow/DiT子任务重新生成15组原始fixtures逐字节一致，52项检查及7组额外输入bit-exact；HiFT Run1的47/54失败确由raw weight-norm因子挂载位置错误引起，读取公开反馈后的Run2真实修正，独立审查20fixtures/54outputs及47项额外检查通过。匹配Conv1dBall的三top PPA独立重跑报告相同，并从liberty/netlist重算area、用独立OpenSTA脚本复算delay/power；仍只代表组件边界，不能替代最终chip前端PPA。

recipe Run1虽已合并四路真实数值参考，仍因plan/graphs参数路径、rotary buffer和main.cpp host路径未集成而failed；公开receipt给出可复现命令与具体原因，Run2已读取并返工。没有root提交、RSI、candidate或赢家，不把7个局部verified升级为全线贯通。证据operator-monitor-20261102-{1455,1525}.json及对应公开receipts。

实验时长评估：先前08:52轮3小时已消耗391379971 reported tokens而未完成root第二次验收；当前复用公开seed的轮次90分钟仍在root前置集成。示例的source、proposer、三个case各两arm的六棵顺序执行树与发布后验证共用同一campaign窗口，maxActive=4只用于每棵树内部。6小时可增加深层集成/RSI入口观察，完整对照与发布验证宜从12小时评估，并同步扩大总token/request上限；该判断不是通过保证，也未扩大当前已冻结的3h/400M/4000或16:55:05截止。没有为扩大实验增加runtime预算账本或调度器。


15:55快照：1303请求全部结算，input158334938/output1320347/unknown0，8个子Task均verified，root已被整批terminal正常唤醒并自行集成。recipe Run2独立复现867参数映射、0缺失，原始四stage数值对照通过，compiler与poly/cosyvoice3模型构建exit0（272accelerator/26host operators、32graphs）；但量化加速路径和专用cosyvoice配置仍有待root集成，不把它升级为整体验收通过。

16:06:05首次root独立验收failed：model-reference/component-verification/delivery通过，design-contract/implementation失败。review复现447SV和组件测试，但发现专用芯片与poly recipe脱节、Conv1dBall未接入实际图、bank分配合同矛盾；root Run2已读取公开反馈并返工。该receipt还把未接入recipe的单个Conv1dBall PPA判作通过；由于root其他required项失败，没有比较/赢家。下一轮同步收紧既有TaskSpec的ppa-evidence与领域review说明，要求实际workload使用的加速边界、活跃实例/存储模型及独立复现，组件报告只作支持证据。没有新增runtime校验器、状态或恢复机制，当前已冻结review保持不变。

用户明确选择下一轮12小时/1600000000 reported tokens/16000请求，仍是整轮共享上限；深度8、256Tasks、单Run4096steps、并发4和40k输出保持。BB example的Task/proposer/evaluation配额与worker/reviewer原生MCP timeout共用配置，阶段时间继续取整轮剩余deadline，不重新领取整轮额度。仅修改examples、既有fixture与领域文档，protocol/runtime源码不变。定向原生DSH4/4；最终根pnpm verify **445/445**（protocol206/runtime135/app91/domain13）、0fail/skip，project/build/typecheck/lint通过；日志artifacts/bb-12h-20261102-{targeted,final-verify}.log。12小时执行根尚未启动，当前根仍按16:55:05和原额度结算；不以配置或fixture通过声称复杂芯片RSI/PPA闭环完成。


### 2026-11-03：按 dac8c0e 收敛 Task 修复

真实模型测试已停止，本次仅运行本地协议与脚本化 DSH 回归。旧记录中的 seed 完整传递、数值验收成功和当前运行状态，以 [Task 修复审计](task-repair-20261103.md) 的逐项更正为准；已撤除首轮配方、固定 suite 和项目 skill 挂载，改由 parent 编写 child 验收，并修复 self Ref 与工作流指引。

相对 `dac8c0e`：core 源码净增 57 行；整个 apps/packages（含源码、测试与配置）净增 62 行；Buckyball 生产代码净减 18 行，含测试净减 16 行。project/build/typecheck/lint 通过；本地测试 445 项通过、1 项被宿主 inotify 配额耗尽阻断（runtime 的既有 CAS 原子发布 fs.watch 测试，ENOSPC；8192/8192 已占用），app 单独完整 92/92 通过；独立 CI 在 `2f2ea05` 上完整 446/446 通过。本轮恢复通用原生 shell 注册并重跑 CAS 命令及 app 回归，日志 `artifacts/task-repair-{audit-verify,app,frozen-checks}-20261103.log`；未跳过测试或修改系统配额。PR 保持 Draft，最终提交的 CI 状态见 PR checks；本次没有新增真实模型行为改善证据。

后续 prompt 补齐（修改前备份 `e084a7d`）：将弱化职责的探索 brief 和两处算术示例替换为拥有解析、汇总及集成责任的阶段合同；工具示例复用同一合同，按需协议文档展示前批冻结 totals → 后批完整 InputRef → parent 最终消费者复验。worker 明确为 workflow 节点，派发时说明输入来源、输出消费者和接口；未新增机制或预设真实任务树。相对 `dac8c0e`，core 净增 78 行，apps/packages 净增 83 行；Buckyball 仍净减 18 行（含测试净减 16 行）。

原生 shell 的示例正例通过，陈旧 totals、错误 CLI、重复 key 丢失均被拒绝，0 模型请求；worker 1967/2048 bytes，带 checkout/bbdev 的生产 prepare 返回 3562/32768 bytes，见 `artifacts/workflow-example-smoke-20261103.json`。project/build/typecheck/lint 和 app 92/92 通过；本地完整 verify 仍仅被既有 fs.watch ENOSPC 阻断，见 `artifacts/workflow-refinement-{verify,app}-20261103.log`，最终 CI 见 PR checks。真实模型测试保持停止；领域 root 证据检查、独立完成能力评测和 BB 成功链路仍未完成，详见审计的剩余范围。


### 契约反馈修订（2026-11-04，amendment 017）

按用户“先停掉这一轮，修完了开个新的，改之前提交 git commit 备份”执行。round5-thin-20261103-2215 的 operator/子进程和独立 monitor 已停止；operator-stop.json 保存最后已结算计量：2,326 请求，277,869,770 input + 2,744,212 output tokens，unknown=1。保留原 open facts，不伪造 closure 或结果。施工前 checkpoint 为 e18e281。

该轮证据显示实际职责树和逐层集成已出现，但不能判定目标已解决：child checks 冻结了互相矛盾的 exit_code 条件、错误的 KV 维度，并依赖复验目录中不存在的 buckyball checkout；相同契约被重复执行。另有真实实现/数值缺陷，不能一律归为验收错误。

当前变更将 fresh CAS-only 检查环境明确写入 worker card 和工具说明；feedback 简化为 kind/summary/refs/replyTo，直接提问 yield、parent 在整批结束前答复、同 Run/session 续接。stop(blocked) 明确交回派发者，不自动 retry；普通 failed/unsolved retry 保留。最后 Run 无提交时仍向 parent 提供该 Task 最近已冻结的产物，最新 blocker record 不被旧 Evidence 覆盖。scheduler 诊断复用 closure，删除预演 retry 的重复分支。没有新 fact、消息副本、broker 或归档恢复；读取保留在 live yield 中的原生 Session，因为 DSH dispose 会移除 live registry 条目。

Buckyball guide 删除重复平台流程，领域就绪仅固定环境、资源、root 问题/验收和预算；不要求预制非 root 检查或求解树。项目既有 skills 仍仅由 root 参考文档路径暴露。完整 RSI 评测就绪与普通探索就绪分开描述。

验证：原生 DSH fixture 已覆盖 maxActive=1 提问→父答复→同 Run 继续，以及错误契约失败→retry 中提问→blocked 交回而不进入第三次 retry→新 required Task 复用旧冻结产物并通过，root 验收和原合同 digest 保持不变。根 pnpm verify 已通过：protocol 206、runtime 136、app 92、inventory 13，共 447/447，0 fail/skip。worker persona/card/exploration 合计 2023/2048 bytes；Buckyball 真实 surface 的脚本化 campaign fixture 也通过既有 12 KiB schema 门禁。新轮启动结果另记，不把 fixture 当作真实模型改善证据。


相对 dac8c0e：全部 apps/packages（含测试/配置）+602/-508，净增 94 行；protocol/runtime src 净增 85 行，连同 app src 与通用计量 example 的框架生产源净增 89 行；Buckyball 生产文件 +21/-40，净减 19 行。合并了被新对话/纠正派发用例覆盖的旧 required replacement fixture，保留明确的 REQUIRED_FEEDBACK_REPLAN 拒绝、冻结检查失败、旧 Evidence、required winner 和跨批 CAS 交接断言。删除反馈 Ref 内存副本，读取原生已提交 tool results。

原生接入路径是现有容量 pool → agents.resume → followup(createWakeMessage) → whenIdle/dispose。独立 Task 的 parent 在 yield 后没有 live Agent，不能只调用 live followup；复用已有同进程 yield 及原生 Session 引用即可，无需另一套消息管理器。归档仍不具备续跑入口。验证日志：artifacts/contract-feedback-verify-20261104.log。


新真实轮：`artifacts/round6-contract-feedback-20261104-012235`，2026-11-04 01:22:35 +0800 启动，绝对截止 2026-11-04 13:22:35 +0800。冻结修复提交 `94d39c3`，79 个源文件 hash 与启动快照一致；12 小时 / 1,000,000,000 reported tokens / 4,000 requests，maxActive=4，模型 deepseek-flash/reasoning=max，未扩预算。operator PID 2765833、只读进度 monitor PID 2765834；monitor 每 1,800 秒记录实际 Task、closure 中已索引反馈和 blocked Run，不能据此自动宣称修改有效。启动检查已发生 5 个已结算真实请求，52,398 input + 1,596 output tokens，unknown=0，无启动失败。原 round5 不续跑。后续是否改善须核对新轮真实父子对话、复验与集成轨迹；当前不声称 frontend 完成或 RSI 获益。


### 依赖规划与领域证据修订（2026-11-04，amendment 018）

按用户要求，round6 于 12:11:57 +0800 停止；operator、monitor 和本轮三个 DC 综合作业均已退出。归档 `artifacts/round6-contract-feedback-20261104-012235/operator-stop.json` 保存 422 请求全部结算、92,835,597 input + 319,311 output tokens、unknown=0；保留 open facts，不伪造 closure。修改前备份提交 `446ec4f`。

该轮约 10.6 小时仍在 root 的第一批两个直属任务，没有孙节点或父子反馈。参考任务局部通过，芯片任务长时间综合通用 DigitalTop，root 尚未完成 recipe、功能与实现集成。轨迹中 root 曾规划后续实现/验证批次，后来将 PPA 提到首批；芯片 child 曾考虑 config→elaboration→synthesis 的串行职责，最终因共享 checkout 和协调成本选择直接执行。局部合同又提前固定拓扑及字符串检查；局部满足不能证明 workload 实现。root 还多次将启动消息中的 100% steps 理解为 100 steps。不能将根因归为旧 skill 或工具列表：实际没有挂载项目 skill，领域 MCP 只有 checkout/bbdev，旧 ball-align 文档本身已有功能验证先于最终 PPA 的说明；本轮没有做因果消融。

通用修订仅更新既有 worker card、探索说明和按需工具参考：先提交初始草图，再读资源细化功能、前提、消费者、证据和预计成本/不确定性；当前仅派发就绪的直属职责，消费前批结果后形成下批合同。叶节点以前提成立和直接可验证结果界定；共享 checkout 不构成依据。前提/合同/计划失去父目标价值时主动 feedback。启动预算明确标注字段和百分号。没有新增 schema、状态、调度器、语义门禁、逐任务时限或固定领域树；沿用现有父子对话机制。

Buckyball 指引删减重复交付/PPA 压力，既有 core/Ball/compiler 作为需要证据的候选；资料区分 elaboration、功能检查和带条件的综合估计。早期综合可验证明确设计假设，最终 PPA 必须对应 workload 实际消费的实现；不规定统一设计阶段顺序。项目旧 skills 继续只在 root 给出参考文档路径，其角色、审批和流程门槛不覆盖 Task 合同；非 root 合同和验收仍由模型编写。root criteria 未变。

新真实轮：`artifacts/round7-workflow-planning-20261104-122838` 于 2026-11-04 12:28:38 +0800 启动，绝对截止 2026-11-05 00:28:38 +0800。冻结提交 `5673c534e3d0868b0e95afb49780d822380e9d6a`，启动记录的 79 个源文件 hash 与当前文件一致；12 小时 / 1,000,000,000 reported tokens / 4,000 requests，maxActive=4，deepseek-flash/reasoning=max，使用全新执行根，不续跑归档 root。operator PID 1341135、只读 monitor PID 1341136；启动约 8 个请求已结算，unknown=0，无启动失败。实时结果只在该根的 SQLite、requests.jsonl 和模型 session 中判断，不把启动或脚本 fixture 当作成功证据。

### round7 取消审计（2026-11-04）

round7 于 20:36:12 +0800 被取消，未生成最终 `result.json`；最终计量为 3,083 requests / 460,696,768 input / 3,105,029 output / unknown=0。`operator-cancelled.json` 中“RSI 尚未开始”的原因与事实事件不一致：SQLite 显示 round1 在 19:38:42 打开 RSI，19:44:24 proposer 提交后被 precheck 以 `Template MCP server binding is dangling` 拒绝；随后 round2 已开始并派发两个直属 child，取消时其中 Ball authoring/PPA probe 尚未提交。

root 合同要求五个推理阶段、架构/内存/精度/数据流、compiler/emulator mapping、RTL、逻辑综合、每阶段组件验证和 workload 实际边界 PPA，六项 required criteria 全部必须通过。round1 同一 root Task 自动消耗三次 Run（194、111、139 steps；分别失败 4 项、1 项、1 项），累计 root 输入约 121M tokens；child 侧 17 次 verified、5 次 failed/blocked。最终已有独立 PPA 报告，但 implementation 仍发现 330 条 recipe 项没有合法 bank/K 分块、累加链和 repository consumer。258 个 offload 条目在 Run1 被指出未交付实现；Run2/3 增加了原模型 host-reference 脚本与数值测试，仍没有目标 recipe 的执行绑定，不能笼统说全部算法源码始终不存在。

模型编写的 child 合同确实出现了错误：`param-anchors` 检查自引用而不可满足；`BuckyballAccelerator == 12` 与 `inputChannels == 5` 的真实拓扑互相矛盾（可达结果是 10，12 需要改成 inputChannels=6 和 ball-bearing controller）。child 通过 feedback 正确指出并 blocked。workload 有后续修正合同；芯片/recipe 的 parent 虽承诺重发，最终改为本地重写，没有派发修正后的同职责 Task。反馈通路有效不能证明 parent 随后的实现或集成有效。

round7 冻结 PPA 报告使用 Yosys/OpenSTA，没有实际 `bbdev dc` 调用；root 读到过商业 EDA 指南和 DC/PT 信息，不能据此断言商业 EDA 不可用或只会增加等待。repo 的 `bbdev yosys --run` 遇到 `arch/build.sc` 缺少 tapeout module 的真实环境缺口，reviewer 使用了替代 flow。该 SRAM/PPA 问题没有阻止本轮成功运行 ISA/BEMU 组件测试，不能解释 recipe consumer 未写和 bank capacity 违规。

进一步责任审计见 [round7 workflow 职责审计](round7-workflow-responsibility-audit-20261104.md)。主要断点是 root 看见接口要求后自行缩范围，直属合同用 JSON/数学参考代替目标执行；Run2 没有读取 Run1 详细验收，reviewer 又在明确写出“无 consumer、指令流不可执行”时判 implementation pass，Run3 因而主要补 PPA。三个提交的 recipe 与 generator hash 完全相同。芯片 child 还将 `PLAN_FIRST` 时的暂态 `canDecompose=false` 误解为永久禁止分解；上一 Run 冻结输出虽被宿主授权向下传递，模型界面却未像直属结果一样暴露完整 InputRef。不能因出现多层树宣称 task workflow 问题已解决，也不能仅以任务大作为根因。RSI precheck 拒绝的是 proposer 自己提交的 dangling tool 引用；尚不能称为已经证实的框架绑定实现缺陷。


### round7 根因修复与 Ball 测试集替换（2026-11-04，amendment 019）

修改前备份 `6090aa8`；归档 round7 保持停止，本次没有重开付费模型 campaign。根因以 [职责审计](round7-workflow-responsibility-audit-20261104.md) 更正旧结论：root 在可见完整要求时主动将目标 consumer 缩成 JSON/数学参考，child 合同没有继承实际实现职责，retry 漏读独立 findings，Run2 reviewer 又在明确记录无 consumer 时判 pass。任务过大增加成本，但不能替代这条责任链分析；出现孙节点也不能证明 workflow 使用正确。原生 feedback 本来可用于合同异议，不另建父子通信机制。

通用修改删除把暂态前置条件误当永久权限的 canDecompose/canSubmit 重复投影，实际 guards 保持。children/evidence 统一返回可直接用于 child 合同的完整 InputRef，并排除只用于内部挂载的 kind 字段；previous attempt 复用相同入口。worker/card 与按需参考强调每个 required outcome 的本地或 child 责任、真实 consumer、完整 retry findings，以及 passing verdict 中仍存在的缺口。不新增 read 门禁、语义判定器、状态、消息副本、固定任务树或逐任务时限。framework/spec-lock/AGENTS 同步为 amendment 019。

新的 [Ball 领域任务](buckyball-mxmm-ball.md) 替换旧 frontend 入口、整模型 guide/review、PPA scorer 与 public-seed 复用分支；旧执行产物仍作审计证据。选择现有 MXMM Ball 的可执行容量感知分块：长 K、A/B 超 bank、C 超 bank、不同有限 scales、有符号/零 codes、输出 guards 和连续调用。要求真实 callable consumer → ISA → RISC-V ELF → focused BEMU；非 root 合同/检查与实现由模型自己编写。项目既有 skills 仍只给 root 参考文档路径。RSI 比较两边完整功能通过后的子树 reported tokens（含 child/retry），不再为固定硬件的软件分块强求芯片 PPA；proposer 仍须先注册再绑定 Method tool，dangling patch 不放行。

真实无模型预检发现并修复一个 bbdev 缺陷：CLI 的 core-index 被后端 core_index 拼写静默丢弃，实际运行的是默认 tile runner。领域补丁只统一 API/event 两处键名；没有 runtime 参数补救或兼容别名。初次四项 tile runner PASS 不算单 core 证据。操作者又把局部 core_id=1 误当全局 index；经 generated derived.json 核对后纠正为 attention global index=2，终止了该独立预检中选错 controller 的进程，保留失败记录，未用超时替代根因修复。

修正后实际命令均为 `--bin bebop-bemu -- ... --core-index 2`，capacity/window/window-chain/window-rows 四项全部 PASS，system+core-index 的非法组合也返回真实失败。独立 checkout/config 与 fresh C/ELF build 成功。准备副本固定为 `07a85ea2898e59a80d0dfbb30520d8ed5c39390a`，bbdev `207c4b73998a1d34279d854d7b3f52d86721e86d`；与成功预检的 API/event、ISA、RTL 和 bank 配置 hash 相同。证据与下一轮 project manifest 位于 `artifacts/buckyball-mxmm-ball-20261104/`，摘要 `preflight-summary.json`；0 模型请求。这只证明领域消费/环境回归可用，不代表模型已写出大矩阵 tiler，也不证明 RTL 等价。

验证：根 `pnpm verify` 447/447 通过（protocol 206、runtime 136、app 92、inventory 13），0 fail/skip，project/build/typecheck/lint 通过；日志 `artifacts/ball-repair-verify-20261104.log`。既有 retry fixture 已升级为 root fail → evidence 完整 InputRef → 新 child 准入/真实读取 → parent 集成，确认旧可写 workspace 不被复用；长 findings 分页与 private receipt 不泄露也覆盖。新 campaign fixture 验证空 Method、四项根失败保留具体原因、预算封存、无错误 activation；不能作为模型自主改善证据。最后短 card 措辞同步后另跑定向回归与 project 检查，日志 `ball-repair-final-{targeted,project}-20261104.log`。

相对 `dac8c0e`，整个 apps/packages（含源码、测试、配置和领域补丁）+867/-768，净增 **99 行**；protocol/runtime src 净增 **80 行**；Buckyball 生产文件净减 **41 行**。worker persona/card/exploration **2042/2048 bytes**。旧 frontend 文档已由 Ball 文档替换。仍需下一轮真实模型证明 required 职责没有在分解中丢失、实际 consumer 被实现、完整 findings 被消费及 RSI 获益；独立 LLM review 的语义错误不由新判定器兜底。本次交付代码、测试集、准备副本与可复查证据，不声称这些行为已被修复保证。


### round8 MXMM Ball 真实测试启动（2026-11-04）

用户明确要求“启动吧”后，以新根 `artifacts/round8-mxmm-ball-20261104-224941` 启动 MXMM Ball campaign；未续跑归档。冻结生产源码提交 `a55421face45df4708f9f2e4b4883058cf210ec5`，81 个启动源码 hash 一致；该提交独立 CI 已通过。Buckyball 准备副本与真实单 core 预检身份沿前节固定，初始 Method 为空，项目既有 skills 仍只在 root 暴露参考文档路径。

实际开始 `2026-11-04T22:49:42.325000+08:00`，绝对截止 `2026-11-05T10:49:42.325000+08:00`；整轮共享 12 小时、1,000,000,000 reported tokens、4,000 requests，并发 4，不扩大配额。provider `singularity-local`，模型 `deepseek-flash`、reasoning=max、输出上限 40k，原生 context/compaction 配置保持既有冻结版本。operator PID 1206481，只读 monitor PID 1206482，间隔 1,800 秒；记录直属合同、公开 closure/findings、反馈与 RSI 事件，不增加调度、自动重启或恢复路径。

启动核实时间 `2026-11-04T22:51:47.699694+08:00`：已发起 12 请求、结算 12，input 260736 / output 8908 tokens，unknown=0；operator 与 monitor 存活，无启动 failure 或最终结果。证据为该根的 `operator-startup.json`、`execution/launch.json`、`execution/requests.jsonl` 和 `monitor-*.json`。这只证明真实测试已开始，尚不能判定 consumer、职责保真、重试证据消费或 RSI 改善有效。

### round8 RSI 失败边界审计与修复（2026-11-05）

round8 于 05:06:38 +0800 自然结束，没有运行中的模型进程。2,062 requests，reported input `354,364,047`、output `2,685,399`、unknown=0。worker/children 985 请求、184,417,195 tokens；reviewer 1,053 请求、171,614,631 tokens；proposer 24 请求、1,017,620 tokens。此前把首轮累计约 84.2M input 归给 proposer、把 blocked tiler probe 称为 required、把源码装配异常写作已完成子树取消，均不准确，已删除。

两个 source 均 verified；首轮 rejected 是 Skill.name display title；第二轮 baseline long-k 已 verified，candidate 在首次请求前因 visible tool schema 12607 > 12288 bytes 崩溃。约 3.57 亿 tokens 没有完整 candidate comparison、无 winner、无 activation。归因、Core 对照、过拟合样本与测试集覆盖局限见 [round8 审计](round8-rsi-audit-20261105.md)。

当前修复：authoring schema 按需读；非法 skill name 在提交前可同 session 修正；RSI 提炼输入驱动的通用算法/脚本/工具，实例答案仍属 Task；压缩重复工具说明；candidate-first；明确 schema 超限保存零请求 invalid record，无效/取消 slot 不继续购买后续 slots，普通完整 fail receipt 继续评测。worker 明确 source-backed pass rule、真实 bash/pipefail、捕获流与 CAS-only 条件。MCP surface 漂移、CAS/provider/会话/清理异常继续原样抛出。没有领域检查器、恢复会话、自动重试、固定任务树或人工算法资产。修改前备份 `a570302`，新真实模型 campaign 尚未启动。

最终使用 upstream Node 24.22.2，根 `pnpm verify` **448/448** 通过（protocol 206、runtime 136、app 93、inventory 13），0 fail/skip，project/build/typecheck/lint 全通过；日志 `artifacts/rsi-repair-20261105/final-verify.log`。S6 原生 fixture 分别验证完整 fail receipt 仍执行四个 slots、candidate 无提交后只执行一个 slot且保留四 slot 分母；非法 skill 名同 session 修正、超限零请求 invalid、MCP surface 漂移仍抛出也通过。round8 真实候选在新根与新 Task/Run/session IDs 中零付费装配：原生 schema 12210/12288 bytes，provider tools 12706 bytes；仅一次本地 fixture 请求、故意无提交，不执行 BEMU 或比较收益，见 `artifacts/rsi-repair-20261105/candidate-composition-4/report.json`。冻结管道报错有独立 Node 捕获流复现。上述证据不证明真实模型合同纠错或领域迁移已改善。

相对 `dac8c0e`，全部 `apps/packages`（源码、测试、配置、领域补丁）+945/-845，净增 **100 行**；Buckyball examples +136/-177，净减 **41 行**，统计包含已删除的旧 frontend 入口。`git diff --check` 通过。当前 suite 仍只验证 MXMM 输入迁移，跨算子领域 suite 未实现/实测；没有用放宽功能验收或伪造 comparison/activation 弥补这一缺口。

### round9 RSI 修复后 MXMM 实测启动（2026-11-05）

用户明确要求“开一轮新的”后，以新根 `artifacts/round9-mxmm-rsi-20261105-131734` 启动；不续跑 round8，不复制旧事实或模型候选，从空 Method 开始。冻结代码为 `e44f109414c2d7c247f2b5ad9b44d1e5e8c781ae`，81 个启动文件 hash 一致。实际宿主使用 upstream Node 24.22.2；新的 `artifacts/buckyball-mxmm-ball-20261105/project.json` 仅更新宿主说明，继续指向已预检的只读 Buckyball 基线、同一 bbdev 和同一真实 MXMM consumer，5 个关键来源 hash 与成功预检一致。项目原有 skills 仍仅作为 root 参考文档路径暴露。

实际开始 `2026-11-05T13:17:34.795+08:00`，绝对截止 `2026-11-06T01:17:34.795+08:00`。整轮共用 12 小时、10 亿 reported tokens、4000 requests、并发 4；provider `singularity-local`、模型 `deepseek-flash`、reasoning=max、40k 输出上限、700k context 与原生 compaction 配置沿既有冻结策略。operator PID 916745，30 分钟只读 monitor PID 916746，无重启或自动恢复。活动入口记录为 `artifacts/mxmm-ball-active-launch.json`。

启动核实 `2026-11-05T13:18:02.029513+08:00`：两个进程存活，8 个请求全部结算，input（含缓存）121806、output 2997、unknown=0；未产生启动 failure 或最终结果。证据在该根 `operator-startup.json`、`source-hashes.json`、`execution/launch.json`、`execution/requests.jsonl` 和 `monitor-*.json`。这是修复后相同 MXMM suite 的真实实验，重点观察合同/反馈消费、重复实现成本、候选装配及完整 RSI comparison；尚未形成改善结论，也不能作为跨算子泛化证据。

### round9 根因复核与入口可达修复（2026-11-06，amendment 021/022）

round9 已停止且没有重开付费测试。归档 `artifacts/round9-mxmm-rsi-20261105-131734/stop-audit.md` 记录 3,771 请求、585,849,365 input（含缓存）+4,703,044 output、unknown=1；source verified、4 个 evaluation roots verified，最后一个 validation slot 活动时停止，没有 `result.json`、comparison、winner 或 activation。reviewer 共消耗 1,925 请求。source 未分解但独立完成并通过全部根验收，说明当前 MXMM 任务并非环境上不可完成；评测 children 全为 probe、部分模型合同错误及高复核成本仍是真实问题，但不足以解释候选必然没有收益。

直接读取归档 MethodPatch、MethodRevision 和每次 run/opened Composition 找到决定性的组成缺陷：候选新增 `mxmm-capacity-tiling` 与 `mxmm-target-verify` 两个 Skill，却保持 `templates=[]` 且没有 `entryTemplateId`。空入口只绑定全局 snapshot，所有候选 Composition 的实际 `skills=[]`，与 baseline 完全相同。因此这轮继续执行的候选树不可能消费 proposer 写出的参数化算法，已有 verified 也不能成为 RSI 改善证据。这不是靠增加 worker prompt、强制树深或改写 Buckyball 验收可以修复的问题。

现有 no-op precheck 改为只比较 entry 可达的模板闭包及其 Skill/MCP 内容；目录可保留未使用资产，但只增加不可达资产的 patch 不再进入付费对照。proposer card 同步明确 put-template/set-entry 的绑定责任，没有自动绑定、添加新事实或猜测模型意图。有效 Skill/MCP 绑定路径保留直接回归。probe/required 语义不变：把唯一 fallback 改成 required 会破坏同批平行探索，当前证据不支持这种粗暴替换；错误冻结合同仍由模型反馈/blocked 和独立验收暴露，不增加自然语言或 shell 语义门禁。

reviewer 正常结束却未提交 findings 时，不再伪造领域 fail 让 worker 重试，而是返回 invalid 验收并沿既有非 transient policy 结算。Agent dispose 与 MCP 资源清理分别尝试并保留错误。amendment 021 的领域职责收缩保留：通用实验宿主、reviewer 生命周期和 token comparator 归宿主，Buckyball 只提供目标、根标准、案例、资料与 checkout/bbdev 环境；旧 campaign 路径及发布后附加工作不恢复，根验收没有放宽。

验证使用 Node 24.22.2、pnpm 11.18.0：`pnpm install --frozen-lockfile` 与根 `pnpm verify` 全部通过，**449/449**（protocol 206、runtime 138、app 92、inventory 13），0 fail/skip，project/build/typecheck/lint 全通过。定向 precheck 10/10 覆盖 round9 的不可达 Skill 拒绝、可达 Skill/MCP 接受及原 CAS 异常；通用实验 fixture 区分两个真实 failed source 的三次 fresh attempts 与第三个无 findings source 的一次 invalid，不重做 worker。相对 `c5a070d`，生产 src/examples 净增 **12 行**，低于用户 80 行上限；`git diff --check` 通过。此次没有新增真实模型请求、完整 comparison 或 RSI 收益证据；当前 suite 仍只证明 MXMM shape/data 迁移，不证明跨算子泛化。

### 模型可见流程与文本审计（2026-11-06）

按实际 DSH 装配路径复核了 worker persona/card、探索 guidance/example、NodeView 与 start/batch wake、Task read/plan/decompose/feedback/submit/stop 的 schema 和错误提示、Summary、独立 reviewer、RSI proposer、原生 skill/MCP 及 Buckyball root/工具说明。没有修改 DSH 自带 prompt 或领域验收，也没有通过增加新的“请遵守”段落解决文本问题。

修正了四处实际缺陷：Summary card 删除了 schema 不存在的 next-use description，避免诱导额外字段；reviewer 明确 pass=已复现满足、fail=未满足、invalid=无法评价，避免把验收失败和领域失败混淆；proposer 只在 previousRound 存在时读取反馈，并大幅压缩 rsi_read/rsi_submit_patch 的重复描述；Task 的 page、result Ref、stop 与预算 nextAction 改为符合真实接口的正向动作。Buckyball 明确先 checkout 新绝对路径、args 必须是 argv 数组，不再在 MCP 说明中重复整段领域排除项；root 参考路径从整个 `.agents/skills/` 缩到 debug-bemu/debug-compiler 两份技术文档，避免无关角色、审批和严格阶段门禁干扰当前 Task。

worker 保留 self/plan、职责归属、冻结核验、真实 consumer、反馈/retry 等必要约束，压缩重复规划文字并保留 cost/uncertainty 与估计验证；探索 guidance 不再重复 worker card。实测 worker persona+card+探索追加为 **1914/2048 bytes**，探索 guidance 为 198 bytes。协议中的 worker/Summary/RSI cards 与实现同步，taskProtocolReference 也明确 entry-reachable 绑定规则。

定向原生测试 19/19 通过：worker/NodeView、Summary 实际请求、RSI proposer、Buckyball 通用实验、探索和 host composition；Summary 请求额外断言不再出现 next-use。最终根 `pnpm verify` **449/449**（protocol 206、runtime 138、app 92、inventory 13），0 fail/skip，project/build/typecheck/lint 全通过。本轮文本审计后，相对 `c5a070d` 的生产 src/examples 累计净增 **10 行**，仍低于 80 行；没有新增付费请求或真实行为改善声明。

### 领域任务缩编与 round10 真实测试启动（2026-11-06，amendment 023）

按用户要求删除新增改动中越界的工具/内部排除表述，形成[统一领域任务编写框架](framework.md#190-领域任务编写框架)：root 只写外部目标、验收、少量 cases、参考资料和环境资源，不规定 Singularity/RSI 可修改的资产、workflow 或解法。worker 可修改独立 checkout 中的领域源码并交付补丁/drafts；算法、脚本、bbdev CLI 与 MCP 统一经 `put-skill`、`put-mcp-server`、`put-template` 和 entry 绑定演化，不修改 live host 或共享 baseline。

round9 正式 patch 只有 `put-skill`，没有 `put-mcp-server`，其假设把成本归为重复算法和验证代码构建；当时 bbdev 已能真实执行 BEMU，没有证据表明它“必须”被改。通用 proposer 现在明确可提炼 algorithms、scripts、MCP/CLI tools 或 workflow rules，但不强迫工具改造，也不再把候选不可见误当工具演化失败。

Buckyball root 合同只保留数值语义、真实 ELF/BEMU、独立复现和交付要求，删除 Singularity 内部排除、工具选择限制和非必要 redesign 禁令。source 已覆盖 bank-crossing，删除重复公共 case，仅保留 long-k 公共迁移与 output-tiling 独立 validation，每轮对照 roots 从 6 缩为 4；四项 required 验收语义未放宽。相对 `c5a070d`，生产 src/examples 累计净增 **7 行**。冻结依赖检查与根 `pnpm verify` **449/449**（protocol 206、runtime 138、app 92、inventory 13），0 fail/skip，project/build/typecheck/lint 全通过。

新真实轮 `artifacts/round10-mxmm-rsi-20261106-021813` 于 02:18:54.905 +08 启动，绝对截止 14:18:54.905 +08；新执行根、空 Method、82 个生产/配置文件的 worktree hash `076e9eeaaa1325e5fb3e7e21c8dfa88157c85bac0a42d54989876d973633b4c9`，不续跑 round9。provider 为 `https://api.agicto.cn/v1`，deepseek-flash/reasoning=max、700k context、40k 输出上限；整轮 12 小时、10 亿 reported tokens、4000 requests、并发 4。campaign PID 1442702，只读半小时 monitor PID 1447066，无自动重启。启动记录见该根 `operator-process.json`、`source-hashes.json` 与 `execution/launch.json`，凭据未写入文件。

02:20:51 启动快照已有 19 次请求全部结算，input（含缓存）703,439、output 13,185、unknown=0；只有 method registered/activated、root admitted/opened 四条事实，尚无 child、提交、验收或 RSI 结果，也没有启动 failure。证据为该根 `operator-startup.json` 与 `monitor-20261105T182051089Z.json`。启动成功只证明新合同和路由可用，不能提前声称 workflow、工具演化或 RSI 收益。

### round10 children 分页中断与修复（2026-11-06）

round10 于 05:19 因宿主异常退出，并非截止、预算耗尽或 RSI 结果。`execution/result.json` 记录 1,860 次请求全部结算，input（含缓存）177,816,626、output 2,678,569、unknown=0，原始错误为 `Task read page is 16591 bytes, above the 16384 byte budget`。最终 94 条事实含 22 个 Run、19 个 closed Task，已有真实多层探索和组件验收，但 root 尚未验收，未进入 RSI；`operator-final-projection.json` 已保存，只读监控已停止，未自动重启。

原生 session 将失败精确定位到 parent 的 `singularity_read({kind:"children",page:5})`。默认五条 child 记录合计 16,591 bytes，证明条数分页与 16 KiB 完整响应上限互相矛盾，不是模型滥用参数。修复在现有 read 路径按实际字节装配 children 页，必要时减少当页条目并以 nextCursor 续接；单条过大返回可改正的工具拒绝并指引改读 evidence，不提高上限、不新增状态或自动重试。

只读 `DomainStore.replay()` 加纯 reducer 重放同一 parent 的五条真实记录，现分为两页、最大 11,856 bytes，五条全部返回且无重复。新增回归逐页检查 16 KiB、顺序与完整性。相对 `c5a070d`，生产 src/examples 累计净增 **16 行**，仍低于 80 行。根 `pnpm verify` **450/450**（protocol 206、runtime 139、app 92、inventory 13），0 fail/skip，project/build/typecheck/lint 全通过。该修复证明原中断场景已消除，不证明 round10 的 workflow 或 RSI 有效；是否重开下一轮由用户授权决定。

### round10 责任链与验收减量修复（2026-11-06，amendment 024）

对 round10 的 SQLite、requests 与模型可见合同复核发现，分页只是直接中断点，更大的失败是递归元工作：19 个 exploration children 的全部 required criteria 都已有 shell check，却仍产生 771 次 reviewer 请求；18 个 child verified 后，工作继续膨胀为复核复核结果、冷审冷审结果和重复重建。reviewer 占全部请求的 41%，worker 侧也持续新增审计树。parent 的 children 读取又只有 ID/状态/Ref，没有该 child 的目标和交付物，长运行或压缩后无法从授权视图恢复职责映射。以上结论来自实际轨迹，不是对模型意图的猜测。

修复沿既有 AcceptanceRef 组合替换重复路径：exploration fallback 改用 `experiment:frozen-check-acceptance`，原生 shell 直接对 CAS 输入/输出逐项结算；缺任何 required check 时在执行 shell 前报 composition mismatch。root 保留独立语义 review，单次上限 128 步，不放宽四项根验收。children 分页返回冻结合同已有的 goalSummary/deliverable，保留此前的实际字节分页。worker/探索/RSI 指引改为生产本层会消费的结果，host 负责提交后验收，不再把 review/audit/reproduction 链当成可无限分解的工作；persona+card+探索追加为 1722/2048 bytes。没有新增 fact、状态、语义判定器、兼容入口或默认 LLM review。

领域 case 不再只冻结 shape 并由 worker/reviewer 各自选题，改为冻结 seed 与 dataRule，精确重建全部 codes/scales；source 也覆盖长 K 和最小块。paired arms 因此消费同一实际输入，独立 reviewer 仍须重建、解码参考、运行 ELF/BEMU 与回归。通用 proposer 指引保留参数化实现和 consumer checks，删除对源特定审核链的学习激励。

验证：相关原生/协议回归 **14/14**；随后 `pnpm install --frozen-lockfile` 与根 `pnpm verify` 全部通过，**453/453**（protocol 206、runtime 139、app 95、inventory 13），0 fail/skip，project/build/typecheck/lint 全通过。完整 DSH fixture 实际完成 root→child→parent 集成→一次 root review→trace seal→proposer，child acceptance 为 frozen-check provider 且没有 child review 请求；缺 check、check pass/fail、职责视图和确定性 case 均有直接断言。没有启动新付费 campaign、执行新 BEMU 或宣称真实模型/RSI 已改善；这些仍须下一轮新根实测，尤其要检查是否还出现审核树、候选入口可达性及完整 comparison。

### 模型可见面与工具消费审计（2026-11-06，amendment 025）

逐类读取 round8/9/10 的原生 system message、`request/header.tools` 和 tool/call 后，确认不能按“未使用”删除 `status/feedback/jobs/children/evidence/resource/RSI/checkout`：它们均有真实消费者。round10 的 Buckyball 只有 `resources:[]`，但仍有 7 次空列表调用；round9 有 26 次空 resource 调用。`mcp__buckyball__bbdev` 在 round10 虽实际出现在 schema 中却零调用，模型只用 checkout，再在 bash 脚本中手工执行 `nix develop`，说明它不是不可见，而是直接入口引导不足。ancestor 的实际调用只得到 pending 或非直属 ID 拒绝，Summary 生成后没有再次读取。`read(self)` 还在单页返回对象、分页返回字符串，并重复展示 criteria；Summary 只有 summary_submit，却仍看到 bash/jobs 指南。

完成以下替换而非新增平行功能：experiment 关闭无实际资源的原生 mcp-resources 服务，profile、NodeView、dispatch guard 与 prompt digest 同步省略三项 resource 工具和 server 提示；每个 worker/reviewer 的工具 schema 因此少 1,013 bytes，通用 Method MCP resource 能力及测试保留。`self` 的所有页统一为可拼接 JSON 文本，criteria 只出现一次，provider 独立为 acceptanceProvider。Summary/Proposer 清空无 bash/jobs 能力角色的对应 DSH 提示。`SUMMARY_PENDING` 增加后续模型步重读 nextAction，不阻塞 owner Run 生命周期。探索 guidance 只保留公共资源和 result/ 交付信息，bbdev 明确直接 MCP argv 入口及 Nix 已激活事实。删除一个未消费 verifier 常量和过时 compaction 注释。

验证：受影响回归 **17/17** 后，`pnpm install --frozen-lockfile` 与根 `pnpm verify` 全部通过，**453/453**（protocol 206、runtime 139、app 95、inventory 13），0 fail/skip，project/build/typecheck/lint 全通过。实际 fixture 断言 worker/reviewer 不再看到空 MCP resource 工具，Summary/Proposer 不再看到 bash/jobs 指南，bbdev 新说明进入真实 schema，Summary 首次 pending 含后续动作且缓存可读，库存 native skill/MCP 演化、评测、activation 与发布后消费仍通过。没有新增付费模型请求，因此上述结论证明模型可见面和协议流程已修正，不声称下一轮真实模型一定采用 bbdev 或产生 RSI 收益。

### 独立领域构造样板与 env-builder（2026-11-06）

将领域构造从宿主静态 import 改为数据边界：`domain-tasks/template/` 提供独立的根合同、公开确定性验收、source/transfer/validation 冻结输入和填写说明；`domain-tasks/buckyball/` 以 JSON 保留原根目标和四项语义验收，以外部 CJS MCP 资产承载 checkout/bbdev。删除 `apps/singularity/examples/` 中四个 Buckyball 任务/装配模块，并将两个领域补丁移到 `domain-tasks/buckyball/patches/`，不把领域启动器放入 `src`。宿主只保留通用声明式装载，解析输入文件并复用既有 TaskSpec、CAS、ToolAsset 与 DSH MCP surface，不增加领域分支。

原始资料可由普通 env-builder DSH session 整合成独立目录。该会话只使用实际消费的 bash 准备公开根合同、冻结案例、验收与预装 MCP 环境，不展示未使用的 jobs 提示，不创建 Task、不写 Method、不开 RSI、不改变运行中的合同；后续新执行读取并冻结结果，不提供热更新。app schema 组合复用 protocol 同版 Zod，删除 app 未消费的 zod 4.6.7 直接依赖。此变更只建立可装载、可调试的领域边界，不证明 builder 的语义判断、真实模型工作流或 RSI 改善。

验证：`pnpm install --frozen-lockfile` 和根 `pnpm verify` 全部通过，**455/455**（protocol 206、runtime 139、app 97、inventory 13），0 fail/skip，project/build/typecheck/lint 全通过。真实 DSH fixture 以普通 builder session 的 bash 从原始资料生成独立目录，随后新执行装载并实际提交，root 经 CAS-only check 得到 verified，没有 reviewer 请求。Buckyball 外部 CJS MCP 实测 checkout、bbdev 业务调用、参数失败与取消退出；独立 lockfile 通过 `--frozen-lockfile` 安装检查。最小样板的三个冻结输入都通过公开验收，错误报告和非整数数值均被拒绝。没有新付费 campaign、真实 BEMU 或真实模型自主构造领域的证据，不能据此声称 bbdev 将在下一轮被采用或 RSI 已改善。

### 领域边界规范清理（2026-11-06）

复核当前数据装载实现后，删除 §19.0 中已经失真的 `DomainAdapter` 伪接口及其 `validateChild`、`resolveAcceptance`、`mountMcpServers`、`seedFor` 等方法描述，改为声明式 `domain.json`/`task.json`/`cases`/`environment` 边界。宿主仍拥有 acceptance 装载、Task/Run/RSI、reviewer 与比较生命周期；领域目录只提供根合同、冻结输入、环境资产和可选评判资料。同步更新 `AcceptanceRef`、发布边界和 `spec-lock`，没有新增运行时 authority 或 helper。

清理后 `pnpm verify` **455/455** 通过，`git diff --check` 通过。该项只消除规范对领域作者的错误引导，不改变当前真实模型证据：仍没有新的付费 campaign、完整 Buckyball comparison 或 RSI 收益结论。

### round12–16 多角度根因复核与宿主减量修复（2026-11-07）

本次从 PR37 后的本地提交、SQLite facts、原生 DSH sessions、requests、CAS MethodPatch 和独立数值重建倒查。开始时工作区没有未提交改动；PR38 远端停在 `0c09c3d`，本地另有七个提交，PR39 为 stacked branch。此前 progress 只记录到 round10，以下以实际归档更正“连续失败都是 workflow 引导不足”的笼统归因。

- round12 的 MCP source 打包先在零请求时因操作者准备目录超过 1 MiB 失败；后续两次运行分别只有 2 和 29 次请求并因 `Request timed out` 结束，只有 root admitted/opened，没有 child、验收或 RSI。规划失败的运行中模型调用了 12 次 `singularity_plan`，反复误用 acceptance、Method、输入对象及 epoch digest 充当 `sourceContract`，证明宿主身份抄写是实际负担；后续加入的 `contextEpoch:"current"` 只覆盖其中一个字段。不能把这部分计为领域算法失败。
- round14 两次运行分别 214 请求、30,450,731 reported tokens 和 108 请求、17,470,414 reported tokens，均以 `Connection error` 退出，unknown=1。首次已有 ISA/容量、BEMU pipeline、独立数值参考三个直属 child verified，说明模型能够形成合理的技术 workflow；没有 root closure 或 RSI。第二次只有 root opened。传输失败按既定宿主边界退出，没有恢复旧根或伪造业务结果。
- round15 共 1,518 请求、303,483,955 reported tokens，unknown=0；其中 reviewer 372 请求、68,863,451 tokens，proposer 54 请求、3,527,911 tokens。两个 source 都因 root reviewer 达到 128 步而未提交完整 findings，以 `verifier-invalid` 关闭，却仍被 `acceptsExecutionRecord: () => true` 放行进入 RSI。第一轮 patch 从公开 root contract 选择 `experiment:acceptance`，但 trace 漏授权该 root provider，precheck 因而拒绝；该 patch 还含非 TaskProposal 的 instanceSchema 字段。第二轮 patch 又复制了 host-owned learning-draft outputs，`AdmissionError` 没被 precheck 当作候选拒绝捕获，直接终止整个 campaign。没有 candidate、paired comparison 或 winner。
- round16 共 429 请求、89,426,908 reported tokens，unknown=0。root Run1 只有 `target-correctness` 失败；Run2 已提交，但 reviewer 在第 56 步启动完整复现后进程终止，只有 `run/submitted`，没有 run/review closure、`result.json`、trace 或 RSI fact。本轮审计时对应进程已不存在。故 round16 不能记作“RSI 部分失败”，它根本没有进入 RSI；也不能把操作者终止留下的开放事实伪造成结算结果。

Task 侧不能再简单归结为模型不知道自己是 workflow 节点。round14 的三路技术分解、round15 的多批派发/冻结交接、round16 的独立参考 child 和 parent 集成都真实存在。持续的问题是：宿主 ID 与调度字段需要模型抄写，probe 失败仍按 `maxRuns=3` 自动购买重试，parent 必须编写任意 shell 验收，且 root 没有稳定的机器可调用接口。正确的分解也会被错误合同和重复调度消耗。

Buckyball 的冻结数据存在更根本的可达成性矛盾。本次按公开 `dataRule`、E4M3/E8M0 与 FP32 范围独立重建，source 四个向量分别有 702、2510、1137、0 个操作数在解码前即超出 FP32；所有 source/public/validation 向量的绝对累加范围也都超出 FP32。pinned BEMU 在 `examples/balls/mxmm/emu/src/mxfp8.rs:108-112` 和 `:161` 分别拒绝非有限解码和累加。round15 的 fold/scale 投影实际换成了另一道题，round16 reviewer 已明确指出冻结 bytes 没有进入 callable。用同一 codes/shapes 将 scale 改为 `112 + ((11*i + seed) % 32)`（112–143）后，独立上界计算中解码和全部累加均保持有限。此项修改会改变冻结根合同，本次没有擅自应用。

本次只实施不需要改变公共 Task/Method 合同的修复：

1. `precheckMethodPatch` 将 `AdmissionError` 与其它候选结构拒绝一样结算为 `rejected`，不再炸掉 campaign；保留 CAS/host 异常原样抛出。
2. `sealPublicTrace` 授权已经在 root contract 公开的 acceptance provider，使 MethodPatch 的 `acceptancePolicy` 检查与 proposer 实际可见输入一致；原生回归直接用独立 root provider 完成 accepted precheck。
3. generic experiment 不再为 `invalid` source 开启 proposer。预算取消仍走原 trace seal 后停止路径，不新增 outcome，不改变既有语义。
4. RSI card 改为优化未来 reasoning/decomposition/interfaces，禁止只为减少步骤把有用 workflow 压成更大的 single-run runbook；同步 framework 与 spec-lock。

定向回归通过：runtime MethodPatch 11/11、generic experiment 5/5、原生 RSI proposer 4/4。随后 `pnpm install --frozen-lockfile` 与根 `pnpm verify` 全部通过：**457/457**（protocol 207、runtime 140、app 97、inventory 13），0 fail/skip，project/build/typecheck/lint 全部通过。测试覆盖 round15 的 AdmissionError 崩溃、独立 root acceptance 的授权与 accepted precheck，以及 invalid source 零 proposer；没有新付费请求、BEMU 执行或真实改善声明。

以下属于需要用户明确确认的合同/实验设计决策，本次未实施：

- 是否按上述有界 scale 规则修正三份 Buckyball case，而不是允许 fold/投影替换冻结输入。
- 是否冻结最小 callable CLI 与机器输出格式，并以领域确定性 checks 替代高价 LLM root review；当前“callable”没有稳定接口， reviewer 只能逐次理解实现。
- 是否让 host 派生 PlanningSketch 身份、MethodPatch.base、acceptancePolicy、默认 instanceSchema 与 learning outputs，删除模型抄写和连续拒绝；这涉及公开协议 amendment。
- 是否停止 probe 的自动 retry，让 parent 根据一次公开结果决定本地集成或显式新 probe；required retry/replacement 保持。
- 是否把 RSI 评测改为多算子/多任务迁移和质量优先指标。当前只有同一 MXMM 的 shape/data 变化，主指标又含缓存 input，完成 comparison 也不能证明跨问题更聪明，且天然偏向少步骤/少复核。

在上述根合同问题解决前，不建议再启动大规模付费 campaign。


### amendment 026 激进减量与真实 consumer 迁移改造（2026-11-07）

用户明确批准修正 Buckyball 根任务、形成新公开协议 amendment、重做质量/迁移判据。以上“待确认”事项现已按批准实施，旧 round12–16 仅保留历史失败证据，不继续作为当前合同。

- Buckyball 三份 MXMM case 的 scale 已改为 `112+((11*i+seed)%32)`，codes/shapes 和 A/B 各自字节索引语义保持旧独立重建结果。零模型上界检查全部有限，source/public/validation 最大保守上界 log2 约 61.615，不再有 FP32 溢出的根合同矛盾。根验收缩为一个 `mxfp8-consumer` 原生 check，冻结 `python3 ball/mxmm.py request.json response.json`、base64 原始输入、C/guard/真实命令记录和四个回归命令；`acceptance.py` 独立重建 bytes，以精确整数参考和保守 FP32 误差界判定，fold/投影不能冒充原输入。没有 LLM root review，也没有四次重复完整复现。
- `domain.json` 现在包含 long-k、smatmul-bias、output-tiling、inventory-transfer 四个 case；case 可覆盖 TaskSpec/acceptance。SMatMul 是不同算子和独立 int8+bias consumer，inventory 是不同非加速器任务。SMatMul 不使用 poly-attention；实际 generated config 证明其部署在 pebble global core 0。独立 checkout 的真实 `smatmul_16x16x32` 和 `smatmul_bias_accumulate` 均出现 PASS，日志保存在 `artifacts/smatmul-consumer-preflight-20261107/`。poly 上 binary_not_found 的部署辨识过程没有被写成支持证据。
- PlanningSketch 的模型输入缩为 PlanningSketchDraft，taskId/runId/contextEpoch/sourceContract 由 host 盖章，旧身份字段由 strict schema 拒绝。MethodPatchDraft 不含 base，host 从 opened Round 盖入；同名模板继承原 acceptancePolicy，新模板继承 source exploration fallback（无 exploration 时 root acceptance）；TaskProposal 使用 host 默认 schema，learning outputs 仍由 admission 派生。旧 `assertProposalSchemaFields` 和 provider 抄写路径删除，没有双格式兼容分支。CAS、真实绑定、验收 receipt、required join 和 active-head activation 保留。
- probe 的 retry policy 改为一 Run 后 terminal，parent 读取公开结果后决定本地集成或显式新 probe；required/root 的 fresh Run retry 和 required replacement 保持。纯 reducer 回归同时覆盖 probe 一次终态、retry 拒绝和 required 祖先预算，现有 required child 原生集成 retry 通过。
- generic experiment 不再以 reported-token 下降产生 improved。主指标改为每 case 的 paired verified consumer fraction，均值至少提高 0.01、各 case/validation 不回退、总 reported-token 成本不超过 baseline 2 倍才可 improved。comparison 新增 tokenCosts，按 arm 分列 input/output/uncachedInput/cacheRead/cacheWrite 和 complete/cacheComplete；缺 cache 元数据为 null，不是 0。UsageRecord/trace 同步保留可选 cache 字段，预算口径不变。
- 零模型 fixture 已执行 MXMM 小形状 CLI 正误路径、SMatMul 正误路径、inventory 正误路径和不同 TaskSpec 装载。generic review fixture 显式保留独立 review 覆盖，Buckyball 自身保持 checks。runtime comparison 直接断言 cache 数字及 null 语义；MethodPatch/RSI 原生 proposer 验证 draft→host 完整候选。上述 fixture 不冒充真实模型工作流或真实候选实现证据。

当前没有启动新付费 campaign，没有新 source、candidate、paired comparison、winner 或 activation，不能声称模型已理解全部 workflow、跨任务能力提升或 RSI 已完成。最终 `pnpm install --frozen-lockfile` 与根 `pnpm verify` 全部通过：**462/462**（protocol 209、runtime 140、app 99、inventory 13），0 fail/skip，project/build/typecheck/lint 全部通过；`git diff --check` 通过。新运行仍须全新执行根、独立环境预检和完整 candidate/baseline/validation comparison。

### 领域调度越界清理（2026-11-07）

沿当前 git 树复核后发现，规范已经声明领域目录是外部数据边界，但 workspace 仍编译旧领域包，并保留领域专用 Task/预算/RSI/activation 循环。该路径使领域算法和验收器反向参与 Singularity 调度，和声明式领域目录重复。

本次删除该旧 domain package、领域专用验证启动器、资源装配和对应 runner/budget 测试；app 与根 tsconfig、workspace lockfile 不再引用旧领域包。Buckyball 与 template 继续只以 JSON、冻结数据、验收脚本和标准 MCP source/manifest/config 进入 `apps/singularity/src/domain.ts`。`loadDomainPackage` 在冻结前统一校验 case/task/criterion/input/output 唯一性及 checks acceptance 的 required check，避免把领域错误推迟到 scheduler 运行中。

验收边界写入 `domain-tasks/ACCEPTANCE.md`：宿主对每个 required check 创建临时目录，物化 CAS 输入/输出，按冻结命令执行并从退出状态生成标准 `PublicReceipt`；脚本不获得 Task 树、Method、scheduler 或 transcript。领域 CLI 仍由外部标准 MCP server 提供，模型只调用冻结的业务 schema。验证：app 定向回归 **95/95**，workspace 为 4 个项目；尚未启动付费 campaign、BEMU 或真实领域运行。

随后复核规范残留的验收表述：删除“进程内领域函数”作为领域验收器及领域直接交付 verifier/scorer 的路径，明确统一 check runner、冻结脚本 digest 和宿主 comparator identity；`spec-lock.json` 已同步新的 `docs/framework.md` digest。这样领域目录只声明数据、TaskSpec、check/MCP 资产，宿主独占调度、验收适配和评测生命周期。

同时清除了 protocol/runtime 的平台探索示例中遗留的 inventory `records/aggregation/totals` 工作流和固定提交输出；示例现在只展示中性的“声明输入 → 可调用 consumer → 父级集成”接口。领域算法不会再从通用 Task 工具 schema 或 explore-child 示例进入模型提示。

本次后续复核没有增加静态门禁。清理了磁盘上被忽略的旧 inventory/domain 与旧入口构建产物；Buckyball MCP 冻结 source 统一使用 `environment/server.cjs`，删除重复的 `environment-source/` 副本。env-builder 仍以新目录独占创建，现会先创建缺失的父目录，保留已有目录即失败的 fresh-root 语义。完整 workspace 测试为 444/444（protocol 209、runtime 140、app 95），build、typecheck、lint 通过；本机 Node 22.23.3 运行 `verify:project` 仅因仓库要求 Node >=24.9.0 失败。

### Node 24 全量验证、环境清理与新 RSI 轮次（2026-11-08）

本次固定 `/home/ROXY/.local/node-v24.9.0-linux-x64/bin/node` 和 pnpm 11.18.0 后，根 `pnpm verify` 全部通过：**444/444**（protocol 209、runtime 140、app 95），0 fail/skip，project/build/typecheck/lint 全部通过。最终集成发现 Summary fixture 仍要求 session 名包含原 Run ID，与 `ce757ed` 的短身份修复相冲突；已改为以超过文件名长度的真实 Run ID 执行原生 Summary 持久化，并验证完整来源身份仍保存在 metadata，usage 与缓存消费不变。定向 Summary 2/2 及随后全量验证均成功，没有增加静态门禁。

当前领域资产只通过通用 `domain.ts` 装载；protocol/runtime/app 生产源码没有 Buckyball、MXFP8、SMatMul 或 inventory 的算法和调度分支。准备材料为根目标/交付物、冻结 source/public/validation 数据、独立可执行验收，以及有消费者时才提供的标准 MCP manifest/config/source 和预装依赖。最小预填目录是 `domain-tasks/template/`；Buckyball 参考目录为 `domain-tasks/buckyball/`，实际准备目录为 `/home/ROXY/code/bb_work/preparation/domain`，MCP SDK 依赖单独保留在 `/home/ROXY/code/bb_work/env/mcp-dependencies`。根验收沿 `domain-tasks/ACCEPTANCE.md` 的统一文件/退出状态接口执行，不给领域脚本调度 authority。

实际 Buckyball 目录可装载，但此前 builder 会话在 30 次请求后中断，未生成 `builder.json`，该准备目录由操作者补齐，不能冒充 builder 完整交付证据。随后使用当前代码、预填 inventory 模板和现成 loader 在全新根完成真实 builder 实测：**17.726 秒、4 次请求、19,078 reported input + 2,452 output tokens、unknown=0**，生成 `builder.json`，source/transfer/validation 装载成功。这证明现成模板的正常准备路径，不证明任意复杂工程都能在相同成本内完成；Buckyball 的 Nix、编译器/BEMU 与商业 EDA 依赖仍由操作者预装。

实际准备配置已注入服务器指南中的 Synopsys VCS W-2024.09-SP1、DC R-2020.09-SP5、PT W-2024.09-SP1 和 `26000@127.0.0.1`。再次通过相同配置进入项目 `nix develop`，确认 `bbdev` 以及 `vcs`/`dc_shell`/`pt_shell` 均解析到预期入口，license 环境保留。没有商业配置的流程沿项目默认环境，focused BEMU 仍使用 Nix。零模型预检的 checkout、bbdev 业务成功、参数失败、取消退出及四个 MXMM 回归均通过，记录在 `/home/ROXY/archives/singularity-v1/buckyball/20261108T-cleanup/preflight-20261108/`；SMatMul 两个真实 PASS 日志已归档到 `buckyball/20261107T165001Z/records/singularity-v1-artifacts/smatmul-consumer-preflight-20261107/`。

新运行根 `/home/ROXY/code/bb_work/execution-buckyball-20261108T-final` 于 **2026-11-08 07:41:09.941 +0800** 启动，绝对截止 **19:41:09.941 +0800**，PID 1040634。使用 `deepseek-flash`、reasoning=max、500k context、40k output，API base URL 为 `https://api.agicto.cn/v1`；凭据只经标准输入注入启动进程，没有写入领域或仓库。预算为 1 Round、12 小时、10 亿 reported tokens、4000 requests、maxActive=4；不恢复失败根或热改活动环境。

截至本次提交前，source 已 verified；fresh `/tmp` 验收实际执行 **5 个 frozen MXFP8 calls 和 4 个 focused-BEMU regressions，EXIT=0**。该过程发现 bbdev 的 `$HOME` 路径限制，source 的交付 consumer 已对自己的独立副本处理，并通过外部临时目录验收；没有改动活动共享基线。RSI proposer 的候选已通过 precheck，candidate long-k 已 verified，当前执行 paired baseline long-k；SMatMul 和两个 validation 还没有完整对照，尚无最终 `round-1.json`/`result.json`、comparison 或 activation，不能声称 RSI 改善。完整 suite 包含 MXMM 长 K/输出分块、不同算子 SMatMul 和不同任务 inventory，足以开展迁移实验，其收益仍须由完整 paired 结果证明。

过期的两轮失败执行目录（清理前约 4.1 GiB + 1.2 GiB）、`/home/ROXY/singularity-next`、旧 EDA/P2E 检查目录及约 201 MiB BEMU cache 已删除；旧 one-off 启动命令也已删除。保留 canonical Buckyball、标准 MCP 依赖、实际 preparation/domain 和活动运行目录。归档根为 `/home/ROXY/archives/singularity-v1/legacy-cleanup-20261108/`，过期执行只留约 11 MB 的调度 SQLite/CAS、原生会话和结果，另留 builder/环境预检记录与 manifest，不保留 checkout/build/cache。

清理中的一次命令未在压缩失败后停止，提前删除了首个旧失败根的辅助汇总；其 SQLite/CAS/原生会话完整保留并通过 SQLite integrity check。launch/round/result 已从删除前的本会话工具输出恢复，453 条辅助请求记录已恢复，其余 10 条原始辅助计量记录未恢复，但全部 **463 次原生 usage** 均仍在归档会话内。`old-buckyball-executions.manifest.json` 明列恢复来源和缺失 ID，不把恢复文件当原始字节证据；活动新轮次没有受影响。最终验证日志与本次环境核对摘要同样归入该归档根。

### 新轮次中断的宿主生命周期核对（2026-11-08）

此前的运行状态只适用于提交时；后续检查确认 PID 1040634 已退出，`round-1.json` 和 `result.json` 均未生成。最后一次结算请求是 649（09:40:45.333 +0800），原生 session 停在 baseline long-k 的 bash job 注册，尚无 tool/result 或 Run closure。SQLite integrity 为 ok，保留 42 条事实；source、candidate long-k 的 verified 不等于整轮 comparison。未耗尽 4000 请求预算，也未到 19:41:09.941 的截止时间。

操作者当时用 Codex 临时 PTY 直接启动 Node，并在 09:40:17.194 结束回复。Codex 本机日志在 **09:41:17 +0800** 明确记录该 thread 的 teardown、Shutdown、Shutting down Codex instance 与 Agent loop exited。官方 app-server 文档说明最后订阅者离开后默认空闲 60 秒卸载 thread，与本次时间线吻合。最后 bash 子任务的 response 文件于 09:43:02 写出，不能据此把已退出的宿主进程视作仍活动。

无模型 OS 实测使用同一 Node 24.9.0：关闭控制 PTY 后，附着进程以 SIGHUP 退出且未写 finally 标记；标准 `subprocess.Popen(start_new_session=True)` 配合独立 stdin 和持久 stdout/stderr，在启动 PTY 关闭后仍正常完成并写出 finally 标记。这证明启动方式的失效机制，**不等于恢复出原进程的退出信号**。最有力的解释是宿主卸载回收了附着终端，启动方式由操作者负责；尚未找到由 Singularity 代码修改触发的异常，也不能仅凭测试通过排除所有代码缺陷。

证据存放于 `/home/ROXY/archives/singularity-v1/legacy-cleanup-20261108/campaign-interruption-20261108/`，包括原始 shutdown 日志摘录、无模型 PTY 对照和带限制说明的 assessment。README 与施工约束补充了独立 OS session 和持久日志要求；没有改动调度代码，没有新增静态门禁、自动重启或恢复机制，也没有在本次诊断中购买新模型请求。退出的执行根保持原样，仅供归档分析。
