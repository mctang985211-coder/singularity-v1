import { z } from 'zod'

import { digestSchema } from './digest.ts'
import { closedObject } from './schema.ts'

const planningSketchLevelSchema = closedObject({
  level: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  purpose: z.string(),
  likelyChildren: z.array(z.string()),
  expectedInputs: z.array(z.string()),
  expectedOutputs: z.array(z.string()),
})

const planningSketchDirectPlanSchema = closedObject({
  bindingId: z.string(),
  purpose: z.string(),
})

/**
 * Model-authored plan from docs/framework.md §6.3. It is structural input to
 * `singularity_plan`; it creates no Task, Method, workflow, scheduling, or
 * acceptance authority.
 */
export const planningSketchSchema = closedObject({
  v: z.literal(1),
  taskId: z.string(),
  runId: z.string(),
  contextEpoch: z.string(),
  objective: z.string(),
  levels: z.array(planningSketchLevelSchema),
  directPlan: z.array(planningSketchDirectPlanSchema),
  assumptions: z.array(z.string()),
  sourceContract: digestSchema,
})

export type PlanningSketch = z.infer<typeof planningSketchSchema>
