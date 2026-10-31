import assert from 'node:assert/strict'
import test from 'node:test'

import type { ContractSummary, TaskRunState } from '@singularity/protocol'
import { ContractSummaryService, DomainStore } from '@singularity/runtime'

import { agentOptions, fixtureUsage, makeScenario } from './task-fixture.ts'
import type { Scenario } from './task-fixture.ts'
import { withHarness } from './run-fixture.ts'

void test('ancestor cache miss runs one independent scoped summary session and settles source usage', { timeout: 120_000 }, async () => {
  let scenario: Scenario | undefined
  let source: ContractSummary | undefined
  await withHarness((request, index) => {
    assert.ok(scenario)
    assert.equal(index, 0)
    assert.equal(JSON.stringify(request).includes(scenario.contract.digest), true)
    const toolNames = request.tools?.map(tool => tool.function?.name)
    assert.deepEqual(toolNames, ['singularity_summary_submit'])
    source = {
      v: 1, sourceContract: scenario.contract.digest, goal: 'Produce the declared result.',
      acceptance: ['The declared output must pass its independent criterion.'], constraints: [], outputs: ['result'],
      frozenDecisions: [], sourceRefs: [{ field: 'goal', digest: scenario.contract.digest }], generatedBy: 'contract-summary-worker',
    }
    return {
      toolCalls: [{ id: 'summary-submit', name: 'singularity_summary_submit', arguments: JSON.stringify({ summary: source }) }],
      usage: fixtureUsage(index),
    }
  }, async ({ spike, storeRoot, workspace, fixture }) => {
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId: 'summary-root', maxRuns: 1 })
    const store = await DomainStore.open({ root: storeRoot })
    try {
      const summaries = new ContractSummaryService({ ctx: spike.ctx, writer: store, agentOptions: agentOptions() })
      summaries.registerRun({ contract: scenario.contract, runId: 'source-run', workspace, checkBudget: () => true })
      const state = {
        tasks: new Map([
          ['summary-root', { taskId: 'summary-root', contract: scenario.contract, rootTaskId: 'summary-root', activeRunId: 'source-run', phase: 'active' }],
          ['child', { taskId: 'child', parentTaskId: 'summary-root', rootTaskId: 'summary-root', phase: 'active' }],
          ['sibling', { taskId: 'sibling', parentTaskId: 'summary-root', rootTaskId: 'summary-root', phase: 'active' }],
        ]),
      } as unknown as TaskRunState
      const pending = await summaries.readAncestor(state, 'child', { kind: 'ancestor', id: scenario.contract.digest }, 100)
      assert.equal(JSON.stringify(pending.data).includes('SUMMARY_PENDING'), true)
      const usage = await summaries.finishRun('source-run')
      assert.equal(fixture.requests.length, 1)
      assert.ok(usage)
      assert.equal(usage.ownerTaskId, 'summary-root')
      assert.equal(usage.sourceContract, scenario.contract.digest)
      assert.equal(usage.inputTokens, fixtureUsage(0).promptTokens)
      assert.equal(usage.outputTokens, fixtureUsage(0).completionTokens)
      assert.equal(usage.steps, 1)
      assert.equal(usage.unknownRequests, 0)
      const loaded = await summaries.readAncestor(state, 'child', { kind: 'ancestor' }, 101)
      assert.deepEqual((loaded.data as { summary: ContractSummary }).summary, source)
      assert.ok(loaded.objectRef)
      assert.equal(fixture.requests.length, 1, 'cache hits and ancestor reads do not purchase model requests')
      const record = summaries.records()[0]
      assert.ok(record)
      assert.ok(record.sessionCut.sessionId.includes('source-run'))
      assert.equal(summaries.executions()[0]?.usage.inputTokens, usage.inputTokens)
      assert.equal(record.ref.sourceContract, scenario.contract.digest)
      assert.equal((await store.readObject(loaded.objectRef)).bytes.byteLength > 0, true)
      assert.throws(() => summaries.readAncestor(state, 'child', { kind: 'ancestor', id: 'sibling' }, 102), /parent chain/)
    } finally {
      await store.close()
    }
  })
})

void test('unavailable source budget and terminal roots keep summaries pending without model usage', { timeout: 120_000 }, async () => {
  await withHarness(() => { throw new Error('a summary request must not be purchased') }, async ({ spike, storeRoot, workspace, fixture }) => {
    const scenario = await makeScenario(storeRoot, spike.ctx, { taskId: 'summary-budget-root', maxRuns: 1 })
    const store = await DomainStore.open({ root: storeRoot })
    try {
      const summaries = new ContractSummaryService({ ctx: spike.ctx, writer: store, agentOptions: agentOptions() })
      let available = false
      summaries.registerRun({ contract: scenario.contract, runId: 'source-run', workspace, checkBudget: () => available })
      const root = { taskId: scenario.contract.taskId, contract: scenario.contract, rootTaskId: scenario.contract.taskId, activeRunId: 'source-run', phase: 'active' }
      const state = { tasks: new Map<string, unknown>([
        [root.taskId, root],
        ['child', { taskId: 'child', parentTaskId: root.taskId, rootTaskId: root.taskId, phase: 'active' }],
      ]) } as unknown as TaskRunState
      assert.match(JSON.stringify((await summaries.readAncestor(state, 'child', { kind: 'ancestor' }, 100)).data), /SUMMARY_PENDING/)
      available = true
      root.phase = 'closed'
      assert.match(JSON.stringify((await summaries.readAncestor(state, 'child', { kind: 'ancestor' }, 101)).data), /SUMMARY_PENDING/)
      assert.equal(await summaries.finishRun('source-run'), undefined)
      assert.equal(fixture.requests.length, 0)
    } finally {
      await store.close()
    }
  })
})
