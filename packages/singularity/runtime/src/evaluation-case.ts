import { canonicalize, evaluationCaseSchema, parseJsonText, parseProtocolValue } from '@singularity/protocol'
import type { EvaluationCase, Ref, TaskContract } from '@singularity/protocol'

import type { CommandService } from './service.ts'

export type { EvaluationCase } from '@singularity/protocol'

export function evaluationCaseFromContract(contract: TaskContract): EvaluationCase {
  return {
    v: 1, spec: contract.spec, acceptance: contract.acceptance, environment: contract.environment, limits: contract.limits,
    baseTools: contract.resources.baseTools,
    ...(contract.resources.exploration === undefined ? {} : { exploration: contract.resources.exploration }),
  }
}

export async function freezeEvaluationCase(service: CommandService, id: string, value: EvaluationCase): Promise<Ref> {
  const body = parseProtocolValue(evaluationCaseSchema, value)
  return service.putObject(id, new TextEncoder().encode(canonicalize(body)))
}

export async function readEvaluationCase(service: CommandService, ref: Ref): Promise<EvaluationCase> {
  const stored = await service.readObject(ref)
  return parseProtocolValue(evaluationCaseSchema, parseJsonText(new TextDecoder('utf-8', { fatal: true }).decode(stored.bytes)))
}
