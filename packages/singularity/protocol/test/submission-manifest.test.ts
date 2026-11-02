import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDigest, digestSchema, verifyDigest } from '../src/digest.ts'
import * as protocol from '../src/index.ts'
import {
  sealSubmissionManifest,
  submissionCheckSchema,
  submissionManifestPayloadSchema,
  submissionManifestSchema,
  submittedLearningDraftSchema,
  submittedOutputSchema,
  validateSubmissionManifest,
  verifySubmissionManifest,
} from '../src/acceptance.ts'
import type {
  SubmissionManifest,
  SubmissionManifestExpectation,
  SubmissionManifestPayload,
  SubmissionCheck,
  SubmittedLearningDraft,
  SubmittedOutput,
} from '../src/acceptance.ts'
import { sealTaskContract } from '../src/task.ts'
import type { TaskContract, TaskContractPayload } from '../src/task.ts'

const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`
const digestC = `sha256:${'c'.repeat(64)}`
const digestD = `sha256:${'d'.repeat(64)}`
const digestE = `sha256:${'e'.repeat(64)}`

function objectRef(id: string, digest: string = digestA): { id: string; digest: string } {
  return { id, digest }
}

const baseOutputs: TaskContractPayload['spec']['outputs'] = [
  { id: 'result', path: 'outputs/result.txt', kind: 'file', role: 'deliverable', required: true },
  { id: 'support', path: 'outputs/support', kind: 'tree', role: 'supporting', required: false },
  { id: '__skill-drafts', path: 'learning-drafts/skills', kind: 'tree', role: 'skill-draft', required: false },
  { id: '__mcp-drafts', path: 'learning-drafts/mcp-servers', kind: 'tree', role: 'mcp-draft', required: false },
]

function contractWith(outputs: TaskContractPayload['spec']['outputs']): TaskContract {
  return sealTaskContract({
    v: 1,
    taskId: 'task-1',
    spec: {
      goal: {
        summary: 'Produce the public result',
        deliverable: 'A sealed submission manifest',
        scope: ['submission'],
        constraints: ['strict output order'],
      },
      criteria: [{checks: [{checkId: 'criterion-1', recipeRef: {id:'fixture:check',digest:'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'},params:{}}], id: 'criterion-1', statement: 'The result is public', required: true }],
      inputs: [],
      outputs,
    },
    origin: { kind: 'root', purpose: 'work', requestRef: objectRef('request', digestB) },
    method: objectRef('method', digestC),
    template: objectRef('template', digestD),
    resources: { baseTools: [], skills: [], mcpServers: [] },
    acceptance: objectRef('acceptance', digestE),
    environment: { seed: objectRef('seed', digestA), profile: objectRef('profile', digestB) },
    limits: {
      maxRuns: 1,
      maxStepsPerRun: 10,
      maxTokens: 1000,
      deadlineAt: 1_800_000_000_000,
      maxDepth: 1,
      maxTasks: 2,
      maxBatchChildren: 1,
    },
  })
}

const contract = contractWith(baseOutputs)
const expectation: SubmissionManifestExpectation = { contract, runId: 'run-1' }

const outputs: SubmittedOutput[] = [
  {
    id: 'result',
    path: 'outputs/result.txt',
    kind: 'file',
    role: 'deliverable',
    required: true,
    object: objectRef('object-result', digestC),
  },
  {
    id: 'support',
    path: 'outputs/support',
    kind: 'tree',
    role: 'supporting',
    required: false,
  },
]

const skillDraft: SubmittedLearningDraft = {
  id: '__skill-drafts',
  path: 'learning-drafts/skills',
  kind: 'tree',
  role: 'skill-draft',
  required: false,
  object: objectRef('object-skills', digestD),
}

const mcpDraft: SubmittedLearningDraft = {
  id: '__mcp-drafts',
  path: 'learning-drafts/mcp-servers',
  kind: 'tree',
  role: 'mcp-draft',
  required: false,
  object: objectRef('object-mcp', digestE),
}

const checks: SubmissionCheck[] = [
  { outputId: 'result', bytes: 12, symlinks: 'none' },
  { outputId: '__skill-drafts', bytes: 34, symlinks: 'none' },
  { outputId: '__mcp-drafts', bytes: 56, symlinks: 'none' },
]

function manifestPayload(overrides: Partial<SubmissionManifestPayload> = {}): SubmissionManifestPayload {
  return {
    v: 1,
    taskId: 'task-1',
    runId: 'run-1',
    contractDigest: contract.digest,
    includeLearningDrafts: true,
    outputs,
    learningDrafts: [skillDraft, mcpDraft],
    checks,
    ...overrides,
  }
}

function sealedManifest(overrides: Partial<SubmissionManifestPayload> = {}): SubmissionManifest {
  return sealSubmissionManifest(manifestPayload(overrides))
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

void test('protocol index exports the submission manifest schema and validators', () => {
  assert.equal(protocol.sealSubmissionManifest, sealSubmissionManifest)
  assert.equal(protocol.verifySubmissionManifest, verifySubmissionManifest)
  assert.equal(protocol.validateSubmissionManifest, validateSubmissionManifest)
  assert.equal(protocol.submissionManifestPayloadSchema, submissionManifestPayloadSchema)
  assert.equal(protocol.submissionManifestSchema, submissionManifestSchema)
  assert.equal(protocol.submittedOutputSchema, submittedOutputSchema)
  assert.equal(protocol.submittedLearningDraftSchema, submittedLearningDraftSchema)
  assert.equal(protocol.submissionCheckSchema, submissionCheckSchema)
})

void test('sealSubmissionManifest seals the strict manifest in the object domain', () => {
  const payload = manifestPayload()
  const manifest = sealSubmissionManifest(payload)

  assert.equal(manifest.digest, computeDigest('object', payload))
  assert.equal(digestSchema.safeParse(manifest.digest).success, true)
  assert.equal(verifySubmissionManifest(manifest), true)
  assert.equal(verifyDigest('object', manifest), true)
  assert.equal(verifyDigest('evidence', manifest), false)
  assert.deepEqual(submissionManifestPayloadSchema.parse(payload), payload)
  assert.deepEqual(submissionManifestSchema.parse(manifest), manifest)
  assert.equal(sealSubmissionManifest(payload).digest, manifest.digest)
})

void test('validateSubmissionManifest accepts the frozen contract, declaration order, and checks', () => {
  const result = validateSubmissionManifest(sealedManifest(), expectation)

  assert.equal(result.valid, true)
  assert.equal(verifySubmissionManifest(result.manifest), true)
})

void test('task, run, and contract identity must match the frozen submission', () => {
  assert.equal(validateSubmissionManifest(sealedManifest({ taskId: 'task-2' }), expectation).valid, false)
  assert.equal(validateSubmissionManifest(sealedManifest({ runId: 'run-2' }), expectation).valid, false)
  assert.equal(validateSubmissionManifest(sealedManifest({ contractDigest: digestA }), expectation).valid, false)
})

void test('the manifest must preserve the contract output declaration order', () => {
  const reversed = [outputs[1], outputs[0]]
  const result = validateSubmissionManifest(sealedManifest({ outputs: reversed }), expectation)
  assert.equal(result.valid, false)
})

void test('every non-draft contract output must be present with the contract fields', () => {
  const missingOutput = validateSubmissionManifest(
    sealedManifest({ outputs: [outputs[0]] }),
    expectation,
  )
  assert.equal(missingOutput.valid, false)

  const wrongPath = validateSubmissionManifest(
    sealedManifest({
      outputs: [
        { ...(outputs[0]), path: 'outputs/other.txt' },
        outputs[1],
      ],
    }),
    expectation,
  )
  assert.equal(wrongPath.valid, false)

  const wrongRole = validateSubmissionManifest(
    sealedManifest({
      outputs: [
        { ...(outputs[0]), role: 'supporting' },
        outputs[1],
      ],
    }),
    expectation,
  )
  assert.equal(wrongRole.valid, false)

  const extraOutput = validateSubmissionManifest(
    sealedManifest({
      outputs: [
        ...outputs,
        {
          id: 'extra',
          path: 'outputs/extra.txt',
          kind: 'file',
          role: 'supporting',
          required: false,
        },
      ],
    }),
    expectation,
  )
  assert.equal(extraOutput.valid, false)
})

void test('required outputs must carry a frozen object reference', () => {
  assert.throws(() =>
    sealSubmissionManifest(
      manifestPayload({
        outputs: [
          {
            id: 'result',
            path: 'outputs/result.txt',
            kind: 'file',
            role: 'deliverable',
            required: true,
          },
          outputs[1],
        ],
      }),
    ),
  )

  const handCrafted = {
    ...manifestPayload({
      outputs: [
        {
          id: 'result',
          path: 'outputs/result.txt',
          kind: 'file',
          role: 'deliverable',
          required: true,
        },
        outputs[1],
      ],
    }),
    digest: digestA,
  }
  assert.equal(validateSubmissionManifest(handCrafted, expectation).valid, false)
})

void test('optional outputs without an object are not acceptance inputs and receive no check', () => {
  const result = validateSubmissionManifest(sealedManifest(), expectation)
  assert.equal(result.valid, true)

  const optionalWithObject: SubmittedOutput = {
    ...(outputs[1]),
    object: objectRef('object-support', digestB),
  }
  const withCheck = validateSubmissionManifest(
    sealedManifest({
      outputs: [outputs[0], optionalWithObject],
      checks: [
        { outputId: 'result', bytes: 12, symlinks: 'none' },
        { outputId: 'support', bytes: 8, symlinks: 'none' },
        { outputId: '__skill-drafts', bytes: 34, symlinks: 'none' },
        { outputId: '__mcp-drafts', bytes: 56, symlinks: 'none' },
      ],
    }),
    expectation,
  )
  assert.equal(withCheck.valid, true)
})

void test('includeLearningDrafts false requires an empty draft array', () => {
  const empty = validateSubmissionManifest(
    sealedManifest({
      includeLearningDrafts: false,
      learningDrafts: [],
      checks: [{ outputId: 'result', bytes: 12, symlinks: 'none' }],
    }),
    expectation,
  )
  assert.equal(empty.valid, true)

  assert.throws(() =>
    sealSubmissionManifest(
      manifestPayload({
        includeLearningDrafts: false,
      }),
    ),
  )

  const handCrafted = { ...manifestPayload({ includeLearningDrafts: false }), digest: digestA }
  assert.equal(validateSubmissionManifest(handCrafted, expectation).valid, false)
})

void test('includeLearningDrafts true may freeze no drafts, one draft, or both in fixed order', () => {
  const none = validateSubmissionManifest(
    sealedManifest({ learningDrafts: [], checks: [{ outputId: 'result', bytes: 12, symlinks: 'none' }] }),
    expectation,
  )
  assert.equal(none.valid, true)

  const skillOnly = validateSubmissionManifest(
    sealedManifest({
      learningDrafts: [skillDraft],
      checks: [
        { outputId: 'result', bytes: 12, symlinks: 'none' },
        { outputId: '__skill-drafts', bytes: 34, symlinks: 'none' },
      ],
    }),
    expectation,
  )
  assert.equal(skillOnly.valid, true)

  const mcpOnly = validateSubmissionManifest(
    sealedManifest({
      learningDrafts: [mcpDraft],
      checks: [
        { outputId: 'result', bytes: 12, symlinks: 'none' },
        { outputId: '__mcp-drafts', bytes: 56, symlinks: 'none' },
      ],
    }),
    expectation,
  )
  assert.equal(mcpOnly.valid, true)
})

void test('learning drafts must keep the fixed skill then MCP order and unique ids', () => {
  assert.throws(() =>
    sealSubmissionManifest(manifestPayload({ learningDrafts: [mcpDraft, skillDraft] })),
  )

  const reversed = { ...manifestPayload({ learningDrafts: [mcpDraft, skillDraft] }), digest: digestA }
  assert.equal(validateSubmissionManifest(reversed, expectation).valid, false)

  const duplicate = {
    ...manifestPayload({
      learningDrafts: [skillDraft, skillDraft],
      checks: [
        { outputId: 'result', bytes: 12, symlinks: 'none' },
        { outputId: '__skill-drafts', bytes: 34, symlinks: 'none' },
        { outputId: '__skill-drafts', bytes: 34, symlinks: 'none' },
      ],
    }),
    digest: digestA,
  }
  assert.equal(validateSubmissionManifest(duplicate, expectation).valid, false)
})

void test('learning drafts must use the fixed id/path/role shape', () => {
  assert.throws(() =>
    sealSubmissionManifest(
      manifestPayload({
        learningDrafts: [
          { ...skillDraft, path: 'learning-drafts/mcp-servers' } as unknown as SubmittedLearningDraft,
        ],
      }),
    ),
  )
  assert.throws(() =>
    sealSubmissionManifest(
      manifestPayload({
        learningDrafts: [{ ...skillDraft, role: 'mcp-draft' } as unknown as SubmittedLearningDraft],
      }),
    ),
  )
})

void test('a manifest draft must correspond to a draft declared by the frozen contract', () => {
  const noDraftContract = contractWith(baseOutputs.slice(0, 2))
  const noDraftExpectation: SubmissionManifestExpectation = { contract: noDraftContract, runId: 'run-1' }
  const manifest = sealSubmissionManifest({
    ...manifestPayload(),
    contractDigest: noDraftContract.digest,
  })

  assert.equal(validateSubmissionManifest(manifest, noDraftExpectation).valid, false)
})

void test('checks must match frozen objects one-to-one in the manifest order', () => {
  assert.throws(() => sealSubmissionManifest(manifestPayload({ checks: checks.slice(0, 2) })))
  assert.throws(() =>
    sealSubmissionManifest(
      manifestPayload({
        checks: [
          ...checks,
          { outputId: 'support', bytes: 1, symlinks: 'none' },
        ],
      }),
    ),
  )
  assert.throws(() =>
    sealSubmissionManifest(
      manifestPayload({
        checks: [checks[1], checks[0], checks[2]],
      }),
    ),
  )

  const missing = { ...manifestPayload({ checks: checks.slice(0, 2) }), digest: digestA }
  assert.equal(validateSubmissionManifest(missing, expectation).valid, false)
})

void test('a check for an unfrozen optional output is an extra check and is invalid', () => {
  const handCrafted = {
    ...manifestPayload({
      checks: [
        ...checks,
        { outputId: 'support', bytes: 0, symlinks: 'none' },
      ],
    }),
    digest: digestA,
  }
  assert.equal(validateSubmissionManifest(handCrafted, expectation).valid, false)
})

void test('check bytes are non-negative safe integers and symlinks must be none', () => {
  for (const bytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    assert.throws(() =>
      sealSubmissionManifest(
        manifestPayload({
          checks: [{ outputId: 'result', bytes, symlinks: 'none' }, ...checks.slice(1)],
        }),
      ),
    )
  }

  assert.throws(() =>
    sealSubmissionManifest(
      manifestPayload({
        checks: [
          { outputId: 'result', bytes: 1, symlinks: 'all' as unknown as 'none' },
          ...checks.slice(1),
        ],
      }),
    ),
  )
})

void test('output and draft ids and paths must remain unique and disjoint', () => {
  const duplicateOutput = validateSubmissionManifest(
    {
      ...manifestPayload({
        outputs: [
          outputs[0],
          outputs[0],
        ],
        checks: [{ outputId: 'result', bytes: 12, symlinks: 'none' }],
      }),
      digest: digestA,
    },
    expectation,
  )
  assert.equal(duplicateOutput.valid, false)

  const overlappingDraft = validateSubmissionManifest(
    {
      ...manifestPayload({
        outputs: [
          outputs[0],
          { ...(outputs[1]), id: skillDraft.id, path: skillDraft.path },
        ],
        learningDrafts: [skillDraft],
        checks,
      }),
      digest: digestA,
    },
    expectation,
  )
  assert.equal(overlappingDraft.valid, false)
})

void test('strictness rejects unknown fields, bad versions, and malformed draft shapes', () => {
  assert.throws(() => sealSubmissionManifest({ ...manifestPayload(), at: 1 }))
  assert.throws(() => sealSubmissionManifest({ ...manifestPayload(), v: 2 }))

  const missingDrafts = { ...manifestPayload() } as Record<string, unknown>
  delete missingDrafts['learningDrafts']
  assert.throws(() => sealSubmissionManifest(missingDrafts))
})

void test('tampered manifests and wrong-domain seals are invalid', () => {
  const tampered = clone(sealedManifest())
  ;(tampered.outputs[0] as { path: string }).path = 'outputs/changed.txt'
  assert.equal(validateSubmissionManifest(tampered, expectation).valid, false)

  const payload = manifestPayload()
  const wrongDomain = { ...payload, digest: computeDigest('evidence', payload) }
  assert.equal(validateSubmissionManifest(wrongDomain, expectation).valid, false)
})

void test('a manifest must be validated against a sealed frozen contract', () => {
  const tamperedContract = { ...contract, spec: { ...contract.spec, outputs: [] } }
  const result = validateSubmissionManifest(sealedManifest(), {
    contract: tamperedContract,
    runId: 'run-1',
  })
  assert.equal(result.valid, false)
})
