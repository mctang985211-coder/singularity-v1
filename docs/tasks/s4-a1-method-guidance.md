# S4-A1 — Method revision pin 与当前层 guidance 装配

## Goal

在现有单 Run 闭环上接通第一个最小资源纵切：host 从同一个冻结 `MethodRevision` 核对 `contract.method` / `contract.template`，解析当前模板的 `guidance`，把 template/guidance 身份写入 Composition；runtime 在 create 与 resume 的 Agent setup 前从 CAS 复验同一对象图，并将完全相同的 guidance 正文注册为实际 DSH `systemPrompt.section`。

## Spec refs

- `docs/framework.md` §2：setup 在 Agent 发布和第一次模型请求前完成冻结能力装配；局部 guidance 使用 system prompt contribution。
- §4.0、§4.1：`MethodRef` / `TemplateRef` 使用 method domain，`TemplateRef.digest == MethodRef.digest`；同一 Task 不读取“最新 Method”。
- §5：每层只使用自己的 template/guidance；template 的资源由所在 Method revision 固定。
- §12、§13：平台 card 与当前层局部指导各有明确位置，不注入整段 Method 或其他层 guidance。
- §14.3：own guidance 最大 `8 KiB`，超限拒绝，不静默截断。
- §15.2：Composition 冻结局部 template/guidance 及实际 DSH composition identity。
- §19.1：resume 必须重新装配并比较完整 Composition，而非只比较名称。
- Conformance：为 C-01/C-20 提供本切片的局部回归；C-12 保持既有真实模型 `proven`，本片只补 Composition/resume 局部回归，不重复或扩大证明范围；本片不将任何 conformance 场景升级为 `proven`。

## Allowed scope

- 新增 `packages/singularity/runtime/src/resources.ts`，负责冻结 Method/template/guidance 的读取、身份核对、UTF-8 正文解析和 8 KiB 上限。
- 对 `runtime/src/run.ts`、`runtime/src/agent.ts` 作必要最小接入；对 `runtime/src/recovery-execution.ts` 仅在共享 create/resume 接入确实无法覆盖时作最小修改。
- 修改 `runtime/src/index.ts` 的当前消费者所需内部导出；不新增生产依赖。
- 修改 `apps/singularity/src/host-composition.ts`，让 host 从 MethodRevision 派生 Composition 的 template/guidance，并保持 platformPrompt 与实际 scoped contribution 一致。
- 修改现有相关 runtime/app tests 与 chat fixture，增加负例和真实 DSH fixture 回归。
- 本任务卡及其实际验证、行数、导出和依赖记录。

## Non-goals

- 不接入 skill、MCP、decompose、feedback、ancestor、child batch、exploration fallback 或 Summary Worker。
- 不修改 `docs/framework.md`、`spec-lock.json`、公开冻结协议、fact、工具输入或验收语义；不更新 conformance 状态。
- 不修改 DSH 本体，不增加 patch/shim，不引入第二模型 loop、writer、registry 或 transcript。
- 不购买真实模型请求，不宣称真实模型、完整 C-01/C-12/C-20 或完整 S4-A 已证明。
- 不大规模重构，不提交或推送。

## 当前消费者与不变量

- `buildSingleRunComposition` 的现有 app 场景是 host 消费者：输入同一 `TaskContract` + `MethodRevision`，输出可复验的 `CompositionPayload`，不再由调用方任意提供 template ref。
- `executeSingleRun` / `resumeSingleRun` 是 runtime 消费者：在任何 Agent/模型副作用前，从冻结 CAS 读取并核对 Method、template、guidance 和 Composition；retry 继续复用原 Composition。
- `driveAgent` 是 DSH 消费者：setup 注册 `singularity:method-guidance`，与 host 对 `platformPrompt` 的计算使用相同 section name/order/text/interpolation。
- 不变量：错误 Method id/digest、TemplateRef 与 Method 不一致、当前 template 悬空、template/guidance ref 与 Composition 不一致、CAS 缺失/损坏、guidance 非严格 UTF-8/非约定文本对象、超过 `8192` bytes 均 fail closed。
- 不变量：非空 skills/MCP/exploration 继续以 `UNSUPPORTED_RESOURCES` 明确拒绝；本片不提前声明这些能力。

## Done when

- [x] host 从同一 MethodRevision 派生并冻结当前 template 和 guidance；Composition 的 refs、实际 DSH scoped system prompt 与首个 fixture wire request 一致。
- [x] create 和 resume 都重新读取/验证冻结 MethodRevision、当前 template 与 guidance；恢复不读取另一 revision，也不产生额外模型请求。
- [x] 错误 pin、悬空 template、guidance digest/ref 不匹配、缺失对象、超限 guidance 在 Agent/模型请求前拒绝；CAS/journal 已有事实不被伪造成成功执行。
- [x] 真实 DSH + chat fixture 证明 guidance 在 create 首请求前装配；resume 通过实际 scoped setup 重装配同一 guidance，持久历史前缀不变且仅允许既有 `end-seed` 追加，零新请求；不声称 seed 历史本身已有 guidance。记录请求数，证据等级不越界。
- [x] 既有 skill/MCP 拒绝和 S1–S3 相关回归保持通过。
- [x] 先记录新负例在未实现代码上的失败，再记录实现后的通过；运行相关测试、根 `pnpm verify`、`git diff --check`。

## 失败场景 / 所需证据

先在未实现实现上运行新增测试并保存真实失败输出，再实现：

1. host 未从 MethodRevision 派生 guidance：预期新 Composition 包含当前 template/guidance，旧实现缺失或仍允许任意 template。
2. Agent 未装配 guidance：首个真实 DSH fixture 请求必须含当前层 guidance 标记，且不包含另一模板标记；旧实现应在该断言失败。
3. 错误 Method/TemplateRef pin、悬空 template、错误 Composition template/guidance ref、缺失 Method/guidance CAS、错误 guidance digest、非 UTF-8/错误文本对象和 `8193` bytes guidance：预期 fail closed；旧实现至少应在核心拒绝断言失败。
4. resume 重建时 Method/guidance 缺失或变化：预期在 Agent/verifier/新模型请求前拒绝或沿既有 composition-mismatch invalid 路径关闭，不允许换 pin 后继续。
5. `8192` bytes guidance 边界可用，`8193` bytes 拒绝；不得截断。

证据只声称仓库/协议负例与真实 DSH fixture 等级；fixture provider 不是实际模型。

## 验证命令

统一环境：

```bash
export PATH=/home/ROXY/code/singularity/.tooling/node-v24.22.2-linux-x64/bin:$PATH
node --version
pnpm --version
# 固定依赖：@deepseek-ai/dsh 0.2.2-alpha.2
```

负例先行与定向回归：

```bash
pnpm --filter @singularity/runtime build
node --test --test-name-pattern='S4-A1|method guidance|Method revision' packages/singularity/runtime/test/recovery.test.ts
pnpm --filter @singularity/app build
node --test --test-name-pattern='S4-A1|method guidance|Method revision' apps/singularity/test/run-recovery.test.ts
```

最终门禁：

```bash
pnpm --filter @singularity/runtime test
pnpm --filter @singularity/app test
pnpm verify
git diff --check
```

## Structure done when

- `resources.ts` 是唯一 Method/template/guidance 解析与授权视图；`run.ts` 只把解析结果纳入 PreparedRun，`agent.ts` 只注册 DSH contribution，app 只负责 composition。
- create/resume 共用同一解析结果，不在 recovery 另写一套 Method 解析；NodeView、settlement、fold、writer 与 CAS 权威不变。
- runtime package index 仅导出 host/测试当前消费的解析 API；无零消费者公开导出、无新增 dependencies/lockfile 变化、无 runtime 反向依赖 app。
- 起始生产行数：`run.ts=726`、`agent.ts=329`、`host-composition.ts=222`、`recovery-execution.ts=582`；新增职责放入 `resources.ts`，避免向既有大文件堆入资源解析。
- 完成后登记 before/after 行数、实际导出/依赖变化、测试数量与未覆盖项；若 `run.ts` 增量接近本片治理触发线，继续收敛接入而不是复制 helper。

## Verification evidence

实施与实跑完成。环境：官方 Node `v24.22.2`、pnpm `11.18.0`、DSH `0.2.2-alpha.2`，在 worktree 内执行 frozen install，DSH_HOME/TMP/cache 均指向 worktree `.tmp`。未设置 `SINGULARITY_SPIKE_LIVE`，未购买真实模型请求。

### 失败证据（baseline `191ca04`，实现前）

```bash
node --test --test-name-pattern='S4-A1|method guidance|Method revision' packages/singularity/runtime/test/recovery.test.ts
# tests 15, pass 0, fail 15
node --test --test-name-pattern='S4-A1|method guidance|Method revision' apps/singularity/test/run-recovery.test.ts
# tests 4, pass 0, fail 4
```

旧实现的核心拒绝为 `SingleRunError(UNSUPPORTED_RESOURCES): this single-Run slice does not mount skills, MCP servers, or composition guidance`（旧 `run.ts:488`）；旧 host 不读取 MethodRevision，new-style host 调用得到缺失/任意 template。原始输出保存在 worktree `.tmp/s4a1-runtime-baseline.log`、`.tmp/s4a1-app-baseline.log`（gitignored）。

### 实现后

```bash
node --test --test-name-pattern='S4-A1|method guidance|Method revision' packages/singularity/runtime/test/recovery.test.ts
# tests 34, pass 34, fail 0
node --test --test-name-pattern='S4-A1|method guidance|Method revision' apps/singularity/test/run-recovery.test.ts
# tests 6, pass 6, fail 0
pnpm --filter @singularity/runtime test   # 120/120
pnpm --filter @singularity/app test       # 37/37
pnpm verify                               # exit 0; protocol 225/225, runtime 120/120, app 37/37
git diff --check                          # exit 0
```

- host：`buildSingleRunComposition` 从同一 `TaskContract` + CAS 中的冻结 `MethodRevision` 选择 `contract.template.id`，写出 template 对象引用并冻结 `guidance`；`platformPrompt` 用与实际 Agent setup 相同的 section name/order/text/interpolation（`singularity:method-guidance`，order 200，`interpolate=false`）计算。
- runtime：app 通过 `PLATFORM_PROMPT_SERVICE` 注入窄 renderer；Agent setup 在发布前渲染实际 scoped assembly、按 `computeDigest('object',{v:1,text})` 复验 `Composition.platformPrompt`。错误 platformPrompt 在 create/resume 均以 invalid 关闭，零模型请求；不新增 runtime 对 `dsh-system-prompt` 的依赖，也不复制 renderer。
- structured digest：guidance 与 Composition template 除 CAS raw digest 外，还按 framework §4.0 复验 `computeDigest('object', parsedValue) == ref.digest`；non-canonical JSON（raw-byte ref 合法）和 CAS 字节 tamper 均拒绝。
- create 真实 DSH + chat fixture：1 个请求；首个 wire request 的 system message 文本与 actual scoped assembly 逐字符相等，含当前 guidance 标记且不含第二模板标记；Composition template CAS 正文逐字段等于 pinned template；guidance ref 等于 template guidance；`platformPrompt == computeDigest('object', {v:1,text:renderPrompt(actual scoped assembly)})`。NodeView `ownTemplate.brief` 来自 pinned template。
- resume 真实 DSH + chat fixture：seed 阶段 1 个请求；resume `create=0`/`resume=1`，请求数仍为 1；resumed scoped setup 重装配相同 guidance 且等于 `platformPrompt`；持久历史和 `seededEvents` 前缀逐事件不变，仅追加既有 `session/end-seed`；无新 `turn/start`、`assistant/message` 或 user message。这里只证明 setup 重装配与历史前缀，不声称 seed 历史本身已含 guidance。
- 语义 invalid closure：已 open Run 的 guidance 对象/超限/Composition template 语义错误沿 `closeOpenedRunInvalid` → `settleInvalidRecord` 关闭为 `resource-invalid:*`，零 Agent/verifier/新请求；已 submitted Run 的资源错误在 verifier 前以 invalid ExecutionRecord 结算，保留原 `run/submitted` fact 和 refs，不写 Evidence。只捕获 `MethodResourceError`，不吞后续执行错误。
- 缺失 guidance CAS：resume 在 store replay 阶段以 CAS 引用错误拒绝，先于 Agent/service 语义路径；切换到另一 Method revision：沿既有 composition-mismatch invalid 路径关闭。二者均零新请求。
- 8 KiB：guidance 正文 UTF-8 `8192` bytes（含多字节 `界`）可用并以 `8192` bytes 注册；`8193` bytes（含多字节）、缺失对象、错误 digest、CAS tamper、非严格 UTF-8、非 `{v:1,text:string}` 对象均在 Agent/verifier/新模型请求前拒绝；create 为 `CONTRACT_INVALID`/`UNSUPPORTED_RESOURCES` 拒绝，resume 语义错误为 invalid closure。未截断。限额按 guidance `text` 的 UTF-8 字节数计量，不含 JSON 外壳。
- skill/MCP/exploration：template `skills`/`tools` 非空、contract skills/MCP/exploration、Composition skills/MCP 均以 `UNSUPPORTED_RESOURCES` 拒绝。

### 证据边界

fixture provider 不是实际模型；本片未升级任何 conformance 状态。C-12 仍保持既有真实模型 `proven`，本片只补 Composition/resume 局部回归，不重复或扩大其证明范围；C-20 仅做全量回归，不把本片 fixture 当作该场景的新证据；C-01 仍为 `unproven`。skill/MCP/exploration、child/ancestor/summary、真实模型与领域评测均未在本片验证。

### Actual structure data

| 文件 | before | after | 变化 |
|---|---:|---:|---:|
| `packages/singularity/runtime/src/run.ts` | 726 | 750 | +24 |
| `packages/singularity/runtime/src/agent.ts` | 329 | 362 | +33 |
| `packages/singularity/runtime/src/recovery-execution.ts` | 582 | 618 | +36 |
| `apps/singularity/src/host-composition.ts` | 222 | 262 | +40 |
| `packages/singularity/runtime/src/resources.ts` | — | 271 | +271（新） |

- 生产文件均低于 800 行；既有文件增量均低于 150 行触发线，未触发拆分。Method/template/guidance 读取、structured digest、严格 UTF-8/文本对象解析、8 KiB 上限、Composition equality、platform prompt 校验和 `MethodResourceError` 集中在 `resources.ts`；`run.ts` 只把内部 `FrozenMethodResources` 纳入 `PreparedRun` 并在写 fact 前调用，`agent.ts` 只注册 DSH section 并调用 host 注入的 renderer，app 只负责 composition 与 capability 注入。
- runtime index 导出：`loadMethodResources`、`assertCompositionResources`、`METHOD_GUIDANCE_SECTION`、`METHOD_GUIDANCE_ORDER`、`PLATFORM_PROMPT_SERVICE`；`FrozenMethodResources` 不再从 package index 导出（内部类型仍由 `loadMethodResources` 返回），`METHOD_GUIDANCE_MAX_BYTES` 与 `MethodResourceError` 保持模块内部。无新增生产依赖、无 lockfile 变化、无 runtime→app 反向依赖。
- 测试：runtime S4-A1 定向 34/34、app S4-A1 定向 6/6；最终 runtime 120/120、app 37/37、protocol 225/225，根 `pnpm verify` 合计 382。
- 未覆盖：skill/MCP/exploration 仍以 `UNSUPPORTED_RESOURCES` 拒绝；child/ancestor/summary/真实模型、完整 C-04–C-09/C-21/C-22 不在本片范围；`Composition.template` 的 CAS 对象 id 由 host 生成，权威仍由 method pin + structured digest + 正文 equality 校验；缺失 CAS 在 store replay 阶段拒绝，尚未形成 invalid closure。
