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
    ackPreview: `sha256:${'0'.repeat(64)}`, task: { goal: { summary: 'Implement a stream adapter for parent integration.', deliverable: 'result/ with the adapter and reproducible stream checks.', scope: ['Consume the frozen kernel; parent retains the final all-suite integration check.'], constraints: ['Consumer interface: JSON stream requests -> exact output records.'] },
      inputs: [{ id: 'kernel', object: { id: 'frozen-kernel', digest: `sha256:${'0'.repeat(64)}` }, path: 'kernel', access: 'copy-to-work' }], localCriteria: [], localOutputs: [],
      acceptanceChecks: [{ criterionId: 'task-goal', checks: [{ checkId: 'stream', recipeRef: { id: 'public-stream-check', digest: `sha256:${'0'.repeat(64)}` }, params: { candidate: 'result/adapter', suite: 'stream' } }] }] } }] },
  singularity_feedback: { kind: 'needs-replan', summary: 'Clarify this component boundary.', proposedChanges: [], refs: [] },
  singularity_submit: { outputIds: ['result'], includeLearningDrafts: false },
  singularity_stop: { reason: 'unsolved', message: 'The required result is incomplete.' },
}

/** A readable public protocol asset, frozen into the normal resource catalog by the host. */
export const taskProtocolReference: JsonValue = {
  v: 1,
  planning: {
    levels: 'Exactly [0,1] or [0,1,2]. Levels describe responsibility scopes: 0=this Task, 1=direct next-layer units, 2=possible deeper units. Levels do not schedule execution; describe dependencies in the completion path and execute dependent work in successive batches.',
    execution: 'Describe the completion path, dependencies, retained work, handoffs and unassigned responsibilities using objective, expectedInputs/expectedOutputs, directPlan.purpose and assumptions. Refine after resource discovery or feedback. Create next-layer work units with consumable outputs and direct checks; each unit owns its scope and integration. Only a later commit creates direct children. Work locally on bounded directly verifiable goals.',
    epoch: 'Read the current contextEpoch from NodeView. Resume or native compaction can change it; a child admission alone is not proof of an epoch change.',
    schema: protocolJsonSchema(planningSketchSchema),
  },
  decompose: protocolJsonSchema(decomposeCommitSchema),
  dependentBatches: {
    first: {
      prepare: { action: 'prepare', bindingId: 'platform:explore-child' },
      commitOnLaterStep: { action: 'commit', children: [{ bindingId: 'platform:explore-child', ackPreview: `sha256:${'0'.repeat(64)}`,
        task: {
          goal: { summary: 'Implement the bounded kernel interface.', deliverable: 'result/ with a kernel consumed by the next stream-adapter unit.',
            scope: ['Consume the frozen source specification; produce the exact per-record kernel interface.'],
            constraints: ['Parent retains stream adaptation and final all-suite integration.'] },
          inputs: [{ id: 'source', object: { id: 'frozen-source', digest: `sha256:${'0'.repeat(64)}` }, path: 'source.json', access: 'copy-to-work' }],
          localCriteria: [], localOutputs: [],
          acceptanceChecks: [{ criterionId: 'task-goal', checks: [{ checkId: 'kernel', recipeRef: { id: 'public-kernel-check', digest: `sha256:${'0'.repeat(64)}` }, params: { candidate: 'result/kernel', suite: 'kernel' } }] }],
        } }],
      },
    },
    handoff: 'After the batch is terminal, read children and evidence. Check the produced interface locally. Copy the complete returned output InputRef; use the frozen output as the next unit input.',
    second: 'Prepare again and use examples.singularity_decompose for a stream adapter consuming that frozen kernel. Replace every illustrative Ref and ackPreview with the current authorized values; select an allowed recipe and valid params. Use acceptanceChecks:[] when template checks are already complete.',
    integrate: 'Read the adapter result, integrate locally and run the parent all-suite check against the real consumer. A local child pass covers its own contract.',
  },
  examples: taskToolExamples,
  method: 'Templates and bindings are editable by RSI for future roots. Read the pinned guidance/example assets before replacing them. Register skill/MCP assets in the Method before binding their IDs; public exploration assets are a separate catalog. Required join comes from the binding, not TaskProposal.',
  skills: 'Use skills as technical references and candidate procedures for this Task. Choose relevant parts from the current goal, inputs and checks; build your own local workflow under the frozen scope and acceptance policy. Load referenced skills by native skill(name=...) and bundled references/scripts from the returned resourceBase.',
  checks: 'Read self for bound checks, allowed recipe refs/params and derived command/report previews. Bind checks for every required criterion through acceptanceChecks before admission; use [] only when the template already supplies every required check. localCriteria is guidance. Execute public checks during work and correct failures; submit freezes outputs for independent reproduction of the same checks.',
  inputs: 'Copy complete authorized InputRefs from self or direct children, including object.id/object.digest, path and access. inputs:[] is for public-resource work independent of Task artifacts. A binary resource is available at its authorized local path; obtain its Ref from self rather than computing a digest.',
  results: 'Read evidence with a direct child ID or lastAttempt.runId. Join every data text page to parse {result,publicReceipt?}; publicReceipt.criteria contains the independent findings. Frozen child outputs are under children/; the previous attempt is under lastAttempt.outputsPath. Read each failed criterion and check report before retry. Update the sketch with the observed implementation, interface, evidence, input or environment problem and the assumption it disproved. Choose local correction, a new bounded batch or a concrete blocker. Reuse useful frozen artifacts, rerun checks affected by changes, then integrate and verify the actual consumer. Prior transcripts and private receipts are not exposed.',
}

export const planningParameters = {
  sketch: { type: 'json', required: true,
    description: 'Use levels [0,1] or [0,1,2]. Creates no Task.',
  },
} as const

const planning = protocolJsonSchema(planningSketchSchema, { reused: 'ref' })
delete planning.$schema
const planningDefinitions = planning.$defs
delete planning.$defs
export const planningInputSchema: ToolDefinition['parameters'] = {
  ...parameterSchemaSpecToJsonSchema(planningParameters),
  $defs: planningDefinitions,
  properties: { sketch: { ...planning, description: planningParameters.sketch.description } },
}

/** DSH declarations for Task tools; protocol admission remains authoritative. */
export const decomposeParameters = {
  action: { type: 'string', required: true, description: 'prepare or commit.' },
  bindingId: { type: 'string', description: 'Prepare binding from NodeView.' },
  children: { type: 'json', description: 'ackPreview=previewRef.digest. Probe: many instances; required: one/batch. Copy full InputRefs. Bind required acceptanceChecks. Chain dependent batches. localOutputs adds supporting outputs or [].' },
} as const

const parameters = parameterSchemaSpecToJsonSchema(decomposeParameters)
const children = protocolJsonSchema(decomposeCommitSchema.shape.children, { reused: 'ref' })
delete children.$schema
const childDefinitions = children.$defs
delete children.$defs
// DSH native ToolDefinition accepts JSON Schema; the DSL's json node omits these fields.
export const decomposeInputSchema: ToolDefinition['parameters'] = {
  ...parameters,
  $defs: childDefinitions,
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
    acceptanceChecks: { type: 'json' },
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
