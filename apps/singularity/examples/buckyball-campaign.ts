import { copyFile,mkdir,readFile,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GlobalResourceSnapshot,JsonValue,Ref,SkillAsset,TaskContract,TaskSpec } from '@singularity/protocol'
import { admitRootTask,canonicalize,EXPLORE_TEMPLATE_ID,methodRevisionSchema,parseProtocolValue,resolveTemplateView,seal,sealMethodRevision } from '@singularity/protocol'
import type { EvaluationTaskRequest } from '@singularity/runtime'
import { activateRoundCandidate,CommandService,ContractSummaryService,evaluateRsiCandidate,evaluationCaseFromContract,executeRsiProposer,executeTaskTree,freezeEvaluationCase,freezeGlobalResources,openRsiRound,precheckMethodPatch,sealPublicTrace,taskProtocolReference } from '@singularity/runtime'

import { bootSpikeProfile,buildSingleRunComposition } from '../src/host-composition.ts'
import { FRONTEND_REVIEW_POLICY,frontendVerifier,compareFrontendPpa,PPA_WEIGHTS } from './buckyball-acceptance.ts'
import { buckyballFrontendTaskSpec,BUCKYBALL_FRONTEND_CAMPAIGN } from './buckyball-frontend-task.ts'
import { nativeAccounting } from './native-accounting.ts'
import { freezeBuckyballTools } from './buckyball-resources.ts'

const actor = { kind: 'runtime', id: 'buckyball-campaign' } as const
const bytes = (value: unknown) => new TextEncoder().encode(canonicalize(value))
const skillDescriptions: Record<string, string> = {
  'model-port': 'Prepare original model reference, recipes, frontend integration and scoped validation.',
  'model-optimize': 'Choose numerical contracts, mappings, layouts, bank reuse and scheduling from real workload evidence.',
  'chip-designer': 'Design chip topology, memory and inter-core interfaces and integrate actual cores.',
  'ip-designer': 'Implement reusable Chisel IP and independently verify its interface with existing UVM infrastructure.',
  'ball-align': 'Align Ball ISA, compiler, emulator, RTL and focused tests to one numerical and interface contract.',
  'workload-tests': 'Build small meaningful operator and component tests using current parameters and regression manifests.',
  'debug-compiler': 'Diagnose real model import and lowering failures through current compiler tooling.',
  check: 'Check actual Ball registration and generated topology consistency.',
  report: 'Report actual artifacts, commands, verification, observed metrics and remaining gaps.',
}

/** One trusted public experiment, using existing Task/RSI APIs without chip branches in runtime. */
export async function runBuckyballCampaign(root: string, prepared: string) {
  const project = JSON.parse(await readFile(join(prepared, 'project.json'), 'utf8')) as { source: { destination: string } }
  const baseline = project.source.destination
  const startedAt = Date.now(), deadlineAt = startedAt + BUCKYBALL_FRONTEND_CAMPAIGN.maxWallClockMs
  await mkdir(root)
  const cancellation = new AbortController()
  const patch = join(root, 'compaction.patch.yml')
  await copyFile(new URL('./buckyball.patch.yml', import.meta.url), patch)
  const spike = await bootSpikeProfile({ home: join(root, 'dsh'), patchFiles: [patch] })
  const accounting = nativeAccounting(spike.ctx, { ...BUCKYBALL_FRONTEND_CAMPAIGN, deadlineAt, cancellation, log: join(root, 'requests.jsonl') })
  const service = await CommandService.open({ root: join(root, 'domain'), actor, clock: Date.now })
  const timer = setTimeout(() => { cancellation.abort('campaign-deadline') }, Math.max(0, deadlineAt - Date.now()))
  const commit = <T extends 'method/registered' | 'method/activated'>(type: T, data: Parameters<typeof service.commit<T>>[0]['data'], id: string) => service.commit({
    command: { v: 1, commandId: id, tool: 'buckyball-host', toolVersion: 1, actor, scope: {}, input: data as JsonValue }, type, data,
  }, [])
  const outcomes: unknown[] = []
  let failure: string | undefined
  const failures: unknown[] = []
  const options: AgentOptions = { provider: 'singularity-local', model: 'deepseek-flash', reasoningEffort: ReasoningEffortId('max'), maxTokens: 40000 }
  const put = (id: string, value: unknown) => service.putObject(id, bytes(value))
  try {
    const provider = await put('buckyball:acceptance', { v: 1, kind: 'independent-native-review-and-reproduction', policy: FRONTEND_REVIEW_POLICY,
      limitations: 'Public trusted local experiment; independent LLM review and rerun evidence, not formal signoff or hidden-data isolation.', weights: PPA_WEIGHTS })
    const comparatorAsset = await put('buckyball:comparator', { v: 1, metric: 'weighted geometric PPA improvement', weights: PPA_WEIGHTS, minDelta: 0.01, noCaseRegression: true })
    const baseTools = await Promise.all(['bash', 'job_output', 'job_list', 'job_kill'].map(name => put(`base-tool:${name}`, { v: 1, name })))
    const protocol = await put('buckyball:task-protocol', taskProtocolReference)
    const guideText = `Autonomous CosyVoice3 chip frontend experiment. Read project.json and your own TaskContract. Explore the real source before selecting architecture. Start from existing cores, Balls and compiler paths to establish an integrated frontend early; then add IP where workload evidence justifies it. Explicitly map each stage to accelerator or original host execution. Integrate through current chip/core/compiler/recipe interfaces and test that path; isolated primitives and documentation do not complete the frontend. Each Task discovers and owns its local workflow. After reading relevant resources, refine the initial sketch around responsibilities, outputs, interfaces and checks. Delegate long-chain stages to direct children, including sequential stages in successive batches; each child discovers deeper workflow. Perform bounded technical work and integrate direct results locally. Use the shared campaign deadline when planning child scope. Start with empty Method. Register discoveries only through RSI after root closure; keep learning drafts in learning-drafts/skills or learning-drafts/mcp-servers.\nUse the registered mcp__buckyball__bbdev tool for bbdev operations, passing your own absolute checkout path and CLI argv. The operator-prepared MCP activates nix develop in that directory. Use native bash for source edits and standalone component tools. No full-chip simulation, whole-model BEMU, P2E/FPGA or physical backend. Focused standalone IP/component/subgraph tests and logical synthesis are allowed. Autonomous architecture/design choices and routine fixes inside this experiment are authorized; record rationale rather than stopping for approval required by old skills.\nShared baseline ${baseline} is read-only. For mutation/build, call mcp__buckyball__checkout with the absolute path to buckyball/ under your workspace. This domain tool copies the complete operator-prepared baseline and installs local configs; it preserves submodules, dependencies, the Nix toolchain link, scripts/nix/download.sh repair and untracked gemmini. Use this prepared copy for your patches and builds. Do not build against baseline, parent or sibling checkouts. The operator-prepared baseline includes the bbdev dependencies/config; preserve them in your independent copy. The domain MCP returns the existing CLI result; use its help and native status commands as needed. Do not alter Singularity source, host profile, verifier or other runs.\nDeliver frontend/ with implementation patches (including separately identified submodule patches), architecture/numerical/interface contracts, original-reference vectors, focused tests, actual logs and reproducible commands. Exclude weights and build trees. Parent can read direct child's frozen files through protocol, then integrate into its own copy. Exploration children inherit the required result/ delivery tree: put patches, reports and test evidence there and submit output ID result. localOutputs may add supporting files; other Method templates use their frozen contract outputs. Final root must cover LLM, Flow, HiFT and host boundaries, not only Qwen. PPA is synthesis-estimated: weights power 30%, critical delay 40%, cell area 30%. Retain identical library/corner/clock/activity and offload conditions for comparison. Missing PPA cannot win. Read the frozen acceptance-policy document for exact review criteria. Report genuine failures and incomplete work.\nLong task limits: root 4096 steps, 256 tasks, depth 8, deadline shared across the whole campaign. Native auto compaction runs at 75% context pressure and is counted. Never reduce the goal just to claim completion.`
    const guide = await put('buckyball:guide', { v: 1, text: guideText })
    const skills: SkillAsset[] = []
    for (const [name, description] of Object.entries(skillDescriptions)) {
      const content = new TextEncoder().encode(await readFile(join(baseline, '.agents/skills', name, 'SKILL.md'), 'utf8'))
      const object = await service.putObject(`buckyball:skill:${name}:SKILL.md`, content)
      const bundle = await put(`buckyball:skill:${name}`, seal('object', { v: 1, kind: 'tree', files: [{ path: 'SKILL.md', bytes: content.byteLength, object }] }))
      skills.push({ id: name, name, description, bundle })
    }
    const tools = await freezeBuckyballTools(service, baseline)
    const snapshotValue: GlobalResourceSnapshot = { v: 1, skills, tools, baseTools, fallbackAcceptance: provider, fallbackJoin: 'probe',
      documents: [{ id: 'frontend-guide', description: 'Scope overrides, independent checkout, delivery and PPA policy. Read before domain operations.', object: guide },
        { id: 'task-protocol', description: 'Current Task planning, direct decomposition, schemas and resource usage.', object: protocol },
        { id: 'acceptance-policy', description: 'Independent review criteria, original-reference checks and synthesis PPA conditions.', object: provider }] }
    const snapshot = await freezeGlobalResources(service, 'buckyball:global-resources', snapshotValue)
    const seed = await put('buckyball:seed', { v: 1, name: 'cosyvoice3-frontend-20261101' })
    const profile = await put('buckyball:profile', { v: 1, options, compaction: { threshold: 0.75, maxTokens: 40000 }, budget: BUCKYBALL_FRONTEND_CAMPAIGN })
    const method = await service.putObject('buckyball:method-empty', bytes(sealMethodRevision({ v: 1, id: 'buckyball:method-empty', templates: [], skills: [], tools: [] })), 'method')
    await commit('method/registered', { revision: method }, 'buckyball:register-empty')
    await commit('method/activated', { next: method, approval: await put('buckyball:initial-approval', { v: 1, purpose: 'empty-initialization' }) }, 'buckyball:activate-empty')
    const summaries = new ContractSummaryService({ ctx: spike.ctx, writer: service, agentOptions: options })
    const verify = frontendVerifier(spike.ctx, { root: join(root, 'reviews'), baseline, project: join(prepared, 'project.json'), agentOptions: options })
    const runTask = async (contract: TaskContract, slot?: EvaluationTaskRequest) => {
      const runId = `${contract.taskId}:run:1`, sessionId = `${runId}:session`
      const composition = await buildSingleRunComposition(spike.ctx, { store: service, id: runId, contract, agentOptions: options, base: { v: 1, seed } })
      return executeTaskTree({ ctx: spike.ctx, journalRoot: join(root, 'domain'), workspace: join(root, 'workspaces', Buffer.from(contract.taskId).toString('hex')),
        runId, sessionId, admission: { contract, attempt: 1, budgetReservation: { tokens: contract.limits.maxTokens, steps: contract.limits.maxStepsPerRun, deadlineAt } },
        composition, agentOptions: options, maxOutputBytes: BUCKYBALL_FRONTEND_CAMPAIGN.maxOutputBytes, verifier: { provider, verify }, actor,
        maxActive: slot?.maxActive ?? BUCKYBALL_FRONTEND_CAMPAIGN.maxActive, workspaceRoot: join(root, 'runs'), summaries,
        signal: slot === undefined ? cancellation.signal : AbortSignal.any([cancellation.signal, slot.signal]),
        checkReportedBudget: value => accounting.available() && (slot?.checkReportedBudget(value) ?? true),
        ...(slot === undefined ? {} : { canOpenRun: slot.canOpenRun }),
        async resolveRun(input) { return { composition: await buildSingleRunComposition(spike.ctx, { store: service, id: input.runId, contract: input.contract, agentOptions: options, base: { v: 1, seed } }),
          agentOptions: options, maxOutputBytes: BUCKYBALL_FRONTEND_CAMPAIGN.maxOutputBytes, verifier: { provider: input.contract.acceptance, verify } } },
      }, service)
    }
    const contractFor = async (taskId: string, spec: TaskSpec, pinned: Ref, purpose: 'work' | 'evaluation', requestRef: Ref) => {
      const revision = parseProtocolValue(methodRevisionSchema, JSON.parse(new TextDecoder().decode((await service.readObject(pinned, 'method')).bytes)))
      const templateId = revision.entryTemplateId ?? EXPLORE_TEMPLATE_ID
      const view = resolveTemplateView(revision, templateId, snapshotValue)
      if (view === undefined) throw new Error('Missing pinned entry template')
      return admitRootTask({ taskId, spec, origin: { kind: 'root', purpose, requestRef }, method: pinned, template: { id: templateId, digest: pinned.digest },
        resources: { baseTools, exploration: snapshot,
          skills: view.skills.map(id => { const asset = [...revision.skills, ...skills].find(value => value.id === id); if (asset === undefined) throw new Error(`Missing skill ${id}`); return asset.bundle }),
          mcpServers: view.tools.map(id => { const asset = [...revision.tools, ...tools].find(value => value.id === id); if (asset === undefined) throw new Error(`Missing tool ${id}`); return asset.server.bundle }) },
        acceptance: provider, environment: { seed, profile }, limits: { ...BUCKYBALL_FRONTEND_CAMPAIGN.task, deadlineAt } })
    }
    const projectRef = await put('buckyball:project', { ...project, status: 'launched', remaining: [], campaign: { startedAt, deadlineAt }, ppaWeights: PPA_WEIGHTS })
    const sourceSpec = buckyballFrontendTaskSpec(projectRef)
    sourceSpec.inputs.push({ id: 'experiment-guide', object: guide, path: 'experiment-guide.json', access: 'copy-to-work' })
    sourceSpec.goal.constraints.push('Read experiment-guide.json before domain work; its operator scope overrides the public skills.')
    // Frozen workload cases specify inputs/goals, never a workflow tree or implementation.
    const definitions = [
      { id: 'llm-prefill', detail: 'Representative batch=1 LLM prompt prefill of 16 and 64 tokens; preserve Qwen2 grouped-query attention/cache semantics and report representative static PPA conditions.' },
      { id: 'flow-streaming', detail: 'Representative Flow/DiT streaming chunk boundaries of 16 and 32 frames; preserve conditioning/layout/numerical interfaces and include the rest of the pipeline in the frontend mapping.' },
      { id: 'hift-boundary', detail: 'Independent validation: HiFT waveform chunk boundary and overlap handling for two small mel chunks; preserve original host reference and the complete frontend mapping.' },
    ]
    const cases: { spec: TaskSpec; ref: Ref }[] = []
    for (const definition of definitions) {
      const input = await put(`buckyball:case-input:${definition.id}`, { ...project, remaining: [], status: 'evaluation-case', case: definition, ppaWeights: PPA_WEIGHTS })
      const spec = buckyballFrontendTaskSpec(input)
      spec.inputs.push({ id: 'experiment-guide', object: guide, path: 'experiment-guide.json', access: 'copy-to-work' })
      spec.goal.constraints.push(definition.detail)
      const contract = await contractFor(`buckyball:definition:${definition.id}`, spec, method, 'evaluation', profile)
      cases.push({ spec, ref: await freezeEvaluationCase(service, `buckyball:case:${definition.id}`, evaluationCaseFromContract(contract)) })
    }
    await writeFile(join(root, 'launch.json'), JSON.stringify({ v: 1, startedAt, deadlineAt, pid: process.pid, sourceSpec, cases, budget: BUCKYBALL_FRONTEND_CAMPAIGN,
      ppaWeights: PPA_WEIGHTS, prepared, emptyMethod: method, independentReview: provider, compaction: 'native enabled; all llm/stream calls accounted' }, null, 2))
    console.log(JSON.stringify({ event: 'campaign-started', pid: process.pid, root, startedAt, deadlineAt }))
    for (let index = 0; index < 3 && accounting.available(); index += 1) {
      const roundId = `buckyball:round:${String(index + 1)}`, taskId = `${roundId}:source`
      const active = (await service.methodRoundState()).productionHead
      if (active === undefined) throw new Error('Missing active Method')
      const source = await runTask(await contractFor(taskId, sourceSpec, active, 'work', await put(`${taskId}:request`, { v: 1, purpose: 'autonomous-chip-frontend' })))
      const trace = await sealPublicTrace({ ctx: spike.ctx, service, actor, rootTaskId: taskId, summaries })
      if (!accounting.available()) break
      const remaining = Math.max(1, deadlineAt - Date.now())
      const plan = { v: 1 as const, cases: cases.slice(0, 2).map(value => value.ref), validationCases: [cases[2].ref],
        metric: { name: 'frontend-ppa', weights: PPA_WEIGHTS }, thresholds: { minDelta: 0.01, maxRegression: 0 }, trialsPerCase: 1,
        proposerBudget: { ...BUCKYBALL_FRONTEND_CAMPAIGN.proposerBudget, maxWallClockMs: remaining }, budget: { ...BUCKYBALL_FRONTEND_CAMPAIGN.evaluationBudget, maxWallClockMs: remaining },
        validation: 'required-by-domain' as const, claim: 'domain-evaluation' as const, comparator: comparatorAsset, sourceSeed: seed, expectedPreviousActiveMethod: active }
      await openRsiRound({ service, actor, roundId, sourceTrace: trace.trace, baseMethod: active, plan, proposerSessionId: `${roundId}:proposer` })
      const workspace = join(root, 'proposers', String(index + 1)); await mkdir(workspace, { recursive: true })
      const proposal = await executeRsiProposer({ ctx: spike.ctx, service, actor, roundId, workspace, agentOptions: options,
        publicEvaluation: { goal: 'Improve reusable chip frontend workflow, task templates, skills and domain tools from this sealed real execution; keep the implementation artifacts in Task output.',
          metric: 'Mean geometric PPA improvement (power .30, delay .40, area .30), after every functional criterion passes and independent reports use identical conditions.',
          thresholds: ['At least 1% mean improvement; no per-case regression. Missing PPA or incomplete hardware is not comparable.'], validationPolicy: 'required-by-domain',
          publicCases: definitions.slice(0, 2).map(value => ({ id: value.id, description: value.detail })) } })
      const precheck = proposal.proposalRef === undefined ? undefined : await precheckMethodPatch({ service, actor, roundId })
      const evaluation = precheck?.accepted === true ? await evaluateRsiCandidate({ service, actor, roundId,
        comparator: { asset: comparatorAsset, describeMetric: () => ({ name: 'frontend-ppa', direction: 'higher-is-better', unit: 'fraction', costObjective: false }), compare: compareFrontendPpa },
        async runTask(slot) { const value = cases.find(value => value.ref.id === slot.slot.caseRef.id); if (value === undefined) throw new Error('Missing frozen case'); await runTask(await contractFor(slot.slot.taskId, value.spec, slot.slot.method, 'evaluation', slot.requestRef), slot) },
      }) : undefined
      let activation
      if (evaluation?.comparison.outcome === 'improved') {
        const next = (await service.methodRoundState()).rounds.get(roundId)?.candidateMethod
        if (next === undefined) throw new Error('Missing improved candidate')
        const approval = await put(`${roundId}:approval`, { v: 1, authorization: 'user-authorized-independent-ppa-winner', expectedPrevious: active, next })
        activation = await activateRoundCandidate({ service, actor, roundId, approval })
      }
      const outcome = { roundId, source: source.root.classification, trace: trace.trace, proposal: proposal.recordRef, precheck,
        comparison: evaluation?.comparison, activation, usage: { ...accounting.usage } }
      outcomes.push(outcome)
      await writeFile(join(root, `round-${String(index + 1)}.json`), JSON.stringify(outcome, null, 2))
      console.log(JSON.stringify({ event: 'round-finished', ...outcome }))
      if (activation !== undefined && accounting.available()) {
        const head = (await service.methodRoundState()).productionHead
        if (head === undefined) throw new Error('Published Method absent')
        const publishedId = `${roundId}:published-work`
        await runTask(await contractFor(publishedId, sourceSpec, head, 'work', await put(`${publishedId}:request`, { v: 1, purpose: 'post-publication-verification' })))
      }
    }
  } catch (error) {
    failures.push(error)
    failure = error instanceof Error ? error.stack ?? error.message : String(error)
  } finally {
    clearTimeout(timer)
    try { await spike.dispose() } catch (error) { failures.push(error) }
    accounting.dispose()
    try { await service.close() } catch (error) { failures.push(error) }
    await writeFile(join(root, 'result.json'), JSON.stringify({ v: 1, startedAt, finishedAt: Date.now(), deadlineAt, outcomes, usage: accounting.usage, failure }, null, 2))
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Buckyball campaign failed')
}

const entry = process.argv[1]
if (import.meta.url === pathToFileURL(resolve(entry)).href) {
  await runBuckyballCampaign(resolve(process.argv[2]), resolve(process.argv[3]))
}
