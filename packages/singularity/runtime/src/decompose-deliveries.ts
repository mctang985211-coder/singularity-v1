import type { Session } from '@deepseek-ai/dsh-session'
import { canonicalize,sameRef } from '@singularity/protocol'
import type { JsonValue, Ref, TaskContract } from '@singularity/protocol'

import {
  isRecord,
  parsePrepareEnvelope,
  parsePrepareResult,
  parseToolArguments,
  readPreview,
  readReceipt,
} from './decompose-preview.ts'
import type { DecomposePrepareResult, DecomposePreviewBody, DecomposePreviewDeliveryBody } from './decompose-preview.ts'
import { findCurrentToolCall, readSessionToolView } from './receipts.ts'
import type { ToolCallRecord, ToolResultRecord } from './receipts.ts'
import { loadTaskExample, readTemplateResourceSummaries, resolveResourceTemplate, resourceAssetCatalog } from './resources.ts'
import type { FrozenMethodResources } from './resources.ts'
import type { CasObjectReader } from './workspace.ts'

export type PrepareDeliveryState = 'current' | 'next-step-required' | 'stale'

/** One persisted prepare delivery reconstructed from a successful tool/result. */
export interface PrepareDeliveryView {
  readonly bindingId: string
  readonly previewRef: Ref
  readonly deliveryReceiptRef: Ref
  readonly state: PrepareDeliveryState
  readonly reason?: string
  readonly resultSeq: number
  readonly preview?: DecomposePreviewBody
  readonly receipt?: DecomposePreviewDeliveryBody
}

export interface ReadPrepareDeliveriesInput {
  readonly contract: TaskContract
  readonly runId: string
  readonly resources: FrozenMethodResources
  readonly reader: CasObjectReader
  readonly session: Session
  readonly currentCallId: string
}

/**
 * Reconstructs every prepare delivery that can still be read from the session
 * and CAS. `currentCallId` is the tool call that will consume the receipt
 * (status or commit); it supplies the next-step comparison.
 */
export async function readPrepareDeliveries(
  input: ReadPrepareDeliveriesInput,
): Promise<readonly PrepareDeliveryView[]> {
  const view = readSessionToolView(input.session)
  const current = findCurrentToolCall(view, input.currentCallId)

  const resultsByCall = new Map<string, ToolResultRecord[]>()
  for (const result of view.results) {
    const existing = resultsByCall.get(result.callId)
    if (existing === undefined) resultsByCall.set(result.callId, [result])
    else existing.push(result)
  }

  const deliveries: PrepareDeliveryView[] = []
  for (const call of view.calls) {
    if (call.name !== 'singularity_decompose') continue
    const argumentsValue = parseToolArguments(call.argumentsText)
    if (!isRecord(argumentsValue)
      || argumentsValue['action'] !== 'prepare'
      || typeof argumentsValue['bindingId'] !== 'string') {
      continue
    }
    const bindingId = argumentsValue['bindingId']
    const results = resultsByCall.get(call.callId)
    if (results === undefined || results.length !== 1) continue
    const result = results[0]
    if (result.isError || result.text === undefined) continue
    const envelope = parsePrepareEnvelope(result.text)
    if (envelope === undefined || envelope.bindingId !== bindingId) continue
    const refs = refsOf(envelope)
    if (result.surfaceOp !== 'append' || !result.surfaceVisible) {
      deliveries.push(staleDelivery(result, bindingId, 'tool result is not a visible append-surface event', refs))
      continue
    }
    const output = parsePrepareResult(envelope.value)
    if (output === undefined) {
      deliveries.push(staleDelivery(result, bindingId, 'prepare result example/interface/resolved or fields are missing, truncated, or malformed', refs))
      continue
    }
    const bindingMatches = input.resources.template.children.filter(binding => binding.bindingId === bindingId)
    if (bindingMatches.length !== 1) {
      deliveries.push(staleDelivery(result, bindingId, 'binding is no longer present on the current template', refsOf(output)))
      continue
    }
    const binding = bindingMatches[0]
    const childTemplate = resolveResourceTemplate(input.resources, binding.templateId)
    if (childTemplate === undefined) {
      deliveries.push(staleDelivery(result, bindingId, 'child template is no longer present in the pinned Method', refsOf(output)))
      continue
    }
    const frozenExample = await loadTaskExample(input.reader, childTemplate.example)
    const frozenResolved = await readTemplateResourceSummaries(input.reader, resourceAssetCatalog(input.resources), childTemplate)
    const preview = await readPreview(input.reader, output.previewRef)
    const receipt = await readReceipt(input.reader, output.deliveryReceiptRef)
    const identityReason = previewIdentityReason({
      preview,
      receipt,
      contract: input.contract,
      runId: input.runId,
      sessionId: view.sessionId,
      binding,
      childTemplate,
      call,
      output,
    })
    if (identityReason !== undefined) {
      deliveries.push(staleDelivery(result, bindingId, identityReason, refsOf(output)))
      continue
    }
    if (canonicalize(preview.example as unknown as JsonValue) !== canonicalize(frozenExample as unknown as JsonValue)
      || canonicalize(preview.resolved as unknown as JsonValue) !== canonicalize(frozenResolved as unknown as JsonValue)) {
      deliveries.push(staleDelivery(result, bindingId, 'preview does not match the frozen example/interface/resolved summary', refsOf(output), preview, receipt))
      continue
    }
    if (canonicalize(output.example as unknown as JsonValue) !== canonicalize(preview.example as unknown as JsonValue)
      || canonicalize(output.interface as unknown as JsonValue) !== canonicalize(preview.interface as unknown as JsonValue)
      || canonicalize(output.resolved as unknown as JsonValue) !== canonicalize(preview.resolved as unknown as JsonValue)) {
      deliveries.push(staleDelivery(result, bindingId, 'tool result example/interface/resolved does not equal the preview', refsOf(output), preview, receipt))
      continue
    }
    if (output.contextEpoch !== view.epoch || receipt.contextEpoch !== view.epoch) {
      deliveries.push(staleDelivery(result, bindingId, 'prepare context epoch is stale', refsOf(output), preview, receipt))
      continue
    }
    const stepState = classifyToolStep(call, current)
    deliveries.push({
      bindingId,
      previewRef: output.previewRef,
      deliveryReceiptRef: output.deliveryReceiptRef,
      state: stepState,
      ...(stepState === 'current' ? {} : { reason: stepState === 'next-step-required' ? 'prepare must be acknowledged on a later model step' : 'prepare call is newer than the current call' }),
      resultSeq: result.seq,
      preview,
      receipt,
    })
  }
  return deliveries
}

/** True only when `prepare` is strictly earlier than `current`. */
function isStrictlyEarlierToolStep(
  prepare: Pick<ToolCallRecord, 'turn' | 'step'>,
  current: Pick<ToolCallRecord, 'turn' | 'step'>,
): boolean {
  return prepare.turn < current.turn
    || (prepare.turn === current.turn && prepare.step < current.step)
}

function classifyToolStep(prepare: ToolCallRecord, current: ToolCallRecord): PrepareDeliveryState {
  if (isStrictlyEarlierToolStep(prepare, current)) return 'current'
  if (prepare.turn === current.turn && prepare.step === current.step) return 'next-step-required'
  return 'stale'
}

interface IdentityInput {
  readonly preview: DecomposePreviewBody
  readonly receipt: DecomposePreviewDeliveryBody
  readonly contract: TaskContract
  readonly runId: string
  readonly sessionId: string
  readonly binding: FrozenMethodResources['template']['children'][number]
  readonly childTemplate: FrozenMethodResources['method']['templates'][number]
  readonly call: ToolCallRecord
  readonly output: DecomposePrepareResult
}

function previewIdentityReason(input: IdentityInput): string | undefined {
  const { preview, receipt, contract, runId, sessionId, binding, childTemplate, call, output } = input
  if (preview.parentTaskId !== contract.taskId
    || preview.parentRunId !== runId
    || preview.bindingId !== binding.bindingId
    || preview.templateId !== childTemplate.id
    || !sameRef(preview.method, contract.method)
    || preview.join !== binding.join
    || preview.brief !== binding.brief
    || !sameRef(preview.exampleRef, childTemplate.example)
    || preview.sourceContract !== contract.digest
    || canonicalize(preview.interface as unknown as JsonValue)
      !== canonicalize({
        acceptance: childTemplate.acceptancePolicy,
        instanceSchema: childTemplate.instanceSchema,
      } as unknown as JsonValue)) {
    return 'preview does not match the frozen parent/binding/template/interface'
  }
  if (receipt.sessionId !== sessionId
    || receipt.parentTaskId !== contract.taskId
    || receipt.parentRunId !== runId
    || receipt.bindingId !== binding.bindingId
    || !sameRef(receipt.method, contract.method)
    || receipt.templateId !== childTemplate.id
    || receipt.join !== binding.join
    || !sameRef(receipt.previewRef, output.previewRef)
    || receipt.sourceContract !== contract.digest
    || receipt.turn !== call.turn
    || receipt.step !== call.step
    || receipt.toolCallId !== call.callId) {
    return 'delivery receipt does not match the frozen call/run/binding'
  }
  if (output.parentTaskId !== contract.taskId
    || output.parentRunId !== runId
    || output.templateId !== childTemplate.id
    || !sameRef(output.templateRef, { id: childTemplate.id, digest: contract.method.digest })
    || !sameRef(output.methodRef, contract.method)
    || output.join !== binding.join
    || output.brief !== binding.brief) {
    return 'prepare result does not match the frozen parent/binding/template'
  }
  return undefined
}

interface DeliveryRefs {
  readonly previewRef: Ref
  readonly deliveryReceiptRef: Ref
}

function staleDelivery(
  result: ToolResultRecord,
  bindingId: string,
  reason: string,
  refs: DeliveryRefs,
  preview?: DecomposePreviewBody,
  receipt?: DecomposePreviewDeliveryBody,
): PrepareDeliveryView {
  return {
    bindingId,
    previewRef: refs.previewRef,
    deliveryReceiptRef: refs.deliveryReceiptRef,
    state: 'stale',
    reason,
    resultSeq: result.seq,
    ...(preview === undefined ? {} : { preview }),
    ...(receipt === undefined ? {} : { receipt }),
  }
}

function refsOf(output: Pick<DecomposePrepareResult, 'previewRef' | 'deliveryReceiptRef'>): DeliveryRefs {
  return { previewRef: output.previewRef, deliveryReceiptRef: output.deliveryReceiptRef }
}
