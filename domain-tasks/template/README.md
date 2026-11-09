# 独立领域任务构造样板

这是一个可运行的最小领域目录，不是 Singularity 插件，也不是预写 Method。将整目录复制到项目源码之外即可改写；本目录也不 import `runtime`、实验宿主、Task 状态或内部工具。

示例通过同一个外部合同处理三份冻结 CSV：source 用于产生学习轨迹，一个公开 case 用于迁移比较，一个 `validation: true` 的 case 用于独立验证。它只示范领域边界和可复现验收，不构成真实模型的 RSI 收益证据。

## 最小目录与填写位置

```text
my-domain/
├── domain.json          # 领域 ID、case 列表、根验收类型
├── task.json            # root goal/criteria/inputs/outputs
├── acceptance.py        # 公开、独立、确定性的根验收实现
└── cases/
    ├── source.csv
    ├── transfer.csv
    └── validation.csv
```

先修改 `task.json` 的现实问题和交付物，再修改案例，最后选择与问题相配的根验收。不要先设计任务树，再反推 root 合同。

### `domain.json`

当前填写示例：

```json
{
  "v": 1,
  "id": "inventory-example",
  "task": "task.json",
  "acceptance": "checks",
  "source": { "records": "cases/source.csv" },
  "cases": [
    {
      "id": "cancellation-and-zero",
      "description": "Repeated SKUs, cancellation, zero totals and signed quantities.",
      "inputs": { "records": "cases/transfer.csv" }
    },
    {
      "id": "negative-and-sorting",
      "description": "Unseen SKUs requiring negative totals and ascending output order.",
      "inputs": { "records": "cases/validation.csv" },
      "validation": true
    }
  ]
}
```

- `id`：领域标识，不是 Method ID、Task ID 或 Round ID。
- `task`：相对本目录的根合同路径。
- `source`：本次学习的实际输入。key 必须对应 `task.json` 的 input ID。
- `cases[].inputs`：仅替换该 case 变化的输入；未变化的输入沿用合同中的 `source`。
- `validation: true`：冻结为独立验证 case。这里的三个输入都是公开 fixture；这个标志不制造隐藏数据或安全边界。
- `acceptance: "checks"`：所有 required root criteria 都有 check，宿主直接在冻结输入和输出上执行。省略该字段或填写 `"review"`，则选择通用独立语义 review；它没有确定性检查能力，不能用来代替真实执行。每个 case 可单独覆盖 `acceptance`。
- 可选 `cases[].task`：该 case 使用另一份根 TaskSpec，以组成不同算子/不同任务的 suite；未填写时沿用默认 `task.json`。TaskSpec 仍只描述外部问题，不写 workflow、Method 或预算。
- 可选 `tools`：指向标准 MCP 环境声明，见下文。没有真实工具消费者时省略，不填空壳工具。

`domain.json` 不接受 `method`、`workflow`、`children`、`reviewerAgent`、`maxRuns`、`retry`、`provider`、`budget`、`deadline` 或 `activation`。这些是宿主或运行合同，不是领域知识。

### `task.json`

`goal`、`criteria`、`outputs` 对应公开 `TaskSpec`。`inputs` 比 `TaskSpec` 少写一个 `object`：宿主冻结文件后补成完整 `InputRef`，领域作者不计算 digest，也不接触 CAS。

- `id`：case 输入映射的 key。
- `path`：worker 和验收所见的相对路径。
- `access: "copy-to-work"`：任务实际消费的输入，物化到工作区。
- `access: "read"`：按需读取的公开资料或验收输入，不自动占据工作区；复验时仍以冻结输入提供。
- `source`：该输入在领域目录中的公共默认文件。case 可以覆盖它。

示例只保留一个可独立验证的外部结果：`rowCount` 正确、每个 SKU 的整数总量正确、保留零和负值、排序正确。它没有规定函数名、算法、子任务、工具、树深或“只能修改哪些 Singularity 资产”。

`criteria[].check` 是实际执行的命令，不是文档路径。本例 `python3 acceptance.py` 能运行，是因为 `acceptance.py` 是冻结输入；复验时宿主从 CAS 准备它，而不是读取 worker 修改过的脚本。Python 是操作者准备的环境前提。所有领域共用同一验收边界，见 [`../ACCEPTANCE.md`](../ACCEPTANCE.md)：宿主准备声明的输入/输出、执行冻结命令并从退出状态生成 `PublicReceipt`，脚本不接触调度器或历史会话。

复杂项目可以交付 `tree`，例如：

```json
{
  "id": "implementation",
  "path": "implementation",
  "kind": "tree",
  "role": "deliverable",
  "required": true
}
```

这声明交付边界，不限制实现内部文件结构。

## 验收与案例纪律

`acceptance.py` 从冻结 CSV 重新计算期望，不读取 worker 工作区、历史对话或 Method。正确报告和缺少 SKU 的报告必须分别通过和失败；本仓库的测试实际执行这两条路径。

换用其他领域时，应保持同样的纪律：

1. 验收检查真实 consumer 和真实输出，不检查“是否创建过工具”“是否分解过”“是否写过审核报告”。
2. 能用确定性检查就不要购买 LLM review。语义验收只处理脚本无法完整表达的部分；check 失败不能被 review 改成 pass。
3. source、公开 case、validation 都冻结真实 bytes，或可精确重建 bytes 的 seed 和规则。paired baseline/candidate 必须使用同一输入、验收和预算，只有 Method 不同。
4. case 应覆盖有区分度的外部行为，优先加入不同算子/不同任务的真实 consumer，不为同一 shape 换名字，也不把实例答案、case 专用解法或审核流程写进 guidance。
5. 一个 case 通过不代表迁移；通用实验以 paired verified consumer fraction 为质量指标，token 只作 uncached/cacheRead/cacheWrite 分列成本与上限，不能单独证明 RSI 改善。没有完整 baseline/candidate、validation 和质量比较，就不能声称 RSI 改善。

公开验收脚本便于调试。隐藏 fixture 不应复制进此目录，也不能靠路径、cwd、HOME 或工具描述来伪装保密；部署必须先提供现成 OS、容器或 broker 隔离。

## 可选环境资源：只提供标准 MCP

工具不是领域控制宿主的回调。领域可提供已有 MCP server 的源码、manifest、transport config 和真实业务 schema；宿主将它们冻结为现有 `ToolAsset`，通过原生 DSH MCP client 挂载。依赖由操作者预装，Task 模型只传业务参数。

需要时，在 `domain.json` 加：

```json
"tools": "tools.json"
```

`tools.json` 的填写示例（这是一个部署示例，不会启动不存在的路径）：

```json
[
  {
    "id": "inventory-cli",
    "name": "inventory_tools",
    "description": "Prepared inventory arithmetic CLI.",
    "kind": "mcp-server",
    "server": {
      "source": "environment",
      "manifest": "environment/manifest.json",
      "config": "environment/config.json",
      "capabilities": ["public-inventory-arithmetic"],
      "exposedTools": [
        {
          "name": "reconcile",
          "description": "Reconcile complete CSV texts; the caller writes the returned report in its own workspace.",
          "parameters": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "csvs": { "type": "array", "minItems": 1, "items": { "type": "string" } }
            },
            "required": ["csvs"]
          }
        }
      ]
    }
  }
]
```

`environment/manifest.json`：

```json
{
  "serverName": "inventory_tools",
  "transport": "stdio",
  "instructions": "Call mcp__inventory_tools__reconcile with complete CSV texts. Write the returned report in your own workspace.",
  "entrypoint": "server.cjs",
  "limits": { "maxBundleBytes": 1048576 }
}
```

`environment/config.json`：

```json
{
  "transport": "stdio",
  "command": "node",
  "args": ["server.cjs"],
  "env": {
    "DOMAIN_MCP_ROOT": "/absolute/prepared/mcp-dependencies"
  },
  "toolCallTimeoutMs": 30000,
  "maxInstructionBytes": 8192
}
```

工具实现不限语言。这个 CJS 例子可用 Node `createRequire` 从 `DOMAIN_MCP_ROOT` 加载预装依赖；Python 或已编译 server 则填写相应的启动命令。env-builder 在独立目录准备依赖并验证实际入口，宿主只将源码作为资产冻结，不 import 它。公开 config 不写凭据；凭据走部署的原生 launch environment 或 broker。

`capabilities` 只是描述，不是权限证明或白名单。不要在工具 description/instructions 里写 workflow、审批树、重试、预算或 Singularity 角色。上线前实测每个公开工具的业务成功、参数失败和取消退出；正式运行时还要看到 agent 的真实调用。若零调用，先查实际 schema、直接入口说明和任务需要，不保留仅为“以后可能有用”的工具。

本最小示例故意没有 `tools`：CSV 计算不需要为它增加一个工具。

## Method 和 workflow 的唯一演化路径

领域目录不预写 Method。worker 在自己的 Task 内承担技术工作、必要分解和本层集成；parent 编写直属 child 的目标、输入、输出和可执行验收，领域不代写这些合同。

可复用发现先作为 Task 的 learning drafts 交付。独立 RSI proposer 用 `rsi_read` 阅读封存证据，用 `rsi_submit_patch` 提交 `put-skill`、`put-mcp-server`、`put-template` 和入口绑定；宿主执行 precheck 和 paired evaluation。新增但未接入入口可达闭包的资产没有 worker 消费者，不构成改进。

领域不直接调用 `CommandService`、事实写入、Run controller、activation、reviewer 生命周期或 Method 内部对象。也不要在 `goal` 中要求“保持 workflow 节点身份”“产生 RSI”“必须使用某工具”——这些是 Singularity 的本层引导与执行责任，不是现实问题的完成条件。

## 调试与启动

不购买模型请求即可在目录中调试公开验收：

```bash
cd /absolute/my-domain
printf '%s\n' '{"rowCount":0,"totals":[]}' > report.json
python3 acceptance.py  # 应当失败并打印实际差异
```

修改配置后先检查：输入 ID 是否一致、每个 case 是否冻结了所需输入、check 是否只依赖声明的 CAS 输入和输出、失败是否真的非零退出。

宿主提供普通 env-builder 和声明式装载入口；领域目录无需 TypeScript 配置，也无需导入仓库。只有一叠原始资料时，先让普通 DSH session 整合出独立目录，再在另一个新执行中加载：

```bash
node apps/singularity/src/env-builder.ts /absolute/raw-materials /absolute/new-preparation-root
node apps/singularity/src/domain.ts /absolute/new-execution-root /absolute/new-preparation-root/domain
```

已经按上述格式准备好的目录可直接作为第二个参数。装载发生在新执行启动时，不是热替换正在运行的合同或 Method。

这条命令会启动真实实验并可能购买模型请求。启动前仍须由操作者明确授权并固定 provider/model/profile、凭据、可信环境、预算、并发和绝对 deadline；使用全新执行根，不续跑归档。领域清单不提供也不覆盖这些运行参数。

## 多轮研究归并到本样板的结论

- round10 的 19 个探索 child 产生 771 次 reviewer 请求，说明“每层再审一次”会替代实际工作；探索 child 用原生 checks，root 按问题需要选择验收。
- children 曾丢失 goal/deliverable，长运行后 parent 难以恢复职责；领域不应再生成额外汇报树来弥补宿主视图。
- 仅冻结 shape 会让 worker/reviewer 各自换题；案例必须冻结实际数据规则。
- bbdev 在 round10 schema 可见却零调用，说明工具数量不等于可消费性；领域只写清真实业务入口，并以真实调用检验。
- 空 MCP resources、无关角色文档和不可执行的工具提示只会稀释注意力；本样板不装载它们。
- 只注册 Skill 而未绑定入口不会产生执行变化；领域更不应通过内部 hook 绕过 MethodPatch 和 paired evaluation。
- 到目前为止，这些解释和修复不等于已测得 RSI 收益。最小领域合同只消除一类干扰，不能替代真实工作流、完整对照和泛化证据。
