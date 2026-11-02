import assert from 'node:assert/strict'
import { chmod,copyFile,mkdtemp,mkdir,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import type { Ref } from '@singularity/protocol'
import { DomainStore } from '@singularity/runtime'

import { BUCKYBALL_RECIPE_REF,buckyballCheck } from '../examples/buckyball-checks.ts'
import { runBuckyballCampaign } from '../examples/buckyball-campaign.ts'
import { writeSyntheticBuckyballToolchain } from './fixtures/buckyball-evidence.ts'
import { messageTexts,startChatCompletionsFixture,toolNames,toolSchemaNames,wireText } from './fixtures/chat-completions.ts'

void test('synthetic BB app fixture reproduces checks, evaluates PPA reports, activates and consumes the new head without paid calls', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bb-success-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const baseline = join(directory, 'baseline'), prepared = join(directory, 'prepared'), root = join(directory, 'execution')
  await mkdir(prepared)
  for (const name of ['model-port', 'model-optimize', 'chip-designer', 'ip-designer', 'ball-align', 'workload-tests', 'debug-compiler', 'check', 'report']) {
    await mkdir(join(baseline, '.agents/skills', name), { recursive: true })
    await writeFile(join(baseline, '.agents/skills', name, 'SKILL.md'), `# ${name}\nSynthetic fixture technical reference.\n`)
  }
  const { project } = await writeSyntheticBuckyballToolchain(directory, baseline)
  await copyFile(project, join(prepared, 'project.json'))
  const bin = join(directory, 'bin')
  await mkdir(bin); await writeFile(join(bin, 'nix'), '#!/bin/sh\nexit 0\n'); await chmod(join(bin, 'nix'), 0o755)
  const reproduce = join(directory, 'reproduce.ts')
  await writeFile(reproduce, `import {readFile,mkdir} from 'node:fs/promises';\nimport {execFile} from 'node:child_process';\nimport {promisify} from 'node:util';\nimport {writeBuckyballEvidence} from ${JSON.stringify(fileURLToPath(new URL('./fixtures/buckyball-evidence.ts', import.meta.url)))};\nconst sourceText=await readFile('outputs/frontend/candidate.py','utf8');\nconst {factor}=JSON.parse(await readFile('outputs/frontend/design.json','utf8'));\nconst actual=(await promisify(execFile)('python3',['outputs/frontend/candidate.py'])).stdout;\nawait writeBuckyballEvidence('reproduced',{sourceText,actual,factor});\n`)
  const oldPath = process.env.PATH, oldUrl = process.env.SINGULARITY_SPIKE_BASE_URL, oldKey = process.env.SINGULARITY_SPIKE_API_KEY
  process.env.PATH = `${bin}:${oldPath ?? ''}`
  t.after(() => {
    for (const [name, value] of [['PATH', oldPath], ['SINGULARITY_SPIKE_BASE_URL', oldUrl], ['SINGULARITY_SPIKE_API_KEY', oldKey]] as const) {
      if (value === undefined) Reflect.deleteProperty(process.env, name); else process.env[name] = value
    }
  })
  let publishedConsumed = false, reviews = 0
  const fixture = await startChatCompletionsFixture((request, index) => {
    const texts = messageTexts(request).join('\n'), calls = toolNames(request)
    const call = (name: string, args: unknown) => ({ toolCalls: [{ id: `bb-success-${String(index)}`, name, arguments: JSON.stringify(args) }], usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } })
    if (toolSchemaNames(request).includes('buckyball_review_submit')) {
      assert.ok(toolSchemaNames(request).includes('skill'), 'the independent reviewer can load the same frozen skills as workers')
      if (!calls.includes('skill')) return call('skill', { name: 'model-port' })
      assert.match(texts, /Frontend/)
      if (!calls.includes('bash')) return call('bash', { description: 'Reproduce the synthetic candidate and synthesis fixture.', command: `${process.execPath} ${reproduce}` })
      reviews += 1
      return call('buckyball_review_submit', { result: { criteria: ['model-reference', 'design-contract', 'implementation', 'component-verification', 'ppa-evidence', 'delivery']
        .map(id => ({ id, verdict: 'pass', reason: 'Synthetic fixture reproduction ran candidate output and generated fixture synthesis reports; no hardware claim.' })) } })
    }
    if (toolSchemaNames(request).includes('rsi_submit_patch')) {
      if (!calls.includes('rsi_read')) return call('rsi_read', { kind: 'method' })
      const contractPages = (request.messages ?? []).filter(value => value.role === 'tool').map(value => JSON.parse(wireText(value.content)) as {
        data?: { format?: string; text?: string }; nextCursor?: string
      }).filter(value => value.data?.format === 'json')
      const lastContractPage = contractPages.at(-1)
      if (lastContractPage === undefined) return call('rsi_read', { kind: 'trace-page', id: 'contract', page: 0 })
      if (lastContractPage.nextCursor !== undefined) return call('rsi_read', { kind: 'trace-page', id: 'contract', cursor: lastContractPage.nextCursor })
      const sourceContract = JSON.parse(contractPages.map(page => page.data?.text).join('')) as { acceptance: Ref }
      const baseText = /"baseMethod":(\{"digest":"[^"]+","id":"[^"]+"\})/.exec(texts)?.[1]
      assert.ok(baseText)
      const round = /"roundId":"([^"]+)","sourceTrace":/.exec(texts)?.[1]
      assert.ok(round)
      return call('rsi_submit_patch', { patch: { v: 1, base: JSON.parse(baseText) as Ref, hypothesis: 'A reusable synthetic design guidance lowers the mocked synthesis factor while preserving actual numerical comparison.', predictedRisks: [], transferPlan: 'Synthetic fixture cases only.', changes: [
        { op: 'put-template', template: { id: 'bb-fixture-efficient', brief: 'Produce the synthetic finite fixture and retain all bound root checks.', guidance: `Use the synthetic fixture factor 0.5. ${round}`,
          example: { goal: { summary: 'Produce a local mapped numerical fixture.', deliverable: 'result/', scope: ['Synthetic local workflow.'], constraints: [] }, inputs: [], localCriteria: [], localOutputs: [], acceptanceChecks: [{ criterionId: 'task-goal', checks: [buckyballCheck('numerical')] }] },
          instanceSchema: {}, requiredCriteria: [{ id: 'task-goal', statement: 'The actual compiled numerical fixture passes.', required: true, checks: [] }], requiredOutputs: [{ id: 'result', path: 'result', kind: 'tree', role: 'deliverable', required: true }],
          acceptancePolicy: sourceContract.acceptance, children: [], skills: [], tools: [] } },
        { op: 'set-entry', templateId: 'bb-fixture-efficient' },
      ] } })
    }
    if (calls.length === 0) return call('singularity_read', { kind: 'self' })
    const pages = (request.messages ?? []).filter(value => value.role === 'tool').map(value => wireText(value.content)).filter(value => value.startsWith('{')).map(value => JSON.parse(value) as { data?: string; nextCursor?: string; contextEpoch: string }).filter(value => typeof value.data === 'string')
    const last = pages.at(-1)
    assert.ok(last)
    if (last.nextCursor !== undefined) return call('singularity_read', { kind: 'self', cursor: last.nextCursor })
    const self = JSON.parse(pages.map(page => page.data).join('')) as { taskId: string; runId: string; contextEpoch: string; contractDigest: string }
    const efficient = texts.includes('"ownTemplate":{"id":"bb-fixture-efficient"')
    if (self.taskId.endsWith(':published-work')) publishedConsumed = efficient
    if (!calls.includes('singularity_plan')) return call('singularity_plan', { sketch: { v: 1, taskId: self.taskId, runId: self.runId, contextEpoch: self.contextEpoch, sourceContract: self.contractDigest,
      objective: 'Produce an independently reproduced synthetic fixture.', levels: [0, 1].map(level => ({ level, purpose: 'Own the local synthetic numerical/interface result.', likelyChildren: [], expectedInputs: [], expectedOutputs: ['frontend/'] })), directPlan: [], assumptions: ['This test is synthetic.'] } })
    if (!calls.includes('bash')) return call('bash', { description: 'Produce the synthetic candidate and design fixture.', command: `mkdir -p frontend\nprintf '%s' 'import json; print(json.dumps([0,1,2,3]))' > frontend/candidate.py\nprintf '%s' '{"factor":${efficient ? '0.5' : '1'}}' > frontend/design.json` })
    return call('singularity_submit', { outputIds: ['frontend'], includeLearningDrafts: false })
  })
  t.after(() => fixture.close())
  process.env.SINGULARITY_SPIKE_BASE_URL = fixture.baseURL; process.env.SINGULARITY_SPIKE_API_KEY = 'fixture-key'
  await runBuckyballCampaign(root, prepared)
  const first = JSON.parse(await readFile(join(root, 'round-1.json'), 'utf8')) as { comparison?: { outcome: string }; activation?: unknown }
  assert.equal(first.comparison?.outcome, 'improved', JSON.stringify(first))
  assert.ok(first.activation)
  const third = JSON.parse(await readFile(join(root, 'round-3.json'), 'utf8')) as { comparison: { outcome: string; cost?: unknown } }
  assert.equal(third.comparison.outcome, 'no-improvement', 'a prior PPA comparison without optional cost remains readable by the next proposer')
  assert.equal(third.comparison.cost, undefined)
  assert.equal(publishedConsumed, true)
  assert.ok(reviews >= 8)
  const service = await DomainStore.open(join(root, 'domain'))
  try {
    const facts = await service.replay()
    assert.equal(facts.filter(fact => fact.type === 'method/activated').length, 2)
  } finally { await service.close() }
  assert.ok(BUCKYBALL_RECIPE_REF.digest.startsWith('sha256:'))
})
