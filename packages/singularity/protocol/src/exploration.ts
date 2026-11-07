import { z } from 'zod'

import { computeDigest } from './digest.ts'
import { skillAssetSchema, toolAssetSchema } from './method.ts'
import type { MethodRevision, TaskTemplate } from './method.ts'
import { refSchema } from './refs.ts'
import { closedObject } from './schema.ts'
import { DEFAULT_TASK_PROPOSAL_INSTANCE_SCHEMA } from './task.ts'
import type { TaskExample } from './task.ts'

/** Frozen public resources explicitly selected by domain/operator (§6.1). */
export const globalResourceSnapshotSchema = closedObject({
  v: z.literal(1),
  documents: z.array(closedObject({ id: z.string(), description: z.string(), object: refSchema })),
  skills: z.array(skillAssetSchema),
  tools: z.array(toolAssetSchema),
  baseTools: z.array(refSchema),
  fallbackAcceptance: refSchema,
  fallbackJoin: z.enum(['required', 'probe']),
})

export type GlobalResourceSnapshot = z.infer<typeof globalResourceSnapshotSchema>

export const EXPLORE_TEMPLATE_ID = 'platform:explore-child'
export const EXPLORE_BINDING_ID = 'platform:explore-child'

export const EXPLORE_GUIDANCE = {
  v: 1,
  text: 'Use frozen public resources for the current goal and deliver consumable files under result/.',
} as const

export const EXPLORE_EXAMPLE = {
  goal: {
    summary: 'Implement the callable consumer for the declared input.',
    deliverable: 'result/consumer.sh and a declared output produced by invoking it with the frozen input.',
    scope: ['Own implementation, invocation and local checks for this consumer; discover any direct responsibilities needed.'],
    constraints: ['Consume only the frozen declared input and emit a deterministic output at the declared interface.',
      'The parent retains final integration and end-to-end checks; the next batch consumes the frozen output.'],
  },
  acceptanceCriteria: [{ id: 'consumer-interface', statement: 'The child provides an executable consumer and the declared output at stable paths.', check: `test -x result/consumer.sh
test -f result/output.bin` }],
  inputs: [{ id: 'input', exampleText: 'A representative sample of the frozen input bytes.' }],
  localOutputs: [{ id: 'output', path: 'result/output.bin', kind: 'file', description: 'Declared output consumed by the parent integration stage.' }],
} satisfies TaskExample

export const EXPLORE_GUIDANCE_REF = { id: 'platform:explore-guidance', digest: computeDigest('object', EXPLORE_GUIDANCE) }
export const EXPLORE_EXAMPLE_REF = { id: 'platform:explore-example', digest: computeDigest('object', EXPLORE_EXAMPLE) }

/** Fixed platform template, bound only to this frozen domain resource snapshot. */
export function explorationTemplate(snapshot: GlobalResourceSnapshot): TaskTemplate {
  return {
    id: EXPLORE_TEMPLATE_ID,
    brief: 'Own one workflow scope, its technical work and result integration.',
    guidance: EXPLORE_GUIDANCE_REF,
    example: EXPLORE_EXAMPLE_REF,
    instanceSchema: structuredClone(DEFAULT_TASK_PROPOSAL_INSTANCE_SCHEMA),
    requiredCriteria: [],
    requiredOutputs: [{ id: 'result', path: 'result', kind: 'tree', role: 'deliverable', required: true }],
    acceptancePolicy: snapshot.fallbackAcceptance,
    skills: snapshot.skills.map(skill => skill.id),
    tools: snapshot.tools.map(tool => tool.id),
    children: [{ bindingId: EXPLORE_BINDING_ID, templateId: EXPLORE_TEMPLATE_ID, brief: 'Own a direct workflow scope with consumable outputs and checks.', join: snapshot.fallbackJoin }],
  }
}

/** Resolves a local exploration view without changing the pinned Method. */
export function resolveTemplateView(method: MethodRevision, templateId: string, snapshot?: GlobalResourceSnapshot): TaskTemplate | undefined {
  if (method.templates.some(template => template.id === EXPLORE_TEMPLATE_ID)) return undefined
  if (templateId === EXPLORE_TEMPLATE_ID) return snapshot === undefined ? undefined : explorationTemplate(snapshot)
  const matches = method.templates.filter(candidate => candidate.id === templateId)
  const template = matches.length === 1 ? matches[0] : undefined
  if (template === undefined || snapshot === undefined || template.children.length > 0) return template
  const fallback = explorationTemplate(snapshot)
  return {
    ...template,
    skills: [...new Set([...template.skills, ...fallback.skills])],
    tools: [...new Set([...template.tools, ...fallback.tools])],
    children: fallback.children,
  }
}
