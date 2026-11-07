# Buckyball 真实 consumer 迁移测试集

本轮替换整模型芯片前端任务。根任务只描述外部问题、冻结输入、可调用交付和确定性验收，不规定 Singularity 求解树、Method、skill 或工具选择。历史 round12–16 的失败证据见 `progress.md`，旧 fold/scale 投影不再视为原冻结输入。

## MXMM 根任务与有限输入

MXMM 目标是在现有 MXMM Ball 上实现可调用的 MXFP8 `C = A * B^T`，经真实 packing/tiling、三 bank、DMA 和累加连接到仓库 ISA，编译 RISC-V ELF 并在 poly-attention 的 global core 2 上运行 BEMU。支持 M=1 或 16 的倍数且不超过 64，N 为 16 的倍数且不超过 80，K 为 32 的倍数且不超过 4096。

每个 case 同时冻结 `dataRule`：向量序号 `j` 与平坦字节序号 `i` 从 0 开始，`seed=case.seed+j`；code 为 `((73*i+19*floor(i/256)+seed)%127)|(i%2?128:0)`，在 `i%257=0` 时改为 0、`i%263=0` 时改为 128；scale 为 `112+((11*i+seed)%32)`。A/B 各自从 0 计算 codes 和 scales，同一向量 seed 同时用于 A/B。codes 按 row-major，scales 按每行每 32 个 K 元素的 row-major 排列。112–143 的 scale 保留非均匀输入，同时使实际 codes/shapes 的解码和全部累加保持有限。

| 场合 | seed | M/N/K | consumer 覆盖 |
| --- | ---: | --- | --- |
| source | 17 | 32/48/1056、64/80/2048、1/32/4096、16/16/32 | 跨 bank、长 K、最小块、重复调用与完整消费链 |
| long-k（公开评测） | 29 | 1/32/4096、16/16/32 | 长 K 与最小块、原始 bytes 和连续调用 |
| output-tiling（独立 validation） | 43 | 64/80/2048、48/64/96 | C 超单 bank、M/N 输出分块与 K continuation |

## 冻结 callable CLI 与机器验收

MXMM 的交付入口固定为：

```bash
python3 ball/mxmm.py request.json response.json
```

`request` 是 `{v:1,calls:[...]}`。每个 call 包含 `id,m,n,k,aCodes,aScales,bCodes,bScales,guard`；codes/scales 为 base64 原始 bytes，guard 是八个 `0x5a5a5a5a` FP32 words。`acceptance.py` 从 `project.json` 生成请求，最后一个向量原样再调用一次。

`response` 是 `{v:1,calls:[...],regressions:[...]}`。每项 call result 只含 `id,c,guard,command`；C 是 row-major 有限 FP32 JSON 数值。command 只含 `name,argv,cwd,exit,stdout,stderr`，必须记录真实 `["bbdev","bebop-bemu","--sim","--chip","poly","--core-index","2","--binary",...]` 成功执行。`regressions` 恰好记录 `mxmm_bank_capacity_test`、`mxmm_window_test`、`mxmm_window_chain_test`、`mxmm_window_rows_test` 四条真实命令。BEMU 证据不冒充 RTL 正确性。

根验收只有 `mxfp8-consumer` 一项，执行 `python3 acceptance.py` 一次，而不是四个 criteria 各自重跑完整 BEMU。验收器从冻结规则独立重建原始 bytes，按 E4M3/E8M0 语义做精确整数块点积，优先比较单次 RNE FP32 结果，其余使用覆盖任意累加顺序的保守 FP32 误差界；同时检查输出 guard、重复调用和全部命令记录。缺文件、非有限值、fold/scale 投影、换输入或缺失回归均失败。没有 LLM root review，也不读取 worker 工作区、旧 transcript 或候选自报 verdict。

`ball/` 必须包含 `mxmm.py` 入口、适用的源码补丁和独立复现资产。算法、子任务、内部源码结构和非 root 检查由模型产生；领域不预写这些 workflow 决策。

## 不同算子与不同任务的迁移 case

`domain.json` 允许 case 覆盖根 TaskSpec 和 acceptance，suite 不把同一 MXMM 换 seed 称为跨任务迁移：

- `smatmul-bias` 是公开的不同算子任务。输入为 16x32 A、32x16 B 的 signed int8 和 16 个 int32 bias，`A[i]=((11*i+73)%17)-8`、`B[i]=((7*i+146)%19)-9`、`bias[j]=((3*j+73)%13)-6`。交付 `python3 ball/smatmul.py request.json response.json`，返回精确 int32 C、guard 和命令记录，并运行 `smatmul_16x16x32_test`、`smatmul_bias_accumulate_test`。真实部署是 pebble global core 0，不是 poly-attention。
- `inventory-transfer` 是独立 validation 的不同非加速器任务。冻结 CSV 要求准确 rowCount、SKU 覆盖、signed 整数聚合和升序输出；`transfer/inventory-acceptance.py` 是确定性真实 consumer。

SMatMul 的零模型预检在独立 checkout 中实际构建并运行两个现有 ELF/BEMU 测试，日志均包含 PASS：`artifacts/smatmul-consumer-preflight-20261107/smatmul_16x16x32.run.log` 和 `smatmul_bias_accumulate.run.log`。poly-attention 的 generated config 不包含 SMatMul，不能把芯片级 UVM 列表误当成该 core 的支持证据。这些预检只证明环境可运行，不证明模型已经实现新 CLI，更不证明 RSI 收益。

## RSI 判据与证据边界

每轮对 source trace 产生一个候选，evaluation 使用 long-k 和 smatmul-bias，validation 使用 output-tiling 和 inventory-transfer；共四个 case、八个 baseline/candidate roots，另有 source。每个 case 冻结自己的 TaskSpec、输入和 acceptance，paired arms 只改变 Method revision。

主指标是每 case 的 paired verified consumer fraction，质量提升均值至少 0.01 且任何 case/validation 不回退，才可判 improved。总 reported-token 成本允许最多为 baseline 的 2 倍，但不以 token 下降作为改善。comparison 的 `tokenCosts` 分别报告 baseline/candidate 的 input、output、uncachedInput、cacheRead、cacheWrite 和 complete/cacheComplete；缺 cache metadata 时为 null，不记成 0。proposer 与 campaign 其它成本仍单独记账，不能把 slot 成本说成整轮成本。

固定 Buckyball 准备副本 `07a85ea2898e59a80d0dfbb30520d8ed5c39390a`；stack `f8af074a28eb83cc58424fe08eda2a67c472b73a`；bbdev `207c4b73998a1d34279d854d7b3f52d86721e86d`。`artifacts/buckyball-mxmm-ball-20261104/project.json` 提供 Ball 所需来源、环境和预检身份。仓库内 `/absolute/...` 是待替换占位符，真实运行必须由 env-builder 合并真实 project 资料、准备独立依赖并验证 MCP 工具成功、参数失败和取消退出。

通用宿主负责 Task/RSI、预算、paired evaluation 和 expected-head activation。新运行使用全新执行根和 IDs，不续跑旧根。完整 candidate/baseline/validation comparison 之前，不声称跨任务更聪明、RSI 已改善或可以 activation。启动例：

```bash
node apps/singularity/src/env-builder.ts /absolute/raw-materials /absolute/new-preparation-root
node apps/singularity/src/domain.ts /absolute/new-execution-root /absolute/new-preparation-root/domain
```
