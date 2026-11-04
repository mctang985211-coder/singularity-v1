# Buckyball / CosyVoice3 芯片前端实跑准备

2026-11-04：round5、round6 已按用户要求停止并归档；当前修正通用规划指引和领域证据说明，使用新执行根重开。当前代码与新轮实际状态见 [进度](progress.md)。历史修复与证据更正见 [Task 修复审计](task-repair-20261103.md)。

## 场景与范围

前次 inventory 证据是真实模型执行的受控案例，包括预先引导的 Method、公共 skill 和空 Method 探索；任务数据、领域规则、评测 case 是预设的。另有脚本化的原生 DSH fixture。它们证明框架闭环，不能证明真实芯片设计能力。

本次使用真实 Buckyball 仓库，从空 Method 开始设计 `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` 芯片前端。用户已明确：**只做 frontend，不做任何全芯片仿真或 P2E 加速**。全模型 BEMU、全芯片 RTL 仿真、FPGA bitstream、P2E、物理后端均不在本次范围。原始软件的 CPU 推理、算子/子图软件比较、IP/组件 UVM、RTL elaboration、逻辑综合和相应静态检查在范围内。不凭空增加面积、功耗或频率达标值；报告实际约束和工具结果。

仓库 model-port/model-optimize 中的 full-model BEMU、完整 P2E 和 FPGA 性能完成门槛由这次任务范围覆盖；不要为满足旧 skill 而执行这些步骤。交付只能声称芯片前端及其实际组件验证，不能声称芯片端到端正确、实测芯片吞吐或完成流片。

领域准备固定可执行环境、公开资源、root 问题/验收和预算。求解方案、非 root 验收、分解、接口与 Method 由模型产生；不得预写答案或子任务集。平台工作流语义以 framework 的 worker card/tool 为准，领域指南不另定义一套流程。完整 RSI 评测还需冻结 case/comparator，单次探索就绪不等于完成该评测或芯片验收。额外模型暂不添加；CosyVoice3 已覆盖不同计算阶段。

## 固定资产

| 资产 | 固定身份 |
|---|---|
| Buckyball upstream | `c3317d2f0739f829c93a86bee145acc191898e81` |
| 本轮准备副本 | `974e7e6da44013c1667c93f677aa123110c752ad`，更新下述 bbdev/verify 环境修复 gitlink |
| stack | `f8af074a28eb83cc58424fe08eda2a67c472b73a` |
| bbdev | `d0795adbfce608e989f415d7a353f33268a2c770`，基于 `06d35a794b000bb31099f7bcb95b5b8d16b856a1` 应用领域修复 |
| 公共 skills | `dc9dff7ce4ac3c6ac1de1748f7cb079bd030dc9b` |
| CosyVoice 源码 | `074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc`，Matcha-TTS `dd9105b34bf2be2230f4aa1e4769fb586a3c824e` |
| checkpoint | `FunAudioLLM/Fun-CosyVoice3-0.5B-2512@29e01c4e8d000f4bcd70751be16fa94bf3d85a18`，Apache-2.0，公开非 gated |

原 Buckyball 的 `scripts/nix/download.sh` 修改、linux gitlink 删除状态及未跟踪的 gemmini 是已有环境状态。准备过程保留原目录；独立副本复制 download.sh 修正，并单独固定 gemmini `8c3f9923a44a2fe2c7930587be297d6d4f8c09ca`。`checkout.json` 记录全部实际初始化子模块。副本只共享 Git 只读 object alternates 和不可变 Nix 工具链，不共享可变的 Task build、bbdev 服务状态或可写模型工作目录。

官方 YAML 同时包含 896 维、24 层 Qwen2 语言模型，22 层 DiT Flow 和 HiFT 声码器，以及 prompt/speech tokenizer 等处理。原始软件实际加载的 LLM / Flow / HiFT 参数分别为 506148480 / 332257088 / 20779887；`0.5B` 名称不等于整个流程只有 0.5B。三部分以及主机侧处理都要在设计里有明确归属。公开资产下载约 5.1 GiB，排除 RL 替代权重及重复 ONNX 导出；6 个大文件的实际 SHA-256 均与官方 LFS oid 一致。

## Task 与模型视图

结构化入口为 [buckyballFrontendTaskSpec](../apps/singularity/examples/buckyball-frontend-task.ts)。操作者将公开 `project.json` 冻结进 CAS，把返回 Ref 传入此函数，再通过现有 root admission 固定合同。该文件包括资产身份、只读 baseline/checkpoint/reference 路径、Run 内工作副本的相对位置、范围和环境限制。TS 函数是 TaskSpec 工厂，**不是执行器或 verifier**。

初始 Method 的 templates/skills/tools 均为空。公共 exploration catalog 提供下列资源的简述和身份，正文按需读取；Method 演化只能发生在 RSI，不在 Task 执行中改合同。

- 仓库说明、当前 Task 协议、范围覆盖说明和固定资产清单。
- 项目原有 `.agents/skills/` 仅由 root 合同中的绝对路径作为技术参考文档暴露；其中角色、审批和流程门槛不覆盖本 Task 合同，不注册或挂载为 skill。只有 Singularity 自产 Method 资产沿原生 skill 路径使用。
- 标准领域 MCP `mcp__buckyball__checkout(project)` 创建完整准备副本，`mcp__buckyball__bbdev(project,args)`，在各自绝对 checkout 目录执行 `nix develop --command bash -c 'exec bbdev "$@"' -- ...args`；原生 `bash` 用于编辑和独立组件工具。
- 固定平台 `explore-child`；是否分解、如何分解、是否继续分解由当前模型决定。父节点仍承担自己的技术工作和直属结果整合。

不把旧 Singular 的 graph-contract、agent-runtime、canvas 或插件交付规则加入本领域 catalog；它们不是本次芯片业务资源。

需要改代码或执行构建的 Task/Run 在自己的 workspace 使用独立 checkout；只读研究直接读公开 baseline。探索 child 继承固定 required `result/` tree，以 output ID `result` 提交自己授权范围的 patch、接口与证据；localOutputs 仅追加 supporting 文件，可省略。父节点检查并合入自己的副本。评测 baseline/candidate 从同一冻结起点创建各自副本，不能共享已被修改的源码、server state 或 build 输出。采用现成 Git checkout/patch 操作，不在 runtime 加 checkout/recovery manager。

## 原生工具与环境

现有 FastMCP 的 `bbdev/mcp/common.py:repo_path()` 按服务源码位置固定仓库，不能直接供多个独立 checkout 共用。最初改用模型自行调用 shell CLI 的决定遗漏了 Nix 激活，真实实跑出现 `bbdev: command not found`；该方案已撤销。

现在使用 [buckyball-mcp.ts](../apps/singularity/examples/buckyball-mcp.ts) 的两个领域工具：`checkout(project)` 用原生 `cp --archive --reflink=auto` 复制完整准备资产，再重新安装本地配置；`bbdev(project,args)` 调用既有 CLI。`BUCKYBALL_BASELINE` 在启动前固定，模型只给新目录的绝对路径；已有目录不能被 checkout 合并覆盖。`project` 是当前节点独立 checkout 的绝对路径，`args` 是既有 CLI argv。工具直接在该目录执行 `nix develop --command bash -c 'exec bbdev "$@"' -- ...args`，参数逐项传递，不拼接 shell 命令。bbdev 仍负责自身业务命令，DSH 原生 MCP client 负责 transport、timeout 与 teardown；Singularity runtime 没有芯片或 Nix 分支。

[buckyball-resources.ts](../apps/singularity/examples/buckyball-resources.ts) 将此工具按标准 ToolAsset 冻结为公共 exploration 资源，空 Method 的每个节点均按正常协议获得它；独立 reviewer 也挂载相同 MCP。操作者预先安装 bbdev 依赖及配置，使用 `uv venv --relocatable` 创建可复制的 Python 环境。worker 和 reviewer 均用领域 checkout 工具获得包括 `.venv`、子模块、`result` 工具链链接的完整副本；模型不再手工 git clone 和补依赖。`args:["--help"]` 获取准确语法；本次范围不授权全芯片仿真、全模型 BEMU、P2E/FPGA 或物理后端。组件 UVM 的 top/IP 要与实际设计匹配；elaboration 成功不等于仿真通过。

此前裁剪的上游 FastMCP 已完成九工具握手与 `validate(chip="toy")` smoke。它只证明原接口可用；新 MCP 的独立 checkout + 真实 Nix/CLI smoke 证据见 `artifacts/buckyball-cosyvoice3-20261101/native-tool-smoke/`，不把 CLI help 当成芯片构建通过。

操作者准备命令为：

```bash
cd "$BBDIR"  # 操作者的独立准备副本
# 对原 bbdev revision 应用 examples/buckyball-bbdev.patch，然后固定修复后的身份。
git -C bbdev apply /absolute/singularity-v1/apps/singularity/examples/buckyball-bbdev.patch
nix develop --command bash -c 'uv venv --relocatable --clear --python "$(command -v python3)" bbdev/api/.venv && uv pip install --python bbdev/api/.venv/bin/python "motia[otel]==1.0.0rc17" "iii-sdk==0.2.0" -r bbdev/api/requirements.txt'
nix develop --command bash -c 'bbdev config --install'
```

当前 CLI 的 config install 不接受 `--chip`。工具执行结果必须检查 exit 和业务输出，不能用 MCP 成功握手代替业务调用。

Buckyball 保留其 Python 3.14 Nix 环境。CosyVoice 原始软件参考使用单独 Python 3.10.20 / PyTorch 2.3.1 CPU 环境，不升级/替换仓库环境，不安装 GPU/TensorRT/DeepSpeed 训练栈。准备时固定 inference 依赖；Whisper 的旧构建及运行时依赖需要 `setuptools<81`，pyworld 使用宿主 GCC/G++ 编译，避免混用 Nix glibc。不修改上游模型源码以伪造可运行结果。

Singularity host 使用已验证的官方 Node 24.9.0 二进制。Buckyball Nix 的 Node 24.18.0 在本机无法通过 DSH 原生 `node-addon-require-builtin` host preparation；保留失败日志，固定实际可用 host，不在产品里加探测或兼容分支。Buckyball 工具子进程继续使用自身 Nix 环境。

官方 `CosyVoice3.inference_zero_shot` 已用原 checkpoint、官方 prompt 音频和文本“你好。”完成一次 CPU 软件推理：2 线程、21.9 秒（含初始化），得到 24000 Hz / 21120 样本、全有限 FP32 输出；保存原始 FP32 tensor 和 WAV。按照官方 CosyVoice3 示例保留 `<|endofprompt|>`。该输入禁用 `text_frontend`；wetext 外部资源返回 403，日志如实保留，因此本次没有证明额外文本规范化资源可用，也未评估听感、数据集质量或数值等价。它只证明原始软件入口可运行，后续组件验收仍需冻结多输入 oracle 和精度标准。

商业工具依服务器指南注入 launch environment。VCS 要设置 `VCS_HOME`，采用 `-full64`；已读取 VCS/DC 版本和现有 license server 状态。尚未凭版本输出宣称 UVM 编译/运行或综合通过。

在当前高负载共享机器上，模型额度开高，构建并发由操作者预设：例如 Python 3.14 原生 `PYTHON_CPU_COUNT=4`、`CMAKE_BUILD_PARALLEL_LEVEL=4`、`CARGO_BUILD_JOBS=4`；需要时用现成 OS 配额约束外部工具。不新增进程探测、任务 drain 或负载恢复器。

## 长任务限制

| 范围 | 启动值/上限 |
|---|---|
| 模型 | `deepseek-flash`，reasoning `max`，700000 context，40000 output |
| 整轮所有模型请求 | 最长 12 小时、1000000000 tokens、4000 次调用；source/child/Summary/proposer/评测/发布后验证共用累计计量 |
| 单 Run | `maxStepsPerRun: 4096`；避免先于整轮调用上限截断 |
| RSI proposer | `maxSteps: 4096`、1000000000 tokens；时间仍受整轮剩余 deadline 限制，不沿用 inventory 的 96 步/2M token 默认值 |
| 双臂评测 | `maxRuns: 4608`、1000000000 tokens、`maxActiveRuns: 4`；六棵 baseline/candidate 树顺序执行，此并发值用于单棵树内部；实际购买请求仍受整轮累计 4000 次限制 |
| Task 树 | `maxDepth: 8`、`maxTasks: 256`、`maxBatchChildren: 8`、`maxRuns: 3`；不是必须达到的目标 |
| 初始 root 子树 token 上限 | 1000000000；子树配额不能使整轮总额增加 |
| 活跃 Task 上限 | 4；外部构建并发与模型上下文限制分别配置 |
| 输出冻结上限 | 256 MiB；交付 patch、必要小向量和证据，不重复提交权重或整个 build 目录 |

绝对 deadline 在付费启动时生成；准备阶段不启动或消耗这 12 小时。给 proposer/evaluation 的相对时间取整轮剩余时间，所有阶段共用累计计量，不各自重新获得 12 小时或 10 亿 tokens。worker/reviewer 的原生 MCP toolCallTimeoutMs 共用这一配置，整轮取消仍沿既有 AbortSignal 传递。每次执行使用全新 execution root；不复用此前已过期的 inventory 窗口。秘密只经 launch environment 注入。

当前示例配置保留最初修复授权的 12h/1B/4000 上限；最新停止要求优先，不据此启动真实模型测试。历史执行各自使用当时冻结的额度。

后续轮的root PPA须对应交付workload实际使用的加速边界，说明活跃core/Ball实例及存储模型并独立复现；单个组件或未接入IP的报告只作支持证据，不替代frontend PPA，缺失则ppa-evidence失败且不提交ppa数值。该要求来自13:55轮首次root审查把未接入recipe的Conv1dBall报告判作PPA通过的实际缺口；该root仍因设计/实现不合格失败，未产生比较或赢家。

默认 inventory profile 仍关闭自动 compaction。本实验以原生 profile patch 启用自动压缩：75% context 压力、16% 近期历史保留、40000 输出上限；不配置额外 compaction/overflow 重购。`native-accounting.ts` 在 DSH `llm/stream` 接缝计入所有请求（包括 Summary、review、proposer、compaction 与辅助调用），共用累计预算。session usage fold 同时消费带 `llmStreamCall:true` 的原生 `compaction/summary`，模型无关摘要不算模型请求。

## 验收与 RSI

根合同固定六项 required criteria：原始参考、设计合同、实现/elaboration/逻辑综合、组件验证、PPA 证据、可复现交付。缺失阶段保持失败或未完成；成功提交文件和模型自报的 PASS 不能使硬件验收通过。

领域 verifier 要在付费启动前接好：只消费冻结交付物，在独立验证 checkout 应用 patch，重跑对应组件检查并按原始软件 oracle 检查数值。模型可提出设计、测试和阈值建议；验收方负责冻结精度标准，审核覆盖和数值方案，不能让候选 patch 改写验收。架构/映射完整性需要独立领域审查；若只有自动结构检查，则明确报告该项未证明，不冒充芯片正确。

RSI 只读取 root 验收结束后的 sealed trace，改进可复用 Method/skill/tool。外部设计产物仍留在 Task 交付，不混进 Method guidance。预先冻结至少两个 evaluation case 和一个 validation case，使用对应的独立 oracle；可按真实 LLM attention/cache、Flow streaming 或 HiFT 子图设计组成可重复的领域子任务，但不能将预置求解步骤写入空 Method。

质量优先于 token 节省：所有 required 组件验收满足、无 case 回退，才能比较成本或复用收益。搜索与 proposer 成本另行计入整轮总账。未改善或无法证明质量保持时保留 rejected/not-comparable，不强制“发布赢家”。只有完成双臂评测并达到冻结阈值的候选才走现有 expected-head activation，再以新 Task 确认实际消费新 head。

功能覆盖从实际成功的协议工具、原生 skill/MCP、Task closure、comparison 和 activation 读取，分别标明未触达项。不要为了填计数强制生成无用工具、固定树深或人为制造失败。

## 环境证据与运行接入

本地忽略目录 `artifacts/buckyball-cosyvoice3-20261101/` 保存源码副本、checkout 清单、固定模型、Python 环境及 lock、`project.json`、`campaign.json`、`task-spec.json`、原始软件 smoke/FP32 输出、原生 MCP probe、配置安装与商业工具版本日志。原 Buckyball 工作区保持原状态。环境安装和 smoke 中的真实错误保留原日志；这是操作者启动准备，没有向 harness 增加自动修复流程。

环境 smoke 不等于芯片验收。领域独立 verifier、冻结 workload case 与原生 compaction 统一计量已由下述 example 和既有接缝补齐；runtime 没有芯片分支或恢复框架。实际启动、消费和芯片验收结果仅以独立 execution root 记录为准。


## 自主 campaign 启动入口

`apps/singularity/examples/buckyball-campaign.ts` 通过现有 root/child/trace/proposer/evaluation/activation 接口执行：最多三个连续 RSI Round，共用同一 campaign 窗口；达到预算即停。初始 Method 为空，不预置设计答案或分解树。使用原生 bash-local、tool-bash 和 tool-jobs 代替最小 profile 的 persistent bash，后台构建由 DSH 管理，模型可用 job_output 等待结果；没有新增进程管理器。

用户授权本实验自主选择设计与 PPA 比例，覆盖旧 skill 中逐项请示设计的约定。领域验收按冻结 root 合同，仓库文档仅供参考，由**独立 DSH review Agent**在独立目录读取冻结 CAS 输出、检查合同和源代码、应用 patch 并重跑相关真实工具。它不读取原 worker 的可写目录、不修复候选、不把 exit 0 或模型自报 PASS 当正确性。review 的请求和 tokens 同样入总账。这是独立模型审查与复跑证据，并非形式化签核；数值/组件覆盖和缺口留在原生 session 与 receipt。

PPA 采用综合估计，权重 **功耗 0.30 / 关键路径延迟 0.40 / 映射面积 0.30**；比较 `pow(Pb/Pc,.30) * pow(Db/Dc,.40) * pow(Ab/Ac,.30) - 1`。面积、功耗、关键路径延迟分别保留 um²、mW、ns 及 library/corner/clock/activity/offload 身份；不能用时钟约束冒充达到的关键路径或猜测功耗。所有功能项通过、条件一致、均值改善至少 1% 且任一 case 无回退才允许激活。缺 PPA、缺实现或无法验证时保持失败/not-comparable，不强行选赢家。

评测固定 LLM 16/64 token prefill、Flow 16/32 frame streaming 两项 workload 定义，独立验证为 HiFT 小 mel chunk 边界；它们固定输入范围与目标，不规定解决步骤。原始 oracle 来自固定源码/checkpoint，在独立审查内复现。全芯片仿真/P2E 仍排除。新 `ppa-evidence` 根验收要求实际复现 PPA 报告。

运行命令（凭据仅从 launch environment 注入）：

```bash
node apps/singularity/examples/buckyball-campaign.ts <全新 execution root> <准备目录>
```

启动记录为 `launch.json`，原生请求累计记录为 `requests.jsonl`，标准输出留 `campaign.log`，每轮及最终结果为 `round-N.json`、`result.json`。执行根不会重启；失败保留原始错误。按用户最新要求每半小时只读巡检树、交付、验收、RSI 和累计用量；需要修订时先停止旧根，提交修改后从新根启动，不中途修改冻结运行资产。

后续独立实验可在准备目录的 `project.json` 指定 `publicSeed: {archive, description}`。操作者将已归档执行的公开冻结产物和公开验收意见整理为 tar.gz，内含 `provenance.json` 记录来源 Run、digest、原 verdict 与已知缺口；`archive` 相对准备目录。启动时把归档原始字节冻结为普通 Task input `public-seed.tar.gz`，source 和全部评测 case 使用同一个 Ref。模型自行检查、选择复用并修正；新 Run 仍按完整原合同独立验收。不得加入私有 receipt、验证集答案、旧 transcript 或可写 workspace，也不导入旧事实/状态/verdict。此输入是公开实验起点，不是 Method、恢复机制或预置 workflow；报告应区分首次从零探索与基于真实产物继续设计。每执行根遵守启动时冻结的整轮上限，当前配置见长任务限制。

BB 的冻结领域策略允许把已终结的 ExecutionRecord 作为失败学习轨迹（规范 §16.1 的现有策略接口），包括预算取消。它不将取消改为验收成功；整轮额度已用完时仍只封存、不打开 proposer。这项配置保证真实截止的归档不会再因缺省 RSI 资格策略而抛错，不增加运行期恢复路径。

## 首次实跑失败与参数边界修正

首次实跑 `artifacts/buckyball-cosyvoice3-live-20261101-1502/execution` 持续 157.788 秒，21 次请求、746746 reported tokens。只有 root opened，没有 child admission、芯片提交、验收或 RSI；产物仍不满足任何芯片成果声明。

`decompose prepare` 成功后，模型的 commit 输出缺少 `children` 的闭合 `]`。原始会话记录为 `assistant/attempt` / `MALFORMED_RESPONSE`，没有 commit 的 `tool/call`。2170 output tokens 低于 40k 上限；证据指向模型/接口返回的非法 JSON，不是 Singularity 拼接，也不是输出 cap 截断。DSH alpha2 的 pi-ai adapter 将已完成的非法工具参数当成 provider 致命错误，导致原生工具校验根本没有机会返回模型。

通过 pnpm 锁定补丁，让已完成的非法参数原样进入 DSH 原生工具校验，保留原始错误并附 `failed` 和极简完整格式用例。没有 JSON 自动修复、自然语言错误匹配或 provider 重试；长度终止仍不执行工具，宿主错误仍退出。不能靠 prompt 保证随机模型永远输出合法 JSON，边界职责是拒绝该调用并提供明确格式反馈。

旧 fixture 用 `JSON.stringify` 产生参数，且绕过实际 bbdev 环境，因此没覆盖这两条真实路径。新增测试直接从本地 SSE endpoint 发送畸形参数，经真实 adapter、DSH loop 和工具校验后修正；覆盖 Task、RSI、Summary 和独立 review，并核对没有多建会话、重复准入或虚假闭合。领域 fixture 也实际调用冻结 MCP，另以独立副本验证真实 Nix 激活。此次修正不自动续跑归档或启动新的付费 campaign。


## 2026-11-02：真实工具预检与阻塞修复

上一轮的候选 `cosy` 配置缺少 `[main_tile]`。bbdev 的 config queue handler 抛出 `ValueError`，却没有写 failure 终态，CLI 的 24 小时轮询一直等待。仅调用 `--help` 的旧 smoke 未覆盖队列执行。领域补丁 [buckyball-bbdev.patch](../apps/singularity/examples/buckyball-bbdev.patch) 让 config handler 将实际异常写入现有 failure 结果；TOML 库错误使用 `ValueError`，避免 `SystemExit` 退出 worker。bbdev 收到原生 `SIGTERM` 时走现有 finally 清理自身服务。没有增加重试、看门狗、错误文字匹配或 Singularity 恢复状态。

通过 DSH 原生 MCP client 实测全部两个工具：完整 checkout 与 config 安装成功；19 个 CLI/帮助入口可访问；重现上一轮缺失 `[main_tile]` 和缺失 TOML 的配置错误，均约 10 秒返回失败，修正后正常完成安装。AXIS arbiter 组件完成真实 elaboration、VCS 编译与 UVM 运行，`UVM_ERROR=0`、`UVM_FATAL=0`。长调用另以 DSH 原生 AbortSignal 在 25 秒取消，8 秒后确认该副本没有残留 bbdev/iii/motia 进程。这证明领域工具链的真实组件路径，不等于所有芯片设计、EDA 子命令或 CosyVoice3 验收完成。

预检与原始结果保存在本地 `artifacts/buckyball-cosyvoice3-20261102/`。付费 campaign 在这些准备完成后使用新 execution 根和新 deadline；保持空 Method、原模型配置和原总预算。截止后 app 不再尝试将预算终止的 source 送入 RSI。固定工具/schema 仍遵守原 prompt 上限，通过精简重复说明容纳 checkout，不放宽门槛。

## 预装 LLVM/MLIR（2026-11-02）

上一轮模型耗时从源码构建 LLVM，说明预装依赖还不完整。操作者先在准备副本通过既有 `bbdev compiler --build "--chip toy"` 完成 LLVM/MLIR 与工具 smoke。标准领域 MCP 为每次 CLI 调用设置 `BUCKYBALL_LLVM_BUILD`，指向该准备副本的冻结 LLVM/MLIR build；领域 build_llvm 直接消费它，不在各 Task 重建 LLVM。每个 Task 仍独立配置、编译其芯片专用 Buddy 编译器和 RTL，库依赖复用不等于复用候选实现或验收输出。

为了原生 cp 只复制 symlink 而非大体积工具链，在编译完成后可由操作者将 LLVM build 移到准备目录并在原路径保留绝对 symlink。此路径不提供给模型写入，MCP 仅将其作为预装依赖使用；没有新增 runtime 安装、检查或恢复逻辑。checkout/CLI 的真实使用结果及模型运行证据仍分别记录。

Verdi PLI 预检复现 `libnovas.so` 缺少 `libz.so.1`；verify Nix shell 的 `NIX_LDFLAGS` 显式加入 Nix zlib rpath。补丁见 `examples/buckyball-verify.patch`，不会修改共享 EDA 安装或增加运行期探测/恢复。

## 固定探索交付（2026-11-02，amendment 014）

上轮研究 child 省略 localOutputs，合同仅有可选 learning drafts，导致实际统计文件未被冻结。平台探索模板现固定 required result/ tree，示例不再重复声明 result；root 保持 frontend/。原生三级回归以无 localOutputs 的 child/grandchild 验证冻结文件与逐层集成。当时新轮 maxActive=4，评测 maxActiveRuns=4；总 3 小时、4 亿 tokens、4000 请求保持原授权。

## CLI 声明与实际路由对齐（2026-11-02）

实跑暴露 bbdev 的 uvm --verilog 空路由：帮助有声明但后端没有实现，导致服务启动后空等 120 秒。领域补丁删除该操作及同样失效的 verilator --cosim，API 指引改为已有 uvm --build（--chip/--ball）。保留 48 个实际有路由的 CLI 操作；操作是否业务成功仍分别实测，不用静态清单代替验证。新准备副本 base 82533d89 / bbdev bc83fe53 在 artifacts/buckyball-cosyvoice3-20261102-routes；完整 checkout、无效参数原生拒绝、AXIS VCS/UVM 及 help 已通过真实 MCP 复测，0 模型请求。旧轮继续使用冻结资产。


### 公开失败反馈与 retry 输入

worker 在 retry 时以 lastAttempt.runId 调用 singularity_read(kind=evidence)，逐页读取独立验收的真实 criteria/reason。此前只暴露通用 failed 的实现缺口已经修复。旧输出仅从 CAS 冻结提交挂载到 lastAttempt.outputsPath；模型在本轮副本中显式整合后重新提交，不能沿用旧 worker workspace。预算百分比沿原 Task 总额度及首次 Run 时间累计，不因 retry 变回 100%。source 结算后即使整轮已截止也先 seal 只读公开轨迹；无剩余额度时不打开 RSI 或继续买请求。

领域资料说明证据边界：elaboration 证明结构生成，综合估计所选 RTL 在特定约束/存储/活动模型下的 PPA，组件检查证明被测行为。早期综合可以验证明确的设计假设；最终 PPA 必须对应 workload 实际消费的实现。现有 core/Ball/compiler 是待验证候选，拓扑/综合报告不能替代模型映射或功能验证。不预制领域任务树或统一设计流程；root 验收保持原样。
