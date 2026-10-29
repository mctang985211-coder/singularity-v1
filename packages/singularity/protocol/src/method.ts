import { z } from 'zod'

import { digestSchema, seal, verifyDigest } from './digest.ts'
import { jsonObjectSchema } from './json.ts'
import { refSchema } from './refs.ts'
import { closedObject, parseProtocolValue } from './schema.ts'
import { outputSpecSchema, taskCriterionSchema } from './task.ts'

/** Static child binding from docs/framework.md §5. */
export const childBindingSchema = closedObject({
  bindingId: z.string(),
  templateId: z.string(),
  brief: z.string(),
  join: z.enum(['required', 'probe']),
})

export type ChildBinding = z.infer<typeof childBindingSchema>

/** Reusable Task template from docs/framework.md §5. */
export const taskTemplateSchema = closedObject({
  id: z.string(),
  brief: z.string(),
  guidance: refSchema,
  example: refSchema,
  instanceSchema: jsonObjectSchema,
  requiredCriteria: z.array(taskCriterionSchema),
  requiredOutputs: z.array(outputSpecSchema),
  acceptancePolicy: refSchema,
  skills: z.array(z.string()),
  tools: z.array(z.string()),
  children: z.array(childBindingSchema),
})

export type TaskTemplate = z.infer<typeof taskTemplateSchema>

/** SKILL.md plus referenced resources frozen as one bundle, from docs/framework.md §5. */
export const skillAssetSchema = closedObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  bundle: refSchema,
})

export type SkillAsset = z.infer<typeof skillAssetSchema>

/** Complete native MCP server asset, from docs/framework.md §5. */
export const toolAssetSchema = closedObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.literal('mcp-server'),
  server: closedObject({
    bundle: refSchema,
    manifest: refSchema,
    sourceFiles: refSchema,
    config: refSchema,
    transport: z.enum(['stdio', 'streamable-http']),
    capabilities: z.array(z.string()),
    exposedTools: z.array(
      closedObject({
        name: z.string(),
        description: z.string(),
        parameters: jsonObjectSchema,
        output: jsonObjectSchema.optional(),
      }),
    ),
  }),
})

export type ToolAsset = z.infer<typeof toolAssetSchema>

/** Immutable reusable Method revision, from docs/framework.md §5. */
export const methodRevisionSchema = closedObject({
  v: z.literal(1),
  id: z.string(),
  parent: refSchema.optional(),
  entryTemplateId: z.string().optional(),
  templates: z.array(taskTemplateSchema),
  skills: z.array(skillAssetSchema),
  tools: z.array(toolAssetSchema),
  digest: digestSchema,
})

export type MethodRevision = z.infer<typeof methodRevisionSchema>

/** Method revision content before sealing; derived from the frozen revision schema. */
export const methodRevisionPayloadSchema = methodRevisionSchema.omit({ digest: true })

export type MethodRevisionPayload = z.infer<typeof methodRevisionPayloadSchema>

/** Validates and seals a Method revision in the `method` digest domain. */
export function sealMethodRevision(payload: MethodRevisionPayload): MethodRevision {
  const parsed = parseProtocolValue(methodRevisionPayloadSchema, payload)
  return seal('method', parsed)
}

/** Rejects malformed or tampered Method revisions, including wrong-domain digests. */
export function verifyMethodRevision(value: unknown): value is MethodRevision {
  try {
    const parsed = parseProtocolValue(methodRevisionSchema, value)
    return verifyDigest('method', parsed)
  } catch {
    return false
  }
}
