import { describeFixtureCheck, fixtureCriterionResults } from './check-fixture.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import { cancellationCutSchema, executionRecordSchema, parseJsonText, parseProtocolValue, sealPublicReceipt } from '@singularity/protocol'
import type { TaskContract } from '@singularity/protocol'
import { CommandService, executeTaskTree, sealPublicTrace } from '@singularity/runtime'
import type { RunVerifier } from '@singularity/runtime'

import { buildSingleRunComposition } from '../src/host-composition.ts'
import { contextEpochFrom } from './fixtures/chat-completions.ts'
import { previewDigestFrom, s4b2Example } from './method-fixture.ts'
import { planReply, selfReadAndPlan, submitReply, withHarness, writeOutputReply } from './run-fixture.ts'
import { agentOptions, fixtureUsage, makeScenario } from './task-fixture.ts'
import type { Scenario } from './task-fixture.ts'

void test('operator cancellation during verification stops the verifier before subtree closure', { timeout: 30_000 }, async () => {
  const taskId = 'cancel-verifying-root', runId = `${taskId}:run`
  let scenario: Scenario | undefined
  const cancellation = new AbortController()
  let stopped = false
  await withHarness((request, index) => selfReadAndPlan(request, index, scenario, taskId, runId)
    ?? (index === 2 ? writeOutputReply() : submitReply()), async ({ spike, workspace, storeRoot }) => {
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
    const actor = { kind: 'runtime', id: 'cancel-verifier-fixture' } as const
    const service = await CommandService.open({ root: storeRoot, actor, clock: Date.now })
    try {
      const result = await executeTaskTree({ ctx: spike.ctx, journalRoot: storeRoot, workspace, runId, sessionId: `${runId}:session`,
        admission: scenario.runAdmission, composition: scenario.composition, agentOptions: agentOptions(), maxOutputBytes: 1024,
        actor, signal: cancellation.signal, maxActive: 1, workspaceRoot: join(workspace, 'runs'),
        resolveRun: () => Promise.reject(new Error('This Task has no children')),
        verifier: { describeCheck: describeFixtureCheck, provider: scenario.contract.acceptance, async verify(request) {
          cancellation.abort('operator-stop-during-verification')
          try { await delay(10_000, undefined, { signal: request.signal }) }
          finally { stopped = true }
          throw new Error('Cancelled verifier must not complete')
        } },
      }, service)
      assert.equal(stopped, true)
      assert.equal(result.root.classification, 'cancelled')
      assert.equal((await service.taskRunState()).tasks.get(taskId)?.closed?.outcome, 'cancelled')
      assert.equal(service.facts().filter(fact => fact.type === 'run/closed').length, 0)
      assert.equal(service.facts().filter(fact => fact.type === 'task/closed' && fact.data.scope === 'subtree').length, 1)
      assert.equal(result.root.evidenceRef, undefined)
    } finally { await service.close() }
  })
})

void test('reported budget exhaustion drains native child/parent sessions and closes once, preserving terminal Evidence and final usage', { timeout: 120_000 }, async () => {
  const taskId = 'pool-budget-root', runId = 'pool-budget-root:run'
  let scenario: Scenario | undefined, child: TaskContract | undefined
  let childRunId = ''
  const actor = { kind: 'runtime', id: 'pool-budget-fixture' } as const
  await withHarness((request, index) => {
    const call = (name: string, args: unknown) => ({ toolCalls: [{ id: `budget-${String(index)}`, name, arguments: JSON.stringify(args) }], usage: fixtureUsage(index) })
    assert.ok(scenario)
    if (index === 0 || index === 4 || index === 8) return call('singularity_read', { kind: 'self' })
    if (index === 1 || index === 5) {
      const current = index === 5 ? child : scenario.contract
      assert.ok(current)
      return planReply({ ...scenario, contract: current }, current.taskId, index === 5 ? childRunId : runId,
        contextEpochFrom({ ...request, messages: [...(request.messages ?? [])].reverse() }) ?? '')
    }
    if (index === 2) return call('singularity_decompose', { action: 'prepare', bindingId: 'required-work' })
    if (index === 3) return call('singularity_decompose', { action: 'commit', children: [{ bindingId: 'required-work', ackPreview: previewDigestFrom(request), task: { acceptanceChecks: [],
      goal: { summary: 'Produce child.txt.', deliverable: 'child.txt', scope: [], constraints: [] }, inputs: [],
      localOutputs: [{ id: 'child-note', path: 'child.txt', kind: 'file', description: 'Public child output.' }],
    } }] })
    if (index === 6) return call('bash', { command: 'printf child > child.txt' })
    if (index === 7) return call('singularity_submit', { outputIds: ['child-note'], includeLearningDrafts: false })
    throw new Error(`No request may be purchased after the budget boundary: ${String(index)}`)
  }, async ({ spike, workspace, storeRoot, fixture }) => {
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, maxStepsPerRun: 20, maxDepth: 2, maxTasks: 2,
      childBinding: { bindingId: 'required-work', templateId: 'budget-child', brief: 'Produce a public result.', join: 'required', example: s4b2Example() } })
    const verifier = (contract: TaskContract): RunVerifier => ({ describeCheck: describeFixtureCheck, provider: contract.acceptance, async verify(request) {
      return Promise.resolve(sealPublicReceipt({ v: 1, provider: contract.acceptance, operationId: request.operationId,
        contractDigest: contract.digest, inputDigests: request.inputs.map(ref => ref.digest), outputDigests: request.outputs.map(ref => ref.digest),
        criteria: await fixtureCriterionResults(request, storeRoot, contract.spec.criteria.filter(value => value.required).map(value => ({ id: value.id, verdict: 'pass', reason: 'Fixture output.' }))), exit: { code: 0, signal: null }, timedOut: false }))
    } })
    const service = await CommandService.open({ root: storeRoot, actor, clock: Date.now })
    try {
      const result = await executeTaskTree({ ctx: spike.ctx, journalRoot: storeRoot, workspace, runId, sessionId: `${runId}:session`,
        admission: { ...scenario.runAdmission, budgetReservation: { ...scenario.runAdmission.budgetReservation, steps: 20 } },
        composition: scenario.composition, agentOptions: agentOptions(), maxOutputBytes: 1024, verifier: verifier(scenario.contract), actor,
        maxActive: 1, workspaceRoot: join(workspace, 'runs'), checkReportedBudget: () => fixture.requests.length < 9,
        async resolveRun(input) {
          child = input.contract; childRunId = input.runId
          return { composition: await buildSingleRunComposition(spike.ctx, { store: service, id: input.runId, contract: input.contract,
            agentOptions: agentOptions(), base: { v: 1, seed: input.contract.environment.seed } }), agentOptions: agentOptions(), maxOutputBytes: 1024, verifier: verifier(input.contract) }
        },
      }, service)
      assert.ok(child)
      assert.equal(result.root.classification, 'cancelled')
      assert.equal(fixture.requests.length, 9)
      const closures = service.facts().filter(fact => fact.type === 'task/closed' && fact.data.scope === 'subtree')
      assert.equal(closures.length, 1)
      const fact = closures[0]
      assert.ok(fact.type === 'task/closed' && fact.data.cancellationCutRef !== undefined)
      const cut = parseProtocolValue(cancellationCutSchema, parseJsonText(new TextDecoder().decode((await service.readObject(fact.data.cancellationCutRef)).bytes)))
      assert.equal(cut.affected.length, 1)
      const recordRef = cut.affected[0]?.executionRecordRef
      assert.ok(recordRef)
      const record = parseProtocolValue(executionRecordSchema, parseJsonText(new TextDecoder().decode((await service.readObject(recordRef)).bytes)))
      assert.equal(record.usage.steps, 5)
      assert.equal(record.usage.unknownRequests, 0)
      assert.ok(record.sessionCut.to > 0)
      assert.equal(service.facts().filter(fact => fact.type === 'run/closed' && fact.data.runId === runId).length, 0)
      const state = await service.taskRunState([])
      assert.equal(state.tasks.get(child.taskId)?.closed?.outcome, 'verified')
      assert.equal(state.tasks.get(taskId)?.closed?.outcome, 'failed')
      assert.equal(state.runs.get(runId)?.closed?.source, 'subtree-cancellation')
      const trace = await sealPublicTrace({ ctx: spike.ctx, service, actor, rootTaskId: taskId,
        acceptsExecutionRecord: () => true })
      assert.equal(trace.body.rootTask.outcome, 'failed')
    } finally { await service.close() }
    const replay = await CommandService.open({ root: storeRoot, actor, clock: Date.now })
    try {
      assert.equal((await replay.taskRunState([])).tasks.get(taskId)?.closed?.outcome, 'failed')
      assert.equal((await replay.taskRunState([])).tasks.get(child.taskId)?.closed?.outcome, 'verified')
    } finally { await replay.close() }
  })
})
