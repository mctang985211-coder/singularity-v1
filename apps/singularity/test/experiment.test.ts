import assert from 'node:assert/strict'
import { chmod,glob,mkdtemp,mkdir,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import { CompactionId } from '@deepseek-ai/dsh-compaction'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId,SessionSeq } from '@deepseek-ai/dsh-session'
import { createWakeMessage,snapshotSession } from '@singularity/runtime'

import { buckyballDomain } from '../examples/buckyball.ts'
import { EXPERIMENT_BUDGET,runExperiment } from '../src/experiment.ts'
import { nativeAccounting } from '../src/accounting.ts'
import { messageTexts,startChatCompletionsFixture,toolNames,toolSchemaNames,wireText } from './fixtures/chat-completions.ts'
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
          args: [fileURLToPath(new URL('../examples/buckyball-mcp.ts', import.meta.url))],
          env: { BUCKYBALL_BASELINE: baseline, PATH: `${bin}:${process.env.PATH ?? ''}` },
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
        for await (const chunk of spike.ctx.llm.stream({ ...agentOptions(), provider: 'singularity-local', model: 'deepseek-flash',
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
        provider: 'singularity-local', model: 'deepseek-flash', usage: { inputTokens: 100, outputTokens: 10 }, rawOutput: [], llmStreamCall: true as const }
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
        for await (const chunk of spike.ctx.llm.stream({ provider: 'singularity-local', model: 'deepseek-flash', purpose: 'compaction', messages: [] })) assert.ok(chunk.type)
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
    if (calls.length === 0) return call('singularity_read', { kind: 'self' })
    const pages = (request.messages ?? []).filter(value => value.role === 'tool').map(value => wireText(value.content)).filter(value => value.startsWith('{')).map(value => JSON.parse(value) as { data?: string; nextCursor?: string; contextEpoch: string })
      .filter(value => typeof value.data === 'string')
    const last = pages.at(-1)
    assert.ok(last)
    if (last.nextCursor !== undefined) return call('singularity_read', { kind: 'self', cursor: last.nextCursor })
    const data = JSON.parse(pages.map(value => value.data).join('')) as { taskId: string; runId: string; contractDigest: string }
    if (!calls.includes('singularity_plan')) return call('singularity_plan', { sketch: { v: 1, taskId: data.taskId, runId: data.runId, sourceContract: data.contractDigest, contextEpoch: last.contextEpoch,
      objective: 'Deliver the incomplete fixture honestly.', levels: [0, 1].map(level => ({ level, purpose: 'Inspect local output.', likelyChildren: [], expectedInputs: [], expectedOutputs: [] })), directPlan: [], assumptions: [] } })
    assert.ok(toolSchemaNames(request).includes('mcp__buckyball__bbdev'), 'the frozen domain MCP is available in each fresh Run')
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
  await runExperiment(root, await buckyballDomain(prepared))
  const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8')) as { failure?: string; outcomes: { source: string; activation?: unknown }[]; usage: { requests: number; completed: number; unknown: number } }
  assert.equal(result.failure, undefined)
  assert.deepEqual(result.outcomes.map(value => value.source), ['failed', 'failed', 'invalid'])
  assert.ok(result.outcomes.every(value => value.activation === undefined))
  assert.equal(reviews, 6, 'real failures use fresh attempts; an unsubmitted review never asks the worker to redo work')
  assert.equal(proposers, 3)
  assert.equal(result.usage.requests, fixture.requests.length)
  assert.equal(result.usage.completed, fixture.requests.length)
  assert.equal(result.usage.unknown, 0)
  const launch = JSON.parse(await readFile(join(root, 'launch.json'), 'utf8')) as {
    sourceSpec: { inputs: { id: string; object: { digest: string } }[]; goal: { constraints: string[] } }
    cases: { spec: { inputs: { id: string; object: { digest: string } }[]; goal: { constraints: string[] } } }[]
  }
  assert.ok(launch.sourceSpec.goal.constraints.some(value => value.includes(`${baseline}/.agents/skills/`)))
  assert.deepEqual(launch.sourceSpec.inputs.map(value => value.id), ['project'])
  assert.equal(launch.cases.length, 3)
  for (const { spec } of launch.cases) {
    assert.ok(spec.goal.constraints.some(value => value.includes(`${baseline}/.agents/skills/`)))
    assert.deepEqual(spec.inputs.map(value => value.id), ['project'])
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
  await runExperiment(exhausted, await buckyballDomain(prepared))
  const stopped = JSON.parse(await readFile(join(exhausted, 'result.json'), 'utf8')) as { failure?: string; outcomes: unknown[]; usage: { unknown: number } }
  assert.equal(stopped.failure, undefined, 'a budget cancellation seals its terminal ExecutionRecord without a host failure')
  assert.deepEqual(stopped.outcomes, [])
  assert.equal(stopped.usage.unknown, 0)
  assert.equal(proposers, 3, 'exhausted source never purchases an RSI request')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(exhausted, 'domain/domain.sqlite'), { readOnly: true })
  try {
    const facts = db.prepare('SELECT payload FROM events ORDER BY seq').all().map(row => JSON.parse(row.payload as string) as { type: string; data: { usage?: { unknownRequests: number }; scope?: string } })
    assert.equal(facts.filter(value => value.type === 'rsi/trace-sealed').length, 1)
    assert.ok(facts.some(value => value.type === 'task/closed' && value.data.scope === 'subtree'))
    assert.equal(facts.some(value => value.type === 'rsi/round-opened'), false)
  } finally { db.close() }
})
