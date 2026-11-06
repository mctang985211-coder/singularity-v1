import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { parseProtocolValue, inputRefSchema, sealMethodRevision, sealPublicReceipt, sealTaskContract } from '@singularity/protocol'
import type { InputRef, Ref, TaskContract } from '@singularity/protocol'
import { CommandService, executeTaskTree, verifyRunSubmission } from '@singularity/runtime'
import type { RunVerifier } from '@singularity/runtime'

import { buildSingleRunComposition } from '../src/host-composition.ts'
import { contextEpochFrom, messageTexts } from './fixtures/chat-completions.ts'
import { previewDigestFrom, s4b2Example } from './method-fixture.ts'
import { contractPayload, methodPayload, planReply, submitReply, withHarness } from './run-fixture.ts'
import { agentOptions, fixtureUsage, FROZEN_OUTPUT, jsonBytes, makeScenario, OUTPUT_PATH } from './task-fixture.ts'
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
      acceptanceCriteria: [{ id: 'child-result', statement: 'The declared result contains the completed work.', check: `test "$(cat child.txt)" = '${FROZEN_OUTPUT}'` }], inputs,
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

void test('frozen checks consume CAS inputs and outputs, preserve review failures and await native cancellation', async () => {
  await withHarness(() => { throw new Error('Checks must not request a model') }, async ({ spike, storeRoot }) => {
    const scenario = await makeScenario(storeRoot, spike.ctx, { taskId: 'frozen-command', maxRuns: 1 })
    const service = await CommandService.open({ root: storeRoot, actor: { kind: 'runtime', id: 'check-fixture' }, clock: Date.now })
    try {
      const output = await service.putObject('check-run:output:result', new TextEncoder().encode(FROZEN_OUTPUT))
      const input = await service.putObject('binary', new Uint8Array([0, 255, 7]))
      const check = `python3 - <<'PY'\nfrom pathlib import Path\nassert Path('seed.bin').read_bytes() == bytes([0,255,7])\nassert not Path('worker-checkout').exists()\nassert Path('result.txt').read_text() == '${FROZEN_OUTPUT}'\nPY`
      for (const [command, review, expected] of [[check, 'pass', 'verified'], ['false | true', 'pass', 'failed'], [check, 'fail', 'failed'], ['sleep 30 & wait', 'pass', 'invalid']] as const) {
        const contract = sealTaskContract({ ...contractPayload(scenario.contract), spec: { ...scenario.contract.spec,
          inputs: [{ id: 'binary', object: input, path: 'seed.bin', access: 'read' }],
          criteria: [{ id: 'check', statement: 'Match frozen input/output bytes.', required: true, check: command }] },
          limits: { ...scenario.contract.limits, deadlineAt: Date.now() + (expected === 'invalid' ? 100 : 10_000) } })
        const result = await verifyRunSubmission({ shell: spike.ctx.shell, contract, runId: 'check-run', inputs: [input], outputs: [output], reader: service, writer: service,
          verifier: { provider: contract.acceptance, verify: request => Promise.resolve(sealPublicReceipt({ v: 1, provider: contract.acceptance,
            operationId: request.operationId, contractDigest: contract.digest, inputDigests: [input.digest], outputDigests: [output.digest],
            criteria: [{ id: 'check', verdict: review, reason: 'Independent domain finding.' }], exit: { code: 0, signal: null }, timedOut: false })) } })
        assert.equal(result.verdict, expected)
        if (result.verdict !== 'invalid') assert.match(result.receipt.criteria[0].reason, /Frozen check:/)
      }
    } finally { await service.close() }
  })
})

void test('check-only acceptance uses native CAS checks without a domain reviewer', async () => {
  await withHarness(() => { throw new Error('check-only acceptance must not request a model') }, async ({ spike, storeRoot }) => {
    const scenario = await makeScenario(storeRoot, spike.ctx, { taskId: 'check-only-verifier', maxRuns: 1 })
    const service = await CommandService.open({ root: storeRoot, actor: { kind: 'runtime', id: 'check-only-fixture' }, clock: Date.now })
    try {
      const output = await service.putObject('check-only:output:result', new TextEncoder().encode(FROZEN_OUTPUT))
      for (const [command, expected] of [[`test "$(cat ${OUTPUT_PATH})" = '${FROZEN_OUTPUT}'`, 'verified'], ['false', 'failed']] as const) {
        const contract = sealTaskContract({ ...contractPayload(scenario.contract), spec: { ...scenario.contract.spec,
          criteria: [{ id: 'check', statement: 'The frozen output has the exact bytes.', required: true, check: command }] } })
        const result = await verifyRunSubmission({ shell: spike.ctx.shell, contract, runId: `check-only-${expected}`,
          inputs: contract.spec.inputs.map(input => input.object), outputs: [output], reader: service, writer: service,
          verifier: { provider: contract.acceptance, checksOnly: true } })
        assert.equal(result.verdict, expected)
        assert.match(result.receipt.criteria[0].reason, /Frozen check:/)
      }
      const partial = sealTaskContract({ ...contractPayload(scenario.contract), spec: { ...scenario.contract.spec,
        criteria: [{ id: 'check', statement: 'Checked.', required: true, check: 'true' }, { id: 'semantic', statement: 'Not checked.', required: true }] } })
      await assert.rejects(verifyRunSubmission({ shell: spike.ctx.shell, contract: partial, runId: 'check-only-partial',
        inputs: partial.spec.inputs.map(input => input.object), outputs: [output], reader: service, writer: service,
        verifier: { provider: partial.acceptance, checksOnly: true } }), { code: 'COMPOSITION_MISMATCH' })
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

for (const correction of [false, true]) {
  void test(`maxActive=1 dispatcher dialogue ${correction ? 'returns a wrong contract without a third retry and replaces it' : 'clarifies and resumes the same Run'}`, { timeout: 240_000 }, async () => {
    const taskId = `dialogue-${String(correction)}-${String(Date.now())}`, runId = `${taskId}:run`
    const tasks = new Map<string, TaskContract>(), steps = new Map<string, number>(), children: TaskContract[] = []
    let scenario: Scenario | undefined, questionId = '', preservedOutput: InputRef | undefined, frozenRef: Ref | undefined
    await withHarness((request, index) => {
      assert.ok(scenario)
      const identity = messageTexts(request).map(text => /"task":\{"id":"([^"]+)"(?:,"parentId":"[^"]+")?,"runId":"([^"]+)"/.exec(text)).find(Boolean)
      assert.ok(identity)
      const current = tasks.get(identity[1]); assert.ok(current)
      const currentRun = identity[2], step = steps.get(currentRun) ?? 0
      steps.set(currentRun, step + 1)
      const self = () => call(index, 'singularity_read', { kind: 'self' })
      const planning = () => plan(request, index, scenario as Scenario, current, currentRun)
      if (current.taskId === taskId) {
        if (correction && step === 8) return submitReply()
        if (correction && step === 9) { assert.match(messageTexts(request).join('\n'), /REQUIRED_FEEDBACK_REPLAN/); return call(index, 'singularity_read', { kind: 'feedback' }) }
        const stage = correction && step >= 10 ? step - 2 : step
        if ([0, 4, 7, 12].includes(stage)) return self()
        if ([1, 8, 13].includes(stage)) return planning()
        if (stage === 2 || (correction && stage === 10)) return call(index, 'singularity_decompose', { action: 'prepare', bindingId: 'required-work' })
        if (stage === 3) {
          const reply = commit(request, index, 'required-work')
          if (correction) {
            const args = JSON.parse(reply.toolCalls?.[0].arguments ?? '') as { children: { task: { acceptanceCriteria: { check: string }[] } }[] }
            args.children[0].task.acceptanceCriteria[0].check = 'test -d worker-checkout'
            return call(index, 'singularity_decompose', args)
          }
          return reply
        }
        if (stage === 5) {
          const text = messageTexts(request).findLast(text => text.includes('reason=feedback;'))
          assert.ok(text, 'dispatcher is woken while its child Task remains open')
          questionId = (JSON.parse(text.slice(text.indexOf('reason=feedback; ') + 'reason=feedback; '.length).split('. Read self;')[0]) as { feedback: { id: string } }).feedback.id
          return call(index, 'singularity_feedback', { kind: 'acceptance-concern', summary: correction
            ? 'The check incorrectly requires your worker checkout. Stop blocked; I will dispatch a corrected Task with your frozen output.'
            : 'The frozen check reads child.txt. Continue producing the exact bytes; no contract change is needed.', replyTo: questionId, refs: [] })
        }
        if (stage === 6) return { content: 'Waiting for the direct child.', usage: fixtureUsage(index) }
        if (stage === 9 || (correction && stage === 14)) return call(index, 'singularity_read', { kind: 'children' })
        if (correction && stage === 11) { preservedOutput = outputInput(request); return commit(request, index, 'required-work', [preservedOutput]) }
        if ((!correction && stage === 10) || (correction && stage === 15)) return call(index, 'bash', { command: `cat 'children/${encodeURIComponent(children.at(-1)?.taskId ?? '')}/child-note' > result.txt` })
        if ((!correction && stage === 11) || (correction && stage === 16)) return submitReply()
      } else {
        const first = current.taskId === children[0]?.taskId
        const asking = first && (!correction || currentRun.endsWith(':run:2'))
        if (step === 0 || (asking && step === 3)) { if (step === 3) assert.match(messageTexts(request).join('\n'), /"feedback":\{"count":1,/); return self() }
        if (step === 1 || (asking && !correction && step === 4)) return planning()
        if (asking && step === 2) return call(index, 'singularity_feedback', { kind: 'acceptance-concern', summary: 'Does the frozen check require the absent worker checkout? Please clarify or correct dispatch.', refs: frozenRef === undefined ? current.spec.inputs.map(input => input.object) : [frozenRef] })
        if (asking && step === 4 && correction) {
          assert.match(messageTexts(request).join('\n'), /Stop blocked; I will dispatch/)
          return call(index, 'singularity_stop', { reason: 'blocked', message: 'Dispatcher confirmed the immutable check is wrong.' })
        }
        if (step === (asking ? 5 : 2)) return call(index, 'bash', { command: `printf %s '${FROZEN_OUTPUT}' > child.txt` })
        if (step === (asking ? 6 : 3)) return call(index, 'singularity_submit', { outputIds: ['child-note'], includeLearningDrafts: false })
      }
      throw new Error(`Unexpected dialogue step ${currentRun}:${String(step)}`)
    }, async ({ spike, workspace, storeRoot }) => {
      const original = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 3, maxStepsPerRun: 60, maxDepth: 1, maxTasks: 3,
        childBinding: { bindingId: 'required-work', templateId: 'template:child', brief: 'Produce the exact bytes.', join: 'required', example: s4b2Example() } })
      const service = await CommandService.open({ root: storeRoot, actor: { kind: 'runtime', id: 'singularity-runtime' }, clock: Date.now })
      try {
        scenario = original; tasks.set(taskId, original.contract)
        const verifier = (task: TaskContract): RunVerifier => ({ provider: task.acceptance, verify: request => { if (task.taskId === children[0]?.taskId && frozenRef === undefined) frozenRef = request.outputs[0]; return Promise.resolve(sealPublicReceipt({
          v: 1, provider: task.acceptance, operationId: request.operationId, contractDigest: task.digest,
          inputDigests: request.inputs.map(ref => ref.digest), outputDigests: request.outputs.map(ref => ref.digest),
          criteria: task.spec.criteria.filter(criterion => criterion.required).map(criterion => ({ id: criterion.id, verdict: 'pass', reason: 'Independent fixture review.' })),
          exit: { code: 0, signal: null }, timedOut: false,
        })) } })
        const result = await executeTaskTree({ ctx: spike.ctx, journalRoot: storeRoot, workspace, runId, sessionId: `${runId}:session`,
          admission: { ...original.runAdmission, budgetReservation: { ...original.runAdmission.budgetReservation, steps: 60 } }, composition: original.composition, agentOptions: agentOptions(), verifier: verifier(original.contract),
          maxOutputBytes: 4096, maxActive: 1, workspaceRoot: join(workspace, 'runs'),
          async resolveRun(input) {
            tasks.set(input.contract.taskId, input.contract)
            if (!children.some(child => child.taskId === input.contract.taskId)) children.push(input.contract)
            return { composition: await buildSingleRunComposition(spike.ctx, { store: service, id: input.runId, contract: input.contract,
              agentOptions: agentOptions(), base: { v: 1, seed: input.contract.environment.seed } }), agentOptions: agentOptions(), verifier: verifier(input.contract), maxOutputBytes: 4096 }
          },
        }, service)
        assert.equal(result.root.classification, 'verified', result.root.executionRecord?.reason)
        const state = await service.taskRunState([]), old = state.tasks.get(children[0].taskId)
        assert.ok(old)
        assert.equal(old.runIds.length, correction ? 2 : 1)
        assert.equal(old.contract.digest, children[0].digest)
        assert.deepEqual(original.contract.spec.criteria, state.tasks.get(taskId)?.contract.spec.criteria)
        assert.equal(children.length, correction ? 2 : 1)
        if (correction) {
          assert.ok(preservedOutput)
          assert.deepEqual(children[1].spec.inputs, [preservedOutput])
          assert.equal(old.closed?.outcome, 'failed')
          assert.equal(result.runs.find(run => run.runId.endsWith(':run:2'))?.retry.allowed, false)
          assert.match(result.runs.find(run => run.runId.endsWith(':run:2'))?.executionRecord?.reason ?? '', /Dispatcher confirmed/)
          assert.ok(result.runs.find(run => run.runId === old.runIds[0])?.evidence?.outputs.some(ref => ref.digest === preservedOutput?.object.digest))
          assert.equal(old.supersededBy, children[1].taskId)
        }
      } finally { await service.close() }
    })
  })
}
