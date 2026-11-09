import assert from 'node:assert/strict'
import { chmod,glob,mkdtemp,mkdir,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename,join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import { CompactionId } from '@deepseek-ai/dsh-compaction'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId,SessionSeq } from '@deepseek-ai/dsh-session'
import { createWakeMessage,snapshotSession } from '@singularity/runtime'

import { prepareBuckyballDomain } from './fixtures/buckyball-domain.ts'
import { EXPERIMENT_BUDGET,MIN_CONTINUOUS_TRIALS,runExperiment,sourceEligible } from '../src/experiment.ts'
import { bindDomainTask } from '../src/domain.ts'
import type { ExperimentDomain,TaskDraft } from '../src/domain.ts'
import { nativeAccounting } from '../src/accounting.ts'
import { messageTexts,startChatCompletionsFixture,toolNames,toolSchemaNames,wireText } from './fixtures/chat-completions.ts'
import { previewDigestFrom } from './method-fixture.ts'
import { withHarness } from './run-fixture.ts'
import { agentOptions } from './task-fixture.ts'

void test('domain MCP copies prepared dependencies, reports CLI failure and forwards native cancellation', { timeout: 120_000 }, async () => {
  await withHarness(() => { throw new Error('MCP preflight must not buy a model request') }, async ({ spike, workspace }) => {
    const baseline = join(workspace, 'baseline'), project = join(workspace, 'buckyball'), bin = join(workspace, 'bin')
    await mkdir(join(baseline, 'bbdev/api/.venv'), { recursive: true })
    await writeFile(join(baseline, 'bbdev/api/.venv/prepared'), 'operator dependencies')
    await mkdir(bin)
    await writeFile(join(bin, 'nix'), `#!/usr/bin/env python3
import os, pathlib, signal, sys
p = pathlib.Path.cwd()
(p / 'llvm-toolchain').write_text(os.environ['BUCKYBALL_LLVM_BUILD'])
if sys.argv[-1] == 'wait':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        (p / 'started').write_text(str(os.getpid()))
        signal.pause()
    finally:
        (p / 'cleaned').write_text('native termination cleanup')
elif sys.argv[-1] == 'fail':
    print('domain command failed', file=sys.stderr)
    sys.exit(7)
else:
    print('prepared config installed')
`)
    await chmod(join(bin, 'nix'), 0o755)
    const handle = await spike.ctx.agents.create({ sessionId: SessionId('buckyball-mcp-preflight'), meta: { cwd: workspace },
      setup: async scope => {
        scope.tools.restrict({ allow: [] })
        await scope.plugin(mcpClient, { transport: 'stdio', serverName: 'buckyball', command: process.execPath,
          args: [fileURLToPath(new URL('../../../domain-tasks/buckyball/environment/server.cjs', import.meta.url))],
          env: { BUCKYBALL_BASELINE: baseline, BUCKYBALL_MCP_ROOT: fileURLToPath(new URL('../', import.meta.url)), PATH: `${bin}:${process.env.PATH ?? ''}` },
          failOnStartupError: true, reconnect: { enabled: false } })
      } })
    let sequence = 0
    const call = async (name: string, args: unknown, signal = new AbortController().signal) => {
      const result = await spike.ctx.tools.execute({ agent: handle.agent, signal,
        calls: [{ type: 'tool-call', id: ToolCallId(`bb-preflight-${String(++sequence)}`),
          name: `mcp__buckyball__${name}`, arguments: JSON.stringify(args) }] })
      return result.results[0].result
    }
    try {
      assert.equal((await call('checkout', { project })).isError, false)
      assert.equal(await readFile(join(project, 'bbdev/api/.venv/prepared'), 'utf8'), 'operator dependencies')
      assert.equal(await readFile(join(project, 'llvm-toolchain'), 'utf8'), join(baseline, 'stack/compiler/thirdparty/buddy-mlir/llvm/build'))
      await writeFile(join(project, 'bbdev/api/.venv/prepared'), 'independent copy')
      assert.equal(await readFile(join(baseline, 'bbdev/api/.venv/prepared'), 'utf8'), 'operator dependencies')
      assert.equal((await call('checkout', { project })).isError, true, 'a new checkout never merges with an existing directory')
      const failure = await call('bbdev', { project, args: ['fail'] })
      assert.equal(failure.isError, true)
      assert.match(JSON.stringify(failure), /domain command failed/)
      assert.equal((await call('bbdev', { project, args: 'bad schema' })).isError, true)
      const cancellation = new AbortController()
      const pending = call('bbdev', { project, args: ['wait'] }, cancellation.signal)
      for (let i = 0; i < 100; i += 1) {
        if (await readFile(join(project, 'started'), 'utf8').catch(() => '') !== '') break
        await delay(20)
      }
      assert.ok(await readFile(join(project, 'started'), 'utf8'))
      cancellation.abort()
      assert.equal((await pending).isError, true)
      for (let i = 0; i < 100; i += 1) {
        if (await readFile(join(project, 'cleaned'), 'utf8').catch(() => '') !== '') break
        await delay(20)
      }
      assert.equal(await readFile(join(project, 'cleaned'), 'utf8'), 'native termination cleanup')
    } finally { await handle.dispose() }
  })
})

void test('native campaign meter includes auxiliary calls; session projection counts marked compaction once', { timeout: 120_000 }, async () => {
  await withHarness(() => ({ content: 'A compact result.', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }), async ({ spike, workspace }) => {
    const cancellation = new AbortController()
    const meter = nativeAccounting(spike.ctx, { deadlineAt: Date.now() + 60_000, maxRequests: 3, maxReportedTokens: 1000,
      cancellation, log: join(workspace, 'meter.jsonl') })
    const handle = await spike.ctx.agents.create({ sessionId: SessionId('buckyball-accounting-test'), meta: { cwd: workspace }, agentOptions: agentOptions() })
    try {
      handle.agent.followup(createWakeMessage({ wakeId: 'accounting-start', text: 'Return a short result.' }))
      await handle.agent.whenIdle()
      const initial = snapshotSession(handle.agent.session).usage
      for (const purpose of ['compaction', 'session-title'] as const) {
        for await (const chunk of spike.ctx.llm.stream({ ...agentOptions(), provider: 'singularity-local', model: 'deepseek-v4.1-flash',
          sessionId: handle.agent.session.id, purpose, messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarize briefly.' }] }] })) {
          assert.ok(chunk.type)
        }
      }
      assert.equal(meter.usage.requests, 3)
      assert.equal(meter.usage.completed, 3)
      assert.equal(meter.usage.inputTokens, 300)
      assert.equal(meter.usage.outputTokens, 30)
      assert.equal(meter.usage.unknown, 0)
      assert.equal(meter.available(), false)
      const summary = { compactionId: CompactionId('native-usage'), summary: [{ type: 'text' as const, text: 'Summary.' }],
        shadowedRange: { start: SessionSeq(0), end: SessionSeq(0) }, shadowedSeqs: [], shadowedTokenCount: 100,
        provider: 'singularity-local', model: 'deepseek-v4.1-flash', usage: { inputTokens: 100, outputTokens: 10 }, rawOutput: [], llmStreamCall: true as const }
      handle.agent.session.append('compaction/summary', summary)
      const compacted = snapshotSession(handle.agent.session).usage
      assert.equal(compacted.steps, initial.steps + 1)
      assert.equal(compacted.inputTokens, initial.inputTokens + 100)
      assert.equal(compacted.outputTokens, initial.outputTokens + 10)
      assert.equal(compacted.unknownRequests, 0)
      const { llmStreamCall: marker, ...template } = summary
      assert.equal(marker, true)
      handle.agent.session.append('compaction/summary', template)
      assert.deepEqual(snapshotSession(handle.agent.session).usage, compacted, 'model-free summaries are not purchases')
      const { usage: absentUsage, ...missingUsage } = summary
      assert.equal(absentUsage.inputTokens, 100)
      handle.agent.session.append('compaction/summary', { ...missingUsage, compactionId: CompactionId('missing-usage') })
      assert.equal(snapshotSession(handle.agent.session).usage.unknownRequests, 1)
      await assert.rejects(async () => {
        for await (const chunk of spike.ctx.llm.stream({ provider: 'singularity-local', model: 'deepseek-v4.1-flash', purpose: 'compaction', messages: [] })) assert.ok(chunk.type)
      })
      assert.equal(meter.usage.requests, 3, 'exhausted auxiliary requests never enter the provider')
      assert.equal(cancellation.signal.aborted, true)
    } finally { await handle.dispose(); meter.dispose() }
  })
})

void test('generic experiment admits empty Method, independently reviews frozen outputs and preserves failed/no-proposal outcomes', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'singularity-experiment-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const baseline = join(directory, 'baseline'), prepared = join(directory, 'prepared'), root = join(directory, 'execution')
  await mkdir(prepared)
  await mkdir(join(baseline, '.agents/skills/legacy-role'), { recursive: true })
  await writeFile(join(baseline, '.agents/skills/legacy-role/SKILL.md'), '# Legacy role\nReference document only.\n')
  await writeFile(join(prepared, 'project.json'), JSON.stringify({ source: { destination: baseline } }))
  const bin = join(directory, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'nix'), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > "$PWD/nix-argv.txt"\nprintf "fixture bbdev help\\n"\n')
  await chmod(join(bin, 'nix'), 0o755)
  const oldPath = process.env.PATH
  process.env.PATH = `${bin}:${oldPath ?? ''}`
  t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath })
  let reviews = 0, proposers = 0, exhaustReview = false
  const fixture = await startChatCompletionsFixture((request, index) => {
    const call = (name: string, args: unknown) => ({ toolCalls: [{ id: `ball-fixture-${String(index)}`, name, arguments: JSON.stringify(args) }],
      usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } })
    if (toolSchemaNames(request).includes('singularity_review_submit')) {
      assert.equal(toolSchemaNames(request).some(name => ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(name)), false)
      if (exhaustReview) return { ...call('job_list', {}), usage: { promptTokens: EXPERIMENT_BUDGET.maxReportedTokens,
        completionTokens: 10, totalTokens: EXPERIMENT_BUDGET.maxReportedTokens + 10 } }
      if (proposers === 2) return { content: 'No review verdict submitted.', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }
      if (!toolNames(request).includes('singularity_review_submit')) return { toolCalls: [{ id: `bad-review-${String(index)}`,
        name: 'singularity_review_submit', arguments: '{"result":' }], usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }
      assert.match(messageTexts(request).join('\n'), /"status":"failed"/)
      reviews += 1
      return call('singularity_review_submit', { result: { criteria: ['executable-mapping', 'target-correctness', 'regression', 'delivery']
        .map(id => ({ id, verdict: 'fail', reason: 'Missing actual MXMM consumer: fixture failure must remain actionable.' })) } })
    }
    if (toolSchemaNames(request).includes('rsi_submit_patch')) {
      const calls = toolNames(request)
      const name = !calls.includes('rsi_read') ? 'rsi_read' : !calls.includes('rsi_submit_patch') ? 'rsi_submit_patch' : undefined
      if (name !== undefined) return { toolCalls: [{ id: `bad-rsi-${String(index)}`, name, arguments: '{"patch":' }],
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }
      assert.match(messageTexts(request).join('\n'), /"status":"failed"/)
      proposers += 1
      return { content: 'No justified reusable improvement from this deliberately incomplete fixture.', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }
    }
    const calls = toolNames(request)
    assert.equal(toolSchemaNames(request).includes('skill'), false, 'project reference documents are never mounted as skills')
    assert.equal(toolSchemaNames(request).some(name => ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(name)), false, 'empty MCP resources stay outside the model surface')
    if (calls.length === 0) return call('singularity_read', { kind: 'self' })
    const pages = (request.messages ?? []).filter(value => value.role === 'tool').map(value => wireText(value.content)).filter(value => value.startsWith('{')).map(value => JSON.parse(value) as { data?: string; nextCursor?: string; contextEpoch: string })
      .filter(value => typeof value.data === 'string')
    const last = pages.at(-1)
    assert.ok(last)
    if (last.nextCursor !== undefined) return call('singularity_read', { kind: 'self', cursor: last.nextCursor })
    JSON.parse(pages.map(value => value.data).join(''))
    if (!calls.includes('singularity_plan')) return call('singularity_plan', { sketch: { v: 1,
      objective: 'Deliver the incomplete fixture honestly.', levels: [0, 1].map(level => ({ level, purpose: 'Inspect local output.', likelyChildren: [], expectedInputs: [], expectedOutputs: [] })), directPlan: [], assumptions: [] } })
    assert.ok(toolSchemaNames(request).includes('mcp__buckyball__bbdev'), 'the frozen domain MCP is available in each fresh Run')
    assert.match(JSON.stringify(request.tools), /Nix is already activated/)
    if (!calls.includes('mcp__buckyball__bbdev')) return call('mcp__buckyball__bbdev', { project: baseline, args: ['--help', 'literal;$(false)'] })
    if (!calls.includes('bash')) {
      assert.match(messageTexts(request).join('\n'), /ball/)
      return call('bash', { description: 'Create incomplete Ball output.', command: "mkdir -p ball && printf 'Incomplete fixture, no target execution.\\n' > ball/report.md" })
    }
    return call('singularity_submit', { outputIds: ['ball'], includeLearningDrafts: false })
  })
  t.after(() => fixture.close())
  const oldUrl = process.env.SINGULARITY_SPIKE_BASE_URL, oldKey = process.env.SINGULARITY_SPIKE_API_KEY
  process.env.SINGULARITY_SPIKE_BASE_URL = fixture.baseURL
  process.env.SINGULARITY_SPIKE_API_KEY = 'fixture-key'
  t.after(() => {
    if (oldUrl === undefined) delete process.env.SINGULARITY_SPIKE_BASE_URL
    else process.env.SINGULARITY_SPIKE_BASE_URL = oldUrl
    if (oldKey === undefined) delete process.env.SINGULARITY_SPIKE_API_KEY
    else process.env.SINGULARITY_SPIKE_API_KEY = oldKey
  })
  const preparedDomain = await prepareBuckyballDomain(prepared)
  const reviewTask = (task: typeof preparedDomain.sourceTask) => ({ ...task,
    criteria: ['executable-mapping', 'target-correctness', 'regression', 'delivery'].map(id => ({
      id, statement: `Independent semantic review of ${id}.`, required: true,
    })) })
  const domain: ExperimentDomain = { ...preparedDomain, acceptance: 'review', sourceTask: reviewTask(preparedDomain.sourceTask),
    cases: preparedDomain.cases.map(value => ({ ...value, task: reviewTask(value.task) })) }
  const projectInput = JSON.parse(new TextDecoder().decode(domain.source.project as Uint8Array)) as { source: { destination: string }; technicalReferences: string[] }
  assert.equal(projectInput.source.destination, baseline)
  assert.ok(projectInput.technicalReferences.every(path => path.startsWith('.agents/skills/')))
  await runExperiment(root, domain)
  const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8')) as { failure?: string; outcomes: { source: string; activation?: unknown }[]; usage: { requests: number; completed: number; unknown: number } }
  assert.equal(result.failure, undefined)
  assert.deepEqual(result.outcomes.map(value => value.source), ['failed', 'failed', 'invalid'])
  assert.ok(result.outcomes.every(value => value.activation === undefined))
  assert.equal(reviews, 6, 'real failures use fresh attempts; an unsubmitted review never asks the worker to redo work')
  assert.equal(proposers, 2, 'an invalid source never purchases another proposer')
  assert.equal(result.usage.requests, fixture.requests.length)
  assert.equal(result.usage.completed, fixture.requests.length)
  assert.equal(result.usage.unknown, 0)
  const launch = JSON.parse(await readFile(join(root, 'launch.json'), 'utf8')) as {
    sourceSpec: { inputs: { id: string; object: { digest: string } }[]; goal: { constraints: string[] } }
    cases: { spec: { inputs: { id: string; object: { digest: string } }[]; goal: { constraints: string[] } } }[]
  }
  assert.ok(launch.sourceSpec.goal.constraints.some(value => value.includes('project.json')))
  assert.equal(launch.sourceSpec.goal.constraints.some(value => value.includes('Singularity')), false)
  assert.deepEqual(launch.sourceSpec.inputs.map(value => value.id), ['project', 'acceptance', 'bemu-tools'])
  assert.equal(launch.cases.length, 4)
  for (const [index, { spec }] of launch.cases.entries()) {
    assert.deepEqual(spec.inputs.map(value => value.id), index === 3 ? ['records', 'acceptance'] : ['project', 'acceptance', 'bemu-tools'])
  }
  const receipts = glob(`${root}/reviews/*/receipt.json`)
  for await (const path of receipts) {
    const receipt = JSON.parse(await readFile(path, 'utf8')) as { criteria: { reason: string }[] }
    assert.ok(receipt.criteria.every(value => value.reason.includes('Missing actual MXMM consumer') || value.reason.includes('did not complete')))
  }
  assert.deepEqual((await readFile(join(baseline, 'nix-argv.txt'), 'utf8')).trimEnd().split('\n'),
    [baseline, 'develop', '--command', 'bash', '-c', 'exec bbdev "$@"', '--', '--help', 'literal;$(false)'])
  exhaustReview = true
  const exhausted = join(directory, 'budget-exhausted')
  await runExperiment(exhausted, domain)
  const stopped = JSON.parse(await readFile(join(exhausted, 'result.json'), 'utf8')) as { failure?: string; outcomes: unknown[]; usage: { unknown: number } }
  assert.equal(stopped.failure, undefined, 'a budget cancellation seals its terminal ExecutionRecord without a host failure')
  assert.deepEqual(stopped.outcomes, [])
  assert.equal(stopped.usage.unknown, 0)
  assert.equal(proposers, 2, 'exhausted source never purchases an RSI request')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(exhausted, 'domain/domain.sqlite'), { readOnly: true })
  try {
    const facts = db.prepare('SELECT payload FROM events ORDER BY seq').all().map(row => JSON.parse(row.payload as string) as { type: string; data: { usage?: { unknownRequests: number }; scope?: string } })
    assert.equal(facts.filter(value => value.type === 'rsi/trace-sealed').length, 1)
    assert.ok(facts.some(value => value.type === 'task/closed' && value.data.scope === 'subtree'))
    assert.equal(facts.some(value => value.type === 'rsi/round-opened'), false)
  } finally { db.close() }
})

void test('Buckyball cases freeze deterministic input data for paired acceptance', async t => {
  const prepared = await mkdtemp(join(tmpdir(), 'singularity-frozen-cases-'))
  t.after(() => rm(prepared, { recursive: true, force: true }))
  await writeFile(join(prepared, 'project.json'), JSON.stringify({ source: { destination: '/unused-fixture-baseline' } }))
  const domain = await prepareBuckyballDomain(prepared)
  const decode = (value: unknown) => JSON.parse(new TextDecoder().decode(value as Uint8Array)) as { case: { seed: number; dataRule: string; shapes: number[][] } }
  const source = decode(domain.source.project).case
  assert.equal(source.seed, 17)
  assert.equal(source.shapes.length, 4)
  assert.match(source.dataRule, /73\*i/)
  assert.match(source.dataRule, /scale=112\+\(\(11\*i\+seed\)%32\)/)
  const cases = domain.cases.filter(value => value.id === 'long-k' || value.id === 'output-tiling')
    .map(value => ({ ...value, data: decode(value.input.project).case }))
  assert.deepEqual(cases.map(value => value.data.seed), [29, 43])
  assert.deepEqual(cases.map(value => value.validation ?? false), [false, true])
  assert.ok(cases.every(value => value.data.dataRule === source.dataRule))
  assert.deepEqual(domain.cases.map(value => value.id), ['long-k', 'output-tiling', 'smatmul-bias', 'inventory-transfer'])
  const object = { id: 'input', digest: `sha256:${'0'.repeat(64)}` }
  const spec = bindDomainTask(domain.sourceTask, { project: object, acceptance: object, 'bemu-tools': object })
  assert.equal(spec.criteria.length, 1)
  assert.match(spec.criteria[0]?.statement ?? '', /deterministic fresh-CAS consumer/)
})

void test('experiment settles exploration children by shell and reviews only the root', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'singularity-check-only-flow-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'execution')
  let reviews = 0, proposers = 0, workerStep = 0
  const fixture = await startChatCompletionsFixture((request, index) => {
    const call = (name: string, args: unknown) => ({ toolCalls: [{ id: `check-flow-${String(index)}`, name, arguments: JSON.stringify(args) }],
      usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } })
    if (toolSchemaNames(request).includes('singularity_review_submit')) {
      reviews += 1
      return call('singularity_review_submit', { result: { criteria: [{ id: 'root-result', verdict: 'fail', reason: 'Root semantic review remains independent.' }] } })
    }
    if (toolSchemaNames(request).includes('rsi_submit_patch')) {
      proposers += 1
      return { content: 'No reusable patch from this protocol fixture.', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }
    }
    const step = workerStep++
    if (step === 0 || step === 4 || step === 8) return call('singularity_read', { kind: 'self' })
    if (step === 1 || step === 5 || step === 9) {
      return call('singularity_plan', { sketch: { v: 1,
        objective: 'Produce and integrate one consumable result.', levels: [0, 1].map(level => ({ level, purpose: 'Produce or integrate output.', likelyChildren: [], expectedInputs: [], expectedOutputs: ['result/value.txt'] })),
        directPlan: [], assumptions: [] } })
    }
    if (step === 2) return call('singularity_decompose', { action: 'prepare', bindingId: 'platform:explore-child' })
    if (step === 3) {
      const ackPreview = previewDigestFrom(request)
      assert.ok(ackPreview)
      return call('singularity_decompose', { action: 'commit', children: [{ bindingId: 'platform:explore-child', ackPreview,
        task: { goal: { summary: 'Produce reusable child bytes.', deliverable: 'result/value.txt containing reusable.', scope: [], constraints: [] },
          acceptanceCriteria: [{ id: 'child-result', statement: 'The child output has the required bytes.', check: 'test "$(cat result/value.txt)" = reusable' }], inputs: [] } }] })
    }
    if (step === 6) return call('bash', { description: 'Produce or integrate the frozen result.', command: 'mkdir -p result && printf reusable > result/value.txt' })
    if (step === 7) return call('singularity_submit', { outputIds: ['result'], includeLearningDrafts: false })
    if (step === 10) return call('singularity_read', { kind: 'children' })
    if (step === 11) {
      const text = messageTexts(request).join('\n')
      assert.match(text, /"goalSummary":"Produce reusable child bytes\."/)
      assert.match(text, /"deliverable":"result\/value\.txt containing reusable\."/)
      return call('bash', { description: 'Produce or integrate the frozen result.', command: 'mkdir -p result && cp children/*/result/value.txt result/value.txt' })
    }
    if (step === 12) return call('singularity_submit', { outputIds: ['result'], includeLearningDrafts: false })
    throw new Error(`Unexpected check-only flow step ${String(step)}`)
  })
  t.after(() => fixture.close())
  const oldUrl = process.env.SINGULARITY_SPIKE_BASE_URL, oldKey = process.env.SINGULARITY_SPIKE_API_KEY
  process.env.SINGULARITY_SPIKE_BASE_URL = fixture.baseURL
  process.env.SINGULARITY_SPIKE_API_KEY = 'fixture-key'
  t.after(() => {
    if (oldUrl === undefined) delete process.env.SINGULARITY_SPIKE_BASE_URL
    else process.env.SINGULARITY_SPIKE_BASE_URL = oldUrl
    if (oldKey === undefined) delete process.env.SINGULARITY_SPIKE_API_KEY
    else process.env.SINGULARITY_SPIKE_API_KEY = oldKey
  })
  const task: TaskDraft = {
    goal: { summary: 'Integrate one child result.', deliverable: 'result/value.txt', scope: [], constraints: [] },
    criteria: [{ id: 'root-result', statement: 'Root integration is independently reviewed.', required: true }],
    inputs: [], outputs: [{ id: 'result', path: 'result', kind: 'tree', role: 'deliverable', required: true }],
  }
  const domain: ExperimentDomain = {
    id: 'check-only-flow', source: {}, sourceTask: task, cases: [
      { id: 'fixture-case', input: {}, description: 'Frozen protocol case.', task },
      { id: 'fixture-validation', input: {}, description: 'Frozen validation case.', validation: true, task },
    ],
  }
  await runExperiment(root, domain, { ...EXPERIMENT_BUDGET,
    rounds: 1, maxActive: 1, reviewMaxSteps: 8, maxRequests: 100, maxWallClockMs: 60_000, maxReportedTokens: 1_000_000, maxOutputBytes: 1024 * 1024,
    task: { ...EXPERIMENT_BUDGET.task, maxRuns: 1, maxStepsPerRun: 20, maxTokens: 1_000_000, maxDepth: 2, maxTasks: 2, maxBatchChildren: 1 },
    proposerBudget: { maxSteps: 4, maxTokens: 100_000, maxWallClockMs: 60_000 },
    evaluationBudget: { ...EXPERIMENT_BUDGET.evaluationBudget, maxWallClockMs: 60_000 } })
  const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8')) as { failure?: string; outcomes: { source: string }[] }
  assert.equal(result.failure, undefined)
  assert.deepEqual(result.outcomes.map(value => value.source), ['failed'])
  assert.equal(reviews, 1, 'the exploration child never purchases an LLM review')
  assert.equal(proposers, 1)
  assert.equal(workerStep, 13)
  const launch = JSON.parse(await readFile(join(root, 'launch.json'), 'utf8')) as { checkAcceptance: { id: string } }
  const campaignId = `experiment:${basename(root)}`
  assert.equal(launch.checkAcceptance.id, `${campaignId}:frozen-check-acceptance`)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(root, 'domain/domain.sqlite'), { readOnly: true })
  try {
    const facts = db.prepare('SELECT payload FROM events ORDER BY seq').all().map(row => JSON.parse(row.payload as string) as {
      type: string; data: { runId?: string; classification?: string; children?: { contract: { taskId: string; acceptance: { id: string } } }[] }
    })
    const admission = facts.find(fact => fact.type === 'task/children-admitted')
    const child = admission?.data.children?.[0]?.contract
    assert.ok(child)
    assert.equal(child.acceptance.id, `${campaignId}:frozen-check-acceptance`)
    const closure = facts.find(fact => fact.type === 'run/closed' && fact.data.runId === `${child.taskId}:run:1`)
    assert.equal(closure?.data.classification, 'verified')
    assert.equal(facts.filter(fact => fact.type === 'rsi/trace-sealed').length, 1)
  } finally { db.close() }
})

void test('continuous metric rounds reject fewer than three trials before creating an execution root', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'singularity-continuous-trials-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const task: TaskDraft = {
    goal: { summary: 'Measure one frozen optimizer.', deliverable: 'result/', scope: [], constraints: [] },
    criteria: [{ id: 'performance', statement: 'Measure the frozen artifact.', required: true, check: 'true', checkOutput: 'metric-json' }],
    inputs: [], outputs: [{ id: 'result', path: 'result', kind: 'tree', role: 'deliverable', required: true }],
  }
  const domain: ExperimentDomain = { id: 'continuous-trials', source: {}, sourceTask: task, cases: [],
    metric: { criterion: 'performance', name: 'speedup', unit: 'ratio' } }
  const root = join(directory, 'root')
  await assert.rejects(
    runExperiment(root, domain, { ...EXPERIMENT_BUDGET, trialsPerCase: MIN_CONTINUOUS_TRIALS - 1 }),
    new RegExp(`at least ${String(MIN_CONTINUOUS_TRIALS)} trials`),
  )
  await assert.rejects(readFile(join(root, 'launch.json')), { code: 'ENOENT' })
})

void test('strict source eligibility rejects failed and cancelled roots before RSI', () => {
  assert.equal(sourceEligible('verified', true), true)
  assert.equal(sourceEligible('failed', true), false)
  assert.equal(sourceEligible('cancelled', true), false)
  assert.equal(sourceEligible('invalid', true), false)
  assert.equal(sourceEligible('failed', false), true)
  assert.equal(sourceEligible('invalid', false), false)
})
