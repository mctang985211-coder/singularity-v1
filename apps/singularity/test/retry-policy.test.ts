import { describeFixtureCheck, fixtureCriterionResults } from './check-fixture.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { sealMethodRevision, sealPublicReceipt } from '@singularity/protocol'
import type { FactPayloadMap, FactType, JsonValue, RoundPlan } from '@singularity/protocol'
import { CommandService, evaluateRsiCandidate, evaluationCaseFromContract, executeTaskTree, freezeEvaluationCase, openRsiRound } from '@singularity/runtime'

import { buildSingleRunComposition } from '../src/host-composition.ts'
import { contextEpochFrom } from './fixtures/chat-completions.ts'
import { methodPayload, planReply, submitReply, withHarness, writeOutputReply } from './run-fixture.ts'
import { agentOptions, fixtureUsage, FROZEN_OUTPUT, jsonBytes, makeScenario } from './task-fixture.ts'
import type { Scenario } from './task-fixture.ts'

void test('one configured host retry policy survives transient invalid retry, Round closure and journal replay', { timeout: 120_000 }, async () => {
  const taskId = `task-retry-policy-${String(process.pid)}-${String(Date.now())}`
  let current: Scenario | undefined
  await withHarness((request, index) => {
    assert.ok(current)
    const step = index % 4
    if (step === 0) return {
      toolCalls: [{ id: `retry-read-${String(index)}`, name: 'singularity_read', arguments: JSON.stringify({ kind: 'self' }) }], usage: fixtureUsage(index),
    }
    if (step === 1) return planReply(current, taskId, `${taskId}:run:${index < 4 ? '1' : '2'}`, contextEpochFrom(request) ?? '')
    return step === 2 ? writeOutputReply() : submitReply()
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    const source = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 2 })
    current = source
    const actor = { kind: 'runtime', id: 'singularity-runtime' } as const
    const hostPolicy = ['verifier-timeout']
    const service = await CommandService.open({ root: storeRoot, actor, clock: Date.now, transientInvalidReasons: hostPolicy })
    hostPolicy.push('unlisted-agent-failure')
    assert.deepEqual(service.retryPolicy(), ['verifier-timeout'])
    assert.deepEqual(service.retryPolicy(['unlisted-agent-failure']), ['verifier-timeout'])
    const roundId = `${taskId}:round`
    const commit = <Type extends FactType>(type: Type, data: FactPayloadMap[Type], id: string) => service.commit({
      command: { v: 1, commandId: id, actor, tool: 'retry-policy-fixture', toolVersion: 1, scope: {}, input: data as JsonValue }, type, data,
    }, [])
    try {
      const base = source.contract.method
      await commit('method/registered', { revision: base }, `${taskId}:register`)
      const approval = await service.putObject('retry-initial-approval', jsonBytes({ next: base }))
      await commit('method/activated', { next: base, approval }, `${taskId}:initial-head`)
      const runId = `${taskId}:run:1`
      const composition = await buildSingleRunComposition(spike.ctx, { store: service, id: runId, contract: source.contract, agentOptions: agentOptions(), base: { v: 1, seed: source.contract.environment.seed } })
      let verifications = 0
      const tree = await executeTaskTree({
        ctx: spike.ctx, journalRoot: storeRoot, workspace, runId, sessionId: `${runId}:session`,
        admission: source.runAdmission, composition, agentOptions: agentOptions(), maxOutputBytes: 1024,
        maxActive: 1, workspaceRoot: join(workspace, 'runs'),
        // The ordinary runner inherits the writer policy; no per-Run list.
        verifier: { describeCheck: describeFixtureCheck,
          provider: source.contract.acceptance,
          async verify(request) {
            const output = request.outputs[0]
            assert.ok(output)
            assert.equal(new TextDecoder().decode((await request.readObject(output, 'object')).bytes), FROZEN_OUTPUT)
            const timedOut = verifications++ === 0
            return sealPublicReceipt({
              v: 1, provider: source.contract.acceptance, operationId: request.operationId, contractDigest: source.contract.digest,
              inputDigests: request.inputs.map(ref => ref.digest), outputDigests: request.outputs.map(ref => ref.digest),
              criteria: await fixtureCriterionResults(request, storeRoot, source.contract.spec.criteria.filter(criterion => criterion.required).map(criterion => ({ id: criterion.id, verdict: 'pass', reason: 'Fixture byte check.' }))),
              exit: { code: timedOut ? null : 0, signal: null }, timedOut,
            })
          },
        },
        resolveRun: () => { throw new Error('This retry fixture has no direct children') },
      }, service)
      assert.equal(tree.root.classification, 'verified', tree.root.executionRecord?.reason)
      assert.deepEqual(tree.runs.map(run => run.classification), ['invalid', 'verified'])
      assert.match(tree.runs[0]?.executionRecord?.reason ?? '', /^verifier-timeout:/)
      assert.equal(fixture.requests.length, 8)
      assert.equal((await service.taskRunState([])).tasks.get(taskId)?.closed?.outcome, 'verified')
      const trace = await service.putObject(`${taskId}:trace`, jsonBytes({ v: 1, rootTaskId: taskId, evidenceRef: tree.root.evidenceRef }))
      const usage = tree.runs.reduce((total, run) => ({ inputTokens: total.inputTokens + run.usage.inputTokens,
        outputTokens: total.outputTokens + run.usage.outputTokens, steps: total.steps + run.usage.steps,
        unknownRequests: total.unknownRequests + run.usage.unknownRequests }), { inputTokens: 0, outputTokens: 0, steps: 0, unknownRequests: 0 })
      await commit('rsi/trace-sealed', { rootTaskId: taskId, trace, usage, sessionCuts: tree.runs.map(run => run.sessionCut) }, `${roundId}:seal`)
      const caseRef = await freezeEvaluationCase(service, `${roundId}:case`, evaluationCaseFromContract(source.contract))
      const comparator = await service.putObject(`${roundId}:comparator`, jsonBytes({ v: 1, name: 'unsupported-fixture-comparator' }))
      const plan: RoundPlan = {
        v: 1, cases: [caseRef], validationCases: [], validation: 'none', claim: 'source-replay', metric: {}, thresholds: { minDelta: 1, maxRegression: 0 }, trialsPerCase: 1,
        proposerBudget: { maxSteps: 1, maxTokens: 100, maxWallClockMs: 1000 }, budget: { maxRuns: 2, maxTokens: 1000, maxWallClockMs: 5000, maxActiveRuns: 1 },
        comparator, sourceSeed: source.contract.environment.seed, expectedPreviousActiveMethod: base,
      }
      await openRsiRound({ service, actor, roundId, sourceTrace: trace, baseMethod: base, plan, proposerSessionId: `${roundId}:proposer` })
      const patch = await service.putObject(`${roundId}:patch`, jsonBytes({ v: 1, base, operations: [] }))
      const precheckReceipt = await service.putObject(`${roundId}:precheck`, jsonBytes({ v: 1, ok: true }))
      await commit('rsi/proposal-submitted', { roundId, patch }, `${roundId}:proposal`)
      const candidate = sealMethodRevision({ ...methodPayload(source.method), id: `${roundId}:candidate`, parent: base })
      const candidateMethod = await service.putObject(candidate.id, jsonBytes(candidate), 'method')
      await commit('rsi/candidate-ready', { roundId, patch, precheckReceipt, candidateMethod }, `${roundId}:candidate`)
      const evaluated = await evaluateRsiCandidate({ service, actor, roundId, runTask: () => { throw new Error('Unsupported comparator must not purchase a Task') } })
      assert.equal(evaluated.comparison.reason, 'unsupported-comparator')
      assert.equal((await service.methodRoundState()).rounds.get(roundId)?.closed?.outcome, 'insufficient-evidence')
      assert.equal(fixture.requests.length, 8)
      await commit('method/activated', { previous: base, expectedPrevious: base, next: candidateMethod, approval }, `${roundId}:manual-head`)
      const beforeMismatch = service.facts().length
      await assert.rejects(openRsiRound({ service, actor, roundId: `${roundId}:stale-source`, sourceTrace: trace,
        baseMethod: candidateMethod, plan: { ...plan, expectedPreviousActiveMethod: candidateMethod },
        proposerSessionId: `${roundId}:stale-source:proposer` }), /sealed source Method/)
      assert.equal(service.facts().length, beforeMismatch, 'source/base mismatch is rejected before opening a Round')
    } finally {
      await service.close()
    }
    const replay = await CommandService.open({ root: storeRoot, actor, clock: Date.now, transientInvalidReasons: ['verifier-timeout'] })
    try {
      const state = await replay.domainState()
      assert.equal(state.runs.size, 2)
      assert.equal(state.tasks.get(taskId)?.closed?.outcome, 'verified')
      assert.equal(state.rounds.get(roundId)?.closed?.outcome, 'insufficient-evidence')
    } finally {
      await replay.close()
    }
  })
})
