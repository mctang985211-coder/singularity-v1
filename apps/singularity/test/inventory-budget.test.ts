import assert from 'node:assert/strict'
import { access,mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalize,parseJsonText,parseProtocolValue,taskContractSchema } from '@singularity/protocol'

import { DomainStore } from '@singularity/runtime'

import { resolveInventoryValidationBudget,runInventoryValidation } from '../examples/inventory-validation.ts'
import { startChatCompletionsFixture } from './fixtures/chat-completions.ts'

void test('validation configuration keeps the cumulative deadline and validates host budget overrides', () => {
  const startedAt = 1_000
  const original = resolveInventoryValidationBudget({}, startedAt, 2_000)
  assert.equal(original.maxOutputTokens, 40_000)
  const configured = resolveInventoryValidationBudget({
    maxRequests: 80, maxReportedTokens: 450_000, maxOutputTokens: 32_768, deadlineAt: 900_000,
    task: { maxTokens: 220_000, maxStepsPerRun: 32, maxRuns: 3, maxDepth: 5, maxTasks: 21, maxBatchChildren: 5 },
    proposerBudget: { maxTokens: 30_000 }, evaluationBudget: { maxActiveRuns: 2 },
  }, startedAt, 5_000)
  assert.equal(configured.deadlineAt, 900_000)
  assert.equal(configured.maxOutputTokens, 32_768)
  assert.deepEqual(configured.task, { maxTokens: 220_000, maxStepsPerRun: 32, maxRuns: 3, maxDepth: 5, maxTasks: 21, maxBatchChildren: 5 })
  assert.equal(configured.proposerBudget.maxTokens, 30_000)
  assert.equal(configured.evaluationBudget.maxActiveRuns, 2)
  assert.equal(resolveInventoryValidationBudget({}, startedAt, 2_000_000).deadlineAt, original.deadlineAt)
  for (const invalid of [{ maxRequests: 0 }, { task: { maxTokens: -1 } }, { task: { deadlineAt: 10 } }, { unexpected: true }]) {
    assert.throws(() => resolveInventoryValidationBudget(invalid, startedAt))
  }
})

void test('configured validation request cap retains prior counters, freezes new Task limits and saves effective budgets', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'inventory-budget-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const startedAt = Date.now() - 1_000
  await writeFile(join(root, 'result.json'), JSON.stringify({ startedAt, requestBoundaries: 9, usage: { tokens: 70, steps: 9, unknown: 0 } }))
  const fixture = await startChatCompletionsFixture(() => ({
    toolCalls: [{ id: 'budget-self', name: 'singularity_read', arguments: '{"kind":"self"}' }],
    usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 },
  }))
  t.after(() => fixture.close())
  const previousUrl = process.env.SINGULARITY_SPIKE_BASE_URL
  const previousKey = process.env.SINGULARITY_SPIKE_API_KEY
  process.env.SINGULARITY_SPIKE_BASE_URL = fixture.baseURL
  process.env.SINGULARITY_SPIKE_API_KEY = 'fixture-key'
  t.after(() => {
    if (previousUrl === undefined) delete process.env.SINGULARITY_SPIKE_BASE_URL
    else process.env.SINGULARITY_SPIKE_BASE_URL = previousUrl
    if (previousKey === undefined) delete process.env.SINGULARITY_SPIKE_API_KEY
    else process.env.SINGULARITY_SPIKE_API_KEY = previousKey
  })
  const output = join(root, 'next')
  const profilePatch = join(root, 'model.yml')
  await writeFile(profilePatch, `- id: llm-pi-ai
  config:
    providers:
      inventory-budget-provider:
        api: openai-completions
        apiKeyEnv: SINGULARITY_SPIKE_API_KEY
        baseURL: ${JSON.stringify(fixture.baseURL)}
        reasoning: max
        compat:
          supportsDeveloperRole: false
          supportsReasoningEffort: true
          supportsUsageInStreaming: true
          thinkingFormat: deepseek
        models:
          - id: inventory-budget-model
            name: Budget fixture model
            contextWindow: 512000
            maxTokens: 30000
            input: [text]
            reasoningEfforts:
              max: max
`)
  const deadlineAt = Date.now() + 120_000
  await assert.rejects(runInventoryValidation(output, 1, root, {
    maxRequests: 10, maxReportedTokens: 1_000, maxOutputTokens: 512, deadlineAt,
    provider: 'inventory-budget-provider', model: 'inventory-budget-model', profilePatches: [profilePatch], reasoningEffort: 'max',
    task: { maxTokens: 45_000, maxStepsPerRun: 32, maxRuns: 3, maxDepth: 5, maxTasks: 21, maxBatchChildren: 5 },
    proposerBudget: { maxTokens: 4_000 }, evaluationBudget: { maxTokens: 10_000 },
  }), /Decisive ExecutionRecord/)
  const result = parseJsonText(await readFile(join(output, 'result.json'), 'utf8'))
  assert.ok(result !== null && typeof result === 'object' && !Array.isArray(result))
  const effective = result.budget
  assert.ok(effective !== null && typeof effective === 'object' && !Array.isArray(effective))
  assert.equal(fixture.requests.length, 1)
  assert.equal(fixture.requests[0]?.max_completion_tokens, 512)
  assert.equal(fixture.requests[0]?.model, 'inventory-budget-model')
  assert.equal(result.startedAt, startedAt)
  assert.equal(result.requestBoundaries, 10)
  assert.equal(canonicalize(result.usage), canonicalize({ tokens: 84, steps: 10, unknown: 0 }))
  assert.equal(effective.deadlineAt, deadlineAt)
  assert.equal(effective.maxReportedTokens, 1_000)
  assert.equal(effective.maxOutputTokens, 512)
  assert.partialDeepStrictEqual(effective.task, { maxTokens: 45_000, maxStepsPerRun: 32 })
  const archive = await DomainStore.open(join(output, 'domain'))
  const facts = await archive.replay()
  await archive.close()
  const admitted = facts.find(fact => fact.type === 'task/admitted')
  assert.ok(admitted?.type === 'task/admitted')
  const contract = parseProtocolValue(taskContractSchema, parseJsonText(await readFile(
    join(output, 'domain', 'objects', admitted.data.contract.digest.slice('sha256:'.length)), 'utf8')))
  assert.equal(contract.limits.maxTokens, 45_000)
  assert.equal(contract.limits.maxStepsPerRun, 32)
  assert.equal(contract.limits.deadlineAt, deadlineAt)
  assert.equal(contract.limits.maxRuns, 3)
  assert.equal(contract.limits.maxDepth, 5)
  assert.equal(contract.limits.maxTasks, 21)
  assert.equal(contract.limits.maxBatchChildren, 5)
})

void test('invalid or exhausted launch conditions fail before creating output or booting a profile', async t => {
  const root = await mkdtemp(join(tmpdir(), 'inventory-preflight-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [name, previous, configuration] of [
    ['requests', { requestBoundaries: 10 }, { maxRequests: 10 }],
    ['tokens', { usage: { tokens: 100 } }, { maxReportedTokens: 100 }],
    ['unknown', { usage: { unknown: 1 } }, {}],
    ['negative', { requestBoundaries: -1 }, {}],
    ['deadline', {}, { deadlineAt: Date.now() - 1 }],
  ] as const) {
    const previousRoot = join(root, `${name}-previous`)
    await mkdir(previousRoot)
    await writeFile(join(previousRoot, 'result.json'), JSON.stringify(previous))
    const output = join(root, name)
    await assert.rejects(runInventoryValidation(output, 1, previousRoot, {
      ...configuration, profilePatches: [join(root, 'profile-must-not-be-opened.yml')],
    }), /budget|counter|deadline/i)
    await assert.rejects(access(output), { code: 'ENOENT' })
  }
})
