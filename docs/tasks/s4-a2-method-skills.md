# S4-A2 — Method skill 绑定、原生 discovery 与只读 guard

- **状态**：已完成（S4-A2）。

## Goal

在 A1 的 Method/template/guidance pin 上，接通最小完整的 skill 纵切：host 从同一冻结 `MethodRevision` 解析 `template.skills → Method.skills → contract.resources.skills → Composition.skills`，runtime 从 CAS 读取并校验 tree bundle、`SKILL.md` 与引用文件，在 Agent scope 内通过 DSH 原生 `SkillRegistry.register` 注册内存 skill，不写宿主文件、不建第二 registry；首个模型请求前由 DSH 原生 skill catalog 发现，`skill` 工具按冻结名称读取，未绑定名称在 dispatch 前拒绝。create/resume 都复验同一 Composition；discovery 8 KiB、单次 skill result 16 KiB 超限显式拒绝，不截断。MCP/exploration 继续明确拒绝，`platformPrompt` 仍按 A1 复验。

## Spec refs

- `docs/framework.md` §2：DSH 拥有 skill registry；setup 在第一请求前完成冻结能力装配。
- §5：`MethodRevision`/`SkillAsset`/`TaskTemplate.skills`；每层只用自己的冻结资产。
- §6.1：普通层只获得自己的冻结 bindings；本片不接 global snapshot/exploration。
- §12.1–§12.4：skill discovery/正文位置；NodeView skills/tools 只列身份；不重复 description。
- §13：固定 worker card；skill 正文不进入 system prompt。
- §14.1–§14.3：`skill` 是 DSH 原生工具；discovery 8 KiB、单 read/skill result 16 KiB、NodeView 8 KiB、tool schema 12 KiB。
- §15.2：`Composition.skills` 是完整 skill bundle refs。
- §19.1：resume 重装配并比较 Composition；资源错误在 Agent/verifier/模型前关闭。
- `docs/tasks/s4-a1-method-guidance.md`、`AGENTS.md` §3/§4.1/§5。
- 本片只提供仓库/类型/unit + 真实 DSH fixture 证据，不升级 C-20/C-09 或其他 conformance。

## Allowed scope

- `packages/singularity/runtime/src/resources.ts`：skill 资源编排、Composition equality 与 platform prompt 复验。
- 新增 `packages/singularity/runtime/src/skill-resources.ts`：skill 资产/顺序/上限校验与树 bundle 语义；当前消费者为 `resources.ts`。
- 新增 `packages/singularity/runtime/src/resource-bundle.ts`：只读 tree manifest/CAS 文件读取与摘要校验；当前消费者为 `skill-resources.ts`。
- `runtime/src/run.ts`：NodeView skills/tools 与 controller 的冻结 skill 名称；不承载 skill 解析。
- 新增 `packages/singularity/runtime/src/agent-skills.ts`：Agent scope 原生 skill 注册、`skill` 工具可用性、discovery/definition 的 runtime+opaque winner 校验；由 `agent.ts` setup 调用。
- `runtime/src/agent.ts`：只调用 skill setup helper、`skill` 工具 allow/restrict；不承载 discovery 解析。
- `runtime/src/tools.ts`：`skill` 名称 guard 与 `INPUT_NOT_AUTHORIZED` nextAction。
- 不改 `runtime/src/store.ts`/`service.ts`/`recovery.ts`；保持统一严格 CAS 引用校验。缺失 skill bundle 在 store replay 以 `OBJECT_MISSING`/`REFERENCE_INVALID` 拒绝，不写成功 closure；只有对象存在但语义 invalid 才由 `MethodResourceError` 形成 resource-invalid closure。
- `runtime/src/index.ts`：仅在出现真实消费者时导出；优先保持现有导出。
- `apps/singularity/src/host-composition.ts`：从 Method 派生 `composition.skills`，移除调用方对 `base.skills` 的任意输入。
- `runtime/package.json`/`pnpm-lock.yaml`：如需官方 DSH skill 类型，加入已有的 `@deepseek-ai/dsh-skill@0.2.2-alpha.2` dependency edge；不新增包版本。
- 相关 runtime/app tests、fixtures、任务卡、build-plan 与本片证据记录。
- 不修改 `docs/framework.md`、`spec-lock.json`、protocol schema、公开工具输入或验收语义。

## Non-goals

- 不接 MCP server、child batch/decompose、feedback、ancestor、Summary Worker、 exploration fallback、draft artifact 或 RSI/MethodPatch。
- 不新增 skill tool、第二 SkillRegistry、filesystem skill provider、TS adapter、registry/transcript/writer/fold。
- 不把 skill bundle 解包到 workspace/HOME，不设置 `resourceBase.kind='directory'`。
- 不实现引用资源的模型读取工具；本片只做 CAS 读取/摘要校验，正文读取留给 S4-G/S7-B。
- 不实现 YAML frontmatter 解析；不引入 YAML/zod 新依赖。
- 不修改 A1 的 platformPrompt 语义；skill catalog 是 user message，不进 system prompt。
- 不购买真实模型请求；不宣称 C-20/C-09 整体 proven。

## 当前消费者与不变量

消费者：

- host：`buildSingleRunComposition` 必须从 `loadMethodResources` 派生 `composition.skills`，不能信任 `base.skills`。
- create：`openSingleRun` 在 `run/opened` 前完成 skill 解析/Composition equality。
- resume/submitted：`loadPreparedRun`/`completeSubmittedRun` 复用同一解析；`MethodResourceError` 沿既有 invalid closure，零 Agent/verifier/模型。
- drive：`drivePreparedRun`/`buildNodeView` 从冻结 plan 生成 NodeView。
- setup：`buildAgentSetup` 注册 DSH skill、allow `skill`、校验 discovery 集合和 prompt 预算。
- dispatch：`RunToolController` 拒绝未绑定 skill。

不变量：

1. 身份顺序固定为 `template.skills[i] → Method.skills 唯一 id → SkillAsset.bundle → contract.resources.skills[i] → Composition.skills[i]`。
2. `contract.resources.skills` 与 `Composition.skills` 都是同一组 frozen bundle refs，长度/顺序/id/digest 完全相等；不允许额外或重排。
3. `SkillAsset.id`、`name` 唯一；`name` 必须是 DSH kebab-case；`description` 非空。重复名称不能依赖 DSH first-wins。
4. 普通层只注册当前 template 绑定的 skills；`ctx.skills.snapshot({scope:agent})` 必须恰好等于绑定集合且 `complete=true`，否则 setup fail closed。
5. skill 正文只经 DSH `skill` tool 按需读取；不进入 system prompt、Composition body、NodeView description 或重复 catalog。
6. discovery 名称/简介上限 8 KiB；单次 `renderSkillContent` 结果上限 16 KiB；超限拒绝，不截断。
7. `skill` 在 self-read 前只作为只读说明读取放行；未绑定名称、其他 agent、submitted/closed 状态仍拒绝。
8. create/resume 共用 `loadMethodResources`，不另写 recovery 解析；Composition mismatch 在 Agent/verifier/模型前关闭。
9. 不写宿主 skill 文件；`resourceBase` 使用 opaque 描述；DSH session log 的 catalog/skill result 持久化是预期行为。
10. 不建立第二 registry；`ctx.skills` 是唯一 skill registry，NodeView 只投影冻结 plan。

## 冻结的内部约定（无需 amendment）

1. `contract.resources.skills` 指向 `SkillAsset.bundle` refs（object domain）；`Composition.skills` 使用同一组 refs。Method 的 `SkillAsset` 提供 id/name/description，不单独写 SkillAsset CAS 对象。
2. bundle 复用 `workspace.ts` 的 `SealedTreeManifest` 形状 `{v:1,kind:'tree',files:[{path,bytes,object}],digest}`；路径规则与 `assertWorkspaceRelativePath` 相同；顺序沿用 `freezeTree` 的目录内按名排序、DFS 前序。
3. bundle 根必须恰有一个 `SKILL.md`；正文按严格 UTF-8 原样注册；不解析 frontmatter，检测到开头 YAML frontmatter 时显式拒绝。
4. 引用文件全部从 CAS 读取并校验 `file.bytes`/object digest，但不物化、不暴露 host path；`resourceBase` 固定为 opaque 描述。
5. 在 Agent scope 用 `agentCtx.inject(['skills'], ctx => ctx.skills.register(...))`；`source:'runtime'`、`invocation:{modelInvocable:true,userInvocable:false}`；不挂 `dsh-skill-filesystem`。
6. 有绑定 skills 时，`tools.restrict` 的 allow 必须加入 `skill`；profile 未挂 `dsh-tool-skill` 时显式 `UNSUPPORTED_RESOURCES`；无 skills 时不主动加入。
7. bundle 总 bytes 使用内部部署 cap（1 MiB），不是协议字段。
8. discovery 使用 raw name+description 的保守 8 KiB 预检，不依赖 DSH 的 500-char 截断；实际 catalog source entries 另行验证。

## Done when

- [x] `template.skills` 为空、单 skill、多 skill 均能解析；顺序严格等于 template 绑定顺序，NodeView 只列 `{id,name}`。
- [x] 悬空/重复 template skill ID、重复 Method skill id/name/bundle、非法 `name`、空 `description` 在 Agent/模型前拒绝。
- [x] `contract.resources.skills` 与 Method 派生 bundle refs 的长度/顺序/id/digest 完全相等；多/少/重排/错 digest 均拒绝。
- [x] `Composition.skills` 与 contract/Method bundle refs 完全相等；多/少/重排/错 digest 以 `COMPOSITION_MISMATCH` 在 Agent/verifier/模型前关闭。
- [x] tree manifest 的 strict JSON、sealed digest、路径、排序、每文件 raw/structured digest、`file.bytes`、`SKILL.md` 严格 UTF-8/非空/无 frontmatter 均有正负例。
- [x] create 真实 DSH fixture：首请求 system message 等于 A1 platformPrompt；catalog user message 含绑定 name/description，不含正文，且恰好一次；`skill` tool schema 可见；`skill` 读取结果等于 `renderSkillContent`。
- [x] 未绑定 skill 调用在 DSH tool body 前返回既有 `INPUT_NOT_AUTHORIZED` 短 JSON；全局/继承 skill 导致 setup fail closed；`skill` 在 self-read 前可读，submitted/closed 后拒绝。
- [x] unit/precheck discovery 8 KiB：`8192` 可用、`8193` 拒绝；单 skill result 16 KiB：`16384` 可用、`16385` 拒绝；均不截断；真实 DSH 只覆盖小 catalog/result。
- [x] NodeView 8 KiB、tool schema 12 KiB、A1 guidance 8 KiB 回归通过；记录实际 system/catalog/tool schema/request bytes 与 fixture usage。
- [x] resume 原 Composition：无新模型请求、无重复 catalog、skill 仍可读；changed Composition.skills 与语义 invalid skill bundle 在 Agent/verifier/模型前形成 invalid closure；缺失 bundle 由统一 strict store replay 拒绝（`OBJECT_MISSING`/`REFERENCE_INVALID`），零 Agent/verifier/模型且无成功 closure。
- [x] dispose 后绑定 skill 不再可读、无新请求/新文件；host/workspace 不出现 `SKILL.md` 或引用资源副本。
- [x] 根 `pnpm verify`、`git diff --check` 通过；任务卡记录实际 tests/line counts/exports/dependency edges/未覆盖项。

## 失败场景 / 所需证据

先在当前实现上运行新增测试并保存真实失败输出，再实现：

1. `template.skills` 非空在 `resources.ts:93-99` 直接 `UNSUPPORTED_RESOURCES`；host 不会派生 `composition.skills`。
2. create 的 runtime/Composition 校验在 `run.ts:508-523` 拒绝 skills。
3. Agent setup 不注册 skill，`skill` 工具被 restrict 隐藏，首请求无 catalog；NodeView `skills=[]`。
4. `RunToolController` 无 skill 名称 guard，未绑定调用不会得到 `INPUT_NOT_AUTHORIZED`。
5. 新增 bundle/CAS/UTF-8/8 KiB/16 KiB 负例在旧实现上无对应代码路径，至少核心断言失败。

记录实际失败命令、测试数、错误码和输出路径；不得先实现再补断言。

## 检查命令

```bash
export PATH=/home/ROXY/code/singularity/.tooling/node-v24.22.2-linux-x64/bin:$PATH
export DSH_HOME="$PWD/.tmp/s4a2-dsh"
export TMPDIR="$PWD/.tmp"
node --version   # v24.22.2
pnpm --version   # 11.18.0

node --test --test-name-pattern='S4-A2|Method skill|skill discovery' \
  packages/singularity/runtime/test/method-skills.test.ts
node --test --test-name-pattern='S4-A2|Method skill|skill discovery' \
  apps/singularity/test/run-recovery.test.ts

pnpm --filter @singularity/runtime test
pnpm --filter @singularity/app test
pnpm verify
git diff --check
```

不设置 `SINGULARITY_SPIKE_LIVE`；fixture 不是真实模型。

## Structure done when

- `resources.ts` 是 Method/template/guidance/skill 资源编排与 Composition equality 的唯一入口；skill 资产/上限解析放入 `skill-resources.ts`，tree manifest/CAS 读取放入 `resource-bundle.ts`，三者均低于 800 行。
- `run.ts` 只把 `methodResources.skills` 投影到 NodeView/controller；`agent.ts` 只调用 `agent-skills.ts` 的注册/发现校验；`agent-skills.ts` 只消费冻结 plan；`tools.ts` 只做 dispatch guard；host 只做 Composition 派生。不得在 recovery 另写 skill 解析。
- 不新增 package index 导出；`FrozenMethodResources`/`FrozenSkillResource` 保持内部类型；`RunToolControllerOptions` 只增加当前 `run.ts`/test 消费的 `skillNames`。
- 依赖变化仅限已有 `@deepseek-ai/dsh-skill@0.2.2-alpha.2` 的 manifest edge；无新第三方包/版本；无 lockfile 版本变化。
- 生产文件低于 800 行；`store.ts` 保持 A1 的严格校验且无本片 diff。登记 before/after 行数、导出/依赖变化、测试数量与未覆盖项。
- `git diff --check`、根 `pnpm verify` 通过；无第二 registry、writer、fold、host skill 文件或 runtime→app 反向依赖。

## Verification evidence

实施完成。环境：官方 Node `v24.22.2`、pnpm `11.18.0`、DSH `0.2.2-alpha.2`；在独立 worktree `/home/ROXY/code/singularity-v1-s4-a2`、分支 `s4-a2-method-skills`、基线 `origin/main=1cfd3e2` 上执行。未设置 `SINGULARITY_SPIKE_LIVE`，未购买真实模型请求。

### 失败证据（实现前）

```bash
node --test packages/singularity/runtime/test/method-skills.test.ts
# tests 5, pass 0, fail 5
# 核心：UNSUPPORTED_RESOURCES: template skills and MCP tool bindings are not mounted in this slice

node --test --test-name-pattern='S4-A2' apps/singularity/test/run-recovery.test.ts
# tests 5, pass 0, fail 5
# 核心：host buildSingleRunComposition 在 loadMethodResources 拒绝 skills
```

原始输出：`.tmp/s4a2-runtime-baseline.log`、`.tmp/s4a2-app-baseline.log`（gitignored）。submitted/dual/missing/semantic recovery 及复核期 unit 用例在实现/复核过程中补充，因此不在首轮 baseline 的 5 个 app 红例内。

### 实现后

```bash
node --test packages/singularity/runtime/test/method-skills.test.ts packages/singularity/runtime/test/agent-skills.test.ts  # 10/10
node --test --test-name-pattern='S4-A2' apps/singularity/test/run-recovery.test.ts  # 9/9
pnpm --filter @singularity/runtime test   # 131/131
pnpm --filter @singularity/app test       # 46/46
pnpm verify                               # exit 0
git diff --check                          # exit 0
```

根 `pnpm verify`：project/build/typecheck/lint/test 全通过；protocol `225/225`、runtime `131/131`、app `46/46`，合计 `402/402`。A1 基线为 `382`，本片新增 `20` 个测试（runtime 11、app 9）。

### 行为与证据

- 身份顺序：`template.skills[i] → Method.skills 唯一 id → SkillAsset.bundle → contract.resources.skills[i] → Composition.skills[i]`。整个 Method skill catalog 先验 id/name/bundle 唯一、name kebab-case、description.trim 非空（未绑定非法资产也拒绝）；解析结果保留 template 顺序。MCP/exploration 继续 `UNSUPPORTED_RESOURCES`。
- bundle：复用 `SealedTreeManifest` 形状与 `freezeTree` 的 DFS 名称顺序；`resource-bundle.ts` 校验 strict JSON、sealed/structured digest、路径、排序、文件/目录祖先冲突、每文件 raw ref、`file.bytes`；先按 manifest 声明 bytes 求和执行 1 MiB cap，再逐文件读取/摘要/实际字节校验；`TreeBundle.bytes` 与 `FrozenSkillResource.files` 已删除。`skill-resources.ts` 要求根 `SKILL.md`、严格 UTF-8、非空；frontmatter 首行覆盖 `---`/CRLF/尾随空白/注释/BOM 变体，并读取/校验引用文件但不物化。
- DSH 注册/发现：`agent-skills.ts` 在 Agent scope 调用 `skills.register`，`source:'runtime'`、`modelInvocable=true`、`userInvocable=false`、opaque `resourceBase`；discovery/definition 同时校验 name/description/content/provider/source/invocation/resourceBase；`kind` 必须为 `opaque`，directory/other-kind 即使 description 相同也拒绝，防止同内容不同 provider 或 directory path 通过。profile 缺 `skill` tool/registry 均 fail closed；不挂 `dsh-skill-filesystem`，不写 workspace/HOME skill 文件。
- discovery：真实 DSH `tool-skill` 在首请求前发出 catalog；首请求 system message 等于 A1 `platformPrompt`，catalog 含绑定 name/description、不含正文；第二请求含 `skill` tool 的 `<skill_content>`，与官方 `renderSkillContent` 逐字符相等，catalog 精确一次；opaque 描述存在，引用文件正文/path 不出现。create fixture：2 requests，usage `90/16 tokens, 2 steps, unknown=0`；实测 bytes：system `871`、catalog `769`、tool schemas `3394`、NodeView `1700`、request0 `7545`、request1 `10180`、skillResult `349`。
- guard：`skill` 在 self-read 前允许读取；未绑定名称在 DSH body 前返回 `INPUT_NOT_AUTHORIZED`；其他 agent、submitted、stopped 仍拒绝（含直接 controller stop/submit 回归）；`global/inherited` skill 使 setup fail closed。
- 上限：unit/precheck 的 discovery raw name+description（含 escape）`8192` bytes 可用、`8193` 拒绝；`renderSkillContent` result `16384` 可用、`16385` 拒绝；不截断。真实 DSH 只验证小 skill catalog（769 bytes）与 result（349 bytes），未冒充 16 KiB live 边界；NodeView/tool schema 断言保持 8 KiB/12 KiB。
- create/resume/submitted：resume 原 Composition 重注册 skill、无新请求、无重复 catalog；changed Composition.skills 与语义 invalid（无 SKILL.md）bundle 在 Agent/verifier/模型前 invalid closure；缺失 bundle 由统一 strict store replay 以 `OBJECT_MISSING` 拒绝，零 Agent/verifier/模型且无成功 closure；submitted recovery 使用冻结 manifest/operationId 验证一次，无 Agent/模型请求。语义 invalid resource reason 实际消费 `MethodResourceError.resource`，形如 `resource-invalid: method: ...`。
- dispose：Agent 处置后 scoped skill 不可读、无新请求；workspace 无 `SKILL.md`/引用资源副本。
- A1 测试调整：原先 3 个 “skill unsupported” 用例改为 dangling skill、contract skill mismatch、Composition skill mismatch；MCP/exploration 拒绝保持通过。

### 证据边界

fixture provider 不是真实模型；本片未升级任何 conformance 状态。C-20 仅做局部 discovery/result/NodeView/tool-schema 回归，不把 fixture 当作完整 C-20；C-09 未涉及。引用资源已从 CAS 读取/摘要校验，但模型读取路径、exploration/global snapshot、MCP resource/template 成功内容、真实模型和领域评测均未验证。

## Actual structure data

| 文件 | before | after | 变化 |
|---|---:|---:|---:|
| `packages/singularity/runtime/src/resources.ts` | 271 | 281 | +10 |
| `packages/singularity/runtime/src/skill-resources.ts` | — | 235 | +235（新） |
| `packages/singularity/runtime/src/resource-bundle.ts` | — | 173 | +173（新） |
| `packages/singularity/runtime/src/agent-skills.ts` | — | 124 | +124（新） |
| `packages/singularity/runtime/src/agent.ts` | 362 | 368 | +6 |
| `packages/singularity/runtime/src/run.ts` | 750 | 749 | -1 |
| `packages/singularity/runtime/src/tools.ts` | 504 | 520 | +16 |
| `packages/singularity/runtime/src/errors.ts` | 27 | 42 | +15 |
| `packages/singularity/runtime/src/store.ts` | 993 | 993 | 0 |
| `packages/singularity/runtime/src/service.ts` | 342 | 342 | 0 |
| `packages/singularity/runtime/src/recovery.ts` | 452 | 452 | 0 |
| `packages/singularity/runtime/src/recovery-execution.ts` | 618 | 618 | 0 |
| `apps/singularity/src/host-composition.ts` | 262 | 263 | +1 |
| `packages/singularity/runtime/src/index.ts` | 26 | 26 | 0 |

- `resources.ts` 只编排 Method/template/guidance/skill 与 Composition equality；`skill-resources.ts` 拥有 skill catalog/资产/limits，`resource-bundle.ts` 拥有 tree/CAS 读取，`agent-skills.ts` 拥有注册/发现 winner 校验；`agent.ts` 只调用 setup helper/allow，`tools.ts` 只做 `skill` dispatch guard，`run.ts` 只做 NodeView/controller 投影。`run.ts` 未承载 skill 解析。
- 导出：package index 未变；`FrozenSkillResource`、`readSkills`、`sameRef`、`readTreeBundle`、`registerSkills`、`assertSkillDiscovery`、`assertSkillToolAvailability` 保持内部。`MethodResourceError` 移入 `errors.ts` 并由 `resources.ts` 内部 re-export，不属于 package index；其 `resource` 字段已被 recovery reason 消费。`RunToolControllerOptions` 新增必需 `skillNames`（消费者 `run.ts` 与 `run-verification.test.ts`）。
- `TreeBundle.bytes` 与 `FrozenSkillResource.files` 已删除，无预备断言字段；`recovery-execution.ts` 行数不变，仅保留 `resource-invalid: <resource>:` 诊断变化。
- 依赖：runtime 新增已有 `@deepseek-ai/dsh-skill@0.2.2-alpha.2` dependency edge；`pnpm-lock.yaml` 仅新增该 importer 关系，无版本变化；无新第三方包。
- 未覆盖：MCP/exploration 仍拒绝；引用资源模型读取、真实 MCP resource/template、真实模型、child/ancestor/summary、完整 C-04–C-09/C-21/C-22 不在本片范围。
