import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { EXPLORE_BINDING_ID, EXPLORE_TEMPLATE_ID, sealMethodRevision, sealPublicReceipt, sealTaskContract } from '@singularity/protocol'
import type { TaskContract } from '@singularity/protocol'
import { CommandService, DomainStore, executeTaskTree, freezeGlobalResources } from '@singularity/runtime'
import type { RunVerifier } from '@singularity/runtime'

import { buildSingleRunComposition } from '../src/host-composition.ts'
import { contextEpochFrom, messageTexts } from './fixtures/chat-completions.ts'
import { previewDigestFrom } from './method-fixture.ts'
import { contractPayload, planReply, withHarness } from './run-fixture.ts'
import { agentOptions, fixtureUsage, makeScenario } from './task-fixture.ts'
import type { Scenario } from './task-fixture.ts'

void test('empty Method plans three levels, commits direct children only, and integrates a grandchild through its parent', { timeout: 240_000 }, async () => {
  const taskId = `empty-method-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}:run`
  let scenario: Scenario | undefined
  let child: TaskContract | undefined
  let childRunId = ''
  let grandchild: TaskContract | undefined
  let grandchildRunId = ''
  const verified: string[] = []
  await withHarness((request, index) => {
    const call = (name: string, args: unknown) => ({ toolCalls: [{ id: `explore-${String(index)}`, name, arguments: JSON.stringify(args) }], usage: fixtureUsage(index) })
    assert.ok(scenario)
    if ([0, 6, 10, 14, 20].includes(index)) {
      if (index === 0) {
        const plan = request.tools?.find(tool => tool.function?.name === 'singularity_plan')
        assert.ok(plan)
        const schema = plan.function?.parameters as { properties: { sketch: { properties: { levels: {
          anyOf: readonly { minItems: number; maxItems: number; prefixItems: readonly { properties: { level: { const: number } } }[] }[]
        } } } } }
        const choices = schema.properties.sketch.properties.levels.anyOf
        assert.deepEqual(choices.map(choice => [choice.minItems, choice.maxItems]), [[2, 2], [3, 3]], JSON.stringify(schema.properties.sketch.properties.levels))
        assert.deepEqual(choices.map(choice => choice.prefixItems.map(level => level.properties.level.const)), [[0, 1], [0, 1, 2]])
      }
      assert.match(messageTexts(request).join('\n'), /"mode":"exploration"/)
      assert.match(messageTexts(request).join('\n'), /public-handbook/)
      if (index === 20) {
        assert.match(messageTexts(request).join('\n'), /"feedback":\{"count":1,/)
        assert.match(messageTexts(request).join('\n'), /reason=children-terminal;.*remainingBudgetPct=\{"tokensPct":\d+,/)
      }
      return call('singularity_read', { kind: 'self' })
    }
    if ([1, 7, 11, 15, 21].includes(index)) {
      const current = index === 11 ? grandchild : index === 7 || index === 15 ? child : scenario.contract
      assert.ok(current)
      const reply = planReply({ ...scenario, contract: current }, current.taskId,
        index === 11 ? grandchildRunId : index === 7 || index === 15 ? childRunId : runId,
        contextEpochFrom({ ...request, messages: [...(request.messages ?? [])].reverse() }) ?? '')
      assert.ok(reply.toolCalls)
      const args = JSON.parse(reply.toolCalls[0].arguments) as { sketch: { levels: unknown[]; directPlan: unknown[] } }
      if (index === 1 || index === 7) {
        args.sketch.levels = [
          { level: 0, purpose: 'Inspect and integrate this level output.', likelyChildren: [EXPLORE_BINDING_ID], expectedInputs: [], expectedOutputs: ['local finding'] },
          { level: 1, purpose: 'Delegate the direct local finding.', likelyChildren: [], expectedInputs: [], expectedOutputs: ['local finding'] },
          { level: 2, purpose: 'The child may delegate a narrower finding in its own workflow.', likelyChildren: [], expectedInputs: [], expectedOutputs: ['narrower finding'] },
        ]
        args.sketch.directPlan = [{ bindingId: EXPLORE_BINDING_ID, purpose: 'Obtain the direct local finding.' }]
      }
      return { ...reply, toolCalls: [{ ...reply.toolCalls[0], arguments: JSON.stringify(args) }] }
    }
    if (index === 2) return call('singularity_read', { kind: 'resource', id: 'public-handbook' })
    if (index === 3) return call('skill', { name: 'global-public-skill' })
    if (index === 4 || index === 8) {
      if (index === 4) assert.match(messageTexts(request).join('\n'), /A public exploration document/)
      return call('singularity_decompose', { action: 'prepare', bindingId: EXPLORE_BINDING_ID })
    }
    if (index === 5 || index === 9) return call('singularity_decompose', { action: 'commit', children: [{ bindingId: EXPLORE_BINDING_ID, ackPreview: previewDigestFrom(request), task: {
      goal: { summary: 'Write a local finding.', deliverable: 'child.txt', scope: [], constraints: [] },
      localCriteria: [], inputs: [], localOutputs: [{ id: 'finding', path: 'child.txt', kind: 'file', description: 'One local finding.' }],
    } }] })
    if (index === 12) return call('bash', { command: "printf child-result > child.txt" })
    if (index === 13 || index === 19) return call('singularity_submit', { outputIds: ['finding'], includeLearningDrafts: false })
    if (index === 16) return call('singularity_read', { kind: 'children' })
    if (index === 17) return call('singularity_feedback', { kind: 'needs-replan', summary: 'Preserve the reusable local finding as a skill draft.', proposedChanges: [{ field: 'outputs', suggestion: 'Include a public learning draft when integrating this finding.' }], refs: [] })
    if (index === 18) {
      assert.ok(grandchild)
      return call('bash', { command: `cat 'children/${encodeURIComponent(grandchild.taskId)}/finding' > child.txt` })
    }
    if (index === 22) return call('singularity_read', { kind: 'feedback' })
    if (index === 23) {
      assert.ok(child)
      assert.match(messageTexts(request).join('\n'), /Preserve the reusable local finding as a skill draft/)
      return call('bash', { command: `cat 'children/${encodeURIComponent(child.taskId)}/finding' > result.txt\nmkdir -p learning-drafts/skills/finding\nprintf '# Useful finding\n\nReuse the observed public approach.\n' > learning-drafts/skills/finding/SKILL.md` })
    }
    if (index === 24) return call('singularity_submit', { outputIds: ['result'], includeLearningDrafts: true })
    return { content: 'Unexpected fixture request.', usage: fixtureUsage(index) }
  }, async ({ spike, storeRoot, workspace, fixture }) => {
    const original = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, maxStepsPerRun: 30, maxDepth: 3, maxTasks: 3,
      skills: [{ id: 'global-public-skill', name: 'global-public-skill', description: 'Public exploration skill.', content: '# Public local skill\n\nInspect the supplied local question and report a useful finding.\n' }] })
    const store = await DomainStore.open({ root: storeRoot })
    try {
      const method = sealMethodRevision({ v: 1, id: 'empty-method', templates: [], skills: [], tools: [] })
      await store.putObject(method.id, new TextEncoder().encode(JSON.stringify(method)), 'method')
      const handbook = await store.putObject('public-handbook', new TextEncoder().encode('A public exploration document.'))
      const exploration = await freezeGlobalResources(store, 'public-resources', {
        documents: [{ id: 'public-handbook', description: 'Public local workflow guidance.', object: handbook }],
        skills: original.method.skills, tools: [], baseTools: original.contract.resources.baseTools, fallbackAcceptance: original.contract.acceptance,
      })
      const contract = sealTaskContract({ ...contractPayload(original.contract), method: { id: method.id, digest: method.digest },
        template: { id: EXPLORE_TEMPLATE_ID, digest: method.digest }, resources: { ...original.contract.resources, exploration } })
      const composition = await buildSingleRunComposition(spike.ctx, { store, id: 'empty-method-root', contract, agentOptions: agentOptions(), base: { v: 1, seed: contract.environment.seed } })
      scenario = { ...original, contract, composition, method, runAdmission: { ...original.runAdmission, contract } }
    } finally {
      await store.close()
    }
    const verifier = (contract: TaskContract): RunVerifier => ({ provider: contract.acceptance,
      async verify(request) {
        assert.equal(new TextDecoder().decode((await request.readObject(request.outputs[0], 'object')).bytes), 'child-result')
        verified.push(contract.taskId)
        return sealPublicReceipt({ v: 1, provider: contract.acceptance, operationId: request.operationId, contractDigest: contract.digest,
          inputDigests: request.inputs.map(ref => ref.digest), outputDigests: request.outputs.map(ref => ref.digest),
          criteria: contract.spec.criteria.filter(criterion => criterion.required).map(criterion => ({ id: criterion.id, verdict: 'pass', reason: 'Observed frozen result bytes.' })), exit: { code: 0, signal: null }, timedOut: false })
      },
    })
    const active = scenario
    assert.ok(active)
    const writer = await CommandService.open({ root: storeRoot, actor: { kind: 'runtime', id: 'singularity-runtime' }, clock: Date.now })
    try {
      const result = await executeTaskTree({ ctx: spike.ctx, journalRoot: storeRoot, workspace, runId, sessionId: `${runId}:session`,
        admission: { ...active.runAdmission, budgetReservation: { ...active.runAdmission.budgetReservation, steps: 30 } },
        composition: active.composition, agentOptions: agentOptions(), verifier: verifier(active.contract), maxOutputBytes: 4096,
        maxActive: 1, workspaceRoot: join(workspace, 'runs'),
        async resolveRun(input) {
          assert.equal(input.contract.origin.kind, 'child')
          if (input.contract.origin.parentId === taskId) {
            child = input.contract; childRunId = input.runId
          } else {
            grandchild = input.contract; grandchildRunId = input.runId
          }
          return { composition: await buildSingleRunComposition(spike.ctx, { store: input.service, id: input.runId, contract: input.contract,
            agentOptions: agentOptions(), base: { v: 1, seed: input.contract.environment.seed } }), agentOptions: agentOptions(), verifier: verifier(input.contract), maxOutputBytes: 4096 }
        },
      }, writer)
      assert.equal(result.root.classification, 'verified', result.root.executionRecord?.reason)
      assert.ok(child)
      assert.equal(child.method.digest, active.contract.method.digest)
      assert.equal(child.template.id, EXPLORE_TEMPLATE_ID)
      assert.deepEqual(child.spec.criteria.map(criterion => [criterion.id, criterion.required]), [['task-goal', true]])
      assert.equal(child.resources.exploration?.digest, active.contract.resources.exploration?.digest)
      assert.equal(result.root.manifest?.learningDrafts[0]?.id, '__skill-drafts')
      assert.ok(result.root.manifest.learningDrafts[0].object)
      assert.ok(grandchild)
      assert.deepEqual(grandchild.spec.criteria, child.spec.criteria)
      assert.deepEqual(grandchild.method, active.contract.method)
      assert.equal(grandchild.origin.kind === 'child' && grandchild.origin.parentId, child.taskId)
      assert.deepEqual(verified, [grandchild.taskId, child.taskId, taskId])
      assert.equal(fixture.requests.length, 25)
      const batches = writer.facts().filter(fact => fact.type === 'task/children-admitted')
      assert.equal(batches.length, 2)
      assert.deepEqual(batches.map(fact => fact.data.parentRunId), [runId, childRunId])
      const submissions = writer.facts().filter(fact => fact.type === 'run/submitted')
      const rootSubmission = submissions.find(fact => fact.data.runId === runId)
      const childSubmission = submissions.find(fact => fact.data.runId === childRunId)
      assert.ok(rootSubmission)
      assert.deepEqual(rootSubmission.data.feedbackRefs, childSubmission?.data.feedbackRefs)
      assert.equal(rootSubmission.data.feedbackRefs.length, 1)
      assert.equal([...((await writer.taskRunState([])).tasks.values())].filter(task => task.phase === 'closed').length, 3)
    } finally {
      await writer.close()
    }
    const replay = await CommandService.open({ root: storeRoot, actor: { kind: 'runtime', id: 'singularity-runtime' }, clock: Date.now })
    try { assert.equal((await replay.taskRunState([])).tasks.get(taskId)?.closed?.outcome, 'verified') }
    finally { await replay.close() }
  })
})
