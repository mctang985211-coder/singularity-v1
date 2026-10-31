import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { decomposeCommitSchema, planningSketchSchema, protocolJsonSchema } from '@singularity/protocol'
import type { JsonValue } from '@singularity/protocol'

/** A readable public protocol asset, frozen into the normal resource catalog by the host. */
export const taskProtocolReference: JsonValue = {
  v: 1,
  planning: {
    levels: 'Exactly [0,1] or [0,1,2]. Level 0 is the current Task, level 1 its direct children, level 2 possible grandchildren. Levels describe Task hierarchy, not sequential computation steps.',
    execution: 'Only directPlan and a later decompose commit select direct children. A sketch itself creates no Tasks. Each child plans and organizes its own level.',
    epoch: 'Read the current contextEpoch from NodeView. Resume or native compaction can change it; a child admission alone is not proof of an epoch change.',
    schema: protocolJsonSchema(planningSketchSchema),
  },
  decompose: protocolJsonSchema(decomposeCommitSchema),
  method: 'Templates and bindings are editable by RSI for future roots. Read the pinned guidance/example assets before replacing them. Required join comes from the binding, not TaskProposal.',
  skills: 'Bound skills use native DSH discovery; directory resources include frozen relative files. Use the path returned by the skill tool for bundled scripts.',
}

export const planningParameters = {
  sketch: { type: 'json', required: true,
    description: 'Ordered Task hierarchy [0,1] or [0,1,2]: this Task, direct children, possible grandchildren. Even a leaf includes level 1 with no likelyChildren and an empty directPlan. A sketch creates no Tasks; commit only direct children.',
  },
} as const

const planning = protocolJsonSchema(planningSketchSchema)
delete planning.$schema
export const planningInputSchema: ToolDefinition['parameters'] = {
  ...parameterSchemaSpecToJsonSchema(planningParameters),
  properties: { sketch: { ...planning, description: planningParameters.sketch.description } },
}

/** DSH declarations for Task tools; protocol admission remains authoritative. */
export const decomposeParameters = {
  action: { type: 'string', required: true, description: 'Use "prepare" to read a child example, or "commit" for a prepared batch.' },
  bindingId: { type: 'string', description: 'A bindingId from the current NodeView childOptions for prepare.' },
  children: { type: 'json', description: 'Commit prepared children using previewRef.digest as ackPreview. Copy complete authorized input refs, including object and path; preview exampleText is illustrative. Template required outputs are inherited; localOutputs adds distinct supporting outputs, or [].' },
} as const

const parameters = parameterSchemaSpecToJsonSchema(decomposeParameters)
const children = protocolJsonSchema(decomposeCommitSchema.shape.children)
delete children.$schema
// DSH native ToolDefinition accepts JSON Schema; the DSL's json node omits these fields.
export const decomposeInputSchema: ToolDefinition['parameters'] = {
  ...parameters,
  properties: {
    ...parameters.properties,
    children: { ...children, description: decomposeParameters.children.description },
  },
}

export const decomposeOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['preview', 'admitted'], required: true },
    previewRef: refValueSchema(false),
    deliveryReceiptRef: refValueSchema(false),
    bindingId: { type: 'string' },
    parentTaskId: { type: 'string' },
    parentRunId: { type: 'string' },
    templateId: { type: 'string' },
    templateRef: refValueSchema(false),
    methodRef: refValueSchema(false),
    join: { type: 'string', enum: ['required', 'probe'] },
    brief: { type: 'string' },
    example: { type: 'json' },
    interface: { type: 'json' },
    resolved: { type: 'json' },
    reminder: { type: 'string' },
    planningSketchRef: refValueSchema(false),
    contextEpoch: { type: 'string' },
    asOf: { type: 'integer' },
    batchId: { type: 'string' },
    children: { type: 'json' },
    remainingBudgetPct: budgetValueSchema(),
  },
} as const

export function refValueSchema(required: boolean) {
  return {
    type: 'object' as const,
    additionalProperties: false as const,
    ...(required ? { required: true as const } : {}),
    properties: {
      id: { type: 'string' as const, required: true as const },
      digest: { type: 'string' as const, required: true as const },
    },
  }
}

export function budgetValueSchema() {
  return {
    type: 'object' as const,
    additionalProperties: false as const,
    required: true as const,
    properties: {
      tokensPct: {
        oneOf: [
          { type: 'number' as const },
          { type: 'null' as const },
        ] as const,
        required: true as const,
      },
      stepsPct: { type: 'number' as const, required: true as const },
      wallClockPct: { type: 'number' as const, required: true as const },
      depthPct: { type: 'number' as const, required: true as const },
      taskSlotsPct: { type: 'number' as const, required: true as const },
    },
  }
}
