import { z } from 'zod'

import { computeDigest } from './digest.ts'
import { skillAssetSchema, toolAssetSchema } from './method.ts'
import type { MethodRevision, TaskTemplate } from './method.ts'
import { refSchema } from './refs.ts'
import { closedObject } from './schema.ts'

/** Frozen public resources explicitly selected by domain/operator (§6.1). */
export const globalResourceSnapshotSchema = closedObject({
  v: z.literal(1),
  documents: z.array(closedObject({ id: z.string(), description: z.string(), object: refSchema })),
  skills: z.array(skillAssetSchema),
  tools: z.array(toolAssetSchema),
  baseTools: z.array(refSchema),
  fallbackAcceptance: refSchema,
  fallbackExample: refSchema,
  fallbackJoin: z.enum(['required', 'probe']),
})

export type GlobalResourceSnapshot = z.infer<typeof globalResourceSnapshotSchema>

export const EXPLORE_TEMPLATE_ID = 'platform:explore-child'
export const EXPLORE_BINDING_ID = 'platform:explore-child'

export const EXPLORE_GUIDANCE = {
  v: 1,
  text: 'Own this Task\'s local workflow, technical work and direct-result integration. Discover the completion path from frozen public documents, skills and tools, then refine the sketch. Delegate distinct bounded responsibilities with consumable outputs and executable checks to direct children; sequential dependencies use later batches. A bounded leaf may complete directly. Copy complete authorized InputRefs from self or child results when passing frozen artifacts; inputs:[] is for work independent of Task artifacts. Prepare the complete example, bind acceptanceChecks for task-goal from policy-authorized recipes, and freeze each child before dispatch. localCriteria is guidance. Run the published checks during work; independent verification repeats them on frozen outputs. Deliver artifacts and reproducible evidence under result/ and submit output ID result. Use feedback and a new Task when a frozen contract is wrong. Preserve reusable skill or MCP drafts under learning-drafts for RSI registration.',
} as const

export const EXPLORE_GUIDANCE_REF = { id: 'platform:explore-guidance', digest: computeDigest('object', EXPLORE_GUIDANCE) }

/** Fixed platform template, bound only to this frozen domain resource snapshot. */
export function explorationTemplate(snapshot: GlobalResourceSnapshot): TaskTemplate {
  return {
    id: EXPLORE_TEMPLATE_ID,
    brief: 'Explore one local goal using frozen public resources.',
    guidance: EXPLORE_GUIDANCE_REF,
    example: snapshot.fallbackExample,
    instanceSchema: {
      type: 'object', additionalProperties: false,
      required: ['goal', 'inputs', 'acceptanceChecks'],
      properties: { goal: { type: 'object' }, localCriteria: { type: 'array' }, inputs: { type: 'array' }, localOutputs: { type: 'array' }, acceptanceChecks: { type: 'array' } },
    },
    requiredCriteria: [{ id: 'task-goal', required: true,
      statement: 'Submitted outputs and reproducible evidence fulfill this Task\'s frozen goal, deliverable, scope and constraints.', checks: [] }],
    requiredOutputs: [{ id: 'result', path: 'result', kind: 'tree', role: 'deliverable', required: true }],
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
