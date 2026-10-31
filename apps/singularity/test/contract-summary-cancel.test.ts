import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import type { TaskRunState } from '@singularity/protocol'
import { cancellationCutSchema,executionRecordSchema,parseJsonText,parseProtocolValue } from '@singularity/protocol'
import { CommandService,ContractSummaryService,executeSingleRun,executeTaskTree,sealPublicTrace } from '@singularity/runtime'

import type { FixtureUsage } from './fixtures/chat-completions.ts'
import { toolSchemaNames } from './fixtures/chat-completions.ts'
import { passingVerifier,withHarness } from './run-fixture.ts'
import type { Scenario } from './task-fixture.ts'
import { ACTOR,agentOptions,fixtureUsage,makeScenario } from './task-fixture.ts'

void test('Task cancellation drains an in-flight native Summary request and settles its final usage once', { timeout: 120_000 }, async () => {
  let scenario: Scenario | undefined
  let summaryRequests = 0
  let knownUsage: FixtureUsage | undefined
  const cancellation = new AbortController()
  const taskId = 'summary-cancel-root', runId = 'summary-cancel-run', sessionId = 'summary-cancel-session'
  await withHarness((request, index) => {
    assert.ok(scenario)
    if (toolSchemaNames(request).includes('singularity_summary_submit')) {
      summaryRequests += 1
      if (summaryRequests === 1) {
        knownUsage = fixtureUsage(index)
        // A rejected schema is an ordinary native tool result. The following
        // correction request is cancelled while in flight, without reported usage.
        return { toolCalls: [{ id: 'incomplete-summary', name: 'singularity_summary_submit', arguments: JSON.stringify({ summary: { v: 1 } }) }], usage: knownUsage }
      }
      assert.equal(summaryRequests, 2)
      cancellation.abort('operator-cancelled-summary-owner')
      return { hang: true }
    }
    return { content: 'The local output remains unsolved.', usage: fixtureUsage(index) }
  }, async ({ spike, storeRoot, workspace }) => {
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
    const service = await CommandService.open({ root: storeRoot, actor: ACTOR, clock: Date.now })
    const summaries = new ContractSummaryService({ ctx: spike.ctx, writer: service, agentOptions: agentOptions() })
    const dispose = spike.ctx.on('agent/created', async ({ agent }) => {
      if (String(agent.session.id) !== sessionId) return
      assert.ok(scenario)
      const state = { tasks: new Map([
        [taskId, { taskId, contract: scenario.contract, rootTaskId: taskId, activeRunId: runId, phase: 'active' }],
        ['reader', { taskId: 'reader', parentTaskId: taskId, rootTaskId: taskId, phase: 'active' }],
      ]) } as unknown as TaskRunState
      await summaries.readAncestor(state, 'reader', { kind: 'ancestor' }, Date.now())
    })
    try {
      const result = await executeTaskTree({
        ctx: spike.ctx, journalRoot: storeRoot, workspace, sessionId, runId, signal: cancellation.signal,
        admission: scenario.runAdmission, composition: scenario.composition, agentOptions: agentOptions(),
        maxOutputBytes: 1024, verifier: passingVerifier(scenario, runId, workspace, []), actor: ACTOR,
        summaries, maxActive: 1, workspaceRoot: join(workspace, 'runs'),
        resolveRun: () => { throw new Error('this fixture has no formal children') },
      }, service)
      assert.equal(result.root.classification, 'cancelled')
      assert.equal(summaryRequests, 2)
      assert.ok(knownUsage)
      const summaryUsage = result.root.usage.summary
      assert.ok(summaryUsage)
      assert.equal(summaryUsage.inputTokens, knownUsage.promptTokens)
      assert.equal(summaryUsage.outputTokens, knownUsage.completionTokens)
      assert.equal(summaryUsage.steps, 2)
      assert.equal(summaryUsage.unknownRequests, 1)
      assert.equal(summaries.records().length, 0)
      assert.equal(summaries.executions().length, 1)
      assert.match(summaries.executions()[0]?.failure ?? '', /operator-cancelled-summary-owner/)
      assert.deepEqual(await summaries.finishRun(runId), summaryUsage)
      assert.deepEqual(await summaries.finishRun(runId), summaryUsage)
      assert.equal(summaries.executions().length, 1)
      const closures = service.facts().filter(fact => fact.type === 'task/closed')
      assert.equal(closures.length, 1)
      assert.equal(service.facts().some(fact => fact.type === 'run/closed'), false)
      const closure = closures[0]
      assert.ok(closure.data.cancellationCutRef !== undefined)
      const cut = parseProtocolValue(cancellationCutSchema, parseJsonText(new TextDecoder().decode((await service.readObject(closure.data.cancellationCutRef)).bytes)))
      const recordRef = cut.affected[0]?.executionRecordRef
      assert.ok(recordRef)
      const record = parseProtocolValue(executionRecordSchema, parseJsonText(new TextDecoder().decode((await service.readObject(recordRef)).bytes)))
      assert.deepEqual(record.usage.summary, summaryUsage)
      const trace = await sealPublicTrace({ service, actor: ACTOR, ctx: spike.ctx, rootTaskId: taskId, summaries,
        acceptsExecutionRecord: record => record.reason === 'operator-cancelled-summary-owner' })
      assert.equal(trace.body.sessionCuts.length, 2)
      assert.equal(trace.body.usage.unknownRequests, result.root.usage.unknownRequests + summaryUsage.unknownRequests)
      assert.equal(trace.body.usage.inputTokens, result.root.usage.inputTokens + summaryUsage.inputTokens)
    } finally { dispose(); await service.close() }
  })
})

void test('a source host failure cancels and drains its in-flight Summary before rejecting', { timeout: 30_000 }, async () => {
  let scenario: Scenario | undefined
  let summaryStarted: () => void = () => { throw new Error('summary signal is not initialized') }
  const started = new Promise<void>(resolve => { summaryStarted = resolve })
  const taskId = 'summary-host-failure', runId = 'summary-host-run', sessionId = 'summary-host-session'
  await withHarness(request => {
    if (toolSchemaNames(request).includes('singularity_summary_submit')) {
      summaryStarted()
      return { hang: true }
    }
    return { httpError: true }
  }, async ({ spike, storeRoot, workspace, fixture }) => {
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
    const service = await CommandService.open({ root: storeRoot, actor: ACTOR, clock: Date.now })
    const summaries = new ContractSummaryService({ ctx: spike.ctx, writer: service, agentOptions: agentOptions() })
    const dispose = spike.ctx.on('agent/created', async ({ agent }) => {
      if (String(agent.session.id) !== sessionId) return
      assert.ok(scenario)
      const state = { tasks: new Map([
        [taskId, { taskId, contract: scenario.contract, rootTaskId: taskId, activeRunId: runId, phase: 'active' }],
        ['reader', { taskId: 'reader', parentTaskId: taskId, rootTaskId: taskId, phase: 'active' }],
      ]) } as unknown as TaskRunState
      await summaries.readAncestor(state, 'reader', { kind: 'ancestor' }, Date.now())
      await started
    })
    try {
      await assert.rejects(executeSingleRun({
        ctx: spike.ctx, journalRoot: storeRoot, workspace, sessionId, runId,
        admission: scenario.runAdmission, composition: scenario.composition, agentOptions: agentOptions(),
        maxOutputBytes: 1024, verifier: passingVerifier(scenario, runId, workspace, []), actor: ACTOR, summaries,
      }, service), /fixture|request|error|500/i)
      assert.equal(fixture.requests.length, 2)
      assert.equal(service.facts().some(fact => fact.type === 'run/closed' || fact.type === 'task/closed'), false)
      assert.equal(summaries.records().length, 0)
      assert.match(summaries.executions()[0]?.failure ?? '', /source-run-failed/)
      assert.equal(spike.ctx.agents.get(sessionId as never), undefined)
      assert.equal(spike.ctx.agents.get(`contract-summary:${runId}:${scenario.contract.digest}` as never), undefined)
    } finally { dispose(); await service.close() }
  })
})
