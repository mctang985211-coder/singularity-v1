import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import type { FactPayloadMap,FactType,JsonValue,MethodPatch,RoundPlan } from '@singularity/protocol'
import { canonicalize,parseJsonText,sealTaskContract } from '@singularity/protocol'
import {
closeRsiRound,
CommandService,DomainStore,evaluationCaseFromContract,executeRsiProposer,executeSingleRun,freezeEvaluationCase,isSettledRunResult,openRsiRound,
precheckMethodPatch,readPublicTrace,readTraceAsset,readTracePage,sealPublicTrace,
} from '@singularity/runtime'

import { buildSingleRunComposition } from '../src/host-composition.ts'
import { messageTexts,toolSchemaNames } from './fixtures/chat-completions.ts'
import {
compositionBase,contractPayload,passingVerifier,selfReadAndPlan,submitReply,withHarness,writeOutputReply,
} from './run-fixture.ts'
import type { Scenario } from './task-fixture.ts'
import { ACTOR,agentOptions,fixtureUsage,jsonBytes,makeScenario } from './task-fixture.ts'

void test('C-14 sealed public trace drives an independent scoped DSH proposer and atomic candidate precheck', { timeout: 120_000 }, async () => {
  let scenario: Scenario | undefined
  let nextScenario: Scenario | undefined
  let patch: MethodPatch | undefined
  let comparisonDigest = ''
  const taskId = 'task:s5-source', runId = 'run:s5-source'
  await withHarness((request, index) => {
    if (index < 2) return selfReadAndPlan(request, index, scenario, taskId, runId) ?? { content: 'unreachable' }
    if (index === 2) return writeOutputReply()
    if (index === 3) return submitReply()
    if (index === 8 || index === 9) return selfReadAndPlan(request, index - 8, nextScenario, 'task:s5-next', 'run:s5-next') ?? { content: 'unreachable' }
    if (index === 10) return writeOutputReply()
    if (index === 11) return submitReply()
    assert.deepEqual(toolSchemaNames(request).sort(), ['rsi_read', 'rsi_submit_patch'])
    if (index === 4) {
      assert.equal(messageTexts(request).some(text => text.includes('You execute one Singularity Task as one level')), false)
      assert.match(messageTexts(request).filter(text => text.includes('"proposer":')).join('\n'), /"tokens":100/, 'an in-flight request must not hide the remaining reported-token budget')
      const context = messageTexts(request).filter(text => text.includes('"proposer":')).join('\n')
      assert.ok(context.includes(canonicalize({ inputTokens: 220, outputTokens: 32, steps: 4, unknownRequests: 0 })))
      assert.ok(scenario)
      assert.ok(context.includes(canonicalize(scenario.method.templates[0].guidance)))
      assert.ok(context.includes(canonicalize(scenario.method.templates[0].example)))
      const schema = JSON.stringify(request.tools)
      for (const field of ['instanceSchema', 'requiredCriteria', 'requiredOutputs', 'acceptancePolicy', 'guidance', 'exampleText', 'files', 'set-entry', 'templateId']) assert.ok(schema.includes(field), `proposer schema must display ${field}`)
      const patchTool = request.tools?.find(tool => tool.function?.name === 'rsi_submit_patch')
      const parameters = patchTool?.function?.parameters as { properties?: { patch?: { type?: string } } } | undefined
      assert.equal(parameters?.properties?.patch?.type, 'object', 'native tool schema exposes the structured patch')
      return { toolCalls: [{ id: 'read-public-resources', name: 'rsi_read', arguments: JSON.stringify({ kind: 'public-resources' }) }], usage: fixtureUsage(index) }
    }
    if (index === 5) return { toolCalls: [{ id: 'read-children', name: 'rsi_read', arguments: JSON.stringify({ kind: 'trace-page', id: 'children' }) }], usage: fixtureUsage(index) }
    if (index === 6) return { toolCalls: [{ id: 'private-denied', name: 'rsi_read', arguments: JSON.stringify({ kind: 'asset', id: 'private-validation-case' }) }], usage: fixtureUsage(index) }
    assert.ok(patch)
    if (index === 7) return { toolCalls: [{ id: 'submit-patch', name: 'rsi_submit_patch', arguments: JSON.stringify({ patch }) }], usage: fixtureUsage(index) }
    if (index === 12) {
      assert.match(messageTexts(request).join('\n'), /"previousRound":\{"outcome":"no-improvement","readKind":"previous-round","roundId":"round:s5"\}/)
      return { toolCalls: [{ id: 'previous-feedback', name: 'rsi_read', arguments: JSON.stringify({ kind: 'previous-round' }) }], usage: fixtureUsage(index) }
    }
    if (index === 13) {
      const texts = messageTexts(request).join('\n')
      assert.ok(texts.includes('Reuse a local review skill for the declared output.'))
      assert.ok(texts.includes('aggregateDelta'))
      assert.ok(texts.includes('no-improvement'))
      assert.ok(!texts.includes('PRIVATE-COMPARISON-CASE'))
      return { toolCalls: [{ id: 'deny-previous-comparison', name: 'rsi_read', arguments: JSON.stringify({ kind: 'asset', id: comparisonDigest }) }], usage: fixtureUsage(index) }
    }
    if (index === 14) {
      assert.match(messageTexts(request).join('\n'), /Asset ID must identify one object/)
      return { content: 'The measured prior hypothesis did not improve this metric.', usage: fixtureUsage(index) }
    }
    throw new Error(`Unexpected fixture model request ${String(index)}`)
  }, async ({ spike, workspace, storeRoot, fixture }) => {
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
    const sourceStore = await DomainStore.open({ root: storeRoot })
    try {
      const document = await sourceStore.putObject('document:s5-public', new TextEncoder().encode('PUBLIC-S5-RESOURCE-SNAPSHOT'))
      const snapshot = await sourceStore.putObject('resources:s5-global', jsonBytes({
        v: 1, documents: [{ id: 'document:s5-public', description: 'A public source document.', object: document }],
        skills: [], tools: [], baseTools: scenario.contract.resources.baseTools,
        fallbackAcceptance: scenario.provider, fallbackJoin: 'probe',
      }))
      const contract = sealTaskContract({ ...contractPayload(scenario.contract), resources: { ...scenario.contract.resources, exploration: snapshot } })
      const composition = await buildSingleRunComposition(spike.ctx, {
        store: sourceStore, id: 's5-source', contract,
        base: compositionBase(scenario.composition), agentOptions: agentOptions(),
      })
      scenario = { ...scenario, contract, composition, runAdmission: { ...scenario.runAdmission, contract } }
    } finally { await sourceStore.close() }
    const source = await executeSingleRun({
      ctx: spike.ctx, journalRoot: storeRoot, workspace, sessionId: 'session-s5-source', runId,
      admission: scenario.runAdmission, composition: scenario.composition,
      agentOptions: agentOptions(), maxOutputBytes: 1024 * 1024,
      verifier: passingVerifier(scenario, runId, workspace, []), actor: ACTOR,
    })
    assert.ok(isSettledRunResult(source))
    assert.equal(source.classification, 'verified')
    const service = await CommandService.open({ root: storeRoot, actor: ACTOR, clock: Date.now })
    try {
      const commit = <Type extends FactType>(type: Type, data: FactPayloadMap[Type], id: string) => service.commit({
        command: { v: 1, commandId: id, tool: 's5-fixture', toolVersion: 1, actor: ACTOR, scope: {}, input: data as JsonValue }, type, data,
      }, [])
      const methodRef = scenario.contract.method
      await commit('method/registered', { revision: methodRef }, 's5:register')
      const approval = await service.putObject('s5:initial-approval', jsonBytes({ v: 1, purpose: 'fixture-initialization' }))
      await commit('method/activated', { next: methodRef, approval }, 's5:activate')
      const sealed = await sealPublicTrace({ service, actor: ACTOR, ctx: spike.ctx, rootTaskId: taskId })
      assert.equal(sealed.body.rootTask.outcome, 'verified')
      assert.equal(sealed.body.sessionCuts.length, 1)
      assert.deepEqual(sealed.body.sourceResourceSnapshot, scenario.contract.resources.exploration)
      assert.ok(sealed.body.authorizedObjects.some(item => item.ref.id === 'document:s5-public'))
      const repeated = await sealPublicTrace({ service, actor: ACTOR, ctx: spike.ctx, rootTaskId: taskId })
      assert.deepEqual(repeated.trace, sealed.trace)
      assert.equal(service.facts().filter(fact => fact.type === 'rsi/trace-sealed').length, 1)
      const children = await readTracePage(service, sealed.body, 'children')
      assert.ok(children.data.text.includes(runId))
      const privateMarker = 'PRIVATE-VALIDATION-PAYLOAD-DO-NOT-DISCLOSE'
      const privateCase = await freezeEvaluationCase(service, 'private-validation-case', {
        ...evaluationCaseFromContract(scenario.contract),
        spec: { ...scenario.contract.spec, goal: { ...scenario.contract.spec.goal, summary: privateMarker } },
      })
      await assert.rejects(readTraceAsset(service, sealed.body, privateCase), /outside.*authorization/)
      const comparator = await service.putObject('s5:comparator', jsonBytes({ v: 1, kind: 'fixture-comparator' }))
      await openRsiRound({
        service, actor: ACTOR, roundId: 'round:s5', sourceTrace: sealed.trace, baseMethod: methodRef,
        proposerSessionId: 'session-s5-proposer', plan: {
          v: 1, cases: [privateCase], metric: { name: 'pass-count' }, thresholds: { minDelta: 0, maxRegression: 0 },
          trialsPerCase: 1, proposerBudget: { maxTokens: 4096, maxSteps: 8, maxWallClockMs: 60_000 },
          budget: { maxRuns: 2, maxTokens: 8192, maxWallClockMs: 60_000, maxActiveRuns: 1 },
          validation: 'none', validationCases: [], claim: 'source-replay', comparator,
          sourceSeed: scenario.contract.environment.seed, expectedPreviousActiveMethod: methodRef,
        },
      })
      const template = scenario.method.templates[0]
      assert.ok(template)
      patch = {
        v: 1, base: methodRef, hypothesis: 'Reuse a local review skill for the declared output.',
        changes: [
          { op: 'put-skill', skill: { id: 'skill:s5-review', name: 's5-review', description: 'Review declared outputs.', files: {
            'SKILL.md': '# Review\n\nRead the frozen criteria. Do not invent a score. Check the declared output.',
          } } },
          { op: 'put-template', template: {
            ...template, guidance: 'Read the criteria, produce the output and check it with the bound review skill.',
            example: { goal: { summary: 'Produce result.txt with the requested content.', deliverable: 'result.txt', scope: ['Write the requested text.'], constraints: ['Use the declared output path.'] }, inputs: [{ id: 'request', exampleText: 'Write the requested text.' }] },
            skills: ['skill:s5-review'],
          } },
        ], predictedRisks: ['Review may add cost.'], transferPlan: 'Measure against the frozen paired cases.',
      }
      const proposerWorkspace = join(workspace, 'proposer')
      await mkdir(proposerWorkspace)
      const proposed = await executeRsiProposer({
        ctx: spike.ctx, service, actor: ACTOR, roundId: 'round:s5', workspace: proposerWorkspace, agentOptions: agentOptions(),
        publicEvaluation: { goal: 'Produce a reusable review step.', metric: 'public pass count', thresholds: ['No regression'], validationPolicy: 'none', publicCases: [{ id: 'public-case', description: 'Produce one declared output.' }] },
      })
      assert.equal(proposed.failure, undefined)
      assert.ok(proposed.proposalRef)
      assert.equal(proposed.usage.steps, 4)
      assert.equal(proposed.usage.unknownRequests, 0)
      assert.equal(proposed.sessionCut.sessionId, 'session-s5-proposer')
      assert.equal(service.facts().filter(fact => fact.type === 'rsi/proposal-submitted').length, 1)
      assert.ok(fixture.requests.flatMap(messageTexts).some(text => text.includes('outside') || text.includes('authorization')))
      assert.equal(fixture.requests.flatMap(messageTexts).some(text => text.includes(privateMarker)), false)
      assert.ok(fixture.requests.flatMap(messageTexts).some(text => text.includes('A public source document.')))
      const precheck = await precheckMethodPatch({ service, actor: ACTOR, roundId: 'round:s5' })
      assert.equal(precheck.accepted, true, canonicalize(precheck))
        assert.notDeepEqual(precheck.candidateMethod, methodRef)
        assert.deepEqual(precheck.candidate.parent, methodRef)
        assert.equal(precheck.candidate.skills[0]?.id, 'skill:s5-review')
        assert.equal((await service.methodRoundState()).methods.get(precheck.candidateMethod.id)?.digest, precheck.candidateMethod.digest)
        assert.deepEqual((await service.methodRoundState()).productionHead, methodRef)
      // Synthetic aggregate exercises the authorized projection; it is not domain improvement evidence.
      const comparison = await service.putObject('s5:public-comparison', jsonBytes({ v: 1, roundId: 'round:s5',
        complete: true, metric: { name: 'pass-count', direction: 'higher-is-better', unit: 'count', costObjective: false },
        aggregateDelta: 0, worstRegression: 0, cost: { baseline: 100, candidate: 120, unit: 'reported-tokens' },
        cases: [{ caseRef: privateCase, detail: 'PRIVATE-COMPARISON-CASE' }], slots: [{ payload: privateMarker }],
      }))
      comparisonDigest = comparison.digest
      await closeRsiRound({ service, actor: ACTOR }, { roundId: 'round:s5', outcome: 'no-improvement', comparisonRef: comparison })
      const nextContract = sealTaskContract({ ...contractPayload(scenario.contract), taskId: 'task:s5-next' })
      const nextWorkspace = join(workspace, 'next-source')
      await mkdir(nextWorkspace)
      const nextComposition = await buildSingleRunComposition(spike.ctx, { store: service, id: 's5-next', contract: nextContract,
        base: compositionBase(scenario.composition), agentOptions: agentOptions() })
      nextScenario = { ...scenario, contract: nextContract, composition: nextComposition,
        runAdmission: { ...scenario.runAdmission, contract: nextContract } }
      await executeSingleRun({ ctx: spike.ctx, journalRoot: storeRoot, workspace: nextWorkspace,
        runId: 'run:s5-next', sessionId: 'session-s5-next', admission: nextScenario.runAdmission,
        composition: nextComposition, agentOptions: agentOptions(), maxOutputBytes: 1024 * 1024,
        verifier: passingVerifier(nextScenario, 'run:s5-next', nextWorkspace, []), actor: ACTOR }, service)
      const nextTrace = await sealPublicTrace({ service, actor: ACTOR, ctx: spike.ctx, rootTaskId: 'task:s5-next' })
      const firstRound = (await service.methodRoundState()).rounds.get('round:s5')
      assert.ok(firstRound)
      const firstPlan = parseJsonText(new TextDecoder().decode((await service.readObject(firstRound.plan, 'round-plan')).bytes))
      await openRsiRound({ service, actor: ACTOR, roundId: 'round:s5-next', sourceTrace: nextTrace.trace, baseMethod: methodRef,
        proposerSessionId: 'session-s5-next-proposer', plan: firstPlan as unknown as RoundPlan })
      const nextProposerWorkspace = join(workspace, 'next-proposer')
      await mkdir(nextProposerWorkspace)
      const nextProposed = await executeRsiProposer({ ctx: spike.ctx, service, actor: ACTOR, roundId: 'round:s5-next',
        workspace: nextProposerWorkspace, agentOptions: agentOptions(),
        publicEvaluation: { goal: 'Revise an unproductive hypothesis.', metric: 'public pass count', thresholds: ['No regression'],
          validationPolicy: 'none', publicCases: [] } })
      assert.equal(nextProposed.failure, undefined)
      assert.equal(nextProposed.usage.steps, 3)
      assert.equal(fixture.requests.flatMap(messageTexts).some(text => text.includes('PRIVATE-COMPARISON-CASE') || text.includes(privateMarker)), false)
      const traceRead = await readPublicTrace(service, sealed.trace)
      assert.equal(canonicalize(traceRead), canonicalize(sealed.body))
      await service.close()
      const replay = await CommandService.open({ root: storeRoot, actor: ACTOR, clock: Date.now })
      try {
        assert.equal(canonicalize(await readPublicTrace(replay, sealed.trace)), canonicalize(sealed.body))
        assert.deepEqual((await replay.methodRoundState()).productionHead, methodRef)
        assert.equal((await replay.methodRoundState()).rounds.get('round:s5')?.candidateMethod?.digest, precheck.candidateMethod.digest)
        assert.equal((await replay.taskRunState([])).tasks.get(taskId)?.closed?.outcome, 'verified')
      } finally { await replay.close() }
    } finally { await service.close() }
  })
})

for (const mode of ['no-proposal', 'read-failure', 'provider-failure'] as const) {
void test(`C-14 explicit failed-source policy: ${mode}`, { timeout: 120_000 }, async () => {
  let scenario: Scenario | undefined
  const taskId = 'task:s5-no-submission', runId = 'run:s5-no-submission'
  await withHarness((request, index) => {
    if (index < 2) return selfReadAndPlan(request, index, scenario, taskId, runId) ?? { content: 'unreachable' }
    if (index === 2) return { content: 'The local output remains unsolved.', usage: fixtureUsage(index) }
    assert.deepEqual(toolSchemaNames(request).sort(), ['rsi_read', 'rsi_submit_patch'])
    if (index === 3 && mode === 'provider-failure') return { httpError: true }
    if (index === 3 && mode === 'read-failure') return { toolCalls: [{ id: 'host-fault-read', name: 'rsi_read', arguments: JSON.stringify({ kind: 'trace-page', id: 'planning' }) }], usage: fixtureUsage(index) }
    if (index === 3) return { content: 'The trace does not support a reusable Method change.', usage: fixtureUsage(index) }
    throw new Error(`Unexpected fixture model request ${String(index)}`)
  }, async ({ spike, workspace, storeRoot, fixture }) => {
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
    const source = await executeSingleRun({
      ctx: spike.ctx, journalRoot: storeRoot, workspace, sessionId: 'session-s5-no-submission', runId,
      admission: scenario.runAdmission, composition: scenario.composition, agentOptions: agentOptions(),
      maxOutputBytes: 1024 * 1024, verifier: passingVerifier(scenario, runId, workspace, []), actor: ACTOR,
    })
    assert.ok(isSettledRunResult(source))
    assert.equal(source.classification, 'failed')
    assert.ok(source.executionRecordRef)
    const service = await CommandService.open({ root: storeRoot, actor: ACTOR, clock: Date.now })
    try {
      await assert.rejects(sealPublicTrace({ service, actor: ACTOR, ctx: spike.ctx, rootTaskId: taskId }), /eligibility policy/)
      assert.equal(service.facts().some(fact => fact.type === 'rsi/trace-sealed'), false)
      const sealed = await sealPublicTrace({
        service, actor: ACTOR, ctx: spike.ctx, rootTaskId: taskId,
        acceptsExecutionRecord: record => record.reason === 'no-submission',
      })
      const planning = await readTracePage(service, sealed.body, 'planning')
      assert.ok(planning.data.text.includes(`${runId}:planning-sketch`))
      assert.ok(sealed.body.authorizedObjects.some(item => item.ref.id === `${runId}:planning-sketch`))
      const methodRef = scenario.contract.method
      const commit = <Type extends FactType>(type: Type, data: FactPayloadMap[Type], id: string) => service.commit({
        command: { v: 1, commandId: id, tool: 's5-fixture', toolVersion: 1, actor: ACTOR, scope: {}, input: data as JsonValue }, type, data,
      }, [])
      await commit('method/registered', { revision: methodRef }, 'no-proposal:register')
      const object = await service.putObject('no-proposal:fixture', jsonBytes({ v: 1 }))
      const caseRef = await freezeEvaluationCase(service, 'no-proposal:case', evaluationCaseFromContract(scenario.contract))
      await commit('method/activated', { next: methodRef, approval: object }, 'no-proposal:activate')
      await openRsiRound({
        service, actor: ACTOR, roundId: 'round:no-proposal', sourceTrace: sealed.trace, baseMethod: methodRef,
        proposerSessionId: 'session-s5-no-proposal', plan: {
          v: 1, cases: [caseRef], metric: {}, thresholds: { minDelta: 0, maxRegression: 0 }, trialsPerCase: 1,
          proposerBudget: { maxTokens: 1024, maxSteps: 3, maxWallClockMs: 60_000 },
          budget: { maxRuns: 2, maxTokens: 2048, maxWallClockMs: 60_000, maxActiveRuns: 1 },
          validation: 'none', validationCases: [], claim: 'source-replay', comparator: object,
          sourceSeed: scenario.contract.environment.seed, expectedPreviousActiveMethod: methodRef,
        },
      })
      const proposerWorkspace = join(workspace, 'proposer')
      await mkdir(proposerWorkspace)
      const before = service.facts()
      const hostFailure = new Error('proposer CAS unavailable')
      if (mode === 'read-failure') {
        const readObject = service.readObject.bind(service)
        const chapter = sealed.body.chapters.find(chapter => chapter.id === 'planning')
        assert.ok(chapter)
        service.readObject = (ref, domain) => ref.digest === chapter.object.digest
          ? Promise.reject(hostFailure) : readObject(ref, domain)
      }
      const attempt = executeRsiProposer({
        ctx: spike.ctx, service, actor: ACTOR, roundId: 'round:no-proposal', workspace: proposerWorkspace,
        agentOptions: agentOptions(), publicEvaluation: { goal: 'Identify one reusable change.', metric: 'public criteria', thresholds: [], validationPolicy: 'none', publicCases: [] },
      })
      if (mode !== 'no-proposal') {
        await assert.rejects(attempt, mode === 'read-failure' ? error => error === hostFailure : /fixture|request|error|500/i)
        assert.strictEqual(service.facts(), before)
        assert.equal(fixture.requests.length, 4, 'host errors must not purchase a repair or retry request')
        assert.equal(spike.ctx.agents.get('session-s5-no-proposal' as never), undefined)
        return
      }
      const proposed = await attempt
      assert.equal(proposed.proposalRef, undefined)
      assert.equal(proposed.failure, undefined)
      assert.equal(proposed.usage.steps, 1)
      assert.equal(proposed.usage.unknownRequests, 0)
      assert.equal(service.facts().some(fact => fact.type === 'rsi/proposal-submitted'), false)
      const closed = (await service.methodRoundState()).rounds.get('round:no-proposal')?.closed
      assert.equal(closed?.outcome, 'insufficient-evidence')
      assert.equal(closed.reason, 'no-proposal')
    } finally { await service.close() }
  })
})

}
