# Buckyball MXMM Ball 测试集

本次替换整模型芯片前端任务。round7 根因与具体归档见 [职责审计](round7-workflow-responsibility-audit-20261104.md)，历史执行数字保留于 [进度](progress.md)。下一轮选择 Ball 层，定位可执行分块与消费接口，避免把全模型实现、芯片拓扑和 EDA 缺口捆为一次验收。

## 问题与完成条件

模型为现有 MXMM Ball 实现可调用的 MXFP8 `C = A * B^T` 分块程序。输入是 row-major E4M3 codes 与每行每 32 个 K 元素的 E8M0 scales，输出 FP32。支持 M=1 或 16 的倍数且不超过 64，N 为 16 的倍数且不超过 80，K 为 32 的倍数且不超过 4096。实际 bank 为 1024 × 128 bits，16 KiB；scale bytes 和输出 base 同样占容量。模型选择 packed panels 或合法窗口，不要求每条指令都有 K-window。

交付须将输入经真实 packing/tiling、三 bank、DMA、first/last 累加连接到仓库 ISA，编译 RISC-V ELF 并在选定 core 上运行 BEMU。JSON 清单、独立 Python 数学、stock ISA 测试均不能替代新 consumer 的执行。函数接口、算法、修复、数值 oracle、子任务与非 root 检查全部由模型产生。没有固定求解树、强制分解深度或任务数。

| 场合 | M/N/K | 要暴露的错误 |
| --- | --- | --- |
| source | 32/48/1056、64/80/2048 | 实际输入/输出跨 bank 的完整消费链 |
| long-k（公开评测） | 1/32/4096、16/16/32 | 长 K 累加与最小块、连续两次调用 |
| bank-crossing（公开评测） | 32/48/1056、16/32/960 | A/B 容量、32 对齐的 K 尾块与 scale 布局 |
| output-tiling（验证） | 64/80/2048、48/64/96 | C 超出单 bank、M/N 输出分块与累加状态 |

shape 不是预制答案。reviewer 还须选择合同范围内的额外维度和非均匀有符号/零 codes、不同有限 scales，独立解码参考并检查真实 target 输出、guard 和重复调用。精确可表示子集要求完全相等，其余要求有依据且实测的 FP32 误差范围。验证 case 单独冻结，但这是公开可信本地实验，不宣称隐藏数据隔离。

根验收为 executable-mapping、target-correctness、regression、delivery，四项全部 required。缺 consumer、未执行目标或任一 required 条款缺失即失败。独立 reviewer 必须在新 checkout 应用全部补丁并重建，不能修候选。现有 capacity/window/chain 回归只证明自身覆盖；若改 RTL/compiler，还须复验改变的边界。BEMU 不证明 RTL 等价。此次没有新自然语言判定器；独立 LLM review 仍可能误判，必须审查实际命令和产物，不能把策略文字当作已改善证据。

## 领域任务何时准备齐全

准备齐全意味着：固定公开问题和根验收、源码/配置身份、可独立复制的依赖、实测成功与失败的业务工具、预算/deadline，以及 RSI 用的冻结 cases 和 comparator。它不要求操作者预写设计路线、子任务合同、非 root 检查或模型的实现。领域问题规定外部交付，Method 才是在探索中学习的工作方法。

入口是 [buckyballBallTaskSpec](../apps/singularity/examples/buckyball-ball-task.ts) 与 [campaign](../apps/singularity/examples/buckyball-campaign.ts)。初始 Method 的 templates/skills/tools 全空；exploration catalog 提供 checkout/bbdev、领域说明和协议。项目 `.agents/skills/` 仅在 root 合同中给参考文档路径，不注册或挂载。其角色、审批和流程门槛不覆盖本合同。只有 Singularity 自产 Method 资产可走 skill 注册路径。

固定 Buckyball 准备副本 `07a85ea2898e59a80d0dfbb30520d8ed5c39390a`；stack `f8af074a28eb83cc58424fe08eda2a67c472b73a`；bbdev `207c4b73998a1d34279d854d7b3f52d86721e86d`（含既有领域工具修复）。本地 `artifacts/buckyball-mxmm-ball-20261104/project.json` 仅提供 Ball 所需来源、环境和预检身份，不带 CosyVoice checkpoint、旧 seed 或整芯片验收。baseline 保持只读，Task/reviewer 各自用独立副本。预装 LLVM 为只读依赖；不共享候选源码和 build 输出。

领域 MCP [checkout/bbdev](../apps/singularity/examples/buckyball-mcp.ts) 直接组合 `cp --archive --reflink=auto` 与项目内 `nix develop`，没有 runtime 领域分支。使用既有 poly compute tile 的 attention core（生成配置的全局 index=2） 作为 Ball 宿主，固定配置而不重新设计 core/chip。业务预检命令如下，具体结果见进度与本地 preflight 记录：

```text
checkout(project=<new absolute directory>)
bbdev(project, ["workload", "--build", "--chip poly --ctest"])
bbdev(project, ["bebop-bemu", "--sim", "--chip poly --core-index 2 --binary poly-attention-ctest-mxmm_bank_capacity_test-baremetal"])
```

相同路径还需实测 mxmm_window_test、mxmm_window_chain_test、mxmm_window_rows_test。配置缺失必须返回真实失败，修正后能正常安装；帮助/握手不能代替这些业务操作。长调用的原生取消/进程退出已有 DSH fixture 和之前的真实 MCP 预检，不新增 watchdog 或恢复管理器。

## RSI 与证据

比较指标改为通过完整功能验收的 Task 子树 reported tokens 均值，包含子任务与重试。两边全部 verified 且计量完整才能比较；平均至少节省 1000 tokens，且每 case 不退步。proposer/reviewer 的额外请求仍计入整轮预算，不能把该子树指标说成全 campaign 成本。固定 Ball 软件分块不适合强求硬件 PPA 改善，因此删除旧 PPA scorer 和取代失败原因的 PPA 转换，不伪造性能指标。没有放松 root 功能验收来追求进入 RSI。

source 失败也可封存为学习证据并打开 RSI；配额耗尽则只封存，不再购买 proposer。proposer 若将公开工具 ID 绑定进模板，须先用 put-tool 注册进 Method；不放行 dangling binding。source、两公开 case 与独立验证 case 都通过现有冻结评测路径；不同 arm 不共享候选实现。条件满足后沿 trusted expected-head activation，发布后另跑工作验证。

整个 campaign 共用 12 小时、10 亿 reported tokens、4000 请求、并发 4 的上限；child/重试/RSI 不重置。真实运行使用全新根和 IDs，不续跑归档；启动前固定 provider/model/profile、凭据、绝对 deadline 和源码 hash。启动例：

```bash
node apps/singularity/examples/buckyball-campaign.ts /absolute/new-execution-root /absolute/prepared-project-directory
```

只读操作者每半小时核对实际 consumer、父目标职责、反馈/重派发、root findings 和 RSI，不把树深/工具计数当作行为改善。脚本 fixture、环境预检和真实模型证据分别报告。当前是否启动及已知缺口以进度为准。
