import assert from 'node:assert/strict'
import test from 'node:test'

import type { ContractSummary,FactPayloadMap,FactType,JsonValue,TaskRunState } from '@singularity/protocol'
import { seal } from '@singularity/protocol'
import {
buildExecutionRecord,CommandService,ContractSummaryService,executeSingleRun,isSettledRunResult,
readTraceAsset,readTracePage,sealPublicTrace,
} from '@singularity/runtime'

import { toolSchemaNames } from './fixtures/chat-completions.ts'
import { passingVerifier,selfReadAndPlan,withHarness } from './run-fixture.ts'
import type { Scenario } from './task-fixture.ts'
import { ACTOR,agentOptions,fixtureUsage,jsonBytes,makeScenario } from './task-fixture.ts'

for (const failure of [false, true]) {
  void test(failure ? 'host Summary failure aborts its owner' : 'sealed trace counts native Summary usage once', { timeout: 120_000 }, async () => {
    let scenario: Scenario | undefined
    let workerRequest = 0
    const taskId = `task:trace-summary-${String(failure)}`, runId = `run:trace-summary-${String(failure)}`
    const sessionId = `session:trace-summary-${String(failure)}`
    await withHarness((request, index) => {
      assert.ok(scenario)
      if (toolSchemaNames(request).includes('singularity_summary_submit')) {
        assert.deepEqual(toolSchemaNames(request), ['singularity_summary_submit'])
        if (failure) return { httpError: true }
        const summary: ContractSummary = {
          v: 1, sourceContract: scenario.contract.digest, goal: 'Produce the declared result.',
          acceptance: ['The declared output must pass its independent criterion.'], constraints: [], outputs: ['result'],
          frozenDecisions: [], sourceRefs: [{ field: 'goal', digest: scenario.contract.digest }], generatedBy: 'contract-summary-worker',
        }
        return { toolCalls: [{ id: 'summary-submit', name: 'singularity_summary_submit', arguments: JSON.stringify({ summary }) }], usage: fixtureUsage(index) }
      }
      const step = workerRequest++
      if (step < 2) return selfReadAndPlan(request, step, scenario, taskId, runId) ?? { content: 'unreachable' }
      return { content: 'The local output remains unsolved.', usage: fixtureUsage(index) }
    }, async ({ spike, storeRoot, workspace }) => {
      scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
      const service = await CommandService.open({ root: storeRoot, actor: ACTOR, clock: Date.now })
      const summaries = new ContractSummaryService({ ctx: spike.ctx, writer: service, agentOptions: agentOptions() })
      // The ancestor cache behavior has its own protocol tests. Here the native
      // source creation hook requests one summary while its owning Run is open.
      const dispose = spike.ctx.on('agent/created', async ({ agent }) => {
        if (String(agent.session.id) !== sessionId) return
        assert.ok(scenario)
        const state = {
          tasks: new Map([
            [taskId, { taskId, contract: scenario.contract, rootTaskId: taskId, activeRunId: runId, phase: 'active' }],
            ['summary-reader', { taskId: 'summary-reader', parentTaskId: taskId, rootTaskId: taskId, phase: 'active' }],
          ]),
        } as unknown as TaskRunState
        const pending = await summaries.readAncestor(state, 'summary-reader', { kind: 'ancestor' }, Date.now())
        assert.match(JSON.stringify(pending.data), /SUMMARY_PENDING/)
      })
      try {
        const attempt = executeSingleRun({
          ctx: spike.ctx, journalRoot: storeRoot, workspace, sessionId, runId,
          admission: scenario.runAdmission, composition: scenario.composition, agentOptions: agentOptions(),
          maxOutputBytes: 1024 * 1024, verifier: passingVerifier(scenario, runId, workspace, []), actor: ACTOR, summaries,
        }, service)
        if (failure) {
          await assert.rejects(attempt, /fixture|request|error|500/i)
          assert.equal(service.facts().some(fact => fact.type === 'run/closed'), false)
          assert.equal(summaries.records().length, 0)
          assert.equal(spike.ctx.agents.get(sessionId as never), undefined)
          return
        }
        const source = await attempt
        assert.ok(isSettledRunResult(source))
        assert.equal(summaries.executions().length, 1)
        const execution = summaries.executions()[0]
        assert.ok(execution)
        assert.equal(execution.failure !== undefined, failure)
        await assert.rejects(sealPublicTrace({ service, actor: ACTOR, ctx: spike.ctx, rootTaskId: taskId,
          acceptsExecutionRecord: () => true }), /Summary execution metadata/)
        const sealed = await sealPublicTrace({ service, actor: ACTOR, ctx: spike.ctx, rootTaskId: taskId,
          summaries, acceptsExecutionRecord: () => true })
        assert.equal(sealed.body.sessionCuts.length, 2)
        assert.ok(sealed.body.sessionCuts.some(cut => cut.sessionId === execution.sessionCut.sessionId))
        const closed = (await service.taskRunState([])).runs.get(runId)?.closed
        assert.ok(closed?.usage)
        assert.equal(sealed.body.usage.inputTokens, closed.usage.inputTokens + (closed.usage.summary?.inputTokens ?? 0))
        assert.equal(sealed.body.usage.steps, closed.usage.steps + (closed.usage.summary?.steps ?? 0))
        assert.equal(sealed.body.usage.unknownRequests, closed.usage.unknownRequests + (closed.usage.summary?.unknownRequests ?? 0))
        const chapter = sealed.body.chapters.find(chapter => chapter.id === 'children')
        assert.ok(chapter)
        const pages = await Promise.all(Array.from({ length: chapter.pages }, (_, page) => readTracePage(service, sealed.body, 'children', page)))
        const text = pages.map(page => page.data.text).join('')
        assert.match(text, /contract-summary/)
        assert.ok(text.includes(execution.sessionCut.sessionId))
        const record = summaries.records()[0]
        assert.ok(record)
        assert.ok((await readTraceAsset(service, sealed.body, record.ref.object)).data.text.includes('Produce the declared result.'))
      } finally {
        dispose()
        await service.close()
      }
    })
  })
}

void test('CancellationCut final records seal without synthetic run/closed facts or duplicate usage', async () => {
  await withHarness(() => { throw new Error('protocol cancellation fixture does not purchase model requests') }, async ({ spike, storeRoot }) => {
    const taskId = 'task:trace-cancelled', runId = 'run:trace-cancelled', sessionId = 'session:trace-cancelled'
    const scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
    const service = await CommandService.open({ root: storeRoot, actor: ACTOR, clock: Date.now })
    try {
      const commit = <Type extends FactType>(type: Type, data: FactPayloadMap[Type]) => service.commit({
        command: { v: 1, commandId: `cancel:${type}`, tool: 'cancellation-fixture', toolVersion: 1, actor: ACTOR, scope: {}, input: data as JsonValue }, type, data,
      }, [])
      const contract = await service.putObject(taskId, jsonBytes(scenario.contract), 'contract')
      const composition = await service.putObject(`${runId}:composition`, jsonBytes(seal('composition', scenario.composition)), 'composition')
      await commit('task/admitted', { taskId, contract })
      await commit('run/opened', { taskId, runId, attempt: 1, sessionId, composition,
        workspaceKey: runId, workspaceSeed: scenario.contract.environment.seed, budgetReservation: scenario.runAdmission.budgetReservation })
      const usage = { inputTokens: 0, outputTokens: 0, steps: 0, unknownRequests: 0 }
      const sessionCut = { sessionId, from: 0, to: 0 }
      const record = buildExecutionRecord({ contract: scenario.contract, runId, composition, usage, sessionCut, reason: 'budget-exhausted' })
      const executionRecordRef = await service.putObject(`${runId}:execution-record`, jsonBytes(record))
      const cut = await service.putObject(`${taskId}:cancellation-cut`, jsonBytes(seal('object', {
        v: 1, targetTaskId: taskId, affected: [{ taskId, runId, executionRecordRef }],
      })))
      await commit('task/closed', { taskId, outcome: 'failed', scope: 'subtree', reason: 'budget-exhausted', cancellationCutRef: cut, evidenceRefs: [] })
      assert.equal(service.facts().some(fact => fact.type === 'run/closed'), false)
      await assert.rejects(sealPublicTrace({ service, actor: ACTOR, rootTaskId: taskId, readSessionEvents: () => Promise.resolve([]) }), /eligibility policy/)
      const sealed = await sealPublicTrace({ service, actor: ACTOR, rootTaskId: taskId,
        readSessionEvents: () => Promise.resolve([]), acceptsExecutionRecord: result => result.reason === 'budget-exhausted' })
      assert.deepEqual(sealed.body.usage, usage)
      assert.deepEqual(sealed.body.sessionCuts, [sessionCut])
      assert.equal(sealed.body.rootTask.outcome, 'failed')
      assert.ok(sealed.body.authorizedObjects.some(item => item.ref.digest === executionRecordRef.digest))
      assert.ok(sealed.body.authorizedObjects.some(item => item.ref.digest === cut.digest))
    } finally { await service.close() }
  })
})
