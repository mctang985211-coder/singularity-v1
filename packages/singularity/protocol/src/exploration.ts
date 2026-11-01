import { z } from 'zod'

import { computeDigest } from './digest.ts'
import type { JsonValue } from './json.ts'
import { skillAssetSchema, toolAssetSchema } from './method.ts'
import type { MethodRevision, TaskTemplate } from './method.ts'
import { refSchema } from './refs.ts'
import { closedObject } from './schema.ts'
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
  text: 'Discover this Task\'s local workflow from frozen public documents, skills and tools. Refine the initial sketch after inspecting relevant resources. Delegate stages with distinct outputs and checks to direct children; sequential stages use successive batches. Each child owns deeper work. Perform bounded local technical work and integrate direct results. A leaf goal is one bounded, directly verifiable unit. Public-resource work may use inputs:[]. Preserve reusable skill or MCP drafts under learning-drafts for RSI registration.',
} as const

export const EXPLORE_EXAMPLE: TaskExample = {
  goal: {
    summary: 'Inspect an authorized input and produce a useful local result.',
    deliverable: 'A concise result that supports the parent goal.',
    scope: ['One independently useful local question.'],
    constraints: ['Use only frozen inputs and public resources authorized for this Task.'],
  },
  localCriteria: [{ id: 'local-result', statement: 'The result answers the local question using the supplied input.' }],
  inputs: [{ id: 'source', exampleText: 'A public input that the parent may explicitly pass to this child.' }],
  localOutputs: [{ id: 'result', path: 'result.txt', kind: 'file', description: 'The local result for parent integration.' }],
}

export const EXPLORE_GUIDANCE_REF = { id: 'platform:explore-guidance', digest: computeDigest('object', EXPLORE_GUIDANCE) }
export const EXPLORE_EXAMPLE_REF = { id: 'platform:explore-example', digest: computeDigest('object', EXPLORE_EXAMPLE as unknown as JsonValue) }

/** Fixed platform template, bound only to this frozen domain resource snapshot. */
export function explorationTemplate(snapshot: GlobalResourceSnapshot): TaskTemplate {
  return {
    id: EXPLORE_TEMPLATE_ID,
    brief: 'Explore one local goal using frozen public resources.',
    guidance: EXPLORE_GUIDANCE_REF,
    example: EXPLORE_EXAMPLE_REF,
    instanceSchema: {
      type: 'object', additionalProperties: false,
      required: ['goal', 'inputs'],
      properties: { goal: { type: 'object' }, localCriteria: { type: 'array' }, inputs: { type: 'array' }, localOutputs: { type: 'array' } },
    },
    requiredCriteria: [{ id: 'task-goal', required: true,
      statement: 'Submitted outputs and reproducible evidence fulfill this Task\'s frozen goal, deliverable, scope and constraints.' }],
    requiredOutputs: [],
    acceptancePolicy: snapshot.fallbackAcceptance,
    skills: snapshot.skills.map(skill => skill.id),
    tools: snapshot.tools.map(tool => tool.id),
    children: [{ bindingId: EXPLORE_BINDING_ID, templateId: EXPLORE_TEMPLATE_ID, brief: 'Explore a useful direct subproblem.', join: snapshot.fallbackJoin }],
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
