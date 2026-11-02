import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { decomposeCommitSchema, planningSketchSchema, protocolJsonSchema } from '@singularity/protocol'
import type { JsonValue } from '@singularity/protocol'

/** Syntax-only examples; current identities and objectives come from the Task view. */
export const taskToolExamples: Record<string, JsonValue> = {
  singularity_read: { kind: 'self' },
  singularity_plan: { sketch: { v: 1, taskId: 'task', runId: 'run', contextEpoch: 'current-epoch',
    sourceContract: `sha256:${'0'.repeat(64)}`, objective: 'Produce the result.',
    levels: [0, 1].map(level => ({ level, purpose: 'Work at this level.', likelyChildren: [], expectedInputs: [], expectedOutputs: [] })),
    directPlan: [], assumptions: [] } },
  singularity_decompose: { action: 'commit', children: [{ bindingId: 'platform:explore-child',
    ackPreview: `sha256:${'0'.repeat(64)}`, task: { goal: { summary: 'Inspect one component.', deliverable: 'A report.', scope: [], constraints: [] },
      inputs: [], localCriteria: [], localOutputs: [] } }] },
  singularity_feedback: { kind: 'needs-replan', summary: 'Clarify this component boundary.', proposedChanges: [], refs: [] },
  singularity_submit: { outputIds: ['result'], includeLearningDrafts: false },
  singularity_stop: { reason: 'unsolved', message: 'The required result is incomplete.' },
}

/** A readable public protocol asset, frozen into the normal resource catalog by the host. */
export const taskProtocolReference: JsonValue = {
  v: 1,
  planning: {
    levels: 'Exactly [0,1] or [0,1,2]. Level 0 is the current Task, level 1 its direct children, level 2 possible grandchildren. Levels describe Task hierarchy, not sequential computation steps.',
    execution: 'Refine the initial sketch after resource discovery. Delegate long-chain stages by output and check boundaries, using successive batches for sequential stages. Only directPlan and a later decompose commit select direct children; each child organizes deeper work. A sketch creates no Tasks. A leaf goal is one bounded, directly verifiable unit.',
    epoch: 'Read the current contextEpoch from NodeView. Resume or native compaction can change it; a child admission alone is not proof of an epoch change.',
    schema: protocolJsonSchema(planningSketchSchema),
  },
  decompose: protocolJsonSchema(decomposeCommitSchema),
  examples: taskToolExamples,
  method: 'Templates and bindings are editable by RSI for future roots. Read the pinned guidance/example assets before replacing them. Register skill/MCP assets in the Method before binding their IDs; public exploration assets are a separate catalog. Required join comes from the binding, not TaskProposal.',
  skills: 'Bound skills use native DSH discovery; directory resources include frozen relative files. Use the path returned by the skill tool for bundled scripts.',
  results: 'Read evidence with a direct child ID or lastAttempt.runId. Join every data text page to parse {result,publicReceipt?}; publicReceipt.criteria contains the independent findings. Frozen child outputs are under children/; the previous attempt is under lastAttempt.outputsPath. Copy useful artifacts to your current outputs and correct the observed failures before resubmitting. Prior transcripts and private receipts are not exposed.',
}

export const planningParameters = {
  sketch: { type: 'json', required: true,
    description: 'Hierarchy [0,1] or [0,1,2]: self, children, possible grandchildren. Refine after discovery; delegate long-chain stages in direct batches. A bounded verifiable leaf has no children.',
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
  action: { type: 'string', required: true, description: '"prepare" reads an example; "commit" admits a prepared batch.' },
  bindingId: { type: 'string', description: 'NodeView childOptions bindingId for prepare.' },
  children: { type: 'json', description: 'ackPreview=previewRef.digest. Probe allows multiple instances per batch and later batches; required one per batch. Use complete authorized input refs. Required outputs inherited; localOutputs adds supporting outputs or [].' },
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
