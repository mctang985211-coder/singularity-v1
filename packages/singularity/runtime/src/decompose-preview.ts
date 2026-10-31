import { z } from 'zod'
import {
  closedObject,
  digestSchema,
  jsonObjectSchema,
  outputSpecSchema,
  parseJsonText,
  parseProtocolValue,
  refSchema,
  remainingBudgetPctSchema,
  taskCriterionSchema,
  taskExampleSchema,
} from '@singularity/protocol'
import type { JsonValue, Ref } from '@singularity/protocol'

import type { CasObjectReader } from './workspace.ts'

const templateInterfaceSchema = closedObject({
  requiredCriteria: z.array(taskCriterionSchema).readonly(),
  requiredOutputs: z.array(outputSpecSchema).readonly(),
  acceptance: refSchema,
  instanceSchema: jsonObjectSchema,
})
const resourceSummarySchema = closedObject({
  skills: z.array(closedObject({ id: z.string(), name: z.string() })).readonly(),
  mcpServers: z.array(closedObject({
    id: z.string(), serverName: z.string(), transport: z.enum(['stdio', 'streamable-http']),
    tools: z.array(z.string()).readonly(),
  })).readonly(),
})
const parentFields = {
  parentTaskId: z.string(), parentRunId: z.string(), bindingId: z.string(),
  templateId: z.string(), join: z.enum(['required', 'probe']),
}
const previewSchema = closedObject({
  v: z.literal(1), kind: z.literal('decompose-preview'), ...parentFields,
  method: refSchema, brief: z.string(), exampleRef: refSchema, example: taskExampleSchema,
  interface: templateInterfaceSchema, resolved: resourceSummarySchema,
  sourceContract: digestSchema, digest: digestSchema,
})
const deliverySchema = closedObject({
  v: z.literal(1), kind: z.literal('decompose-preview-delivery'), ...parentFields,
  sessionId: z.string(), method: refSchema, previewRef: refSchema,
  sourceContract: digestSchema, contextEpoch: z.string(),
  turn: z.number().int(), step: z.number().int(),
  toolCallId: z.string(), digest: digestSchema,
})
const prepareSchema = closedObject({
  status: z.literal('preview'), ...parentFields,
  previewRef: refSchema, deliveryReceiptRef: refSchema, templateRef: refSchema, methodRef: refSchema,
  brief: z.string(), example: taskExampleSchema, interface: templateInterfaceSchema,
  resolved: resourceSummarySchema, reminder: z.string(), planningSketchRef: refSchema,
  contextEpoch: z.string(), asOf: z.number().int(), remainingBudgetPct: remainingBudgetPctSchema,
})

/** Runtime-private formats have one schema/type source. CAS verifies their digests. */
export type DecomposePreviewBody = z.infer<typeof previewSchema>
export type DecomposePreviewDeliveryBody = z.infer<typeof deliverySchema>
export type DecomposePrepareResult = z.infer<typeof prepareSchema>

export async function readPreview(reader: CasObjectReader, ref: Ref): Promise<DecomposePreviewBody> {
  return parseProtocolValue(previewSchema, await readJsonObject(reader, ref, 'preview'))
}

export async function readReceipt(reader: CasObjectReader, ref: Ref): Promise<DecomposePreviewDeliveryBody> {
  return parseProtocolValue(deliverySchema, await readJsonObject(reader, ref, 'object'))
}

async function readJsonObject(reader: CasObjectReader, ref: Ref, domain: 'object' | 'preview'): Promise<JsonValue> {
  const { bytes } = await reader.readObject(ref, domain)
  return parseJsonText(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

/** A partial envelope still identifies a truncated result as stale. */
export function parsePrepareEnvelope(text: string) {
  const value = parseToolArguments(text)
  if (!isRecord(value) || value['status'] !== 'preview' || typeof value['bindingId'] !== 'string') return undefined
  const preview = refSchema.safeParse(value['previewRef'])
  const delivery = refSchema.safeParse(value['deliveryReceiptRef'])
  if (!preview.success || !delivery.success) return undefined
  return { value, bindingId: value['bindingId'], previewRef: preview.data, deliveryReceiptRef: delivery.data }
}

export function parsePrepareResult(value: Record<string, JsonValue>): DecomposePrepareResult | undefined {
  const result = prepareSchema.safeParse(value)
  return result.success ? result.data : undefined
}

export function parseToolArguments(text: string): JsonValue | undefined {
  try { return parseJsonText(text) } catch { return undefined }
}

export function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
