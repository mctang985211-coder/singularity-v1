import assert from 'node:assert/strict'
import { chmod,mkdtemp,mkdir,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import { CompactionId } from '@deepseek-ai/dsh-compaction'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId,SessionSeq } from '@deepseek-ai/dsh-session'
import type { RoundPlan } from '@singularity/protocol'
import type { PublicEvaluationEvidence } from '@singularity/runtime'
import { createWakeMessage,snapshotSession } from '@singularity/runtime'

import { runBuckyballCampaign } from '../examples/buckyball-campaign.ts'
import { compareFrontendPpa } from '../examples/buckyball-acceptance.ts'
import { nativeAccounting } from '../examples/native-accounting.ts'
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

void test('PPA comparator normalizes units and rejects incomplete correctness or unmatched synthesis conditions', () => {
  const caseRef = { id: 'frontend-case', digest: `sha256:${'a'.repeat(64)}` }
  const plan = { cases: [caseRef], validationCases: [], trialsPerCase: 1 } as unknown as RoundPlan
  const trial = (arm: 'baseline' | 'candidate', factor: number, conditions = 'smic180/tt/1.8V/25C/activity=.1/top=same') => {
    const ppa = { power: 10 * factor, delay: 2 * factor, area: 100 * factor, conditions, evidence: 'independently reproduced synthesis report' }
    return { caseRef, arm, verdict: 'verified', receipt: { criteria: [{ id: 'ppa-evidence', verdict: 'pass', reason: JSON.stringify(ppa),
      metric: { name: 'ppa-weighted-cost', unit: 'mW^0.3 ns^0.4 um2^0.3', value: ppa.power ** 0.3 * ppa.delay ** 0.4 * ppa.area ** 0.3 } }] } } as unknown as PublicEvaluationEvidence
  }
  const good = compareFrontendPpa(plan, [trial('baseline', 1), trial('candidate', 0.5)])
  assert.equal(good.comparable, true)
  assert.ok(Math.abs(good.aggregateDelta - 1) < 1e-10)
  assert.equal(compareFrontendPpa(plan, [trial('baseline', 1), trial('candidate', 0.5, 'different-corner')]).comparable, false)
  assert.equal(compareFrontendPpa(plan, [trial('baseline', 1), { ...trial('candidate', 0.5), verdict: 'failed' }]).comparable, false)
  assert.equal(compareFrontendPpa(plan, [trial('baseline', 1)]).comparable, false)
})

void test('chip campaign admits empty Method, independently reviews frozen outputs and preserves failed/no-proposal outcomes', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'buckyball-campaign-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const baseline = join(directory, 'baseline'), prepared = join(directory, 'prepared'), root = join(directory, 'execution')
  await mkdir(prepared)
  for (const name of ['model-port', 'model-optimize', 'chip-designer', 'ip-designer', 'ball-align', 'workload-tests', 'debug-compiler', 'check', 'report']) {
    await mkdir(join(baseline, '.agents/skills', name), { recursive: true })
    await writeFile(join(baseline, '.agents/skills', name, 'SKILL.md'), `# ${name}\nRead current domain sources.\n`)
  }
  await writeFile(join(prepared, 'project.json'), JSON.stringify({ source: { destination: baseline } }))
  const bin = join(directory, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'nix'), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > "$PWD/nix-argv.txt"\nprintf "fixture bbdev help\\n"\n')
  await chmod(join(bin, 'nix'), 0o755)
  const oldPath = process.env.PATH
  process.env.PATH = `${bin}:${oldPath ?? ''}`
  t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath })
  let reviews = 0, proposers = 0
  const fixture = await startChatCompletionsFixture((request, index) => {
    const call = (name: string, args: unknown) => ({ toolCalls: [{ id: `chip-fixture-${String(index)}`, name, arguments: JSON.stringify(args) }],
      usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } })
    if (toolSchemaNames(request).includes('buckyball_review_submit')) {
      if (!toolNames(request).includes('buckyball_review_submit')) return { toolCalls: [{ id: `bad-review-${String(index)}`,
        name: 'buckyball_review_submit', arguments: '{"result":' }], usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }
      assert.match(messageTexts(request).join('\n'), /"status":"failed"/)
      reviews += 1
      return call('buckyball_review_submit', { result: { criteria: ['model-reference', 'design-contract', 'implementation', 'component-verification', 'ppa-evidence', 'delivery']
        .map(id => ({ id, verdict: 'fail', reason: 'Fixture intentionally supplies no chip implementation or independently reproduced evidence.' })) } })
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
      assert.match(messageTexts(request).join('\n'), /frontend/)
      return call('bash', { description: 'Create an explicitly incomplete fixture output.', command: "mkdir -p frontend\nprintf 'Incomplete fixture, no chip implementation.\\n' > frontend/report.md" })
    }
    return call('singularity_submit', { outputIds: ['frontend'], includeLearningDrafts: false })
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
  await runBuckyballCampaign(root, prepared)
  const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8')) as { failure?: string; outcomes: { source: string; activation?: unknown }[]; usage: { requests: number; completed: number; unknown: number } }
  assert.equal(result.failure, undefined)
  assert.equal(result.outcomes.length, 3)
  assert.ok(result.outcomes.every(value => value.source === 'failed' && value.activation === undefined))
  assert.equal(reviews, 9, 'each failed source uses the three configured fresh attempts')
  assert.equal(proposers, 3)
  assert.equal(result.usage.requests, fixture.requests.length)
  assert.equal(result.usage.completed, fixture.requests.length)
  assert.equal(result.usage.unknown, 0)
  assert.deepEqual((await readFile(join(baseline, 'nix-argv.txt'), 'utf8')).trimEnd().split('\n'),
    [baseline, 'develop', '--command', 'bash', '-c', 'exec bbdev "$@"', '--', '--help', 'literal;$(false)'])
})
