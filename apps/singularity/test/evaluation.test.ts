import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { sealMethodRevision, sealPublicReceipt, sealTaskContract } from '@singularity/protocol'
import type { FactPayloadMap, FactType, JsonValue, Ref, RoundPlan, TaskContract } from '@singularity/protocol'
import { activateRoundCandidate, CommandService, evaluateRsiCandidate, evaluationCaseFromContract, executeTaskTree, freezeEvaluationCase, openRsiRound, readEvaluationCase } from '@singularity/runtime'
import type { EvaluationComparator, RunVerifier } from '@singularity/runtime'

import { buildSingleRunComposition } from '../src/host-composition.ts'
import { contextEpochFrom } from './fixtures/chat-completions.ts'
import { contractPayload, methodPayload, planReply, submitReply, withHarness, writeOutputReply } from './run-fixture.ts'
import { agentOptions, fixtureUsage, FROZEN_OUTPUT, jsonBytes, makeScenario, OUTPUT_PATH } from './task-fixture.ts'
import type { Scenario } from './task-fixture.ts'

for (const incomplete of [false, true]) void test(`S6 ${incomplete ? 'incomplete candidate stops without buying baseline' : 'complete failed receipts preserve subsequent paired slots'}`, { timeout: 240_000 }, async () => {
  const taskId = `task-evaluation-${String(process.pid)}-${String(Date.now())}`
  let current: Scenario | undefined
  let currentRunId = `${taskId}:run`
  await withHarness((request, index) => {
    assert.ok(current)
    if (incomplete && index === 4) return { content: 'End without a submission.', usage: fixtureUsage(index) }
    const step = index % 4
    if (step === 0) return {
      toolCalls: [{ id: `eval-read-${String(index)}`, name: 'singularity_read', arguments: JSON.stringify({ kind: 'self' }) }], usage: fixtureUsage(index),
    }
    if (step === 1) return planReply(current, current.contract.taskId, currentRunId, contextEpochFrom(request) ?? '')
    if (step === 2) return writeOutputReply()
    return submitReply()
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    const source = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
    current = source
    const actor = { kind: 'runtime', id: 'singularity-runtime' } as const
    const service = await CommandService.open({ root: storeRoot, actor, clock: Date.now })
    let comparisonRef: Ref | undefined
    const roundId = `${taskId}:round`
    const verified: string[] = []
    const verifier = (contract: TaskContract): RunVerifier => ({
      provider: contract.acceptance,
      async verify(request) {
        const output = request.outputs[0]
        assert.ok(output)
        const bytes = (await request.readObject(output, 'object')).bytes
        assert.equal(new TextDecoder().decode(bytes), FROZEN_OUTPUT)
        verified.push(contract.taskId)
        return sealPublicReceipt({
          v: 1, provider: contract.acceptance, operationId: request.operationId, contractDigest: contract.digest,
          inputDigests: request.inputs.map(ref => ref.digest), outputDigests: request.outputs.map(ref => ref.digest),
          criteria: contract.spec.criteria.filter(criterion => criterion.required).map(criterion => ({ id: criterion.id, verdict: contract.method.id.endsWith(':candidate') ? 'fail' : 'pass', reason: 'Fixture business verdict after byte check.', metric: { name: 'output-bytes', unit: 'bytes', value: bytes.length } })),
          exit: { code: 0, signal: null }, timedOut: false,
        })
      },
    })
    const commit = <Type extends FactType>(type: Type, data: FactPayloadMap[Type], id: string) => service.commit({
      command: { v: 1, commandId: id, actor, tool: 'evaluation-fixture-host', toolVersion: 1, scope: {}, input: data as JsonValue }, type, data,
    }, [])
    const run = async (contract: TaskContract, runWorkspace: string, checkReportedBudget?: Parameters<typeof executeTaskTree>[0]['checkReportedBudget'], canOpenRun?: () => boolean) => {
      currentRunId = `${contract.taskId}:run`
      const composition = await buildSingleRunComposition(spike.ctx, { store: service, id: currentRunId, contract, agentOptions: agentOptions(), base: { v: 1, seed: contract.environment.seed } })
      current = { ...source, contract, composition }
      return executeTaskTree({
        ctx: spike.ctx, journalRoot: storeRoot, workspace: runWorkspace,
        runId: currentRunId, sessionId: `${currentRunId}:session`,
        admission: { contract, attempt: 1, budgetReservation: { tokens: contract.limits.maxTokens, steps: contract.limits.maxStepsPerRun, deadlineAt: contract.limits.deadlineAt } },
        composition, agentOptions: agentOptions(), verifier: verifier(contract), maxOutputBytes: 1024,
        maxActive: 1, workspaceRoot: join(runWorkspace, 'runs'),
        ...(checkReportedBudget === undefined ? {} : { checkReportedBudget }),
        ...(canOpenRun === undefined ? {} : { canOpenRun }),
        resolveRun: () => { throw new Error('This fixture case has no direct children') },
      }, service)
    }
    try {
      const base = source.contract.method
      await commit('method/registered', { revision: base }, `${roundId}:register`)
      const approval = await service.putObject('initial-approval', jsonBytes({ next: base }))
      await commit('method/activated', { next: base, approval }, `${roundId}:initial-head`)
      const sourceResult = await run(source.contract, workspace)
      assert.equal(sourceResult.root.classification, 'verified')
      // This test isolates evaluation from the separately tested public trace
      // renderer and proposer; its source still traverses the ordinary runner.
      assert.ok(sourceResult.root.evidenceRef)
      const trace = await service.putObject(`${taskId}:trace`, jsonBytes({ v: 1, rootTaskId: taskId, evidenceRef: sourceResult.root.evidenceRef }))
      await commit('rsi/trace-sealed', { rootTaskId: taskId, trace, usage: sourceResult.root.usage, sessionCuts: [sourceResult.root.sessionCut] }, `${roundId}:seal`)
      const frozenSource = evaluationCaseFromContract(source.contract)
      const cases = await Promise.all(['case-a', 'case-b'].map(id => freezeEvaluationCase(service, id, {
        ...frozenSource, spec: { ...frozenSource.spec, goal: { ...frozenSource.spec.goal, summary: `${frozenSource.spec.goal.summary} Fixture case ${id}.` } },
      })))
      const comparatorRef = await service.putObject('comparator', jsonBytes({ v: 1, name: 'fixture-byte-length' }))
      const plan: RoundPlan = {
        v: 1, cases, metric: { name: 'output-bytes', aggregate: 'mean' }, thresholds: { minDelta: 1, maxRegression: 0 }, trialsPerCase: 1,
        proposerBudget: { maxSteps: 1, maxTokens: 100, maxWallClockMs: 1000 },
        budget: { maxRuns: 4, maxTokens: 100_000, maxWallClockMs: 120_000, maxActiveRuns: 1 },
        validation: 'none', validationCases: [], claim: 'source-replay', comparator: comparatorRef,
        sourceSeed: source.contract.environment.seed, expectedPreviousActiveMethod: base,
      }
      const invalidCase = await service.putObject('invalid-case', jsonBytes({ v: 1, description: 'A description alone does not freeze root inputs.' }))
      await assert.rejects(openRsiRound({ service, actor, roundId, sourceTrace: trace, baseMethod: base, plan: { ...plan, cases: [invalidCase] }, proposerSessionId: `${roundId}:proposer` }))
      assert.equal(service.facts().filter(fact => fact.type === 'rsi/round-opened').length, 0)
      await openRsiRound({ service, actor, roundId, sourceTrace: trace, baseMethod: base, plan, proposerSessionId: `${roundId}:proposer` })
      const patch = await service.putObject(`${roundId}:patch`, jsonBytes({ v: 1, base, operations: [] }))
      const precheckReceipt = await service.putObject(`${roundId}:precheck`, jsonBytes({ v: 1, ok: true }))
      await commit('rsi/proposal-submitted', { roundId, patch }, `${roundId}:proposal`)
      const candidate = sealMethodRevision({ ...methodPayload(source.method), id: `${source.method.id}:candidate`, parent: base })
      const candidateRef = await service.putObject(candidate.id, jsonBytes(candidate), 'method')
      await commit('rsi/candidate-ready', { roundId, patch, precheckReceipt, candidateMethod: candidateRef }, `${roundId}:candidate`)
      const comparator: EvaluationComparator = {
        asset: comparatorRef,
        describeMetric: () => ({ name: 'output-bytes', direction: 'higher-is-better', unit: 'bytes', costObjective: false }),
        compare(frozen, evidence) {
          assert.equal(evidence.length, 4)
          const compared = frozen.cases.map(caseRef => {
            const value = (arm: 'baseline' | 'candidate') => {
              const item = evidence.find(item => item.caseRef.id === caseRef.id && item.arm === arm)
              assert.ok(item)
              assert.equal(item.verdict, arm === 'candidate' ? 'failed' : 'verified')
              return item.receipt.criteria[0]?.metric?.value ?? Number.NaN
            }
            return { caseRef, baseline: value('baseline'), candidate: value('candidate'), verdict: 'Exact frozen output bytes.' }
          })
          return { comparable: true, cases: compared, aggregateDelta: compared.reduce((sum, item) => sum + item.candidate - item.baseline, 0) / compared.length }
        },
      }
      const result = await evaluateRsiCandidate({
        service, actor, roundId, comparator,
        async runTask(slotRequest) {
          const { baseTools, exploration, ...frozen } = await readEvaluationCase(service, slotRequest.slot.caseRef)
          const contract = sealTaskContract({
            ...contractPayload(source.contract), ...frozen, taskId: slotRequest.slot.taskId,
            resources: { ...source.contract.resources, baseTools, ...(exploration === undefined ? {} : { exploration }) },
            origin: { kind: 'root', purpose: 'evaluation', requestRef: slotRequest.requestRef },
            method: slotRequest.slot.method, template: { id: source.contract.template.id, digest: slotRequest.slot.method.digest },
          })
          const tree = await run(contract, join(workspace, slotRequest.slot.id.slice(-64)), slotRequest.checkReportedBudget, slotRequest.canOpenRun)
          assert.equal(tree.root.classification, slotRequest.slot.arm === 'candidate' ? 'failed' : 'verified', tree.root.executionRecord?.reason)
        },
      })
      comparisonRef = result.comparisonRef
      assert.equal(result.comparison.outcome, incomplete ? 'insufficient-evidence' : 'no-improvement')
      assert.equal(result.comparison.complete, !incomplete)
      assert.equal(result.comparison.completeCases, incomplete ? 0 : 2)
      assert.equal(result.comparison.slots.length, 4)
      assert.equal(result.comparison.usage.unknownRequests, 0)
      assert.equal(verified.length, incomplete ? 1 : 5)
      assert.equal(fixture.requests.length, incomplete ? 5 : 20)
      assert.equal((await service.methodRoundState()).rounds.get(roundId)?.closed?.outcome, result.comparison.outcome)
    } finally {
      await service.close()
    }
    const replay = await CommandService.open({ root: storeRoot, actor, clock: Date.now })
    try {
      const result = await evaluateRsiCandidate({ service: replay, actor, roundId, runTask: () => { throw new Error('closed replay must not start another Task') } })
      assert.deepEqual(result.comparisonRef, comparisonRef)
      assert.equal(result.comparison.outcome, incomplete ? 'insufficient-evidence' : 'no-improvement')
      assert.equal(fixture.requests.length, incomplete ? 5 : 20)
      assert.equal((await replay.taskRunState([])).tasks.size, incomplete ? 2 : 5)
    } finally {
      await replay.close()
    }
  })
})

void test('S7 synthetic numeric fixtures activate an improved domain Round, start the next Round from fresh work, and reject stale approval', { timeout: 240_000 }, async () => {
  const taskId = `task-rounds-${String(process.pid)}-${String(Date.now())}`
  let current: Scenario | undefined
  let currentRunId = `${taskId}:run`
  let currentValue = 1
  await withHarness((request, index) => {
    assert.ok(current)
    const step = index % 4
    if (step === 0) return {
      toolCalls: [{ id: `round-read-${String(index)}`, name: 'singularity_read', arguments: JSON.stringify({ kind: 'self' }) }], usage: fixtureUsage(index),
    }
    if (step === 1) return planReply(current, current.contract.taskId, currentRunId, contextEpochFrom(request) ?? '')
    if (step === 2) return {
      toolCalls: [{ id: `round-write-${String(index)}`, name: 'bash', arguments: JSON.stringify({ command: `printf %s ${String(currentValue)} > ${OUTPUT_PATH}` }) }], usage: fixtureUsage(index),
    }
    return submitReply()
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    const source = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
    const sourceContract = sealTaskContract({
      ...contractPayload(source.contract),
      spec: {
        ...source.contract.spec,
        goal: { summary: 'Return one integer from 1 to 3; the synthetic metric prefers larger valid integers.', deliverable: OUTPUT_PATH, scope: ['synthetic numeric fixture'], constraints: ['Write exactly one digit with no trailing newline.'] },
        criteria: [{ id: 'numeric-result', statement: 'The result is an integer from 1 to 3.', required: true }],
      },
    })
    const actor = { kind: 'operator', id: 'synthetic-round-fixture' } as const
    const service = await CommandService.open({ root: storeRoot, actor, clock: Date.now })
    const values = new Map([[sourceContract.method.id, 1]])
    const commit = <Type extends FactType>(type: Type, data: FactPayloadMap[Type], id: string) => service.commit({
      command: { v: 1, commandId: id, actor, tool: 'synthetic-round-fixture', toolVersion: 1, scope: {}, input: data as JsonValue }, type, data,
    }, [])
    const run = async (contract: TaskContract, runWorkspace: string, checkReportedBudget?: Parameters<typeof executeTaskTree>[0]['checkReportedBudget'], canOpenRun?: () => boolean) => {
      currentRunId = `${contract.taskId}:run`
      const composition = await buildSingleRunComposition(spike.ctx, { store: service, id: currentRunId, contract, agentOptions: agentOptions(), base: { v: 1, seed: contract.environment.seed } })
      current = { ...source, contract, composition }
      const value = values.get(contract.method.id)
      assert.ok(value)
      // The fixture scripts this response. It tests protocol execution, not
      // learning or measured improvement by a real model on a real domain.
      currentValue = value
      return executeTaskTree({
        ctx: spike.ctx, journalRoot: storeRoot, workspace: runWorkspace, runId: currentRunId, sessionId: `${currentRunId}:session`, actor,
        admission: { contract, attempt: 1, budgetReservation: { tokens: contract.limits.maxTokens, steps: contract.limits.maxStepsPerRun, deadlineAt: contract.limits.deadlineAt } },
        composition, agentOptions: agentOptions(), maxOutputBytes: 1024, maxActive: 1, workspaceRoot: join(runWorkspace, 'runs'),
        ...(checkReportedBudget === undefined ? {} : { checkReportedBudget }),
        ...(canOpenRun === undefined ? {} : { canOpenRun }),
        verifier: {
          provider: contract.acceptance,
          async verify(request) {
            const output = request.outputs[0]
            assert.ok(output)
            const bytes = (await request.readObject(output, 'object')).bytes
            const text = new TextDecoder().decode(bytes)
            assert.match(text, /^[1-3]$/)
            return sealPublicReceipt({
              v: 1, provider: contract.acceptance, operationId: request.operationId, contractDigest: contract.digest,
              inputDigests: request.inputs.map(ref => ref.digest), outputDigests: request.outputs.map(ref => ref.digest),
              criteria: [{ id: 'numeric-result', verdict: 'pass', reason: 'Independent digit-range check.', metric: { name: 'synthetic-quality', unit: 'points', value: Number(text) } }],
              exit: { code: 0, signal: null }, timedOut: false,
            })
          },
        },
        resolveRun: () => { throw new Error('This numeric fixture has no direct children') },
      }, service)
    }
    const comparatorRef = await service.putObject('numeric-comparator', jsonBytes({ v: 1, name: 'synthetic-numeric-mean' }))
    const frozenSource = evaluationCaseFromContract(sourceContract)
    const cases = await Promise.all(['numeric-case-a', 'numeric-case-b', 'numeric-validation'].map(id => freezeEvaluationCase(service, id, {
      ...frozenSource, spec: { ...frozenSource.spec, goal: { ...frozenSource.spec.goal, summary: `${frozenSource.spec.goal.summary} Fixture case ${id}.` } },
    })))
    const comparator: EvaluationComparator = {
      asset: comparatorRef,
      describeMetric: () => ({ name: 'synthetic-quality', direction: 'higher-is-better', unit: 'points', costObjective: false }),
      compare(frozen, evidence) {
        assert.equal(evidence.length, 6)
        assert.equal(evidence.filter(item => item.partition === 'validation').length, 2)
        const compared = [...frozen.cases, ...frozen.validationCases].map(caseRef => {
          const value = (arm: 'baseline' | 'candidate') => {
            const item = evidence.find(item => item.caseRef.id === caseRef.id && item.arm === arm)
            assert.ok(item)
            assert.equal(item.verdict, 'verified')
            return item.receipt.criteria[0]?.metric?.value ?? Number.NaN
          }
          return { caseRef, baseline: value('baseline'), candidate: value('candidate'), verdict: 'Independent numeric receipt metric.' }
        })
        return { comparable: true, cases: compared, aggregateDelta: compared.reduce((sum, item) => sum + item.candidate - item.baseline, 0) / compared.length }
      },
    }
    const completeRound = async (roundId: string, contract: TaskContract, value: number) => {
      const sourceResult = await run(contract, join(workspace, `source-${String(value)}`))
      assert.equal(sourceResult.root.classification, 'verified')
      assert.ok(sourceResult.root.evidenceRef)
      // Manual trace/proposer/precheck fixture facts isolate the evaluation and
      // activation consumers from their separately tested model sessions.
      const trace = await service.putObject(`${roundId}:trace`, jsonBytes({ v: 1, rootTaskId: contract.taskId, evidenceRef: sourceResult.root.evidenceRef }))
      await commit('rsi/trace-sealed', { rootTaskId: contract.taskId, trace, usage: sourceResult.root.usage, sessionCuts: [sourceResult.root.sessionCut] }, `${roundId}:seal`)
      const plan: RoundPlan = {
        v: 1, cases: cases.slice(0, 2), validationCases: cases.slice(2), validation: 'required-by-domain', claim: 'domain-evaluation',
        metric: { name: 'synthetic-quality', aggregate: 'mean' }, thresholds: { minDelta: 0.5, maxRegression: 0 }, trialsPerCase: 1,
        proposerBudget: { maxSteps: 1, maxTokens: 100, maxWallClockMs: 1000 },
        budget: { maxRuns: 6, maxTokens: 100_000, maxWallClockMs: 120_000, maxActiveRuns: 1 },
        comparator: comparatorRef, sourceSeed: contract.environment.seed, expectedPreviousActiveMethod: contract.method,
      }
      await openRsiRound({ service, actor, roundId, sourceTrace: trace, baseMethod: contract.method, plan, proposerSessionId: `${roundId}:proposer` })
      const patch = await service.putObject(`${roundId}:patch`, jsonBytes({ v: 1, base: contract.method, operations: [] }))
      const precheckReceipt = await service.putObject(`${roundId}:precheck`, jsonBytes({ v: 1, ok: true }))
      await commit('rsi/proposal-submitted', { roundId, patch }, `${roundId}:proposal`)
      const guidance = await service.putObject(`${roundId}:guidance`, jsonBytes({ v: 1, text: `Write the valid integer ${String(value + 1)}.` }))
      const candidate = sealMethodRevision({ ...methodPayload(source.method), id: `${roundId}:candidate`, parent: contract.method, templates: source.method.templates.map(template => ({ ...template, guidance })) })
      const candidateRef = await service.putObject(candidate.id, jsonBytes(candidate), 'method')
      values.set(candidate.id, value + 1)
      await commit('rsi/candidate-ready', { roundId, patch, precheckReceipt, candidateMethod: candidateRef }, `${roundId}:candidate`)
      const result = await evaluateRsiCandidate({
        service, actor, roundId, comparator,
        async runTask(slotRequest) {
          const { baseTools, exploration, ...frozen } = await readEvaluationCase(service, slotRequest.slot.caseRef)
          const evaluation = sealTaskContract({
            ...contractPayload(contract), ...frozen, taskId: slotRequest.slot.taskId,
            resources: { ...contract.resources, baseTools, ...(exploration === undefined ? {} : { exploration }) },
            origin: { kind: 'root', purpose: 'evaluation', requestRef: slotRequest.requestRef }, method: slotRequest.slot.method,
            template: { id: contract.template.id, digest: slotRequest.slot.method.digest },
          })
          const tree = await run(evaluation, join(workspace, slotRequest.slot.id.slice(-64)), slotRequest.checkReportedBudget, slotRequest.canOpenRun)
          assert.equal(tree.root.classification, 'verified', tree.root.executionRecord?.reason)
        },
      })
      assert.equal(result.comparison.outcome, 'improved')
      assert.equal(result.comparison.completeCases, 3)
      assert.equal(result.comparison.aggregateDelta, 1)
      assert.equal(result.comparison.usage.unknownRequests, 0)
      return candidateRef
    }
    try {
      const base = sourceContract.method
      await commit('method/registered', { revision: base }, `${taskId}:register`)
      const initialApproval = await service.putObject('numeric-initial-approval', jsonBytes({ next: base }))
      await commit('method/activated', { next: base, approval: initialApproval }, `${taskId}:initial-head`)
      const firstRound = `${taskId}:round-1`
      const next = await completeRound(firstRound, sourceContract, 1)
      const approval = await service.putObject(`${firstRound}:approval`, jsonBytes({ expectedPrevious: base, next }))
      await activateRoundCandidate({ service, actor, roundId: firstRound, approval })
      assert.deepEqual((await service.domainState()).productionHead, next)
      assert.deepEqual((await service.taskRunState([])).tasks.get(taskId)?.contract.method, base)
      const nextRequest = await service.putObject(`${taskId}:next-work-request`, jsonBytes({ v: 1, request: 'Fresh work after fixture activation.' }))
      const nextWork = sealTaskContract({
        ...contractPayload(sourceContract), taskId: `${taskId}:next-work`, origin: { kind: 'root', purpose: 'work', requestRef: nextRequest },
        method: next, template: { id: sourceContract.template.id, digest: next.digest },
      })
      const secondRound = `${taskId}:round-2`
      const candidate2 = await completeRound(secondRound, nextWork, 2)
      const second = (await service.methodRoundState()).rounds.get(secondRound)
      assert.deepEqual(second?.baseMethod, next)
      assert.notDeepEqual(second.sourceTrace, (await service.methodRoundState()).rounds.get(firstRound)?.sourceTrace)
      // A separate trusted rollback changes the head while the completed
      // Round and its candidate remain intact for operator review.
      const rollback = await service.putObject(`${taskId}:rollback-approval`, jsonBytes({ expectedPrevious: next, next: base }))
      await commit('method/activated', { expectedPrevious: next, previous: next, next: base, approval: rollback }, `${taskId}:trusted-rollback`)
      const staleApproval = await service.putObject(`${secondRound}:approval`, jsonBytes({ expectedPrevious: next, next: candidate2 }))
      await assert.rejects(activateRoundCandidate({ service, actor, roundId: secondRound, approval: staleApproval }), /expected head/)
      const state = await service.domainState()
      assert.deepEqual(state.productionHead, base)
      assert.deepEqual(state.rounds.get(secondRound)?.candidateMethod, candidate2)
      assert.equal(state.rounds.get(secondRound)?.closed?.outcome, 'improved')
      assert.equal(state.tasks.size, 14)
      assert.equal(fixture.requests.length, 56)
    } finally {
      await service.close()
    }
    const replay = await CommandService.open({ root: storeRoot, actor, clock: Date.now })
    try {
      const state = await replay.domainState()
      assert.deepEqual(state.productionHead, sourceContract.method)
      assert.equal(state.rounds.size, 2)
      assert.ok([...state.rounds.values()].every(round => round.closed?.outcome === 'improved'))
      assert.equal(state.tasks.size, 14)
      assert.equal(fixture.requests.length, 56)
    } finally {
      await replay.close()
    }
  })
})
