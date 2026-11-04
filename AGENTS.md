# Singularity 项目级 Agent 工作约束

## 权威与授权

- `docs/framework.md` 是协议唯一权威；`spec-lock.json` 固定其 digest。`AGENTS.md` 只写施工约束，`docs/progress.md` 写当前状态、证据和缺口。调研 artifact 不替代规范，不另建平行任务卡和交接规范。
- 开始或恢复工作时阅读相关规范、进度和实际消费者；保留工作区已有未提交成果。旧 Singularity 仓库不提供本仓库兼容要求。
- 用户已授权本次核实审计，并联动修改架构、约束、代码和测试；amendment 006/007/008/009/010/011/012/013/014/015/016/017/018 记录本次运行契约与原生优先原则。常规实现选择自主推进，不重复请求确认。未来超出已授权范围的公开协议/authority 变化先说明 amendment；用户明确授权优先。

## 启动条件先于执行

- 使用 Node >=24.9.0、pnpm 11.18.0、DSH 0.2.2-alpha.2 和固定 lockfile。启动前固定 provider/model/profile、凭据、可信 MCP/skill 资产、验收、预算和绝对 deadline。
- 一个执行根归一个进程；运行中不重启，不让 supervisor 自动重启。退出后的根只作归档，下一次执行使用新根和新 IDs，不建立 crash resume/reconcile/灾备产品。
- app 在 profile boot 前验证剩余预算并 exclusive create 输出根；Run 在模型创建前验证冻结资源、provider identity 并准备输入。真实 scoped prompt/MCP surface 在 setup、第一模型请求前完成校验；固定 profile 只启用原生 skill registry/loader，Singularity 自产冻结 skills 注册到 Agent scope；项目原有 skills 只用 root 提示中的参考文档路径暴露，不逐字段重读自检。
- 操作者提供健康存储和干净 launch env。可信公开任务沿现有本地 profile 执行；隐藏数据或不可信代码先用现成 OS/容器/broker 建立真实读写/网络/进程边界。cwd、HOME、chmod、loopback URL 和 manifest capability 声明均不能代替这些边界。
- profile 不挂载任意 filesystem/global skill provider，不在执行中修改共享 registry；全局公开资源先冻结再注册到当前 scope。MCP 的 HOME/TMP/XDG 路径由部署环境提供，框架不创建或重定向。可信 bundle 的 capability 列表只作描述，manifest/config 只解析消费字段，不设 exact-key/能力白名单门禁；实际 surface 对比保留。
- 领域 MCP 上线前实测全部公开工具的业务成功、参数失败和取消退出；帮助/握手只证明接口可见，不能替代执行。独立源码副本由领域 checkout/现成复制工具携带完整预装依赖，不让 Task 模型重新安装。
- 领域 CLI 经标准 MCP 提供；操作者或领域 MCP 准备依赖并在目标项目内激活环境（如 nix develop → bash）。Task 模型传业务参数，runtime 不实现领域环境准备。
- 公开 profile/config 只提供公开 JSON 值，凭据通过原生 launchEnvironment 注入；Composition 序列化不扫描 password/token 等字段名。DSH MCP client 已有原生环境名称 scrub；不再维护第二份 credential 清单，不宣称原生启发式去除了所有凭据渠道。

## 唯一 authority 与依赖

- `runtime → protocol`、`app → runtime`、`domain → protocol public types`。protocol 保持纯 TS，除纯 hash 外不访问宿主副作用；runtime 不包含领域算法/suite 分支，app 只做组合。
- Task、Run、Method、Evidence、RsiRound 是业务概念；Task 树是只读投影。每个 domain 一个 CommandService、事实序列、纯 fold 和 Task wake authority。SQLite 事务内强制 guard → INSERT fact → COMMIT；retry policy 参数不能关闭 guard。领域投影和 CAS 解析可缓存；命令去重直接查询 events.command_id 唯一索引，不维护内存 command projection 或第二份可变业务状态表。CAS 用同目录完整临时文件 + 原生 link 原子发布；不添加 append 引用扫描或修复器。
- DSH 拥有 Agent/Session、模型 loop、tool/skill registry、MCP transport、compaction、session persistence、创建回滚、取消和 disposal。直接组合公开能力；同步 receipt/usage 原始事件读取只留一个经过接入成本比较的适配入口，不复制 inbox 或 transcript。
- 每个 worker 是 workflow 的一级：先形成草图，再依据相关资源在 purpose/assumptions 细化功能、依赖、消费者、证据及预计成本/不确定性；只派发当前就绪的直属职责，消费前批结果后形成下批合同。每层承担本地技术工作与集成；叶节点须前提已成立、结果可直接验证，同一 checkout 不构成叶节点依据。优化现有 prompt，不增语义判定器、固定树深或分解数量门禁；guided 分解证据不能升级为空 Method 自主发现多层 workflow 的证据。
- 正式 child Task 使用独立 DSH session；只创建 direct children，root/descendants 固定 Method revision，运行中合同不变。Summary 是按合同 digest 派生的只读业务缓存，usage 归 source Task；Summary 使用原生 agents.create/dispose；替换为 subagent 所需的 live parent/preset/catalog 成本比较见 `docs/progress.md` 的原生接入比较。
- root acceptance 归 operator/domain；parent 在派发前编写非空 acceptanceCriteria（statement + 自包含 shell check），准入后冻结为 required 合同项。探索 child 仍固定 required result/ tree；host 用原生 shell 对 CAS 产物复验命令，review 不能放行失败检查。保留冻结 Ref/digest 和外部 receipt 绑定；DB 外键不能证明外部内容身份。Proposer 只提交 patch，host 评测、比较和 trusted expected-head activation；隐藏 payload 保持实际部署读取边界。

## 最短正常路径

- 默认使用现成库和 DSH 公开插件。保留自定义层必须列出可用原生调用路径，比较本项目接入后的状态、分支和适配成本，明确证明原生方案更复杂；“暂不能证明等价”不构成保留理由。可由操作者固定的环境条件写在启动约定，不添加运行期兜底。内部文件拆分由消费者决定，不设行数/文件数指标，不把临时 owner 表当永久架构。
- 边界验证真实输入，内部复用已解析类型和结果。相对路径共用 schema；DSH defineTool 已校验参数的部分不再手写 exact-key/类型检查。产物冻结使用原生递归 readdir、leaf no-follow 和最终 hash；不恢复 ancestor walker。路径隔离是部署前置条件，可信本地 fixture 不冒充私有/不可信部署。Zod 单源定义协议结构，Ajv 处理模板提供的动态 JSON Schema；不用手写 JSON parser/schema interpreter，不在每次解析时做 canonical JSON 往返。协议 schema 不使用 transform/default/coercion，由源码门禁约束。
- 只有模型可修正的参数、计划、提交和协议拒绝返回模型。宿主 CAS、provider、会话、资源、原生清理等未知异常保留原始原因，原生 cancel/dispose 后抛出，不写虚假 invalid/Evidence/闭合 fact。Summary、Proposer、precheck 与 Task 工具遵守同一边界。清理须尝试完成；多重失败保留全部原因，不吞错误。
- 完成的非法工具参数走 DSH 原生解析/校验；Singularity 工具保留原始失败并附 failed 与完整极简格式用例。用例按需展示，不堆进 system prompt；不修补 JSON、不匹配自然语言错误、不建立参数恢复或 provider 重购机制。原始畸形参数须经过真实 provider adapter 的无付费回归，不能只用 JSON.stringify fixture 证明该路径。
- 预算/截止、领域失败和无效验收仍按协议结算。verifier 转发 AbortSignal 并等待自己拥有的工作退出，不能丢弃 Promise 冒充停止。任意不合作进程内代码不在强停保证内。
- retry 通过既有 evidence 读取最近 closed Run 的公开逐项验收，复用其 CAS 冻结输出；不读取旧 workspace/transcript。start/batch/tool 预算共用当前 Task 投影，retry 不重置 token/time 百分比。
- resource 文本读取的 UTF-8 边界用 Node 原生 isUtf8；合法二进制对象返回模型可改正的工具拒绝，使用 copy-to-work 与原生文件工具。CAS 读取异常仍是宿主异常，不添加格式猜测或解包恢复器。
- 同进程 yield → 整批 terminal 或直属反馈 → continue 是正常路径；只允许实际观察到的 live yield 续接，不从归档重建。保持原合同、session 和 deadline；已挂载 child 输出不重复覆盖。stop(blocked) 交回 dispatcher 且不自动 retry；普通业务 retry 使用新 Run/session 和独占创建的新 workspace，保留 required feedback/replan/replacement；probe 允许同批多实例与后续批次的新问题，不沿用 required winner 或自动 replacement 门禁。
- 工具条件复用一个 dispatch guard；wake 使用原生 deriveMessages 的消息 ID 判重，不承诺 provider exactly-once。submit 用 DSH exclusive 工具直接冻结 CAS，不建立进程表探测、静止检测或备用作业管理器。
- TS 使用 ESM、严格类型、import type、本地 `.ts` 导入、包 exports、references 和 Cordis effects。新增生产依赖服务当前消费者并同步 lockfile；helper 仅承载实际重复或明确业务职责。

## 验证与证据

```bash
pnpm install --frozen-lockfile
pnpm verify
```

- 根 `pnpm verify` 依次检查 project、build、typecheck、lint、test；开发先跑相关检查，失败修复后复跑，集成完成跑根门禁，不机械重复验证。
- 测试按批准后的协议迁移：删除退出后恢复/torn-tail 期待，保留业务 retry、live continuation、receipt/权限/预算/领域行为。宿主错误测试断言原始错误、原生资源结束、无新增模型请求和无虚假闭合；不能只改成宽泛通过。
- tests 在所属 `*.test.ts` 注册，fixture 只提供构造；并行 runner 使用独立目录、DSH_HOME 和缓存。保留用户已有成果，不清理其他工作的目录。
- 区分纯协议测试、真实 DSH fixture、真实模型、冻结多 case 领域评测。低等级证据不能升级；历史 A–J 只证明其冻结版本。付费请求和 activation 遵守用户授权的窗口、预算与范围，进度记录实际消费及证据。
- 同步受影响的规范、lock、约束、进度和注释；进度明确未覆盖项，不把工具/fact 计数当分支覆盖率。secrets/private fixtures 不进入公开文本和日志。
