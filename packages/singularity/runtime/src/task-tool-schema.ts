import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { decomposeCommitSchema, EXPLORE_EXAMPLE, planningSketchSchema, protocolJsonSchema } from '@singularity/protocol'
import type { JsonValue } from '@singularity/protocol'

/** Syntax-only examples; current identities and objectives come from the Task view. */
export const taskToolExamples: Record<string, JsonValue> = {
  singularity_read: { kind: 'self' },
  singularity_plan: { sketch: { v: 1, taskId: 'task', runId: 'run', contextEpoch: 'current-epoch',
    sourceContract: `sha256:${'0'.repeat(64)}`, objective: 'Deliver a report from frozen records.',
    levels: [{ level: 0, purpose: 'Integrate aggregation and reporting; check the final report.', likelyChildren: ['platform:explore-child'], expectedInputs: ['records.json'], expectedOutputs: ['validated report'] },
      { level: 1, purpose: 'Aggregate known records first; define reporting after inspecting the returned totals and CLI.', likelyChildren: [], expectedInputs: ['frozen records or totals'], expectedOutputs: ['executable stage and consumable output'] }],
    directPlan: [{ bindingId: 'platform:explore-child', purpose: 'Implement aggregation from ready records; retain report integration and consumer checks here.' }], assumptions: ['Aggregation is bounded by the supplied records and exact sum rule. Estimate execution cost from input size; reserve time for CLI verification and the later report stage.'] } },
  singularity_decompose: { action: 'commit', children: [{ bindingId: 'platform:explore-child',
    ackPreview: `sha256:${'0'.repeat(64)}`, task: { goal: EXPLORE_EXAMPLE.goal,
      inputs: [{ id: 'records', object: { id: 'example:records', digest: `sha256:${'0'.repeat(64)}` }, path: 'records.json', access: 'copy-to-work' }],
      acceptanceCriteria: EXPLORE_EXAMPLE.acceptanceCriteria, localOutputs: EXPLORE_EXAMPLE.localOutputs } }] },
  singularity_feedback: { kind: 'needs-replan', summary: 'Clarify this component boundary.', refs: [] },
  singularity_submit: { outputIds: ['result', 'totals'], includeLearningDrafts: false },
  singularity_stop: { reason: 'unsolved', message: 'The required result is incomplete.' },
}

/** A readable public protocol asset, frozen into the normal resource catalog by the host. */
export const taskProtocolReference: JsonValue = {
  v: 1,
  planning: {
    levels: 'Exactly [0,1] or [0,1,2]. Level 0 is the current Task, level 1 its direct children, level 2 possible grandchildren. Levels describe responsibility scopes; dependencies execute in successive batches.',
    execution: 'After discovery, use purpose/assumptions for functions, prerequisites, output consumers, evidence, estimated cost and uncertainty, including integration and verification. Look ahead through the completion path; commit only ready direct responsibilities and consume prerequisite results before defining downstream contracts. Each child organizes deeper work. A leaf has settled prerequisites and one directly verifiable result; sharing a checkout is insufficient. A sketch creates no Tasks; decompose commit admits them.',
    epoch: 'Read the current contextEpoch from NodeView. Resume or native compaction can change it; a child admission alone is not proof of an epoch change.',
    schema: protocolJsonSchema(planningSketchSchema),
  },
  decompose: protocolJsonSchema(decomposeCommitSchema),
  examples: taskToolExamples,
  handoffExample: [
    'Illustration: the parent owns a final report workflow; the example child owns the complete aggregation stage. Discover the actual stages for your Task.',
    'Read self, plan, prepare explore-child, then commit the aggregation contract with the authorized records InputRef. Replace illustrative identities with actual returned values. Each child discovers its own workflow and may organize direct children.',
    'After the batch finishes, read children and evidence, following all pages. Inspect the frozen result/aggregate.py and totals output; check the CLI and revise assumptions/cost estimates before defining its consumer. If the result changes the premise, discuss it through feedback and replan.',
    'Prepare a later report batch. Copy the totals output InputRef fields id/object/path/access unchanged into that child inputs. Its goal defines the JSON totals interface and report format; author checks that compare the report with those totals. An access:read input is read with singularity_read(kind="resource", id=...), not a sibling workspace path.',
    'Read the report result, integrate both stages into this Task outputs and test the actual report consumer against the original records and this Task acceptance. Local passes do not replace this integration check. A failed interface leads to corrected work or a new contract through feedback.',
  ],
  method: 'Templates and bindings are editable by RSI for future roots. Read the pinned guidance/example assets before replacing them. Register skill/MCP assets in the Method before binding their IDs; public exploration assets are a separate catalog. Required join comes from the binding, not TaskProposal.',
  skills: 'Bound skills use native DSH discovery; directory resources include frozen relative files. Use the path returned by the skill tool for bundled scripts.',
  results: 'Read evidence with a direct child ID or lastAttempt.runId. Join ALL data pages to parse {outputs,result,publicReceipt?}; outputs gives complete authorized InputRefs to copy unchanged into child contracts. publicReceipt.criteria contains independent findings, including gaps in passing verdicts. Correct those gaps before resubmitting; preserve the parent goal. Prior transcripts and private receipts are not exposed.',
}

export const planningParameters = {
  sketch: { type: 'json', required: true,
    description: 'Levels [0,1] or [0,1,2]: self, direct children, possible grandchildren. purpose/assumptions: dependencies, consumers, evidence, cost/uncertainty.',
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
  children: { type: 'json', description: 'ackPreview=previewRef.digest; copy InputRefs unchanged. Checks use bash -e -o pipefail with captured stdout/stderr and ONLY frozen inputs/outputs. Required outputs inherited; localOutputs adds files or [].' },
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
