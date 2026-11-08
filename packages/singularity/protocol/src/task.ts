import { z } from 'zod'

import { digestSchema, seal, verifyDigest } from './digest.ts'
import type { JsonObject } from './json.ts'
import { refSchema } from './refs.ts'
import { closedObject, parseProtocolValue, workspaceRelativePathSchema } from './schema.ts'

/** Parent-authored acceptance frozen before dispatch. */
export const acceptanceCriterionSchema = closedObject({
  id: z.string(),
  statement: z.string(),
  check: z.string().regex(/\S/),
  checkOutput: z.literal('metric-json').optional(),
})

export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>

/** Model-supplied supporting output; this shape cannot express required deliverables. */
export const localOutputSchema = closedObject({
  id: z.string(),
  path: workspaceRelativePathSchema,
  kind: z.enum(['file', 'tree']),
  description: z.string(),
})

export type LocalOutput = z.infer<typeof localOutputSchema>

const taskGoalSchema = closedObject({
  summary: z.string(),
  deliverable: z.string(),
  scope: z.array(z.string()),
  constraints: z.array(z.string()),
})

export const taskCriterionSchema = closedObject({
  id: z.string(),
  statement: z.string(),
  required: z.boolean(),
  check: z.string().regex(/\S/).optional(),
  checkOutput: z.literal('metric-json').optional(),
}).superRefine((criterion, ctx) => {
  if (criterion.checkOutput !== undefined && criterion.check === undefined) {
    ctx.addIssue({ code: 'custom', path: ['checkOutput'], message: 'metric output requires a frozen check' })
  }
})

export type TaskCriterion = z.infer<typeof taskCriterionSchema>

/** Frozen input authorisation resolved by the host. */
export const inputRefSchema = closedObject({
  id: z.string(),
  object: refSchema,
  path: workspaceRelativePathSchema,
  access: z.enum(['read', 'copy-to-work']),
})

export type InputRef = z.infer<typeof inputRefSchema>

/** Output obligation or supporting output; roles and requiredness are host-owned. */
export const outputSpecSchema = closedObject({
  id: z.string(),
  path: workspaceRelativePathSchema,
  kind: z.enum(['file', 'tree']),
  role: z.enum(['deliverable', 'supporting', 'skill-draft', 'mcp-draft']),
  required: z.boolean(),
})

export type OutputSpec = z.infer<typeof outputSpecSchema>

/** Resource binding fixed by the template, deployment policy, and frozen snapshot. */
export const resourceBindingSchema = closedObject({
  baseTools: z.array(refSchema),
  skills: z.array(refSchema),
  mcpServers: z.array(refSchema),
  exploration: refSchema.optional(),
})

export type ResourceBinding = z.infer<typeof resourceBindingSchema>

/** Budget and fan-out limits frozen at admission. */
export const taskLimitsSchema = closedObject({
  maxRuns: z.number(),
  maxStepsPerRun: z.number(),
  maxTokens: z.number(),
  deadlineAt: z.number(),
  maxDepth: z.number(),
  maxTasks: z.number(),
  maxBatchChildren: z.number(),
})

export type TaskLimits = z.infer<typeof taskLimitsSchema>

/** Host-resolved business obligations for an admitted Task. */
export const taskSpecSchema = closedObject({
  goal: taskGoalSchema,
  criteria: z.array(taskCriterionSchema),
  inputs: z.array(inputRefSchema),
  outputs: z.array(outputSpecSchema),
})

export type TaskSpec = z.infer<typeof taskSpecSchema>

/** The only Task shape a model may submit through decomposition. */
export const taskProposalSchema = closedObject({
  goal: taskGoalSchema,
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
  inputs: z.array(inputRefSchema),
  localOutputs: z.array(localOutputSchema).optional(),
})

export type TaskProposal = z.infer<typeof taskProposalSchema>

/** Host-owned default used by exploration and every MethodPatch template. */
export const DEFAULT_TASK_PROPOSAL_INSTANCE_SCHEMA: JsonObject = {
  type: 'object', additionalProperties: false,
  required: ['goal', 'inputs', 'acceptanceCriteria'],
  properties: {
    goal: { type: 'object' },
    acceptanceCriteria: { type: 'array', minItems: 1 },
    inputs: { type: 'array' },
    localOutputs: { type: 'array' },
  },
}

const taskExampleInputSchema = closedObject({
  id: z.string(),
  exampleText: z.string(),
})

/** Complete Task example whose inputs are embedded samples, never object refs. */
export const taskExampleSchema = taskProposalSchema.omit({ inputs: true }).extend({
  inputs: z.array(taskExampleInputSchema),
})

export type TaskExample = z.infer<typeof taskExampleSchema>

export const taskRootOriginSchema = closedObject({
  kind: z.literal('root'),
  purpose: z.enum(['work', 'evaluation']),
  requestRef: refSchema,
})

export type TaskRootOrigin = z.infer<typeof taskRootOriginSchema>

export const taskChildOriginSchema = closedObject({
  kind: z.literal('child'),
  parentId: z.string(),
  parentRunId: z.string(),
  batchId: z.string(),
  bindingId: z.string(),
})

export type TaskChildOrigin = z.infer<typeof taskChildOriginSchema>

export const taskOriginSchema = z.discriminatedUnion('kind', [
  taskRootOriginSchema,
  taskChildOriginSchema,
])

export type TaskOrigin = z.infer<typeof taskOriginSchema>

const taskEnvironmentSchema = closedObject({
  seed: refSchema,
  profile: refSchema,
})

/** A complete contract body before the contract digest is attached. */
export const taskContractPayloadSchema = closedObject({
  v: z.literal(1),
  taskId: z.string(),
  spec: taskSpecSchema,
  origin: taskOriginSchema,
  method: refSchema,
  template: refSchema,
  resources: resourceBindingSchema,
  acceptance: refSchema,
  environment: taskEnvironmentSchema,
  limits: taskLimitsSchema,
})

export type TaskContractPayload = z.infer<typeof taskContractPayloadSchema>

/** A frozen, sealed Task contract. */
export const taskContractSchema = taskContractPayloadSchema.extend({
  digest: digestSchema,
})

export type TaskContract = z.infer<typeof taskContractSchema>

/**
 * Seals an already complete contract body. The caller must have resolved and
 * ordered arrays and optional fields before calling; this function only
 * validates the strict shape and attaches the contract digest.
 */
export function sealTaskContract(payload: unknown): TaskContract {
  const body = parseProtocolValue(taskContractPayloadSchema, payload)
  return seal('contract', body)
}

/** Accepts only complete strict contracts whose contract-domain digest matches. */
export function verifyTaskContract(value: unknown): value is TaskContract {
  try {
    const contract = parseProtocolValue(taskContractSchema, value)
    return verifyDigest('contract', contract)
  } catch {
    return false
  }
}

/** Derived CAS reference to a contract summary, indexed by source contract. */
export const contractSummaryRefSchema = closedObject({
  object: refSchema,
  sourceContract: digestSchema,
  schema: z.literal('task-contract-summary/v1'),
})

export type ContractSummaryRef = z.infer<typeof contractSummaryRefSchema>

const contractSummarySourceRefSchema = closedObject({
  field: z.string(),
  digest: digestSchema,
})

/** Read-only derived summary; it is not a TaskContract field. */
export const contractSummarySchema = closedObject({
  v: z.literal(1),
  sourceContract: digestSchema,
  goal: z.string(),
  acceptance: z.array(z.string()),
  constraints: z.array(z.string()),
  outputs: z.array(z.string()),
  frozenDecisions: z.array(z.string()),
  sourceRefs: z.array(contractSummarySourceRefSchema),
  generatedBy: z.literal('contract-summary-worker'),
})

export type ContractSummary = z.infer<typeof contractSummarySchema>

/** First decompose action: delivery of a template example, with no admission. */
export const decomposePrepareSchema = closedObject({
  action: z.literal('prepare'),
  bindingId: z.string(),
})

export type DecomposePrepare = z.infer<typeof decomposePrepareSchema>

export const decomposeCommitChildSchema = closedObject({
  bindingId: z.string(),
  ackPreview: digestSchema,
  task: taskProposalSchema,
})

export type DecomposeCommitChild = z.infer<typeof decomposeCommitChildSchema>

/** Second decompose action: a batch of TaskProposals for host admission. */
export const decomposeCommitSchema = closedObject({
  action: z.literal('commit'),
  children: z.array(decomposeCommitChildSchema),
})

export type DecomposeCommit = z.infer<typeof decomposeCommitSchema>

export const decomposeInputSchema = z.discriminatedUnion('action', [
  decomposePrepareSchema,
  decomposeCommitSchema,
])

export type DecomposeInput = z.infer<typeof decomposeInputSchema>
