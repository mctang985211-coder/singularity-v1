import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDigest, seal, verifyDigest } from '../src/digest.ts'
import { parseProtocolValue } from '../src/schema.ts'
import {
  contractSummaryRefSchema,
  contractSummarySchema,
  sealTaskContract,
  taskContractPayloadSchema,
  taskContractSchema,
  verifyTaskContract,
} from '../src/task.ts'
import type {
  ContractSummary,
  ContractSummaryRef,
  TaskChildOrigin,
  TaskContract,
  TaskContractPayload,
  TaskRootOrigin,
} from '../src/task.ts'

const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`
const digestC = `sha256:${'c'.repeat(64)}`
const digestD = `sha256:${'d'.repeat(64)}`

function ref(id: string, digest = digestA): { id: string; digest: string } {
  return { id, digest }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

const goal = {
  summary: 'Verify the frozen contract schema',
  deliverable: 'A sealed contract and passing tests',
  scope: ['protocol schemas', 'contract sealing'],
  constraints: ['no host effects', 'strict objects'],
}

const rootBody: TaskContractPayload = {
  v: 1,
  taskId: 'task-root',
  spec: {
    goal,
    criteria: [
      { id: 'contract-sealed', statement: 'The contract is sealed under the contract domain', required: true },
      { id: 'proposal-rejected', statement: 'Model-supplied binding fields are rejected', required: false },
    ],
    localGuidance: [{ id: 'local-trace', statement: 'Keep local notes traceable to this task' }],
    inputs: [
      { id: 'input-rtl', object: ref('obj-rtl', digestB), path: 'inputs/rtl.sv', access: 'read' },
      { id: 'input-copy', object: ref('obj-copy', digestC), path: 'inputs/copy.txt', access: 'copy-to-work' },
    ],
    outputs: [
      { id: 'result', path: 'outputs/result.json', kind: 'file', role: 'deliverable', required: true },
      { id: 'log', path: 'outputs/log', kind: 'tree', role: 'supporting', required: false },
    ],
  },
  origin: { kind: 'root', purpose: 'work', requestRef: ref('request-root', digestD) },
  method: ref('method-1', digestB),
  template: ref('template-1', digestC),
  resources: {
    baseTools: [ref('tool-read', digestA)],
    skills: [ref('skill-1', digestB)],
    mcpServers: [ref('mcp-1', digestC)],
    exploration: ref('exploration-1', digestD),
  },
  acceptance: ref('acceptance-1', digestA),
  environment: { seed: ref('seed-1', digestB), profile: ref('profile-1', digestC) },
  limits: {
    maxRuns: 2,
    maxStepsPerRun: 20,
    maxTokens: 100_000,
    deadlineAt: 1_800_000_000_000,
    maxDepth: 3,
    maxTasks: 8,
    maxBatchChildren: 4,
  },
}

const childBody: TaskContractPayload = {
  ...rootBody,
  taskId: 'task-child',
  origin: {
    kind: 'child',
    parentId: 'task-root',
    parentRunId: 'run-root-1',
    batchId: 'batch-1',
    bindingId: 'functional-simulation',
  },
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys)
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value).reverse()) {
      result[key] = reverseObjectKeys((value as Record<string, unknown>)[key])
    }
    return result
  }
  return value
}

function rootOriginOf(body: TaskContractPayload): TaskRootOrigin {
  if (body.origin.kind !== 'root') throw new Error('expected a root origin')
  return body.origin
}

function childOriginOf(body: TaskContractPayload): TaskChildOrigin {
  if (body.origin.kind !== 'child') throw new Error('expected a child origin')
  return body.origin
}

function firstLocalGuidance(body: TaskContractPayload) {
  const first = body.spec.localGuidance?.[0]
  if (first === undefined) throw new Error('expected local guidance')
  return first
}

function explorationOf(body: TaskContractPayload) {
  const { exploration } = body.resources
  if (exploration === undefined) throw new Error('expected an exploration ref')
  return exploration
}

interface Tampering {
  readonly label: string
  readonly mutate: (body: TaskContractPayload) => void
}

const tamperings: readonly Tampering[] = [
  { label: 'taskId', mutate: body => { body.taskId = 'task-other' } },
  { label: 'spec.goal.summary', mutate: body => { body.spec.goal.summary += ' changed' } },
  { label: 'spec.goal.deliverable', mutate: body => { body.spec.goal.deliverable += ' changed' } },
  { label: 'spec.goal.scope[0]', mutate: body => { body.spec.goal.scope[0] = 'changed scope' } },
  { label: 'spec.goal.constraints[0]', mutate: body => { body.spec.goal.constraints[0] = 'changed constraint' } },
  { label: 'spec.criteria[0].id', mutate: body => { body.spec.criteria[0].id = 'changed-criterion' } },
  { label: 'spec.criteria[0].statement', mutate: body => { body.spec.criteria[0].statement += ' changed' } },
  { label: 'spec.criteria[0].required', mutate: body => { body.spec.criteria[0].required = false } },
  { label: 'spec.localGuidance[0].id', mutate: body => { firstLocalGuidance(body).id = 'changed-guidance' } },
  { label: 'spec.localGuidance[0].statement', mutate: body => { firstLocalGuidance(body).statement += ' changed' } },
  { label: 'spec.inputs[0].id', mutate: body => { body.spec.inputs[0].id = 'changed-input' } },
  { label: 'spec.inputs[0].object.id', mutate: body => { body.spec.inputs[0].object.id = 'changed-object' } },
  { label: 'spec.inputs[0].object.digest', mutate: body => { body.spec.inputs[0].object.digest = digestD } },
  { label: 'spec.inputs[0].path', mutate: body => { body.spec.inputs[0].path = 'inputs/other.sv' } },
  { label: 'spec.inputs[0].access', mutate: body => { body.spec.inputs[0].access = 'copy-to-work' } },
  { label: 'spec.outputs[0].id', mutate: body => { body.spec.outputs[0].id = 'changed-output' } },
  { label: 'spec.outputs[0].path', mutate: body => { body.spec.outputs[0].path = 'outputs/other.json' } },
  { label: 'spec.outputs[0].kind', mutate: body => { body.spec.outputs[0].kind = 'tree' } },
  { label: 'spec.outputs[0].role', mutate: body => { body.spec.outputs[0].role = 'supporting' } },
  { label: 'spec.outputs[0].required', mutate: body => { body.spec.outputs[0].required = false } },
  { label: 'origin.purpose', mutate: body => { rootOriginOf(body).purpose = 'evaluation' } },
  { label: 'origin.requestRef.id', mutate: body => { rootOriginOf(body).requestRef.id = 'changed-request' } },
  { label: 'origin.requestRef.digest', mutate: body => { rootOriginOf(body).requestRef.digest = digestA } },
  { label: 'method.id', mutate: body => { body.method.id = 'changed-method' } },
  { label: 'method.digest', mutate: body => { body.method.digest = digestD } },
  { label: 'template.id', mutate: body => { body.template.id = 'changed-template' } },
  { label: 'template.digest', mutate: body => { body.template.digest = digestD } },
  { label: 'resources.baseTools[0].id', mutate: body => { body.resources.baseTools[0].id = 'changed-tool' } },
  { label: 'resources.baseTools[0].digest', mutate: body => { body.resources.baseTools[0].digest = digestD } },
  { label: 'resources.skills[0].id', mutate: body => { body.resources.skills[0].id = 'changed-skill' } },
  { label: 'resources.skills[0].digest', mutate: body => { body.resources.skills[0].digest = digestA } },
  { label: 'resources.mcpServers[0].id', mutate: body => { body.resources.mcpServers[0].id = 'changed-server' } },
  { label: 'resources.mcpServers[0].digest', mutate: body => { body.resources.mcpServers[0].digest = digestA } },
  { label: 'resources.exploration.id', mutate: body => { explorationOf(body).id = 'changed-exploration' } },
  { label: 'resources.exploration.digest', mutate: body => { explorationOf(body).digest = digestA } },
  { label: 'acceptance.id', mutate: body => { body.acceptance.id = 'changed-acceptance' } },
  { label: 'acceptance.digest', mutate: body => { body.acceptance.digest = digestB } },
  { label: 'environment.seed.id', mutate: body => { body.environment.seed.id = 'changed-seed' } },
  { label: 'environment.seed.digest', mutate: body => { body.environment.seed.digest = digestA } },
  { label: 'environment.profile.id', mutate: body => { body.environment.profile.id = 'changed-profile' } },
  { label: 'environment.profile.digest', mutate: body => { body.environment.profile.digest = digestA } },
  { label: 'limits.maxRuns', mutate: body => { body.limits.maxRuns += 1 } },
  { label: 'limits.maxStepsPerRun', mutate: body => { body.limits.maxStepsPerRun += 1 } },
  { label: 'limits.maxTokens', mutate: body => { body.limits.maxTokens += 1 } },
  { label: 'limits.deadlineAt', mutate: body => { body.limits.deadlineAt += 1 } },
  { label: 'limits.maxDepth', mutate: body => { body.limits.maxDepth += 1 } },
  { label: 'limits.maxTasks', mutate: body => { body.limits.maxTasks += 1 } },
  { label: 'limits.maxBatchChildren', mutate: body => { body.limits.maxBatchChildren += 1 } },
]

const childTamperings: readonly Tampering[] = [
  { label: 'origin.parentId', mutate: body => { childOriginOf(body).parentId = 'task-other' } },
  { label: 'origin.parentRunId', mutate: body => { childOriginOf(body).parentRunId = 'run-other' } },
  { label: 'origin.batchId', mutate: body => { childOriginOf(body).batchId = 'batch-other' } },
  { label: 'origin.bindingId', mutate: body => { childOriginOf(body).bindingId = 'binding-other' } },
]

const incompleteMutations: readonly Tampering[] = [
  { label: 'missing v', mutate: body => { delete (body as unknown as Record<string, unknown>)['v'] } },
  { label: 'missing taskId', mutate: body => { delete (body as unknown as Record<string, unknown>)['taskId'] } },
  { label: 'missing spec', mutate: body => { delete (body as unknown as Record<string, unknown>)['spec'] } },
  { label: 'missing spec.goal', mutate: body => { delete (body.spec as unknown as Record<string, unknown>)['goal'] } },
  { label: 'missing goal.summary', mutate: body => { delete (body.spec.goal as unknown as Record<string, unknown>)['summary'] } },
  { label: 'missing spec.criteria', mutate: body => { delete (body.spec as unknown as Record<string, unknown>)['criteria'] } },
  { label: 'missing spec.inputs', mutate: body => { delete (body.spec as unknown as Record<string, unknown>)['inputs'] } },
  { label: 'missing spec.outputs', mutate: body => { delete (body.spec as unknown as Record<string, unknown>)['outputs'] } },
  { label: 'missing origin', mutate: body => { delete (body as unknown as Record<string, unknown>)['origin'] } },
  { label: 'missing method', mutate: body => { delete (body as unknown as Record<string, unknown>)['method'] } },
  { label: 'missing template', mutate: body => { delete (body as unknown as Record<string, unknown>)['template'] } },
  { label: 'missing resources', mutate: body => { delete (body as unknown as Record<string, unknown>)['resources'] } },
  { label: 'missing resources.baseTools', mutate: body => { delete (body.resources as unknown as Record<string, unknown>)['baseTools'] } },
  { label: 'missing acceptance', mutate: body => { delete (body as unknown as Record<string, unknown>)['acceptance'] } },
  { label: 'missing environment', mutate: body => { delete (body as unknown as Record<string, unknown>)['environment'] } },
  { label: 'missing environment.seed', mutate: body => { delete (body.environment as unknown as Record<string, unknown>)['seed'] } },
  { label: 'missing environment.profile', mutate: body => { delete (body.environment as unknown as Record<string, unknown>)['profile'] } },
  { label: 'missing limits', mutate: body => { delete (body as unknown as Record<string, unknown>)['limits'] } },
  { label: 'missing limits.maxTokens', mutate: body => { delete (body.limits as unknown as Record<string, unknown>)['maxTokens'] } },
]

const unknownFieldMutations: readonly Tampering[] = [
  { label: 'unknown top-level field', mutate: body => { (body as unknown as Record<string, unknown>)['unexpected'] = true } },
  { label: 'unknown spec field', mutate: body => { (body.spec as unknown as Record<string, unknown>)['unexpected'] = true } },
  { label: 'unknown goal field', mutate: body => { (body.spec.goal as unknown as Record<string, unknown>)['unexpected'] = true } },
  { label: 'unknown criterion field', mutate: body => { (body.spec.criteria[0] as unknown as Record<string, unknown>)['unexpected'] = true } },
  { label: 'unknown localGuidance field', mutate: body => { (firstLocalGuidance(body) as unknown as Record<string, unknown>)['unexpected'] = true } },
  { label: 'unknown input field', mutate: body => { (body.spec.inputs[0] as unknown as Record<string, unknown>)['unexpected'] = true } },
  { label: 'unknown input object field', mutate: body => { (body.spec.inputs[0].object as unknown as Record<string, unknown>)['unexpected'] = true } },
  { label: 'unknown output field', mutate: body => { (body.spec.outputs[0] as unknown as Record<string, unknown>)['unexpected'] = true } },
  { label: 'unknown root origin field', mutate: body => { (body.origin as unknown as Record<string, unknown>)['parentId'] = 'task-root' } },
  { label: 'unknown method ref field', mutate: body => { (body.method as unknown as Record<string, unknown>)['unexpected'] = true } },
  { label: 'unknown resources field', mutate: body => { (body.resources as unknown as Record<string, unknown>)['unexpected'] = true } },
  { label: 'unknown asset ref field', mutate: body => { (body.resources.skills[0] as unknown as Record<string, unknown>)['unexpected'] = true } },
  { label: 'unknown environment field', mutate: body => { (body.environment as unknown as Record<string, unknown>)['unexpected'] = true } },
  { label: 'unknown limits field', mutate: body => { (body.limits as unknown as Record<string, unknown>)['unexpected'] = true } },
]

void test('seals complete root and child contracts under the contract digest domain', () => {
  const body: TaskContractPayload = rootBody
  const sealedRoot: TaskContract = sealTaskContract(body)
  const sealedChild: TaskContract = sealTaskContract(childBody)

  assert.equal(sealedRoot.digest, computeDigest('contract', rootBody))
  assert.notEqual(sealedChild.digest, sealedRoot.digest)
  assert.equal(verifyTaskContract(sealedRoot), true)
  assert.equal(verifyTaskContract(sealedChild), true)
  assert.equal(verifyDigest('contract', sealedRoot), true)
  assert.equal(verifyDigest('fact', sealedRoot), false)
  assert.deepEqual(sealedRoot.spec, rootBody.spec)
  assert.equal(sealedChild.origin.kind, 'child')
  assert.equal(childOriginOf(sealedChild).bindingId, 'functional-simulation')
  assert.deepEqual(parseProtocolValue(taskContractSchema, sealedRoot), sealedRoot)
  assert.throws(() => parseProtocolValue(taskContractPayloadSchema, sealedRoot))
})

void test('object key insertion order does not change the contract digest', () => {
  const reversed = reverseObjectKeys(rootBody) as TaskContractPayload
  const sealed = sealTaskContract(rootBody)
  const sealedReversed = sealTaskContract(reversed)

  assert.equal(sealedReversed.digest, sealed.digest)
  assert.deepEqual(sealedReversed, sealed)
})

void test('sealTaskContract rejects partial payloads and outermost digest fields', () => {
  assert.throws(() => sealTaskContract({ v: 1, taskId: 'partial' }))
  const sealed = sealTaskContract(rootBody)
  assert.throws(() => sealTaskContract(sealed))

  for (const { label, mutate } of incompleteMutations) {
    const body = clone(rootBody)
    mutate(body)
    assert.throws(() => sealTaskContract(body), label)
  }

  const missingBinding = clone(childBody)
  delete (missingBinding.origin as unknown as Record<string, unknown>)['bindingId']
  assert.throws(() => sealTaskContract(missingBinding))
})

void test('sealTaskContract preserves supplied field and array order without merging or appending', () => {
  const body = clone(rootBody)
  delete (body.spec as unknown as Record<string, unknown>)['localGuidance']
  delete (body.resources as unknown as Record<string, unknown>)['exploration']

  const original = sealTaskContract(rootBody)
  const sealed = sealTaskContract(body)

  assert.equal('localGuidance' in sealed.spec, false)
  assert.equal('exploration' in sealed.resources, false)
  assert.equal(sealed.spec.criteria.length, rootBody.spec.criteria.length)
  assert.equal(sealed.spec.outputs.length, rootBody.spec.outputs.length)
  assert.deepEqual(sealed.spec.criteria.map(criterion => criterion.id), ['contract-sealed', 'proposal-rejected'])
  assert.deepEqual(sealed.spec.outputs.map(output => output.id), ['result', 'log'])

  const reordered = clone(rootBody)
  reordered.spec.criteria.reverse()
  reordered.spec.goal.scope.reverse()
  const sealedReordered = sealTaskContract(reordered)

  assert.deepEqual(sealedReordered.spec.criteria.map(criterion => criterion.id), ['proposal-rejected', 'contract-sealed'])
  assert.deepEqual(sealedReordered.spec.goal.scope, ['contract sealing', 'protocol schemas'])
  assert.notEqual(sealedReordered.digest, original.digest)
})

void test('every contract field is covered by the contract digest', () => {
  const sealedRoot = sealTaskContract(rootBody)
  for (const { label, mutate } of tamperings) {
    const resealedBody = clone(rootBody)
    mutate(resealedBody)
    const resealed = sealTaskContract(resealedBody)
    assert.equal(verifyTaskContract(resealed), true, `${label}: resealed contract must verify`)

    const tampered = clone(sealedRoot) as unknown as TaskContractPayload
    mutate(tampered)
    assert.equal(verifyTaskContract(tampered), false, `${label}: tampering must invalidate the digest`)
  }

  const sealedChild = sealTaskContract(childBody)
  for (const { label, mutate } of childTamperings) {
    const resealedBody = clone(childBody)
    mutate(resealedBody)
    const resealed = sealTaskContract(resealedBody)
    assert.equal(verifyTaskContract(resealed), true, `${label}: resealed child contract must verify`)

    const tampered = clone(sealedChild) as unknown as TaskContractPayload
    mutate(tampered)
    assert.equal(verifyTaskContract(tampered), false, `${label}: child tampering must invalidate the digest`)
  }
})

void test('unknown fields at every object level are rejected even after rehashing', () => {
  for (const { label, mutate } of unknownFieldMutations) {
    const body = clone(rootBody)
    mutate(body)
    assert.throws(() => sealTaskContract(body), label)

    const rehashed = seal('contract', body)
    assert.equal(verifyTaskContract(rehashed), false, label)
  }

  const child = clone(childBody)
  ;(child.origin as unknown as Record<string, unknown>)['purpose'] = 'work'
  assert.throws(() => sealTaskContract(child))
  assert.equal(verifyTaskContract(seal('contract', child)), false)
})

void test('wrong versions, wrong domains, and malformed contracts are rejected', () => {
  const sealed = sealTaskContract(rootBody)

  assert.throws(() => sealTaskContract({ ...rootBody, v: 2 }))
  assert.equal(verifyTaskContract(seal('contract', { ...rootBody, v: 2 })), false)
  assert.equal(verifyTaskContract(seal('fact', rootBody)), false)
  assert.equal(verifyTaskContract({ ...sealed, digest: digestB }), false)
  assert.equal(verifyTaskContract({ ...sealed, taskId: 'task-other' }), false)
  assert.equal(verifyTaskContract(rootBody), false)
  assert.equal(verifyTaskContract(null), false)
  assert.equal(verifyTaskContract({}), false)
  assert.equal(verifyTaskContract([]), false)

  const withAccessor = {
    ...sealed,
    get taskId(): string {
      return sealed.taskId
    },
  }
  assert.equal(verifyTaskContract(withAccessor), false)
  assert.equal(
    verifyTaskContract({ ...sealed, spec: { ...sealed.spec, goal: { ...sealed.spec.goal, summary: undefined } } }),
    false,
  )
})

void test('root and child origin variants reject fields from the other variant', () => {
  const root: TaskRootOrigin = { kind: 'root', purpose: 'evaluation', requestRef: ref('request-1') }
  const child: TaskChildOrigin = {
    kind: 'child',
    parentId: 'task-parent',
    parentRunId: 'run-parent',
    batchId: 'batch-1',
    bindingId: 'binding-1',
  }
  const rootBodyWith = { ...rootBody, origin: root }
  const childBodyWith = { ...childBody, origin: child }

  assert.equal(verifyTaskContract(sealTaskContract(rootBodyWith)), true)
  assert.equal(verifyTaskContract(sealTaskContract(childBodyWith)), true)
  assert.throws(() => sealTaskContract({ ...rootBodyWith, origin: { ...root, parentId: 'task-parent' } }))
  assert.throws(() => sealTaskContract({ ...childBodyWith, origin: { ...child, purpose: 'work' } }))
  assert.throws(() => sealTaskContract({ ...rootBodyWith, origin: { ...root, kind: 'child' } }))
  assert.throws(() => sealTaskContract({ ...childBodyWith, origin: { ...child, kind: 'root' } }))
})

void test('ContractSummaryRef and ContractSummary are strict derived read-only schemas', () => {
  const contract = sealTaskContract(rootBody)
  const summaryRef: ContractSummaryRef = {
    object: ref('summary-object', digestB),
    sourceContract: contract.digest,
    schema: 'task-contract-summary/v1',
  }
  assert.deepEqual(parseProtocolValue(contractSummaryRefSchema, summaryRef), summaryRef)
  assert.throws(() => parseProtocolValue(contractSummaryRefSchema, { ...summaryRef, unexpected: true }))
  assert.throws(() => parseProtocolValue(contractSummaryRefSchema, { ...summaryRef, schema: 'task-contract-summary/v2' }))
  assert.throws(() => parseProtocolValue(contractSummaryRefSchema, { ...summaryRef, sourceContract: 'sha256:bad' }))

  const summary: ContractSummary = {
    v: 1,
    sourceContract: contract.digest,
    goal: rootBody.spec.goal.summary,
    acceptance: ['The contract is sealed under the contract domain'],
    constraints: [...rootBody.spec.goal.constraints],
    outputs: ['outputs/result.json'],
    frozenDecisions: ['Method and template refs are pinned'],
    sourceRefs: [
      { field: 'spec.criteria[0]', digest: digestB },
      { field: 'spec.outputs[0]', digest: digestC },
    ],
    generatedBy: 'contract-summary-worker',
  }
  assert.deepEqual(parseProtocolValue(contractSummarySchema, summary), summary)
  assert.throws(() => parseProtocolValue(contractSummarySchema, { ...summary, unexpected: true }))
  assert.throws(() => parseProtocolValue(contractSummarySchema, { ...summary, generatedBy: 'model' }))
  assert.throws(() => parseProtocolValue(contractSummarySchema, { ...summary, sourceRefs: [{ field: 'x', digest: digestA, unexpected: true }] }))
  assert.throws(() => parseProtocolValue(contractSummarySchema, { ...summary, digest: digestA }))
})

void test('ContractSummary parsing never writes back into the frozen contract', () => {
  const contract = sealTaskContract(rootBody)
  const before = clone(contract)
  const summary: ContractSummary = {
    v: 1,
    sourceContract: contract.digest,
    goal: 'Summary for the parent',
    acceptance: [],
    constraints: [],
    outputs: [],
    frozenDecisions: [],
    sourceRefs: [],
    generatedBy: 'contract-summary-worker',
  }

  parseProtocolValue(contractSummarySchema, summary)
  assert.deepEqual(contract, before)
  assert.equal(contract.digest, before.digest)
  assert.equal(verifyTaskContract(contract), true)
  assert.equal('contractSummary' in contract, false)
  assert.equal('summary' in contract, false)

  assert.throws(() => sealTaskContract({ ...rootBody, contractSummary: summary }))
  assert.throws(() => sealTaskContract({ ...rootBody, summaryRef: { object: ref('summary'), sourceContract: contract.digest, schema: 'task-contract-summary/v1' } }))
  assert.equal(verifyTaskContract(seal('contract', { ...rootBody, contractSummary: summary })), false)
})
