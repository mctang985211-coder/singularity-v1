import { z } from 'zod'

import { digestSchema } from './digest.ts'
import { refSchema } from './refs.ts'
import { closedObject } from './schema.ts'

const levelFields = {
  purpose: z.string(),
  likelyChildren: z.array(z.string()),
  expectedInputs: z.array(z.string()),
  expectedOutputs: z.array(z.string()),
}

const levelZeroSchema = closedObject({
  level: z.literal(0),
  ...levelFields,
})

const levelOneSchema = closedObject({
  level: z.literal(1),
  ...levelFields,
})

const levelTwoSchema = closedObject({
  level: z.literal(2),
  ...levelFields,
})

/**
 * Levels are exactly the ordered sequences [0, 1] or [0, 1, 2]: level 0 is
 * the current Task, level 1 its direct children, and level 2 optional
 * grandchildren. Empty, partial, duplicate, reordered, skipped, and longer
 * sequences are rejected.
 */
const planningSketchLevelsSchema = z.union([
  // This Zod version emits prefixItems without tuple length bounds by default.
  // Explicit checks preserve the same accepted values in the model's JSON Schema.
  z.tuple([levelZeroSchema, levelOneSchema]).check(z.minLength(2), z.maxLength(2)),
  z.tuple([levelZeroSchema, levelOneSchema, levelTwoSchema]).check(z.minLength(3), z.maxLength(3)),
])

const planningSketchDirectPlanSchema = closedObject({
  bindingId: z.string(),
  purpose: z.string(),
})

/**
 * Model-authored plan from docs/framework.md §6.3. It is structural input to
 * `singularity_plan`; it creates no Task, Method, workflow, scheduling, or
 * acceptance authority. `directPlan` is a flat list of level-1 direct-child
 * intents; it has no level field and never expresses level 2.
 */
export const planningSketchSchema = closedObject({
  v: z.literal(1),
  taskId: z.string(),
  runId: z.string(),
  contextEpoch: z.string(),
  objective: z.string(),
  levels: planningSketchLevelsSchema,
  directPlan: z.array(planningSketchDirectPlanSchema),
  assumptions: z.array(z.string()),
  sourceContract: digestSchema,
})

export type PlanningSketch = z.infer<typeof planningSketchSchema>

/** The model supplies suggestions only; caller identity belongs to the host. */
export const taskFeedbackInputSchema = closedObject({
  kind: z.enum(['needs-replan', 'input-invalid', 'acceptance-concern', 'blocked']),
  summary: z.string(),
  replyTo: z.string().optional(),
  refs: z.array(refSchema),
})

export type TaskFeedbackInput = z.infer<typeof taskFeedbackInputSchema>

/** Read-only direct-parent feedback from framework §7.2; never a domain fact. */
export const taskFeedbackSchema = taskFeedbackInputSchema.extend({
  v: z.literal(1),
  id: z.string(),
  source: z.enum(['scheduler', 'child-worker', 'parent-worker']),
  sourceTaskId: z.string(),
  sourceRunId: z.string(),
  directParentTaskId: z.string(),
  sourceContract: digestSchema,
  createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict()

export type TaskFeedback = z.infer<typeof taskFeedbackSchema>
