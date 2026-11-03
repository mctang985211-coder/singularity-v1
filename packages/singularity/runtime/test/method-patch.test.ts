import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { FactPayloadMap,FactType,MethodPatch,Ref } from '@singularity/protocol'
import { canonicalize,seal,sealMethodRevision } from '@singularity/protocol'

import { freezeEvaluationCase } from '../src/evaluation-case.ts'
import { precheckMethodPatch,submitMethodPatch } from '../src/method-patch.ts'
import { CommandService } from '../src/service.ts'

const actor = { kind: 'runtime', id: 's5-precheck-fixture' } as const
const bytes = (value: unknown) => new TextEncoder().encode(canonicalize(value))
const usage = { inputTokens: 0, outputTokens: 0, steps: 0, unknownRequests: 0 }

/** Pure host precheck fixture; live DSH trace sealing is covered by the app integration. */
async function withRound(run: (service: CommandService, base: Ref) => Promise<void>, skillText?: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-precheck-'))
  const service = await CommandService.open({ root, actor, clock: () => 1000 })
  try {
    const commit = <Type extends FactType>(type: Type, data: FactPayloadMap[Type], id: string) => service.commit({
      command: { v: 1, commandId: id, tool: 'precheck-fixture', toolVersion: 1, actor, scope: {}, input: null }, type, data,
    }, [])
    const skills = []
    if (skillText !== undefined) {
      const file = await service.putObject('legacy:file', new TextEncoder().encode(skillText))
      const bundle = await service.putObject('legacy:bundle', bytes(seal('object', { v: 1, kind: 'tree', files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(skillText), object: file }] })))
      skills.push({ id: 'skill:review', name: 'review', description: 'Check declared outputs.', bundle })
    }
    const base = sealMethodRevision({ v: 1, id: 'method:base', templates: [], skills, tools: [] })
    const baseRef = await service.putObject(base.id, bytes(base), 'method')
    await commit('method/registered', { revision: baseRef }, 'register')
    const source = await service.putObject('source', bytes({ v: 1 }))
    const caseRef = await freezeEvaluationCase(service, 'case:fixture', {
      v: 1, spec: { goal: { summary: 'Produce the declared output.', deliverable: 'result.txt', scope: [], constraints: [] },
        criteria: [], inputs: [], outputs: [] },
      acceptance: source, environment: { seed: source, profile: source }, baseTools: [],
      limits: { maxRuns: 1, maxStepsPerRun: 2, maxTokens: 100, deadlineAt: 2000, maxDepth: 1, maxTasks: 1, maxBatchChildren: 1 },
    })
    await commit('method/activated', { next: baseRef, approval: source }, 'activate')
    const trace = await service.putObject('trace:fixture', bytes(seal('object', {
      v: 1, kind: 'public-task-trace', traceId: 'trace:fixture', rootTask: { id: 'task:fixture', method: baseRef, outcome: 'verified' },
      sourceResourceSnapshot: source, chapters: [], authorizedObjects: [], usage, sessionCuts: [],
    })))
    await commit('rsi/trace-sealed', { rootTaskId: 'task:fixture', trace, usage, sessionCuts: [] }, 'seal')
    const plan = await service.putObject('round:plan', bytes({
      v: 1, cases: [caseRef], metric: {}, thresholds: { minDelta: 0, maxRegression: 0 }, trialsPerCase: 1,
      proposerBudget: { maxSteps: 2, maxTokens: 100, maxWallClockMs: 1000 },
      budget: { maxRuns: 2, maxTokens: 100, maxWallClockMs: 1000, maxActiveRuns: 1 },
      validation: 'none', validationCases: [], claim: 'source-replay', comparator: source, sourceSeed: source, expectedPreviousActiveMethod: baseRef,
    }), 'round-plan')
    await commit('rsi/round-opened', { roundId: 'round:fixture', sourceTrace: trace, baseMethod: baseRef, plan, proposerSessionId: 'session:proposer' }, 'open')
    await run(service, baseRef)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
}

function patch(base: Ref, changes: MethodPatch['changes']): MethodPatch {
  return { v: 1, base, hypothesis: 'Reuse a bounded review.', changes, predictedRisks: [], transferPlan: 'Evaluate the frozen cases.' }
}

void test('precheck atomically publishes one complete revision while preserving the active head', async () => {
  await withRound(async (service, base) => {
    const proposal = await submitMethodPatch({ service, actor, roundId: 'round:fixture', value: patch(base, [
      { op: 'put-skill', skill: { id: 'skill:review', name: 'review', description: 'Check declared outputs.', files: {
        'SKILL.md': '---\nname: review\ndescription: Check declared outputs.\n---\n# Review\n\nDo not invent scores; use the frozen criteria.', 'refs/notes.txt': 'Reusable notes.',
      } } },
    ]) })
    await assert.rejects(submitMethodPatch({ service, actor, roundId: 'round:fixture', value: patch(base, []) }), /formal proposal/)
    const result = await precheckMethodPatch({ service, actor, roundId: 'round:fixture' })
    assert.equal(result.accepted, true)
    assert.equal(service.facts().filter(fact => fact.type === 'method/registered').length, 1)
    assert.equal(service.facts().filter(fact => fact.type === 'rsi/candidate-ready').length, 1)
    assert.equal(service.facts().filter(fact => fact.type === 'rsi/proposal-submitted').at(0)?.data.patch.digest, proposal.digest)
    assert.deepEqual((await service.methodRoundState()).productionHead, base)
    assert.deepEqual(result.candidate.parent, base)
  })
})

void test('MCP draft uses existing manifest/config/capability checks without scanning source semantics', async () => {
  await withRound(async (service, base) => {
    await submitMethodPatch({ service, actor, roundId: 'round:fixture', value: patch(base, [{ op: 'put-mcp-server', server: {
      id: 'tool:review', name: 'review', description: 'A bounded review MCP server.', kind: 'mcp-server', server: {
        files: { 'server.mjs': "import { exec } from 'node:child_process';\n// The deployment capability controls actual execution.\n" },
        manifest: { v: 1, serverName: 'review', transport: 'stdio', capabilities: ['tools'], instructions: 'Review the current output.', entrypoint: 'server.mjs', limits: { maxBundleBytes: 1024 * 1024, maxInstructionBytes: 8192, toolCallTimeoutMs: 1000 } },
        config: { v: 1, serverName: 'review', transport: 'stdio', command: 'node', args: ['server.mjs'], cwd: '.', env: {}, toolCallTimeoutMs: 1000, maxInstructionBytes: 8192, failOnStartupError: true, reconnect: { enabled: false } },
        transport: 'stdio', capabilities: ['tools'], exposedTools: [{ name: 'review', description: 'Review the output.', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
      },
    } }]) })
    const result = await precheckMethodPatch({ service, actor, roundId: 'round:fixture' })
    assert.equal(result.accepted, true, canonicalize(result))
  })
})

void test('rewriting identical skill files with new host-generated refs remains a no-op', async () => {
  const text = '# Review\n\nCheck the declared output.'
  await withRound(async (service, base) => {
    await submitMethodPatch({ service, actor, roundId: 'round:fixture', value: patch(base, [{
      op: 'put-skill', skill: { id: 'skill:review', name: 'review', description: 'Check declared outputs.', files: { 'SKILL.md': text } },
    }]) })
    const result = await precheckMethodPatch({ service, actor, roundId: 'round:fixture' })
    assert.equal(result.accepted, false)
    assert.match(result.reason, /no-op/)
  }, text)
})

for (const scenario of [
  { name: 'relative bundle paths', changes: [{ op: 'put-skill', skill: { id: 'skill:a', name: 'review', description: 'Review.', files: { 'SKILL.md': '# Review', '../outside': 'escape' } } }], reason: /relative paths/ },
  { name: 'required SKILL.md', changes: [{ op: 'put-skill', skill: { id: 'skill:a', name: 'review', description: 'Review.', files: { 'notes.md': '# Review' } } }], reason: /SKILL.md/ },
  { name: 'no-op', changes: [{ op: 'set-entry', templateId: null }], reason: /no-op/ },
  { name: 'dangling entry', changes: [{ op: 'set-entry', templateId: 'template:absent' }], reason: /dangling/ },
  { name: 'duplicate operations', changes: [{ op: 'set-entry', templateId: null }, { op: 'set-entry', templateId: null }], reason: /repeats/ },
] satisfies readonly { readonly name: string; readonly changes: MethodPatch['changes']; readonly reason: RegExp }[]) {
  void test(`precheck rejects ${scenario.name} with a receipt and no candidate publication`, async () => {
    await withRound(async (service, base) => {
      await submitMethodPatch({ service, actor, roundId: 'round:fixture', value: patch(base, scenario.changes) })
      const result = await precheckMethodPatch({ service, actor, roundId: 'round:fixture' })
      assert.equal(result.accepted, false)
      assert.match(result.reason, scenario.reason)
      assert.equal(service.facts().filter(fact => fact.type === 'rsi/candidate-ready').length, 0)
      assert.equal((await service.methodRoundState()).rounds.get('round:fixture')?.closed?.outcome, 'rejected')
      assert.deepEqual((await service.methodRoundState()).productionHead, base)
    })
  })
}

void test('precheck propagates CAS failure without recording a rejected candidate or closing the Round', async () => {
  await withRound(async (service, base) => {
    await submitMethodPatch({ service, actor, roundId: 'round:fixture', value: patch(base, [
      { op: 'put-skill', skill: { id: 'skill:review', name: 'review', description: 'Review.', files: {
        'SKILL.md': '---\nname: review\ndescription: Review.\n---\nReview the output.',
      } } },
    ]) })
    const before = service.facts()
    const hostFailure = new Error('precheck CAS unavailable')
    service.readObject = () => Promise.reject(hostFailure)
    await assert.rejects(precheckMethodPatch({ service, actor, roundId: 'round:fixture' }), error => error === hostFailure)
    assert.strictEqual(service.facts(), before)
    assert.equal(service.facts().some(fact => fact.type === 'rsi/round-closed' || fact.type === 'rsi/candidate-ready'), false)
  })
})
