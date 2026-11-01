# Buckyball / CosyVoice3 芯片前端实跑准备

## 场景与范围

前次 inventory 证据是真实模型执行的受控案例，包括预先引导的 Method、公共 skill 和空 Method 探索；任务数据、领域规则、评测 case 是预设的。另有脚本化的原生 DSH fixture。它们证明框架闭环，不能证明真实芯片设计能力。

本次使用真实 Buckyball 仓库，从空 Method 开始设计 `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` 芯片前端。用户已明确：**只做 frontend，不做任何全芯片仿真或 P2E 加速**。全模型 BEMU、全芯片 RTL 仿真、FPGA bitstream、P2E、物理后端均不在本次范围。原始软件的 CPU 推理、算子/子图软件比较、IP/组件 UVM、RTL elaboration、逻辑综合和相应静态检查在范围内。不凭空增加面积、功耗或频率达标值；报告实际约束和工具结果。

仓库 model-port/model-optimize 中的 full-model BEMU、完整 P2E 和 FPGA 性能完成门槛由这次任务范围覆盖；不要为满足旧 skill 而执行这些步骤。交付只能声称芯片前端及其实际组件验证，不能声称芯片端到端正确、实测芯片吞吐或完成流片。

只固定目标、验收、资源和预算。模型自行发现仓库、提出拓扑与数值方案、安排直属 workflow、实现并整合。操作者不预置 task 分解树、答案、调用顺序或可直接照抄的芯片实现。额外模型暂不添加；CosyVoice3 本身已经覆盖多种不同计算阶段。

## 固定资产

| 资产 | 固定身份 |
|---|---|
| Buckyball | `c3317d2f0739f829c93a86bee145acc191898e81` |
| stack | `f8af074a28eb83cc58424fe08eda2a67c472b73a` |
| bbdev | `06d35a794b000bb31099f7bcb95b5b8d16b856a1` |
| 公共 skills | `dc9dff7ce4ac3c6ac1de1748f7cb079bd030dc9b` |
| CosyVoice 源码 | `074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc`，Matcha-TTS `dd9105b34bf2be2230f4aa1e4769fb586a3c824e` |
| checkpoint | `FunAudioLLM/Fun-CosyVoice3-0.5B-2512@29e01c4e8d000f4bcd70751be16fa94bf3d85a18`，Apache-2.0，公开非 gated |

原 Buckyball 的 `scripts/nix/download.sh` 修改、linux gitlink 删除状态及未跟踪的 gemmini 是已有环境状态。准备过程保留原目录；独立副本复制 download.sh 修正，并单独固定 gemmini `8c3f9923a44a2fe2c7930587be297d6d4f8c09ca`。`checkout.json` 记录全部实际初始化子模块。副本只共享 Git 只读 object alternates 和不可变 Nix 工具链，不共享 build、bbdev 服务状态或可写模型工作目录。

官方 YAML 同时包含 896 维、24 层 Qwen2 语言模型，22 层 DiT Flow 和 HiFT 声码器，以及 prompt/speech tokenizer 等处理。原始软件实际加载的 LLM / Flow / HiFT 参数分别为 506148480 / 332257088 / 20779887；`0.5B` 名称不等于整个流程只有 0.5B。三部分以及主机侧处理都要在设计里有明确归属。公开资产下载约 5.1 GiB，排除 RL 替代权重及重复 ONNX 导出；6 个大文件的实际 SHA-256 均与官方 LFS oid 一致。

## Task 与模型视图

结构化入口为 [buckyballFrontendTaskSpec](../apps/singularity/examples/buckyball-frontend-task.ts)。操作者将公开 `project.json` 冻结进 CAS，把返回 Ref 传入此函数，再通过现有 root admission 固定合同。该文件包括资产身份、只读 baseline/checkpoint/reference 路径、Run 内工作副本的相对位置、范围和环境限制。TS 函数是 TaskSpec 工厂，**不是执行器或 verifier**。

初始 Method 的 templates/skills/tools 均为空。公共 exploration catalog 提供下列资源的简述和身份，正文按需读取；Method 演化只能发生在 RSI，不在 Task 执行中改合同。

- 仓库说明、当前 Task 协议、范围覆盖说明和固定资产清单。
- 现有 `model-port`、`model-optimize`、`chip-designer`、`ip-designer`、`ball-align`、`workload-tests`、`debug-compiler`、`check` 和 `report` skills；以注册的原生 skill loader 加载。
- `bash` 等既有 DSH 工具，通过各自工作副本中的现有 bbdev CLI 执行领域操作。
- 固定平台 `explore-child`；是否分解、如何分解、是否继续分解由当前模型决定。父节点仍承担自己的技术工作和直属结果整合。

不把旧 Singular 的 graph-contract、agent-runtime、canvas 或插件交付规则加入本领域 catalog；它们不是本次芯片业务资源。

需要改代码或执行构建的 Task/Run 在自己的 workspace 使用独立 checkout；只读研究直接读公开 baseline。子节点只交付自己授权范围的 patch、接口与证据；父节点检查并合入自己的副本。评测 baseline/candidate 从同一冻结起点创建各自副本，不能共享已被修改的源码、server state 或 build 输出。采用现成 Git checkout/patch 操作，不在 runtime 加 checkout/recovery manager。

## 原生工具与环境

已对现有 FastMCP 服务进行 `stdio` 接口验证；操作者使用其公开 `list_tools/remove_tool` 接口，选择 9 个前端相关工具完成 smoke：

`validate`、`bbdev_compiler_build`、`bbdev_workload_build`、`bbdev_model_build`、`bbdev_bebop_verilator_verilog`、`bbdev_uvm_build`、`bbdev_uvm_run`、`bbdev_task_status`、`bbdev_task_cancel`。

这不是新 MCP 实现或新的权限系统。该 surface 不含全芯片仿真、P2E、kernel/bitstream 与物理设计工具。但此次 probe **仅证明上游接口可用，不将它绑定给正式多节点任务**：`bbdev/mcp/common.py:repo_path()` 按服务源码位置固定仓库，现有 runtime 又将 stdio bundle 放在自身资源目录。绑定同一个冻结 launcher 会使所有 Run 指向同一份 checkout。

本次选择 DSH 原生 shell + 各自目录下的 `nix develop -c bbdev ...`。CLI 已有相同的后端、task 轮询和服务 teardown；MCP 路径则需要额外的每 Run 路径注入或新的 RPC 转发层，接入职责更多。用户要求优先用现成工具，因此不为维持 MCP 形式写第二套工作区路由，也不让旧 skill 的 MCP-only 偏好迫使节点共享可写目录。组件 UVM 的 top/IP 要与实际被验证的设计匹配；elaboration 成功不等于仿真通过。

独立副本安装 bbdev 自身 pyproject 依赖，用现有命令初始化配置：

```bash
cd "$BBDIR"
nix develop -c bbdev config --install
```

当前 CLI 的 config install 不接受 `--chip`。通过原生 MCP 实测 `validate(chip="toy")`，不能用成功握手代替业务工具返回值。

Buckyball 保留其 Python 3.14 Nix 环境。CosyVoice 原始软件参考使用单独 Python 3.10.20 / PyTorch 2.3.1 CPU 环境，不升级/替换仓库环境，不安装 GPU/TensorRT/DeepSpeed 训练栈。准备时固定 inference 依赖；Whisper 的旧构建及运行时依赖需要 `setuptools<81`，pyworld 使用宿主 GCC/G++ 编译，避免混用 Nix glibc。不修改上游模型源码以伪造可运行结果。

Singularity host 使用已验证的官方 Node 24.9.0 二进制。Buckyball Nix 的 Node 24.18.0 在本机无法通过 DSH 原生 `node-addon-require-builtin` host preparation；保留失败日志，固定实际可用 host，不在产品里加探测或兼容分支。Buckyball 工具子进程继续使用自身 Nix 环境。

官方 `CosyVoice3.inference_zero_shot` 已用原 checkpoint、官方 prompt 音频和文本“你好。”完成一次 CPU 软件推理：2 线程、21.9 秒（含初始化），得到 24000 Hz / 21120 样本、全有限 FP32 输出；保存原始 FP32 tensor 和 WAV。按照官方 CosyVoice3 示例保留 `<|endofprompt|>`。该输入禁用 `text_frontend`；wetext 外部资源返回 403，日志如实保留，因此本次没有证明额外文本规范化资源可用，也未评估听感、数据集质量或数值等价。它只证明原始软件入口可运行，后续组件验收仍需冻结多输入 oracle 和精度标准。

商业工具依服务器指南注入 launch environment。VCS 要设置 `VCS_HOME`，采用 `-full64`；已读取 VCS/DC 版本和现有 license server 状态。尚未凭版本输出宣称 UVM 编译/运行或综合通过。

在当前高负载共享机器上，模型额度开高，构建并发由操作者预设：例如 Python 3.14 原生 `PYTHON_CPU_COUNT=4`、`CMAKE_BUILD_PARALLEL_LEVEL=4`、`CARGO_BUILD_JOBS=4`；需要时用现成 OS 配额约束外部工具。不新增进程探测、任务 drain 或负载恢复器。

## 长任务限制

| 范围 | 启动值/上限 |
|---|---|
| 模型 | `deepseek-flash`，reasoning `max`，700000 context，40000 output |
| 整轮所有模型请求 | 最长 3 小时、400000000 tokens、4000 次调用；source/child/Summary/proposer/评测/发布后验证共用累计计量 |
| 单 Run | `maxStepsPerRun: 4096`；避免先于整轮调用上限截断 |
| Task 树 | `maxDepth: 8`、`maxTasks: 256`、`maxBatchChildren: 8`、`maxRuns: 3`；不是必须达到的目标 |
| 初始 root 子树 token 上限 | 400000000；子树配额不能使整轮总额增加 |
| 活跃 Task 上限 | 初始 2；外部构建并发与模型上下文限制分别配置 |
| 输出冻结上限 | 256 MiB；交付 patch、必要小向量和证据，不重复提交权重或整个 build 目录 |

绝对 deadline 在付费启动时生成；准备阶段不启动或消耗这 3 小时。每次执行使用全新 execution root；不复用此前已过期的 inventory 窗口。秘密只经 launch environment 注入。

当前 profile 仍关闭自动 compaction，因为现有计量只读 assistant 请求；长任务正式启动前需要把**原生 compaction 请求**纳入同一累计调用/token 预算，再开启原生自动压缩。不要通过关闭预算、编造 usage、自建摘要 loop 或重新购买失败请求绕开此缺口。

## 验收与 RSI

根合同固定五项 required criteria：原始参考、设计合同、实现/elaboration/逻辑综合、组件验证、可复现交付。缺失阶段保持失败或未完成；成功提交文件和模型自报的 PASS 不能使硬件验收通过。

领域 verifier 要在付费启动前接好：只消费冻结交付物，在独立验证 checkout 应用 patch，重跑对应组件检查并按原始软件 oracle 检查数值。模型可提出设计、测试和阈值建议；验收方负责冻结精度标准，审核覆盖和数值方案，不能让候选 patch 改写验收。架构/映射完整性需要独立领域审查；若只有自动结构检查，则明确报告该项未证明，不冒充芯片正确。

RSI 只读取 root 验收结束后的 sealed trace，改进可复用 Method/skill/tool。外部设计产物仍留在 Task 交付，不混进 Method guidance。预先冻结至少两个 evaluation case 和一个 validation case，使用对应的独立 oracle；可按真实 LLM attention/cache、Flow streaming 或 HiFT 子图设计组成可重复的领域子任务，但不能将预置求解步骤写入空 Method。

质量优先于 token 节省：所有 required 组件验收满足、无 case 回退，才能比较成本或复用收益。搜索与 proposer 成本另行计入整轮总账。未改善或无法证明质量保持时保留 rejected/not-comparable，不强制“发布赢家”。只有完成双臂评测并达到冻结阈值的候选才走现有 expected-head activation，再以新 Task 确认实际消费新 head。

功能覆盖从实际成功的协议工具、原生 skill/MCP、Task closure、comparison 和 activation 读取，分别标明未触达项。不要为了填计数强制生成无用工具、固定树深或人为制造失败。

## 本次证据与启动缺口

本地忽略目录 `artifacts/buckyball-cosyvoice3-20261101/` 保存源码副本、checkout 清单、固定模型、Python 环境及 lock、`project.json`、`campaign.json`、`task-spec.json`、原始软件 smoke/FP32 输出、原生 MCP probe、配置安装与商业工具版本日志。原 Buckyball 工作区保持原状态。环境安装和 smoke 中的真实错误保留原日志；这是操作者启动准备，没有向 harness 增加自动修复流程。

已完成准备不等于已完成 Singularity 芯片实跑：本次尚未购买新的模型请求，也未生成芯片验收 Evidence 或 RSI winner。正式付费 campaign 前剩下两个接入项：领域独立 verifier/冻结 case 与原生 compaction 统一计量。这些工作应落在 example/domain 和既有计量接缝，不向核心加入芯片分支或恢复框架。
