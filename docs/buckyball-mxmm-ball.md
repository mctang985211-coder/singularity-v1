# Buckyball MXMM Ball 测试集

本次替换整模型芯片前端任务。round7 根因与具体归档见 [职责审计](round7-workflow-responsibility-audit-20261104.md)，历史执行数字保留于 [进度](progress.md)。下一轮选择 Ball 层，定位可执行分块与消费接口，避免把全模型实现、芯片拓扑和 EDA 缺口捆为一次验收。

## 问题与完成条件

模型为现有 MXMM Ball 实现可调用的 MXFP8 `C = A * B^T` 分块程序。输入是 row-major E4M3 codes 与每行每 32 个 K 元素的 E8M0 scales，输出 FP32。支持 M=1 或 16 的倍数且不超过 64，N 为 16 的倍数且不超过 80，K 为 32 的倍数且不超过 4096。实际 bank 为 1024 × 128 bits，16 KiB；scale bytes 和输出 base 同样占容量。模型自行选择实现路径。

交付须将输入经真实 packing/tiling、三 bank、DMA、first/last 累加连接到仓库 ISA，编译 RISC-V ELF 并在选定 core 上运行 BEMU。函数接口、算法、修复、数值 oracle、子任务与非 root 检查全部由模型产生，没有固定求解树或工具选择。领域合同不规定 Singularity/RSI 可修改的资产范围。

| 场合 | seed | M/N/K | 要暴露的错误 |
| --- | ---: | --- | --- |
| source | 17 | 32/48/1056、64/80/2048、1/32/4096、16/16/32 | 跨 bank、长 K、最小块与完整消费链 |
| long-k（公开评测） | 29 | 1/32/4096、16/16/32 | 长 K 累加与最小块、连续两次调用 |
| output-tiling（验证） | 43 | 64/80/2048、48/64/96 | C 超出单 bank、M/N 输出分块与累加状态 |

每个 case 同时冻结 `dataRule`：向量序号 `j` 与平坦字节序号 `i` 从 0 开始，`seed=case.seed+j`；code 为 `((73*i+19*floor(i/256)+seed)%127)|(i%2?128:0)`，在 `i%257=0` 时改为 0、`i%263=0` 时改为 128；scale 为 `(11*i+seed)%255`。codes 按 row-major，scales 按每行每 32 个 K 元素的 row-major 排列。它固定全部实际输入 bytes，包含有符号/零 codes 和不同有限 scales；worker 与 reviewer 不得各自换题。

每轮只保留一个公开迁移 case 和一个独立 validation case，共四个 baseline/candidate roots。root reviewer 按同一冻结规则生成参考输入，独立解码并检查真实 target 输出、guard 和重复调用。精确可表示子集要求完全相等，其余要求有依据且实测的 FP32 误差范围。验证 case 单独冻结，但这是公开可信本地实验，不宣称隐藏数据隔离。

根验收为 executable-mapping、target-correctness、regression、delivery，四项全部 required。独立 reviewer 在新 checkout 应用全部补丁并重建，不能修候选，单次 root review 最多 128 个模型步骤。现有 capacity/window/chain 回归只证明自身覆盖；每个被改变的边界都须复验，BEMU 不证明 RTL 等价。独立 LLM review 仍可能误判，必须审查实际命令和产物，不能把策略文字当作已改善证据。

## 领域任务何时准备齐全

领域编写遵循[统一领域任务框架](framework.md#190-领域任务编写框架)：只提供目标、参考资料、根评判标准和少量测试输入。源码/配置与可用工具属于环境资料；预算、deadline、provider/profile、RSI 控制流和验收执行器由 Singularity 宿主配置。操作者负责环境可运行，不预写设计路线、子任务合同、非 root 检查或待发现的 Method。

领域入口为独立的 [root 合同](../domain-tasks/buckyball/task.json)、[案例](../domain-tasks/buckyball/domain.json) 和环境资产，不再由 app import 领域 TypeScript。[通用宿主](../apps/singularity/src/experiment.ts) 拥有 Task/RSI 流程与预算；[通用 reviewer](../packages/singularity/runtime/src/reviewer.ts) 只用于 root 语义验收。每个 child 的 parent-authored criteria 已有完整 shell checks，故其冻结 AcceptanceRef 选择原生 CAS-only check 结算，不再购买一层 LLM review。初始 Method 的 templates/skills/tools 全空；root 通过 `project.json` 按需找到 `.agents/skills/debug-bemu/SKILL.md` 与 `.agents/skills/debug-compiler/SKILL.md`，这些只是技术资料，不注册为 skills，也不引入其角色或阶段门禁。只有 Singularity 自产 Method 资产可走 skill 注册路径。

固定 Buckyball 准备副本 `07a85ea2898e59a80d0dfbb30520d8ed5c39390a`；stack `f8af074a28eb83cc58424fe08eda2a67c472b73a`；bbdev `207c4b73998a1d34279d854d7b3f52d86721e86d`（含既有领域工具修复）。本地 `artifacts/buckyball-mxmm-ball-20261104/project.json` 仅提供 Ball 所需来源、环境和预检身份，不带 CosyVoice checkpoint、旧 seed 或整芯片验收。env-builder 将该真实资料并入独立领域目录的 source/case 输入并填写公开环境路径；仓库内的占位路径不能直接用于启动。baseline 保持只读，Task/reviewer 各自用独立副本。预装 LLVM 为只读依赖；不共享候选源码和 build 输出。既有领域修复的公开补丁保存在 [bbdev](../domain-tasks/buckyball/patches/bbdev.patch) 与 [verify](../domain-tasks/buckyball/patches/verify.patch)，不属于宿主源码。

领域 MCP [checkout/bbdev](../domain-tasks/buckyball/environment/server.cjs) 是由原生 MCP 启动的外部资产，直接组合 `cp --archive --reflink=auto` 与项目内 `nix develop`，没有 runtime 领域分支或宿主 import。MCP SDK 由 env-builder 在独立依赖目录预装，`BUCKYBALL_MCP_ROOT` 指向该目录；源码、manifest 和 tools schema 随领域目录冻结。experiment 不为这个无 resources 的 server 暴露三种 MCP resource 工具或对应提示。直接 bbdev 操作使用 `mcp__buckyball__bbdev` 并传 argv，避免在 bash 中重复手工激活同一入口。使用既有 poly compute tile 的 attention core（生成配置的全局 index=2） 作为 Ball 宿主，固定配置而不重新设计 core/chip。业务预检命令如下，具体结果见进度与本地 preflight 记录：

```text
checkout(project=<new absolute directory>)
bbdev(project, ["workload", "--build", "--chip poly --ctest"])
bbdev(project, ["bebop-bemu", "--sim", "--chip poly --core-index 2 --binary poly-attention-ctest-mxmm_bank_capacity_test-baremetal"])
```

相同路径还需实测 mxmm_window_test、mxmm_window_chain_test、mxmm_window_rows_test。配置缺失必须返回真实失败，修正后能正常安装；帮助/握手不能代替这些业务操作。长调用的原生取消/进程退出已有 DSH fixture 和之前的真实 MCP 预检，不新增 watchdog 或恢复管理器。

## RSI 与证据

比较指标为通过完整功能验收的 Task 子树 reported tokens 均值，包含子任务与重试。两边全部 verified 且计量完整才能比较；平均至少节省 1000 tokens，且每 case 不退步。proposer/root reviewer 的额外请求仍计入整轮预算，不能把该子树指标说成全 campaign 成本。当前用例只覆盖同一 MXMM 的冻结 shape/data 迁移，不能据此声称跨算子或整个加速器领域泛化；Method 可保存通用实现、脚本、bbdev/MCP 等可复用资产，实例结果不能作为答案资产。没有放松 root 功能验收来追求进入 RSI。

source 失败也可封存为学习证据并打开 RSI；配额耗尽则只封存，不再购买 proposer。proposer 若将公开工具 ID 绑定进模板，须先注册再绑定；不放行 dangling binding。source、一个公开迁移 case 与独立 validation case 都通过现有冻结评测路径；不同 arm 不共享候选实现。开轮、评测、通用 token 比较及 trusted expected-head activation 均由 Singularity 宿主执行。

整个 campaign 共用 12 小时、10 亿 reported tokens、4000 请求、并发 4 的上限；child/重试/RSI 不重置。真实运行使用全新根和 IDs，不续跑归档；启动前固定 provider/model/profile、凭据、绝对 deadline 和源码 hash。启动例：

```bash
node apps/singularity/src/env-builder.ts /absolute/raw-materials /absolute/new-preparation-root
node apps/singularity/src/domain.ts /absolute/new-execution-root /absolute/new-preparation-root/domain
```

只读操作者每半小时核对实际 consumer、父目标职责、反馈/重派发、root findings 和 RSI，不把树深/工具计数当作行为改善。脚本 fixture、环境预检和真实模型证据分别报告。当前是否启动及已知缺口以进度为准。
