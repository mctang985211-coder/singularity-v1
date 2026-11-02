import { z } from 'zod'

import { digestSchema, seal } from './digest.ts'
import { jsonObjectSchema } from './json.ts'
import { refSchema } from './refs.ts'
import { closedObject, parseProtocolValue } from './schema.ts'

/** A frozen recipe selection. Display commands and expectations are derived. */
export const executableCheckSchema = closedObject({
  checkId: z.string().min(1),
  recipeRef: refSchema,
  params: jsonObjectSchema,
})
export type ExecutableCheck = z.infer<typeof executableCheckSchema>

export const proposedCriterionChecksSchema = closedObject({
  criterionId: z.string().min(1),
  checks: z.array(executableCheckSchema).min(1),
})
export type ProposedCriterionChecks = z.infer<typeof proposedCriterionChecksSchema>

/** Only these public fields are consumed from the domain's acceptance policy. */
export const acceptanceCheckPolicySchema = closedObject({
  checkRecipes: z.array(refSchema),
  checkResources: z.array(refSchema),
}).loose()
export type AcceptanceCheckPolicy = z.infer<typeof acceptanceCheckPolicySchema>

/** Domain adapters own parameter interpretation, execution, and pass rules. */
export const checkRecipeSchema = closedObject({
  v: z.literal(1),
  name: z.string().min(1),
  entrypoint: z.array(z.string().min(1)).min(1),
  dependencies: z.array(refSchema),
  paramsSchema: jsonObjectSchema,
  resultSchema: jsonObjectSchema,
  publicDataPolicy: z.string().min(1),
  passRule: z.string().min(1),
  maxWallClockMs: z.number().int().positive(),
}).loose()
export type CheckRecipe = z.infer<typeof checkRecipeSchema>

export const checkPreviewSchema = closedObject({
  criterionId: z.string().min(1),
  checkId: z.string().min(1),
  recipeRef: refSchema,
  params: jsonObjectSchema,
  displayCommand: z.array(z.string()),
  expectedReport: jsonObjectSchema,
})
export type CheckPreview = z.infer<typeof checkPreviewSchema>

export const publicCheckResultSchema = closedObject({
  checkId: z.string().min(1),
  verdict: z.enum(['pass', 'fail', 'invalid']),
  reportRef: refSchema,
})
export type PublicCheckResult = z.infer<typeof publicCheckResultSchema>

export const publicCheckReportPayloadSchema = closedObject({
  v: z.literal(1),
  operationId: z.string().min(1),
  contractDigest: digestSchema,
  criterionId: z.string().min(1),
  checkId: z.string().min(1),
  recipeRef: refSchema,
  inputDigests: z.array(digestSchema),
  outputDigests: z.array(digestSchema),
  exit: closedObject({ code: z.number().int().nullable(), signal: z.string().min(1).nullable() }),
  timedOut: z.boolean(),
  verdict: z.enum(['pass', 'fail', 'invalid']),
  data: jsonObjectSchema,
})
export type PublicCheckReportPayload = z.infer<typeof publicCheckReportPayloadSchema>
export const publicCheckReportSchema = publicCheckReportPayloadSchema.extend({ digest: digestSchema })
export type PublicCheckReport = z.infer<typeof publicCheckReportSchema>

export function sealPublicCheckReport(value: unknown): PublicCheckReport {
  return seal('object', parseProtocolValue(publicCheckReportPayloadSchema, value))
}
