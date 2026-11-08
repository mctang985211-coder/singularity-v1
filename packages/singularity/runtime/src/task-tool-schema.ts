import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { decomposeCommitSchema, EXPLORE_EXAMPLE, planningSketchDraftSchema, protocolJsonSchema } from '@singularity/protocol'
import type { JsonValue } from '@singularity/protocol'

/** Syntax-only examples; current identities and objectives come from the Task view. */
export const taskToolExamples: Record<string, JsonValue> = {
  singularity_read: { kind: 'self' },
  singularity_plan: { sketch: { v: 1, objective: 'Deliver a consumable result from the declared input.',
    levels: [{ level: 0, purpose: 'Integrate the consumer and check its declared output.', likelyChildren: ['platform:explore-child'], expectedInputs: ['declared input'], expectedOutputs: ['consumable result'] },
      { level: 1, purpose: 'Implement the callable consumer and inspect its output interface before integration.', likelyChildren: [], expectedInputs: ['frozen input'], expectedOutputs: ['executable consumer and output'] }],
    directPlan: [{ bindingId: 'platform:explore-child', purpose: 'Implement one ready consumer responsibility and return an output this level will consume.' }], assumptions: ['The consumer is bounded by the declared input and its external contract. Estimate execution cost from input size and reserve time for interface checks.'] } },
  singularity_decompose: { action: 'commit', children: [{ bindingId: 'platform:explore-child',
    ackPreview: `sha256:${'0'.repeat(64)}`, task: { goal: EXPLORE_EXAMPLE.goal,
      inputs: [{ id: 'input', object: { id: 'example:input', digest: `sha256:${'0'.repeat(64)}` }, path: 'input.bin', access: 'copy-to-work' }],
      acceptanceCriteria: EXPLORE_EXAMPLE.acceptanceCriteria, localOutputs: EXPLORE_EXAMPLE.localOutputs } }] },
  singularity_feedback: { kind: 'needs-replan', summary: 'Clarify this component boundary.', refs: [] },
  singularity_submit: { outputIds: ['result'], includeLearningDrafts: false },
  singularity_stop: { reason: 'unsolved', message: 'The required result is incomplete.' },
}

/** A readable public protocol asset, frozen into the normal resource catalog by the host. */
export const taskProtocolReference: JsonValue = {
  v: 1,
  planning: {
    levels: 'Exactly [0,1] or [0,1,2]. Level 0 is the current Task, level 1 its direct children, level 2 possible grandchildren. Levels describe responsibility scopes; dependencies execute in successive batches.',
    execution: 'Use purpose/assumptions for prerequisites, output consumers, evidence and cost/uncertainty. Commit ready implementation responsibilities whose frozen outputs this level will consume; host verification is not a child responsibility. Consume prerequisite results before downstream contracts. Each child organizes deeper work; a sketch creates no Tasks.',
    epoch: 'Submit business fields only. The host stamps taskId, runId, contextEpoch and sourceContract from the current Run; resume or native compaction can change the host epoch.',
    schema: protocolJsonSchema(planningSketchDraftSchema),
  },
  decompose: protocolJsonSchema(decomposeCommitSchema),
  examples: taskToolExamples,
  acceptance: {
    authoring: 'Before dispatch, write checks for this actual goal, frozen inputs and consumer. Examples are references, never inherited obligations.',
    positive: 'python3 tools/check_consumer.py --input project.json --output result/response.json',
    negative: 'cp result/response.json bad.json\npython3 tools/mutate_response.py bad.json\nif python3 tools/check_consumer.py --input project.json --output bad.json; then echo "checker accepted invalid output" >&2; exit 1; fi',
    concern: 'Before implementation, explain what the check measures, what the parent needs, a reproducible difference and a suggested check via acceptance-concern. replyTo clarifies; stop(blocked) then a new Task changes the contract. Reuse complete frozen output InputRefs.',
    integration: 'A child checks its local result; the parent invokes the actual consumer and verifies integration against original inputs. The root checks the complete goal.',
  },
  handoffExample: [
    'Illustration: the parent owns final integration; the example child owns one complete consumer stage. Discover the actual stages for your Task.',
    'Read self, plan, prepare explore-child, then commit the consumer contract with the authorized InputRef. Replace illustrative identities with actual returned values. Each child discovers its own workflow and may organize direct children.',
    'After the batch finishes, read children and evidence, following all pages. Inspect the frozen consumer and declared output; invoke the actual interface and revise assumptions/cost estimates before defining the integration stage. If the result changes the premise, discuss it through feedback and replan.',
    'Prepare a later integration batch. Copy the supporting output InputRef fields id/object/path/access unchanged into that child inputs. Its goal defines the external output interface and report format; author checks that compare the final consumer with those inputs. An access:read input is read with singularity_read(kind="resource", id=...), not a sibling workspace path.',
    'Read the consumer result, integrate it into this Task outputs and test the actual end-to-end consumer against the original declared input and this Task acceptance. Local passes do not replace this integration check. A failed interface leads to corrected work or a new contract through feedback.',
  ],
  method: 'Templates and bindings are editable by RSI for future roots. Read the pinned guidance/example assets before replacing them. Bind changed assets into entry-reachable templates; unreachable additions are no-ops. The host composes the same frozen public capabilities for all templates; bind only Method-owned additions. Required join comes from the binding, not TaskProposal.',
  skills: 'Bound skills use native DSH discovery; directory resources include frozen relative files. Use the path returned by the skill tool for bundled scripts.',
  results: 'Children pages include goalSummary/deliverable for integration. Read evidence by child/result Ref or lastAttempt.runId and join ALL data pages into {outputs,result,publicReceipt?}; outputs are complete InputRefs. Resolve remaining contract findings without creating another review layer. Prior transcripts and private receipts are not exposed.',
}

export const planningParameters = {
  sketch: { type: 'json', required: true,
    description: 'Levels [0,1] or [0,1,2]: self, direct children, possible grandchildren. purpose/assumptions: dependencies, consumers, evidence, cost/uncertainty.',
  },
} as const

const planning = protocolJsonSchema(planningSketchDraftSchema)
delete planning.$schema
export const planningInputSchema: ToolDefinition['parameters'] = {
  ...parameterSchemaSpecToJsonSchema(planningParameters),
  properties: { sketch: { ...planning, description: planningParameters.sketch.description } },
}

/** DSH declarations for Task tools; protocol admission remains authoritative. */
export const decomposeParameters = {
  action: { type: 'string', required: true, description: '"prepare" reads an example; "commit" admits a prepared batch.' },
  bindingId: { type: 'string', description: 'NodeView childOptions bindingId for prepare.' },
  children: { type: 'json', description: 'ackPreview=previewRef.digest; copy InputRefs unchanged. Checks use bash -e -o pipefail with captured streams and only frozen inputs/outputs. Every child delivers the required result/ tree; localOutputs adds supporting files/trees or is omitted/[].' },
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
