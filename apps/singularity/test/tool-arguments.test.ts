import assert from 'node:assert/strict'
import test from 'node:test'

import { SessionId } from '@deepseek-ai/dsh-session'
import { createWakeMessage,executeSingleRun,snapshotSession } from '@singularity/runtime'

import { messageTexts,wireText } from './fixtures/chat-completions.ts'
import { previewDigestFrom,s4b2Example } from './method-fixture.ts'
import { readFacts,recordSessionEvents,selfReadAndPlan,withHarness } from './run-fixture.ts'
import { agentOptions,fixtureUsage,makeScenario } from './task-fixture.ts'
import type { Scenario } from './task-fixture.ts'

void test('raw malformed arguments use native DSH tool errors and the next request can correct them', { timeout: 120_000 }, async () => {
  await withHarness((_request, index) => ({ toolCalls: [{ id: `native-${String(index)}`, name: 'working_directory',
    arguments: index === 0 ? '{"path":' : '{}' }], usage: fixtureUsage(index) }), async ({ spike, workspace, fixture }) => {
    const handle = await spike.ctx.agents.create({ sessionId: SessionId('native-malformed'), meta: { cwd: workspace }, agentOptions: agentOptions() })
    // End after the valid call so a fixture cannot mask a loop with a final answer.
    const stop = spike.ctx.on('tools/post-execute', (exec, result, next) => {
      if (exec.name === 'working_directory' && !result.isError) exec.agent?.cancel({ kind: 'hook', reason: 'fixture-complete' })
      return next()
    })
    try {
      handle.agent.followup(createWakeMessage({ wakeId: 'native-start', text: 'Inspect the working directory.' }))
      await handle.agent.whenIdle()
      assert.equal(fixture.requests.length, 2)
      assert.ok(messageTexts(fixture.requests[1]).some(text => /invalid arguments/.test(text)))
    } finally { stop(); await handle.dispose() }
  })
})

void test('length-limited responses retain native max-tokens semantics and dispatch no tools', { timeout: 120_000 }, async () => {
  for (const args of ['{}', '{"path":']) {
    await withHarness(() => ({ toolCalls: [{ id: 'truncated', name: 'working_directory', arguments: args }],
      finishReason: 'length', usage: fixtureUsage(0) }), async ({ spike, workspace, fixture }) => {
      const handle = await spike.ctx.agents.create({ sessionId: SessionId(`length-${String(args.length)}`), meta: { cwd: workspace }, agentOptions: agentOptions() })
      const recording = recordSessionEvents(spike, handle.agent.session.id)
      try {
        handle.agent.followup(createWakeMessage({ wakeId: 'length-start', text: 'Inspect the working directory.' }))
        await handle.agent.whenIdle()
        assert.equal(fixture.requests.length, 1)
        assert.equal(recording.events.filter(event => event.type === 'tool/call').length, 0)
        assert.equal(recording.events.filter(event => event.type === 'assistant/attempt').length, 0)
        assert.equal(snapshotSession(handle.agent.session).usage.steps, 1)
        assert.equal(snapshotSession(handle.agent.session).usage.unknownRequests, 0)
        assert.ok(recording.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'max-tokens'))
      } finally { recording.dispose(); await handle.dispose() }
    })
  }
})

void test('all Task tools return failed with a format example; corrected decompose admits one child without a retry session', { timeout: 120_000 }, async () => {
  const taskId = 'raw-args-task', runId = `${taskId}:run`, sessionId = `${runId}:session`, bindingId = 'inspect'
  const invalid = [
    ['singularity_read', '{"kind":"self"'],
    ['singularity_plan', '{"sketch":'],
    ['singularity_decompose', '{"action":"commit","children":[{"task":{}}}'],
    ['singularity_feedback', '{"refs":[}'],
    ['singularity_submit', '{"outputIds":["result"}'],
    ['singularity_stop', '{"reason":"unsolved"'],
    ['singularity_decompose', '{"action":"commit","children":"wrong-type"}'],
  ] as const
  let scenario: Scenario | undefined
  await withHarness((request, index) => {
    const first = selfReadAndPlan(request, index, scenario, taskId, runId)
    if (first !== undefined) return first
    if (index > 3) {
      const last = request.messages?.filter(message => message.role === 'tool').at(-1)
      const error = wireText(last?.content)
      assert.ok(error.includes('"status":"failed"'))
      assert.ok(error.includes('"example":'), 'a native parameter failure includes a complete syntax example')
    }
    const call = (name: string, argumentsText: string) => ({ toolCalls: [{ id: `args-${String(index)}`, name, arguments: argumentsText }], usage: fixtureUsage(index) })
    if (index === 2) return call('singularity_decompose', JSON.stringify({ action: 'prepare', bindingId }))
    if (index < 3 + invalid.length) {
      const [name, args] = invalid[index - 3]
      return call(name, args)
    }
    return call('singularity_decompose', JSON.stringify({ action: 'commit', children: [{ bindingId, ackPreview: previewDigestFrom(request),
      task: { goal: { summary: 'Inspect a component.', deliverable: 'A note.', scope: [], constraints: [] }, inputs: [], acceptanceCriteria: [{ id: 'child-result', statement: 'The declared result contains the completed work.', check: 'test -s notes.txt' }], localOutputs: [] } }] }))
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, maxDepth: 2, maxTasks: 2, maxStepsPerRun: 20,
      childBinding: { bindingId, templateId: 'component', brief: 'Inspect one component.', join: 'probe', example: s4b2Example() } })
    const events = recordSessionEvents(spike, sessionId)
    try {
      const result = await executeSingleRun({ ctx: spike.ctx, journalRoot: storeRoot, workspace, runId, sessionId,
        admission: { ...scenario.runAdmission, budgetReservation: { ...scenario.runAdmission.budgetReservation, steps: 20 } },
        composition: scenario.composition, agentOptions: agentOptions(), maxOutputBytes: 1024,
        verifier: { provider: scenario.provider, verify() { throw new Error('parent must yield before verification') } } })
      assert.equal(result.kind, 'yielded')
      assert.equal(result.usage.unknownRequests, 0)
      assert.equal(fixture.requests.length, 4 + invalid.length)
      const facts = await readFacts(storeRoot)
      assert.equal(facts.filter(fact => fact.type === 'task/children-admitted').length, 1)
      assert.equal(facts.filter(fact => fact.type === 'run/opened').length, 1)
      assert.equal(facts.some(fact => fact.type === 'run/closed'), false)
      const failures = events.events.filter(event => event.type === 'tool/result' && event.data.message.isError)
      assert.equal(failures.length, invalid.length)
      assert.equal(events.events.some(event => event.type === 'assistant/attempt'), false)
    } finally { events.dispose() }
  })
})
