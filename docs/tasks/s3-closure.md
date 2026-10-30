# S3 闭合、真实模型证据与薄度审查

## Goal / Spec refs

在不进入 S4 的前提下闭合 S3 的 C-03、C-11、C-12 证据；用指定真实 chat 模型复跑最终交付，并删除真实执行证明无消费者的 helper、重复门禁和补丁代码。

- Spec refs：framework §2–§4、§9–§15.3、§19.1、§21、§23；build-plan S1–S3；conformance C-02/C-03/C-11/C-12。
- 允许范围：S1–S3 既有 protocol/runtime/app、对应测试、模型路由默认值和证据文档。
- 非目标：不实现 child、RSI、evaluation；不修改 framework/spec-lock；不新增 writer、fold、registry、模型 loop、兼容层或通用 helper；不删除规范要求的 guard；不把 fixture 当真实模型证据。
- 并行边界：真实模型场景、C-11、只读薄度审查分别使用独立工作区；主代理负责默认路由、顺序整合和最终实跑。不得共享可写 checkout、HOME、缓存或工作区。
- Done when：C-03/C-11/C-12 的规范要求有对应真实执行证据；真实模型命令、场景、usage 与未覆盖项如实登记；精简项有消费者证据；最终代码上的真实模型和根 `pnpm verify` 均通过，否则保持 S3 未闭合且不进 S4。
- 检查：指定 Node 24 下 `pnpm install --frozen-lockfile`、根 `pnpm verify`、`git diff --check`，以及 `SINGULARITY_SPIKE_LIVE=1` 的真实模型场景。

## 模型配置边界

默认路由为 OpenAI-compatible chat endpoint `http://127.0.0.1:16660/v1`、model `deepseek-v4.1-flash`、`reasoning=max`。API key 只通过进程环境 `SINGULARITY_SPIKE_API_KEY` 提供，不写入仓库、文档、Composition 或证据日志。

## 实现与薄度结论

- C-02 live 使用真实 `buildSingleRunComposition`，不再接受占位 platform prompt；协议动作按持久 `tool/call` 与成功 `tool/result` 关联，保留 self-read → plan → bash → submit 和独立 verifier。live 使用合同上限 12 步，fixture 仍以 4 步证明最小路径。
- C-03 的 retry NodeView 从 journal 投影提供上一 Run 的公开 `lastAttempt`，不复制旧 transcript/verdict。retry 在任何新 fact 前复用 DSH 持久 `SessionHeader.cwd` 比较 canonical workspace；相同路径、symlink 别名或缺失持久事实均 fail closed，不新增 lease/registry。
- C-11 在同一真实 C-03 journal 上验证 closed resume 原 refs、零重复 verifier/模型/CAS 冻结、全量 replay 和 torn-tail 截断；既有 fixture 保留 command 幂等冲突与顺序/refs 负例。
- C-12 分别验证原 Composition resume 不重复购买 wake，以及完整 Composition 变化在 Agent/verifier/模型前结算 invalid。
- DSH job teardown 失败即使 `dispose()` 正常返回也结算 `invalid + drainPending`，不调用 verifier、不生成 Evidence；没有新增 job registry 或第二账本。

确定删除项包括：无消费者的 `isContextEpochCurrent`、`RunToolSnapshot.readSelf`、重复的 `submitted` 投影、`contractRef` 死链路、仅测试使用的 command supporting-object option、导出烟测、267 行测试 wake 副本和约 470 行动态 chat/SSE 复制。保留恢复结果中的诊断字段、两层工具 guard、verifier/Evidence、预算、Composition、wake 与 CAS guards。

## 真实模型证据

2026-10-31 在最终交付代码上执行：

```bash
export SINGULARITY_SPIKE_LIVE=1
# SINGULARITY_SPIKE_API_KEY 仅由进程环境提供；未设置 BASE_URL，验证默认路由
pnpm --filter @singularity/app test
```

Node `24.22.2`、pnpm `11.18.0`、DSH `0.2.2-alpha.2`、默认 chat `http://127.0.0.1:16660/v1`、`deepseek-v4.1-flash`、`reasoning=max`。全部 live app 场景 **31/31** 通过，未启动 scripted chat fixture 充当 live 证据。

- C-02：真实 scoped Composition、成功 self-read → plan → bash → submit、独立 CAS verifier 通过；Evidence `sha256:e78abbf37462eb639a0fead42b5dee4ccab3dc9d9ab25da115ac350fe6154af7`。
- C-03：首 Run `no-submission`，ExecutionRecord `sha256:d7693e1fcdf7d4ba0632b297e04f9ff7f79aa0f0e0b9739459b4b378c93ee236`，usage `2198/47 tokens, 1 step, unknown=0`；fresh Run/session/workspace 重新 submit/verify，manifest `sha256:c40e8220a6f37bd809adeb64020171752a7931fb1cfb580011f3830d65fd3069`，receipt `sha256:7c246c6737947bc2ccd6f2236ce0c419d57770268efb529c1e4a71305c7e5b77`，Evidence `sha256:e44ca08d5a95cf1e0165b95043b1b3a4ec696f2994f5db24f8ae06daf1a9d5fd`，usage `39380/2110 tokens, 6 steps, unknown=0`。旧 ExecutionRecord 保留，retry worker 收到公开 `lastAttempt`。
- C-11：复用上述真实 journal，closed resume 返回原 manifest/receipt/Evidence/run/task facts，未重新 verifier、模型或 CAS 冻结；全量 replay 7 facts，完整无 LF tail 被截断且 journal/CAS 不变。Run closed `sha256:474009f63b28a62a3c1fd0e764ffce63ca47e822f36449ca9af06bd1c9cb934e`，Task closed `sha256:ce34a480b29f6a50d59cca81b90a9bdea04287ef93ae4c34a56d6a70ebc682d8`。
- C-12 match：`wakeOutcome=already-admitted`，resume 零新模型请求；ExecutionRecord `sha256:747218380f262e2e5d2147c052419ba9726ff27dfc7dc1c0183d9e8a330e5bb4`，usage `1312/1 tokens, 1 step, unknown=0`。
- C-12 mismatch：完整 Composition 变化在 Agent/verifier/模型前结算 invalid；ExecutionRecord `sha256:47059755eaae09d696f68085242e1c89d4d13ac4d5babbd652f6b29618b847c8`，usage `unknownRequests=1`，未伪造成 0。

最终根 `pnpm verify` 通过 **341/341**（protocol 225、runtime 85、app 31），`git diff --check` 通过。framework/spec-lock 未改；没有第二 writer/fold/registry、模型 loop、process runner 或新生产依赖。

C-02/C-03/C-11/C-12 升级为 proven，S3 完成，可进入 S4。自动 pressure compaction、summary 独立预算、不可停止进程的实际 sandbox quarantine、S4 preview/read receipt 和 S6 evaluation Capsule 不在本次证明范围；其他 conformance 状态不变。
