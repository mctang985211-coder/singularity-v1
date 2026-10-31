import { verifyFact } from './fact.ts'
import type { Fact, RsiRoundClosedPayload, RsiRoundOpenedPayload } from './fact.ts'
import { verifyMethodRevision } from './method.ts'
import type { MethodRevision } from './method.ts'
import type { Ref } from './refs.ts'
import { validateRoundPlan } from './round-plan.ts'
import type { RoundPlan } from './round-plan.ts'

export class MethodRoundError extends Error {
  override readonly name = 'MethodRoundError'
  readonly code = 'INVALID_ARGUMENT'
}

export interface RsiRoundState extends RsiRoundOpenedPayload {
  readonly status: 'proposing' | 'checking' | 'evaluating' | 'closed'
  readonly patch?: Ref
  readonly candidateMethod?: Ref
  readonly precheckReceipt?: Ref
  readonly closed?: RsiRoundClosedPayload
}

export interface MethodRoundState {
  readonly methods: ReadonlyMap<string, Ref>
  readonly productionHead?: Ref
  readonly rounds: ReadonlyMap<string, RsiRoundState>
}

/** Method/Round facet of the unified domain fold. */
export function projectMethodRounds(
  facts: readonly Fact[],
  plans: ReadonlyMap<string, RoundPlan>,
  revisions?: ReadonlyMap<string, MethodRevision>,
): MethodRoundState {
  const methods = new Map<string, Ref>()
  const rounds = new Map<string, RsiRoundState>()
  const traces = new Map<string, Ref>()
  const usedTraces = new Set<string>()
  let productionHead: Ref | undefined
  for (const fact of facts) {
    if (fact.type.startsWith('method/') || fact.type.startsWith('rsi/')) guard(verifyFact(fact), 'Method/Round fact is invalid')
    switch (fact.type) {
      case 'method/registered':
        validateRevision(fact.data.revision, fact.data.parent, revisions)
        guard(!methods.has(fact.data.revision.id), 'Method revision is already registered')
        if (fact.data.parent !== undefined) guard(same(methods.get(fact.data.parent.id), fact.data.parent), 'Method parent is absent')
        methods.set(fact.data.revision.id, fact.data.revision)
        break
      case 'method/activated': {
        const data = fact.data
        guard(same(methods.get(data.next.id), data.next), 'Activation target is not registered')
        guard(same(data.expectedPrevious, productionHead) && same(data.previous, productionHead), 'Activation expected head differs from production head')
        productionHead = data.next
        break
      }
      case 'rsi/trace-sealed':
        guard(!traces.has(fact.data.rootTaskId), 'Root trace is already sealed')
        traces.set(fact.data.rootTaskId, fact.data.trace)
        break
      case 'rsi/round-opened': {
        const data = fact.data
        guard(!rounds.has(data.roundId), 'Round already exists')
        const plan = plans.get(data.plan.id)
        guard(plan !== undefined, 'RoundPlan is absent')
        validateRoundPlan(plan)
        guard(same(data.baseMethod, productionHead) && same(plan.expectedPreviousActiveMethod, productionHead), 'Round base differs from active head')
        guard([...traces.values()].some(ref => same(ref, data.sourceTrace)), 'Round source trace is not sealed')
        const traceKey = `${data.sourceTrace.id}:${data.sourceTrace.digest}`
        guard(!usedTraces.has(traceKey), 'A consecutive Round requires a new sealed root trace')
        usedTraces.add(traceKey)
        rounds.set(data.roundId, { ...data, status: 'proposing' })
        break
      }
      case 'rsi/proposal-submitted': {
        const round = requireRound(rounds, fact.data.roundId)
        guard(round.status === 'proposing' && round.patch === undefined, 'Round does not accept another proposal')
        rounds.set(round.roundId, { ...round, patch: fact.data.patch, status: 'checking' })
        break
      }
      case 'rsi/candidate-ready': {
        const round = requireRound(rounds, fact.data.roundId)
        guard(round.status === 'checking' && same(round.patch, fact.data.patch), 'Candidate does not match the submitted proposal')
        validateRevision(fact.data.candidateMethod, round.baseMethod, revisions)
        guard(!methods.has(fact.data.candidateMethod.id), 'Candidate revision already exists')
        methods.set(fact.data.candidateMethod.id, fact.data.candidateMethod)
        rounds.set(round.roundId, { ...round, ...fact.data, status: 'evaluating' })
        break
      }
      case 'rsi/round-closed': {
        const round = requireRound(rounds, fact.data.roundId)
        guard(round.status !== 'closed', 'Round is already closed')
        const outcome = fact.data.outcome
        if (outcome === 'improved' || outcome === 'no-improvement') {
          guard(round.status === 'evaluating' && fact.data.comparisonRef !== undefined, 'Compared outcome requires candidate and comparison')
        }
        if (outcome === 'rejected') guard(fact.data.precheckReceipt !== undefined || fact.data.reason !== undefined, 'Rejected Round requires precheck receipt or reason')
        rounds.set(round.roundId, { ...round, status: 'closed', closed: fact.data })
        break
      }
    }
  }
  return { methods, rounds, ...(productionHead === undefined ? {} : { productionHead }) }
}

function validateRevision(ref: Ref, parent: Ref | undefined, revisions: ReadonlyMap<string, MethodRevision> | undefined): void {
  if (revisions === undefined) return
  const revision = revisions.get(ref.id)
  guard(revision !== undefined && verifyMethodRevision(revision) && revision.id === ref.id && revision.digest === ref.digest, 'Method revision is absent or does not match its catalog reference')
  guard(same(revision.parent, parent), 'Method revision parent differs from the registering fact')
}

function requireRound(rounds: ReadonlyMap<string, RsiRoundState>, id: string): RsiRoundState {
  const round = rounds.get(id)
  guard(round !== undefined, 'Round does not exist')
  return round
}

function guard(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MethodRoundError(message)
}

function same(left: Ref | undefined, right: Ref | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && left.id === right.id && left.digest === right.digest
}
