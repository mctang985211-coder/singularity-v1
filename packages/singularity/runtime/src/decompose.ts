import type { Session } from '@deepseek-ai/dsh-session'
import { canonicalize, seal, resolveTaskProposalSpec } from '@singularity/protocol'
import type { JsonObject, JsonValue, Ref, TaskContract } from '@singularity/protocol'

import type { DecomposePrepareResult, DecomposePreviewBody, DecomposePreviewDeliveryBody } from './decompose-preview.ts'
import { DecomposeError } from './errors.ts'
import type { ContextEpoch } from './epoch.ts'
import type { RemainingBudgetPct } from './prompt.ts'
import { loadTaskExample, readTemplateResourceSummaries, resolveResourceTemplate, resourceAssetCatalog } from './resources.ts'
import type { FrozenMethodResources } from './resources.ts'
import { findCurrentToolCall, readSessionToolView } from './receipts.ts'
import type { CasObjectReader, CasObjectWriter } from './workspace.ts'
import type { DescribeCheck } from './checks.ts'
import { prepareExecutableChecks } from './checks.ts'

const textEncoder = new TextEncoder()
const PREPARE_RESULT_MAX_BYTES = 32 * 1024
const PREVIEW_KIND = 'decompose-preview'
const DELIVERY_KIND = 'decompose-preview-delivery'

/** Frozen Method resources and read-only CAS access used by the prepare tool. */
export interface DecomposeToolContext {
  readonly methodResources: FrozenMethodResources
  readonly reader: CasObjectReader
  readonly describeCheck: DescribeCheck
}

export interface PrepareDecomposeInput {
  readonly contract: TaskContract
  readonly runId: string
  readonly sessionId: string
  readonly resources: FrozenMethodResources
  readonly reader: CasObjectReader
  readonly describeCheck: DescribeCheck
  readonly writer: CasObjectWriter
  readonly session: Session
  readonly callId: string
  readonly epoch: ContextEpoch
  readonly planningSketchRef: Ref
  readonly remainingBudgetPct: RemainingBudgetPct
  readonly asOf: number
}

export interface PrepareDecomposeOutput {
  readonly previewRef: Ref
  readonly deliveryReceiptRef: Ref
  readonly response: DecomposePrepareResult
}

/**
 * Builds one complete prepare response and persists only supporting CAS
 * objects. No fact, Task, Run, batch, workspace, or budget reservation is
 * created. The preview body is delivery-epoch independent; the delivery
 * receipt owns turn/step/epoch identity.
 */
export async function prepareDecompose(
  input: PrepareDecomposeInput,
  bindingId: string,
): Promise<PrepareDecomposeOutput> {
  const bindings = input.resources.template.children.filter(binding => binding.bindingId === bindingId)
  if (bindings.length !== 1) {
    throw new DecomposeError(
      'BINDING_FIXED',
      `child binding ${JSON.stringify(bindingId)} must exist exactly once on the current template`,
    )
  }
  const binding = bindings[0]
  const childTemplate = resolveResourceTemplate(input.resources, binding.templateId)
  if (childTemplate === undefined) {
    throw new DecomposeError(
      'BINDING_FIXED',
      `child template ${JSON.stringify(binding.templateId)} must exist exactly once in the pinned Method revision`,
    )
  }

  const view = readSessionToolView(input.session)
  const call = findCurrentToolCall(view, input.callId)
  if (call.name !== 'singularity_decompose') {
    throw new DecomposeError('INVALID_ARGUMENT', 'prepare must run from singularity_decompose')
  }
  if (input.epoch !== view.epoch) {
    throw new DecomposeError('PREVIEW_STALE', 'prepare context epoch is no longer current')
  }
  const example = await loadTaskExample(input.reader, childTemplate.example)
  const checks = await prepareExecutableChecks({ reader: input.reader, acceptance: childTemplate.acceptancePolicy,
    spec: resolveTaskProposalSpec(childTemplate, { ...example, inputs: [] }),
    limits: input.contract.limits, describeCheck: request => input.describeCheck({ ...request,
      spec: { ...request.spec, inputs: example.inputs.map(value => ({ path: `samples/${encodeURIComponent(value.id)}` })) },
    }) })
  const resolved = await readTemplateResourceSummaries(input.reader, resourceAssetCatalog(input.resources), childTemplate)

  const previewBody = {
    v: 1 as const,
    kind: PREVIEW_KIND,
    parentTaskId: input.contract.taskId,
    parentRunId: input.runId,
    bindingId,
    templateId: childTemplate.id,
    method: input.contract.method,
    join: binding.join,
    brief: binding.brief,
    exampleRef: childTemplate.example,
    example,
    interface: {
      requiredCriteria: childTemplate.requiredCriteria.map(criterion => ({ ...criterion })),
      requiredOutputs: childTemplate.requiredOutputs.map(output => ({ ...output })),
      acceptance: childTemplate.acceptancePolicy,
      instanceSchema: structuredClone(childTemplate.instanceSchema),
    },
    resolved,
    acceptanceChecks: [...checks.previews],
    sourceContract: input.contract.digest,
  }
  // The full check recipe is already available through self; copying its
  // evidence/case schemas into every preview pushes the result over the
  // 32 KiB prepare budget without giving the model any new selection data.
  const preview = seal('preview', previewBody as unknown as JsonObject) as unknown as DecomposePreviewBody
  const previewId = `decompose-preview:${input.runId}:${bindingId}`
  const previewRef: Ref = { id: previewId, digest: preview.digest }

  const receiptBody = {
    v: 1 as const,
    kind: DELIVERY_KIND,
    sessionId: input.sessionId,
    parentTaskId: input.contract.taskId,
    parentRunId: input.runId,
    bindingId,
    method: input.contract.method,
    templateId: childTemplate.id,
    join: binding.join,
    previewRef,
    sourceContract: input.contract.digest,
    contextEpoch: view.epoch,
    turn: call.turn,
    step: call.step,
    toolCallId: input.callId,
  }
  const receipt = seal('object', receiptBody as unknown as JsonObject) as unknown as DecomposePreviewDeliveryBody
  const receiptId = `decompose-delivery:${input.sessionId}:${input.callId}`
  const deliveryReceiptRef: Ref = { id: receiptId, digest: receipt.digest }

  const response: DecomposePrepareResult = {
    status: 'preview',
    previewRef,
    deliveryReceiptRef,
    bindingId,
    parentTaskId: input.contract.taskId,
    parentRunId: input.runId,
    templateId: childTemplate.id,
    templateRef: { id: childTemplate.id, digest: input.contract.method.digest },
    methodRef: input.contract.method,
    join: binding.join,
    brief: binding.brief,
    example,
    interface: preview.interface,
    resolved,
    acceptanceChecks: [...checks.previews],
    reminder: 'Read the complete example; keep this preview receipt for a later model step. Preview samples/<encoded input id> paths refer to the embedded example texts; bind real authorized InputRefs before commit.',
    planningSketchRef: input.planningSketchRef,
    contextEpoch: view.epoch,
    asOf: input.asOf,
    remainingBudgetPct: input.remainingBudgetPct,
  }
  assertSize(response, PREPARE_RESULT_MAX_BYTES, 'decompose prepare result')

  const storedPreview = await input.writer.putObject(
    previewId,
    textEncoder.encode(canonicalize(preview as unknown as JsonValue)),
    'preview',
  )
  if (storedPreview.digest !== preview.digest) {
    throw new Error('preview CAS digest does not match its preview seal')
  }
  const storedReceipt = await input.writer.putObject(
    receiptId,
    textEncoder.encode(canonicalize(receipt as unknown as JsonValue)),
    'object',
  )
  if (storedReceipt.digest !== receipt.digest) {
    throw new Error('delivery receipt CAS digest does not match its object seal')
  }
  return {
    previewRef: storedPreview,
    deliveryReceiptRef: storedReceipt,
    response,
  }
}

function assertSize(value: unknown, limit: number, label: string): void {
  const bytes = textEncoder.encode(canonicalize(value as JsonValue)).byteLength
  if (bytes > limit) {
    throw new DecomposeError(
      'LIMIT_EXCEEDED',
      `${label} is ${String(bytes)} bytes, above the ${String(limit)} byte budget`,
    )
  }
}
