import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { sealMethodRevision, sealPublicReceipt, sealTaskContract } from '@singularity/protocol'
import type { TaskContract } from '@singularity/protocol'
import { CommandService, executeTaskTree } from '@singularity/runtime'
import type { RunVerifier } from '@singularity/runtime'

import { buildSingleRunComposition } from '../src/host-composition.ts'
import { contextEpochFrom, messageTexts } from './fixtures/chat-completions.ts'
import { previewDigestFrom, s4b2Example } from './method-fixture.ts'
import { contractPayload, methodPayload, planReply, withHarness } from './run-fixture.ts'
import { agentOptions, FROZEN_OUTPUT, jsonBytes, makeScenario } from './task-fixture.ts'
import type { Scenario, ScriptedReply } from './task-fixture.ts'

void test('local child cap settles failed while its sibling continues; parent replans, replaces and verifies both required winners', { timeout: 120_000 }, async () => {
  const taskId = 'local-budget-root', runId = `${taskId}:run`
  let scenario: Scenario | undefined
  let firstPreview = '', parentRequests = 0
  const children = new Map<string, { readonly contract: TaskContract; readonly runId: string; readonly sessionId: string }>()
  const childRequests = new Map<string, number>()
  const siblingStarted = Promise.withResolvers<undefined>()
  const actor = { kind: 'runtime', id: 'local-budget-fixture' } as const
  const usage = (tokens: number) => ({ promptTokens: tokens - 10, completionTokens: 10, totalTokens: tokens, cachedTokens: 0 })
  await withHarness((request, index) => {
    const call = (name: string, args: unknown, tokens = 50): ScriptedReply => ({
      toolCalls: [{ id: `local-budget-${String(index)}`, name, arguments: JSON.stringify(args) }], usage: usage(tokens),
    })
    assert.ok(scenario)
    const currentScenario = scenario
    const currentId = messageTexts(request).map(text => /"task":\{"id":"([^"]+)"/.exec(text)?.[1]).find(id => id !== undefined)
    assert.ok(currentId)
    const child = children.get(currentId)
    const plan = (contract: TaskContract, currentRunId: string, tokens = 50): ScriptedReply => ({
      ...planReply({ ...currentScenario, contract }, contract.taskId, currentRunId,
        contextEpochFrom({ ...request, messages: [...(request.messages ?? [])].reverse() }) ?? ''), usage: usage(tokens),
    })
    if (child !== undefined) {
      const step = childRequests.get(currentId) ?? 0
      childRequests.set(currentId, step + 1)
      if (step === 0) assert.ok(messageTexts(request).some(text => text.includes('"depthPct":0')),
        'a leaf sees that its remaining decomposition depth is zero')
      const bad = children.values().next().value
      assert.ok(bad)
      if (currentId === bad.contract.taskId) {
        assert.equal(step, 0, 'the exhausted leaf purchases no further requests')
        return call('singularity_read', { kind: 'self' }, child.contract.limits.maxTokens + 1)
      }
      if (step === 0) return call('singularity_read', { kind: 'self' })
      if (step === 1) {
        if (child.contract.origin.kind === 'child' && child.contract.origin.bindingId === 'sibling') siblingStarted.resolve(undefined)
        return plan(child.contract, child.runId)
      }
      if (step === 2) return call('bash', { command: `printf %s '${FROZEN_OUTPUT}' > child.txt` })
      assert.equal(step, 3)
      return call('singularity_submit', { outputIds: ['child-note'], includeLearningDrafts: false })
    }
    assert.equal(currentId, taskId)
    const step = parentRequests++
    if (step === 5) assert.ok(messageTexts(request).some(text => text.includes('"taskSlotsPct":25')),
      'the parent counts itself and both admitted children')
    if (step === 11) assert.ok(messageTexts(request).some(text => text.includes('"taskSlotsPct":0')),
      'the replacement uses the final Task slot')
    if (step === 0 || step === 5 || step === 11) return call('singularity_read', { kind: 'self' }, step === 0 ? 100 : 50)
    if (step === 1 || step === 8 || step === 12) return plan(scenario.contract, runId, step === 1 ? 100 : 50)
    if (step === 2 || step === 3 || step === 9) {
      if (step === 3) {
        const preview = previewDigestFrom({ ...request, messages: [...(request.messages ?? [])].reverse() })
        assert.ok(preview)
        firstPreview = preview
      }
      return call('singularity_decompose', { action: 'prepare', bindingId: step === 3 ? 'sibling' : 'exhausted' }, step < 5 ? 100 : 50)
    }
    if (step === 4 || step === 10) return call('singularity_decompose', { action: 'commit', children: (step === 4 ? [
      { bindingId: 'exhausted', ackPreview: firstPreview },
      { bindingId: 'sibling', ackPreview: previewDigestFrom({ ...request, messages: [...(request.messages ?? [])].reverse() }) },
    ] : [{ bindingId: 'exhausted', ackPreview: previewDigestFrom({ ...request, messages: [...(request.messages ?? [])].reverse() }) }])
      .map(item => ({ ...item, task: {
        goal: { summary: 'Produce child.txt.', deliverable: 'child.txt', scope: [], constraints: [] }, inputs: [],
        localOutputs: [{ id: 'child-note', path: 'child.txt', kind: 'file', description: 'Direct public output.' }],
      } })) }, step === 4 ? 100 : 50)
    if (step === 6 || step === 15) return call('singularity_submit', { outputIds: ['result'], includeLearningDrafts: false })
    if (step === 7) {
      assert.ok(messageTexts(request).some(text => text.includes('REQUIRED_FEEDBACK_REPLAN')))
      return call('singularity_read', { kind: 'feedback' })
    }
    if (step === 13) return call('singularity_read', { kind: 'children' })
    assert.equal(step, 14)
    const winners = [...children.values()].slice(1)
    assert.equal(winners.length, 2)
    const paths = winners.map(winner => `children/${encodeURIComponent(winner.contract.taskId)}/child-note`)
    return call('bash', { command: `cmp '${paths[0]}' '${paths[1]}' && cat '${paths[0]}' > result.txt` })
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    const original = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, maxStepsPerRun: 40,
      maxDepth: 1, maxTasks: 4, maxBatchChildren: 2,
      childBinding: { bindingId: 'exhausted', templateId: 'budget-child', brief: 'Produce a public result.', join: 'required', example: s4b2Example() } })
    const service = await CommandService.open({ root: storeRoot, actor, clock: Date.now })
    try {
      const method = sealMethodRevision({ ...methodPayload(original.method), id: 'method:local-budget',
        templates: original.method.templates.map(template => template.id === original.contract.template.id
          ? { ...template, children: [...template.children, { bindingId: 'sibling', templateId: 'budget-child', brief: 'Produce the second public result.', join: 'required' }] }
          : template) })
      const methodRef = await service.putObject(method.id, jsonBytes(method), 'method')
      const contract = sealTaskContract({ ...contractPayload(original.contract), method: methodRef,
        template: { id: original.contract.template.id, digest: method.digest }, limits: { ...original.contract.limits, maxTokens: 10_000 } })
      const composition = await buildSingleRunComposition(spike.ctx, { store: service, id: runId, contract,
        agentOptions: agentOptions(), base: { v: 1, seed: contract.environment.seed } })
      scenario = { ...original, method, contract, composition }
      const verifier = (task: TaskContract): RunVerifier => ({ provider: task.acceptance,
        async verify(request) {
          const output = request.outputs[0]
          assert.ok(output)
          assert.equal(new TextDecoder().decode((await request.readObject(output, 'object')).bytes), FROZEN_OUTPUT)
          if (task.taskId === taskId) assert.equal(request.inputs.length, 3, 'root verifier receives its source and both verified required winners')
          return sealPublicReceipt({ v: 1, provider: task.acceptance, operationId: request.operationId, contractDigest: task.digest,
            inputDigests: request.inputs.map(ref => ref.digest), outputDigests: request.outputs.map(ref => ref.digest),
            criteria: task.spec.criteria.filter(value => value.required).map(value => ({ id: value.id, verdict: 'pass', reason: 'Exact declared bytes.' })),
            exit: { code: 0, signal: null }, timedOut: false })
        } })
      spike.ctx.on('agent/pre-step', async ({ agent }, next) => {
        const bad = children.values().next().value
        if (bad !== undefined && String(agent.session.id) === bad.sessionId) await siblingStarted.promise
        return next()
      })
      const result = await executeTaskTree({ ctx: spike.ctx, journalRoot: storeRoot, workspace, runId, sessionId: `${runId}:session`,
        admission: { ...original.runAdmission, contract, budgetReservation: { tokens: 10_000, steps: 40, deadlineAt: contract.limits.deadlineAt } },
        composition, agentOptions: agentOptions(), maxOutputBytes: 1024, verifier: verifier(contract), actor,
        maxActive: 2, workspaceRoot: join(workspace, 'runs'),
        async resolveRun(input) {
          children.set(input.contract.taskId, { contract: input.contract, runId: input.runId, sessionId: input.sessionId })
          return { composition: await buildSingleRunComposition(spike.ctx, { store: service, id: input.runId, contract: input.contract,
            agentOptions: agentOptions(), base: { v: 1, seed: input.contract.environment.seed } }), agentOptions: agentOptions(),
            maxOutputBytes: 1024, verifier: verifier(input.contract) }
        },
      }, service)
      assert.equal(result.root.classification, 'verified', result.root.executionRecord?.reason)
      assert.equal(fixture.requests.length, 25)
      assert.equal(children.size, 3)
      const [bad, sibling, replacement] = [...children.values()]
      const badResult = result.runs.find(run => run.taskId === bad.contract.taskId)
      assert.ok(badResult)
      assert.equal(badResult.classification, 'failed')
      assert.equal(bad.contract.limits.maxTokens, 4750)
      assert.equal(badResult.usage.inputTokens + badResult.usage.outputTokens, 4751)
      assert.equal(result.runs.find(run => run.taskId === sibling.contract.taskId)?.classification, 'verified')
      assert.equal(result.runs.find(run => run.taskId === replacement.contract.taskId)?.classification, 'verified')
      assert.equal(service.facts().filter(row => row.type === 'task/closed' && row.data.scope === 'subtree').length, 0)
      const state = await service.taskRunState([])
      assert.equal(state.tasks.get(bad.contract.taskId)?.closed?.outcome, 'failed')
      assert.equal(state.tasks.get(bad.contract.taskId)?.supersededBy, replacement.contract.taskId)
      assert.equal(state.tasks.get(sibling.contract.taskId)?.closed?.outcome, 'verified')
      assert.equal(state.tasks.get(taskId)?.closed?.outcome, 'verified')
      assert.ok(result.runs.every(run => run.usage.unknownRequests === 0))
    } finally { await service.close() }
    const replay = await CommandService.open({ root: storeRoot, actor, clock: Date.now })
    try {
      const state = await replay.taskRunState([])
      assert.equal(state.tasks.get(taskId)?.closed?.outcome, 'verified')
      assert.equal([...state.tasks.values()].filter(task => task.closed?.outcome === 'verified').length, 3)
    } finally { await replay.close() }
  })
})
