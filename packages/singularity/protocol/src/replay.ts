import { z } from 'zod'

import { usageRecordSchema } from './fact.ts'
import { refSchema } from './refs.ts'
import { evaluationMetricSchema } from './round-plan.ts'
import { closedObject } from './schema.ts'

/**
 * Deployment-attested replay closure from docs/framework.md §18.2.
 * `closed` is only valid with a trusted runner proof and hermetic execution
 * controls; every other combination is a best-effort observation.
 */
export const replayClosureSchema = closedObject({
  level: z.enum(['closed', 'best-effort']),
  workspace: z.enum(['fresh-cas-inputs', 'uncontrolled']),
  network: z.enum(['disabled', 'frozen-broker', 'uncontrolled']),
  hostFilesystem: z.enum(['denied', 'read-only-cas-mounts', 'uncontrolled']),
  executionProof: refSchema.optional(),
  reasons: z.array(z.string()),
}).superRefine((closure, ctx) => {
  if (closure.level === 'closed') {
    if (closure.executionProof === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['executionProof'],
        message: 'closed replay requires a trusted runner executionProof',
      })
    }
    if (closure.workspace !== 'fresh-cas-inputs') {
      ctx.addIssue({
        code: 'custom',
        path: ['workspace'],
        message: 'closed replay requires fresh CAS inputs',
      })
    }
    if (closure.network === 'uncontrolled') {
      ctx.addIssue({
        code: 'custom',
        path: ['network'],
        message: 'closed replay requires disabled network or a frozen broker',
      })
    }
    if (closure.hostFilesystem === 'uncontrolled') {
      ctx.addIssue({
        code: 'custom',
        path: ['hostFilesystem'],
        message: 'closed replay requires denied or read-only CAS host filesystem',
      })
    }
    return
  }
  if (closure.executionProof !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['executionProof'],
      message: 'best-effort replay cannot claim an executionProof',
    })
  }
})

export type ReplayClosure = z.infer<typeof replayClosureSchema>

/** Deterministic utility-v1 features archived with a slice selection. */
export const sliceFeaturesSchema = closedObject({
  failed: z.boolean(),
  leaf: z.boolean(),
  retries: z.number().int().nonnegative(),
  subtreeTokens: z.number().nonnegative(),
  rootTokens: z.number().nonnegative(),
  priorAttempts: z.number().int().nonnegative(),
  qualityHeadroom: z.boolean(),
})

export type SliceFeatures = z.infer<typeof sliceFeaturesSchema>

/**
 * A Task-level replay anchor frozen as CAS research data. It is not a fact,
 * Round, Task state, or registry entry (§18.2).
 */
export const replayPointSchema = closedObject({
  v: z.literal(1),
  id: z.string(),
  sourceTrace: refSchema,
  sourceTaskId: z.string(),
  sourceContract: refSchema,
  sourceEvidence: refSchema,
  sourceCase: refSchema,
  baseMethod: refSchema,
  templateId: z.string(),
  bindingPath: z.array(z.string()),
  outcome: z.enum(['verified', 'failed']),
  localCases: z.array(refSchema).min(1).max(2),
  localMetric: evaluationMetricSchema.optional(),
  closure: replayClosureSchema,
  fanOut: closedObject({
    bindingReferences: z.number().int().nonnegative(),
    shared: z.boolean(),
  }),
  hostFingerprint: z.string(),
  baselinePolicy: z.enum(['strict', 'fresh-paired']).optional(),
  replayTolerance: closedObject({
    relative: z.number().nonnegative(),
  }).optional(),
}).superRefine((point, ctx) => {
  const sourceCase = point.localCases.some(
    candidate => candidate.id === point.sourceCase.id && candidate.digest === point.sourceCase.digest,
  )
  if (!sourceCase) {
    ctx.addIssue({
      code: 'custom',
      path: ['sourceCase'],
      message: 'sourceCase must be one of localCases',
    })
  }
})

export type ReplayPoint = z.infer<typeof replayPointSchema>

/** utility-v1 selection record including the exact features it scored. */
export const sliceSelectionSchema = closedObject({
  v: z.literal(1),
  campaignId: z.string(),
  point: replayPointSchema,
  features: sliceFeaturesSchema,
  policy: closedObject({
    name: z.literal('utility-v1'),
    revision: z.literal(1),
  }),
  visibleHistory: z.array(refSchema),
  score: z.number(),
  reasons: z.array(z.string()),
})

export type SliceSelection = z.infer<typeof sliceSelectionSchema>

/** Public-only history entry for prior root Rounds and slice attempts. */
export const proposalHistoryEntrySchema = closedObject({
  id: z.string(),
  baseMethod: refSchema,
  focusTemplateId: z.string().optional(),
  hypothesis: z.string().optional(),
  operations: z.array(z.string()),
  outcome: z.enum([
    'improved',
    'no-improvement',
    'local-qualified',
    'root-rejected',
    'rejected',
    'insufficient-evidence',
  ]),
  reason: z.string().optional(),
  aggregateDelta: z.number().optional(),
})

export type ProposalHistoryEntry = z.infer<typeof proposalHistoryEntrySchema>

/** Frozen local finalist policy; diagnostics never activate production. */
export const localFinalistPolicySchema = z.discriminatedUnion('kind', [
  closedObject({ kind: z.literal('root-quality') }),
  closedObject({
    kind: z.literal('engineering-cost-diagnostic'),
    minRelativeTokenReduction: z.number().positive().max(1),
  }),
])

export type LocalFinalistPolicy = z.infer<typeof localFinalistPolicySchema>

/** One candidate slice attempt; not an RSI Round and never an activation source. */
export const sliceAttemptSchema = closedObject({
  v: z.literal(1),
  attemptId: z.string(),
  campaignId: z.string(),
  selection: refSchema,
  patch: refSchema.optional(),
  candidateMethod: refSchema.optional(),
  proposalRecord: refSchema.optional(),
  localPlan: refSchema,
  comparison: refSchema.optional(),
  scope: closedObject({
    kind: z.enum(['bootstrap-entry', 'existing-template', 'expand-template']),
    sharedTemplate: z.boolean(),
    affectedTemplateIds: z.array(z.string()),
  }).optional(),
  outcome: z.enum([
    'local-qualified',
    'diagnostic-finalist',
    'duplicate-candidate',
    'no-improvement',
    'insufficient-evidence',
    'rejected',
    'proposer-failure',
  ]),
  reason: z.string().optional(),
  usage: usageRecordSchema,
  nativeRequests: z.number().int().nonnegative(),
  nativeCompleted: z.number().int().nonnegative(),
  runCount: z.number().int().nonnegative(),
  cacheComplete: z.boolean(),
})

export type SliceAttempt = z.infer<typeof sliceAttemptSchema>

/** Campaign accounting and finalist record; only the root Round can promote. */
export const sliceCampaignResultSchema = closedObject({
  v: z.literal(1),
  campaignId: z.string(),
  roundId: z.string(),
  finalistPolicy: localFinalistPolicySchema,
  selection: refSchema.optional(),
  baselineRoundId: z.string().optional(),
  baselineSlots: z.array(z.string()),
  hostFingerprint: z.string(),
  baselineFidelity: z.enum(['exact', 'verdict-drift']).optional(),
  attempts: z.array(refSchema),
  finalistAttempt: refSchema.optional(),
  outcome: z.enum([
    'finalist',
    'no-qualified-candidate',
    'not-replayable',
    'budget-exhausted',
  ]),
  reason: z.string().optional(),
  diagnostics: z.array(z.string()).optional(),
  localPlan: refSchema.optional(),
  budget: closedObject({
    maxTokens: z.number().int().positive(),
    maxRuns: z.number().int().positive(),
    maxWallClockMs: z.number().int().positive(),
  }),
  usage: usageRecordSchema,
  nativeRequests: z.number().int().nonnegative(),
  nativeCompleted: z.number().int().nonnegative(),
  runCount: z.number().int().nonnegative(),
  cacheComplete: z.boolean(),
}).superRefine((result, ctx) => {
  if (result.outcome === 'budget-exhausted' && result.finalistAttempt !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['finalistAttempt'],
      message: 'budget-exhausted campaigns cannot submit a finalist attempt',
    })
  }
  if (result.outcome === 'finalist' && result.finalistAttempt === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['finalistAttempt'],
      message: 'finalist campaigns must identify the finalist attempt',
    })
  }
  if (result.outcome !== 'finalist' && result.finalistAttempt !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['finalistAttempt'],
      message: 'only finalist campaigns may identify a finalist attempt',
    })
  }
})

export type SliceCampaignResult = z.infer<typeof sliceCampaignResultSchema>
