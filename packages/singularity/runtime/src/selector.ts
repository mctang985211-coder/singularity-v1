import { EXPLORE_TEMPLATE_ID } from '@singularity/protocol'
import type { ReplayPoint, SliceFeatures } from '@singularity/protocol'

/** One replayable Task point with the features visible to utility-v1. */
export interface SliceCandidatePoint {
  readonly point: ReplayPoint
  readonly failed: boolean
  readonly leaf: boolean
  readonly retries: number
  readonly subtreeTokens: number
  readonly rootTokens: number
  readonly priorAttempts: number
  readonly qualityHeadroom: boolean
}

/** Deterministic utility-v1 decision; the caller archives it as a SliceSelection. */
export interface SliceSelectionResult {
  readonly point: ReplayPoint
  readonly score: number
  readonly reasons: string[]
  readonly features: SliceFeatures
}

function isRootBootstrap(point: ReplayPoint): boolean {
  return point.templateId === EXPLORE_TEMPLATE_ID && point.bindingPath.length === 0
}

function isReservedTemplate(templateId: string): boolean {
  return templateId.startsWith('platform:')
    || templateId.startsWith('singularity_')
    || templateId.startsWith('rsi_')
    || templateId.includes('explore-child')
}

function candidateFeatures(candidate: SliceCandidatePoint): SliceFeatures {
  return {
    failed: candidate.failed,
    leaf: candidate.leaf,
    retries: candidate.retries,
    subtreeTokens: candidate.subtreeTokens,
    rootTokens: candidate.rootTokens,
    priorAttempts: candidate.priorAttempts,
    qualityHeadroom: candidate.qualityHeadroom,
  }
}

/**
 * Fixed, deterministic utility-v1 point selector from docs/framework.md §18.2.
 *
 * Reserved non-root templates, insufficient closure, and saturated quality points
 * are filtered before scoring. Ties are broken by `point.id`, independent of the
 * input order, so replaying the same visible prefix selects the same point.
 */
export function selectUtilityV1(
  candidates: readonly SliceCandidatePoint[],
  requireClosed: boolean,
  requireQualityHeadroom = true,
): SliceSelectionResult | undefined {
  let best: SliceSelectionResult | undefined

  for (const candidate of candidates) {
    const { point } = candidate
    if (isReservedTemplate(point.templateId) && !isRootBootstrap(point)) continue
    if (requireClosed && point.closure.level !== 'closed') continue
    if (requireQualityHeadroom && !candidate.qualityHeadroom) continue

    const costShare = candidate.rootTokens === 0
      ? 0
      : Math.min(1, candidate.subtreeTokens / candidate.rootTokens)
    // Frozen utility-v1 weights: failure 3, retry <=1, cost share <=1,
    // leaf 0.2, history <=1 penalty, shared fan-out 0.25, best-effort 1.
    let score = 0
    const reasons: string[] = []

    if (candidate.failed) {
      score += 3
      reasons.push('independent-failed-evidence')
    }
    score += Math.min(1, candidate.retries / 3)
    reasons.push('retry-pressure')
    score += costShare
    reasons.push('subtree-cost-share')
    if (candidate.leaf) {
      score += 0.2
      reasons.push('leaf-tool-opportunity')
    }
    score -= Math.min(2, candidate.priorAttempts) * 0.5
    if (point.fanOut.shared) {
      score -= 0.25
      reasons.push('shared-template-fanout')
    }
    if (point.closure.level !== 'closed') {
      score -= 1
      reasons.push('best-effort-only')
    }

    if (
      best === undefined
      || score > best.score
      || (score === best.score && point.id < best.point.id)
    ) {
      best = { point, score, reasons, features: candidateFeatures(candidate) }
    }
  }

  return best
}
