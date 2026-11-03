import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { parseJsonText, refSchema, sealMethodRevision, sealPublicReceipt, sealTaskContract } from '@singularity/protocol'
import type { TaskContract } from '@singularity/protocol'
import { CommandService, executeTaskTree } from '@singularity/runtime'
import type { RunVerifier } from '@singularity/runtime'

import { buildSingleRunComposition } from '../src/host-composition.ts'
import { contextEpochFrom, messageTexts } from './fixtures/chat-completions.ts'
import { s4b2Example } from './method-fixture.ts'
import { contractPayload, methodPayload, planReply, recordSessionEvents, withHarness } from './run-fixture.ts'
import { agentOptions, FROZEN_OUTPUT, jsonBytes, makeScenario } from './task-fixture.ts'
import type { Scenario, ScriptedReply, WireRequest } from './task-fixture.ts'

function preview(request: WireRequest, bindingId: string): string {
  for (const text of messageTexts(request).reverse()) {
    let value: unknown
    try { value = parseJsonText(text) } catch { continue }
    if (typeof value !== 'object' || value === null || !('bindingId' in value) || value.bindingId !== bindingId || !('previewRef' in value)) continue
    const parsed = refSchema.safeParse(value.previewRef)
    if (parsed.success) return parsed.data.digest
  }
  throw new Error(`Missing delivered preview for ${bindingId}`)
}

void test('maxActive=2 child retry counts its own descendants, excludes an expensive sibling, and wakes parent only after retry terminal', { timeout: 240_000 }, async () => {
  const taskId = `child-retry-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}:run`, sessionId = `${runId}:session`
  const tasks = new Map<string, TaskContract>()
  const steps = new Map<string, number>()
  let scenario: Scenario | undefined
  let retryChild: TaskContract | undefined
  let expensiveSibling: TaskContract | undefined
  let retryObserved = false
  let secondBatchWakeObserved = false
  const usage = { promptTokens: 9, completionTokens: 1, totalTokens: 10 }
  await withHarness((request, index) => {
    assert.ok(scenario)
    const currentScenario = scenario
    const identity = messageTexts(request).map(text => /"task":\{"id":"([^"]+)"(?:,"parentId":"[^"]+")?,"runId":"([^"]+)"/.exec(text)).find(value => value !== null)
    assert.ok(identity, 'every fixture request has its actual live NodeView')
    const currentTaskId = identity[1], currentRunId = identity[2]
    const contract = tasks.get(currentTaskId)
    assert.ok(contract)
    const step = steps.get(currentRunId) ?? 0
    steps.set(currentRunId, step + 1)
    const call = (name: string, args: unknown): ScriptedReply => ({ toolCalls: [{ id: `retry-${String(index)}`, name, arguments: JSON.stringify(args) }], usage })
    const self = () => call('singularity_read', { kind: 'self' })
    const plan = (): ScriptedReply => {
      const reply = planReply({ ...currentScenario, contract }, currentTaskId, currentRunId,
        contextEpochFrom({ ...request, messages: [...(request.messages ?? [])].reverse() }) ?? '')
      return { ...reply, usage, toolCalls: reply.toolCalls?.map(tool => ({ ...tool, id: `retry-plan-${String(index)}` })) }
    }
    const prepare = (bindingId: string) => call('singularity_decompose', { action: 'prepare', bindingId })
    const commit = (bindingIds: readonly string[]) => call('singularity_decompose', { action: 'commit', children: bindingIds.map(bindingId => ({
      bindingId, ackPreview: preview(request, bindingId), task: {
        goal: { summary: 'Produce exact fixture bytes in child.txt.', deliverable: 'child.txt', scope: [], constraints: [] },
        acceptanceCriteria: [{ id: 'exact-child', statement: 'Produce the declared child result.', check: 'test -s child.txt' }], inputs: [], localOutputs: [{ id: 'child-note', path: 'child.txt', kind: 'file', description: 'Direct frozen result.' }],
      },
    })) })
    if (currentTaskId === taskId) {
      if (step === 0 || step === 4 || step === 9) {
        if (step === 9) {
          assert.equal(retryObserved, true)
          secondBatchWakeObserved = true
        }
        return self()
      }
      if (step === 1 || step === 5 || step === 10) return plan()
      if (step === 2) return prepare('expensive')
      if (step === 3) return commit(['expensive'])
      if (step === 6) return prepare('required-work')
      if (step === 7) return prepare('parallel-work')
      if (step === 8) return commit(['required-work', 'parallel-work'])
      if (step === 11) return call('singularity_read', { kind: 'children' })
      if (step === 12) {
        assert.ok(retryChild)
        return call('bash', { command: `cat 'children/${encodeURIComponent(retryChild.taskId)}/child-note' > result.txt` })
      }
      if (step === 13) return call('singularity_submit', { outputIds: ['result'], includeLearningDrafts: false })
    } else if (contract.origin.kind === 'child' && contract.origin.bindingId === 'required-work' && currentRunId.endsWith(':run:1')) {
      if (step === 0 || step === 4) return self()
      if (step === 1 || step === 5) return plan()
      if (step === 2) return prepare('grandchild')
      if (step === 3) return commit(['grandchild'])
      if (step === 6) return call('singularity_stop', { reason: 'unsolved', message: 'One fresh retry must integrate this local result.' })
    } else {
      if (currentRunId.endsWith(':run:2')) {
        assert.equal(secondBatchWakeObserved, false, 'parent cannot resume before the retry is terminal')
        retryObserved = true
      }
      if (step === 0) return { ...self(), ...(contract.origin.kind === 'child' && contract.origin.bindingId === 'expensive'
        ? { usage: { promptTokens: 5999, completionTokens: 1, totalTokens: 6000 } } : {}) }
      if (step === 1) return plan()
      if (step === 2) return call('bash', { command: `printf %s '${FROZEN_OUTPUT}' > child.txt` })
      if (step === 3) return call('singularity_submit', { outputIds: ['child-note'], includeLearningDrafts: false })
    }
    throw new Error(`Unexpected fixture step ${currentRunId}:${String(step)}`)
  }, async ({ spike, workspace, storeRoot, fixture }) => {
    const original = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 2, maxStepsPerRun: 60, maxDepth: 2, maxTasks: 5, maxBatchChildren: 2,
      childBinding: { bindingId: 'expensive', templateId: 'retry-leaf', brief: 'Produce an independent public result.', join: 'probe', example: s4b2Example() } })
    const actor = { kind: 'runtime', id: 'child-retry-fixture' } as const
    const service = await CommandService.open({ root: storeRoot, actor, clock: Date.now })
    const events = recordSessionEvents(spike, sessionId)
    let active = 0, peak = 0
    const create = spike.ctx.agents.create.bind(spike.ctx.agents), resume = spike.ctx.agents.resume.bind(spike.ctx.agents)
    const count = (handle: Awaited<ReturnType<typeof create>>) => {
      active += 1; peak = Math.max(peak, active)
      const dispose = handle.dispose.bind(handle)
      return { ...handle, async dispose() { await dispose(); active -= 1 } }
    }
    spike.ctx.agents.create = async options => count(await create(options))
    spike.ctx.agents.resume = async options => count(await resume(options))
    try {
      const leaf = original.method.templates.find(template => template.id === 'retry-leaf')
      assert.ok(leaf)
      const method = sealMethodRevision({ ...methodPayload(original.method), id: 'method:child-retry', templates: [
        { ...original.method.templates[0], children: [
          { bindingId: 'expensive', templateId: leaf.id, brief: 'Produce an independent public result.', join: 'probe' },
          { bindingId: 'required-work', templateId: 'retry-parent', brief: 'Produce the required direct result.', join: 'required' },
          { bindingId: 'parallel-work', templateId: leaf.id, brief: 'Produce a parallel supporting result.', join: 'probe' },
        ] }, leaf,
        { ...leaf, id: 'retry-parent', children: [{ bindingId: 'grandchild', templateId: leaf.id, brief: 'Inspect one local subproblem.', join: 'probe' }],
          requiredCriteria: [{ id: 'exact-child-bytes', statement: 'Produce the exact fixture bytes.', required: true }] },
      ] })
      const methodRef = await service.putObject(method.id, jsonBytes(method), 'method')
      const contract = sealTaskContract({ ...contractPayload(original.contract), method: methodRef,
        template: { id: original.contract.template.id, digest: method.digest }, limits: { ...original.contract.limits, maxTokens: 10_000 } })
      const composition = await buildSingleRunComposition(spike.ctx, { store: service, id: runId, contract,
        agentOptions: agentOptions(), base: { v: 1, seed: contract.environment.seed } })
      scenario = { ...original, method, contract, composition }
      tasks.set(taskId, contract)
      const verifier = (task: TaskContract): RunVerifier => ({ provider: task.acceptance, async verify(request) {
        const output = request.outputs[0]
        assert.ok(output)
        assert.equal(new TextDecoder().decode((await request.readObject(output, 'object')).bytes), FROZEN_OUTPUT)
        return sealPublicReceipt({ v: 1, provider: task.acceptance, operationId: request.operationId, contractDigest: task.digest,
          inputDigests: request.inputs.map(ref => ref.digest), outputDigests: request.outputs.map(ref => ref.digest),
          criteria: task.spec.criteria.filter(value => value.required).map(value => ({ id: value.id, verdict: 'pass', reason: 'Exact frozen bytes.' })),
          exit: { code: 0, signal: null }, timedOut: false })
      } })
      const result = await executeTaskTree({ ctx: spike.ctx, journalRoot: storeRoot, workspace, runId, sessionId,
        admission: { ...original.runAdmission, contract, budgetReservation: { tokens: 10_000, steps: 60, deadlineAt: contract.limits.deadlineAt } },
        composition, agentOptions: agentOptions(), verifier: verifier(contract), maxOutputBytes: 1024,
        maxActive: 2, workspaceRoot: join(workspace, 'runs'), actor,
        async resolveRun(input) {
          tasks.set(input.contract.taskId, input.contract)
          if (input.contract.origin.kind === 'child') {
            if (input.contract.origin.bindingId === 'required-work') retryChild = input.contract
            if (input.contract.origin.bindingId === 'expensive') expensiveSibling = input.contract
          }
          return { composition: await buildSingleRunComposition(spike.ctx, { store: service, id: input.runId, contract: input.contract,
            agentOptions: agentOptions(), base: { v: 1, seed: input.contract.environment.seed } }),
            agentOptions: agentOptions(), verifier: verifier(input.contract), maxOutputBytes: 1024 }
        },
      }, service)
      assert.equal(result.root.classification, 'verified', result.root.executionRecord?.reason)
      assert.ok(retryChild)
      const retried = retryChild
      assert.ok(expensiveSibling)
      const state = await service.taskRunState([])
      const retryTask = state.tasks.get(retryChild.taskId)
      assert.deepEqual(retryTask?.runIds, [`${retryChild.taskId}:run:1`, `${retryChild.taskId}:run:2`])
      assert.equal(retryTask.closed?.outcome, 'verified')
      const first = state.runs.get(`${retryChild.taskId}:run:1`), second = state.runs.get(`${retryChild.taskId}:run:2`)
      assert.equal(first?.closed?.classification, 'failed')
      assert.equal(second?.closed?.classification, 'verified')
      assert.equal(retryChild.limits.maxRuns, contract.limits.maxRuns)
      const siblingUsage = state.runs.get(`${expensiveSibling.taskId}:run:1`)?.closed?.usage
      assert.ok(siblingUsage)
      assert.ok(siblingUsage.inputTokens + siblingUsage.outputTokens > retryChild.limits.maxTokens, 'unrelated closed sibling exceeds this child cap')
      const firstUsage = first.closed.usage
      const grandchild = [...tasks.values()].find(task => task.origin.kind === 'child' && task.origin.parentId === retried.taskId)
      assert.ok(firstUsage)
      assert.ok(grandchild)
      const grandchildUsage = state.runs.get(`${grandchild.taskId}:run:1`)?.closed?.usage
      assert.ok(grandchildUsage)
      assert.equal(second.opened.budgetReservation.tokens, retryChild.limits.maxTokens
        - firstUsage.inputTokens - firstUsage.outputTokens - grandchildUsage.inputTokens - grandchildUsage.outputTokens)
      const firstResult = result.runs.find(run => run.runId === first.runId)
      assert.equal(firstResult?.retry.allowed, true)
      assert.equal(firstResult.taskFact, undefined)
      assert.equal(peak, 2)
      assert.equal(active, 0)
      assert.deepEqual([...steps.values()].sort((left, right) => left - right), [4, 4, 4, 4, 7, 14], JSON.stringify(result.runs.map(run => ({ task: run.taskId, classification: run.classification, reason: run.executionRecord?.reason }))))
      assert.equal(fixture.requests.length, 37)
      const parentWakes = events.events.filter(event => event.type === 'user/message' && String(event.data.id).endsWith(':terminal'))
      assert.equal(parentWakes.length, 2, 'one root wake per batch, with no extra wake at failed child Run closure')
      const retryClosure = service.facts().findIndex(fact => fact.type === 'task/closed' && fact.data.taskId === retried.taskId)
      const rootSubmission = service.facts().findIndex(fact => fact.type === 'run/submitted' && fact.data.runId === runId)
      assert.ok(retryClosure >= 0 && retryClosure < rootSubmission)
    } finally {
      events.dispose(); spike.ctx.agents.create = create; spike.ctx.agents.resume = resume
      await service.close()
    }
    const replay = await CommandService.open({ root: storeRoot, actor, clock: Date.now })
    try {
      const state = await replay.taskRunState([])
      assert.equal(state.tasks.get(taskId)?.closed?.outcome, 'verified')
      assert.equal(state.tasks.get(retryChild.taskId)?.closed?.outcome, 'verified')
    } finally { await replay.close() }
  })
})
