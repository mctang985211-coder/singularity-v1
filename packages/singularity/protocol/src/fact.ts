import { z } from 'zod'

import { digestSchema, seal, verifyDigest } from './digest.ts'
import { refSchema } from './refs.ts'
import { closedObject, parseProtocolValue } from './schema.ts'
import { taskContractSchema } from './task.ts'

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER

/** Journal sequence numbers start at zero and remain safe integers. */
const sequenceSchema = z.number().int().min(0).max(MAX_SAFE_INTEGER)

/** Unix epoch milliseconds (UTC) as a non-negative safe integer. */
const epochMillisecondsSchema = z.number().int().min(0).max(MAX_SAFE_INTEGER)

/** Supporting usage counters from docs/framework.md §15.2. */
export const usageRecordSummarySchema = closedObject({
  ownerTaskId: z.string(),
  sourceContract: digestSchema,
  inputTokens: z.number(),
  outputTokens: z.number(),
  steps: z.number(),
  unknownRequests: z.number(),
})

export type UsageRecordSummary = z.infer<typeof usageRecordSummarySchema>

/** Known and unknown model usage; unknown is never asserted to be zero. */
export const usageRecordSchema = closedObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  steps: z.number(),
  unknownRequests: z.number(),
  summary: usageRecordSummarySchema.optional(),
})

export type UsageRecord = z.infer<typeof usageRecordSchema>

/** Inclusive/exclusive DSH session sequence cut. */
export const sessionCutSchema = closedObject({
  sessionId: z.string(),
  from: z.number(),
  to: z.number(),
})

export type SessionCut = z.infer<typeof sessionCutSchema>

/** Budget reserved for one Run or child admission. */
export const budgetReservationSchema = closedObject({
  tokens: z.number(),
  steps: z.number(),
  deadlineAt: epochMillisecondsSchema,
})

export type BudgetReservation = z.infer<typeof budgetReservationSchema>

/** ExecutionRecord body for no-submission, stop, cancellation, or infrastructure failure. */
export const executionRecordPayloadSchema = closedObject({
  v: z.literal(1),
  taskId: z.string(),
  runId: z.string(),
  contractDigest: digestSchema,
  method: refSchema,
  composition: refSchema,
  inputs: z.array(refSchema),
  outputs: z.array(refSchema).optional(),
  usage: usageRecordSchema,
  sessionCut: sessionCutSchema,
  reason: z.string(),
})

export type ExecutionRecordPayload = z.infer<typeof executionRecordPayloadSchema>

/** Sealed ExecutionRecord; its digest uses the object domain. */
export const executionRecordSchema = executionRecordPayloadSchema.extend({
  digest: digestSchema,
})

export type ExecutionRecord = z.infer<typeof executionRecordSchema>

/** Complete native MCP server identity inside a Composition. */
export const compositionMcpServerSchema = closedObject({
  manifest: refSchema,
  bundle: refSchema,
  schema: refSchema,
  config: refSchema,
  transport: z.enum(['stdio', 'streamable-http']),
  capabilities: z.array(z.string()),
})

export type CompositionMcpServer = z.infer<typeof compositionMcpServerSchema>

/** Composition body fixed before a Run starts. */
export const compositionPayloadSchema = closedObject({
  v: z.literal(1),
  dsh: closedObject({
    package: z.string(),
    version: z.string(),
    config: refSchema,
  }),
  platformPrompt: digestSchema,
  contract: refSchema,
  template: refSchema,
  guidance: refSchema.optional(),
  skills: z.array(refSchema),
  mcpServers: z.array(compositionMcpServerSchema),
  modelRoute: refSchema,
  resources: refSchema,
  seed: refSchema,
})

export type CompositionPayload = z.infer<typeof compositionPayloadSchema>

/** Sealed Composition; its digest uses the composition domain. */
export const compositionSchema = compositionPayloadSchema.extend({
  digest: digestSchema,
})

export type Composition = z.infer<typeof compositionSchema>

/** One descendant affected by a subtree cancellation. */
export const cancellationCutAffectedSchema = closedObject({
  taskId: z.string(),
  runId: z.string().optional(),
  executionRecordRef: refSchema.optional(),
})

export type CancellationCutAffected = z.infer<typeof cancellationCutAffectedSchema>

/** Immutable cancellation snapshot referenced by task/closed. */
export const cancellationCutPayloadSchema = closedObject({
  v: z.literal(1),
  targetTaskId: z.string(),
  affected: z.array(cancellationCutAffectedSchema),
})

export type CancellationCutPayload = z.infer<typeof cancellationCutPayloadSchema>

/** Sealed CancellationCut; its digest uses the object domain. */
export const cancellationCutSchema = cancellationCutPayloadSchema.extend({
  digest: digestSchema,
})

export type CancellationCut = z.infer<typeof cancellationCutSchema>

/** The thirteen closed fact types from docs/framework.md §10.2. */
export const FACT_TYPES = [
  'method/registered',
  'method/activated',
  'task/admitted',
  'run/opened',
  'task/children-admitted',
  'run/submitted',
  'run/closed',
  'task/closed',
  'rsi/trace-sealed',
  'rsi/round-opened',
  'rsi/proposal-submitted',
  'rsi/candidate-ready',
  'rsi/round-closed',
] as const

export const factTypeSchema = z.enum(FACT_TYPES)

export type FactType = z.infer<typeof factTypeSchema>

export const methodRegisteredPayloadSchema = closedObject({
  revision: refSchema,
  parent: refSchema.optional(),
  sourceProposal: refSchema.optional(),
})

export type MethodRegisteredPayload = z.infer<typeof methodRegisteredPayloadSchema>

export const methodActivatedPayloadSchema = closedObject({
  expectedPrevious: refSchema.optional(),
  previous: refSchema.optional(),
  next: refSchema,
  approval: refSchema,
  evaluationRef: refSchema.optional(),
})

export type MethodActivatedPayload = z.infer<typeof methodActivatedPayloadSchema>

export const taskAdmittedPayloadSchema = closedObject({
  taskId: z.string(),
  contract: refSchema,
})

export type TaskAdmittedPayload = z.infer<typeof taskAdmittedPayloadSchema>

export const runOpenedPayloadSchema = closedObject({
  taskId: z.string(),
  runId: z.string(),
  attempt: z.number(),
  sessionId: z.string(),
  composition: refSchema,
  workspaceKey: z.string(),
  workspaceSeed: refSchema,
  budgetReservation: budgetReservationSchema,
})

export type RunOpenedPayload = z.infer<typeof runOpenedPayloadSchema>

/** Host-derived replacement metadata for one admitted child. */
export const childReplacementSchema = closedObject({
  feedbackRef: refSchema,
  supersedesChildIds: z.array(z.string()),
})

export type ChildReplacement = z.infer<typeof childReplacementSchema>

/** One complete child contract plus host-derived join and budget. */
export const admittedChildSchema = closedObject({
  contract: taskContractSchema,
  join: z.enum(['required', 'probe']),
  budgetReservation: budgetReservationSchema,
  replacement: childReplacementSchema.optional(),
})

export type AdmittedChild = z.infer<typeof admittedChildSchema>

export const childrenAdmittedPayloadSchema = closedObject({
  parentRunId: z.string(),
  batchId: z.string(),
  children: z.array(admittedChildSchema),
})

export type ChildrenAdmittedPayload = z.infer<typeof childrenAdmittedPayloadSchema>

export const runSubmittedPayloadSchema = closedObject({
  runId: z.string(),
  outputs: refSchema,
  transcriptOffset: closedObject({
    sessionId: z.string(),
    seq: z.number(),
  }),
  previewReceipts: z.array(refSchema),
  readReceipts: z.array(refSchema),
  planningSketchRef: refSchema,
  feedbackRefs: z.array(refSchema),
})

export type RunSubmittedPayload = z.infer<typeof runSubmittedPayloadSchema>

const runClosedBaseShape = {
  runId: z.string(),
  reason: z.string(),
  usage: usageRecordSchema,
  planningSketchRef: refSchema.optional(),
  feedbackRefs: z.array(refSchema),
}

/** Verified or criteria-failed closure backed by Evidence. */
export const runClosedWithEvidencePayloadSchema = closedObject({
  ...runClosedBaseShape,
  classification: z.enum(['verified', 'failed']),
  evidenceRef: refSchema,
})

export type RunClosedWithEvidencePayload = z.infer<typeof runClosedWithEvidencePayloadSchema>

/** No-submission, stop, invalid, or cancelled closure backed by ExecutionRecord. */
export const runClosedWithExecutionRecordPayloadSchema = closedObject({
  ...runClosedBaseShape,
  classification: z.enum(['failed', 'invalid', 'cancelled']),
  executionRecordRef: refSchema,
})

export type RunClosedWithExecutionRecordPayload = z.infer<
  typeof runClosedWithExecutionRecordPayloadSchema
>

/** Exactly one result reference and a classification legal for that reference. */
export const runClosedPayloadSchema = z.union([
  runClosedWithEvidencePayloadSchema,
  runClosedWithExecutionRecordPayloadSchema,
])

export type RunClosedPayload = z.infer<typeof runClosedPayloadSchema>

export const taskClosedPayloadSchema = closedObject({
  taskId: z.string(),
  outcome: z.enum(['verified', 'failed', 'invalid', 'cancelled']),
  reason: z.string(),
  decisiveRunId: z.string().optional(),
  evidenceRefs: z.array(refSchema),
  scope: z.literal('subtree').optional(),
  cancellationCutRef: refSchema.optional(),
})

export type TaskClosedPayload = z.infer<typeof taskClosedPayloadSchema>

export const traceSealedPayloadSchema = closedObject({
  rootTaskId: z.string(),
  trace: refSchema,
  usage: usageRecordSchema,
  sessionCuts: z.array(sessionCutSchema),
})

export type TraceSealedPayload = z.infer<typeof traceSealedPayloadSchema>

export const rsiRoundOpenedPayloadSchema = closedObject({
  roundId: z.string(),
  sourceTrace: refSchema,
  baseMethod: refSchema,
  plan: refSchema,
  proposerSessionId: z.string(),
})

export type RsiRoundOpenedPayload = z.infer<typeof rsiRoundOpenedPayloadSchema>

export const rsiProposalSubmittedPayloadSchema = closedObject({
  roundId: z.string(),
  patch: refSchema,
})

export type RsiProposalSubmittedPayload = z.infer<typeof rsiProposalSubmittedPayloadSchema>

export const rsiCandidateReadyPayloadSchema = closedObject({
  roundId: z.string(),
  patch: refSchema,
  precheckReceipt: refSchema,
  candidateMethod: refSchema,
})

export type RsiCandidateReadyPayload = z.infer<typeof rsiCandidateReadyPayloadSchema>

export const rsiRoundClosedPayloadSchema = closedObject({
  roundId: z.string(),
  outcome: z.enum([
    'improved',
    'no-improvement',
    'insufficient-evidence',
    'rejected',
    'cancelled',
  ]),
  comparisonRef: refSchema.optional(),
  precheckReceipt: refSchema.optional(),
  reason: z.string().optional(),
})

export type RsiRoundClosedPayload = z.infer<typeof rsiRoundClosedPayloadSchema>

/** Single schema authority for one payload per fact type. */
export const factPayloadSchemaByType = {
  'method/registered': methodRegisteredPayloadSchema,
  'method/activated': methodActivatedPayloadSchema,
  'task/admitted': taskAdmittedPayloadSchema,
  'run/opened': runOpenedPayloadSchema,
  'task/children-admitted': childrenAdmittedPayloadSchema,
  'run/submitted': runSubmittedPayloadSchema,
  'run/closed': runClosedPayloadSchema,
  'task/closed': taskClosedPayloadSchema,
  'rsi/trace-sealed': traceSealedPayloadSchema,
  'rsi/round-opened': rsiRoundOpenedPayloadSchema,
  'rsi/proposal-submitted': rsiProposalSubmittedPayloadSchema,
  'rsi/candidate-ready': rsiCandidateReadyPayloadSchema,
  'rsi/round-closed': rsiRoundClosedPayloadSchema,
} as const satisfies Record<FactType, z.ZodType>

export type FactPayloadMap = {
  readonly [Type in FactType]: z.infer<(typeof factPayloadSchemaByType)[Type]>
}

export type FactPayload = FactPayloadMap[FactType]

export const factActorSchema = closedObject({
  kind: z.enum(['operator', 'runtime']),
  id: z.string(),
})

export type FactActor = z.infer<typeof factActorSchema>

function unsealedFactVariant<Type extends FactType, DataSchema extends z.ZodType>(
  type: Type,
  data: DataSchema,
) {
  return closedObject({
    v: z.literal(1),
    seq: sequenceSchema,
    commandId: z.string(),
    commandDigest: digestSchema,
    type: z.literal(type),
    actor: factActorSchema,
    at: epochMillisecondsSchema,
    data,
    prev: digestSchema.nullable(),
  })
}

function sealedFactVariant<Type extends FactType, DataSchema extends z.ZodType>(
  type: Type,
  data: DataSchema,
) {
  return unsealedFactVariant(type, data).extend({ digest: digestSchema })
}

/** Fact envelope before the fact-domain digest is attached. */
export const unsealedFactSchema = z.discriminatedUnion('type', [
  unsealedFactVariant('method/registered', factPayloadSchemaByType['method/registered']),
  unsealedFactVariant('method/activated', factPayloadSchemaByType['method/activated']),
  unsealedFactVariant('task/admitted', factPayloadSchemaByType['task/admitted']),
  unsealedFactVariant('run/opened', factPayloadSchemaByType['run/opened']),
  unsealedFactVariant('task/children-admitted', factPayloadSchemaByType['task/children-admitted']),
  unsealedFactVariant('run/submitted', factPayloadSchemaByType['run/submitted']),
  unsealedFactVariant('run/closed', factPayloadSchemaByType['run/closed']),
  unsealedFactVariant('task/closed', factPayloadSchemaByType['task/closed']),
  unsealedFactVariant('rsi/trace-sealed', factPayloadSchemaByType['rsi/trace-sealed']),
  unsealedFactVariant('rsi/round-opened', factPayloadSchemaByType['rsi/round-opened']),
  unsealedFactVariant('rsi/proposal-submitted', factPayloadSchemaByType['rsi/proposal-submitted']),
  unsealedFactVariant('rsi/candidate-ready', factPayloadSchemaByType['rsi/candidate-ready']),
  unsealedFactVariant('rsi/round-closed', factPayloadSchemaByType['rsi/round-closed']),
])

export type UnsealedFact = z.infer<typeof unsealedFactSchema>

/** Sealed journal fact; type and data are a single matching union variant. */
export const factSchema = z.discriminatedUnion('type', [
  sealedFactVariant('method/registered', factPayloadSchemaByType['method/registered']),
  sealedFactVariant('method/activated', factPayloadSchemaByType['method/activated']),
  sealedFactVariant('task/admitted', factPayloadSchemaByType['task/admitted']),
  sealedFactVariant('run/opened', factPayloadSchemaByType['run/opened']),
  sealedFactVariant('task/children-admitted', factPayloadSchemaByType['task/children-admitted']),
  sealedFactVariant('run/submitted', factPayloadSchemaByType['run/submitted']),
  sealedFactVariant('run/closed', factPayloadSchemaByType['run/closed']),
  sealedFactVariant('task/closed', factPayloadSchemaByType['task/closed']),
  sealedFactVariant('rsi/trace-sealed', factPayloadSchemaByType['rsi/trace-sealed']),
  sealedFactVariant('rsi/round-opened', factPayloadSchemaByType['rsi/round-opened']),
  sealedFactVariant('rsi/proposal-submitted', factPayloadSchemaByType['rsi/proposal-submitted']),
  sealedFactVariant('rsi/candidate-ready', factPayloadSchemaByType['rsi/candidate-ready']),
  sealedFactVariant('rsi/round-closed', factPayloadSchemaByType['rsi/round-closed']),
])

export type Fact = z.infer<typeof factSchema>

/** Validates a complete envelope body and seals it in the fact domain. */
export function sealFact(payload: unknown): Fact {
  const body = parseProtocolValue(unsealedFactSchema, payload)
  return parseProtocolValue(factSchema, seal('fact', body))
}

/** Accepts only complete strict facts whose fact-domain digest matches. */
export function verifyFact(value: unknown): value is Fact {
  try {
    const fact = parseProtocolValue(factSchema, value)
    return verifyDigest('fact', fact)
  } catch {
    return false
  }
}
