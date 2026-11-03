# 2026-11-03 任务验收与工作流修复验证

本次按模型工作能力规划及任务验收范例实施 amendment016。required criterion 在 Task 准入前绑定非空、已授权的冻结配方与参数；本地预览从合同派生，提交后对冻结产物独立复验，逐项报告经 CAS 和公开 receipt 绑定。旧文字验收生产路径、重复 self 验收视图和 `reference` 别名已删除。

输入与交接保留完整授权 InputRef，支持二进制连传两级、tree 叶文件跨批消费。四类 Agent 使用原生 scoped persona；worker/reviewer 读取同一套适配后的完整技能资产。没有新增 workflow schema、父计划快照、检查 registry、authority、fact 或报告账本。

## 无付费验证

最终 `pnpm verify` **497/497**：protocol 210、runtime 140、app 132、inventory 15；0 failed/cancelled/skipped，project/build/typecheck/lint 全通过。日志为本地 `artifacts/takeover-domain-release-verify-20261103.log`。

原生 DSH fixture 覆盖完整 Ref、二级二进制输入、跨批 tree 产物、检查授权与参数拒绝、逐 check 报告身份与读取权限、四角色实际请求、独立复验失败不能被 reviewer 覆盖，以及真实运行中取消后的子树结算与清理。Buckyball app 成功 fixture 覆盖 source→proposal→六个评测 slot→比较→expected-head activation→新 head 消费；这不是付费模型或芯片收益证据。

操作者最终预检 **8/8**：固定 Node 24.9.0、pnpm 11.18.0、DSH 0.2.2-alpha.2，校验源模型/checkpoint/library、9 个技能共 23 个冻结文件，实跑 MCP 成功/参数失败/取消、toy compiler build 与组件 UVM、原生映射正负例、四角色 wire 身份/工具边界及最小数值复验。预检记录实际 prompt/tool schema digest，不声称动态装配文本与独立固定 hash 逐字相等。报告为 `artifacts/takeover-domain-preflight-20261103.json`。

测试前再次逐项核验 P0/P1、本轮 P2 fixture、消费者同步及冗余清理；记录为 `artifacts/takeover-domain-prelaunch-review-20261103.json`。现有唯一子代理随后完成只读复核，未发现新的阻断项。

## 领域检查的实际范围

| 配方 | 计算内容 | 结论边界 |
|---|---|---|
| host-reference | 固定原软件/checkpoint 版本，直接比较 FP32/整数向量 | 原软件参考，不代表加速实现等价 |
| compiler | 原生 MLIR 可达操作、Chip.pb target/core/Ball/ISA | 编译映射，不要求 RTL |
| synthesis | 原始综合报告、Yosys 实例边界及固定 library/corner | 组件指标，不输出可比较的 frontend PPA |
| numerical / integration / implementation / ppa | 实际编译精度、数值、映射至 RTL 及 workload 边界 | 完整 frontend 的既有六项标准保持有效 |

required `task-goal` 仅绑定 delivery 会被领域准入拒绝；delivery 仍用于独立交付身份检查。领域代码不判断自然语言目标是否完备。样本充分性、原软件语义与量化阈值的合理性仍须按冻结 policy 独立审查。

极小 8-bit 寄存加法器的真实 DC compile_ultra/Yosys readiness 通过 18 项检查，覆盖 1 个活跃实例、2 个模块。时间单位取自原始报告；面积按 SMIC180 惯例显式声明，未独立确认物理面积尺度。该结果仅验证报告解析接口，不构成 frontend PPA 比较。

## 真实模型窗口与归档

模型为操作者指定的 `deepseek-flash`、reasoning `max`、700000 context、40000 最大输出，端点为 `https://api.agicto.cn/v1`。凭据仅由仓库外 launch environment 提供。全部尝试共用 **2026-11-03 02:15:16–14:15:16 +08** 的绝对窗口、**10 亿 reported tokens / 4000 调用**上限，退出后用新根，不续跑旧合同或重领预算。

首根 `artifacts/takeover-live-20261103-0216` 的四次 Conv1D 仅改变 persona。前三次独立复验均为 58 cases/512 值/0 差异，第四次 control 在 15 调用上限取消，没有正式 receipt；`comparable=false`、`delta=null`。不能声称 persona 收益。

随后 Buckyball 的三个 child 仅给 `task-goal` 绑定 delivery，技术结果来自 reviewer 临时复跑，未满足正式技术 checks 的要求。因此停止该根并保留失败归档。原软件参考的 40 向量/120798 值/0 差异、真实编译产物等局部复现事实保留，但不是完整验收成功。原根无 root 提交、RSI、比较或赢家激活。

该根最终 **603 调用 / 87844685 reported tokens**，全部结算、unknown=0、pending=0。停止过程留下一个失败 Run 的 sessionCut 与最终原生事件数不一致，归档审计为 failed；没有修复归档或伪造闭合。

补齐 host-reference/compiler/synthesis 配方后重新完成 497 项门禁和 8 项预检。一次临时启动因 `artifacts` 下的模块解析失败，在模型创建前退出，付费请求为 0。修正操作者脚本依赖路径与原始错误记录后，使用全新根 `artifacts/takeover-bounded-20261103-0412`，继续扣除上述消费与已用时间。

该根冻结为计划 C 的有界 Buckyball 原软件参考与真实编译映射集成回归：空 Method，根绑定 host-reference + compiler，由模型自行选择工作单元及集成方式，不预置 child 树。此合同不运行 RSI；它的结果仅用于该参考/编译范围，不能升级为完整 frontend、PPA 或方法收益。

04:15 半小时巡检确认该根自主派发两个 child，分别绑定 host-reference/compiler，均传完整 project/guide Ref。参考 child 已提交，compiler 在独立 checkout 构建。04:22:36 编译 child 在原生 compaction 后的一次模型流以 `Stream ended without finish_reason` 结束，usage 为零；计量器取消整树，同时取消在途 reviewer。发生顺序不证明 compaction 导致 provider 错误。

该根 135 调用全部结算，10233838 reported tokens、2 次 usage 未知；3 个 Task/Run 均按正常取消链关闭，唯一 trace 已封存。终局审计 complete/valid，验证 sessionCut、usage、CAS、trace 及终态，未修写任何归档。没有正式技术验收成功。操作者审计曾因逐页拼接大型 trace 保留底层字符串而内存耗尽，改为每章读取一次冻结字节并核对分页两端后通过；这只修改 ignored 审计脚本。

后续新根 `artifacts/takeover-bounded-20261103-0427` 使用相同生产代码和有界目标。启动前从共享预算扣除前两根的 738 调用/98078523 reported tokens，另按每次未知请求 700000+40000 的最大模型额度预留 1480000 tokens，以及 5000000 在途尾部余量；绝对截止时间保持 14:15:16。

该根的独立参考 child 已正式 verified：host-reference 的 78 项检查通过，覆盖 12 cases、3 个组件、29686 值，超容差为 0，maxAbsError=1040。冻结 FP32 容差为 rtol=1e-4、atol=1e-5；最大 error/allowed 比为 0.262，不能将大数值的绝对误差写成逐值零差异。reviewer 从固定原软件和 checkpoint 独立重建的参考向量逐字节相同；禁止导入 torch/cosyvoice 后重跑独立 actual，额外 24413 值 probes 仍无超容差，+1 扰动负控恰好产生 1 个 mismatch。F0 组件按合同使用 FP32，完整模型 inference 的 FP64 转换已明确披露；不代表完整推理等价。

child Evidence digest 为 `sha256:7d8c0926c0c16aa9da19d67c470bb379135051baafc236c555fd3abae181c830`，公开 receipt digest 为 `sha256:e925c046d0de6658ba0bb5db7eed453de12e57b86f7a0ea6a7d2883b45c426dd`，正式 check report digest 为 `sha256:bf011ed99ff0c85eaf3232907b3947172b23630046e061c3e9b0e4c70aaee924`。`reproduce.sh` 未带可执行位，使用 `bash reproduce.sh` 可成功复现；README 中直接执行脚本的命令存在交付瑕疵。

只读复核确认 child 的 58 个冻结叶（result 57、skill 1）与 parent 自动挂载内容逐字节一致；parent 从双方冻结数据交叉核对的 12 个输入和 29686 个参考值全部精确相等。parent 的 crosscheck JSON 中，展示用的 child Evidence ID 将 `ba38` 手写成 `ba36`；digest、实际读取路径和正式 child Evidence/receipt 均正确。该展示 Ref 本身不准确，不将其写成完整正确的授权 Ref，也未修改冻结产物来掩盖笔误。

## 最终 Buckyball 结果

当前根于 **05:07:04 +08** 完成，root 与 child 均正式 verified，2 个 Task/Run 全部终结。空 Method 下，模型自行选择保留参考/编译技术工作，再派发独立参考 child，并消费其冻结结果完成交叉核对；没有预置 child 树。该观察支持本次输入、检查、冻结交接和独立集成复验通路，不能单次推断模型能力或 persona 收益，也不证明多层工作流发现。

| 正式报告 | 结果 |
|---|---|
| root host-reference | 108 checks，17 cases，3 stages，56186 值，0 超容差，maxAbsError=976 |
| root compiler | 12 checks，1 route，3 recipe operations，173 mapped operations，1 target |
| child host-reference | 78 checks，12 cases，3 stages，29686 值，0 超容差，maxAbsError=1040 |

root reviewer 在自己的全新 checkout 从源码构建 toy compiler，重新编译提交的 recipe，生成 mapped MLIR 与冻结提交逐字节相同；实际 route 为 `buckyball.fp32_matmul → buckyball.matmul_f32`，target/core 为 `toy`，Ball 为 `MxmmBall`，ISA 为 `MXMM_F32`。独立生成的 Chip.pb 仅有内嵌绝对 workspace 路径不同，profile/core/Ball/ISA 相同。它只编译一个 matmul，未包含 Linear bias epilogue，也没有 RTL 执行或完整 frontend 映射。

数值范围须同时保留失败观察：root 交付的 12 cases 及 reviewer 新增的 5 cases 通过；另有交付中明确排除的 6 个边界输入，以及 reviewer 额外生成的 1 个 F0 输入，超出冻结 FP32 原软件容差。reviewer 用 FP64 对照将这些差异归于近抵消下的 FP32 舍入，但这些输入并未因此变成通过。正式通过只覆盖表中 17 cases，不代表任意输入、完整模型精度或硬件数值等价。

root Evidence digest 为 `sha256:72793c63e4c88ce17f20b3b6f0935779fe693d7adb9239d0c3524fe48bf45ae0`，receipt digest 为 `sha256:0ad0d975e6b5f5e27b875e6e5a7e3d11463af72f2d94b8f4daab0ca38c326946`。host-reference 报告 digest 为 `sha256:a0c71dea02a1474013539132dd29ffc27a42373fb11a8599bef70fa582b87002`，compiler 报告 digest 为 `sha256:cfd0a09fe1e5f6aa7831453d8dcb2bea5f0e31ff8e73383d704d3e6d420a8626`。

终局只读审计 `artifacts/takeover-bounded-20261103-0427/operator-final-audit.json` 为 **complete/valid、issues=[]**，核对生产源码哈希未变、原生 sessionCut/usage、合同/manifest/CAS、两份 root 报告和一份 child 报告身份、公开权限以及唯一封存 trace。root `Evidence.inputs` 恰为 2 个合同输入 Ref + 58 个 child 冻结叶 Ref = 60，完整 id/digest、顺序与 CAS 字节身份全部正确。trace 包含 190 个授权对象、7 个章节，digest 为 `sha256:e455f112bbb3019eb014bee25a78e270892462e14311e9e6489c7463ccf99f1c`。历史首根的归档缺陷仍原样保留，并未被当前根的审计通过覆盖。

本根 **228 调用 / 37114919 reported tokens**，全部结算、unknown=0。全部真实尝试合计 **966 调用 / 135193442 reported tokens**，pending=0；历史 2 次未知用量另预留 **1480000 tokens**，合计仍低于 10 亿 tokens 与 4000 调用，原 12 小时绝对窗口内完成。没有打开 RSI Round、比较候选或激活赢家；当前成功不构成完整 frontend、PPA 或 Method 改善证据。

## 完整真实轮暴露的错误放行及修复

完整根 `artifacts/takeover-full-real-20261103-0750` 使用空Method和完整六项frontend合同，观察到两级自主派发、完整project/guide Ref和技术checks。Flow提交把固定原生FP32参考改为FP64，actual也以FP64生成，但仍标FP32。reviewer独立复现1839/3840原FP32超差后仍pass。正式Evidence `sha256:cfc7b4c51e202a8d2ef82d1435caf0f4c3b5547d8721dfb88938def1a7d2e089`与receipt `sha256:999cdd770db4cf0ecbac5892b31281d236a974e26f41068b64ac143dc13aa2bf`原样归档。它证明旧数组比较器的oracle可被替换，不能证明完整修复有效。

该根08:19停止。operator与DSH同时处理SIGTERM使进程在业务封存前退出，留下partial状态；无完整result/trace，不补写、不恢复。HiFT两组初始输出在容差内，但reviewer扩展长度/streaming用例发现截断和差异；不能把局部初始通过视为完整通过。compiler仍在真实构建时停止；无root提交、完整六项验收、RSI比较或赢家。全部累计1532调用/216722725 reported tokens、unknown3，继续计入同一12小时窗口。

修复后，host-reference与numerical均由冻结领域runner直接调用固定原软件与权重产生expected；reviewer只提供typed输入和独立复现actual。原生FP32合同、整数exact与compiled precision规则保留，删除自填reference/checkpoint/comparator作为oracle的路径。领域runner不复制模型算法，原HiFT内部FP64步骤照常保留。新recipe digest与script在现有CAS依赖链冻结，reviewer首请求前取得完整可执行资源。

真实失败回归 `artifacts/oracle-regression-20261103/regression.json`：0750同一Flow输入/actual，host-reference与numerical均拒绝，**1839/3840超差，maxAbsError=0.0030074119567871094**；归档原生FP32输出作actual时**3840/3840精确一致**。这是针对真实错误放行的正负对照，不等于完整frontend/PPA或Method收益。PR继续Draft，后续完整真实验收通过前不合并。

最终本地 `pnpm verify` **498/498**、0失败/取消/跳过，project/build/typecheck/lint通过；真实原生API smoke与Flow正负回归完成。预检首次7/8因operator缺少VCS PATH失败，按服务器指南补齐原生启动环境后完整重跑 **8/8**，包含真实UVM与compiler构建、MCP参数失败/取消，不跳过检查。提交 `b0bbdbee9438aeacd583309a299d108900c9e22f` 的 [GitHub CI](https://github.com/mctang985211-coder/singularity-v1/actions/runs/41555482478) 同样通过。

修复后完整新根 `artifacts/takeover-full-native-oracle-20261103-0858` 于08:58:43 +08开始，继承全部历史消费、原14:15:16截止、剩余2468调用/776057275可分配tokens。启动只读审计partial/valid、issues=[]，生产源码快照未变。原02:15:16起点的30分钟watch继续，下一09:15:16。初期root触发READ_SELF_FIRST与PLAN_FIRST后自行完成self/计划再探索；不记作首次操作成功。尚无完整真实验收结果，PR保持Draft。

09:15:16定时快照为7个Task、两批派发、最大深度2、1个冻结提交；shared1843调用/248712015 reported tokens、unknown3。根六项检查保持，完整project/guide Ref从self到直属合同再到Flow用例孙任务均一致，已启动Run目录独立、输入物化字节匹配CAS。审计`operator-audit-0915.json`为partial/valid、issues=[]、生产源码哈希未变。ONNX任务曾实际尝试FP64累加，冻结提交声明其最终actual使用FP32，独立review仍在核验；这里不把对照试验或自述记成通过。

首份正式通过来自LLM数值child：Evidence `sha256:3837b4f619d20202e295f917197342fd9cad9a5755230ed1318a49b1d74e35b5`，check report `sha256:abee7550d2f441dffffd64651726f831a63e4cc0a49a5014de95e1dd06b19839`。原4例加reviewer独立新增7例，正式共70checks/11cases/162996值，0mismatch、maxAbsError=0；通过使用原生固定oracle与checkpoint-only独立executor。手写attention分支的数值差异保留，不能将SDPA分支通过升级为该分支或真实硬件通过。09:26审计核对Run/Task关闭、sessionCut/usage及receipt/check CAS身份，partial/valid、issues=[]；整个根仍未终结，没有完整frontend/PPA/RSI成功。

0858根于09:34:41经SIGUSR1正常取消。ONNX reviewer重跑提交case通过，但新增有效campplus输入T16出现6/192超差、T8出现8/192超差；reviewer以FP64对照解释后将其排除在正式分母之外，仍正式pass。这是第二种真实错误放行，原生oracle身份正确不能保证用例覆盖正确。原Evidence为`sha256:06cc7974c0a381db7de5b24ef1caaa1feca69bcc2335b254966905ca0b7b7070`，report为`sha256:4f1665b8eb243943040876a7a33cc9a9a8b72a8085740aeb40f248bb22438743`；全部证据及停止原因保留。HiFT另有9个额外probe中34/65760值超差（final-t28为31、loud-t14为3），取消前无正式结论。

正常取消终局审计为complete/valid、issues=[]，7个Task/Run全部关闭，2 verified、5 cancelled；唯一trace digest为`sha256:25a430074698f15d76c7adeb86fdd50c2283bab775db028ea7f7cf94ec0911e3`。本根694调用全部结算、96934305 reported tokens、unknown2。共享消费现为2226调用/313657030 reported tokens、unknown5、pending0，仍计入原12小时窗口。没有完整frontend/PPA/RSI成功，PR38不具备合并条件。

针对分母缺口，领域配方冻结25个公开完整typed输入，覆盖8stage；每条数值check的stage由合同固定。宿主从CAS为每条check重新物化交付，执行数值入口的全部输入；不接受reviewer选择输入、提供actual数组或更换程序。host-reference使用同一suite的caseId向量。报告保留每例输入身份、expected/actual、指标及失败，已知有效失败不再作为可排除的诊断。FP32/整数阈值、完整root六项要求及量化语义审查保持。

`artifacts/suite-regression-final-20261103`对原ONNX CAS代码仅加JSON CLI适配，全部3例/576值执行，10个超差并拒绝；原生参考向量正控0超差。candidate使用固定referencePython，与原review的系统python3环境不同，不能声称精确重现原6/8的舍入数字。首次脚本要求T8也必须失败而断言失败的记录原样保留，未改case或阈值。定向42项及完整app成功fixture通过，后续完整verify/预检和真实根另记，不能将此回归当作完整frontend成功。

扩展归档回归对HiFT执行全部6例/30720值，精确复现34超差（final-t28为31、loud-t14为3）并拒绝；原LLM程序hidden/logits各3例、合计76081值均精确一致。全suite原生检查首次发现两条旧tokenizer T16/length12输入在原ONNX模型触发3×4广播错误；原始失败保留。最终仅将这两条输入的length改为实跑成功的15，保留全部tensor值、形状和其他字段，caseId同步l15，provenance明确记录这项operator修正。所有已知有效CAM++/HiFT数值失败仍必跑。固定Python3.10.20/NumPy1.26.4与原系统Python3.14.6/NumPy2.5.1的版本差异已核实。

最终复核修正全部case程序失败的零比较值报告schema，并用清空后的目录物化CAS交付；相应回归42/42通过，覆盖reviewer预放未冻结dependency不能影响结果。首轮完整verify的app成功fixture在并行负载下超出180秒，测试预算按全8stage工作量提高至360秒；中间verify因suite调整主动停止，最终门禁结果另记。没有降低用例数、正确性断言或业务阈值。

最终冻结版本的`pnpm verify` **503/503**，protocol210、runtime140、app138、inventory15，0失败/取消/跳过，project/build/typecheck/lint通过（artifacts/takeover-suite-frozen-verify-20261103.log）。`artifacts/suite-extended-release-regression-20261103`的原生正控覆盖全部8stage/25case/128831值、精确一致；`artifacts/suite-regression-frozen-20261103`的ONNX负/正控和扩展HiFT/LLM报告绑定相同recipe digest `sha256:59ec9223ad38d4f5bcd1ffb8b9471383c38103637c3d3fafe99b8a005ad667d2`。10:15:16巡检准时落盘，无新增付费请求；完整工具链预检仍在进行，新真实根尚未启动。

最终完整预检 **8/8**，记录artifacts/takeover-suite-ready-preflight-20261103.json，绑定上述当前recipe；真实UVM、compiler build、MCP参数失败/取消均未跳过。逐项核验与冗余删除记录更新为artifacts/takeover-suite-prelaunch-review-20261103.json。源码提交e766a07已推送PR38；10:23:44 +08启动新完整根artifacts/takeover-full-fixed-suite-20261103-1023，空Method与完整六项验收不变，继承2226调用/313657030 reported tokens/unknown5，最多剩余1774调用/677642970 tokens，截止仍14:15:16。只读启动审计partial/valid、issues=[]、源码快照未变，root经约束反馈补齐self/计划后继续实际探索。下一定时巡检10:45:16。尚无完整真实验收结果，不具备合并条件。
