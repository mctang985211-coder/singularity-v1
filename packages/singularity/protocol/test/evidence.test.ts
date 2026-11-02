import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDigest, seal } from '../src/digest.ts'
import {
  sealEvidence,
  validateEvidence,
  verifyEvidence,
} from '../src/acceptance.ts'
import type { EvidencePayload } from '../src/acceptance.ts'
import { sealTaskContract } from '../src/task.ts'
import type { TaskContract } from '../src/task.ts'

const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`
const digestC = `sha256:${'c'.repeat(64)}`

function makeContract(): TaskContract {
  return sealTaskContract({
    v: 1,
    taskId: 'task-evidence',
    spec: {
      goal: {
        summary: 'evidence test',
        deliverable: 'one evidence object',
        scope: [],
        constraints: [],
      },
      criteria: [{checks: [{checkId: 'criterion-a', recipeRef: {id:'fixture:check',digest:'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'},params:{}}], id: 'criterion-a', statement: 'pass', required: true }],
      inputs: [],
      outputs: [],
    },
    origin: { kind: 'root', purpose: 'work', requestRef: { id: 'request', digest: digestA } },
    method: { id: 'method', digest: digestB },
    template: { id: 'template', digest: digestB },
    resources: { baseTools: [], skills: [], mcpServers: [] },
    acceptance: { id: 'acceptance', digest: digestC },
    environment: {
      seed: { id: 'seed', digest: digestA },
      profile: { id: 'profile', digest: digestB },
    },
    limits: {
      maxRuns: 1,
      maxStepsPerRun: 10,
      maxTokens: 1000,
      deadlineAt: 10_000,
      maxDepth: 2,
      maxTasks: 10,
      maxBatchChildren: 2,
    },
  })
}

function makePayload(contract: TaskContract): EvidencePayload {
  return {
    v: 1,
    task: { id: contract.taskId, digest: contract.digest },
    runId: 'run-evidence',
    contractDigest: contract.digest,
    method: contract.method,
    inputs: [],
    outputs: [{ id: 'out', digest: digestC }],
    composition: { id: 'composition', digest: digestB },
    verification: {
      provider: { id: 'provider', digest: digestA },
      operationId: 'run-evidence:verify',
      publicReceipt: { id: 'receipt', digest: digestB },
    },
    usage: { inputTokens: 3, outputTokens: 2, steps: 1, unknownRequests: 0 },
    sessionCut: { sessionId: 'session-evidence', from: 0, to: 4 },
    environment: { seed: contract.environment.seed.digest, mode: 'workspace' },
  }
}

void test('Evidence seals in the evidence domain and validates identity', () => {
  const contract = makeContract()
  const evidence = sealEvidence(makePayload(contract))

  assert.equal(evidence.digest, computeDigest('evidence', evidence))
  assert.equal(verifyEvidence(evidence), true)
  assert.notEqual(evidence.digest, computeDigest('object', evidence))
  assert.equal(verifyEvidence(seal('object', makePayload(contract))), false)

  const validation = validateEvidence(evidence, {
    contract,
    runId: 'run-evidence',
    composition: { id: 'composition', digest: digestB },
  })
  assert.equal(validation.valid, true)
})

void test('Evidence rejects identity, domain, and strict-shape mismatches', () => {
  const contract = makeContract()
  const evidence = sealEvidence(makePayload(contract))

  for (const expected of [
    { contract, runId: 'other-run', composition: { id: 'composition', digest: digestB } },
    { contract, runId: 'run-evidence', composition: { id: 'composition', digest: digestA } },
  ]) {
    const result = validateEvidence(evidence, expected)
    assert.equal(result.valid, false)
  }

  const wrongTask = sealEvidence({
    ...makePayload(contract),
    task: { id: 'other-task', digest: contract.digest },
  })
  const taskValidation = validateEvidence(wrongTask, {
    contract,
    runId: 'run-evidence',
    composition: { id: 'composition', digest: digestB },
  })
  assert.equal(taskValidation.valid, false)

  assert.throws(() => sealEvidence({
    ...makePayload(contract),
    task: { id: contract.taskId, digest: digestA },
  }))

  assert.throws(() => sealEvidence({
    ...makePayload(contract),
    unknown: true,
  }))

  const tampered = { ...evidence, runId: 'tampered' }
  assert.equal(verifyEvidence(tampered), false)
  assert.equal(validateEvidence(tampered, {
    contract,
    runId: 'run-evidence',
    composition: { id: 'composition', digest: digestB },
  }).valid, false)
})
