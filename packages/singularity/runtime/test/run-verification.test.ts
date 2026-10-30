import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  sealPublicReceipt,
  sealSubmissionManifest,
  sealTaskContract,
} from '@singularity/protocol'
import type {
  PublicReceipt,
  Ref,
  SubmissionManifest,
  TaskContract,
} from '@singularity/protocol'

import { DomainStore } from '../src/store.ts'
import {
  VERIFIER_ERROR_REASON,
  VERIFIER_TIMEOUT_REASON,
  verifyRunSubmission,
} from '../src/verification.ts'
import type { RunVerifier, VerifierRequest } from '../src/verification.ts'

const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`

function makeContract(): TaskContract {
  return sealTaskContract({
    v: 1,
    taskId: 'task-verify',
    spec: {
      goal: {
        summary: 'verify',
        deliverable: 'one output',
        scope: [],
        constraints: [],
      },
      criteria: [{ id: 'crit', statement: 'must pass', required: true }],
      inputs: [{ id: 'input', object: { id: 'input', digest: digestA }, path: 'in.txt', access: 'read' }],
      outputs: [
        { id: 'out', path: 'out.txt', kind: 'file', role: 'deliverable', required: true },
      ],
    },
    origin: { kind: 'root', purpose: 'work', requestRef: { id: 'request', digest: digestA } },
    method: { id: 'method', digest: digestB },
    template: { id: 'template', digest: digestB },
    resources: { baseTools: [], skills: [], mcpServers: [] },
    acceptance: { id: 'acceptance', digest: digestA },
    environment: {
      seed: { id: 'seed', digest: digestA },
      profile: { id: 'profile', digest: digestB },
    },
    limits: {
      maxRuns: 1,
      maxStepsPerRun: 10,
      maxTokens: 1000,
      deadlineAt: 10_000,
      maxDepth: 1,
      maxTasks: 1,
      maxBatchChildren: 1,
    },
  })
}

function makeManifest(contract: TaskContract, outputRef: Ref): SubmissionManifest {
  return sealSubmissionManifest({
    v: 1,
    taskId: contract.taskId,
    runId: 'run-verify',
    contractDigest: contract.digest,
    includeLearningDrafts: false,
    outputs: [
      {
        id: 'out',
        path: 'out.txt',
        kind: 'file',
        role: 'deliverable',
        required: true,
        object: outputRef,
      },
    ],
    learningDrafts: [],
    checks: [{ outputId: 'out', bytes: 5, symlinks: 'none' }],
  })
}

function receipt(
  contract: TaskContract,
  provider: Ref,
  overrides: Partial<{
    verdict: 'pass' | 'fail' | 'invalid'
    code: number | null
    signal: string | null
    timedOut: boolean
    inputDigest: string
    outputDigest: string
  }> = {},
): PublicReceipt {
  return sealPublicReceipt({
    v: 1,
    provider,
    operationId: 'run-verify:verify',
    contractDigest: contract.digest,
    inputDigests: [overrides.inputDigest ?? digestA],
    outputDigests: [overrides.outputDigest ?? digestB],
    criteria: [
      {
        id: 'crit',
        verdict: overrides.verdict ?? 'pass',
        reason: 'public criterion reason',
      },
    ],
    exit: {
      code: overrides.code === undefined ? 0 : overrides.code,
      signal: overrides.signal ?? null,
    },
    timedOut: overrides.timedOut ?? false,
  })
}

async function withStore<T>(operation: (store: DomainStore) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-verify-store-'))
  const store = await DomainStore.open({ root })
  try {
    return await operation(store)
  } finally {
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function run(
  store: DomainStore,
  options: {
    readonly verifier: RunVerifier
    readonly contract: TaskContract
    readonly manifest: SubmissionManifest
    readonly outputRef: Ref
  },
) {
  return verifyRunSubmission({
    contract: options.contract,
    runId: 'run-verify',
    manifest: options.manifest,
    inputs: [{ id: 'input', digest: digestA }],
    outputs: [options.outputRef],
    verifier: options.verifier,
    reader: store,
    writer: store,
  })
}

void test('host classifies verified and failed receipts and writes the receipt to CAS', async () => {
  await withStore(async store => {
    const outputRef = await store.putObject('output', new TextEncoder().encode('out!!'), 'object')
    const contract = makeContract()
    const manifest = makeManifest(contract, outputRef)
    const provider = { id: 'provider', digest: digestA }

    let readBack = ''
    const verified = await run(store, {
      contract,
      manifest,
      outputRef,
      verifier: {
        provider,
        async verify(request: VerifierRequest) {
          assert.equal(request.operationId, 'run-verify:verify')
          const { bytes } = await request.readObject(outputRef, 'object')
          readBack = new TextDecoder().decode(bytes)
          return receipt(contract, provider, { outputDigest: outputRef.digest })
        },
      },
    })
    if (verified.verdict !== 'verified') assert.fail('expected a verified receipt')
    assert.equal(readBack, 'out!!')
    const stored = await store.readObject(verified.receiptRef, 'object')
    const storedValue = JSON.parse(new TextDecoder().decode(stored.bytes)) as { readonly digest?: unknown }
    assert.equal(storedValue.digest, verified.receipt.digest)

    const failed = await run(store, {
      contract,
      manifest,
      outputRef,
      verifier: {
        provider,
        verify: () => Promise.resolve(receipt(contract, provider, {
          verdict: 'fail',
          code: 0,
          outputDigest: outputRef.digest,
        })),
      },
    })
    assert.equal(failed.verdict, 'failed')
  })
})

void test('verifier self-reported verdict, timeout, signal, and identity mismatches are invalid', async () => {
  await withStore(async store => {
    const outputRef = await store.putObject('output-invalid', new TextEncoder().encode('out!!'), 'object')
    const contract = makeContract()
    const manifest = makeManifest(contract, outputRef)
    const provider = { id: 'provider', digest: digestA }

    const selfVerdict = await run(store, {
      contract,
      manifest,
      outputRef,
      verifier: {
        provider,
        verify: () => Promise.resolve({
          ...receipt(contract, provider),
          verdict: 'verified',
        }),
      },
    })
    assert.equal(selfVerdict.verdict, 'invalid')

    const timedOut = await run(store, {
      contract,
      manifest,
      outputRef,
      verifier: {
        provider,
        verify: () => Promise.resolve(receipt(contract, provider, {
          timedOut: true,
          code: null,
        })),
      },
    })
    if (timedOut.verdict !== 'invalid') assert.fail('expected invalid timeout')
    assert.equal(timedOut.code, 'verifier-timeout')

    const signalled = await run(store, {
      contract,
      manifest,
      outputRef,
      verifier: {
        provider,
        verify: () => Promise.resolve(receipt(contract, provider, {
          code: null,
          signal: 'SIGKILL',
        })),
      },
    })
    if (signalled.verdict !== 'invalid') assert.fail('expected invalid signal')
    assert.equal(signalled.code, 'verifier-signal')

    const wrongProvider = await run(store, {
      contract,
      manifest,
      outputRef,
      verifier: {
        provider,
        verify: () => Promise.resolve(receipt(contract, { id: 'other-provider', digest: digestB })),
      },
    })
    assert.equal(wrongProvider.verdict, 'invalid')

    const wrongDigest = await run(store, {
      contract,
      manifest,
      outputRef,
      verifier: {
        provider,
        verify: () => Promise.resolve(receipt(contract, provider, {
          outputDigest: digestA,
        })),
      },
    })
    assert.equal(wrongDigest.verdict, 'invalid')

    const allPassExitOne = await run(store, {
      contract,
      manifest,
      outputRef,
      verifier: {
        provider,
        verify: () => Promise.resolve(receipt(contract, provider, { code: 1 })),
      },
    })
    assert.equal(allPassExitOne.verdict, 'invalid')

    const thrown = await run(store, {
      contract,
      manifest,
      outputRef,
      verifier: {
        provider,
        verify: () => Promise.reject(new Error('infrastructure down')),
      },
    })
    if (thrown.verdict !== 'invalid') assert.fail('expected invalid verifier error')
    assert.ok(thrown.reason.startsWith(VERIFIER_ERROR_REASON))
  })
})

void test('timeout reason is stable for transient retry policy matching', async () => {
  await withStore(async store => {
    const outputRef = await store.putObject('output-timeout', new TextEncoder().encode('out!!'), 'object')
    const contract = makeContract()
    const manifest = makeManifest(contract, outputRef)
    const provider = { id: 'provider', digest: digestA }
    const result = await run(store, {
      contract,
      manifest,
      outputRef,
      verifier: {
        provider,
        verify: () => Promise.resolve(receipt(contract, provider, { timedOut: true, code: null })),
      },
    })
    if (result.verdict !== 'invalid') assert.fail('expected invalid timeout')
    assert.ok(result.reason.startsWith(VERIFIER_TIMEOUT_REASON))
    assert.equal(result.code, VERIFIER_TIMEOUT_REASON)
  })
})
