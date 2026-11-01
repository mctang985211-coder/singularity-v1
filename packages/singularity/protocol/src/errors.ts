import { z } from 'zod'

/** Frozen protocol rejection codes from docs/framework.md §14.1. */
export const TOOL_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'READ_SELF_FIRST',
  'PLAN_FIRST',
  'PREVIEW_REQUIRED',
  'PREVIEW_STALE',
  'NEXT_STEP_REQUIRED',
  'CHILD_BATCH_ACTIVE',
  'REQUIRED_FEEDBACK_REPLAN',
  'INPUT_NOT_AUTHORIZED',
  'BINDING_FIXED',
  'LIMIT_EXCEEDED',
  'ALREADY_SUBMITTED',
  'RUN_CLOSED',
  'COMPOSITION_MISMATCH',
  'IDEMPOTENCY_CONFLICT',
] as const

export const toolErrorCodeSchema = z.enum(TOOL_ERROR_CODES)

export type ToolErrorCode = z.infer<typeof toolErrorCodeSchema>

/**
 * Model-visible remaining budget percentages from docs/framework.md §12.2.
 * Token budget is unknown when the host cannot expose a reliable fraction.
 *
 * This module stays a leaf: schema.ts depends on json.ts, which imports these
 * errors, so the strict tool-surface schemas use z.strictObject directly.
 */
export const remainingBudgetPctSchema = z.strictObject({
  tokensPct: z.number().min(0).max(100).nullable(),
  stepsPct: z.number().min(0).max(100),
  wallClockPct: z.number().min(0).max(100),
  depthPct: z.number().min(0).max(100),
  taskSlotsPct: z.number().min(0).max(100),
})

export type RemainingBudgetPct = z.infer<typeof remainingBudgetPctSchema>

/**
 * Short DSH tool failure payload from docs/framework.md §14.1.
 * `nextAction` describes the positive next step for the current model.
 */
export const toolErrorSchema = z.strictObject({
  code: toolErrorCodeSchema,
  nextAction: z.string(),
  remainingBudgetPct: remainingBudgetPctSchema,
})

export type ToolError = z.infer<typeof toolErrorSchema>

/** Preserve the original message while keeping the caller's non-Error fallback. */
export function errorMessage(error: unknown, fallback = String(error)): string {
  return error instanceof Error ? error.message : fallback
}
