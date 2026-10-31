import type { Session } from '@deepseek-ai/dsh-session'
import {
  canonicalize,
  digestSchema,
  outputSpecSchema,
  parseJsonText,
  parseProtocolValue,
  refSchema,
  remainingBudgetPctSchema,
  seal,
  taskCriterionSchema,
  taskExampleSchema,
  verifyDigest,
} from '@singularity/protocol'
import type {
  Digest,
  JsonObject,
  JsonValue,
  OutputSpec,
  Ref,
  TaskContract,
  TaskCriterion,
  TaskExample,
} from '@singularity/protocol'

import { DecomposeError, MethodResourceError } from './errors.ts'
import type { ContextEpoch } from './epoch.ts'
import type { RemainingBudgetPct } from './prompt.ts'
import { loadTaskExample, readTemplateResourceSummaries } from './resources.ts'
import type { FrozenMethodResources, TemplateResourceSummary } from './resources.ts'
import { findCurrentToolCall, readSessionToolView } from './receipts.ts'
import type { SessionToolView, ToolCallRecord, ToolResultRecord } from './receipts.ts'
import type { CasObjectReader, CasObjectWriter } from './workspace.ts'

const textEncoder = new TextEncoder()
const PREPARE_RESULT_MAX_BYTES = 32 * 1024
const PREVIEW_KIND = 'decompose-preview'
const DELIVERY_KIND = 'decompose-preview-delivery'

/** Runtime-private preview body; its outermost digest uses the preview domain. */
export interface DecomposePreviewBody {
  readonly v: 1
  readonly kind: typeof PREVIEW_KIND
  readonly parentTaskId: string
  readonly parentRunId: string
  readonly bindingId: string
  readonly templateId: string
  readonly method: Ref
  readonly join: 'required' | 'probe'
  readonly brief: string
  readonly exampleRef: Ref
  readonly example: TaskExample
  readonly interface: {
    readonly requiredCriteria: readonly TaskCriterion[]
    readonly requiredOutputs: readonly OutputSpec[]
    readonly acceptance: Ref
    readonly instanceSchema: JsonObject
  }
  readonly resolved: TemplateResourceSummary
  readonly sourceContract: Digest
  readonly digest: Digest
}

/** Runtime-private delivery receipt; its outermost digest uses the object domain. */
export interface DecomposePreviewDeliveryBody {
  readonly v: 1
  readonly kind: typeof DELIVERY_KIND
  readonly sessionId: string
  readonly parentTaskId: string
  readonly parentRunId: string
  readonly bindingId: string
  readonly method: Ref
  readonly templateId: string
  readonly join: 'required' | 'probe'
  readonly previewRef: Ref
  readonly sourceContract: Digest
  readonly contextEpoch: string
  readonly turn: number
  readonly step: number
  readonly toolCallId: string
  readonly digest: Digest
}

/** Prepare-only response delivered through the DSH tool result. */
export interface DecomposePrepareResult {
  readonly status: 'preview'
  readonly previewRef: Ref
  readonly deliveryReceiptRef: Ref
  readonly bindingId: string
  readonly parentTaskId: string
  readonly parentRunId: string
  readonly templateId: string
  readonly templateRef: Ref
  readonly methodRef: Ref
  readonly join: 'required' | 'probe'
  readonly brief: string
  readonly example: TaskExample
  readonly interface: DecomposePreviewBody['interface']
  readonly resolved: TemplateResourceSummary
  readonly reminder: string
  readonly planningSketchRef: Ref
  readonly contextEpoch: string
  readonly asOf: number
  readonly remainingBudgetPct: RemainingBudgetPct
}

/** Frozen Method resources and read-only CAS access used by the prepare tool. */
export interface DecomposeToolContext {
  readonly methodResources: FrozenMethodResources
  readonly reader: CasObjectReader
}

export interface PrepareDecomposeInput {
  readonly contract: TaskContract
  readonly runId: string
  readonly sessionId: string
  readonly resources: FrozenMethodResources
  readonly reader: CasObjectReader
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

export type PrepareDeliveryState = 'current' | 'next-step-required' | 'stale'

/** One persisted prepare delivery reconstructed from a successful tool/result. */
export interface PrepareDeliveryView {
  readonly bindingId: string
  readonly previewRef: Ref
  readonly deliveryReceiptRef: Ref
  readonly state: PrepareDeliveryState
  readonly reason?: string
  readonly callSeq: number
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
  const childTemplates = input.resources.method.templates.filter(template => template.id === binding.templateId)
  if (childTemplates.length !== 1) {
    throw new DecomposeError(
      'BINDING_FIXED',
      `child template ${JSON.stringify(binding.templateId)} must exist exactly once in the pinned Method revision`,
    )
  }
  const childTemplate = childTemplates[0]

  let view: SessionToolView
  let call: ToolCallRecord
  try {
    view = readSessionToolView(input.session)
    call = findCurrentToolCall(view, input.callId)
  } catch (error) {
    throw new DecomposeError('INVALID_ARGUMENT', errorMessage(error), { cause: error })
  }
  if (call.name !== 'singularity_decompose') {
    throw new DecomposeError('INVALID_ARGUMENT', 'prepare must run from singularity_decompose')
  }
  if (input.epoch !== view.epoch) {
    throw new DecomposeError('PREVIEW_STALE', 'prepare context epoch is no longer current')
  }
  if (!Number.isSafeInteger(call.turn) || !Number.isSafeInteger(call.step)) {
    throw new DecomposeError('INVALID_ARGUMENT', 'prepare tool call has no stable turn/step')
  }

  let example: TaskExample
  let resolved: TemplateResourceSummary
  try {
    example = await loadTaskExample(input.reader, childTemplate.example)
    resolved = await readTemplateResourceSummaries(input.reader, input.resources.method, childTemplate)
  } catch (error) {
    if (error instanceof DecomposeError) throw error
    if (error instanceof MethodResourceError) {
      throw new DecomposeError('INVALID_ARGUMENT', error.message, { cause: error })
    }
    throw error
  }

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
    sourceContract: input.contract.digest,
  }
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
    reminder: 'Read the complete example; keep this preview receipt for a later model step.',
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
    throw new DecomposeError('INVALID_ARGUMENT', 'preview CAS digest does not match its preview seal')
  }
  const storedReceipt = await input.writer.putObject(
    receiptId,
    textEncoder.encode(canonicalize(receipt as unknown as JsonValue)),
    'object',
  )
  if (storedReceipt.digest !== receipt.digest) {
    throw new DecomposeError('INVALID_ARGUMENT', 'delivery receipt CAS digest does not match its object seal')
  }
  return {
    previewRef: storedPreview,
    deliveryReceiptRef: storedReceipt,
    response,
  }
}

/**
 * Reconstructs every prepare delivery that can still be read from the session
 * and CAS. `currentCallId` is the tool call that will consume the receipt
 * (status now, commit in B2); it supplies the next-step comparison.
 */
export async function readPrepareDeliveries(
  input: ReadPrepareDeliveriesInput,
): Promise<readonly PrepareDeliveryView[]> {
  let view: SessionToolView
  let current: ToolCallRecord
  try {
    view = readSessionToolView(input.session)
    current = findCurrentToolCall(view, input.currentCallId)
  } catch (error) {
    throw new DecomposeError('INVALID_ARGUMENT', errorMessage(error), { cause: error })
  }

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
    if (result.seq <= call.seq) {
      deliveries.push(staleDelivery(call, result, bindingId, 'tool result does not follow its prepare call', refs))
      continue
    }
    if (result.turn !== call.turn || result.step !== call.step) {
      deliveries.push(staleDelivery(call, result, bindingId, 'tool result turn/step does not match its call', refs))
      continue
    }
    if (result.surfaceOp !== 'append' || !result.surfaceVisible) {
      deliveries.push(staleDelivery(call, result, bindingId, 'tool result is not a visible append-surface event', refs))
      continue
    }
    if (!result.sourceEventSeqs.includes(call.seq)) {
      deliveries.push(staleDelivery(call, result, bindingId, 'tool result does not cite its prepare call', refs))
      continue
    }
    const output = parsePrepareResult(envelope.value)
    if (output === undefined) {
      deliveries.push(staleDelivery(call, result, bindingId, 'prepare result example/interface/resolved or fields are missing, truncated, or malformed', refs))
      continue
    }
    if (output.previewRef.id !== `decompose-preview:${input.runId}:${bindingId}`
      || output.deliveryReceiptRef.id !== `decompose-delivery:${view.sessionId}:${call.callId}`) {
      deliveries.push(staleDelivery(call, result, bindingId, 'prepare result refs do not use the deterministic ids', refsOf(output)))
      continue
    }
    const bindingMatches = input.resources.template.children.filter(binding => binding.bindingId === bindingId)
    if (bindingMatches.length !== 1) {
      deliveries.push(staleDelivery(call, result, bindingId, 'binding is no longer present on the current template', refsOf(output)))
      continue
    }
    const binding = bindingMatches[0]
    const childTemplates = input.resources.method.templates.filter(template => template.id === binding.templateId)
    if (childTemplates.length !== 1) {
      deliveries.push(staleDelivery(call, result, bindingId, 'child template is no longer present in the pinned Method', refsOf(output)))
      continue
    }
    const childTemplate = childTemplates[0]
    let frozenExample: TaskExample
    let frozenResolved: TemplateResourceSummary
    try {
      frozenExample = await loadTaskExample(input.reader, childTemplate.example)
      frozenResolved = await readTemplateResourceSummaries(input.reader, input.resources.method, childTemplate)
    } catch (error) {
      deliveries.push(staleDelivery(call, result, bindingId, `frozen child example or resources are unreadable: ${errorMessage(error)}`, refsOf(output)))
      continue
    }
    const preview = await readPreview(input.reader, output.previewRef)
    const receipt = await readReceipt(input.reader, output.deliveryReceiptRef)
    if (preview === undefined || receipt === undefined) {
      deliveries.push(staleDelivery(call, result, bindingId, 'preview or delivery receipt CAS is unreadable', refsOf(output)))
      continue
    }
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
      deliveries.push(staleDelivery(call, result, bindingId, identityReason, refsOf(output)))
      continue
    }
    if (canonicalize(preview.example as unknown as JsonValue) !== canonicalize(frozenExample as unknown as JsonValue)
      || canonicalize(preview.interface as unknown as JsonValue) !== canonicalize({
        requiredCriteria: childTemplate.requiredCriteria,
        requiredOutputs: childTemplate.requiredOutputs,
        acceptance: childTemplate.acceptancePolicy,
        instanceSchema: childTemplate.instanceSchema,
      } as unknown as JsonValue)
      || canonicalize(preview.resolved as unknown as JsonValue) !== canonicalize(frozenResolved as unknown as JsonValue)) {
      deliveries.push(staleDelivery(call, result, bindingId, 'preview does not match the frozen example/interface/resolved summary', refsOf(output), preview, receipt))
      continue
    }
    if (canonicalize(output.example as unknown as JsonValue) !== canonicalize(preview.example as unknown as JsonValue)
      || canonicalize(output.interface as unknown as JsonValue) !== canonicalize(preview.interface as unknown as JsonValue)
      || canonicalize(output.resolved as unknown as JsonValue) !== canonicalize(preview.resolved as unknown as JsonValue)) {
      deliveries.push(staleDelivery(call, result, bindingId, 'tool result example/interface/resolved does not equal the preview', refsOf(output), preview, receipt))
      continue
    }
    if (output.contextEpoch !== view.epoch || receipt.contextEpoch !== view.epoch) {
      deliveries.push(staleDelivery(call, result, bindingId, 'prepare context epoch is stale', refsOf(output), preview, receipt))
      continue
    }
    const stepState = classifyToolStep(call, current)
    deliveries.push({
      bindingId,
      previewRef: output.previewRef,
      deliveryReceiptRef: output.deliveryReceiptRef,
      state: stepState,
      ...(stepState === 'current' ? {} : { reason: stepState === 'next-step-required' ? 'prepare must be acknowledged on a later model step' : 'prepare call is newer than the current call' }),
      callSeq: call.seq,
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
    || !sameDigest(preview.sourceContract, contract.digest)
    || canonicalize(preview.interface as unknown as JsonValue)
      !== canonicalize({
        requiredCriteria: childTemplate.requiredCriteria,
        requiredOutputs: childTemplate.requiredOutputs,
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
    || !sameDigest(receipt.sourceContract, contract.digest)
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
  call: ToolCallRecord,
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
    callSeq: call.seq,
    resultSeq: result.seq,
    ...(preview === undefined ? {} : { preview }),
    ...(receipt === undefined ? {} : { receipt }),
  }
}

function refsOf(output: Pick<DecomposePrepareResult, 'previewRef' | 'deliveryReceiptRef'>): DeliveryRefs {
  return { previewRef: output.previewRef, deliveryReceiptRef: output.deliveryReceiptRef }
}

async function readPreview(
  reader: CasObjectReader,
  ref: Ref,
): Promise<DecomposePreviewBody | undefined> {
  try {
    const value = await readJsonObject(reader, ref, 'preview')
    if (!verifyDigest('preview', value)) return undefined
    return isPreviewBody(value) ? value as unknown as DecomposePreviewBody : undefined
  } catch {
    return undefined
  }
}

async function readReceipt(
  reader: CasObjectReader,
  ref: Ref,
): Promise<DecomposePreviewDeliveryBody | undefined> {
  try {
    const value = await readJsonObject(reader, ref, 'object')
    if (!verifyDigest('object', value)) return undefined
    return isDeliveryBody(value) ? value as unknown as DecomposePreviewDeliveryBody : undefined
  } catch {
    return undefined
  }
}

async function readJsonObject(
  reader: CasObjectReader,
  ref: Ref,
  domain: 'object' | 'preview',
): Promise<JsonValue> {
  const { bytes } = await reader.readObject(ref, domain)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return parseJsonText(text)
}

interface PrepareEnvelope {
  readonly value: Record<string, JsonValue>
  readonly status: 'preview'
  readonly bindingId: string
  readonly previewRef: Ref
  readonly deliveryReceiptRef: Ref
}

function parsePrepareEnvelope(text: string): PrepareEnvelope | undefined {
  let value: JsonValue
  try {
    value = parseJsonText(text)
  } catch {
    return undefined
  }
  if (!isRecord(value) || value['status'] !== 'preview' || typeof value['bindingId'] !== 'string') {
    return undefined
  }
  const previewRef = parseRef(value['previewRef'])
  const deliveryReceiptRef = parseRef(value['deliveryReceiptRef'])
  if (previewRef === undefined || deliveryReceiptRef === undefined) return undefined
  return {
    value,
    status: 'preview',
    bindingId: value['bindingId'],
    previewRef,
    deliveryReceiptRef,
  }
}

function parsePrepareResult(value: Record<string, JsonValue>): DecomposePrepareResult | undefined {
  if (!hasExactKeys(value, [
    'status', 'previewRef', 'deliveryReceiptRef', 'bindingId', 'parentTaskId',
    'parentRunId', 'templateId', 'templateRef', 'methodRef', 'join', 'brief',
    'example', 'interface', 'resolved', 'reminder', 'planningSketchRef',
    'contextEpoch', 'asOf', 'remainingBudgetPct',
  ])) return undefined
  if (value['status'] !== 'preview'
    || typeof value['bindingId'] !== 'string'
    || typeof value['parentTaskId'] !== 'string'
    || typeof value['parentRunId'] !== 'string'
    || typeof value['templateId'] !== 'string'
    || typeof value['brief'] !== 'string'
    || typeof value['reminder'] !== 'string'
    || typeof value['contextEpoch'] !== 'string'
    || (value['join'] !== 'required' && value['join'] !== 'probe')
    || !Number.isSafeInteger(value['asOf'])
    || !parseProtocolSafe(taskExampleSchema, value['example'])
    || !isInterface(value['interface'])
    || !isResolved(value['resolved'])
    || !parseProtocolSafe(remainingBudgetPctSchema, value['remainingBudgetPct'])
    || parseRef(value['previewRef']) === undefined
    || parseRef(value['deliveryReceiptRef']) === undefined
    || parseRef(value['templateRef']) === undefined
    || parseRef(value['methodRef']) === undefined
    || parseRef(value['planningSketchRef']) === undefined) return undefined
  return value as unknown as DecomposePrepareResult
}

function isInterface(value: JsonValue | undefined): boolean {
  if (!isRecord(value)
    || !hasExactKeys(value, ['requiredCriteria', 'requiredOutputs', 'acceptance', 'instanceSchema'])
    || !Array.isArray(value['requiredCriteria'])
    || !Array.isArray(value['requiredOutputs'])
    || !parseProtocolSafe(refSchema, value['acceptance'])
    || !isRecord(value['instanceSchema'])) return false
  for (const criterion of value['requiredCriteria']) {
    if (!parseProtocolSafe(taskCriterionSchema, criterion)) return false
  }
  for (const output of value['requiredOutputs']) {
    if (!parseProtocolSafe(outputSpecSchema, output)) return false
  }
  return true
}

function isResolved(value: JsonValue | undefined): boolean {
  if (!isRecord(value)
    || !hasExactKeys(value, ['skills', 'mcpServers'])
    || !Array.isArray(value['skills'])
    || !Array.isArray(value['mcpServers'])) return false
  for (const skill of value['skills']) {
    if (!isRecord(skill) || !hasExactKeys(skill, ['id', 'name'])
      || typeof skill['id'] !== 'string' || typeof skill['name'] !== 'string') return false
  }
  for (const server of value['mcpServers']) {
    if (!isRecord(server) || !hasExactKeys(server, ['id', 'serverName', 'transport', 'tools'])
      || typeof server['id'] !== 'string' || typeof server['serverName'] !== 'string'
      || (server['transport'] !== 'stdio' && server['transport'] !== 'streamable-http')
      || !Array.isArray(server['tools'])
      || server['tools'].some(tool => typeof tool !== 'string')) return false
  }
  return true
}

function isPreviewBody(value: JsonValue): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    'v', 'kind', 'parentTaskId', 'parentRunId', 'bindingId', 'templateId', 'method',
    'join', 'brief', 'exampleRef', 'example', 'interface', 'resolved', 'sourceContract', 'digest',
  ])) return false
  if (value['v'] !== 1 || value['kind'] !== PREVIEW_KIND
    || typeof value['parentTaskId'] !== 'string'
    || typeof value['parentRunId'] !== 'string'
    || typeof value['bindingId'] !== 'string'
    || typeof value['templateId'] !== 'string'
    || (value['join'] !== 'required' && value['join'] !== 'probe')
    || typeof value['brief'] !== 'string'
    || parseRef(value['method']) === undefined
    || parseRef(value['exampleRef']) === undefined
    || !parseProtocolSafe(taskExampleSchema, value['example'])
    || !isDigest(value['sourceContract'])
    || !isDigest(value['digest'])) return false
  return isInterface(value['interface']) && isResolved(value['resolved'])
}

function isDeliveryBody(value: JsonValue): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    'v', 'kind', 'sessionId', 'parentTaskId', 'parentRunId', 'bindingId', 'method',
    'templateId', 'join', 'previewRef', 'sourceContract', 'contextEpoch', 'turn', 'step',
    'toolCallId', 'digest',
  ])) return false
  return value['v'] === 1
    && value['kind'] === DELIVERY_KIND
    && typeof value['sessionId'] === 'string'
    && typeof value['parentTaskId'] === 'string'
    && typeof value['parentRunId'] === 'string'
    && typeof value['bindingId'] === 'string'
    && typeof value['templateId'] === 'string'
    && (value['join'] === 'required' || value['join'] === 'probe')
    && parseRef(value['method']) !== undefined
    && parseRef(value['previewRef']) !== undefined
    && isDigest(value['sourceContract'])
    && typeof value['contextEpoch'] === 'string'
    && Number.isSafeInteger(value['turn'])
    && Number.isSafeInteger(value['step'])
    && typeof value['toolCallId'] === 'string'
    && isDigest(value['digest'])
}

function parseToolArguments(text: string): JsonValue | undefined {
  try {
    return parseJsonText(text)
  } catch {
    return undefined
  }
}

function parseRef(value: unknown): Ref | undefined {
  try {
    return parseProtocolValue(refSchema, value)
  } catch {
    return undefined
  }
}

function parseProtocolSafe(schema: Parameters<typeof parseProtocolValue>[0], value: unknown): boolean {
  try {
    parseProtocolValue(schema, value)
    return true
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, JsonValue>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function isDigest(value: unknown): value is Digest {
  return typeof value === 'string' && digestSchema.safeParse(value).success
}

function sameRef(left: Ref, right: Ref): boolean {
  return left.id === right.id && left.digest === right.digest
}

function sameDigest(left: Digest, right: Digest): boolean {
  return left === right
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
