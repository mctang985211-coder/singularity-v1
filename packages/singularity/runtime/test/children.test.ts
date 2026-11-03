import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalize, sealEvidence, sealPublicReceipt, sealTaskContract } from '@singularity/protocol'
import type { Ref, TaskState } from '@singularity/protocol'

import { readChildData } from '../src/children.ts'
import type { DirectChildren } from '../src/children.ts'
import { CommandService } from '../src/service.ts'

void test('parent reads public child Evidence while the private receipt stays outside its object authorization', async t => {
  const root = await mkdtemp(join(tmpdir(), 'singularity-child-evidence-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = await CommandService.open({ root, actor: { kind: 'runtime', id: 'child-read-test' }, clock: () => 1000 })
  t.after(() => service.close())
  const ref = (id: string): Ref => ({ id, digest: `sha256:${'a'.repeat(64)}` })
  const contract = sealTaskContract({
    v: 1, taskId: 'child', method: ref('method'), template: ref('template'),
    spec: { goal: { summary: 'Child work', deliverable: 'Result', scope: [], constraints: [] }, criteria: [], inputs: [], outputs: [] },
    origin: { kind: 'child', parentId: 'parent', parentRunId: 'parent-run', batchId: 'batch', bindingId: 'work' },
    resources: { baseTools: [], skills: [], mcpServers: [] }, acceptance: ref('verifier'),
    environment: { seed: ref('seed'), profile: ref('profile') },
    limits: { maxRuns: 1, maxStepsPerRun: 2, maxTokens: 1000, deadlineAt: 5000, maxDepth: 1, maxTasks: 1, maxBatchChildren: 1 },
  })
  const privateReceipt = await service.putObject('private-receipt', new TextEncoder().encode('private verifier details'))
  const finding = `${'Observed boundary evidence. '.repeat(1000)}Fix the reset handshake.`
  const receipt = sealPublicReceipt({ v: 1, provider: contract.acceptance, operationId: 'child-run:verify',
    contractDigest: contract.digest, inputDigests: [], outputDigests: [], criteria: [{ id: 'boundary', verdict: 'fail', reason: finding }], exit: { code: 0, signal: null }, timedOut: false })
  const publicReceipt = await service.putObject('public-receipt', new TextEncoder().encode(canonicalize(receipt)))
  const evidence = sealEvidence({
    v: 1, task: { id: contract.taskId, digest: contract.digest }, runId: 'child-run', contractDigest: contract.digest,
    method: contract.method, inputs: [], outputs: [], composition: ref('composition'),
    verification: { provider: contract.acceptance, operationId: 'child-run:verify', publicReceipt, privateReceipt },
    usage: { inputTokens: 10, outputTokens: 2, steps: 1, unknownRequests: 0 },
    sessionCut: { sessionId: 'child-session', from: 0, to: 1 }, environment: { seed: contract.environment.seed.digest, mode: 'workspace' },
  })
  const evidenceRef = await service.putObject('child-evidence', new TextEncoder().encode(canonicalize(evidence)), 'evidence')
  const task: TaskState = { taskId: 'child', contract, rootTaskId: 'parent', parentTaskId: 'parent',
    parentRunId: 'parent-run', depth: 1, phase: 'closed', runIds: ['child-run'], childIds: [],
    closed: { outcome: 'verified', reason: 'verified', source: 'task/closed', factDigest: ref('closure').digest } }
  const children: DirectChildren = { results: [{ task, evidenceRef, outputs: [] }], inputs: [], requiredFailure: false,
    view: { requiredObligations: [], childBatch: null, childHistory: { total: 1, outcomes: { verified: 1 } }, recentChildResults: [] } }
  let text = '', cursor: string | undefined, pages = 0
  do {
    const result = await readChildData(service, children, [], { kind: 'evidence', id: task.taskId, ...(cursor === undefined ? {} : { cursor }) })
    assert.equal(typeof result.data, 'string')
    assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength < 16 * 1024)
    text += result.data as string
    cursor = result.nextCursor
    pages++
  } while (cursor !== undefined)
  assert.ok(pages > 1, 'long independent findings use bounded pages')
  const payload = JSON.parse(text) as { publicReceipt: typeof receipt }
  assert.equal(payload.publicReceipt.criteria[0]?.reason, finding)
  assert.ok(text.includes(publicReceipt.id))
  assert.ok(!text.includes('privateReceipt'))
  assert.ok(!text.includes(privateReceipt.id))
  await assert.rejects(readChildData(service, children, [], { kind: 'evidence', id: 'unrelated-run' }), { code: 'INPUT_NOT_AUTHORIZED' })
  await assert.rejects(readChildData(service, children, [], { kind: 'resource', id: privateReceipt.id }), { code: 'INPUT_NOT_AUTHORIZED' })
  assert.ok(new TextDecoder().decode((await service.readObject(evidenceRef, 'evidence')).bytes).includes(privateReceipt.id))
})
