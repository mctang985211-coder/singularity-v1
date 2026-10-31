import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobView } from '@deepseek-ai/dsh-jobs'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { sealPublicReceipt, sealTaskContract } from '@singularity/protocol'
import type {
  PublicReceipt,
  Ref,
  TaskContract,
} from '@singularity/protocol'

import { DomainStore } from '../src/store.ts'
import { initialContextEpoch } from '../src/epoch.ts'
import type { FrozenMethodResources } from '../src/resources.ts'
import { RunToolController } from '../src/tools.ts'
import {
  VERIFIER_ERROR_REASON,
  VERIFIER_TIMEOUT_REASON,
  verifyRunSubmission,
} from '../src/verification.ts'
import type { RunVerifier, VerifierRequest } from '../src/verification.ts'

const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`

function makeContract(constraints: string[] = []): TaskContract {
  return sealTaskContract({
    v: 1,
    taskId: 'task-verify',
    spec: {
      goal: {
        summary: 'verify',
        deliverable: 'one output',
        scope: [],
        constraints,
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
    readonly outputRef: Ref
  },
  clock: () => number = () => 0,
) {
  return verifyRunSubmission({
    contract: options.contract,
    runId: 'run-verify',
    inputs: [{ id: 'input', digest: digestA }],
    outputs: [options.outputRef],
    verifier: options.verifier,
    reader: store,
    writer: store,
  }, clock)
}

void test('host deadline bounds a verifier that never returns', async () => {
  await withStore(async store => {
    const outputRef = await store.putObject('output', new TextEncoder().encode('out!!'), 'object')
    const contract = makeContract()
    const result = await Promise.race([
      run(store, {
        contract, outputRef,
        verifier: { provider: contract.acceptance, verify: () => new Promise<never>(() => {}) },
      }, () => contract.limits.deadlineAt - 10),
      new Promise<'hung'>(resolve => { setTimeout(() => { resolve('hung') }, 100) }),
    ])
    assert.notEqual(result, 'hung')
    assert.equal(typeof result === 'object' && result.verdict, 'invalid')
    assert.equal(typeof result === 'object' && 'code' in result && result.code, 'verifier-timeout')
  })
})

void test('host rejects receipts returned at the deadline or after an invalid clock change', async () => {
  await withStore(async store => {
    const outputRef = await store.putObject('output', new TextEncoder().encode('out!!'), 'object')
    const contract = makeContract()
    for (const finishedAt of [contract.limits.deadlineAt, contract.limits.deadlineAt - 2, NaN]) {
      let now = contract.limits.deadlineAt - 1
      const result = await run(store, {
        contract, outputRef,
        verifier: {
          provider: contract.acceptance,
          verify() {
            now = finishedAt
            return Promise.resolve(receipt(contract, contract.acceptance, { outputDigest: outputRef.digest }))
          },
        },
      }, () => now)
      assert.equal(result.verdict, 'invalid')
      assert.equal('code' in result && result.code, 'verifier-timeout')
    }
  })
})

void test('host classifies verified and failed receipts and writes the receipt to CAS', async () => {
  await withStore(async store => {
    const outputRef = await store.putObject('output', new TextEncoder().encode('out!!'), 'object')
    const contract = makeContract()
    const provider = contract.acceptance

    let readBack = ''
    const verified = await run(store, {
      contract,
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
    const provider = contract.acceptance

    const selfVerdict = await run(store, {
      contract,
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
      outputRef,
      verifier: {
        provider,
        verify: () => Promise.resolve(receipt(contract, { id: 'other-provider', digest: digestB })),
      },
    })
    assert.equal(wrongProvider.verdict, 'invalid')

    const wrongDigest = await run(store, {
      contract,
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
      outputRef,
      verifier: {
        provider,
        verify: () => Promise.resolve(receipt(contract, provider, { code: 1 })),
      },
    })
    assert.equal(allPassExitOne.verdict, 'invalid')

    const thrown = await run(store, {
      contract,
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
    const provider = contract.acceptance
    const result = await run(store, {
      contract,
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

void test('frozen acceptance rejects a substituted verifier before it receives CAS access', async () => {
  await withStore(async store => {
    const outputRef = await store.putObject('output-provider', new TextEncoder().encode('out!!'), 'object')
    const contract = makeContract()
    for (const provider of [
      { ...contract.acceptance, id: 'other-provider' },
      { ...contract.acceptance, digest: digestB },
    ]) {
      let called = false
      const result = await run(store, {
        contract,
        outputRef,
        verifier: {
          provider,
          verify() {
            called = true
            return Promise.resolve(receipt(contract, provider, { outputDigest: outputRef.digest }))
          },
        },
      })
      assert.equal(result.verdict, 'invalid')
      assert.equal(called, false)
    }
  })
})

void test('skill dispatch is denied after stop and after submission', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'singularity-skill-guard-work-'))
  const contract = makeContract()
  await writeFile(join(workspace, 'out.txt'), 'x', 'utf8')
  try {
    await withStore(async store => {
      const contextEpoch = initialContextEpoch('skill-guard-session')
      const agent = { session: { id: 'skill-guard-session', snapshotEvents: () => [] } } as unknown as Agent
      const callId = 'skill-guard-call' as ToolRunContext['callId']
      const execution = (name: string, args: unknown = {}): ToolRunContext => ({
        name, agent, arguments: args, callId, rootCallId: callId,
        token: Symbol() as ToolRunContext['token'], signal: new AbortController().signal,
        deferContext() {}, concludeTurn() {},
      })
      const setup = () => {
        const definitions = new Map<string, ToolDefinition>()
        const controller = new RunToolController({
          contract,
          runId: 'skill-guard-run',
          sessionId: 'skill-guard-session',
          workspace,
          skillNames: ['allowed-skill'],
          mcpPlan: { serverNames: [], publicToolNames: [], resourceToolNames: [] },
          writer: store,
          maxOutputBytes: 1024,
          clock: () => 1000,
          budget: () => ({ tokensPct: 100, stepsPct: 100, wallClockPct: 100, depthPct: 100, taskSlotsPct: 100 }),
          checkBudget: () => true,
          epoch: () => contextEpoch,
          commitSubmission: frozen => Promise.resolve(frozen.manifestRef),
        })
        controller.register({ get: () => ({ list: () => [] }), tools: {
          register: (definition: ToolDefinition) => {
            definitions.set(definition.name, definition)
            return () => undefined
          },
          guard() {},
        } } as unknown as Context, agent)
        return { controller, definitions }
      }
      const ready = async (
        controller: RunToolController,
        definitions: ReadonlyMap<string, ToolDefinition>,
      ): Promise<void> => {
        const readTool = definitions.get('singularity_read')
        const planTool = definitions.get('singularity_plan')
        assert.ok(readTool && planTool)
        let cursor: string | undefined
        do {
          const page = await readTool.execute(
            { kind: 'self', ...(cursor === undefined ? {} : { cursor }) },
            execution('singularity_read'),
          ) as { readonly nextCursor?: string }
          cursor = page.nextCursor
        } while (cursor !== undefined)
        await planTool.execute({ sketch: {
          v: 1,
          taskId: contract.taskId,
          runId: 'skill-guard-run',
          contextEpoch,
          objective: 'exercise skill guard states',
          sourceContract: contract.digest,
          levels: [0, 1].map(level => ({
            level, purpose: 'current level', likelyChildren: [], expectedInputs: [], expectedOutputs: [],
          })),
          directPlan: [],
          assumptions: [],
        } }, execution('singularity_plan'))
      }

      const stopped = setup()
      await ready(stopped.controller, stopped.definitions)
      assert.equal(stopped.controller.checkGuard(execution('skill', { name: 'allowed-skill' })), undefined)
      const unbound = stopped.controller.checkGuard(execution('skill', { name: 'other-skill' }))
      assert.ok(unbound)
      assert.equal((JSON.parse(unbound) as { readonly code: string }).code, 'INPUT_NOT_AUTHORIZED')
      const stopTool = stopped.definitions.get('singularity_stop')
      assert.ok(stopTool)
      await stopTool.execute({ reason: 'blocked', message: 'stop skill guard' }, execution('singularity_stop'))
      const afterStop = stopped.controller.checkGuard(execution('skill', { name: 'allowed-skill' }))
      assert.ok(afterStop)
      assert.equal((JSON.parse(afterStop) as { readonly code: string }).code, 'RUN_CLOSED')

      const submitted = setup()
      await ready(submitted.controller, submitted.definitions)
      const submitTool = submitted.definitions.get('singularity_submit')
      assert.ok(submitTool)
      await submitTool.execute(
        { outputIds: ['out'], includeLearningDrafts: false },
        execution('singularity_submit'),
      )
      const afterSubmit = submitted.controller.checkGuard(execution('skill', { name: 'allowed-skill' }))
      assert.ok(afterSubmit)
      assert.equal((JSON.parse(afterSubmit) as { readonly code: string }).code, 'ALREADY_SUBMITTED')
    })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

void test('MCP dispatch guard admits only frozen public tools/resources and keeps lifecycle gates', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'singularity-mcp-guard-work-'))
  const contract = makeContract()
  try {
    await withStore(async store => {
      const contextEpoch = initialContextEpoch('mcp-guard-session')
      const agent = { session: { id: 'mcp-guard-session', snapshotEvents: () => [] } } as unknown as Agent
      const otherAgent = { session: { id: 'mcp-guard-other', snapshotEvents: () => [] } } as unknown as Agent
      const callId = 'mcp-guard-call' as ToolRunContext['callId']
      const execution = (name: string, args: unknown = {}, target: Agent = agent): ToolRunContext => ({
        name, agent: target, arguments: args, callId, rootCallId: callId,
        token: Symbol() as ToolRunContext['token'], signal: new AbortController().signal,
        deferContext() {}, concludeTurn() {},
      })
      const definitions = new Map<string, ToolDefinition>()
      const controller = new RunToolController({
        contract,
        runId: 'mcp-guard-run',
        sessionId: 'mcp-guard-session',
        workspace,
        skillNames: [],
        mcpPlan: {
          serverNames: ['calc'],
          publicToolNames: ['mcp__calc__echo'],
          resourceToolNames: ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'],
        },
        writer: store,
        maxOutputBytes: 1024,
        clock: () => 1000,
        budget: () => ({ tokensPct: 100, stepsPct: 100, wallClockPct: 100, depthPct: 100, taskSlotsPct: 100 }),
        checkBudget: () => true,
        epoch: () => contextEpoch,
        commitSubmission: frozen => Promise.resolve(frozen.manifestRef),
      })
      controller.register({ get: () => ({ list: () => [] }), tools: {
        register: (definition: ToolDefinition) => {
          definitions.set(definition.name, definition)
          return () => undefined
        },
        guard() {},
      } } as unknown as Context, agent)

      const codeOf = (value: string | undefined): string | undefined => value === undefined
        ? undefined
        : (JSON.parse(value) as { readonly code: string }).code

      assert.equal(codeOf(controller.checkGuard(execution('mcp__calc__echo', { message: 'hi' }))), 'READ_SELF_FIRST')
      assert.equal(codeOf(controller.checkGuard(execution('mcp__calc__other', {}))), 'INPUT_NOT_AUTHORIZED')
      assert.equal(codeOf(controller.checkGuard(execution('mcp__other__echo', {}))), 'INPUT_NOT_AUTHORIZED')
      assert.equal(codeOf(controller.checkGuard(execution('list_mcp_resources', { server: 'calc' }))), undefined)
      assert.equal(codeOf(controller.checkGuard(execution('read_mcp_resource', { server: 'other', uri: 'x' }))), 'INPUT_NOT_AUTHORIZED')
      assert.equal(codeOf(controller.checkGuard(execution('mcp__calc__echo', { message: 'hi' }, otherAgent))), 'INVALID_ARGUMENT')

      const readTool = definitions.get('singularity_read')
      const planTool = definitions.get('singularity_plan')
      assert.ok(readTool && planTool)
      let cursor: string | undefined
      do {
        const page = await readTool.execute(
          { kind: 'self', ...(cursor === undefined ? {} : { cursor }) },
          execution('singularity_read'),
        ) as { readonly nextCursor?: string }
        cursor = page.nextCursor
      } while (cursor !== undefined)
      assert.equal(codeOf(controller.checkGuard(execution('mcp__calc__echo', { message: 'hi' }))), 'PLAN_FIRST')
      await planTool.execute({ sketch: {
        v: 1,
        taskId: contract.taskId,
        runId: 'mcp-guard-run',
        contextEpoch,
        objective: 'exercise MCP guard states',
        sourceContract: contract.digest,
        levels: [0, 1].map(level => ({
          level, purpose: 'current level', likelyChildren: [], expectedInputs: [], expectedOutputs: [],
        })),
        directPlan: [],
        assumptions: [],
      } }, execution('singularity_plan'))
      assert.equal(codeOf(controller.checkGuard(execution('mcp__calc__echo', { message: 'hi' }))), undefined)

      const stopTool = definitions.get('singularity_stop')
      assert.ok(stopTool)
      await stopTool.execute({ reason: 'blocked', message: 'stop MCP guard' }, execution('singularity_stop'))
      assert.equal(codeOf(controller.checkGuard(execution('mcp__calc__echo', { message: 'hi' }))), 'RUN_CLOSED')
      assert.equal(codeOf(controller.checkGuard(execution('list_mcp_resources', { server: 'calc' }))), 'RUN_CLOSED')

      await writeFile(join(workspace, 'out.txt'), 'x', 'utf8')
      const submittedDefinitions = new Map<string, ToolDefinition>()
      const submittedController = new RunToolController({
        contract,
        runId: 'mcp-guard-run',
        sessionId: 'mcp-guard-session',
        workspace,
        skillNames: [],
        mcpPlan: {
          serverNames: ['calc'],
          publicToolNames: ['mcp__calc__echo'],
          resourceToolNames: ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'],
        },
        writer: store,
        maxOutputBytes: 1024,
        clock: () => 1000,
        budget: () => ({ tokensPct: 100, stepsPct: 100, wallClockPct: 100, depthPct: 100, taskSlotsPct: 100 }),
        checkBudget: () => true,
        epoch: () => contextEpoch,
        commitSubmission: frozen => Promise.resolve(frozen.manifestRef),
      })
      submittedController.register({ get: () => ({ list: () => [] }), tools: {
        register: (definition: ToolDefinition) => {
          submittedDefinitions.set(definition.name, definition)
          return () => undefined
        },
        guard() {},
      } } as unknown as Context, agent)
      const submittedRead = submittedDefinitions.get('singularity_read')
      const submittedPlan = submittedDefinitions.get('singularity_plan')
      assert.ok(submittedRead && submittedPlan)
      let submittedCursor: string | undefined
      do {
        const page = await submittedRead.execute(
          { kind: 'self', ...(submittedCursor === undefined ? {} : { cursor: submittedCursor }) },
          execution('singularity_read'),
        ) as { readonly nextCursor?: string }
        submittedCursor = page.nextCursor
      } while (submittedCursor !== undefined)
      await submittedPlan.execute({ sketch: {
        v: 1,
        taskId: contract.taskId,
        runId: 'mcp-guard-run',
        contextEpoch,
        objective: 'exercise MCP submitted guard',
        sourceContract: contract.digest,
        levels: [0, 1].map(level => ({
          level, purpose: 'current level', likelyChildren: [], expectedInputs: [], expectedOutputs: [],
        })),
        directPlan: [],
        assumptions: [],
      } }, execution('singularity_plan'))
      const submitTool = submittedDefinitions.get('singularity_submit')
      assert.ok(submitTool)
      await submitTool.execute(
        { outputIds: ['out'], includeLearningDrafts: false },
        execution('singularity_submit'),
      )
      assert.equal(codeOf(submittedController.checkGuard(execution('mcp__calc__echo', { message: 'hi' }))), 'ALREADY_SUBMITTED')
    })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

void test('tool dispatch uses the exact host budget check while preserving read and stop', async () => {
  await withStore(async store => {
    const contract = makeContract(['领域约束'.repeat(4096)])
    const contextEpoch = initialContextEpoch('session-guard')
    const definitions = new Map<string, ToolDefinition>()
    const jobs: JobView[] = []
    let allowed = true
    const controller = new RunToolController({
      contract,
      runId: 'run-guard',
      sessionId: 'session-guard',
      workspace: '/workspace',
      skillNames: [],
      mcpPlan: { serverNames: [], publicToolNames: [], resourceToolNames: [] },
      writer: store,
      maxOutputBytes: 1024,
      clock: () => contract.limits.deadlineAt + 1,
      budget: () => ({ tokensPct: null, stepsPct: 0, wallClockPct: 0, depthPct: 100, taskSlotsPct: 100 }),
      checkBudget: () => allowed,
      epoch: () => contextEpoch,
      commitSubmission: frozen => Promise.resolve(frozen.manifestRef),
    })
    const agent = { session: { id: 'session-guard', snapshotEvents: () => [] } } as unknown as Agent
    controller.register({ get: () => ({ list: () => jobs }), tools: {
      register: (definition: ToolDefinition) => definitions.set(definition.name, definition),
      guard() {},
    } } as unknown as Context, agent)
    const callId = 'guard-call' as ToolRunContext['callId']
    const execution = (name: string): ToolRunContext => ({
      name, agent, arguments: {}, callId, rootCallId: callId,
      token: Symbol() as ToolRunContext['token'], signal: new AbortController().signal,
      deferContext() {}, concludeTurn() {},
    })
    const readTool = definitions.get('singularity_read')
    const planTool = definitions.get('singularity_plan')
    assert.ok(readTool && planTool)
    const assertSubmissionGate = (expected: string | undefined) => {
      const refusal = controller.checkGuard(execution('singularity_submit'))
      assert.equal(refusal === undefined ? undefined : (JSON.parse(refusal) as { code: string }).code, expected)
      assert.equal(controller.obligations().canSubmit, expected === undefined)
      assert.deepEqual(controller.obligations().denialCodes, expected === undefined ? [] : [expected])
    }
    assertSubmissionGate('READ_SELF_FIRST')
    const pages: string[] = []
    let cursor: string | undefined
    do {
      const page = await readTool.execute({ kind: 'self', ...(cursor === undefined ? {} : { cursor }) }, execution('singularity_read')) as {
        readonly data: string
        readonly nextCursor?: string
      }
      assert.ok(new TextEncoder().encode(JSON.stringify(page)).byteLength <= 16 * 1024)
      assert.equal(typeof page.data, 'string')
      pages.push(page.data)
      cursor = page.nextCursor
      if (pages.length === 1 && cursor !== undefined) {
        await assert.rejects(readTool.execute({ kind: 'self', cursor: `${cursor}0` }, execution('singularity_read')), /INVALID_ARGUMENT/)
        const repeated = await readTool.execute({ kind: 'self' }, execution('singularity_read')) as { readonly data: string }
        assert.equal(repeated.data, page.data, 're-reading a page must not advance coverage')
      }
      if (cursor !== undefined) assertSubmissionGate('READ_SELF_FIRST')
    } while (cursor !== undefined)
    assert.ok(pages.length > 1)
    assert.deepEqual((JSON.parse(pages.join('')) as { goal: { constraints: string[] } }).goal.constraints, contract.spec.goal.constraints)
    await assert.rejects(readTool.execute({ kind: 'self', cursor: 'unissued-cursor' }, execution('singularity_read')), /INVALID_ARGUMENT/)
    assertSubmissionGate('PLAN_FIRST')
    await planTool.execute({ sketch: {
      v: 1, taskId: contract.taskId, runId: 'run-guard', contextEpoch,
      objective: 'complete current task', sourceContract: contract.digest,
      levels: [0, 1].map(level => ({ level, purpose: 'current level', likelyChildren: [], expectedInputs: [], expectedOutputs: [] })),
      directPlan: [], assumptions: [],
    } }, execution('singularity_plan'))
    assertSubmissionGate(undefined)
    jobs.push({
      id: 'bash-active' as JobView['id'], kind: 'bash', label: 'writes output',
      owner: agent.session.id, status: 'running', startedAt: 0,
      output: { total: 0, earliest: 0 },
    })
    assertSubmissionGate('ACTIVE_JOB')
    jobs[0] = { ...jobs[0], status: 'stopping' }
    assertSubmissionGate('ACTIVE_JOB')
    jobs[0] = { ...jobs[0], status: 'completed' }
    assertSubmissionGate(undefined)
    assert.equal(controller.checkGuard(execution('bash')), undefined)
    allowed = false
    assertSubmissionGate('LIMIT_EXCEEDED')
    const refusal = controller.checkGuard(execution('bash'))
    assert.ok(refusal)
    assert.equal((JSON.parse(refusal) as { readonly code: string }).code, 'LIMIT_EXCEEDED')
    assert.equal(controller.checkGuard(execution('singularity_read')), undefined)
    assert.equal(controller.checkGuard(execution('singularity_stop')), undefined)
    const stopTool = definitions.get('singularity_stop')
    assert.ok(stopTool)
    await stopTool.execute({ reason: 'blocked', message: 'no further work' }, execution('singularity_stop'))
    assertSubmissionGate('RUN_CLOSED')
  })
})

void test('S4-B1 registers prepare-only decompose for empty child bindings and accepts duplicate directPlan', async () => {
  const contract = makeContract()
  await withStore(async store => {
    const contextEpoch = initialContextEpoch('b1-guard-session')
    const agent = { session: { id: 'b1-guard-session', snapshotEvents: () => [] } } as unknown as Agent
    const callId = 'b1-guard-call' as ToolRunContext['callId']
    const execution = (name: string, args: unknown = {}): ToolRunContext => ({
      name, agent, arguments: args, callId, rootCallId: callId,
      token: Symbol() as ToolRunContext['token'], signal: new AbortController().signal,
      deferContext() {}, concludeTurn() {},
    })
    const register = (controller: RunToolController): Map<string, ToolDefinition> => {
      const definitions = new Map<string, ToolDefinition>()
      controller.register({ get: () => ({ list: () => [] }), tools: {
        register: (definition: ToolDefinition) => {
          definitions.set(definition.name, definition)
          return () => undefined
        },
        guard() {},
      } } as unknown as Context, agent)
      return definitions
    }
    const resources = {
      method: { templates: [] },
      template: { children: [] },
      guidance: { id: 'guidance', digest: digestA },
      guidanceText: '',
      skills: [],
      mcpServers: [],
    } as unknown as FrozenMethodResources

    const noChild = new RunToolController({
      contract,
      runId: 'b1-no-child-run',
      sessionId: 'b1-guard-session',
      workspace: '/workspace',
      skillNames: [],
      mcpPlan: { serverNames: [], publicToolNames: [], resourceToolNames: [] },
      childBindingIds: [],
      decompose: { methodResources: resources, reader: store },
      writer: store,
      maxOutputBytes: 1024,
      clock: () => 1000,
      budget: () => ({ tokensPct: 100, stepsPct: 100, wallClockPct: 100, depthPct: 100, taskSlotsPct: 100 }),
      checkBudget: () => true,
      epoch: () => contextEpoch,
      commitSubmission: frozen => Promise.resolve(frozen.manifestRef),
    })
    const noChildTools = register(noChild)
    assert.ok(noChildTools.has('singularity_decompose'), 'prepare schema must stay discoverable without child bindings')
    assert.equal(noChild.obligations().canDecompose, false)
    const noChildGuard = noChild.checkGuard(execution('singularity_decompose', { action: 'prepare', bindingId: 'b1' }))
    assert.ok(noChildGuard)
    assert.equal((JSON.parse(noChildGuard) as { readonly code: string }).code, 'BINDING_FIXED')
    const noChildPrepare = noChildTools.get('singularity_decompose')
    assert.ok(noChildPrepare)
    await assert.rejects(
      noChildPrepare.execute({ action: 'prepare', bindingId: 'b1' }, execution('singularity_decompose')),
      /BINDING_FIXED/,
    )

    const planner = new RunToolController({
      contract,
      runId: 'b1-plan-run',
      sessionId: 'b1-guard-session',
      workspace: '/workspace',
      skillNames: [],
      mcpPlan: { serverNames: [], publicToolNames: [], resourceToolNames: [] },
      childBindingIds: ['b1'],
      writer: store,
      maxOutputBytes: 1024,
      clock: () => 1000,
      budget: () => ({ tokensPct: 100, stepsPct: 100, wallClockPct: 100, depthPct: 100, taskSlotsPct: 100 }),
      checkBudget: () => true,
      epoch: () => contextEpoch,
      commitSubmission: frozen => Promise.resolve(frozen.manifestRef),
    })
    const plannerTools = register(planner)
    const readTool = plannerTools.get('singularity_read')
    const planTool = plannerTools.get('singularity_plan')
    assert.ok(readTool && planTool)
    let cursor: string | undefined
    do {
      const page = await readTool.execute(
        { kind: 'self', ...(cursor === undefined ? {} : { cursor }) },
        execution('singularity_read'),
      ) as { readonly nextCursor?: string }
      cursor = page.nextCursor
    } while (cursor !== undefined)
    const sketch = (directPlan: readonly { readonly bindingId: string; readonly purpose: string }[]) => ({
      v: 1,
      taskId: contract.taskId,
      runId: 'b1-plan-run',
      contextEpoch,
      objective: 'exercise directPlan visibility',
      sourceContract: contract.digest,
      levels: [0, 1].map(level => ({
        level, purpose: 'current level', likelyChildren: [], expectedInputs: [], expectedOutputs: [],
      })),
      directPlan,
      assumptions: [],
    })
    await planTool.execute({ sketch: sketch([
      { bindingId: 'b1', purpose: 'first attempt' },
      { bindingId: 'b1', purpose: 'later batch or replacement' },
    ]) }, execution('singularity_plan'))
    await assert.rejects(
      planTool.execute({ sketch: sketch([{ bindingId: 'missing', purpose: 'not visible' }]) }, execution('singularity_plan')),
      /BINDING_FIXED/,
    )
  })
})

void test('S4-B1 prepare is gated by self read and the current PlanningSketch', async () => {
  const contract = makeContract()
  await withStore(async store => {
    const contextEpoch = initialContextEpoch('b1-gate-session')
    const agent = { session: { id: 'b1-gate-session', snapshotEvents: () => [] } } as unknown as Agent
    const callId = 'b1-gate-call' as ToolRunContext['callId']
    const execution = (name: string, args: unknown = {}): ToolRunContext => ({
      name, agent, arguments: args, callId, rootCallId: callId,
      token: Symbol() as ToolRunContext['token'], signal: new AbortController().signal,
      deferContext() {}, concludeTurn() {},
    })
    const resources = {
      method: { templates: [] },
      template: { children: [] },
      guidance: { id: 'guidance', digest: digestA },
      guidanceText: '',
      skills: [],
      mcpServers: [],
    } as unknown as FrozenMethodResources
    const definitions = new Map<string, ToolDefinition>()
    const controller = new RunToolController({
      contract,
      runId: 'b1-gate-run',
      sessionId: 'b1-gate-session',
      workspace: '/workspace',
      skillNames: [],
      mcpPlan: { serverNames: [], publicToolNames: [], resourceToolNames: [] },
      childBindingIds: ['b1'],
      decompose: { methodResources: resources, reader: store },
      writer: store,
      maxOutputBytes: 1024,
      clock: () => 1000,
      budget: () => ({ tokensPct: 100, stepsPct: 100, wallClockPct: 100, depthPct: 100, taskSlotsPct: 100 }),
      checkBudget: () => true,
      epoch: () => contextEpoch,
      commitSubmission: frozen => Promise.resolve(frozen.manifestRef),
    })
    controller.register({ get: () => ({ list: () => [] }), tools: {
      register: (definition: ToolDefinition) => {
        definitions.set(definition.name, definition)
        return () => undefined
      },
      guard() {},
    } } as unknown as Context, agent)
    const prepare = definitions.get('singularity_decompose')
    const read = definitions.get('singularity_read')
    assert.ok(prepare && read)
    const codeOf = (value: string | undefined): string | undefined => value === undefined
      ? undefined
      : (JSON.parse(value) as { readonly code: string }).code
    assert.equal(codeOf(controller.checkGuard(execution('singularity_decompose', { action: 'prepare', bindingId: 'b1' }))), 'READ_SELF_FIRST')
    await assert.rejects(
      prepare.execute({ action: 'prepare', bindingId: 'b1' }, execution('singularity_decompose')),
      /READ_SELF_FIRST/,
    )
    let cursor: string | undefined
    do {
      const page = await read.execute(
        { kind: 'self', ...(cursor === undefined ? {} : { cursor }) },
        execution('singularity_read'),
      ) as { readonly nextCursor?: string }
      cursor = page.nextCursor
    } while (cursor !== undefined)
    assert.equal(codeOf(controller.checkGuard(execution('singularity_decompose', { action: 'prepare', bindingId: 'b1' }))), 'PLAN_FIRST')
    await assert.rejects(
      prepare.execute({ action: 'prepare', bindingId: 'b1' }, execution('singularity_decompose')),
      /PLAN_FIRST/,
    )
  })
})
