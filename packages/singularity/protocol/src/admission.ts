import { z } from 'zod'

import { canonicalize } from './json.ts'
import type { ToolErrorCode } from './errors.ts'
import { methodRevisionSchema, verifyMethodRevision } from './method.ts'
import type { ChildBinding, MethodRevision } from './method.ts'
import { refSchema } from './refs.ts'
import { closedObject, parseProtocolValue } from './schema.ts'
import {
  inputRefSchema,
  resourceBindingSchema,
  sealTaskContract,
  taskContractPayloadSchema,
  taskContractSchema,
  taskLimitsSchema,
  taskProposalSchema,
  taskRootOriginSchema,
  taskSpecSchema,
  verifyTaskContract,
} from './task.ts'
import type {
  InputRef,
  LocalOutput,
  OutputSpec,
  ResourceBinding,
  TaskContract,
  TaskLimits,
  TaskProposal,
  TaskRootOrigin,
  TaskSpec,
} from './task.ts'

/** Fixed learning-draft output from docs/framework.md §6.2. */
export const SKILL_DRAFTS_OUTPUT: OutputSpec = {
  id: '__skill-drafts',
  path: 'learning-drafts/skills',
  kind: 'tree',
  role: 'skill-draft',
  required: false,
}

/** Fixed learning-draft output from docs/framework.md §6.2. */
export const MCP_DRAFTS_OUTPUT: OutputSpec = {
  id: '__mcp-drafts',
  path: 'learning-drafts/mcp-servers',
  kind: 'tree',
  role: 'mcp-draft',
  required: false,
}

const RESERVED_OUTPUT_IDS = new Set([SKILL_DRAFTS_OUTPUT.id, MCP_DRAFTS_OUTPUT.id])
const RESERVED_OUTPUT_PATH_ROOT = 'learning-drafts'

/** Existing protocol rejection codes used by pure admission; no new codes. */
export type AdmissionErrorCode = Extract<
  ToolErrorCode,
  'INVALID_ARGUMENT' | 'BINDING_FIXED' | 'INPUT_NOT_AUTHORIZED' | 'LIMIT_EXCEEDED' | 'CHILD_BATCH_ACTIVE'
>

/** A pure admission rejection with a stable tool-facing code. */
export class AdmissionError extends Error {
  override readonly name = 'AdmissionError'
  readonly code: AdmissionErrorCode

  constructor(code: AdmissionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

const taskEnvironmentSchema = taskContractPayloadSchema.shape.environment

/** Host-resolved root fields before the fixed learning drafts are appended. */
export const rootAdmissionInputSchema = closedObject({
  taskId: z.string(),
  spec: taskSpecSchema,
  origin: taskRootOriginSchema,
  method: refSchema,
  template: refSchema,
  resources: resourceBindingSchema,
  acceptance: refSchema,
  environment: taskEnvironmentSchema,
  limits: taskLimitsSchema,
})

export type RootAdmissionInput = z.infer<typeof rootAdmissionInputSchema>

/** One host-resolved child request; only `proposal` and `bindingId` are model-originated. */
export const childAdmissionRequestSchema = closedObject({
  bindingId: z.string(),
  taskId: z.string(),
  authorizedInputs: z.array(inputRefSchema),
  proposal: taskProposalSchema,
  resources: resourceBindingSchema,
  environment: taskEnvironmentSchema,
  limits: taskLimitsSchema,
})

export type ChildAdmissionRequest = z.infer<typeof childAdmissionRequestSchema>

/** Input projection showing an already-active child batch for the parent Run. */
export const activeBatchProjectionSchema = closedObject({
  batchId: z.string(),
})

export type ActiveBatchProjection = z.infer<typeof activeBatchProjectionSchema>

/** Frozen parent, pinned Method revision, and a non-empty batch of child proposals. */
export const childBatchAdmissionInputSchema = closedObject({
  parent: taskContractSchema,
  method: methodRevisionSchema,
  parentRunId: z.string(),
  batchId: z.string(),
  activeBatch: activeBatchProjectionSchema.optional(),
  children: z.array(childAdmissionRequestSchema),
})

export type ChildBatchAdmissionInput = z.infer<typeof childBatchAdmissionInputSchema>

/** One admitted child contract plus host-derived join; join never enters the contract. */
export interface AdmittedChildContract {
  readonly bindingId: string
  readonly join: ChildBinding['join']
  readonly contract: TaskContract
}

/** Pure result of child admission; no fact is appended and no budget is reserved. */
export interface AdmittedChildBatch {
  readonly parentId: string
  readonly parentRunId: string
  readonly batchId: string
  readonly children: readonly AdmittedChildContract[]
}

type ContractEnvironment = z.infer<typeof taskEnvironmentSchema>

function parseAdmission<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  label: string,
): z.output<Schema> {
  try {
    return parseProtocolValue(schema, value)
  } catch (error) {
    throw new AdmissionError('INVALID_ARGUMENT', `${label} is not a valid protocol value`, {
      cause: error,
    })
  }
}

function invalidArgument(message: string): never {
  throw new AdmissionError('INVALID_ARGUMENT', message)
}

function bindingFixed(message: string): never {
  throw new AdmissionError('BINDING_FIXED', message)
}

function limitExceeded(message: string): never {
  throw new AdmissionError('LIMIT_EXCEEDED', message)
}

function isReservedOutputPath(path: string): boolean {
  return (
    path === RESERVED_OUTPUT_PATH_ROOT ||
    path === `${RESERVED_OUTPUT_PATH_ROOT}/` ||
    path.startsWith(`${RESERVED_OUTPUT_PATH_ROOT}/`)
  )
}

function assertNoReservedOutput(output: Pick<OutputSpec, 'id' | 'path'>, label: string): void {
  if (RESERVED_OUTPUT_IDS.has(output.id)) {
    invalidArgument(`${label} must not use reserved output id ${JSON.stringify(output.id)}`)
  }
  if (isReservedOutputPath(output.path)) {
    invalidArgument(`${label} must not use reserved output path ${JSON.stringify(output.path)}`)
  }
}

function assertNoDraftRole(output: OutputSpec, label: string): void {
  if (output.role === 'skill-draft' || output.role === 'mcp-draft') {
    invalidArgument(`${label} must not use draft role ${JSON.stringify(output.role)}`)
  }
}

function assertUniqueIds(items: readonly { readonly id: string }[], label: string): void {
  const ids = new Set<string>()
  for (const item of items) {
    if (ids.has(item.id)) {
      invalidArgument(`${label} must not contain duplicate id ${JSON.stringify(item.id)}`)
    }
    ids.add(item.id)
  }
}

function assertUniqueOutputs(outputs: readonly OutputSpec[]): void {
  const ids = new Set<string>()
  const paths = new Set<string>()
  for (const output of outputs) {
    if (ids.has(output.id)) {
      invalidArgument(`Merged outputs contain duplicate id ${JSON.stringify(output.id)}`)
    }
    if (paths.has(output.path)) {
      invalidArgument(`Merged outputs contain duplicate path ${JSON.stringify(output.path)}`)
    }
    ids.add(output.id)
    paths.add(output.path)
  }
}

function copyOutput(output: OutputSpec): OutputSpec {
  return {
    id: output.id,
    path: output.path,
    kind: output.kind,
    role: output.role,
    required: output.required,
  }
}

function toSupportingOutput(output: LocalOutput): OutputSpec {
  return {
    id: output.id,
    path: output.path,
    kind: output.kind,
    role: 'supporting',
    required: false,
  }
}

function validateBaseOutputs(outputs: readonly OutputSpec[], label: string): void {
  for (const output of outputs) {
    assertNoReservedOutput(output, label)
    assertNoDraftRole(output, label)
  }
}

function validateLocalOutputs(outputs: readonly LocalOutput[]): void {
  for (const output of outputs) {
    assertNoReservedOutput(output, 'localOutputs')
  }
}

/** Fixed order: base → local supporting outputs → skill drafts → MCP drafts. */
function mergeOutputs(
  base: readonly OutputSpec[],
  local: readonly LocalOutput[],
): readonly OutputSpec[] {
  const merged = [
    ...base.map(copyOutput),
    ...local.map(toSupportingOutput),
    copyOutput(SKILL_DRAFTS_OUTPUT),
    copyOutput(MCP_DRAFTS_OUTPUT),
  ]
  assertUniqueOutputs(merged)
  return merged
}

function copyGoal(goal: TaskSpec['goal']): TaskSpec['goal'] {
  return {
    summary: goal.summary,
    deliverable: goal.deliverable,
    scope: [...goal.scope],
    constraints: [...goal.constraints],
  }
}

function copySpec(spec: TaskSpec, outputs: readonly OutputSpec[]): TaskSpec {
  return {
    goal: copyGoal(spec.goal),
    criteria: spec.criteria.map(criterion => ({ ...criterion })),
    ...(spec.localGuidance === undefined
      ? {}
      : { localGuidance: spec.localGuidance.map(criterion => ({ ...criterion })) }),
    inputs: spec.inputs.map(copyInput),
    outputs: outputs.map(copyOutput),
  }
}

function copyInput(input: InputRef): InputRef {
  return {
    id: input.id,
    object: { ...input.object },
    path: input.path,
    access: input.access,
  }
}

function copyResources(resources: ResourceBinding): ResourceBinding {
  return {
    baseTools: resources.baseTools.map(tool => ({ ...tool })),
    skills: resources.skills.map(skill => ({ ...skill })),
    mcpServers: resources.mcpServers.map(server => ({ ...server })),
    ...(resources.exploration === undefined
      ? {}
      : { exploration: { ...resources.exploration } }),
  }
}

function copyEnvironment(environment: ContractEnvironment): ContractEnvironment {
  return {
    seed: { ...environment.seed },
    profile: { ...environment.profile },
  }
}

function copyLimits(limits: TaskLimits): TaskLimits {
  return { ...limits }
}

function copyRootOrigin(origin: TaskRootOrigin): TaskRootOrigin {
  return {
    kind: 'root',
    purpose: origin.purpose,
    requestRef: { ...origin.requestRef },
  }
}

function assertRootTemplateRef(method: { readonly digest: string }, template: { readonly id: string; readonly digest: string }): void {
  if (template.digest !== method.digest) {
    invalidArgument('TemplateRef.digest must equal MethodRef.digest')
  }
}

/**
 * Appends the two fixed learning-draft outputs to a host-resolved root spec,
 * then seals the complete contract. No Method revision is available here, so
 * the host-provided Method/Template refs are only checked for digest equality.
 */
export function admitRootTask(input: RootAdmissionInput): TaskContract {
  const parsed = parseAdmission(rootAdmissionInputSchema, input, 'Root admission input')
  assertUniqueIds(parsed.spec.criteria, 'Root spec.criteria')
  assertUniqueIds(parsed.spec.inputs, 'Root spec.inputs')
  assertRootTemplateRef(parsed.method, parsed.template)
  validateBaseOutputs(parsed.spec.outputs, 'Root spec.outputs')
  const outputs = mergeOutputs(parsed.spec.outputs, [])

  try {
    return sealTaskContract({
      v: 1,
      taskId: parsed.taskId,
      spec: copySpec(parsed.spec, outputs),
      origin: copyRootOrigin(parsed.origin),
      method: { ...parsed.method },
      template: { ...parsed.template },
      resources: copyResources(parsed.resources),
      acceptance: { ...parsed.acceptance },
      environment: copyEnvironment(parsed.environment),
      limits: copyLimits(parsed.limits),
    })
  } catch (error) {
    if (error instanceof AdmissionError) throw error
    throw new AdmissionError('INVALID_ARGUMENT', 'Root contract could not be sealed', {
      cause: error,
    })
  }
}

function findBinding(
  template: { readonly children: readonly ChildBinding[] },
  bindingId: string,
): ChildBinding {
  const binding = template.children.find(candidate => candidate.bindingId === bindingId)
  if (binding === undefined) {
    bindingFixed(`Child binding ${JSON.stringify(bindingId)} is not fixed by the parent template`)
  }
  return binding
}

function findTemplate(method: MethodRevision, templateId: string) {
  const template = method.templates.find(candidate => candidate.id === templateId)
  if (template === undefined) {
    invalidArgument(`Child template ${JSON.stringify(templateId)} is absent from the Method revision`)
  }
  return template
}

function assertAuthorizedInputs(
  proposal: TaskProposal,
  authorizedInputs: readonly InputRef[],
): void {
  if (canonicalize(proposal.inputs) !== canonicalize(authorizedInputs)) {
    throw new AdmissionError(
      'INPUT_NOT_AUTHORIZED',
      'Child inputs must exactly match the host-authorized inputs in order',
    )
  }
}

export function assertChildLimitsWithinParent(parent: TaskLimits, child: TaskLimits): void {
  if (child.deadlineAt > parent.deadlineAt) {
    limitExceeded('Child deadlineAt must not exceed the parent deadlineAt')
  }
  if (child.maxDepth >= parent.maxDepth) {
    limitExceeded('Child maxDepth must be less than the parent maxDepth')
  }
  if (child.maxTasks < 1 || child.maxTasks > parent.maxTasks - 1) {
    limitExceeded('Child maxTasks must be between 1 and parent maxTasks - 1')
  }
  if (child.maxTokens > parent.maxTokens) {
    limitExceeded('Child maxTokens must not exceed the parent maxTokens')
  }
  if (child.maxStepsPerRun > parent.maxStepsPerRun) {
    limitExceeded('Child maxStepsPerRun must not exceed the parent maxStepsPerRun')
  }
  if (child.maxBatchChildren > parent.maxBatchChildren) {
    limitExceeded('Child maxBatchChildren must not exceed the parent maxBatchChildren')
  }
}

/**
 * Admits a non-empty child batch against a frozen parent contract and its
 * pinned Method revision. Every child contract is built and sealed before the
 * result is returned; a later failure never exposes an earlier partial batch.
 */
export function admitChildBatch(input: ChildBatchAdmissionInput): AdmittedChildBatch {
  const parsed = parseAdmission(childBatchAdmissionInputSchema, input, 'Child batch admission input')

  if (parsed.activeBatch !== undefined) {
    throw new AdmissionError(
      'CHILD_BATCH_ACTIVE',
      'The parent Run already has an active child batch',
    )
  }
  if (parsed.children.length === 0) {
    invalidArgument('Child batch must contain at least one child')
  }

  const parent = parsed.parent
  const method = parsed.method
  if (!verifyTaskContract(parent)) {
    invalidArgument('Parent contract is not a valid sealed contract')
  }
  if (!verifyMethodRevision(method)) {
    invalidArgument('Method revision is not a valid sealed revision')
  }
  if (parent.method.id !== method.id || parent.method.digest !== method.digest) {
    bindingFixed('Child Method is pinned to the verified parent Method revision')
  }
  if (parent.template.digest !== method.digest) {
    bindingFixed('Parent TemplateRef.digest must equal the pinned Method digest')
  }
  const parentTemplate = findTemplate(method, parent.template.id)

  if (parsed.children.length > parent.limits.maxBatchChildren) {
    throw new AdmissionError(
      'LIMIT_EXCEEDED',
      'Child batch exceeds the parent maxBatchChildren limit',
    )
  }

  const seenBindings = new Set<string>()
  const seenTaskIds = new Set<string>()
  const admitted: AdmittedChildContract[] = []
  for (const request of parsed.children) {
    if (seenBindings.has(request.bindingId)) {
      invalidArgument(
        `Child batch contains duplicate binding ${JSON.stringify(request.bindingId)}`,
      )
    }
    seenBindings.add(request.bindingId)
    if (seenTaskIds.has(request.taskId)) {
      invalidArgument(
        `Child batch contains duplicate taskId ${JSON.stringify(request.taskId)}`,
      )
    }
    seenTaskIds.add(request.taskId)

    const binding = findBinding(parentTemplate, request.bindingId)
    const template = findTemplate(method, binding.templateId)

    assertChildLimitsWithinParent(parent.limits, request.limits)
    assertAuthorizedInputs(request.proposal, request.authorizedInputs)
    assertUniqueIds(
      template.requiredCriteria,
      `Template ${JSON.stringify(template.id)} requiredCriteria`,
    )
    assertUniqueIds(request.proposal.inputs, 'Child spec.inputs')
    validateBaseOutputs(template.requiredOutputs, `Template ${JSON.stringify(template.id)} requiredOutputs`)
    const localOutputs = request.proposal.localOutputs ?? []
    validateLocalOutputs(localOutputs)
    const outputs = mergeOutputs(template.requiredOutputs, localOutputs)

    let contract: TaskContract
    try {
      contract = sealTaskContract({
        v: 1,
        taskId: request.taskId,
        spec: {
          goal: copyGoal(request.proposal.goal),
          criteria: template.requiredCriteria.map(criterion => ({ ...criterion })),
          ...(request.proposal.localCriteria === undefined
            ? {}
            : {
                localGuidance: request.proposal.localCriteria.map(criterion => ({
                  ...criterion,
                })),
              }),
          inputs: request.proposal.inputs.map(copyInput),
          outputs: outputs.map(copyOutput),
        },
        origin: {
          kind: 'child',
          parentId: parent.taskId,
          parentRunId: parsed.parentRunId,
          batchId: parsed.batchId,
          bindingId: request.bindingId,
        },
        method: { ...parent.method },
        template: { id: template.id, digest: method.digest },
        resources: copyResources(request.resources),
        acceptance: { ...template.acceptancePolicy },
        environment: copyEnvironment(request.environment),
        limits: copyLimits(request.limits),
      })
    } catch (error) {
      if (error instanceof AdmissionError) throw error
      throw new AdmissionError('INVALID_ARGUMENT', 'Child contract could not be sealed', {
        cause: error,
      })
    }

    if (!verifyTaskContract(contract)) {
      invalidArgument('Sealed child contract failed verification')
    }
    admitted.push({
      bindingId: request.bindingId,
      join: binding.join,
      contract,
    })
  }

  return {
    parentId: parent.taskId,
    parentRunId: parsed.parentRunId,
    batchId: parsed.batchId,
    children: admitted,
  }
}
