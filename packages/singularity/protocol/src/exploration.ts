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
  text: 'Discover the completion path for this Task. Choose direct responsibility scopes with usable interfaces; dependent work uses later batches. Each child plans its own work. Author acceptanceCriteria with concrete pass rules and self-contained shell checks before dispatch. Checks run at the workspace root with declared input/output paths, during work and independently after submission. Use complete frozen InputRefs from self or child results. Deliver under result/. A bounded leaf may finish directly. Integrate direct results and recheck this Task; preserve reusable discoveries as learning drafts.',
} as const

export const EXPLORE_EXAMPLE: TaskExample = {
  goal: {
    summary: 'Evaluate the supplied arithmetic expression.',
    deliverable: 'result/value.txt containing the evaluated integer.',
    scope: ['One independently useful local question.'],
    constraints: ['Use only frozen inputs and public resources authorized for this Task.'],
  },
  acceptanceCriteria: [{ id: 'local-result', statement: 'The result reproduces the expected value from the supplied input.', check: "python3 - <<'PY'\nfrom pathlib import Path\nassert Path('result/value.txt').read_text().strip() == '4'\nPY" }],
  inputs: [{ id: 'source', exampleText: '2 + 2 = 4; write the value to result/value.txt.' }],
  localOutputs: [],
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
      required: ['goal', 'inputs', 'acceptanceCriteria'],
      properties: { goal: { type: 'object' }, acceptanceCriteria: { type: 'array' }, inputs: { type: 'array' }, localOutputs: { type: 'array' } },
    },
    requiredCriteria: [],
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
