import { canonicalize, evaluationCaseSchema, parseJsonText, parseProtocolValue } from '@singularity/protocol'
import type { EvaluationCase, Ref, TaskContract, TaskSpec } from '@singularity/protocol'

import type { CommandService } from './service.ts'

export type { EvaluationCase } from '@singularity/protocol'

const LEARNING_DRAFT_OUTPUT_IDS = new Set(['__skill-drafts', '__mcp-drafts'])

/**
 * Host-added learning drafts are appended by `admitRootTask`, never part of
 * the canonical EvaluationCase. Stripping them on both comparison sides keeps
 * a frozen case and its paired Task contract from disagreeing or duplicating
 * the fixed outputs.
 */
export function withoutLearningDraftOutputs(spec: TaskSpec): TaskSpec {
  if (!spec.outputs.some(output => LEARNING_DRAFT_OUTPUT_IDS.has(output.id)
    || output.role === 'skill-draft' || output.role === 'mcp-draft')) return spec
  return {
    ...spec,
    outputs: spec.outputs.filter(output => !LEARNING_DRAFT_OUTPUT_IDS.has(output.id)
      && output.role !== 'skill-draft' && output.role !== 'mcp-draft'),
  }
}

function canonicalEvaluationCase(value: EvaluationCase): EvaluationCase {
  return { ...value, spec: withoutLearningDraftOutputs(value.spec) }
}

export function evaluationCaseFromContract(contract: TaskContract): EvaluationCase {
  return {
    v: 1, spec: withoutLearningDraftOutputs(contract.spec), acceptance: contract.acceptance,
    environment: contract.environment, limits: contract.limits,
    baseTools: contract.resources.baseTools,
    ...(contract.resources.exploration === undefined ? {} : { exploration: contract.resources.exploration }),
  }
}

export async function freezeEvaluationCase(service: CommandService, id: string, value: EvaluationCase): Promise<Ref> {
  const body = parseProtocolValue(evaluationCaseSchema, canonicalEvaluationCase(value))
  return service.putObject(id, new TextEncoder().encode(canonicalize(body)))
}

export async function readEvaluationCase(service: CommandService, ref: Ref): Promise<EvaluationCase> {
  const stored = await service.readObject(ref)
  return canonicalEvaluationCase(parseProtocolValue(evaluationCaseSchema,
    parseJsonText(new TextDecoder('utf-8', { fatal: true }).decode(stored.bytes))))
}
