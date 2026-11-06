# Buckyball MXMM Ball 独立领域目录

这里只有领域数据与标准 MCP 环境资产，不是 Singularity 的 TypeScript 模块。`task.json` 保留 root 目标和四项语义验收；`cases/` 冻结 seed、shape 与完整 dataRule；`environment/` 提供 checkout/bbdev 的源码、公开 schema 和依赖声明。

`source.destination`、`BUCKYBALL_BASELINE` 和 `BUCKYBALL_MCP_ROOT` 的 `/absolute/...` 是待替换占位符，不能直接用于真实运行。将本目录作为构造参考交给普通 env-builder session，并提供操作者准备的 `project.json` 与依赖资料。builder 必须：

1. 将真实 `project.json` 的来源身份、预检和可选文档信息合并到三份 case 输入，保持各自冻结的 case 不变。
2. 将 `BUCKYBALL_BASELINE` 指向同一个只读准备副本，不在 case 之间替换基线。
3. 在独立目录预装 `environment/package.json` 的固定 MCP SDK 依赖，将 `BUCKYBALL_MCP_ROOT` 指向该目录。`server.cjs` 通过 Node `createRequire` 从这个公开路径加载依赖；宿主不 import server，也不在 Task 运行时安装依赖。依赖准备使用随目录提供的 lockfile：`pnpm --dir /absolute/prepared-domain/environment install --frozen-lockfile --ignore-workspace`。
4. 实际检查 `checkout` 的独立副本、bbdev 业务成功、参数失败和取消退出，再交付目录。

普通 env-builder 的入口是：

```bash
node apps/singularity/src/env-builder.ts /absolute/raw-materials /absolute/new-preparation-root
```

生成目录为 `/absolute/new-preparation-root/domain`，先检查其中的合同、输入和配置，再在另行授权的新执行中加载：

```bash
node apps/singularity/src/domain.ts /absolute/new-execution-root /absolute/new-preparation-root/domain
```

两次启动都需要操作者固定模型路由、凭据、预算和绝对 deadline；第二条命令可能购买完整 Task/RSI 请求。目录在新执行启动时冻结，不在运行中热改 root 合同、Method 或共享 MCP registry。

root 仍使用独立语义 review，不声称 `server.cjs` 的预检证明了 MXMM 解法正确，也不声称目录解耦本身带来 RSI 收益。详细目标、验收和证据限制见 `docs/buckyball-mxmm-ball.md`。
