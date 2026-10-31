import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { sealPublicReceipt } from '@singularity/protocol'
import type { TaskContract } from '@singularity/protocol'
import { CommandService, executeTaskTree } from '@singularity/runtime'
import type { RunVerifier } from '@singularity/runtime'

import { buildSingleRunComposition } from '../src/host-composition.ts'
import { contextEpochFrom, messageTexts } from './fixtures/chat-completions.ts'
import { previewDigestFrom, s4b2Example, s4a2Skill, S4A2_SKILL_NAME } from './method-fixture.ts'
import { planReply, recordSessionEvents, submitReply, withHarness } from './run-fixture.ts'
import { agentOptions, fixtureUsage, FROZEN_OUTPUT, makeScenario } from './task-fixture.ts'
import type { Scenario } from './task-fixture.ts'

void test('S4-B3 maxActive=1 releases parent, executes required child, wakes and independently verifies parent; replay agrees', { timeout: 240_000 }, async () => {
  const taskId = `task-b3-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}:run`
  const sessionId = `${runId}:session`
  let scenario: Scenario | undefined
  let child: TaskContract | undefined
  let childRunId = ''
  const verified: string[] = []
  const bindingId = 'required-work'
  let skillDirectory = ''
  await withHarness((request, requestIndex) => {
    const index = requestIndex - 1
    const call = (name: string, args: unknown) => ({
      toolCalls: [{ id: `b3-${String(index)}`, name, arguments: JSON.stringify(args) }], usage: fixtureUsage(index),
    })
    assert.ok(scenario)
    if (requestIndex === 0) return call('skill', { name: S4A2_SKILL_NAME })
    if (index === 0) {
      const result = messageTexts(request).find(text => text.startsWith(`<skill_content name="${S4A2_SKILL_NAME}">`))
      skillDirectory = /Base directory for this skill: (.+)/.exec(result ?? '')?.[1] ?? ''
      assert.ok(skillDirectory)
    }
    if (index === 0 || index === 4 || index === 8) return call('singularity_read', { kind: 'self' })
    if (index === 1 || index === 5 || index === 9) {
      const current = index === 5 ? child : scenario.contract
      assert.ok(current)
      return planReply({ ...scenario, contract: current }, current.taskId,
        index === 5 ? childRunId : runId, contextEpochFrom({ ...request, messages: [...(request.messages ?? [])].reverse() }) ?? '')
    }
    if (index === 2) return call('singularity_decompose', { action: 'prepare', bindingId })
    if (index === 3) return call('singularity_decompose', {
      action: 'commit', children: [{ bindingId, ackPreview: previewDigestFrom(request), task: {
        goal: { summary: 'Write the exact bytes to child.txt.', deliverable: 'child.txt', scope: [], constraints: [] },
        localCriteria: [], inputs: [],
        localOutputs: [{ id: 'child-note', path: 'child.txt', kind: 'file', description: 'Frozen child result.' }],
      } }],
    })
    if (index === 6) return call('bash', { command: `printf %s '${FROZEN_OUTPUT}' > child.txt` })
    if (index === 7) return call('singularity_submit', { outputIds: ['child-note'], includeLearningDrafts: false })
    if (index === 10) {
      assert.ok(messageTexts(request).some(text => text.includes('reason=children-terminal')))
      return call('singularity_read', { kind: 'children' })
    }
    if (index === 11) {
      assert.ok(child)
      assert.ok(messageTexts(request).some(text => text.includes('"status":"winner"')))
      assert.ok(messageTexts(request).some(text => text.includes(skillDirectory)), 'resume retains the prior skill result')
      return call('bash', { command: `sh '${skillDirectory}/scripts/result.sh' > result.txt && cmp result.txt 'children/${encodeURIComponent(child.taskId)}/child-note'` })
    }
    if (index === 12) return submitReply()
    return { content: `unexpected request ${String(index)}`, usage: fixtureUsage(index) }
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId, maxRuns: 1, maxStepsPerRun: 30, maxDepth: 2, maxTasks: 2,
      skills: [{ ...s4a2Skill(), extraFiles: [{ path: 'scripts/result.sh', content: `printf %s '${FROZEN_OUTPUT}'\n` }] }],
      childBinding: { bindingId, templateId: 'template:child', brief: 'Produce a direct result.', join: 'required', example: s4b2Example() },
    })
    const active = scenario
    const verifier = (contract: TaskContract): RunVerifier => ({
      provider: contract.acceptance,
      async verify(request) {
        assert.equal(new TextDecoder().decode((await request.readObject(request.outputs[0], 'object')).bytes), FROZEN_OUTPUT)
        if (contract.taskId === taskId) assert.equal(request.inputs.length, 2, 'root verifier sees initial input plus direct output')
        verified.push(contract.taskId)
        return sealPublicReceipt({
          v: 1, provider: contract.acceptance, operationId: request.operationId, contractDigest: contract.digest,
          inputDigests: request.inputs.map(ref => ref.digest), outputDigests: request.outputs.map(ref => ref.digest),
          criteria: contract.spec.criteria.filter(criterion => criterion.required).map(criterion => ({ id: criterion.id, verdict: 'pass', reason: 'Exact frozen bytes.' })),
          exit: { code: 0, signal: null }, timedOut: false,
        })
      },
    })
    let activeHandles = 0
    let peak = 0
    const create = spike.ctx.agents.create.bind(spike.ctx.agents)
    const resume = spike.ctx.agents.resume.bind(spike.ctx.agents)
    const count = (handle: Awaited<ReturnType<typeof create>>) => {
      activeHandles += 1
      peak = Math.max(peak, activeHandles)
      const dispose = handle.dispose.bind(handle)
      return { ...handle, async dispose() { await dispose(); activeHandles -= 1 } }
    }
    spike.ctx.agents.create = async options => count(await create(options))
    spike.ctx.agents.resume = async options => count(await resume(options))
    const events = recordSessionEvents(spike, sessionId)
    const writer = await CommandService.open({ root: storeRoot, actor: { kind: 'runtime', id: 'singularity-runtime' }, clock: Date.now })
    try {
      const result = await executeTaskTree({
        ctx: spike.ctx, journalRoot: storeRoot, workspace, runId, sessionId,
        admission: { ...active.runAdmission, budgetReservation: { ...active.runAdmission.budgetReservation, steps: 30 } },
        composition: active.composition, agentOptions: agentOptions(), verifier: verifier(active.contract), maxOutputBytes: 1024,
        maxActive: 1, workspaceRoot: join(workspace, 'runs'),
        async resolveRun(input) {
          child = input.contract
          childRunId = input.runId
          return {
            composition: await buildSingleRunComposition(spike.ctx, {
              store: input.service, id: input.runId, contract: input.contract, agentOptions: agentOptions(),
              base: { v: 1, seed: input.contract.environment.seed },
            }),
            agentOptions: agentOptions(), verifier: verifier(input.contract), maxOutputBytes: 1024,
          }
        },
      }, writer)
      assert.equal(result.root.classification, 'verified', result.root.executionRecord?.reason)
      assert.equal(result.runs.length, 2)
      assert.ok(child)
      assert.deepEqual(verified, [child.taskId, taskId])
      assert.equal(peak, 1)
      assert.equal(activeHandles, 0)
      assert.equal(fixture.requests.length, 14)
      assert.deepEqual(result.root.evidence?.inputs.map(ref => ref.digest), result.root.receipt?.inputDigests)
      assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), FROZEN_OUTPUT)
      await assert.rejects(readFile(join(skillDirectory, 'scripts/result.sh')), { code: 'ENOENT' })
      const state = await writer.taskRunState([])
      assert.equal(state.tasks.get(taskId)?.closed?.outcome, 'verified')
      assert.equal(state.tasks.get(child.taskId)?.closed?.outcome, 'verified')
      const wakes = events.events.filter(event => event.type === 'user/message').map(event => String(event.data.id)).filter(id => id === `${runId}:start` || id.endsWith(':terminal'))
      assert.equal(wakes.length, 2)
      assert.ok(wakes[1]?.endsWith(':terminal'))
    } finally {
      events.dispose()
      spike.ctx.agents.create = create
      spike.ctx.agents.resume = resume
      await writer.close()
    }
    const replay = await CommandService.open({ root: storeRoot, actor: { kind: 'runtime', id: 'singularity-runtime' }, clock: Date.now })
    try {
      const state = await replay.taskRunState([])
      assert.equal(state.tasks.get(taskId)?.closed?.outcome, 'verified')
      assert.equal([...state.tasks.values()].filter(task => task.phase === 'closed').length, 2)
      assert.equal([...state.runs.values()].filter(run => run.phase === 'closed').length, 2)
    } finally {
      await replay.close()
    }
  })
})
