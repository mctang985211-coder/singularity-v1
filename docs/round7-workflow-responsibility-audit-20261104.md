# round7：实现职责在任务树中的丢失

审计对象：`artifacts/round7-workflow-planning-20261104-122838`，冻结源码 `5673c53`，round1 的三个 root Run。仅检查归档、冻结产物和当前消费者源码，没有新增模型、编译或 EDA 测试。

结论：root 能读到要求，且确实认识到 recipe 必须连接仓库接口；随后因未经实测的成本判断主动缩减实现范围，把配置、算子清单、数学参考和已有算子测试当成可提交的 frontend。child 合同没有承接完整执行链；root 接手后也没有补齐。retry 未正确消费失败证据，独立 review 又发生相互矛盾的放行，导致后续主要修 PPA。同一 recipe 原样提交三次。不能用“出现多层树”证明 workflow 问题已解决，也不能仅用“任务过大”解释这些具体遗漏。

## 要求是否可见

root 合同 `07749db8…` 的 implementation 明确要求：

> connect model recipes and RTL through current repository interfaces

component-verification 还要求每个模型阶段都有实现和组件证据。完整合同由 root Run1 的 `singularity_read(kind="self")` 返回，session seq 11/12、19/20；后两次 Run 返回同一合同。没有观察到要求被 runtime 隐藏或丢页。

领域 guide `abfa523b…` 明确要求测试 consuming recipe/dataflow，区分结构生成、综合估计与实际功能；它没有排除 compiler 或可执行接口。合同只排除全芯片仿真、whole-model BEMU、P2E/FPGA 和物理后端；没有排除代码生成、小组件或子图执行。也没有要求一定采用 MLIR：C/ISA 驱动等实际消费路径可以作为实现选择，不能把“没有全模型 MLIR”当成放弃所有执行接口的依据。

## 实际职责树

SQLite `task/children-admitted` 是准入事实；规划里列出的候选 child 不等于实际派发。

| 派发者 / 事实 seq | 实际职责 | 与缺失实现的关系 |
| --- | --- | --- |
| root Run1 / 4 | 原模型参考；workload/拓扑分析 | 生产原模型证据和设计依据，不负责目标执行实现 |
| workload child / 7 | Balls、core、bank 调研 | 调研仓库能力，不负责 recipe lowering |
| root Run1 / 23 | 修正后的 workload；`7cdddd77…` 芯片配置与 recipe；MXFP8 算子验证 | 唯一实际派发的 recipe 实现合同已被收窄为 JSON + Python 数学执行器 |
| 修正后的 workload / 27 | 参数与 FLOP、Flow/HiFT workload、内存可行性 | 更深层节点继续做分析，不是实现节点 |
| root Run2 / 51 | `932c9740…` 各阶段验证；SRAM PPA 模型 | 没有派发 recipe consumer、目标 host 路径或合法指令生成 |
| 验证 child / 54、66 | text-prompt、LLM、Flow、HiFT、output 五个阶段的参考/算子验证 | 合同要求通用 Balls 和原模型 host-reference；并未分到完整目标阶段实现 |
| root Run3 | 没有 child | root 本地修 PPA；原 recipe 保留 |

因此，不是完整实现职责沿几层传递后才消失。主要缺口在 root 写直属合同和本地集成时已经出现；下层基本完成的是被缩减后的验证范围。

## 三个缺口的形成过程

### 1. compiler / 可执行 consumer 从未成为实际实现职责

root Run1 的已提交规划（session seq 457，后续 seq 599）把 `compiler/MLIR recipe build` 写成 excluded by scope / out of scope，并将 compiler lowering 当成报告中的 gap。这不是 operator 合同给出的排除项。

root 派给 `7cdddd77…` 的合同规定：

> declarative mxmm micro-op mapping per stage plus a pure-python executor

`recipe-consumer` check 实际调用 `emu.run_case(frozen[0])`，比较误差和子任务自己报告的 bound；它没有调用仓库 compiler、ISA driver 或 BEMU，也没有要求这个函数读取 `stage-ops.json`。因此名称虽叫 consumer，该检查不能证明目标仓库消费了 recipe。shell 检查通过只证明它写出的局部条件成立。

该 child 因 parent 同时要求 `inputChannels=5` 和 12 个 accelerator 而正确提问、blocked。root 承认应为 10（session seq 568），承诺重发修正合同，但随后没有重发同职责 Task。root 最终规划 seq 1457 说明未使用被阻塞的芯片/recipe 产物，改由 parent 自行实现。最终 generator/recipe 确为 parent 产物，不能说这部分已经由 verified child 完成。

root 自写的 `recipe/validate.py` 又只检查同源 workload 名称、形状、tile 数和 Python 数值函数。`check_numeric()` 不把真实 recipe 指令交给 repository consumer。`recipe/REPORT.md` 最终仍把 compiler/MLIR/BEMU 接入列成“下一步”。没有任何已准入 child 合同负责关闭这个缺口。

### 2. bank / K / 累加链被“形状覆盖”等同替代

最终 `recipe/build_recipe.py:29` 的 `tile_plan()` 只分 M、N，明确 `K stays whole`；`k_blocks` 是数量元数据，不是 K-panel 的执行安排。bank_rule 只给 lhs/rhs 的编号公式，未提供写 bank、col 和累加链。`tile_op()` 对 workload 的 GEMM/attention/conv 一项生成一个所谓 micro-op，没有生成合法 ISA 指令序列或权重/调用绑定。

`validate.py:20` 复验同一组名称、形状、覆盖和 precision；它没有检查真实 bank 容量、A/B/C 三 bank、指令字段或数据移动。`check_numeric():73` 用独立小矩阵调用 Python 数学函数，不执行这些大 K 的 recipe 项。于是“验证通过”与“不可能装入实际 bank”可以同时发生。

对冻结 JSON 进行只读复算，与 Run3 reviewer 的结果一致：

| bank 容量 | B 超容量的 recipe 项 | A 超容量的 recipe 项 |
| --- | ---: | ---: |
| attention 16 KiB | 229 / 330 | 66 / 330 |
| ffn 32 KiB | 220 / 330 | 53 / 330 |

生成器按 16×64 tile 携带整个 K；MXFP8 B 占用 `64*K*33/32` 字节。`hift_upsample_stage0` 的 K=8192，需要 540672 B，约为 attention bank 的 33 倍。330 项实际上是高层算子描述，不能以“micro-op”名称充当已可下发的指令。

不要求每条合法指令都必须有 K-window：仓库已有 packed-panel 普通 MXMM 和 window 两种路径。缺的是根据实际容量选择并生成合法分块、first/last、地址与搬运。只在 JSON 中补字段名仍不足以实现该职责。

### 3. host-offload 被清单和参考测试代替

generator 对非 GEMM/attention/conv 只执行 `host.append(op['name'])`（`build_recipe.py:89`），得到 LLM 247、Flow 5、HiFT 6，共 258 个条目；这不是可执行 host 调度。

Run1 reviewer 确实指出这些 offload 没有交付实现，且 controller RVV 与实际 plain rocket 配置不符。Run2 root 派出的验证合同则要求通用算子和 host-reference，验收主要检查阶段名、证据 hash、PASS token、文件和 tolerance；`implementation_evidence` 甚至只检查非空、路径前缀，没有证明这些源码消费了目标 recipe。该 child 的输入只有 project/guide，没有 root 的实现或 recipe 冻结产物。

验证 child 在自己的规划（session seq 353、424）和最终 REPORT 中清楚写明：仓库没有 CosyVoice3-specific Ball dataflow，这些是通用 Ball contract 和原模型数学参考。它没有将这个事实提问给 dispatcher，root 集成后也没有补一个实际阶段执行职责。

应纠正先前“258 个操作直到最终完全没有代码”的笼统表述：Run2/3 已有原始 CosyVoice 软件、host-reference 脚本及其数值对照；缺少的是它们在所声明目标实现中的执行绑定、与加速器交接和 recipe 调度。不能把“原模型算法不存在”和“目标实现未接通”混为一谈，也不需要无理由重写可复用的原算法。

## retry 与 review 为何没有收敛

1. **Run1 review 找到了核心缺口，但 Run2 root 没读详细 receipt。** Run2 session 中没有任何 `singularity_read(kind="evidence")` 调用；`feedback` 返回的是父子反馈，不是上次 root 的逐项验收。启动 `lastAttempt.reason` 仅列出四个失败 criterion 名称。已有 worker card 明确要求 retry 读取上次 evidence，工具也支持；该行为要求没有被遵守。root 按局部报告和失败项名称重新解释 implementation，主要补 elaboration/synthesis 和阶段测试。
2. **Run2 reviewer 给出自相矛盾的 implementation pass。** 其原生 `buckyball_review_submit`（review session seq 1340）同时写出 `there is no compiler/lowering/driver that consumes the recipe`、Flow/HiFT 指令流不可执行，却提交 verdict=pass。组件项也在明确没有任何 recipe micro-op 功能测试的情况下判 pass。这是独立领域审查的语义错误，不是 runtime 将 fail 改成 pass；adapter 对 implementation 保留了模型 verdict。
3. **Run3 root 因而把剩余工作收窄为 PPA。** 规划 seq 43 明确说 Run2 已过五项、只失败 PPA。它后来确实在 evidence seq 85/86、91/92 收到上述“无 consumer”的详细理由，但没有重新打开对应职责；第二页仍有 `nextCursor=8192`，它也没有读完后续页。
4. **产物 hash 证明执行链未返工。** 三次冻结提交的 `recipe/build_recipe.py` 均为 `174d220f662e7cc171f6942f8d564f2838a9da83092493317facecd8a1591165`；`recipe/stage-ops.json` 均为 `e12458025315f14342fa87dad7763ba5d3a71c28eebd53032b62a97aca975cfe`。330 个条目、1434633 个 M/N tiles 没变。Run3 review 最终又因实际不可执行而判 implementation fail。

三次 root receipts：

| Run | implementation | component | PPA | receipt CAS |
| --- | --- | --- | --- | --- |
| 1 | fail：无实际接口、host 路径等 | fail：仅 mxmm 等局部证据 | fail | `475a2abd8a651d18bac7ad406bef8e30925715bf5d2f3f4ad8566c780d6f971d` |
| 2 | pass，理由却明确实现缺失 | pass，理由却明确不测 recipe | fail | `5f672550f080cae0a3045135ef59e9c188cd39edde0faa721746ec712c1d5aeb` |
| 3 | fail：bank/K/链/consumer | pass：通用算子/host 参考 | pass，附模型边界 | `b4e1714248ed15c775b4a020a1c7826e141a5ccb78f5e186245d1e6db3418327` |

这些对象位于归档 `execution/domain/objects/`。第三轮通过的 component/PPA 不会修复未变 recipe，也不证明完整设计可运行。

## Singularity 界面的具体问题

- 芯片/recipe child 的已提交规划 seq 45 将 `canDecompose=false` 解释为“没有授权创建子任务”。此前 context seq 35/43 的 denialCodes 实为 `PLAN_FIRST`；规划后的 seq 49 已为 `canDecompose=true`，并持续如此。没有真实的深度/Task/权限拒绝。它把暂时的操作前置条件误解为永久职责限制，之后整条配置/recipe 链均本地执行。这是模型可见状态及引导仍存在误解的直接证据。
- Run3 root 考虑派发 PPA，随后因不清楚如何把上一 Run 的冻结输出作为完整 InputRef 传给 child 而改为自己执行。宿主 `run-controller.ts:40` 已将 `previous.outputs` 纳入授权；但 worker card 只说从 self/direct results 复制完整 InputRef，`readChildData(evidence)` 返回 raw Evidence.outputs Ref，不返回宿主实际使用的 id/path/access InputRef。初始 inputs 和直属结果有完整暴露，previous outputs 的界面不齐。root 也没有读完 evidence，不能将其所有输入困惑都归为宿主禁令。这是跨 retry 再分解的可用性缺口，不是实测派发被拒绝。
- 框架能执行 direct-child、跨批、feedback，不代表生成的合同保留了父目标。当前 prompt 已说 actual consumers 和 local pass 的范围，真实运行仍发生上述语义缩水；不能据此宣布“模型已正确使用 task 架构”。相反，也没有证据表明增加树深、Task 数门禁或预制领域树能解决它。

## 环境与参考文档的责任边界

仓库已有 `examples/balls/mxmm/workloads/isa/mxmm.h`（三 bank、first/last、window 的 fullK/startK），`arch/src/main/scala/Unit.scala` 的真实消费者断言，以及 bank-capacity/window/chain C tests、MLIR tests。Run3 reviewer 独立构建并运行了 15 个 BEMU ELF，包括容量和 window/chain。原模型、checkpoint、torch oracle 也多次成功复现。因此合法分块、ISA 接入和小子图验证不属于“缺环境而根本不能进行”。完整 CosyVoice lowering 的成本与全部可行性仍未被这轮证明，不能反向宣称一定能在预算内做完。

`tapeout.runMain` 缺失是实际 SRAM/PPA flow 问题；它没有阻止 C/ISA/BEMU 路径，不能解释未写 consumer。project 暴露商业 EDA 指南和路径，root 也读到 DC/PT 信息；没有实际 `bbdev dc` 调用，冻结报告使用 Yosys/OpenSTA。不能仅凭 PATH 或选择开源工具断言商业 EDA 不可用，更不能断言商业 EDA“只会增加等待”。

root 读取过项目参考文档。`chip-designer` 有“默认不负责 compiler/ISA”的角色文字，`model-port`、`ball-align` 又要求 compiler 与实际执行；root 合同明确这些文件的角色和门槛不覆盖 Task。它们未被挂载为 skill。根因轨迹中可见未经实测的编译成本顾虑和自行缩范围；没有消融证据能把偏离单独归因于某份参考文档或工具列表。

## 下一步修复的依据

应优先解决通用 workflow 的职责保真、retry 失败证据消费和上述状态/InputRef 界面问题，同时纠正领域 review 把明确缺失的 required 条款判 pass 的行为。领域 recipe 的自检属于模型本应编写和校验的产物，不能由操作者预制完整非 root 验收或固定实现树来替它完成。

成功证据应是：模型自己为仍未满足的父目标安排实现职责，并通过一个实际仓库消费者验证所交付的 recipe/host 接口；引用已有测试或增加 JSON 字段不能代替这个证据。先以现有轨迹定位最小改动，再决定新测试范围；本审计没有修改生产代码或重开真实测试。
