import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import type { FactPayloadMap,FactType,JsonValue,MethodPatchDraft,RoundPlan } from '@singularity/protocol'
import { parseJsonText,parseProtocolValue,proposalHistoryEntrySchema,seal,sealMethodRevision } from '@singularity/protocol'
import { CommandService,draftRsiPatch } from '@singularity/runtime'
import type { ProposalHistoryView } from '@singularity/runtime'

import { messageTexts,toolSchemaNames } from './fixtures/chat-completions.ts'
import { withHarness } from './run-fixture.ts'
import { ACTOR,agentOptions,fixtureUsage,jsonBytes } from './task-fixture.ts'

const zeroUsage = { inputTokens: 0, outputTokens: 0, steps: 0, unknownRequests: 0 }
const decoder = new TextDecoder('utf-8', { fatal: true })

void test('draftRsiPatch records an independent draft without proposal or closure facts and shares its budget', { timeout: 120_000 }, async () => {
  const patch: MethodPatchDraft = { v: 1, hypothesis: 'Reuse one bounded draft step.',
    changes: [{ op: 'set-entry', templateId: null }], predictedRisks: [], transferPlan: 'Compare the frozen public cases.' }
  await withHarness((request, index) => {
    assert.deepEqual(toolSchemaNames(request).sort(), ['rsi_read', 'rsi_submit_patch'])
    const context = messageTexts(request).join('\n')
    if (index === 0) {
      assert.ok(context.includes('"focus":"reuse"'))
      assert.ok(context.includes('"history":{"count":10,"readKind":"history"}'))
      return { toolCalls: [{ id: 'draft-history-0', name: 'rsi_read', arguments: JSON.stringify({ kind: 'history', page: 0 }) }],
        usage: fixtureUsage(index) }
    }
    if (index === 1) {
      assert.ok(context.includes('"total":10'))
      assert.ok(context.includes('"nextCursor":"1"'))
      return { toolCalls: [{ id: 'draft-history-1', name: 'rsi_read', arguments: JSON.stringify({ kind: 'history', cursor: '1' }) }],
        usage: fixtureUsage(index) }
    }
    if (index === 2) {
      assert.ok(context.includes('"page":1'))
      return { toolCalls: [{ id: 'draft-submit', name: 'rsi_submit_patch', arguments: JSON.stringify({ patch }) }],
        usage: fixtureUsage(index) }
    }
    throw new Error(`Unexpected fixture model request ${String(index)}`)
  }, async ({ spike, workspace, storeRoot, fixture }) => {
    const service = await CommandService.open({ root: storeRoot, actor: ACTOR, clock: () => 1000 })
    try {
      const commit = <Type extends FactType>(type: Type, data: FactPayloadMap[Type], id: string) => service.commit({
        command: { v: 1, commandId: id, tool: 'draft-fixture', toolVersion: 1, actor: ACTOR, scope: {}, input: data as JsonValue }, type, data,
      }, [])
      const source = await service.putObject('draft:source', jsonBytes({ v: 1 }))
      const method = sealMethodRevision({ v: 1, id: 'method:draft-base', templates: [], skills: [], tools: [] })
      const methodRef = await service.putObject(method.id, jsonBytes(method), 'method')
      await commit('method/registered', { revision: methodRef }, 'draft:register')
      await commit('method/activated', { next: methodRef, approval: source }, 'draft:activate')
      const plan: RoundPlan = {
        v: 1, cases: [source], metric: {}, thresholds: { minDelta: 0, maxRegression: 0 }, trialsPerCase: 1,
        proposerBudget: { maxSteps: 8, maxTokens: 4096, maxWallClockMs: 60_000 },
        budget: { maxRuns: 2, maxTokens: 4096, maxWallClockMs: 60_000, maxActiveRuns: 1 },
        validation: 'none', validationCases: [], claim: 'source-replay', comparator: source, sourceSeed: source,
        expectedPreviousActiveMethod: methodRef,
      }
      const planRef = await service.putObject('draft:plan', jsonBytes(plan), 'round-plan')
      const trace = await service.putObject('draft:trace', jsonBytes(seal('object', {
        v: 1, kind: 'public-task-trace', traceId: 'trace:draft',
        rootTask: { id: 'task:draft', outcome: 'verified', method: methodRef },
        sourceResourceSnapshot: source, chapters: [], authorizedObjects: [{ ref: source, domain: 'object' }],
        usage: zeroUsage, sessionCuts: [],
      })))
      await commit('rsi/trace-sealed', { rootTaskId: 'task:draft', trace, usage: zeroUsage, sessionCuts: [] }, 'draft:seal')
      await commit('rsi/round-opened', { roundId: 'round:draft', sourceTrace: trace, baseMethod: methodRef, plan: planRef,
        proposerSessionId: 'session:round-draft' }, 'draft:open')
      const historyEntries = Array.from({ length: 10 }, (_, index) => parseProtocolValue(proposalHistoryEntrySchema, {
        id: `round:${String(index + 1)}`, baseMethod: methodRef, hypothesis: `history-${String(index + 1)}`,
        operations: ['set-entry:null'], outcome: 'no-improvement',
      }))
      const history: ProposalHistoryView = { v: 1, roundId: 'round:draft', entries: historyEntries,
        historyRefs: await Promise.all(historyEntries.map((entry, index) => service.putObject(`draft:history:${String(index)}`, jsonBytes(entry)))) }
      const before = service.facts()
      const proposerWorkspace = join(workspace, 'draft-proposer')
      await mkdir(proposerWorkspace)
      const drafted = await draftRsiPatch({
        ctx: spike.ctx, service, actor: ACTOR, roundId: 'round:draft',
        proposalSessionId: 'session:draft-independent', recordId: 'record:draft:1',
        workspace: proposerWorkspace, agentOptions: agentOptions(),
        publicEvaluation: { goal: 'Reuse a bounded step.', metric: 'public criteria', thresholds: [], validationPolicy: 'none', publicCases: [] },
        sharedBudget: { deadlineAt: Date.now() + 60_000, maxTokens: 4096, maxSteps: 8, used: zeroUsage },
        focus: 'reuse', history,
      })
      assert.equal(drafted.failure, undefined)
      assert.deepEqual(drafted.draft, patch)
      assert.ok(drafted.draftRef)
      assert.equal(drafted.usage.steps, 3)
      assert.equal(drafted.sessionCut.sessionId, 'session:draft-independent')
      assert.deepEqual(service.facts(), before)
      const record = parseJsonText(decoder.decode((await service.readObject(drafted.recordRef)).bytes)) as Record<string, unknown>
      assert.equal(record['kind'], 'rsi-patch-draft')
      assert.equal(record['proposalSessionId'], 'session:draft-independent')
      assert.deepEqual(record['draftRef'], drafted.draftRef)
      assert.deepEqual(parseJsonText(decoder.decode((await service.readObject(drafted.draftRef)).bytes)), patch)

      const requests = fixture.requests.length
      const exhausted = await draftRsiPatch({
        ctx: spike.ctx, service, actor: ACTOR, roundId: 'round:draft',
        proposalSessionId: 'session:draft-second', recordId: 'record:draft:2',
        workspace: proposerWorkspace, agentOptions: agentOptions(),
        publicEvaluation: { goal: 'Reuse a bounded step.', metric: 'public criteria', thresholds: [], validationPolicy: 'none', publicCases: [] },
        sharedBudget: { deadlineAt: Date.now() + 60_000, maxTokens: 4096, maxSteps: drafted.usage.steps - 1, used: drafted.usage },
        focus: 'reuse',
      })
      assert.equal(exhausted.draft, undefined)
      assert.match(exhausted.failure ?? '', /budget is exhausted/)
      assert.equal(fixture.requests.length, requests, 'a shared used budget must not purchase another request')
      assert.deepEqual(service.facts(), before, 'draft execution never writes proposal, method or Round closure facts')
    } finally {
      await service.close()
    }
  })
})
