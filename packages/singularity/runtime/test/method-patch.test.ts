import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { FactPayloadMap,FactType,MethodPatch,MethodPatchDraft,Ref,TemplateDraft } from '@singularity/protocol'
import { canonicalize,DEFAULT_TASK_PROPOSAL_INSTANCE_SCHEMA,seal,sealMethodRevision,sealTaskContract } from '@singularity/protocol'

import { freezeEvaluationCase } from '../src/evaluation-case.ts'
import { freezeGlobalResources } from '../src/global-resources.ts'
import { precheckMethodPatch,submitMethodPatch } from '../src/method-patch.ts'
import { CommandService } from '../src/service.ts'

const actor = { kind: 'runtime', id: 's5-precheck-fixture' } as const
const bytes = (value: unknown) => new TextEncoder().encode(canonicalize(value))
const usage = { inputTokens: 0, outputTokens: 0, steps: 0, unknownRequests: 0 }

/** Pure host precheck fixture; live DSH trace sealing is covered by the app integration. */
async function withRound(run: (service: CommandService, base: Ref, acceptance: Ref) => Promise<void>, skillText?: string, publicSkill = false): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-precheck-'))
  const service = await CommandService.open({ root, actor, clock: () => 1000 })
  try {
    const commit = <Type extends FactType>(type: Type, data: FactPayloadMap[Type], id: string) => service.commit({
      command: { v: 1, commandId: id, tool: 'precheck-fixture', toolVersion: 1, actor, scope: {}, input: null }, type, data,
    }, [])
    const source = await service.putObject('source', bytes({ v: 1 }))
    let exploration: Ref | undefined
    if (publicSkill) {
      const text = '---\nname: public-environment\ndescription: Public environment.\n---\nUse the public environment.'
      const file = await service.putObject('public:file', new TextEncoder().encode(text))
      const bundle = await service.putObject('public:bundle', bytes(seal('object', { v: 1, kind: 'tree', files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(text), object: file }] })))
      exploration = await freezeGlobalResources(service, 'public', { documents: [], baseTools: [], tools: [],
        skills: [{ id: 'public:skill', name: 'public-environment', description: 'Public environment.', bundle }], fallbackAcceptance: source })
    }
    const skills = [], templates = []
    if (skillText !== undefined) {
      const file = await service.putObject('legacy:file', new TextEncoder().encode(skillText))
      const bundle = await service.putObject('legacy:bundle', bytes(seal('object', { v: 1, kind: 'tree', files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(skillText), object: file }] })))
      skills.push({ id: 'skill:review', name: 'review', description: 'Check declared outputs.', bundle })
      const { guidance, example, ...template } = templateDraft(['skill:review'])
      templates.push({ ...template,
        instanceSchema: structuredClone(DEFAULT_TASK_PROPOSAL_INSTANCE_SCHEMA), acceptancePolicy: source,
        guidance: await service.putObject('legacy:guidance', bytes({ v: 1, text: guidance })),
        example: await service.putObject('legacy:example', bytes(example)) })
    }
    const base = sealMethodRevision({ v: 1, id: 'method:base', ...(skillText === undefined ? {} : { entryTemplateId: 'template:root' }), templates, skills, tools: [] })
    const baseRef = await service.putObject(base.id, bytes(base), 'method')
    await commit('method/registered', { revision: baseRef }, 'register')
    const spec = { goal: { summary: 'Produce the declared output.', deliverable: 'result.txt', scope: [], constraints: [] },
      criteria: [], inputs: [], outputs: [] }
    const limits = { maxRuns: 1, maxStepsPerRun: 2, maxTokens: 100, deadlineAt: 2000, maxDepth: 1, maxTasks: 1, maxBatchChildren: 1 }
    const caseRef = await freezeEvaluationCase(service, 'case:fixture', {
      v: 1, spec, acceptance: source, environment: { seed: source, profile: source }, baseTools: [], limits,
    })
    const rootContract = sealTaskContract({ v: 1, taskId: 'task:fixture', spec,
      origin: { kind: 'root', purpose: 'work', requestRef: source }, method: baseRef,
      template: { id: 'template:root', digest: baseRef.digest },
      resources: { baseTools: [], skills: [], mcpServers: [], ...(exploration === undefined ? {} : { exploration }) }, acceptance: source,
      environment: { seed: source, profile: source }, limits })
    const contractRef = await service.putObject(rootContract.taskId, bytes(rootContract))
    await commit('method/activated', { next: baseRef, approval: source }, 'activate')
    const trace = await service.putObject('trace:fixture', bytes(seal('object', {
      v: 1, kind: 'public-task-trace', traceId: 'trace:fixture', rootTask: { id: 'task:fixture', method: baseRef, outcome: 'verified' },
      sourceResourceSnapshot: source, chapters: [{ id: 'contract', object: contractRef, sizeClass: 'small', pages: 1 }],
      authorizedObjects: [{ ref: source, domain: 'object' }, { ref: contractRef, domain: 'object' }], usage, sessionCuts: [],
    })))
    await commit('rsi/trace-sealed', { rootTaskId: 'task:fixture', trace, usage, sessionCuts: [] }, 'seal')
    const plan = await service.putObject('round:plan', bytes({
      v: 1, cases: [caseRef], metric: {}, thresholds: { minDelta: 0, maxRegression: 0 }, trialsPerCase: 1,
      proposerBudget: { maxSteps: 2, maxTokens: 100, maxWallClockMs: 1000 },
      budget: { maxRuns: 2, maxTokens: 100, maxWallClockMs: 1000, maxActiveRuns: 1 },
      validation: 'none', validationCases: [], claim: 'source-replay', comparator: source, sourceSeed: source, expectedPreviousActiveMethod: baseRef,
    }), 'round-plan')
    await commit('rsi/round-opened', { roundId: 'round:fixture', sourceTrace: trace, baseMethod: baseRef, plan, proposerSessionId: 'session:proposer' }, 'open')
    await run(service, baseRef, source)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
}

function patch(changes: MethodPatch['changes']): MethodPatchDraft {
  return { v: 1, hypothesis: 'Reuse a bounded review.', changes, predictedRisks: [], transferPlan: 'Evaluate the frozen cases.' }
}

function templateDraft(skills: string[] = [], tools: string[] = []): TemplateDraft {
  return { id: 'template:root', brief: 'Use reusable assets.', guidance: 'Use the bound reusable assets.',
    example: { goal: { summary: 'Produce the declared output.', deliverable: 'result.txt', scope: [], constraints: [] },
      acceptanceCriteria: [{ id: 'delivery', statement: 'The declared output exists.', check: 'test -f result.txt' }], inputs: [] },
    skills, tools, children: [] }
}

function bindEntry(assets: { skills?: string[]; tools?: string[] }): MethodPatch['changes'] {
  return [{ op: 'put-template', template: templateDraft(assets.skills, assets.tools) },
    { op: 'set-entry', templateId: 'template:root' }]
}

for (const copyPublic of [false, true]) {
  void test(`precheck ${copyPublic ? 'rejects a copied public identity' : 'composes public resources without Method copies'}`, async () => {
    await withRound(async service => {
      await submitMethodPatch({ service, actor, roundId: 'round:fixture', value: patch([
        ...(copyPublic ? [{ op: 'put-skill' as const, skill: { id: 'public:skill', name: 'public-copy', description: 'Copy.', files: {
          'SKILL.md': '---\nname: public-copy\ndescription: Copy.\n---\nCopy.',
        } } }] : []),
        ...bindEntry({}),
      ]) })
      const result = await precheckMethodPatch({ service, actor, roundId: 'round:fixture' })
      assert.equal(result.accepted, !copyPublic)
      if (result.accepted) assert.equal(result.candidate.skills.length, 0)
      else assert.match(result.reason, /public asset.*conflicts/)
    }, undefined, true)
  })
}

void test('precheck atomically publishes one complete revision while preserving the active head', async () => {
  await withRound(async (service, base, acceptance) => {
    const proposal = await submitMethodPatch({ service, actor, roundId: 'round:fixture', value: patch([
      { op: 'put-skill', skill: { id: 'skill:review', name: 'review', description: 'Check declared outputs.', files: {
        'SKILL.md': '---\nname: review\ndescription: Check declared outputs.\n---\n# Review\n\nDo not invent scores; use the frozen criteria.', 'refs/notes.txt': 'Reusable notes.',
      } } }, ...bindEntry({ skills: ['skill:review'] }),
    ]) })
    await assert.rejects(submitMethodPatch({ service, actor, roundId: 'round:fixture', value: patch([]) }), /formal proposal/)
    const result = await precheckMethodPatch({ service, actor, roundId: 'round:fixture' })
    assert.equal(result.accepted, true)
    assert.equal(service.facts().filter(fact => fact.type === 'method/registered').length, 1)
    assert.equal(service.facts().filter(fact => fact.type === 'rsi/candidate-ready').length, 1)
    assert.equal(service.facts().filter(fact => fact.type === 'rsi/proposal-submitted').at(0)?.data.patch.digest, proposal.digest)
    assert.deepEqual((await service.methodRoundState()).productionHead, base)
    assert.deepEqual(result.candidate.parent, base)
    assert.equal(result.candidate.entryTemplateId, 'template:root')
    assert.deepEqual(result.candidate.templates[0]?.skills, ['skill:review'])
    assert.deepEqual(result.candidate.templates[0]?.acceptancePolicy, acceptance)
    assert.deepEqual(result.candidate.templates[0]?.instanceSchema, DEFAULT_TASK_PROPOSAL_INSTANCE_SCHEMA)
  })
})

void test('MCP draft uses existing manifest/config/capability checks without scanning source semantics', async () => {
  await withRound(async (service) => {
    await submitMethodPatch({ service, actor, roundId: 'round:fixture', value: patch([{ op: 'put-mcp-server', server: {
      id: 'tool:review', name: 'review', description: 'A bounded review MCP server.', kind: 'mcp-server', server: {
        files: { 'server.mjs': "import { exec } from 'node:child_process';\n// The deployment capability controls actual execution.\n" },
        manifest: { v: 1, serverName: 'review', transport: 'stdio', capabilities: ['tools'], instructions: 'Review the current output.', entrypoint: 'server.mjs', limits: { maxBundleBytes: 1024 * 1024, maxInstructionBytes: 8192, toolCallTimeoutMs: 1000 } },
        config: { v: 1, serverName: 'review', transport: 'stdio', command: 'node', args: ['server.mjs'], cwd: '.', env: {}, toolCallTimeoutMs: 1000, maxInstructionBytes: 8192, failOnStartupError: true, reconnect: { enabled: false } },
        transport: 'stdio', capabilities: ['tools'], exposedTools: [{ name: 'review', description: 'Review the output.', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
      },
    } }, ...bindEntry({ tools: ['tool:review'] })]) })
    const result = await precheckMethodPatch({ service, actor, roundId: 'round:fixture' })
    assert.equal(result.accepted, true, canonicalize(result))
  })
})

void test('rewriting identical skill files with new host-generated refs remains a no-op', async () => {
  const text = '# Review\n\nCheck the declared output.'
  await withRound(async (service) => {
    await submitMethodPatch({ service, actor, roundId: 'round:fixture', value: patch([{
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
  { name: 'entry-unreachable skill', changes: [{ op: 'put-skill', skill: { id: 'skill:a', name: 'review', description: 'Review.', files: { 'SKILL.md': '# Reusable algorithm' } } }], reason: /no-op/ },
  { name: 'dangling entry', changes: [{ op: 'set-entry', templateId: 'template:absent' }], reason: /dangling/ },
  { name: 'duplicate operations', changes: [{ op: 'set-entry', templateId: null }, { op: 'set-entry', templateId: null }], reason: /repeats/ },
] satisfies readonly { readonly name: string; readonly changes: MethodPatch['changes']; readonly reason: RegExp }[]) {
  void test(`precheck rejects ${scenario.name} with a receipt and no candidate publication`, async () => {
    await withRound(async (service, base) => {
      await submitMethodPatch({ service, actor, roundId: 'round:fixture', value: patch(scenario.changes) })
      const result = await precheckMethodPatch({ service, actor, roundId: 'round:fixture' })
      assert.equal(result.accepted, false)
      assert.match(result.reason, scenario.reason)
      assert.equal(service.facts().filter(fact => fact.type === 'rsi/candidate-ready').length, 0)
      assert.equal((await service.methodRoundState()).rounds.get('round:fixture')?.closed?.outcome, 'rejected')
      assert.deepEqual((await service.methodRoundState()).productionHead, base)
    })
  })
}

void test('model cannot submit fixed template outputs or criteria, leaving the Round open', async () => {
  await withRound(async (service, base) => {
    for (const field of ['requiredOutputs', 'requiredCriteria']) {
      await assert.rejects(submitMethodPatch({ service, actor, roundId: 'round:fixture', value: patch([
        { op: 'put-template', template: { ...templateDraft(), [field]: [] } },
      ]) }))
    }
    assert.equal(service.facts().some(fact => fact.type === 'rsi/proposal-submitted' || fact.type === 'rsi/round-closed'), false)
    assert.deepEqual((await service.methodRoundState()).productionHead, base)
  })
})

void test('precheck propagates CAS failure without recording a rejected candidate or closing the Round', async () => {
  await withRound(async (service) => {
    await submitMethodPatch({ service, actor, roundId: 'round:fixture', value: patch([
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
