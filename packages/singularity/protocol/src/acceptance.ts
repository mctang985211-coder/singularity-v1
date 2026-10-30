import { z } from 'zod'

import { digestSchema, seal, verifyDigest } from './digest.ts'
import type { Digest } from './digest.ts'
import { sessionCutSchema, usageRecordSchema } from './fact.ts'
import { refSchema } from './refs.ts'
import type { Ref } from './refs.ts'
import { closedObject, parseProtocolValue } from './schema.ts'
import { verifyTaskContract } from './task.ts'
import type { OutputSpec, TaskContract } from './task.ts'

/**
 * `TaskContract.acceptance` is a frozen acceptance policy/provider identity.
 * Amendment 002 A0 maps it to the existing `object` digest domain; no new
 * domain is introduced.
 */
export type AcceptanceRef = Ref

const finiteNumberSchema = z.number()

/** Optional public metric attached to a pass/fail criterion. */
export const publicMetricSchema = closedObject({
  name: z.string().min(1),
  unit: z.string().min(1),
  value: finiteNumberSchema,
})

export type PublicMetric = z.infer<typeof publicMetricSchema>

/**
 * One required criterion result from amendment 002 A1. `reason` is mandatory
 * for every verdict; invalid results carry no domain metric or score.
 */
export const publicCriterionResultSchema = closedObject({
  id: z.string().min(1),
  verdict: z.enum(['pass', 'fail', 'invalid']),
  reason: z.string().min(1),
  metric: publicMetricSchema.optional(),
  score: finiteNumberSchema.optional(),
}).superRefine((criterion, ctx) => {
  if (criterion.verdict === 'invalid') {
    if (criterion.metric !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['metric'],
        message: 'invalid criteria must not carry a metric',
      })
    }
    if (criterion.score !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['score'],
        message: 'invalid criteria must not carry a score',
      })
    }
  }
  if (criterion.score !== undefined && criterion.metric === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['score'],
      message: 'score requires a metric',
    })
  }
})

export type PublicCriterionResult = z.infer<typeof publicCriterionResultSchema>

/** Raw verifier process termination; timeout is expressed only by `timedOut`. */
export const publicExitStatusSchema = closedObject({
  code: z.number().int().nullable(),
  signal: z.string().min(1).nullable(),
})

export type PublicExitStatus = z.infer<typeof publicExitStatusSchema>

const publicReceiptBaseShape = {
  v: z.literal(1),
  provider: refSchema,
  operationId: z.string().min(1),
  contractDigest: digestSchema,
  inputDigests: z.array(digestSchema),
  outputDigests: z.array(digestSchema),
  criteria: z.array(publicCriterionResultSchema),
  exit: publicExitStatusSchema,
  timedOut: z.boolean(),
}

/** Receipt body before the outer object-domain CAS seal is attached. */
export const publicReceiptPayloadSchema = closedObject(publicReceiptBaseShape).superRefine(
  (receipt, ctx) => {
    if (!receipt.timedOut && receipt.exit.code === null && receipt.exit.signal === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['exit'],
        message: 'a non-timeout receipt must record exactly one termination status',
      })
    }
    if (receipt.exit.code !== null && receipt.exit.signal !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['exit'],
        message: 'a receipt must not record an exit code and a signal together',
      })
    }
  },
)

export type PublicReceiptPayload = z.infer<typeof publicReceiptPayloadSchema>

/** Strict public receipt from amendment 002 A1; it never carries a total verdict. */
export const publicReceiptSchema = publicReceiptPayloadSchema.extend({
  digest: digestSchema,
})

export type PublicReceipt = z.infer<typeof publicReceiptSchema>

/** Validates and seals a receipt in the `object` digest domain. */
export function sealPublicReceipt(payload: unknown): PublicReceipt {
  const body = parseProtocolValue(publicReceiptPayloadSchema, payload)
  return seal('object', body)
}

/** Accepts only strict receipts whose object-domain digest matches. */
export function verifyPublicReceipt(value: unknown): value is PublicReceipt {
  try {
    const receipt = parseProtocolValue(publicReceiptSchema, value)
    return verifyDigest('object', receipt)
  } catch {
    return false
  }
}

/** Host-owned snapshot identity against which a receipt is checked. */
export interface PublicReceiptExpectation {
  readonly provider: Ref
  readonly operationId: string
  readonly contractDigest: Digest
  readonly inputDigests: readonly Digest[]
  readonly outputDigests: readonly Digest[]
  readonly requiredCriteria: readonly string[]
}

/** Host-derived receipt classification; no total verdict exists in the receipt. */
export type PublicReceiptVerdict = 'verified' | 'failed' | 'invalid'

/**
 * Invalid receipts are diagnostic only: the validator does not return the
 * parsed receipt, so it cannot be sealed as Evidence by accident.
 */
export type PublicReceiptValidation =
  | {
      readonly verdict: 'verified' | 'failed'
      readonly reason: string
      readonly receipt: PublicReceipt
    }
  | { readonly verdict: 'invalid'; readonly reason: string }

/**
 * Validates receipt identity, ordered digest lists, required criteria, metric
 * rules, exit status, and timeout, then derives the host verdict from
 * amendment 002 A2. Exit code zero alone never produces `verified`.
 */
export function validatePublicReceipt(
  value: unknown,
  expected: PublicReceiptExpectation,
): PublicReceiptValidation {
  let receipt: PublicReceipt
  try {
    receipt = parseProtocolValue(publicReceiptSchema, value)
  } catch (error) {
    return invalidReceipt(`receipt is not a strict sealed object: ${errorMessage(error)}`)
  }
  if (!verifyDigest('object', receipt)) {
    return invalidReceipt('receipt digest is not a valid object-domain seal')
  }
  if (!sameRef(receipt.provider, expected.provider)) {
    return invalidReceipt('receipt provider does not match the frozen acceptance provider')
  }
  if (receipt.operationId !== expected.operationId) {
    return invalidReceipt('receipt operationId does not match the verifier operation')
  }
  if (receipt.contractDigest !== expected.contractDigest) {
    return invalidReceipt('receipt contractDigest does not match the frozen contract')
  }
  if (!sameDigests(receipt.inputDigests, expected.inputDigests)) {
    return invalidReceipt('receipt inputDigests do not match the authorized input snapshot')
  }
  if (!sameDigests(receipt.outputDigests, expected.outputDigests)) {
    return invalidReceipt('receipt outputDigests do not match the frozen output snapshot')
  }

  const requiredIds = new Set(expected.requiredCriteria)
  if (requiredIds.size !== expected.requiredCriteria.length) {
    return invalidReceipt('expected required criteria contain duplicate ids')
  }
  const counts = new Map<string, number>()
  for (const criterion of receipt.criteria) {
    counts.set(criterion.id, (counts.get(criterion.id) ?? 0) + 1)
  }
  for (const id of requiredIds) {
    const count = counts.get(id)
    if (count === undefined) {
      return invalidReceipt(`required criterion ${JSON.stringify(id)} is missing`)
    }
    if (count !== 1) {
      return invalidReceipt(`required criterion ${JSON.stringify(id)} must appear exactly once`)
    }
  }
  for (const id of counts.keys()) {
    if (!requiredIds.has(id)) {
      return invalidReceipt(`receipt contains non-required criterion ${JSON.stringify(id)}`)
    }
  }

  if (receipt.criteria.some(criterion => criterion.verdict === 'invalid')) {
    return invalidReceipt('at least one criterion is invalid')
  }
  if (receipt.timedOut) {
    return invalidReceipt('verifier timed out')
  }
  if (receipt.exit.signal !== null) {
    return invalidReceipt(`verifier was terminated by signal ${JSON.stringify(receipt.exit.signal)}`)
  }
  if (receipt.exit.code === null) {
    return invalidReceipt('receipt has no exit code and is not a timeout')
  }

  const failedIds = receipt.criteria
    .filter(criterion => criterion.verdict === 'fail')
    .map(criterion => criterion.id)
  if (failedIds.length > 0) {
    return {
      verdict: 'failed',
      reason: `required criteria failed: ${failedIds.join(', ')}`,
      receipt,
    }
  }
  if (receipt.exit.code !== 0) {
    return invalidReceipt('all criteria passed but the verifier exit code is not zero')
  }
  return {
    verdict: 'verified',
    reason: 'all required criteria passed with exit code zero and no timeout or signal',
    receipt,
  }
}

function invalidReceipt(reason: string): PublicReceiptValidation {
  return { verdict: 'invalid', reason }
}

function sameRef(left: Ref, right: Ref): boolean {
  return left.id === right.id && left.digest === right.digest
}

function sameDigests(left: readonly Digest[], right: readonly Digest[]): boolean {
  if (left.length !== right.length) return false
  return left.every((digest, index) => digest === right[index])
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown validation error'
}

/** One frozen non-draft submission output from amendment 002 A3. */
export const submittedOutputSchema = closedObject({
  id: z.string().min(1),
  path: z.string().min(1),
  kind: z.enum(['file', 'tree']),
  role: z.enum(['deliverable', 'supporting']),
  required: z.boolean(),
  object: refSchema.optional(),
})

export type SubmittedOutput = z.infer<typeof submittedOutputSchema>

const submittedSkillDraftSchema = closedObject({
  id: z.literal('__skill-drafts'),
  path: z.literal('learning-drafts/skills'),
  kind: z.literal('tree'),
  role: z.literal('skill-draft'),
  required: z.literal(false),
  object: refSchema,
})

const submittedMcpDraftSchema = closedObject({
  id: z.literal('__mcp-drafts'),
  path: z.literal('learning-drafts/mcp-servers'),
  kind: z.literal('tree'),
  role: z.literal('mcp-draft'),
  required: z.literal(false),
  object: refSchema,
})

/** Fixed learning draft shape; skill drafts and MCP drafts cannot be swapped. */
export const submittedLearningDraftSchema = z.discriminatedUnion('id', [
  submittedSkillDraftSchema,
  submittedMcpDraftSchema,
])

export type SubmittedLearningDraft = z.infer<typeof submittedLearningDraftSchema>

/** Host assertion recorded after a no-follow freeze traversal. */
export const submissionCheckSchema = closedObject({
  outputId: z.string().min(1),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  symlinks: z.literal('none'),
})

export type SubmissionCheck = z.infer<typeof submissionCheckSchema>

const submissionManifestBaseShape = {
  v: z.literal(1),
  taskId: z.string().min(1),
  runId: z.string().min(1),
  contractDigest: digestSchema,
  includeLearningDrafts: z.boolean(),
  outputs: z.array(submittedOutputSchema),
  learningDrafts: z.array(submittedLearningDraftSchema),
  checks: z.array(submissionCheckSchema),
}

/**
 * Manifest body before the outer object-domain CAS seal. Structural rules are
 * intrinsic to the manifest; contract identity and declaration order are
 * checked by {@link validateSubmissionManifest}.
 */
export const submissionManifestPayloadSchema = closedObject(
  submissionManifestBaseShape,
).superRefine((manifest, ctx) => {
  const outputIds = new Set<string>()
  const outputPaths = new Set<string>()
  for (const [index, output] of manifest.outputs.entries()) {
    if (outputIds.has(output.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['outputs', index, 'id'],
        message: 'output ids must be unique',
      })
    }
    outputIds.add(output.id)
    if (outputPaths.has(output.path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['outputs', index, 'path'],
        message: 'output paths must be unique',
      })
    }
    outputPaths.add(output.path)
    if (output.required && output.object === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['outputs', index, 'object'],
        message: 'required outputs must carry a frozen object reference',
      })
    }
  }

  if (!manifest.includeLearningDrafts && manifest.learningDrafts.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['learningDrafts'],
      message: 'learningDrafts must be empty when includeLearningDrafts is false',
    })
  }
  let previousDraftRank = -1
  const draftIds = new Set<string>()
  const draftPaths = new Set<string>()
  for (const [index, draft] of manifest.learningDrafts.entries()) {
    const rank = draft.id === '__skill-drafts' ? 0 : 1
    if (rank <= previousDraftRank) {
      ctx.addIssue({
        code: 'custom',
        path: ['learningDrafts', index, 'id'],
        message: 'learning drafts must be unique and ordered skill then MCP',
      })
    }
    previousDraftRank = rank
    if (draftIds.has(draft.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['learningDrafts', index, 'id'],
        message: 'learning draft ids must be unique',
      })
    }
    draftIds.add(draft.id)
    if (draftPaths.has(draft.path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['learningDrafts', index, 'path'],
        message: 'learning draft paths must be unique',
      })
    }
    draftPaths.add(draft.path)
    if (outputIds.has(draft.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['learningDrafts', index, 'id'],
        message: 'learning drafts must not overlap output ids',
      })
    }
    if (outputPaths.has(draft.path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['learningDrafts', index, 'path'],
        message: 'learning drafts must not overlap output paths',
      })
    }
  }

  const frozenIds: string[] = []
  for (const output of manifest.outputs) {
    if (output.object !== undefined) frozenIds.push(output.id)
  }
  for (const draft of manifest.learningDrafts) frozenIds.push(draft.id)
  if (manifest.checks.length !== frozenIds.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['checks'],
      message: 'checks must cover every frozen output exactly once',
    })
    return
  }
  for (const [index, check] of manifest.checks.entries()) {
    if (check.outputId !== frozenIds[index]) {
      ctx.addIssue({
        code: 'custom',
        path: ['checks', index, 'outputId'],
        message: 'checks must follow the frozen output order',
      })
    }
  }
})

export type SubmissionManifestPayload = z.infer<typeof submissionManifestPayloadSchema>

/** Strict submission manifest from amendment 002 A3. */
export const submissionManifestSchema = submissionManifestPayloadSchema.extend({
  digest: digestSchema,
})

export type SubmissionManifest = z.infer<typeof submissionManifestSchema>

/** Validates and seals a manifest in the `object` digest domain. */
export function sealSubmissionManifest(payload: unknown): SubmissionManifest {
  const body = parseProtocolValue(submissionManifestPayloadSchema, payload)
  return seal('object', body)
}

/** Accepts only strict manifests whose object-domain digest matches. */
export function verifySubmissionManifest(value: unknown): value is SubmissionManifest {
  try {
    const manifest = parseProtocolValue(submissionManifestSchema, value)
    return verifyDigest('object', manifest)
  } catch {
    return false
  }
}

/** Frozen contract and Run against which a submission manifest is checked. */
export interface SubmissionManifestExpectation {
  readonly contract: TaskContract
  readonly runId: string
}

export type SubmissionManifestValidation =
  | { readonly valid: true; readonly manifest: SubmissionManifest }
  | { readonly valid: false; readonly reason: string }

/**
 * Checks task/run/contract identity, the contract output declaration order,
 * declared required objects, fixed draft order, learning-draft rules, and the
 * one-to-one check sequence over frozen objects.
 */
export function validateSubmissionManifest(
  value: unknown,
  expected: SubmissionManifestExpectation,
): SubmissionManifestValidation {
  let manifest: SubmissionManifest
  try {
    manifest = parseProtocolValue(submissionManifestSchema, value)
  } catch (error) {
    return invalidManifest(`manifest is not a strict sealed object: ${errorMessage(error)}`)
  }
  if (!verifyDigest('object', manifest)) {
    return invalidManifest('manifest digest is not a valid object-domain seal')
  }
  if (!verifyTaskContract(expected.contract)) {
    return invalidManifest('expected contract is not a valid sealed TaskContract')
  }
  if (manifest.taskId !== expected.contract.taskId) {
    return invalidManifest('manifest taskId does not match the frozen contract')
  }
  if (manifest.runId !== expected.runId) {
    return invalidManifest('manifest runId does not match the current Run')
  }
  if (manifest.contractDigest !== expected.contract.digest) {
    return invalidManifest('manifest contractDigest does not match the frozen contract')
  }

  const declaredOutputs = expected.contract.spec.outputs.filter(
    output => output.role === 'deliverable' || output.role === 'supporting',
  )
  if (manifest.outputs.length !== declaredOutputs.length) {
    return invalidManifest('manifest outputs do not match the non-draft contract outputs')
  }
  for (const [index, output] of manifest.outputs.entries()) {
    const declared = declaredOutputs.at(index)
    if (declared === undefined || !sameOutputDeclaration(output, declared)) {
      return invalidManifest(
        `manifest output ${JSON.stringify(output.id)} does not match the frozen contract declaration`,
      )
    }
    if (output.required && output.object === undefined) {
      return invalidManifest(`required output ${JSON.stringify(output.id)} has no frozen object`)
    }
  }

  const declaredDrafts = new Map<string, OutputSpec>()
  for (const output of expected.contract.spec.outputs) {
    if (output.role === 'skill-draft' || output.role === 'mcp-draft') {
      declaredDrafts.set(output.id, output)
    }
  }
  for (const draft of manifest.learningDrafts) {
    const declared = declaredDrafts.get(draft.id)
    if (declared === undefined) {
      return invalidManifest(
        `learning draft ${JSON.stringify(draft.id)} is not declared by the frozen contract`,
      )
    }
    if (!sameDraftDeclaration(draft, declared)) {
      return invalidManifest(
        `learning draft ${JSON.stringify(draft.id)} does not match the frozen contract declaration`,
      )
    }
  }

  return { valid: true, manifest }
}

function invalidManifest(reason: string): SubmissionManifestValidation {
  return { valid: false, reason }
}

function sameOutputDeclaration(output: SubmittedOutput, declared: OutputSpec): boolean {
  return (
    output.id === declared.id &&
    output.path === declared.path &&
    output.kind === declared.kind &&
    output.role === declared.role &&
    output.required === declared.required
  )
}

function sameDraftDeclaration(draft: SubmittedLearningDraft, declared: OutputSpec): boolean {
  return (
    draft.id === declared.id &&
    draft.path === declared.path &&
    draft.kind === declared.kind &&
    draft.role === declared.role &&
    draft.required === declared.required
  )
}

/**
 * Host-built data request from docs/framework.md §15.3. Runtime extends this
 * shape with a read-only CAS reader; this protocol type deliberately contains
 * no function, DSH, filesystem, or clock dependency.
 */
export interface VerifyRequest {
  /** Fixed `runId + ':verify'` identity for one submission. */
  readonly operationId: string
  /** Frozen TaskContract the verifier must check. */
  readonly task: TaskContract
  /** Authorized input snapshot in frozen contract order. */
  readonly inputs: readonly Ref[]
  /** Frozen output snapshot in submission-manifest order. */
  readonly outputs: readonly Ref[]
}

/** Environment identity recorded in Evidence; never a second seed authority. */
export const evidenceEnvironmentSchema = closedObject({
  seed: digestSchema,
  mode: z.string().min(1),
})

export type EvidenceEnvironment = z.infer<typeof evidenceEnvironmentSchema>

/** Verification identity in Evidence; privateReceipt remains opaque. */
export const evidenceVerificationSchema = closedObject({
  provider: refSchema,
  operationId: z.string().min(1),
  publicReceipt: refSchema,
  privateReceipt: refSchema.optional(),
})

export type EvidenceVerification = z.infer<typeof evidenceVerificationSchema>

const evidencePayloadBaseShape = {
  v: z.literal(1),
  task: refSchema,
  runId: z.string().min(1),
  contractDigest: digestSchema,
  method: refSchema,
  inputs: z.array(refSchema),
  outputs: z.array(refSchema),
  composition: refSchema,
  verification: evidenceVerificationSchema,
  usage: usageRecordSchema,
  sessionCut: sessionCutSchema,
  environment: evidenceEnvironmentSchema,
}

/** Evidence body before the `evidence` domain seal is attached. */
export const evidencePayloadSchema = closedObject(evidencePayloadBaseShape).superRefine(
  (evidence, ctx) => {
    if (evidence.task.digest !== evidence.contractDigest) {
      ctx.addIssue({
        code: 'custom',
        path: ['task', 'digest'],
        message: 'Evidence task digest must equal the frozen contract digest',
      })
    }
  },
)

export type EvidencePayload = z.infer<typeof evidencePayloadSchema>

/** Sealed acceptance evidence; ExecutionRecord cannot impersonate this shape. */
export const evidenceSchema = evidencePayloadSchema.extend({
  digest: digestSchema,
})

export type Evidence = z.infer<typeof evidenceSchema>

/** Validates and seals Evidence in the `evidence` digest domain. */
export function sealEvidence(payload: unknown): Evidence {
  const body = parseProtocolValue(evidencePayloadSchema, payload)
  return seal('evidence', body)
}

/** Accepts only strict Evidence whose `evidence` domain digest matches. */
export function verifyEvidence(value: unknown): value is Evidence {
  try {
    const evidence = parseProtocolValue(evidenceSchema, value)
    return verifyDigest('evidence', evidence)
  } catch {
    return false
  }
}

/** Frozen contract and run identity used to check an Evidence object. */
export interface EvidenceExpectation {
  readonly contract: TaskContract
  readonly runId: string
  readonly composition: Ref
}

export type EvidenceValidation =
  | { readonly valid: true; readonly evidence: Evidence }
  | { readonly valid: false; readonly reason: string }

/**
 * Checks Evidence identity against the frozen contract and Run. Usage,
 * session cut, and receipt refs are validated by the runtime that owns their
 * snapshot; this function never reads CAS.
 */
export function validateEvidence(
  value: unknown,
  expected: EvidenceExpectation,
): EvidenceValidation {
  let evidence: Evidence
  try {
    evidence = parseProtocolValue(evidenceSchema, value)
  } catch (error) {
    return { valid: false, reason: `Evidence is not a strict sealed object: ${errorMessage(error)}` }
  }
  if (!verifyDigest('evidence', evidence)) {
    return { valid: false, reason: 'Evidence digest is not a valid evidence-domain seal' }
  }
  if (!verifyTaskContract(expected.contract)) {
    return { valid: false, reason: 'expected contract is not a valid sealed TaskContract' }
  }
  if (evidence.task.id !== expected.contract.taskId) {
    return { valid: false, reason: 'Evidence task id does not match the frozen contract' }
  }
  if (evidence.task.digest !== expected.contract.digest) {
    return { valid: false, reason: 'Evidence task digest does not match the frozen contract' }
  }
  if (evidence.contractDigest !== expected.contract.digest) {
    return { valid: false, reason: 'Evidence contractDigest does not match the frozen contract' }
  }
  if (evidence.runId !== expected.runId) {
    return { valid: false, reason: 'Evidence runId does not match the Run' }
  }
  if (!sameRef(evidence.method, expected.contract.method)) {
    return { valid: false, reason: 'Evidence method does not match the frozen contract method' }
  }
  if (!sameRef(evidence.composition, expected.composition)) {
    return { valid: false, reason: 'Evidence composition does not match the opened Run composition' }
  }
  if (evidence.environment.seed !== expected.contract.environment.seed.digest) {
    return { valid: false, reason: 'Evidence environment seed does not match the frozen contract seed' }
  }
  return { valid: true, evidence }
}
