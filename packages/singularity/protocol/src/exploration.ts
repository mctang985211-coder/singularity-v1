import { z } from 'zod'

import { computeDigest } from './digest.ts'
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
  text: 'Use frozen public resources for the current goal and deliver consumable files under result/.',
} as const

export const EXPLORE_EXAMPLE = {
  goal: {
    summary: 'Implement the record aggregation stage of a report workflow.',
    deliverable: 'result/aggregate.py exposing aggregate(rows) and a CLI taking records.json; totals.json for the later report stage.',
    scope: ['Own parsing, aggregation and stage integration; discover any direct responsibilities needed.'],
    constraints: ['Consume the frozen records input; emit a JSON object mapping each key to its integer sum.',
      'The parent retains final report integration and end-to-end checks; the next batch consumes the frozen totals output.'],
  },
  acceptanceCriteria: [{ id: 'aggregation', statement: 'The callable handles empty and cancelling inputs; callable, CLI and saved totals reproduce the supplied records.', check: `python3 - <<'PY'
import json, runpy, subprocess, sys
from pathlib import Path
rows = json.loads(Path('records.json').read_text())
expected = {}
for row in rows:
    expected[row['key']] = expected.get(row['key'], 0) + row['value']
aggregate = runpy.run_path('result/aggregate.py')['aggregate']
assert aggregate(rows) == expected and aggregate([]) == {}
assert aggregate([{'key':'x','value':-2},{'key':'x','value':2}]) == {'x':0}
actual = json.loads(subprocess.check_output([sys.executable, 'result/aggregate.py', 'records.json']))
assert actual == expected == json.loads(Path('totals.json').read_text())
PY` }],
  inputs: [{ id: 'records', exampleText: '[{"key":"a","value":2},{"key":"b","value":-1},{"key":"a","value":3}]' }],
  localOutputs: [{ id: 'totals', path: 'totals.json', kind: 'file', description: 'Frozen key totals consumed by the next report stage.' }],
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
