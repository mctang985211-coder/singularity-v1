import {
  canonicalize,
  MethodRoundError,
  parseJsonText,
  parseProtocolValue,
  refSchema,
  roundPlanSchema,
  validateRoundPlan,
} from '@singularity/protocol'
import type {
  Fact,
  FactActor,
  FactPayloadMap,
  JsonValue,
  Ref,
  RoundPlan,
  RsiRoundState,
} from '@singularity/protocol'

import type { CommandService } from './service.ts'
import { readEvaluationCase } from './evaluation-case.ts'

export interface RoundCommandContext {
  readonly service: CommandService
  readonly actor: FactActor
}

/** Freeze the plan before the independent proposer can purchase a request. */
export async function openRsiRound(request: RoundCommandContext & {
  readonly roundId: string
  readonly sourceTrace: Ref
  readonly baseMethod: Ref
  readonly plan: RoundPlan
  readonly proposerSessionId: string
}): Promise<RsiRoundState> {
  const { service, roundId } = request
  const plan = validateRoundPlan(request.plan)
  await Promise.all([...plan.cases, ...plan.validationCases].map(ref => readEvaluationCase(service, ref)))
  const prior = (await service.methodRoundState()).rounds.get(roundId)
  if (prior !== undefined) {
    const priorPlan = await readRoundPlan(service, prior.plan)
    guard(same(prior.sourceTrace, request.sourceTrace) && same(prior.baseMethod, request.baseMethod)
      && prior.proposerSessionId === request.proposerSessionId
      && canonicalize(priorPlan) === canonicalize(plan), 'Round id is already bound to different frozen inputs')
    return prior
  }
  const source = service.facts().find(fact => fact.type === 'rsi/trace-sealed' && same(fact.data.trace, request.sourceTrace))
  guard(source?.type === 'rsi/trace-sealed', 'Round source trace is not sealed')
  const state = await service.taskRunState([])
  const root = state.tasks.get(source.data.rootTaskId)
  guard(root?.contract.origin.kind === 'root' && root.contract.origin.purpose === 'work', 'Evaluation roots cannot automatically start RSI')
  guard(same(root.contract.method, request.baseMethod), 'Round base Method differs from the sealed source Method')
  guard(same(root.contract.environment.seed, plan.sourceSeed), 'Round source seed differs from original admission seed')
  const planRef = await service.putObject(`${roundId}:plan`, encode(plan), 'round-plan')
  await commitRoundFact(request, 'rsi/round-opened', {
    roundId,
    sourceTrace: request.sourceTrace,
    baseMethod: request.baseMethod,
    plan: planRef,
    proposerSessionId: request.proposerSessionId,
  })
  return requireRound(service, roundId)
}

export async function requireRound(service: CommandService, roundId: string): Promise<RsiRoundState> {
  const round = (await service.methodRoundState()).rounds.get(roundId)
  guard(round !== undefined, `Round ${roundId} does not exist`)
  return round
}

export async function readRoundPlan(service: CommandService, ref: Ref): Promise<RoundPlan> {
  return parseProtocolValue(roundPlanSchema, await readRoundObject(service, ref, 'round-plan'))
}

/** Closure records the statistical result and never changes the active Method. */
export async function closeRsiRound(
  context: RoundCommandContext,
  data: FactPayloadMap['rsi/round-closed'],
): Promise<Fact> {
  return commitRoundFact(context, 'rsi/round-closed', data)
}

/** Trusted operator boundary. The proposer has no access to this function. */
export async function activateRoundCandidate(request: RoundCommandContext & {
  readonly roundId: string
  readonly approval: Ref
}): Promise<Fact> {
  const round = await requireRound(request.service, request.roundId)
  guard(round.closed?.outcome === 'improved' && round.closed.comparisonRef !== undefined
    && round.candidateMethod !== undefined, 'Only a completed improved Round can be activated')
  const plan = await readRoundPlan(request.service, round.plan)
  guard(plan.claim === 'domain-evaluation', 'Source replay does not authorize production activation')
  const comparison = await readRoundObject(request.service, round.closed.comparisonRef)
  guard(typeof comparison === 'object' && comparison !== null && !Array.isArray(comparison)
    && comparison.complete === true && comparison.outcome === 'improved'
    && comparison.roundId === request.roundId && canonicalize(comparison.plan) === canonicalize(round.plan), 'Activation requires the complete frozen-plan comparison')
  const approval = await readRoundObject(request.service, request.approval)
  guard(typeof approval === 'object' && approval !== null && !Array.isArray(approval), 'Activation approval is not an object')
  const expectedPrevious = parseProtocolValue(refSchema, approval.expectedPrevious)
  const next = parseProtocolValue(refSchema, approval.next)
  guard(same(expectedPrevious, plan.expectedPreviousActiveMethod) && same(next, round.candidateMethod), 'Approval expected/next does not match the frozen Round')
  // The fold checks expectedPrevious inside the single writer queue. A stale
  // operator approval cannot overwrite an activation committed concurrently.
  return commitRoundFact(request, 'method/activated', {
    expectedPrevious,
    previous: expectedPrevious,
    next,
    approval: request.approval,
    evaluationRef: round.closed.comparisonRef,
  }, `activate:${request.approval.digest}`)
}

export async function commitRoundFact<Type extends 'rsi/round-opened' | 'rsi/round-closed' | 'method/activated'>(
  context: RoundCommandContext,
  type: Type,
  data: FactPayloadMap[Type],
  suffix: string = type,
): Promise<Fact> {
  const roundId = 'roundId' in data ? data.roundId : 'activation'
  return context.service.commit({
    command: {
      v: 1,
      commandId: `${roundId}:${suffix}`,
      tool: 'singularity_rsi_host',
      toolVersion: 1,
      actor: context.actor,
      scope: {},
      input: data as JsonValue,
    },
    type,
    data,
  }, [])
}

export async function readRoundObject(
  service: CommandService,
  ref: Ref,
  domain: 'object' | 'round-plan' | 'evidence' | 'composition' | 'method' = 'object',
): Promise<JsonValue> {
  return parseJsonText(new TextDecoder('utf-8', { fatal: true }).decode((await service.readObject(ref, domain)).bytes))
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value))
}

function same(left: Ref, right: Ref): boolean {
  return left.id === right.id && left.digest === right.digest
}

function guard(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MethodRoundError(message)
}
