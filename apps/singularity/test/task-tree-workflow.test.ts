import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { parseProtocolValue, inputRefSchema, sealMethodRevision, sealPublicReceipt, sealTaskContract } from '@singularity/protocol'
import type { InputRef, TaskContract } from '@singularity/protocol'
import { CommandService, executeTaskTree } from '@singularity/runtime'
import type { RunVerifier } from '@singularity/runtime'

import { buildSingleRunComposition } from '../src/host-composition.ts'
import { contextEpochFrom, messageTexts } from './fixtures/chat-completions.ts'
import { previewDigestFrom, s4b2Example } from './method-fixture.ts'
import { contractPayload, methodPayload, planReply, submitReply, withHarness } from './run-fixture.ts'
import { agentOptions, fixtureUsage, FROZEN_OUTPUT, jsonBytes, makeScenario } from './task-fixture.ts'
import type { Scenario, ScriptedReply, WireRequest } from './task-fixture.ts'

function call(index: number, name: string, args: unknown): ScriptedReply {
  return { toolCalls: [{ id: `workflow-${String(index)}`, name, arguments: JSON.stringify(args) }], usage: fixtureUsage(index) }
}

function plan(request: WireRequest, index: number, scenario: Scenario, contract: TaskContract, runId: string): ScriptedReply {
  const reply = planReply({ ...scenario, contract }, contract.taskId, runId,
    contextEpochFrom({ ...request, messages: [...(request.messages ?? [])].reverse() }) ?? '')
  return { ...reply, toolCalls: reply.toolCalls?.map(tool => ({ ...tool, id: `workflow-plan-${String(index)}` })) }
}

function commit(request: WireRequest, index: number, bindingId: string, inputs: readonly InputRef[] = []): ScriptedReply {
  return call(index, 'singularity_decompose', { action: 'commit', children: [{
    bindingId, ackPreview: previewDigestFrom({ ...request, messages: [...(request.messages ?? [])].reverse() }),
    task: { goal: { summary: 'Produce exact fixture bytes in child.txt.', deliverable: 'child.txt', scope: [], constraints: [] },
      localCriteria: [], inputs,
      localOutputs: [{ id: 'child-note', path: 'child.txt', kind: 'file', description: 'Direct frozen output.' }],
    },
  }] })
}

function outputInput(request: WireRequest): InputRef {
  for (const text of messageTexts(request)) {
    let value: unknown
    try { value = JSON.parse(text) } catch { continue }
    if (typeof value !== 'object' || value === null || !('data' in value) || !Array.isArray(value.data)) continue
    for (const row of value.data as unknown[]) {
      if (typeof row !== 'object' || row === null || !('outputs' in row) || !Array.isArray(row.outputs)) continue
      for (const output of row.outputs as unknown[]) {
        if (typeof output !== 'object' || output === null || !('id' in output) || !('object' in output) || !('path' in output)) continue
        return parseProtocolValue(inputRefSchema, { id: output.id, object: output.object, path: output.path, access: 'read' })
      }
    }
  }
  throw new Error('Fixture model did not receive a direct frozen output')
}

void test('S4 required child failure returns scheduler feedback, enforces replan, admits replacement and joins its verified winner', { timeout: 240_000 }, async () => {
  const taskId = `task-replacement-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}:run`
  let scenario: Scenario | undefined
  let child: TaskContract | undefined
  let childRunId = ''
  const children: TaskContract[] = []
  await withHarness((request, index) => {
    assert.ok(scenario)
    if ([0, 4, 8, 14, 18].includes(index)) return call(index, 'singularity_read', { kind: 'self' })
    if ([1, 5, 11, 15, 19].includes(index)) {
      const current = index === 5 || index === 15 ? child : scenario.contract
      assert.ok(current)
      return plan(request, index, scenario, current, index === 5 || index === 15 ? childRunId : runId)
    }
    if (index === 2 || index === 12) return call(index, 'singularity_decompose', { action: 'prepare', bindingId: 'required-work' })
    if (index === 3 || index === 13) return commit(request, index, 'required-work')
    if (index === 6) return call(index, 'bash', { command: 'printf wrong > child.txt' })
    if (index === 7 || index === 17) return call(index, 'singularity_submit', { outputIds: ['child-note'], includeLearningDrafts: false })
    if (index === 9) return submitReply()
    if (index === 10) {
      assert.ok(messageTexts(request).some(text => text.includes('REQUIRED_FEEDBACK_REPLAN')))
      return call(index, 'singularity_read', { kind: 'feedback' })
    }
    if (index === 16) return call(index, 'bash', { command: `printf %s '${FROZEN_OUTPUT}' > child.txt` })
    if (index === 20) return call(index, 'singularity_read', { kind: 'children' })
    if (index === 21) {
      assert.equal(children.length, 2)
      return call(index, 'bash', { command: `cat 'children/${encodeURIComponent(children[1].taskId)}/child-note' > result.txt` })
    }
    if (index === 22) return submitReply()
    throw new Error(`Unexpected replacement fixture request ${String(index)}`)
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    const original = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, maxStepsPerRun: 40, maxDepth: 1, maxTasks: 3,
      childBinding: { bindingId: 'required-work', templateId: 'template:child', brief: 'Produce the required direct result.', join: 'required', example: s4b2Example() } })
    const actor = { kind: 'runtime', id: 'singularity-runtime' } as const
    const service = await CommandService.open({ root: storeRoot, actor, clock: Date.now })
    try {
      const method = sealMethodRevision({ ...methodPayload(original.method), id: 'method:replacement-fixture',
        templates: original.method.templates.map(template => template.id === 'template:child'
          ? { ...template, requiredCriteria: [{ id: 'exact-child-bytes', statement: 'Produce the exact declared bytes.', required: true }] }
          : template) })
      const methodRef = await service.putObject(method.id, jsonBytes(method), 'method')
      const contract = sealTaskContract({ ...contractPayload(original.contract), method: methodRef, template: { id: original.contract.template.id, digest: method.digest } })
      const composition = await buildSingleRunComposition(spike.ctx, { store: service, id: runId, contract, agentOptions: agentOptions(), base: { v: 1, seed: contract.environment.seed } })
      scenario = { ...original, method, contract, composition }
      const verifier = (task: TaskContract): RunVerifier => ({
        provider: task.acceptance,
        async verify(request) {
          const output = request.outputs[0]
          assert.ok(output)
          const exact = new TextDecoder().decode((await request.readObject(output, 'object')).bytes) === FROZEN_OUTPUT
          return sealPublicReceipt({ v: 1, provider: task.acceptance, operationId: request.operationId, contractDigest: task.digest,
            inputDigests: request.inputs.map(ref => ref.digest), outputDigests: request.outputs.map(ref => ref.digest),
            criteria: task.spec.criteria.filter(criterion => criterion.required).map(criterion => ({ id: criterion.id, verdict: exact ? 'pass' : 'fail', reason: exact ? 'Exact bytes.' : 'Fixture bytes differ.' })),
            exit: { code: 0, signal: null }, timedOut: false })
        },
      })
      const result = await executeTaskTree({
        ctx: spike.ctx, journalRoot: storeRoot, workspace, runId, sessionId: `${runId}:session`,
        admission: { ...original.runAdmission, contract, budgetReservation: { ...original.runAdmission.budgetReservation, steps: 40 } },
        composition, agentOptions: agentOptions(), verifier: verifier(contract), maxOutputBytes: 1024,
        maxActive: 1, workspaceRoot: join(workspace, 'runs'),
        async resolveRun(input) {
          child = input.contract
          childRunId = input.runId
          children.push(child)
          return { composition: await buildSingleRunComposition(spike.ctx, { store: service, id: input.runId, contract: child, agentOptions: agentOptions(), base: { v: 1, seed: child.environment.seed } }), agentOptions: agentOptions(), verifier: verifier(child), maxOutputBytes: 1024 }
        },
      }, service)
      assert.equal(result.root.classification, 'verified', result.root.executionRecord?.reason)
      assert.equal(fixture.requests.length, 23)
      assert.deepEqual(result.runs.map(run => run.classification), ['failed', 'verified', 'verified'])
      const state = await service.taskRunState([])
      assert.equal(state.tasks.get(children[0].taskId)?.supersededBy, children[1].taskId)
      assert.equal(state.tasks.get(children[1].taskId)?.closed?.outcome, 'verified')
      const batches = service.facts().filter(fact => fact.type === 'task/children-admitted')
      assert.equal(batches.length, 2)
      assert.deepEqual(batches[1]?.data.children[0]?.replacement?.supersedesChildIds, [children[0].taskId])
      assert.ok(batches[1]?.data.children[0]?.replacement?.feedbackRef)
    } finally { await service.close() }
  })
})

for (const mode of ['required', 'probe', 'failed-probe'] as const) {
  void test(`S4 ${mode} subsequent batch receives frozen output and integrates without reusing a winner or fabricating replacement`, { timeout: 240_000 }, async () => {
    const secondBinding = mode === 'required' ? 'second' : 'first'
    const taskId = `task-batches-${String(process.pid)}-${String(Date.now())}`
    const runId = `${taskId}:run`
    let scenario: Scenario | undefined
    let child: TaskContract | undefined
    let childRunId = ''
    let firstOutput: InputRef | undefined
    const children: TaskContract[] = []
    await withHarness((request, index) => {
      assert.ok(scenario)
      if ([0, 4, 8, 13, 18].includes(index)) return call(index, 'singularity_read', { kind: 'self' })
      if ([1, 5, 9, 14, 19].includes(index)) {
        const current = index === 5 || index === 14 ? child : scenario.contract
        assert.ok(current)
        return plan(request, index, scenario, current, index === 5 || index === 14 ? childRunId : runId)
      }
      if (index === 2 || index === 11) return call(index, 'singularity_decompose', { action: 'prepare', bindingId: index === 2 ? 'first' : secondBinding })
      if (index === 3) return commit(request, index, 'first')
      if (index === 6 || index === 16) return call(index, 'bash', { command: `printf %s '${FROZEN_OUTPUT}' > child.txt` })
      if (index === 7 || index === 17) return call(index, 'singularity_submit', { outputIds: ['child-note'], includeLearningDrafts: false })
      if (index === 10 || index === 20) return call(index, 'singularity_read', { kind: 'children' })
      if (index === 12) {
        firstOutput = outputInput(request)
        return commit(request, index, secondBinding, [firstOutput])
      }
      if (index === 15) {
        assert.ok(firstOutput)
        return call(index, 'singularity_read', { kind: 'resource', id: firstOutput.id })
      }
      if (index === 21) return call(index, 'bash', { command: `cat 'children/${encodeURIComponent(children[1].taskId)}/child-note' > result.txt` })
      if (index === 22) return submitReply()
      throw new Error(`Unexpected multi-batch fixture request ${String(index)}`)
    }, async ({ spike, fixture, workspace, storeRoot }) => {
      const original = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, maxStepsPerRun: 40, maxDepth: 1, maxTasks: 3,
        childBinding: { bindingId: 'first', templateId: 'template:child', brief: 'Produce the first direct result.', join: mode === 'required' ? 'required' : 'probe', example: s4b2Example() } })
      const actor = { kind: 'runtime', id: 'singularity-runtime' } as const
      const service = await CommandService.open({ root: storeRoot, actor, clock: Date.now })
      try {
        const method = sealMethodRevision({ ...methodPayload(original.method), id: 'method:batches-fixture',
          templates: original.method.templates.map(template => template.id === original.contract.template.id
            ? { ...template, children: mode === 'required' ? [...template.children, { bindingId: 'second', templateId: 'template:child', brief: 'Consume the frozen first result.', join: 'required' }] : template.children }
            : { ...template, requiredCriteria: [{ id: 'exact-child-bytes', statement: 'Produce the declared bytes.', required: true }] }) })
        const methodRef = await service.putObject(method.id, jsonBytes(method), 'method')
        const contract = sealTaskContract({ ...contractPayload(original.contract), method: methodRef, template: { id: original.contract.template.id, digest: method.digest } })
        const composition = await buildSingleRunComposition(spike.ctx, { store: service, id: runId, contract, agentOptions: agentOptions(), base: { v: 1, seed: contract.environment.seed } })
        scenario = { ...original, method, contract, composition }
        const verifier = (task: TaskContract): RunVerifier => ({ provider: task.acceptance, async verify(request) {
          const output = request.outputs[0]
          assert.ok(output)
          assert.equal(new TextDecoder().decode((await request.readObject(output, 'object')).bytes), FROZEN_OUTPUT)
          if (task.origin.kind === 'child' && task.taskId === children.at(1)?.taskId) {
            assert.ok(firstOutput)
            assert.deepEqual(request.inputs, [firstOutput.object])
          }
          return sealPublicReceipt({ v: 1, provider: task.acceptance, operationId: request.operationId, contractDigest: task.digest,
            inputDigests: request.inputs.map(ref => ref.digest), outputDigests: request.outputs.map(ref => ref.digest),
            criteria: task.spec.criteria.filter(criterion => criterion.required).map(criterion => ({ id: criterion.id, verdict: mode === 'failed-probe' && task.taskId === children.at(0)?.taskId ? 'fail' : 'pass', reason: 'Fixture criterion result.' })),
            exit: { code: 0, signal: null }, timedOut: false })
        } })
        const result = await executeTaskTree({ ctx: spike.ctx, journalRoot: storeRoot, workspace, runId, sessionId: `${runId}:session`,
          admission: { ...original.runAdmission, contract, budgetReservation: { ...original.runAdmission.budgetReservation, steps: 40 } },
          composition, agentOptions: agentOptions(), verifier: verifier(contract), maxOutputBytes: 1024, maxActive: 1, workspaceRoot: join(workspace, 'runs'),
          async resolveRun(input) {
            child = input.contract
            childRunId = input.runId
            children.push(child)
            return { composition: await buildSingleRunComposition(spike.ctx, { store: service, id: input.runId, contract: child, agentOptions: agentOptions(), base: { v: 1, seed: child.environment.seed } }), agentOptions: agentOptions(), verifier: verifier(child), maxOutputBytes: 1024 }
          },
        }, service)
        assert.equal(result.root.classification, 'verified', result.root.executionRecord?.reason)
        assert.equal(fixture.requests.length, 23)
        assert.ok(firstOutput)
        assert.deepEqual(children[1].spec.inputs, [firstOutput])
        assert.equal(result.runs.length, 3)
        const batches = service.facts().filter(fact => fact.type === 'task/children-admitted')
        assert.equal(batches.length, 2)
        assert.equal(batches[1]?.data.children[0]?.replacement, undefined)
        assert.equal(result.runs[0]?.classification, mode === 'failed-probe' ? 'failed' : 'verified')
        assert.ok(result.runs[0]?.evidence?.outputs.some(output => output.digest === firstOutput?.object.digest))
      } finally { await service.close() }
    })
  })
}
