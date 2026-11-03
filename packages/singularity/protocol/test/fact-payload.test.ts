import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalize } from '../src/json.ts'
import { parseProtocolValue, protocolJsonSchema } from '../src/schema.ts'
import { sealTaskContract } from '../src/task.ts'
import {
  FACT_TYPES,
  childrenAdmittedPayloadSchema,
  factPayloadSchemaByType,
  methodActivatedPayloadSchema,
  methodRegisteredPayloadSchema,
  rsiCandidateReadyPayloadSchema,
  rsiProposalSubmittedPayloadSchema,
  rsiRoundClosedPayloadSchema,
  rsiRoundOpenedPayloadSchema,
  runClosedPayloadSchema,
  runClosedWithEvidencePayloadSchema,
  runClosedWithExecutionRecordPayloadSchema,
  runOpenedPayloadSchema,
  runSubmittedPayloadSchema,
  taskAdmittedPayloadSchema,
  taskClosedPayloadSchema,
  traceSealedPayloadSchema,
} from '../src/fact.ts'
import type {
  ChildrenAdmittedPayload,
  FactPayload,
  FactType,
  MethodActivatedPayload,
  MethodRegisteredPayload,
  RsiCandidateReadyPayload,
  RsiProposalSubmittedPayload,
  RsiRoundClosedPayload,
  RsiRoundOpenedPayload,
  RunClosedPayload,
  RunOpenedPayload,
  RunSubmittedPayload,
  TaskAdmittedPayload,
  TaskClosedPayload,
  TraceSealedPayload,
} from '../src/fact.ts'

const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`
const digestC = `sha256:${'c'.repeat(64)}`
const digestD = `sha256:${'d'.repeat(64)}`

function ref(id: string, digest = digestA): { readonly id: string; readonly digest: string } {
  return { id, digest }
}

const usage = {
  inputTokens: 120,
  outputTokens: 80,
  steps: 4,
  unknownRequests: 1,
  summary: {
    ownerTaskId: 'task-root',
    sourceContract: digestB,
    inputTokens: 20,
    outputTokens: 10,
    steps: 2,
    unknownRequests: 3,
  },
}

const budgetReservation = {
  tokens: 10_000,
  steps: 20,
  deadlineAt: 1_800_000_000_000,
}

const childContract = sealTaskContract({
  v: 1,
  taskId: 'task-child-1',
  spec: {
    goal: {
      summary: 'Produce one bounded child result',
      deliverable: 'A result file',
      scope: [],
      constraints: [],
    },
    criteria: [],
    inputs: [],
    outputs: [],
  },
  origin: {
    kind: 'child',
    parentId: 'task-root',
    parentRunId: 'run-root-1',
    batchId: 'batch-1',
    bindingId: 'binding-child-1',
  },
  method: ref('method-1', digestB),
  template: ref('template-1', digestC),
  resources: { baseTools: [], skills: [], mcpServers: [] },
  acceptance: ref('acceptance-1', digestD),
  environment: { seed: ref('seed-1', digestA), profile: ref('profile-1', digestB) },
  limits: {
    maxRuns: 1,
    maxStepsPerRun: 5,
    maxTokens: 1_000,
    deadlineAt: 1_800_000_000_000,
    maxDepth: 1,
    maxTasks: 1,
    maxBatchChildren: 1,
  },
})

const methodRegistered: MethodRegisteredPayload = {
  revision: ref('method-1', digestB),
  parent: ref('method-0', digestA),
  sourceProposal: ref('proposal-1', digestC),
}

const methodActivated: MethodActivatedPayload = {
  expectedPrevious: ref('method-1', digestB),
  previous: ref('method-1', digestB),
  next: ref('method-2', digestC),
  approval: ref('approval-1', digestD),
  evaluationRef: ref('evaluation-1', digestA),
}

const taskAdmitted: TaskAdmittedPayload = {
  taskId: 'task-root',
  contract: ref('contract-root', childContract.digest),
}

const runOpened: RunOpenedPayload = {
  taskId: 'task-root',
  runId: 'run-root-1',
  attempt: 1,
  sessionId: 'session-root-1',
  composition: ref('composition-1', digestA),
  workspaceKey: 'workspace-root-1',
  workspaceSeed: ref('seed-1', digestB),
  budgetReservation,
}

const childrenAdmitted: ChildrenAdmittedPayload = {
  parentRunId: 'run-root-1',
  batchId: 'batch-1',
  children: [
    {
      contract: childContract,
      join: 'required',
      budgetReservation,
      replacement: {
        feedbackRef: ref('feedback-1', digestC),
        supersedesChildIds: ['task-child-0'],
      },
    },
  ],
}

const runSubmitted: RunSubmittedPayload = {
  runId: 'run-root-1',
  outputs: ref('outputs-manifest-1', digestD),
  transcriptOffset: { sessionId: 'session-root-1', seq: 42 },
  previewReceipts: [ref('preview-receipt-1', digestA)],
  readReceipts: [ref('read-receipt-1', digestB)],
  planningSketchRef: ref('planning-sketch-1', digestC),
  feedbackRefs: [ref('feedback-1', digestD)],
}

const runClosedVerified: RunClosedPayload = {
  runId: 'run-root-1',
  classification: 'verified',
  reason: 'All required criteria passed',
  evidenceRef: ref('evidence-1', digestA),
  usage,
  planningSketchRef: ref('planning-sketch-1', digestB),
  feedbackRefs: [ref('feedback-1', digestC)],
}

const taskClosed: TaskClosedPayload = {
  taskId: 'task-root',
  outcome: 'cancelled',
  reason: 'Operator cancelled the subtree',
  decisiveRunId: 'run-root-1',
  evidenceRefs: [ref('evidence-1', digestA)],
  scope: 'subtree',
  cancellationCutRef: ref('cancellation-cut-1', digestB),
}

const traceSealed: TraceSealedPayload = {
  rootTaskId: 'task-root',
  trace: ref('trace-1', digestC),
  usage,
  sessionCuts: [{ sessionId: 'session-root-1', from: 0, to: 42 }],
}

const rsiRoundOpened: RsiRoundOpenedPayload = {
  roundId: 'round-1',
  sourceTrace: ref('trace-1', digestA),
  baseMethod: ref('method-1', digestB),
  plan: ref('round-plan-1', digestC),
  proposerSessionId: 'session-proposer-1',
}

const rsiProposalSubmitted: RsiProposalSubmittedPayload = {
  roundId: 'round-1',
  patch: ref('method-patch-1', digestD),
}

const rsiCandidateReady: RsiCandidateReadyPayload = {
  roundId: 'round-1',
  patch: ref('method-patch-1', digestA),
  precheckReceipt: ref('precheck-receipt-1', digestB),
  candidateMethod: ref('method-candidate-1', digestC),
}

const rsiRoundClosed: RsiRoundClosedPayload = {
  roundId: 'round-1',
  outcome: 'improved',
  comparisonRef: ref('comparison-1', digestD),
  precheckReceipt: ref('precheck-receipt-1', digestA),
  reason: 'Candidate improved the frozen comparison set',
}

const representativePayloads: readonly (readonly [FactType, FactPayload])[] = [
  ['method/registered', methodRegistered],
  ['method/activated', methodActivated],
  ['task/admitted', taskAdmitted],
  ['run/opened', runOpened],
  ['task/children-admitted', childrenAdmitted],
  ['run/submitted', runSubmitted],
  ['run/closed', runClosedVerified],
  ['task/closed', taskClosed],
  ['rsi/trace-sealed', traceSealed],
  ['rsi/round-opened', rsiRoundOpened],
  ['rsi/proposal-submitted', rsiProposalSubmitted],
  ['rsi/candidate-ready', rsiCandidateReady],
  ['rsi/round-closed', rsiRoundClosed],
]

void test('thirteen fact types each have one strict payload schema and a valid example', () => {
  assert.equal(FACT_TYPES.length, 13)
  assert.equal(new Set(FACT_TYPES).size, 13)
  assert.deepEqual(Object.keys(factPayloadSchemaByType).sort(), [...FACT_TYPES].sort())
  assert.equal(representativePayloads.length, 13)
  assert.deepEqual(representativePayloads.map(([type]) => type), [...FACT_TYPES])

  for (const [type, payload] of representativePayloads) {
    const parsed = parseProtocolValue(factPayloadSchemaByType[type], payload)
    assert.deepEqual(parsed, payload, type)
    assert.throws(
      () => parseProtocolValue(factPayloadSchemaByType[type], { ...payload, extra: true }),
      Error,
      `${type} must reject unknown fields`,
    )
  }
})

void test('every fact payload schema generates stable pure JSON Schema', () => {
  for (const type of FACT_TYPES) {
    const jsonSchema = protocolJsonSchema(factPayloadSchemaByType[type])
    if (type === 'run/closed') {
      assert.ok(Array.isArray(jsonSchema.anyOf), type)
    } else {
      assert.equal(jsonSchema.type, 'object', type)
      assert.equal(jsonSchema.additionalProperties, false, type)
    }
    assert.equal(canonicalize(jsonSchema), canonicalize(protocolJsonSchema(factPayloadSchemaByType[type])))
  }
})

void test('representative payload schemas reject missing required fields', () => {
  assert.throws(() => parseProtocolValue(methodRegisteredPayloadSchema, { parent: ref('method-0') }))
  assert.throws(() =>
    parseProtocolValue(methodActivatedPayloadSchema, {
      approval: ref('approval-1'),
    }),
  )
  assert.throws(() => parseProtocolValue(taskAdmittedPayloadSchema, { taskId: 'task-root' }))
  assert.throws(() => parseProtocolValue(runOpenedPayloadSchema, { ...runOpened, runId: undefined }))
  assert.throws(() =>
    parseProtocolValue(runSubmittedPayloadSchema, { ...runSubmitted, transcriptOffset: undefined }),
  )
  assert.throws(() => parseProtocolValue(taskClosedPayloadSchema, { ...taskClosed, outcome: undefined }))
  assert.throws(() => parseProtocolValue(traceSealedPayloadSchema, { ...traceSealed, usage: undefined }))
  assert.throws(() =>
    parseProtocolValue(rsiRoundOpenedPayloadSchema, { ...rsiRoundOpened, proposerSessionId: undefined }),
  )
  assert.throws(() => parseProtocolValue(rsiProposalSubmittedPayloadSchema, { roundId: 'round-1' }))
  assert.throws(() =>
    parseProtocolValue(rsiCandidateReadyPayloadSchema, { ...rsiCandidateReady, candidateMethod: undefined }),
  )
  assert.throws(() => parseProtocolValue(rsiRoundClosedPayloadSchema, { roundId: 'round-1' }))
})

void test('run/closed is a schema union with exactly one result reference and legal classification', () => {
  const base = {
    runId: 'run-root-1',
    reason: 'Run closed',
    usage,
    feedbackRefs: [ref('feedback-1', digestA)],
  }

  const variants: readonly RunClosedPayload[] = [
    { ...base, classification: 'verified', evidenceRef: ref('evidence-1', digestB) },
    { ...base, classification: 'failed', evidenceRef: ref('evidence-1', digestB) },
    { ...base, classification: 'failed', executionRecordRef: ref('execution-record-1', digestC) },
    { ...base, classification: 'invalid', executionRecordRef: ref('execution-record-1', digestC) },
    { ...base, classification: 'cancelled', executionRecordRef: ref('execution-record-1', digestC) },
  ]

  for (const variant of variants) {
    assert.deepEqual(parseProtocolValue(runClosedPayloadSchema, variant), variant)
  }

  assert.deepEqual(
    parseProtocolValue(runClosedWithEvidencePayloadSchema, variants[0]),
    variants[0],
  )
  assert.deepEqual(
    parseProtocolValue(runClosedWithExecutionRecordPayloadSchema, variants[2]),
    variants[2],
  )

  const invalid = [
    { ...base, classification: 'verified' },
    { ...base, classification: 'invalid' },
    { ...base, classification: 'cancelled' },
    {
      ...base,
      classification: 'verified',
      evidenceRef: ref('evidence-1', digestB),
      executionRecordRef: ref('execution-record-1', digestC),
    },
    { ...base, classification: 'verified', executionRecordRef: ref('execution-record-1', digestC) },
    { ...base, classification: 'invalid', evidenceRef: ref('evidence-1', digestB) },
    { ...base, classification: 'cancelled', evidenceRef: ref('evidence-1', digestB) },
    { ...base, classification: 'no-submission', executionRecordRef: ref('execution-record-1', digestC) },
    { ...base, classification: 'failed' },
    {
      ...base,
      classification: 'failed',
      evidenceRef: ref('evidence-1', digestB),
      extra: true,
    },
  ]

  for (const payload of invalid) {
    assert.throws(() => parseProtocolValue(runClosedPayloadSchema, payload))
  }

  const jsonSchema = protocolJsonSchema(runClosedPayloadSchema)
  assert.ok(Array.isArray(jsonSchema.anyOf))
})

void test('task/children-admitted keeps complete child contracts and host-owned binding fields', () => {
  const payload: ChildrenAdmittedPayload = {
    parentRunId: 'run-root-1',
    batchId: 'batch-1',
    children: [
      {
        contract: childContract,
        join: 'probe',
        budgetReservation,
      },
      {
        contract: childContract,
        join: 'required',
        budgetReservation,
        replacement: {
          feedbackRef: ref('feedback-1', digestA),
          supersedesChildIds: ['task-child-0', 'task-child-0b'],
        },
      },
    ],
  }

  const parsed = parseProtocolValue(childrenAdmittedPayloadSchema, payload)
  assert.deepEqual(parsed, payload)
  assert.equal(parsed.children[0]?.contract.digest, childContract.digest)
  assert.deepEqual(parsed.children[1]?.replacement?.supersedesChildIds, ['task-child-0', 'task-child-0b'])

  assert.throws(() =>
    parseProtocolValue(childrenAdmittedPayloadSchema, {
      ...payload,
      children: [{ contract: ref('contract-1'), join: 'required', budgetReservation }],
    }),
  )
  assert.throws(() =>
    parseProtocolValue(childrenAdmittedPayloadSchema, {
      ...payload,
      children: [{ contract: { ...childContract, digest: 'not-a-digest' }, join: 'required', budgetReservation }],
    }),
  )
  assert.throws(() =>
    parseProtocolValue(childrenAdmittedPayloadSchema, {
      ...payload,
      children: [{ contract: childContract, join: 'optional', budgetReservation }],
    }),
  )
  assert.throws(() =>
    parseProtocolValue(childrenAdmittedPayloadSchema, {
      ...payload,
      children: [
        {
          contract: childContract,
          join: 'required',
          budgetReservation,
          replacement: { feedbackRef: ref('feedback-1') },
        },
      ],
    }),
  )
  assert.throws(() =>
    parseProtocolValue(childrenAdmittedPayloadSchema, {
      ...payload,
      children: [
        {
          contract: childContract,
          join: 'required',
          budgetReservation,
          replacement: {
            feedbackRef: ref('feedback-1'),
            supersedesChildIds: ['task-child-0'],
            extra: true,
          },
        },
      ],
    }),
  )
  assert.throws(() =>
    parseProtocolValue(childrenAdmittedPayloadSchema, {
      ...payload,
      children: [{ contract: childContract, join: 'required', budgetReservation, extra: true }],
    }),
  )
})

void test('nested fact payload objects reject unknown fields and invalid nested shapes', () => {
  assert.throws(() =>
    parseProtocolValue(runOpenedPayloadSchema, {
      ...runOpened,
      budgetReservation: { ...budgetReservation, extra: true },
    }),
  )
  assert.throws(() =>
    parseProtocolValue(runSubmittedPayloadSchema, {
      ...runSubmitted,
      transcriptOffset: { ...runSubmitted.transcriptOffset, extra: true },
    }),
  )
  assert.throws(() =>
    parseProtocolValue(traceSealedPayloadSchema, {
      ...traceSealed,
      sessionCuts: [{ ...traceSealed.sessionCuts[0], extra: true }],
    }),
  )
  assert.throws(() =>
    parseProtocolValue(taskClosedPayloadSchema, {
      ...taskClosed,
      evidenceRefs: [ref('evidence-1'), { id: 'missing-digest' }],
    }),
  )
})
