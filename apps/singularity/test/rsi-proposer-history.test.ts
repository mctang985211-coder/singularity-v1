import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { FactPayloadMap,FactType,JsonValue,Ref,RoundPlan } from '@singularity/protocol'
import { canonicalize,parseJsonText,seal,sealMethodRevision } from '@singularity/protocol'
import { buildProposalHistory,CommandService,extendProposalHistory,submitMethodPatch } from '@singularity/runtime'

const actor = { kind: 'runtime', id: 'proposal-history-test' } as const
const zeroUsage = { inputTokens: 0, outputTokens: 0, steps: 0, unknownRequests: 0 }
const bytes = (value: unknown) => new TextEncoder().encode(canonicalize(value))
const decoder = new TextDecoder('utf-8', { fatal: true })

interface HistoryFixture {
  readonly source: Ref
  readonly methodRef: Ref
  readonly planRef: Ref
  openRound(roundId: string): Promise<void>
  propose(roundId: string, hypothesis: string): Promise<Ref>
  closeRound(roundId: string, comparisonRef?: Ref): Promise<void>
}

async function withHistory(run: (service: CommandService, fixture: HistoryFixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-proposal-history-'))
  const service = await CommandService.open({ root, actor, clock: () => 1000 })
  try {
    const commit = <Type extends FactType>(type: Type, data: FactPayloadMap[Type], id: string) => service.commit({
      command: { v: 1, commandId: id, tool: 'proposal-history-fixture', toolVersion: 1, actor, scope: {}, input: data as JsonValue }, type, data,
    }, [])
    const source = await service.putObject('history:source', bytes({ v: 1 }))
    const method = sealMethodRevision({ v: 1, id: 'method:history-base', templates: [], skills: [], tools: [] })
    const methodRef = await service.putObject(method.id, bytes(method), 'method')
    await commit('method/registered', { revision: methodRef }, 'history:register')
    await commit('method/activated', { next: methodRef, approval: source }, 'history:activate')
    const plan: RoundPlan = {
      v: 1, cases: [source], metric: {}, thresholds: { minDelta: 0, maxRegression: 0 }, trialsPerCase: 1,
      proposerBudget: { maxSteps: 2, maxTokens: 100, maxWallClockMs: 1000 },
      budget: { maxRuns: 2, maxTokens: 100, maxWallClockMs: 1000, maxActiveRuns: 1 },
      validation: 'none', validationCases: [], claim: 'source-replay', comparator: source, sourceSeed: source,
      expectedPreviousActiveMethod: methodRef,
    }
    const planRef = await service.putObject('history:plan', bytes(plan), 'round-plan')
    let sequencer = 0
    const fixture: HistoryFixture = {
      source, methodRef, planRef,
      async openRound(roundId) {
        sequencer += 1
        const trace = await service.putObject(`history:trace:${String(sequencer)}`, bytes(seal('object', {
          v: 1, kind: 'public-task-trace', traceId: `trace:${String(sequencer)}`,
          rootTask: { id: `task:${String(sequencer)}`, outcome: 'verified', method: methodRef },
          sourceResourceSnapshot: source, chapters: [], authorizedObjects: [{ ref: source, domain: 'object' }],
          usage: zeroUsage, sessionCuts: [],
        })))
        await commit('rsi/trace-sealed', { rootTaskId: `task:${String(sequencer)}`, trace, usage: zeroUsage, sessionCuts: [] }, `seal:${roundId}`)
        await commit('rsi/round-opened', { roundId, sourceTrace: trace, baseMethod: methodRef, plan: planRef,
          proposerSessionId: `session:${roundId}` }, `open:${roundId}`)
      },
      async propose(roundId, hypothesis) {
        return submitMethodPatch({ service, actor, roundId, value: { v: 1, hypothesis,
          changes: [{ op: 'set-entry', templateId: null }], predictedRisks: [], transferPlan: 'Compare public cases.' } })
      },
      async closeRound(roundId, comparisonRef) {
        await commit('rsi/round-closed', { roundId, outcome: 'insufficient-evidence',
          ...(comparisonRef === undefined ? {} : { comparisonRef }), reason: 'fixture-closure' }, `close:${roundId}`)
      },
    }
    await run(service, fixture)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function putArchivedAttempt(
  service: CommandService,
  fixture: HistoryFixture,
  attemptId: string,
  focus: string,
  patch: Ref,
  comparison?: Ref,
): Promise<Ref> {
  const selection = await service.putObject(`history:selection:${attemptId}`, bytes({
    v: 1, campaignId: 'campaign:fixture',
    point: {
      v: 1, id: `replay:${attemptId}`, sourceTrace: fixture.source, sourceTaskId: 'task:source',
      sourceContract: fixture.source, sourceEvidence: fixture.source, sourceCase: fixture.source,
      baseMethod: fixture.methodRef, templateId: focus, bindingPath: [], outcome: 'failed',
      localCases: [fixture.source],
      closure: { level: 'best-effort', workspace: 'uncontrolled', network: 'uncontrolled', hostFilesystem: 'uncontrolled', reasons: ['fixture'] },
      fanOut: { bindingReferences: 0, shared: false }, hostFingerprint: 'host:fixture',
    },
    features: { failed: true, leaf: true, retries: 0, subtreeTokens: 10, rootTokens: 20, priorAttempts: 0, qualityHeadroom: true },
    policy: { name: 'utility-v1', revision: 1 }, visibleHistory: [], score: 1, reasons: ['fixture'],
  }))
  return service.putObject(`history:attempt:${attemptId}`, bytes({
    v: 1, attemptId, campaignId: 'campaign:fixture', selection, patch, localPlan: fixture.planRef,
    ...(comparison === undefined ? {} : { comparison }), outcome: 'local-qualified',
    usage: { inputTokens: 10, outputTokens: 2, steps: 1, unknownRequests: 0 },
    nativeRequests: 2, nativeCompleted: 2, runCount: 1, cacheComplete: true,
  }))
}

void test('proposal history exposes only the public whitelist and sanitized history refs', async () => {
  await withHistory(async (service, fixture) => {
    await fixture.openRound('round:1')
    await fixture.propose('round:1', 'Reuse a bounded review.')
    const privateMarker = 'PRIVATE-HISTORY-PAYLOAD'
    const comparison = await service.putObject('history:comparison', bytes({
      v: 1, roundId: 'round:1', complete: true, claim: 'source-replay', aggregateDelta: 0.25,
      worstRegression: 0.75, reason: 'PRIVATE-REASON', validationReason: 'PRIVATE-VALIDATION',
      cases: [{ caseRef: fixture.source, detail: privateMarker }], slots: [{ payload: privateMarker }],
      usage: { inputTokens: 10, outputTokens: 2, steps: 1, unknownRequests: 0, complete: true, cacheComplete: true },
      tokenCosts: { complete: true, cacheComplete: true,
        baseline: { inputTokens: 120, outputTokens: 20, uncachedInputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0 },
        candidate: { inputTokens: 80, outputTokens: 15, uncachedInputTokens: 65, cacheReadTokens: 15, cacheWriteTokens: 0 } },
    }))
    await fixture.closeRound('round:1', comparison)
    await fixture.openRound('round:2')

    const view = await buildProposalHistory({ service, roundId: 'round:2' })
    assert.equal(view.entries.length, 1)
    assert.equal(view.historyRefs.length, 1)
    const entry = view.entries[0]
    assert.ok(entry)
    assert.equal(entry.id, 'round:1')
    assert.deepEqual(entry.baseMethod, fixture.methodRef)
    assert.equal(entry.outcome, 'insufficient-evidence')
    assert.equal(entry.hypothesis, 'Reuse a bounded review.')
    assert.deepEqual(entry.operations, ['set-entry:null'])
    assert.equal(entry.aggregateDelta, 0.25)
    assert.equal(canonicalize(view).includes(privateMarker), false)
    for (const privateField of ['worstRegression', 'validationReason', 'PRIVATE-REASON', 'PRIVATE-VALIDATION']) {
      assert.equal(canonicalize(view).includes(privateField), false, `history must not expose ${privateField}`)
    }
    const stored = parseJsonText(decoder.decode((await service.readObject(view.historyRefs[0])).bytes))
    assert.deepEqual(stored, entry)
  })
})

void test('proposal history bounds cross-base roots and same-focus attempts, then extends explicit archived attempts', async () => {
  await withHistory(async (service, fixture) => {
    const patches: Ref[] = []
    for (let index = 1; index <= 34; index += 1) {
      const roundId = `round:${String(index)}`
      await fixture.openRound(roundId)
      patches.push(await fixture.propose(roundId, `history-${String(index)}`))
      await fixture.closeRound(roundId)
    }
    await fixture.openRound('round:current')
    const refs: Ref[] = []
    for (let index = 1; index <= 10; index += 1) {
      refs.push(await putArchivedAttempt(service, fixture, `speed-${String(index)}`, 'speed', patches[index - 1]))
    }
    for (let index = 1; index <= 2; index += 1) {
      refs.push(await putArchivedAttempt(service, fixture, `other-${String(index)}`, 'other', patches[index - 1]))
    }
    const view = await buildProposalHistory({ service, roundId: 'round:current', focus: 'speed', attemptRefs: refs })
    const roots = view.entries.filter(entry => entry.id.startsWith('round:'))
    const attempts = view.entries.filter(entry => entry.id.startsWith('attempt:'))
    assert.equal(roots.length, 32)
    assert.equal(roots[0]?.hypothesis, 'history-3')
    assert.equal(roots.at(-1)?.hypothesis, 'history-34')
    assert.equal(attempts.length, 8)
    assert.ok(attempts.every(entry => entry.focusTemplateId === 'speed'))
    assert.equal(attempts[0]?.id, 'attempt:speed-3')
    assert.equal(attempts.at(-1)?.id, 'attempt:speed-10')
    assert.equal(view.historyRefs.length, view.entries.length)

    const comparison = await service.putObject('history:attempt-comparison', bytes({
      v: 1, roundId: 'round:1', complete: true, aggregateDelta: 0.5,
      tokenCosts: { complete: true, cacheComplete: true,
        baseline: { inputTokens: 30, outputTokens: 5, uncachedInputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
        candidate: { inputTokens: 20, outputTokens: 5, uncachedInputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    }))
    const newer = await putArchivedAttempt(service, fixture, 'speed-11', 'speed', patches[10], comparison)
    const unrelated = await putArchivedAttempt(service, fixture, 'other-3', 'other', patches[1])
    const extended = await extendProposalHistory({ service, history: view, attemptRefs: [newer, unrelated] })
    const extendedAttempts = extended.entries.filter(entry => entry.id.startsWith('attempt:'))
    assert.equal(extended.entries.filter(entry => entry.id.startsWith('round:')).length, 32)
    assert.equal(extendedAttempts.length, 8)
    assert.equal(extendedAttempts.at(-1)?.id, 'attempt:speed-11')
    assert.equal(extendedAttempts.at(-1)?.aggregateDelta, 0.5)
    assert.equal(extended.historyRefs.length, extended.entries.length)
    assert.equal(extended.entries.some(entry => entry.id === 'attempt:other-3'), false)
  })
})
