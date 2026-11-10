import assert from 'node:assert/strict'
import test from 'node:test'

import { EXPLORE_TEMPLATE_ID, sliceSelectionSchema } from '@singularity/protocol'
import type { Ref, ReplayPoint } from '@singularity/protocol'

import { selectUtilityV1 } from '../src/selector.ts'
import type { SliceCandidatePoint } from '../src/selector.ts'

const digest = `sha256:${'0'.repeat(64)}`

function ref(id: string): Ref {
  return { id, digest }
}

interface CandidateOptions {
  readonly failed?: boolean
  readonly leaf?: boolean
  readonly retries?: number
  readonly subtreeTokens?: number
  readonly rootTokens?: number
  readonly priorAttempts?: number
  readonly qualityHeadroom?: boolean
  readonly templateId?: string
  readonly bindingPath?: readonly string[]
  readonly closureLevel?: 'closed' | 'best-effort'
  readonly shared?: boolean
}

function point(id: string, options: CandidateOptions = {}): ReplayPoint {
  const closureLevel = options.closureLevel ?? 'closed'
  const sourceCase = ref(`${id}:source-case`)
  return {
    v: 1,
    id,
    sourceTrace: ref(`${id}:trace`),
    sourceTaskId: `${id}:task`,
    sourceContract: ref(`${id}:contract`),
    sourceEvidence: ref(`${id}:evidence`),
    sourceCase,
    baseMethod: ref(`${id}:base-method`),
    templateId: options.templateId ?? 'worker:repair',
    bindingPath: [...(options.bindingPath ?? [])],
    outcome: options.failed === true ? 'failed' : 'verified',
    localCases: [sourceCase],
    closure: closureLevel === 'closed'
      ? {
          level: 'closed',
          workspace: 'fresh-cas-inputs',
          network: 'disabled',
          hostFilesystem: 'denied',
          executionProof: ref(`${id}:proof`),
          reasons: ['hermetic-runner'],
        }
      : {
          level: 'best-effort',
          workspace: 'uncontrolled',
          network: 'uncontrolled',
          hostFilesystem: 'uncontrolled',
          reasons: ['no-hermetic-proof'],
        },
    fanOut: { bindingReferences: 1, shared: options.shared ?? false },
    hostFingerprint: 'dsh-0.2.2-alpha.2:model-route:fixture',
  }
}

function candidate(id: string, options: CandidateOptions = {}): SliceCandidatePoint {
  return {
    point: point(id, options),
    failed: options.failed ?? false,
    leaf: options.leaf ?? false,
    retries: options.retries ?? 0,
    subtreeTokens: options.subtreeTokens ?? 0,
    rootTokens: options.rootTokens ?? 100,
    priorAttempts: options.priorAttempts ?? 0,
    qualityHeadroom: options.qualityHeadroom ?? true,
  }
}

void test('utility-v1 is deterministic and breaks ties by point.id regardless of input order', () => {
  const tiedA = candidate('worker:a')
  const tiedB = candidate('worker:b')
  const expensiveFailure = candidate('worker:c', {
    failed: true, retries: 9, subtreeTokens: 100, leaf: true,
  })

  const forward = selectUtilityV1([tiedB, expensiveFailure, tiedA], true)
  const reverse = selectUtilityV1([tiedA, expensiveFailure, tiedB], true)
  const repeated = selectUtilityV1([expensiveFailure, tiedA, tiedB], true)
  assert.equal(forward?.point.id, 'worker:c')
  assert.deepEqual(reverse, forward)
  assert.deepEqual(repeated, forward)
  assert.deepEqual(forward.reasons, [
    'independent-failed-evidence',
    'retry-pressure',
    'subtree-cost-share',
    'leaf-tool-opportunity',
  ])

  const exactTie = selectUtilityV1([tiedB, tiedA], true)
  assert.equal(exactTie?.point.id, 'worker:a')
  assert.equal(selectUtilityV1([tiedA, tiedB], true)?.point.id, 'worker:a')
})

void test('utility-v1 filters reserved templates except an empty-root explore bootstrap', () => {
  for (const templateId of ['platform:runner', 'singularity_internal', 'rsi_workflow', 'worker:explore-child-helper']) {
    assert.equal(selectUtilityV1([candidate(`reserved:${templateId}`, { templateId })], true), undefined)
  }
  assert.equal(
    selectUtilityV1([candidate('reserved:explore-child', { templateId: EXPLORE_TEMPLATE_ID, bindingPath: ['child'] })], true),
    undefined,
  )

  const bootstrap = selectUtilityV1([candidate('root:bootstrap', { templateId: EXPLORE_TEMPLATE_ID })], true)
  assert.equal(bootstrap?.point.templateId, EXPLORE_TEMPLATE_ID)
  assert.deepEqual(bootstrap.point.bindingPath, [])
  assert.equal(bootstrap.score, 0)
  assert.deepEqual(bootstrap.reasons, ['retry-pressure', 'subtree-cost-share'])
})

void test('utility-v1 excludes unproven closure when requireClosed is set', () => {
  const bestEffort = candidate('worker:best-effort', { closureLevel: 'best-effort' })
  assert.equal(selectUtilityV1([bestEffort], true), undefined)

  const open = selectUtilityV1([bestEffort], false)
  assert.equal(open?.point.id, 'worker:best-effort')
  assert.equal(open.score, -1)
  assert.deepEqual(open.reasons, ['retry-pressure', 'subtree-cost-share', 'best-effort-only'])
})

void test('utility-v1 filters saturated quality points unless headroom is waived', () => {
  const saturatedFailure = candidate('worker:saturated', { failed: true, qualityHeadroom: false })
  assert.equal(selectUtilityV1([saturatedFailure], true), undefined)
  assert.equal(selectUtilityV1([saturatedFailure], true, false)?.point.id, 'worker:saturated')

  const lowValue = candidate('worker:low-value')
  const selected = selectUtilityV1([saturatedFailure, lowValue], true)
  assert.equal(selected?.point.id, 'worker:low-value')
})

void test('utility-v1 scores failure, retries, cost share, and leaf status', () => {
  const selected = selectUtilityV1([candidate('worker:full-credit', {
    failed: true,
    retries: 6,
    subtreeTokens: 100,
    rootTokens: 100,
    leaf: true,
  })], true)
  assert.equal(selected?.score, 5.2)
  assert.deepEqual(selected.reasons, [
    'independent-failed-evidence',
    'retry-pressure',
    'subtree-cost-share',
    'leaf-tool-opportunity',
  ])

  const zeroRoot = selectUtilityV1([candidate('worker:zero-root', { subtreeTokens: 100, rootTokens: 0 })], true)
  assert.equal(zeroRoot?.score, 0)
  const capped = selectUtilityV1([candidate('worker:capped', { subtreeTokens: 500, rootTokens: 100 })], true)
  assert.equal(capped?.score, 1)
  const partial = selectUtilityV1([candidate('worker:partial', { retries: 1, subtreeTokens: 25, rootTokens: 100 })], true)
  assert.equal(partial?.score, 0.25 + 1 / 3)
})

void test('utility-v1 penalizes shared template fan-out', () => {
  const shared = candidate('worker:shared', { shared: true })
  const privatePoint = candidate('worker:private')
  const selected = selectUtilityV1([shared, privatePoint], true)
  assert.equal(selected?.point.id, 'worker:private')
  assert.equal(selected.score, 0)

  const sharedOnly = selectUtilityV1([shared], true)
  assert.equal(sharedOnly?.score, -0.25)
  assert.deepEqual(sharedOnly.reasons, ['retry-pressure', 'subtree-cost-share', 'shared-template-fanout'])
})

void test('utility-v1 penalizes prior attempts with a saturated history penalty', () => {
  const fresh = candidate('worker:fresh')
  const attempted = candidate('worker:attempted', { priorAttempts: 2 })
  assert.equal(selectUtilityV1([attempted, fresh], true)?.point.id, 'worker:fresh')
  assert.equal(selectUtilityV1([attempted], true)?.score, -1)

  const cappedA = candidate('worker:capped-a', { priorAttempts: 2 })
  const cappedB = candidate('worker:capped-b', { priorAttempts: 10 })
  assert.equal(selectUtilityV1([cappedB, cappedA], true)?.point.id, 'worker:capped-a')
  assert.equal(selectUtilityV1([cappedB], true)?.score, -1)
})

void test('utility-v1 snapshots visible features and returns no point for empty input', () => {
  const input = candidate('worker:featured', {
    failed: true,
    leaf: true,
    retries: 2,
    subtreeTokens: 40,
    rootTokens: 80,
    priorAttempts: 1,
    qualityHeadroom: true,
  })
  const selected = selectUtilityV1([input], true)
  assert.deepEqual(selected?.features, {
    failed: true,
    leaf: true,
    retries: 2,
    subtreeTokens: 40,
    rootTokens: 80,
    priorAttempts: 1,
    qualityHeadroom: true,
  })
  const mutable = input as { -readonly [Key in keyof SliceCandidatePoint]: SliceCandidatePoint[Key] }
  mutable.failed = false
  mutable.retries = 99
  assert.equal(selected.features.failed, true)
  assert.equal(selected.features.retries, 2)

  assert.equal(selectUtilityV1([], true), undefined)
})

void test('utility-v1 decision round-trips through the strict SliceSelection schema', () => {
  const selected = selectUtilityV1([candidate('worker:archived', { failed: true, retries: 1 })], true)
  assert.ok(selected)
  const archived = sliceSelectionSchema.parse({
    v: 1,
    campaignId: 'round:slice',
    point: selected.point,
    features: selected.features,
    policy: { name: 'utility-v1', revision: 1 },
    visibleHistory: [],
    score: selected.score,
    reasons: selected.reasons,
  })
  assert.deepEqual(archived.features, selected.features)
  assert.equal(archived.point.id, 'worker:archived')
  assert.equal(archived.score, selected.score)
})
