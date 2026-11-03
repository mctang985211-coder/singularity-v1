import assert from 'node:assert/strict'
import { join } from 'node:path'

import test from 'node:test'

import type { SessionEvent } from '@deepseek-ai/dsh-session'

import type { AdmittedChild,Ref,TaskExample } from '@singularity/protocol'
import { computeDigest,decomposeCommitSchema,protocolJsonSchema,sealPublicReceipt } from '@singularity/protocol'
import { DomainStore,executeSingleRun } from '@singularity/runtime'

import { messageTexts,toolSchemaNames } from './fixtures/chat-completions.ts'

import {
S4A2_SKILL_NAME,
S4B1_BINDING,
S4B1_EXAMPLE_MARKER,
S4B2_BINDING,
S4B2_EXAMPLE_MARKER,
previewDigestFrom,
s4a2Skill,
s4b1Example,
s4b2Example,
} from './method-fixture.ts'
import {
captureAgentContexts,
captureAgentPrompts,
currentComposition,
factsOfType,
readFacts,
recordSessionEvents,
selfReadAndPlan,
submitReply,
withHarness,
writeOutputReply
} from './run-fixture.ts'
import type { Scenario } from './task-fixture.ts'
import { agentOptions,fixtureUsage,makeScenario } from './task-fixture.ts'

void test('S4-B1 prepare delivers a persisted preview and status reconstructs it without a child', { timeout: 240_000 }, async () => {
  const taskId = `task-s4b1-prepare-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  let scenario: Scenario | undefined
  let result: Awaited<ReturnType<typeof executeSingleRun>> | undefined
  const createdSessions: string[] = []
  const prompts: string[] = []
  const contexts: string[] = []

  await withHarness((request, index) => {
    const first = selfReadAndPlan(request, index, scenario, taskId, runId)
    if (first !== undefined) return first
    if (index === 2) {
      return {
        reasoning: 'Prepare the frozen child example without committing a child.',
        toolCalls: [{
          id: 's4b1-prepare',
          name: 'singularity_decompose',
          arguments: JSON.stringify({ action: 'prepare', bindingId: S4B1_BINDING }),
        }],
        usage: fixtureUsage(2),
      }
    }
    if (index === 3) {
      return {
        reasoning: 'Read status to confirm the prepare receipt is still current.',
        toolCalls: [{
          id: 's4b1-status',
          name: 'singularity_read',
          arguments: JSON.stringify({ kind: 'status' }),
        }],
        usage: fixtureUsage(3),
      }
    }
    if (index === 4) {
      return {
        reasoning: 'A commit without children is a strict INVALID_ARGUMENT negative and must not create a child batch.',
        toolCalls: [{
          id: 's4b1-commit',
          name: 'singularity_decompose',
          arguments: JSON.stringify({ action: 'commit' }),
        }],
        usage: fixtureUsage(4),
      }
    }
    if (index === 5) return writeOutputReply()
    if (index === 6) return submitReply()
    return { content: `unexpected S4-B1 request ${String(index + 1)}`, usage: fixtureUsage(index) }
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      skills: [s4a2Skill()],
      childBinding: {
        bindingId: S4B1_BINDING,
        templateId: 'template:s3c-child',
        brief: 'Inspect the supplied sample and produce a local note.',
        join: 'probe',
        example: s4b1Example(),
      },
    })
    const active = scenario
    const disposeAgents = spike.ctx.on('agent/created', ({ agent }) => {
      if (String(agent.session.id) === sessionId) createdSessions.push(String(agent.session.id))
      return undefined
    })
    const disposePrompts = captureAgentPrompts(spike, sessionId, prompts)
    const disposeContexts = captureAgentContexts(spike, sessionId, contexts)
    const events = recordSessionEvents(spike, sessionId)
    try {
      result = await executeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        workspace,
        sessionId,
        runId,
        admission: active.runAdmission,
        composition: active.composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: active.provider,
          verify(request) {
            return Promise.resolve(sealPublicReceipt({
              v: 1,
              provider: active.provider,
              operationId: request.operationId,
              contractDigest: request.task.digest,
              inputDigests: request.inputs.map(ref => ref.digest),
              outputDigests: request.outputs.map(ref => ref.digest),
              criteria: request.task.spec.criteria
                .filter(criterion => criterion.required)
                .map(criterion => ({
                  id: criterion.id,
                  verdict: 'pass' as const,
                  reason: 'fixture criterion passed',
                })),
              exit: { code: 0, signal: null },
              timedOut: false,
            }))
          },
        },
        transientInvalidReasons: [],
      })
    } finally {
      events.dispose()
      disposeContexts()
      disposePrompts()
      disposeAgents()
    }

    assert.ok(result.kind === 'settled')
    assert.equal(result.classification, 'verified', result.executionRecord?.reason)
    assert.equal(fixture.requests.length, 7, 'S4-B1 must use exactly the scripted prepare/status/commit-rejection/integration steps')
    assert.deepEqual(createdSessions, [sessionId])
    const firstRequest = fixture.requests[0] ?? {}
    assert.ok(toolSchemaNames(firstRequest).includes('singularity_decompose'))
    const childrenSchema = protocolJsonSchema(decomposeCommitSchema.shape.children)
    delete childrenSchema.$schema
    assert.partialDeepStrictEqual(
      firstRequest.tools?.find(tool => tool.function?.name === 'singularity_decompose')?.function?.parameters,
      { properties: { children: childrenSchema } },
      'the actual model request must expose the complete protocol TaskProposal structure',
    )
    assert.ok(contexts[0]?.includes(S4B1_BINDING))
    assert.ok(contexts[0]?.includes('"join":"probe"'))
    assert.ok(contexts[0]?.includes('"canDecompose":false'))
    assert.ok(prompts[0])
    assert.equal(active.composition.platformPrompt, computeDigest('object', { v: 1, text: prompts[0] ?? '' }))
    assert.ok(Buffer.byteLength(JSON.stringify(firstRequest.tools ?? [])) <= 12 * 1024)
    assert.ok(Buffer.byteLength(contexts[0] ?? '') <= 8 * 1024)

    const prepareResultEvent = events.events.find(
      (event): event is Extract<SessionEvent, { readonly type: 'tool/result' }> =>
        event.type === 'tool/result' && event.data.message.toolCallId === 's4b1-prepare',
    )
    assert.ok(prepareResultEvent, 'the successful prepare tool result must be persisted')
    const prepareText = prepareResultEvent.data.message.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
    const prepareOutput = JSON.parse(prepareText) as {
      readonly status: string
      readonly previewRef: Ref
      readonly deliveryReceiptRef: Ref
      readonly bindingId: string
      readonly join: string
      readonly brief: string
      readonly templateRef: Ref
      readonly methodRef: Ref
      readonly example: TaskExample
      readonly resolved: { readonly skills: readonly { readonly id: string; readonly name: string }[] }
      readonly interface: { readonly instanceSchema: unknown }
      readonly contextEpoch: string
    }
    assert.equal(prepareOutput.status, 'preview')
    assert.equal(prepareOutput.bindingId, S4B1_BINDING)
    assert.equal(prepareOutput.join, 'probe')
    assert.equal(prepareOutput.example.goal.summary.includes(S4B1_EXAMPLE_MARKER), true)
    assert.deepEqual(prepareOutput.example, s4b1Example())
    assert.equal(prepareOutput.resolved.skills.some(skill => skill.name === S4A2_SKILL_NAME), true)
    assert.equal(prepareOutput.brief, 'Inspect the supplied sample and produce a local note.')
    assert.deepEqual(prepareOutput.interface.instanceSchema, {})
    assert.equal(prepareOutput.templateRef.id, 'template:s3c-child')
    assert.equal(prepareOutput.templateRef.digest, prepareOutput.methodRef.digest)

    const statusResultEvent = events.events.find(
      (event): event is Extract<SessionEvent, { readonly type: 'tool/result' }> =>
        event.type === 'tool/result' && event.data.message.toolCallId === 's4b1-status',
    )
    assert.ok(statusResultEvent, 'the status tool result must be persisted')
    const statusText = statusResultEvent.data.message.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
    const statusOutput = JSON.parse(statusText) as {
      readonly data: { readonly previews: readonly { readonly state: string; readonly previewRef: Ref }[] }
    }
    assert.equal(statusOutput.data.previews.length, 1)
    assert.equal(statusOutput.data.previews[0]?.state, 'current')
    assert.deepEqual(statusOutput.data.previews[0]?.previewRef, prepareOutput.previewRef)

    const store = await DomainStore.open({ root: storeRoot })
    try {
      await store.readObject(prepareOutput.previewRef, 'preview')
      await assert.rejects(store.readObject(prepareOutput.previewRef, 'object'), /digest|domain|corrupt/i)
      await store.readObject(prepareOutput.deliveryReceiptRef, 'object')
      await assert.rejects(store.readObject(prepareOutput.deliveryReceiptRef, 'preview'), /digest|domain|corrupt/i)
      const facts = store.facts()
      assert.equal(facts.some(fact => fact.type === 'task/children-admitted'), false)
      assert.deepEqual(facts.map(fact => fact.type), [
        'task/admitted',
        'run/opened',
        'run/submitted',
        'run/closed',
        'task/closed',
      ])
    } finally {
      await store.close()
    }

    const requestTexts = messageTexts(fixture.requests[4] ?? {})
    assert.ok(requestTexts.some(text => text.includes('"state":"current"')))
    assert.ok(requestTexts.some(text => text.includes(S4B1_EXAMPLE_MARKER)))
    const commitTexts = messageTexts(fixture.requests[5] ?? {})
    assert.ok(commitTexts.some(text => text.includes('"code":"INVALID_ARGUMENT"')), 'a malformed commit without children must be rejected with INVALID_ARGUMENT')
    const usage = result.usage
    if (process.env.SINGULARITY_S4B1_EVIDENCE === '1') {
      console.log('S4-B1 evidence:', JSON.stringify({
        prepareRef: prepareOutput.previewRef,
        receiptRef: prepareOutput.deliveryReceiptRef,
        contextEpoch: prepareOutput.contextEpoch,
        usage,
        systemBytes: Buffer.byteLength(prompts[0] ?? ''),
        nodeViewBytes: Buffer.byteLength(contexts[0] ?? ''),
        toolSchemaBytes: Buffer.byteLength(JSON.stringify(firstRequest.tools ?? [])),
        request0Bytes: Buffer.byteLength(JSON.stringify(firstRequest)),
        sessionEvents: events.events.length,
        eventTypes: events.events.map(event => event.type),
        toolResults: events.events
          .filter((event): event is Extract<SessionEvent, { readonly type: 'tool/result' }> => event.type === 'tool/result')
          .map(event => String(event.data.message.toolCallId)),
      }))
    }
    assert.ok(usage.inputTokens > 0)
    assert.ok(usage.outputTokens > 0)
    assert.equal(usage.unknownRequests, 0)
  })
})

void test('S4-B2 commit yields the parent; an admitted child uses the shared Run path', { timeout: 240_000 }, async () => {
  const taskId = `task-s4b2-commit-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  const expectedBatchId = `batch:${sessionId}:s4b2-commit`
  let scenario: Scenario | undefined
  let childScenario: Scenario | undefined
  let admittedChild: AdmittedChild | undefined
  let result: Awaited<ReturnType<typeof executeSingleRun>> | undefined
  const createdSessions: string[] = []
  const prompts: string[] = []
  const contexts: string[] = []

  await withHarness((request, index) => {
    if (index >= 4) {
      assert.ok(childScenario)
      const childId = childScenario.contract.taskId
      const first = selfReadAndPlan(request, index - 4, childScenario, childId, `${childId}:run`)
      if (first !== undefined) return first
      return {
        toolCalls: [{
          id: 'child-submit', name: 'singularity_submit',
          arguments: JSON.stringify({ outputIds: [], includeLearningDrafts: false }),
        }],
        usage: fixtureUsage(index),
      }
    }
    const first = selfReadAndPlan(request, index, scenario, taskId, runId)
    if (first !== undefined) return first
    if (index === 2) {
      return {
        reasoning: 'Read the complete frozen child example and keep the preview receipt.',
        toolCalls: [{
          id: 's4b2-prepare',
          name: 'singularity_decompose',
          arguments: JSON.stringify({ action: 'prepare', bindingId: S4B2_BINDING }),
        }],
        usage: fixtureUsage(2),
      }
    }
    if (index === 3) {
      const ackPreview = previewDigestFrom(request)
      assert.ok(ackPreview, 'the later model step must see the persisted previewRef digest')
      return {
        reasoning: 'Acknowledge the persisted preview and commit exactly one prepared child.',
        toolCalls: [{
          id: 's4b2-commit',
          name: 'singularity_decompose',
          arguments: JSON.stringify({
            action: 'commit',
            children: [{
              bindingId: S4B2_BINDING,
              ackPreview,
              task: {
                goal: {
                  summary: 'Inspect the authorized sample and report one result.',
                  deliverable: 'One result and a local note.',
                  scope: ['single committed child sample'],
                  constraints: ['Use only host-authorized inputs.'],
                },
                acceptanceCriteria: [{
                  id: 's4b2-child-criterion',
                  statement: 'The local note records the observed sample.',
                }],
                inputs: [],
                localOutputs: [{
                  id: 's4b2-child-note',
                  path: 'notes.txt',
                  kind: 'file',
                  description: 'Child-local note.',
                }],
              },
            }],
          }),
        }],
        usage: fixtureUsage(3),
      }
    }
    return { content: `unexpected S4-B2 request ${String(index + 1)}`, usage: fixtureUsage(index) }
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      maxDepth: 2,
      maxTasks: 2,
      maxBatchChildren: 1,
      skills: [s4a2Skill()],
      childBinding: {
        bindingId: S4B2_BINDING,
        templateId: 'template:s3c-child',
        brief: 'Inspect the supplied sample and produce a local note.',
        join: 'probe',
        example: s4b2Example(),
      },
    })
    const active = scenario
    const disposeAgents = spike.ctx.on('agent/created', ({ agent }) => {
      if (String(agent.session.id) === sessionId) createdSessions.push(String(agent.session.id))
      return undefined
    })
    const disposePrompts = captureAgentPrompts(spike, sessionId, prompts)
    const disposeContexts = captureAgentContexts(spike, sessionId, contexts)
    const events = recordSessionEvents(spike, sessionId)
    try {
      result = await executeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        workspace,
        sessionId,
        runId,
        admission: active.runAdmission,
        composition: active.composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: active.provider,
          verify() {
            throw new Error('an active child batch must not verify the parent')
          },
        },
        transientInvalidReasons: [],
      })
    } finally {
      events.dispose()
      disposeContexts()
      disposePrompts()
      disposeAgents()
    }

    assert.equal(result.kind, 'yielded')
    assert.equal(result.taskId, taskId)
    assert.equal(result.runId, runId)
    assert.equal(result.sessionId, sessionId)
    assert.equal(result.batchId, expectedBatchId)
    assert.deepEqual(result.childTaskIds, [
      `child:${computeDigest('object', { parentTaskId: taskId, batchId: expectedBatchId, bindingId: S4B2_BINDING, index: 0 }).slice(7)}`,
    ])
    assert.equal(fixture.requests.length, 4, 'commit must conclude the turn without buying another request')
    assert.deepEqual(createdSessions, [sessionId], 'commit must not create a child Agent session')
    assert.ok(result.usage.inputTokens > 0)
    assert.ok(result.usage.outputTokens > 0)
    assert.equal(result.usage.unknownRequests, 0)
    assert.ok(contexts[0]?.includes(S4B2_BINDING))
    assert.ok(contexts[0]?.includes('"join":"probe"'))
    assert.ok(prompts[0])

    const requestTexts = messageTexts(fixture.requests[3] ?? {})
    const previewDigest = previewDigestFrom(fixture.requests[3] ?? {})
    assert.ok(previewDigest)
    assert.ok(requestTexts.some(text => text.includes(S4B2_EXAMPLE_MARKER)))
    assert.equal(requestTexts.some(text => text.includes('"status":"preview"')), true)

    const store = await DomainStore.open({ root: storeRoot })
    try {
      const facts = store.facts()
      assert.deepEqual(facts.map(fact => fact.type), [
        'task/admitted',
        'run/opened',
        'task/children-admitted',
      ])
      const admittedFacts = factsOfType(facts, 'task/children-admitted')
      assert.equal(admittedFacts.length, 1)
      const admitted = admittedFacts[0]
      assert.ok(admitted)
      assert.equal(admitted.data.parentRunId, runId)
      assert.equal(admitted.data.batchId, expectedBatchId)
      assert.equal(admitted.data.children.length, 1)
      const child = admitted.data.children[0]
      assert.ok(child)
      admittedChild = child
      assert.equal(child.contract.taskId, result.childTaskIds[0])
      assert.equal(child.join, 'probe')
      assert.deepEqual(child.contract.origin, {
        kind: 'child',
        parentId: taskId,
        parentRunId: runId,
        batchId: expectedBatchId,
        bindingId: S4B2_BINDING,
      })
      assert.equal(child.contract.method.id, active.method.id)
      assert.equal(child.contract.template.id, 'template:s3c-child')
      assert.equal(child.contract.spec.inputs.length, 0)
      assert.deepEqual(child.contract.spec.localGuidance, [{
        id: 's4b2-child-criterion',
        statement: 'The local note records the observed sample.',
      }])
      assert.deepEqual(child.contract.spec.criteria, [])
      assert.deepEqual(child.contract.resources.baseTools, active.contract.resources.baseTools)
      assert.deepEqual(child.contract.resources.skills, active.contract.resources.skills)
      assert.equal(child.contract.resources.mcpServers.length, 0)
      assert.equal(child.contract.limits.maxRuns, 1)
      assert.equal(child.contract.limits.maxDepth, 1)
      assert.equal(child.contract.limits.maxTasks, 1)
      assert.equal(child.contract.limits.deadlineAt, active.contract.limits.deadlineAt)
      assert.equal(child.budgetReservation.tokens, child.contract.limits.maxTokens)
      assert.ok(child.budgetReservation.tokens > 0)
      assert.ok(child.budgetReservation.tokens <= active.contract.limits.maxTokens)
      assert.equal(child.budgetReservation.steps, child.contract.limits.maxStepsPerRun)
      assert.equal(child.budgetReservation.deadlineAt, active.contract.limits.deadlineAt)
      assert.deepEqual(
        child.contract.spec.outputs.map(output => ({
          id: output.id,
          role: output.role,
          required: output.required,
        })),
        [
          { id: 's4b2-child-note', role: 'supporting', required: false },
          { id: '__skill-drafts', role: 'skill-draft', required: false },
          { id: '__mcp-drafts', role: 'mcp-draft', required: false },
        ],
      )
      assert.equal(facts.some(fact => fact.type === 'run/submitted'), false)
      assert.equal(facts.some(fact => fact.type === 'run/closed'), false)
      assert.equal(facts.some(fact => fact.type === 'task/closed'), false)
      assert.equal(child.contract.taskId === taskId, false)
    } finally {
      await store.close()
    }

    const usage = result.usage
    if (process.env.SINGULARITY_S4B2_EVIDENCE === '1') {
      console.log('S4-B2 evidence:', JSON.stringify({
        batchId: result.batchId,
        childTaskIds: result.childTaskIds,
        previewDigest,
        usage,
        systemBytes: Buffer.byteLength(prompts[0] ?? ''),
        nodeViewBytes: Buffer.byteLength(contexts[0] ?? ''),
        toolSchemaBytes: Buffer.byteLength(JSON.stringify((fixture.requests[0] ?? {}).tools ?? [])),
        request0Bytes: Buffer.byteLength(JSON.stringify(fixture.requests[0] ?? {})),
        requests: fixture.requests.length,
        sessionEvents: events.events.length,
        eventTypes: events.events.map(event => event.type),
        toolResults: events.events
          .filter((event): event is Extract<SessionEvent, { readonly type: 'tool/result' }> =>
            event.type === 'tool/result')
          .map(event => String(event.data.message.toolCallId)),
      }))
    }

    // Exercise the same executor with the already admitted child contract.
    assert.ok(admittedChild)
    const child = admittedChild
    childScenario = {
      ...active,
      contract: child.contract,
      provider: child.contract.acceptance,
    }
    const childResult = await executeSingleRun({
      ctx: spike.ctx, journalRoot: storeRoot, workspace: join(workspace, 'child'),
      sessionId: `${child.contract.taskId}:session`, runId: `${child.contract.taskId}:run`,
      admission: { contract: child.contract, attempt: 1, budgetReservation: child.budgetReservation },
      composition: await currentComposition(spike.ctx, storeRoot, childScenario),
      agentOptions: agentOptions(), maxOutputBytes: 1024,
      verifier: {
        provider: child.contract.acceptance,
        verify(request) {
          return Promise.resolve(sealPublicReceipt({
            v: 1, provider: child.contract.acceptance, operationId: request.operationId,
            contractDigest: request.task.digest,
            inputDigests: request.inputs.map(ref => ref.digest),
            outputDigests: request.outputs.map(ref => ref.digest),
            criteria: [], exit: { code: 0, signal: null }, timedOut: false,
          }))
        },
      },
    })
    assert.equal(childResult.kind, 'settled')
    assert.equal(childResult.classification, 'verified')
    const facts = await readFacts(storeRoot)
    assert.equal(factsOfType(facts, 'task/admitted').length, 1, 'child admission remains the batch fact')
    assert.equal(factsOfType(facts, 'run/closed').some(fact => fact.data.runId === runId), false)
  })
})
