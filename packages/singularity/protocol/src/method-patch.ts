import { z } from 'zod'

import { canonicalize, jsonObjectSchema } from './json.ts'
import { skillAssetSchema, taskTemplateSchema, toolAssetSchema } from './method.ts'
import { refSchema } from './refs.ts'
import { closedObject, parseProtocolValue } from './schema.ts'
import { taskExampleSchema } from './task.ts'

/** Model-authored asset content; interface policy and refs are host-derived. */
export const templateDraftSchema = taskTemplateSchema.omit({
  guidance: true, example: true, instanceSchema: true, acceptancePolicy: true,
}).extend({
  guidance: z.string(),
  example: taskExampleSchema,
})
export type TemplateDraft = z.infer<typeof templateDraftSchema>

export const skillDraftSchema = skillAssetSchema.omit({ bundle: true }).extend({
  files: z.record(z.string(), z.string()),
})
export type SkillDraft = z.infer<typeof skillDraftSchema>

export const mcpServerDraftSchema = toolAssetSchema.omit({ server: true }).extend({
  server: toolAssetSchema.shape.server.omit({
    bundle: true, manifest: true, sourceFiles: true, config: true,
  }).extend({
    files: z.record(z.string(), z.string()),
    manifest: jsonObjectSchema,
    config: jsonObjectSchema,
  }),
})
export type McpServerDraft = z.infer<typeof mcpServerDraftSchema>

/** Model-authored operations from framework §17.2; the Round base is host-owned. */
export const methodPatchDraftSchema = closedObject({
  v: z.literal(1),
  hypothesis: z.string(),
  changes: z.array(z.discriminatedUnion('op', [
    closedObject({ op: z.literal('put-template'), template: templateDraftSchema }),
    closedObject({ op: z.literal('remove-template'), id: z.string() }),
    closedObject({ op: z.literal('put-skill'), skill: skillDraftSchema }),
    closedObject({ op: z.literal('remove-skill'), id: z.string() }),
    closedObject({ op: z.literal('put-mcp-server'), server: mcpServerDraftSchema }),
    closedObject({ op: z.literal('remove-mcp-server'), id: z.string() }),
    closedObject({ op: z.literal('set-entry'), templateId: z.string().nullable() }),
  ])).max(64),
  predictedRisks: z.array(z.string()),
  transferPlan: z.string(),
})
export type MethodPatchDraft = z.infer<typeof methodPatchDraftSchema>

/** Frozen proposal after host admission stamps the opened Round's base. */
export const methodPatchSchema = methodPatchDraftSchema.extend({ base: refSchema }).strict()
export type MethodPatch = z.infer<typeof methodPatchSchema>

/** Parse a frozen patch, or stamp a model draft with the trusted Round base. */
export function parseMethodPatch(value: unknown, base?: z.infer<typeof refSchema>): MethodPatch {
  const patch = base === undefined
    ? parseProtocolValue(methodPatchSchema, value)
    : { ...parseProtocolValue(methodPatchDraftSchema, value), base }
  if (new TextEncoder().encode(canonicalize(patch)).byteLength > 256 * 1024) {
    throw new Error('MethodPatch exceeds the 256 KiB limit')
  }
  return patch
}
