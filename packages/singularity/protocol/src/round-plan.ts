import { z } from 'zod'

import { jsonObjectSchema } from './json.ts'
import { refSchema } from './refs.ts'
import { closedObject, parseProtocolValue } from './schema.ts'
import { resourceBindingSchema, taskContractPayloadSchema } from './task.ts'

/** Fixed root case; each evaluation arm supplies only Method bindings. */
export const evaluationCaseSchema = taskContractPayloadSchema.pick({
  v: true, spec: true, acceptance: true, environment: true, limits: true,
}).extend({
  baseTools: resourceBindingSchema.shape.baseTools,
  exploration: resourceBindingSchema.shape.exploration,
})
export type EvaluationCase = z.infer<typeof evaluationCaseSchema>

/** Metric policy belongs to the domain comparator, not the framework. */
export const metricSpecSchema = jsonObjectSchema
export type MetricSpec = z.infer<typeof metricSpecSchema>

/** Frozen purchase and comparison policy from framework §18. */
export const roundPlanSchema = closedObject({
  v: z.literal(1),
  cases: z.array(refSchema),
  metric: metricSpecSchema,
  thresholds: closedObject({
    minDelta: z.number().nonnegative(),
    maxRegression: z.number().nonnegative(),
    maxRelativeCostIncrease: z.number().nonnegative().optional(),
  }),
  trialsPerCase: z.number().int().positive(),
  proposerBudget: closedObject({
    maxSteps: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    maxWallClockMs: z.number().int().positive(),
  }),
  budget: closedObject({
    maxRuns: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    maxWallClockMs: z.number().int().positive(),
    maxActiveRuns: z.number().int().positive(),
  }),
  validation: z.enum(['none', 'required-by-domain']),
  validationCases: z.array(refSchema),
  claim: z.enum(['source-replay', 'domain-evaluation']),
  comparator: refSchema,
  sourceSeed: refSchema,
  expectedPreviousActiveMethod: refSchema,
})

export type RoundPlan = z.infer<typeof roundPlanSchema>

/** Check purchase feasibility before any proposer or trial request. */
export function validateRoundPlan(value: unknown): RoundPlan {
  const plan = parseProtocolValue(roundPlanSchema, value)
  if (plan.cases.length === 0) throw new Error('RoundPlan requires at least one case')
  if (plan.validation === 'none' && plan.claim !== 'source-replay') {
    throw new Error('Evaluation without independent validation can only claim source-replay')
  }
  if (plan.validation === 'required-by-domain' && plan.validationCases.length === 0) {
    throw new Error('required validation needs independent cases')
  }
  const refs = [...plan.cases, ...plan.validationCases]
  if (new Set(refs.map(ref => `${ref.id}:${ref.digest}`)).size !== refs.length) {
    throw new Error('RoundPlan cases must be distinct, including validation')
  }
  const slots = refs.length * 2 * plan.trialsPerCase
  if (!Number.isSafeInteger(slots) || slots > plan.budget.maxRuns) {
    throw new Error('RoundPlan maxRuns cannot purchase every frozen slot')
  }
  return plan
}
