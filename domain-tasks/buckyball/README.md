# Buckyball 独立领域目录

这里只有领域数据、确定性验收和标准 MCP 环境资产，不是 Singularity 的 TypeScript 模块，也不 import runtime、Task/RSI 状态或实验宿主。

## 文件职责

- `task.json`：MXMM 根目标、原始输入约束、一个 `mxfp8-consumer` 确定性验收。
- `acceptance.py`：冻结 callable CLI、请求/响应机器格式、输入重建、独立数值参考和命令记录检查。
- `cases/`：MXMM source、long-k、output-tiling 的 seed、shape 与完整 dataRule；scale 均为 `112+((11*i+seed)%32)`。
- `transfer/`：不同算子 SMatMul 和不同任务 inventory 的独立 TaskSpec、case 与确定性验收。
- `domain.json`：默认根合同以及四个 paired cases。case 可覆盖 `task`/`acceptance`，不改变宿主控制流。
- `environment/`：checkout/bbdev 的源码、公开 schema 和依赖声明。

MXMM 调用固定为 `python3 ball/mxmm.py request.json response.json`，SMatMul 为 `python3 ball/smatmul.py request.json response.json`。请求直接携带原始 codes/scales 或 int8 bytes；验收不允许 fold、投影、换 seed 或 host-only 数学结果代替真实 BEMU consumer。完整 schema 以对应 `acceptance.py` 为准。

四个 paired cases 是 long-k（公开）、smatmul-bias（公开、pebble core 0）、output-tiling（validation、poly-attention core 2）和 inventory-transfer（validation）。source 也是 MXMM/poly-attention core 2。每个 case 使用自己的 TaskSpec 和确定性 checks，不购买 LLM root review。

## 准备与启动

`source.destination`、`BUCKYBALL_BASELINE` 和 `BUCKYBALL_MCP_ROOT` 的 `/absolute/...` 是待替换占位符，不能直接用于真实运行。将本目录作为构造参考交给普通 env-builder session，并提供操作者准备的 `project.json` 与依赖资料。builder 必须：

1. 将真实 `project.json` 的来源身份、预检和可选文档信息合并到三份 MXMM case 与 `transfer/smatmul-case.json`，保持各自冻结的 case/dataRule 不变。
2. 将 `BUCKYBALL_BASELINE` 指向同一个只读准备副本，不在 case 之间替换基线。
3. 在领域目录**之外**的独立目录预装 `environment/package.json` 的固定 MCP SDK 依赖，将 `BUCKYBALL_MCP_ROOT` 指向该目录。`server.cjs` 通过 Node `createRequire` 从这个公开路径加载依赖；宿主不 import server，也不在 Task 运行时安装依赖。依赖目录的 `package.json` 与 `pnpm-lock.yaml` 从 `environment/` 复制，不要把 `node_modules` 放进领域 bundle（它会破坏 1 MiB MCP source 上限）：`mkdir -p /absolute/prepared-domain/mcp-deps && cp environment/package.json environment/pnpm-lock.yaml /absolute/prepared-domain/mcp-deps/ && pnpm --dir /absolute/prepared-domain/mcp-deps install --frozen-lockfile --ignore-workspace`。
4. 实际检查 `checkout` 的独立副本、bbdev 业务成功、参数失败和取消退出，再交付目录。启动前还须对每个真实 consumer 做零模型预检；帮助/握手或数学参考不算通过。

普通 env-builder 的入口是：

```bash
node apps/singularity/src/env-builder.ts /absolute/raw-materials /absolute/new-preparation-root
```

生成目录为 `/absolute/new-preparation-root/domain`，先检查其中的合同、输入和配置，再在另行授权的新执行中加载：

```bash
node apps/singularity/src/domain.ts /absolute/new-execution-root /absolute/new-preparation-root/domain
```

两次启动都需要操作者固定模型路由、凭据、预算和绝对 deadline；第二条命令可能购买完整 Task/RSI 请求。目录在新执行启动时冻结，不在运行中热改 root 合同、Method 或共享 MCP registry。新运行使用全新根和 IDs，不续跑归档。

RSI 以真实 consumer 的 paired verified fraction 为质量指标，不以同一 MXMM 的 token 下降代表能力提升。comparison 分列 uncached/cacheRead/cacheWrite 成本，未知 cache 不记成 0。SMatMul 预检证据与当前验证/缺口统一见 `docs/buckyball-mxmm-ball.md` 和 `docs/progress.md`；完整 paired comparison 之前不声称 RSI 改善或 activation。
