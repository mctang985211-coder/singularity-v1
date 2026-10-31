import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  canonicalize,
  computeDigest,
  computeDigestBytes,
  evidenceSchema,
  parseProtocolValue,
  seal,
  sealFact,
  sealMethodRevision,
  sealSubmissionManifest,
  sealEvidence,
  sealPublicReceipt,
  sealTaskContract,
} from '@singularity/protocol'
import type {
  Digest,
  Fact,
  FactActor,
  FactPayloadMap,
  FactType,
  MethodRevision,
  NormalizedCommand,
  Ref,
  UnsealedFact,
} from '@singularity/protocol'

import {
  CAS_DIGEST_DOMAINS,
  CommandService,
  DomainStore,
  JOURNAL_FILENAME,
} from '../src/index.ts'
import type { CasDigestDomain } from '../src/index.ts'

const encoder = new TextEncoder()
const digestA: Digest = `sha256:${'a'.repeat(64)}`
const digestB: Digest = `sha256:${'b'.repeat(64)}`
const actor: FactActor = { kind: 'runtime', id: 'runtime-reference-test' }
const at = 1_800_000_000_000

const limits = {
  maxRuns: 2,
  maxStepsPerRun: 10,
  maxTokens: 10_000,
  deadlineAt: at + 1_000_000,
  maxDepth: 2,
  maxTasks: 4,
  maxBatchChildren: 2,
}

const usage = {
  inputTokens: 1,
  outputTokens: 2,
  steps: 1,
  unknownRequests: 0,
}

const sessionCut = { sessionId: 'session-1', from: 0, to: 1 }

function ref(id: string, digest: Digest = digestA): Ref {
  return { id, digest }
}

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-cas-refs-'))
  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function errorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return error.code
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(errorCode(error), code, `expected ${code}, got ${String(errorCode(error))}`)
    return true
  })
}

async function putRaw(
  store: DomainStore,
  id: string,
  domain: CasDigestDomain = 'object',
): Promise<Ref> {
  const bytes = encoder.encode(`raw:${domain}:${id}\n`)
  return store.putObject(id, bytes, domain)
}

async function putSealed(
  store: DomainStore,
  id: string,
  domain: CasDigestDomain,
  value: unknown,
): Promise<Ref> {
  return store.putObject(id, encoder.encode(canonicalize(value)), domain)
}

async function putTree(
  store: DomainStore,
  id: string,
  files: readonly { readonly path: string; readonly content: string }[],
): Promise<Ref> {
  const entries = []
  for (const file of files) {
    const bytes = encoder.encode(file.content)
    entries.push({
      path: file.path,
      bytes: bytes.byteLength,
      object: await store.putObject(`${id}:file:${file.path}`, bytes, 'object'),
    })
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return putSealed(store, id, 'object', seal('object', { v: 1, kind: 'tree', files: entries }))
}

async function firstTreeLeaf(store: DomainStore, treeRef: Ref): Promise<Ref> {
  const bytes = (await store.readObject(treeRef, 'object')).bytes
  const value = JSON.parse(new TextDecoder().decode(bytes)) as {
    readonly files?: readonly { readonly object?: Ref }[]
  }
  const leaf = value.files?.[0]?.object
  assert.ok(leaf)
  return leaf
}

interface Graph {
  readonly facts: readonly Fact[]
  readonly methodRef: Ref
  readonly parentMethodRef: Ref
  readonly contractRef: Ref
  readonly compositionRef: Ref
  readonly executionRef: Ref
  readonly guidanceRef: Ref
  readonly compositionConfigRef: Ref
  readonly executionInputRef: Ref
  readonly acceptanceRef: Ref
  readonly evidenceRef: Ref
  readonly publicReceiptRef: Ref
  readonly privateReceiptRef: Ref
  readonly manifestOutputRef: Ref
  readonly evidenceOutputRef: Ref
  readonly methodSkillBundleRef: Ref
  readonly methodToolBundleRef: Ref
  readonly methodToolSourceRef: Ref
  readonly contractSkillBundleRef: Ref
  readonly contractMcpBundleRef: Ref
  readonly compositionSkillBundleRef: Ref
  readonly compositionMcpBundleRef: Ref
}

/**
 * Builds one real 14-fact journal covering all 13 closed fact types (with both
 * run/closed variants) plus a fully nested method, contract, composition, and
 * execution record. All referenced CAS objects are written first.
 */
async function buildGraph(store: DomainStore): Promise<Graph> {
  const objectRef = (id: string): Promise<Ref> => putRaw(store, id)
  const requestRef = await objectRef('request-root')
  const inputObjectRef = await objectRef('input-object')
  const toolRef = await objectRef('resource-tool')
  const resourceSkillRef = await putTree(store, 'resource-skill', [{ path: 'SKILL.md', content: '# resource skill\n' }])
  const resourceMcpRef = await putTree(store, 'resource-mcp', [{ path: 'server.js', content: '// resource mcp\n' }])
  const explorationRef = await objectRef('resource-exploration')
  const seedRef = await objectRef('environment-seed')
  const profileRef = await objectRef('environment-profile')
  const guidanceRef = await objectRef('method-guidance')
  const exampleRef = await objectRef('method-example')
  const acceptancePolicyRef = await objectRef('template-acceptance-policy')
  const skillBundleRef = await putTree(store, 'method-skill-bundle', [{ path: 'SKILL.md', content: '# method skill\n' }])
  const toolBundleRef = await putTree(store, 'method-tool-bundle', [{ path: 'server.js', content: '// method mcp\n' }])
  const toolManifestRef = await objectRef('method-tool-manifest')
  const toolSourceRef = await putTree(store, 'method-tool-source', [{ path: 'server.js', content: '// method mcp\n' }])
  const toolConfigRef = await objectRef('method-tool-config')

  const parentMethod = sealMethodRevision({
    v: 1,
    id: 'method-parent',
    templates: [],
    skills: [],
    tools: [],
  })
  const parentMethodRef = await putSealed(store, 'method-parent', 'method', parentMethod)

  const method: MethodRevision = sealMethodRevision({
    v: 1,
    id: 'method-rich',
    parent: parentMethodRef,
    templates: [
      {
        id: 'template-root',
        brief: 'Use all nested references',
        guidance: guidanceRef,
        example: exampleRef,
        instanceSchema: { type: 'object', additionalProperties: false },
        requiredCriteria: [],
        requiredOutputs: [],
        acceptancePolicy: acceptancePolicyRef,
        skills: [],
        tools: [],
        children: [],
      },
    ],
    skills: [
      { id: 'skill-1', name: 'Skill', description: 'Nested skill', bundle: skillBundleRef },
    ],
    tools: [
      {
        id: 'tool-1',
        name: 'Tool',
        description: 'Nested MCP server',
        kind: 'mcp-server',
        server: {
          bundle: toolBundleRef,
          manifest: toolManifestRef,
          sourceFiles: toolSourceRef,
          config: toolConfigRef,
          transport: 'stdio',
          capabilities: [],
          exposedTools: [],
        },
      },
    ],
  })
  const methodRef = await putSealed(store, 'method-rich', 'method', method)

  const acceptanceRef = await objectRef('acceptance-policy')
  const contractPayload = {
    v: 1 as const,
    taskId: 'task-root',
    spec: {
      goal: {
        summary: 'Reference validation',
        deliverable: 'One frozen fact graph',
        scope: ['cas-reference-validation'],
        constraints: ['no business reducer'],
      },
      criteria: [],
      inputs: [{ id: 'input-1', object: inputObjectRef, path: 'inputs/in', access: 'read' as const }],
      outputs: [],
    },
    origin: { kind: 'root' as const, purpose: 'work' as const, requestRef },
    method: methodRef,
    template: { id: 'template-root', digest: methodRef.digest },
    resources: {
      baseTools: [toolRef],
      skills: [resourceSkillRef],
      mcpServers: [resourceMcpRef],
      exploration: explorationRef,
    },
    acceptance: acceptanceRef,
    environment: { seed: seedRef, profile: profileRef },
    limits,
  }
  const contract = sealTaskContract(contractPayload)
  const contractRef = await putSealed(store, 'contract-root', 'contract', contract)

  const childContract = sealTaskContract({
    ...contractPayload,
    taskId: 'task-child',
    origin: {
      kind: 'child',
      parentId: 'task-root',
      parentRunId: 'run-1',
      batchId: 'batch-1',
      bindingId: 'binding-1',
    },
  })

  const compositionConfigRef = await objectRef('composition-dsh-config')
  const compositionTemplateRef = await objectRef('composition-template-object')
  const compositionGuidanceRef = await objectRef('composition-guidance')
  const compositionSkillRef = await putTree(store, 'composition-skill', [{ path: 'SKILL.md', content: '# composition skill\n' }])
  const compositionMcpManifestRef = await objectRef('composition-mcp-manifest')
  const compositionMcpBundleRef = await putTree(store, 'composition-mcp-bundle', [{ path: 'server.js', content: '// composition mcp\n' }])
  const compositionMcpSchemaRef = await objectRef('composition-mcp-schema')
  const compositionMcpConfigRef = await objectRef('composition-mcp-config')
  const compositionModelRouteRef = await objectRef('composition-model-route')
  const compositionResourcesRef = await objectRef('composition-resources')
  const compositionSeedRef = await objectRef('composition-seed')

  const composition = seal('composition', {
    v: 1,
    dsh: { package: 'dsh', version: '0.2.2-alpha.2', config: compositionConfigRef },
    platformPrompt: digestA,
    contract: contractRef,
    template: compositionTemplateRef,
    guidance: compositionGuidanceRef,
    skills: [compositionSkillRef],
    mcpServers: [
      {
        manifest: compositionMcpManifestRef,
        bundle: compositionMcpBundleRef,
        schema: compositionMcpSchemaRef,
        config: compositionMcpConfigRef,
        transport: 'stdio',
        capabilities: [],
      },
    ],
    modelRoute: compositionModelRouteRef,
    resources: compositionResourcesRef,
    seed: compositionSeedRef,
  })
  const compositionRef = await putSealed(store, 'composition-1', 'composition', composition)

  const executionInputRef = await objectRef('execution-input')
  const executionOutputRef = await objectRef('execution-output')
  const execution = seal('object', {
    v: 1,
    taskId: 'task-root',
    runId: 'run-2',
    contractDigest: contract.digest,
    method: methodRef,
    composition: compositionRef,
    inputs: [executionInputRef],
    outputs: [executionOutputRef],
    usage,
    sessionCut,
    reason: 'stop',
  })
  const executionRef = await putSealed(store, 'execution-1', 'object', execution)

  const manifestOutputRef = await objectRef('manifest-output')
  const evidenceOutputRef = await objectRef('evidence-output')
  const publicReceipt = sealPublicReceipt({
    v: 1, provider: acceptanceRef, operationId: 'run-1:verify',
    contractDigest: contract.digest, inputDigests: [inputObjectRef.digest],
    outputDigests: [evidenceOutputRef.digest], criteria: [],
    exit: { code: 0, signal: null }, timedOut: false,
  })
  const publicReceiptRef = await putSealed(store, 'receipt-1', 'object', publicReceipt)
  const privateReceiptRef = await objectRef('private-receipt')
  const evidence = sealEvidence({
    v: 1, task: { id: contract.taskId, digest: contract.digest }, runId: 'run-1',
    contractDigest: contract.digest, method: methodRef, inputs: [inputObjectRef],
    outputs: [evidenceOutputRef], composition: compositionRef,
    verification: { provider: acceptanceRef, operationId: 'run-1:verify', publicReceipt: publicReceiptRef, privateReceipt: privateReceiptRef },
    usage, sessionCut, environment: { seed: seedRef.digest, mode: 'test' },
  })
  const evidenceRef = await putSealed(store, 'evidence-1', 'evidence', evidence)
  const roundPlanRef = await putRaw(store, 'round-plan-1', 'round-plan')
  const traceRef = await putRaw(store, 'trace-1')
  const sourceTraceRef = await putRaw(store, 'source-trace-1')
  const patchRef = await putRaw(store, 'patch-1')
  const precheckRef = await putRaw(store, 'precheck-1')
  const comparisonRef = await putRaw(store, 'comparison-1')
  const sketchRef = await putRaw(store, 'sketch-1')
  const feedbackRef = await putRaw(store, 'feedback-1')
  const outputManifestRef = await putSealed(store, 'outputs-manifest', 'object', sealSubmissionManifest({
    v: 1, taskId: contract.taskId, runId: 'run-1', contractDigest: contract.digest,
    includeLearningDrafts: false,
    outputs: [{ id: 'output', path: 'out.txt', kind: 'file', role: 'deliverable', required: false, object: manifestOutputRef }],
    learningDrafts: [], checks: [{ outputId: 'output', bytes: 1, symlinks: 'none' }],
  }))
  const previewReceiptRef = await putRaw(store, 'preview-receipt')
  const readReceiptRef = await putRaw(store, 'read-receipt')
  const approvalRef = await putRaw(store, 'method-approval')
  const evaluationRef = await putRaw(store, 'method-evaluation')
  const proposalSourceRef = await putRaw(store, 'method-source-proposal')
  const cutRef = await putRaw(store, 'cancellation-cut')

  const facts: Fact[] = []
  async function append<Type extends FactType>(
    type: Type,
    data: FactPayloadMap[Type],
  ): Promise<Fact> {
    const unsealed = {
      v: 1,
      seq: facts.length,
      commandId: `command-${String(facts.length)}`,
      commandDigest: digestA,
      type,
      actor,
      at: at + facts.length,
      data,
      prev: facts.at(-1)?.digest ?? null,
    } as UnsealedFact
    const fact = await store.appendFact(unsealed)
    facts.push(fact)
    return fact
  }

  await append('method/registered', {
    revision: methodRef,
    parent: parentMethodRef,
    sourceProposal: proposalSourceRef,
  })
  await append('method/activated', {
    expectedPrevious: parentMethodRef,
    previous: parentMethodRef,
    next: methodRef,
    approval: approvalRef,
    evaluationRef,
  })
  await append('task/admitted', {
    taskId: 'task-root',
    contract: contractRef,
  })
  await append('run/opened', {
    taskId: 'task-root',
    runId: 'run-1',
    attempt: 1,
    sessionId: 'session-1',
    composition: compositionRef,
    workspaceKey: 'workspace-root',
    workspaceSeed: compositionSeedRef,
    budgetReservation: { tokens: 100, steps: 1, deadlineAt: limits.deadlineAt },
  })
  await append('task/children-admitted', {
    parentRunId: 'run-1',
    batchId: 'batch-1',
    children: [
      {
        contract: childContract,
        join: 'required',
        budgetReservation: { tokens: 10, steps: 1, deadlineAt: limits.deadlineAt },
        replacement: { feedbackRef, supersedesChildIds: ['task-old'] },
      },
    ],
  })
  await append('run/submitted', {
    runId: 'run-1',
    outputs: outputManifestRef,
    transcriptOffset: { sessionId: 'session-1', seq: 1 },
    previewReceipts: [previewReceiptRef],
    readReceipts: [readReceiptRef],
    planningSketchRef: sketchRef,
    feedbackRefs: [feedbackRef],
  })
  await append('run/closed', {
    runId: 'run-1',
    classification: 'verified',
    reason: 'evidence closure',
    evidenceRef,
    usage,
    planningSketchRef: sketchRef,
    feedbackRefs: [feedbackRef],
  })
  await append('run/closed', {
    runId: 'run-2',
    classification: 'invalid',
    reason: 'execution record closure',
    executionRecordRef: executionRef,
    usage,
    feedbackRefs: [feedbackRef],
  })
  await append('task/closed', {
    taskId: 'task-root',
    outcome: 'verified',
    reason: 'closed',
    decisiveRunId: 'run-1',
    evidenceRefs: [evidenceRef],
    cancellationCutRef: cutRef,
  })
  await append('rsi/trace-sealed', {
    rootTaskId: 'task-root',
    trace: traceRef,
    usage,
    sessionCuts: [sessionCut],
  })
  await append('rsi/round-opened', {
    roundId: 'round-1',
    sourceTrace: sourceTraceRef,
    baseMethod: methodRef,
    plan: roundPlanRef,
    proposerSessionId: 'session-2',
  })
  await append('rsi/proposal-submitted', { roundId: 'round-1', patch: patchRef })
  await append('rsi/candidate-ready', {
    roundId: 'round-1',
    patch: patchRef,
    precheckReceipt: precheckRef,
    candidateMethod: methodRef,
  })
  await append('rsi/round-closed', {
    roundId: 'round-1',
    outcome: 'improved',
    comparisonRef,
    precheckReceipt: precheckRef,
    reason: 'improved',
  })

  await store.putObject('orphan-object', encoder.encode('orphan'), 'object')
  await access(join(store.root, JOURNAL_FILENAME))

  return {
    facts,
    methodRef,
    parentMethodRef,
    contractRef,
    compositionRef,
    executionRef,
    guidanceRef,
    compositionConfigRef,
    executionInputRef,
    acceptanceRef,
    evidenceRef,
    publicReceiptRef,
    privateReceiptRef,
    manifestOutputRef,
    evidenceOutputRef,
    methodSkillBundleRef: skillBundleRef,
    methodToolBundleRef: toolBundleRef,
    methodToolSourceRef: toolSourceRef,
    contractSkillBundleRef: resourceSkillRef,
    contractMcpBundleRef: resourceMcpRef,
    compositionSkillBundleRef: compositionSkillRef,
    compositionMcpBundleRef: compositionMcpBundleRef,
  }
}

void test('every CAS digest domain round-trips and rejects wrong domain, tampering, and absence', async () => {
  await withRoot(async (root) => {
    const store = await DomainStore.open({ root })
    try {
      for (const domain of CAS_DIGEST_DOMAINS) {
        const bytes = encoder.encode(`raw bytes for ${domain}\n`)
        const objectRef = await store.putObject(`object-${domain}`, bytes, domain)
        assert.equal(objectRef.id, `object-${domain}`)
        assert.equal(objectRef.digest, computeDigestBytes(domain, bytes))
        assert.deepEqual((await store.readObject(objectRef, domain)).bytes, bytes)

        const wrongDomain: CasDigestDomain = domain === 'object' ? 'contract' : 'object'
        await rejectsWithCode(store.readObject(objectRef, wrongDomain), 'OBJECT_DOMAIN_MISMATCH')
      }

      await rejectsWithCode(
        store.readObject({ id: 'missing', digest: digestB }, 'object'),
        'OBJECT_MISSING',
      )

      const tamperedBytes = encoder.encode('tamper this object')
      const tamperedRef = await store.putObject('tampered', tamperedBytes, 'object')
      await writeFile(store.objectPath(tamperedRef.digest), encoder.encode('different bytes'))
      await rejectsWithCode(store.readObject(tamperedRef, 'object'), 'OBJECT_CORRUPT')

      await rejectsWithCode(
        store.readObject(tamperedRef, 'fact' as CasDigestDomain),
        'INVALID_ARGUMENT',
      )
    } finally {
      await store.close()
    }
  })
})

void test('sealed structured objects use their self digest under the requested CAS domain', async () => {
  await withRoot(async (root) => {
    const store = await DomainStore.open({ root })
    try {
      const method = sealMethodRevision({
        v: 1,
        id: 'method-sealed',
        templates: [],
        skills: [],
        tools: [],
      })
      const methodBytes = encoder.encode(canonicalize(method))
      const methodRef = await store.putObject('method-sealed', methodBytes, 'method')
      assert.equal(methodRef.digest, method.digest)
      assert.deepEqual((await store.readObject(methodRef, 'method')).bytes, methodBytes)
      await rejectsWithCode(store.readObject(methodRef, 'contract'), 'OBJECT_DOMAIN_MISMATCH')

      const execution = seal('object', {
        v: 1,
        taskId: 'task-sealed',
        runId: 'run-sealed',
        contractDigest: digestA,
        method: ref('method-sealed', method.digest),
        composition: ref('composition-sealed', digestB),
        inputs: [],
        usage,
        sessionCut,
        reason: 'sealed',
      })
      const executionBytes = encoder.encode(canonicalize(execution))
      const executionRef = await store.putObject('execution-sealed', executionBytes, 'object')
      assert.equal(executionRef.digest, execution.digest)
      assert.deepEqual((await store.readObject(executionRef, 'object')).bytes, executionBytes)
      await rejectsWithCode(store.readObject(executionRef, 'evidence'), 'OBJECT_DOMAIN_MISMATCH')
    } finally {
      await store.close()
    }
  })
})

void test('replay validates all 13 fact types, nested refs, acceptance domain, and orphan tolerance', async () => {
  await withRoot(async (root) => {
    const store = await DomainStore.open({ root })
    const graph = await buildGraph(store)
    try {
      assert.deepEqual(await store.replay(), graph.facts)
      await access(store.objectPath(graph.acceptanceRef.digest))
      await putRaw(store, 'orphan-object')
    } finally {
      await store.close()
    }

    const reopened = await DomainStore.open({ root })
    try {
      const replay = await reopened.replay()
      assert.deepEqual(replay, graph.facts)
      assert.equal(new Set(replay.map((fact) => fact.type)).size, 13)
      assert.equal(replay.length, 14)
    } finally {
      await reopened.close()
    }
  })
})

void test('nested method, contract, composition, and execution refs reject missing objects at startup', async () => {
  const scenarios = [
    { name: 'method template guidance', select: (graph: Graph) => graph.guidanceRef },
    { name: 'composition dsh config', select: (graph: Graph) => graph.compositionConfigRef },
    { name: 'execution input', select: (graph: Graph) => graph.executionInputRef },
    { name: 'contract acceptance', select: (graph: Graph) => graph.acceptanceRef },
  ] as const

  for (const scenario of scenarios) {
    await withRoot(async (root) => {
      const store = await DomainStore.open({ root })
      const graph = await buildGraph(store)
      const target = scenario.select(graph)
      await store.close()
      await unlink(store.objectPath(target.digest))
      await assert.rejects(DomainStore.open({ root }), (error: unknown) => {
        assert.equal(errorCode(error), 'OBJECT_MISSING', `${scenario.name} must reject`)
        return true
      })
    })
  }
})

void test('nested Method/Composition tree file refs reject missing leaves at startup', async () => {
  const scenarios = [
    { name: 'method skill leaf', select: (graph: Graph) => graph.methodSkillBundleRef },
    { name: 'method MCP bundle leaf', select: (graph: Graph) => graph.methodToolBundleRef },
    { name: 'method MCP sourceFiles leaf', select: (graph: Graph) => graph.methodToolSourceRef },
    { name: 'contract skill leaf', select: (graph: Graph) => graph.contractSkillBundleRef },
    { name: 'contract MCP leaf', select: (graph: Graph) => graph.contractMcpBundleRef },
    { name: 'composition skill leaf', select: (graph: Graph) => graph.compositionSkillBundleRef },
    { name: 'composition MCP leaf', select: (graph: Graph) => graph.compositionMcpBundleRef },
  ] as const

  for (const scenario of scenarios) {
    await withRoot(async (root) => {
      const store = await DomainStore.open({ root })
      const graph = await buildGraph(store)
      const leaf = await firstTreeLeaf(store, scenario.select(graph))
      await store.close()
      await unlink(store.objectPath(leaf.digest))
      await assert.rejects(DomainStore.open({ root }), (error: unknown) => {
        assert.equal(errorCode(error), 'OBJECT_MISSING', `${scenario.name} must reject`)
        return true
      })
    })
  }
})

void test('a tampered referenced object rejects both replay and a fresh open', async () => {
  await withRoot(async (root) => {
    const store = await DomainStore.open({ root })
    const graph = await buildGraph(store)
    await writeFile(
      store.objectPath(graph.compositionConfigRef.digest),
      encoder.encode('tampered reference target'),
    )
    try {
      await rejectsWithCode(store.replay(), 'OBJECT_CORRUPT')
    } finally {
      await store.close()
    }
    await rejectsWithCode(DomainStore.open({ root }), 'OBJECT_CORRUPT')
  })
})

void test('a journal fact with a wrong-domain ref rejects startup', async () => {
  await withRoot(async (root) => {
    const store = await DomainStore.open({ root })
    const method = sealMethodRevision({
      v: 1,
      id: 'method-wrong-domain',
      templates: [],
      skills: [],
      tools: [],
    })
    const methodRef = await putSealed(store, 'method-wrong-domain', 'method', method)
    const fact = sealFact({
      v: 1,
      seq: 0,
      commandId: 'command-wrong-domain-journal',
      commandDigest: digestA,
      type: 'task/admitted',
      actor,
      at,
      data: { taskId: 'task-wrong-domain', contract: methodRef },
      prev: null,
    })
    await store.close()

    // Bypass appendFact to simulate a journal written by an older writer and
    // prove open/replay still rejects the wrong CAS domain.
    await writeFile(store.journalPath, `${canonicalize(fact)}\n`)
    await rejectsWithCode(DomainStore.open({ root }), 'OBJECT_DOMAIN_MISMATCH')
  })
})

void test('an empty journal remains valid and a wrong-domain memory ref does not create an object', async () => {
  await withRoot(async (root) => {
    const store = await DomainStore.open({ root })
    try {
      assert.deepEqual(await store.replay(), [])
      await rejectsWithCode(store.readObject(ref('never-stored', digestA), 'object'), 'OBJECT_MISSING')
      assert.equal(store.tornTail(), undefined)
    } finally {
      await store.close()
    }
  })
})

void test('CommandService putObject writes domain-tagged objects and restart replay validates them', async () => {
  await withRoot(async (root) => {
    const serviceActor: FactActor = { kind: 'operator', id: 'operator-service-reference' }
    const command: NormalizedCommand = {
      v: 1,
      commandId: 'command-domain-object',
      tool: 'singularity_reference_test',
      toolVersion: 1,
      actor: serviceActor,
      scope: {},
      input: { method: true },
    }
    const method = sealMethodRevision({ v: 1, id: 'method-domain-object', templates: [], skills: [], tools: [] })
    const bytes = encoder.encode(canonicalize(method))
    const methodRef: Ref = { id: method.id, digest: method.digest }

    const first = await CommandService.open({ root, actor: serviceActor, clock: () => at })
    try {
      assert.deepEqual(await first.putObject(methodRef.id, bytes, 'method'), methodRef)
      const fact = await first.commit({
        command,
        type: 'method/registered',
        data: { revision: methodRef },
      })
      assert.equal(fact.seq, 0)
    } finally {
      await first.close()
    }

    const restarted = await CommandService.open({ root, actor: serviceActor, clock: () => at })
    try {
      const replayed = await restarted.commit({
        command,
        type: 'method/registered',
        data: { revision: methodRef },
      })
      assert.equal(replayed.seq, 0)
    } finally {
      await restarted.close()
    }
  })
})

void test('commit rejects invalid refs before fsync without consuming seq and ignores CAS orphans', async () => {
  await withRoot(async (root) => {
    const serviceActor: FactActor = { kind: 'operator', id: 'operator-commit-reference' }
    const makeCommand = (commandId: string): NormalizedCommand => ({
      v: 1,
      commandId,
      tool: 'singularity_reference_test',
      toolVersion: 1,
      actor: serviceActor,
      scope: {},
      input: { commandId },
    })
    const journalPath = join(root, JOURNAL_FILENAME)
    const service = await CommandService.open({ root, actor: serviceActor, clock: () => at })
    const inspector = await DomainStore.open({ root })
    try {
      const first = await service.commit({
        command: makeCommand('command-valid-0'),
        type: 'rsi/round-closed',
        data: { roundId: 'round-valid-0', outcome: 'cancelled', reason: 'base' },
      })
      const journalBefore = await readFile(journalPath)
      const sizeBefore = (await stat(journalPath)).size

      const orphanBytes = encoder.encode('orphan written before failed commit')
      const orphanRef = await service.putObject('orphan-object', orphanBytes)
      const missingContract: Ref = { id: 'missing-contract', digest: digestB }
      await rejectsWithCode(
        service.commit({
          command: makeCommand('command-missing-ref'),
          type: 'task/admitted',
          data: { taskId: 'task-missing', contract: missingContract },
        }),
        'OBJECT_MISSING',
      )
      assert.deepEqual(await readFile(journalPath), journalBefore)
      assert.equal((await stat(journalPath)).size, sizeBefore)
      assert.equal(service.facts().length, 1)
      assert.deepEqual(await inspector.readObject(orphanRef), { bytes: orphanBytes })

      const wrongBytes = encoder.encode('wrong domain object')
      const wrongDigest = computeDigestBytes('evidence', wrongBytes)
      await service.putObject('wrong-domain', wrongBytes, 'evidence')
      await rejectsWithCode(
        service.commit({
          command: makeCommand('command-wrong-domain'),
          type: 'task/admitted',
          data: { taskId: 'task-wrong', contract: { id: 'wrong-domain', digest: wrongDigest } },
        }),
        'OBJECT_DOMAIN_MISMATCH',
      )
      assert.deepEqual(await readFile(journalPath), journalBefore)
      assert.equal(service.facts().length, 1)

      const corruptBytes = encoder.encode('original contract bytes')
      const corruptRef = await inspector.putObject('corrupt-contract', corruptBytes, 'contract')
      await writeFile(
        inspector.objectPath(corruptRef.digest),
        encoder.encode('tampered contract bytes'),
      )
      await rejectsWithCode(
        service.commit({
          command: makeCommand('command-corrupt-ref'),
          type: 'task/admitted',
          data: { taskId: 'task-corrupt', contract: corruptRef },
        }),
        'OBJECT_CORRUPT',
      )
      assert.deepEqual(await readFile(journalPath), journalBefore)
      assert.equal(service.facts().length, 1)

      const valid = await service.commit({
        command: makeCommand('command-valid-1'),
        type: 'rsi/round-closed',
        data: { roundId: 'round-valid-1', outcome: 'cancelled', reason: 'after failures' },
      })
      assert.equal(valid.seq, first.seq + 1)
      assert.equal(valid.prev, first.digest)
      assert.equal(service.facts().length, 2)
      assert.equal((await readFile(journalPath, 'utf8')).trimEnd().split('\n').length, 2)

      const replay = await inspector.replay()
      assert.deepEqual(replay, [first, valid])
      assert.deepEqual(
        (
          await inspector.readObject({
            id: 'orphan-object',
            digest: computeDigestBytes('object', orphanBytes),
          })
        ).bytes,
        orphanBytes,
      )
    } finally {
      await inspector.close()
      await service.close()
    }
  })
})

void test('fact helpers seal a verifiable chain before replay validation', () => {
  const fact = sealFact({
    v: 1,
    seq: 0,
    commandId: 'command-sealed',
    commandDigest: digestA,
    type: 'rsi/round-closed',
    actor,
    at,
    data: { roundId: 'round-sealed', outcome: 'cancelled', reason: 'sealed' },
    prev: null,
  })
  assert.equal(fact.digest, computeDigest('fact', fact))
})

void test('replay rejects a sealed manifest whose file or tree leaf is missing', async t => {
  for (const kind of ['file', 'tree'] as const) {
    await t.test(kind, async () => withRoot(async root => {
      const store = await DomainStore.open({ root })
      const nestedBytes = encoder.encode('nested output')
      const nestedRef = await store.putObject('nested-output', nestedBytes)
      const object = kind === 'file' ? nestedRef : await putSealed(store, 'tree-output', 'object', seal('object', {
        v: 1, kind: 'tree', files: [{ path: 'leaf.txt', bytes: nestedBytes.byteLength, object: nestedRef }],
    }))
    const manifest = sealSubmissionManifest({
      v: 1,
      taskId: 'task-nested-manifest',
      runId: 'run-nested-manifest',
      contractDigest: digestA,
      includeLearningDrafts: false,
      outputs: [{
        id: 'output-1', path: 'out.txt', kind, role: 'deliverable',
        required: false, object,
      }],
      learningDrafts: [],
      checks: [{ outputId: 'output-1', bytes: nestedBytes.byteLength, symlinks: 'none' }],
    })
    const manifestRef = await putSealed(store, 'nested-manifest', 'object', manifest)
    await store.appendFact({
      v: 1,
      seq: 0,
      commandId: 'command-nested-manifest',
      commandDigest: digestA,
      type: 'run/submitted',
      actor,
      at,
      data: {
        runId: 'run-nested-manifest', outputs: manifestRef,
        transcriptOffset: { sessionId: 'session-nested-manifest', seq: 0 },
        previewReceipts: [], readReceipts: [],
        planningSketchRef: await putRaw(store, 'nested-sketch'), feedbackRefs: [],
      },
      prev: null,
    })
    await store.close()
    await unlink(store.objectPath(nestedRef.digest))
    await rejectsWithCode(DomainStore.open({ root }), 'OBJECT_MISSING')
    }))
  }
})

void test('replay verifies Evidence outputs and public/private receipt refs', async t => {
  for (const key of ['evidenceOutputRef', 'publicReceiptRef', 'privateReceiptRef'] as const) {
    await t.test(key, async () => withRoot(async root => {
      const store = await DomainStore.open({ root })
      const graph = await buildGraph(store)
      await store.close()
      await unlink(store.objectPath(graph[key].digest))
      await rejectsWithCode(DomainStore.open({ root }), 'OBJECT_MISSING')
    }))
  }
})

void test('append and replay reject wrong-domain refs nested in Evidence and PublicReceipt', async t => {
  for (const kind of ['evidence-output', 'receipt-provider'] as const) {
    await t.test(kind, async () => withRoot(async root => {
      const store = await DomainStore.open({ root })
      try {
        const graph = await buildGraph(store)
        const evidence = parseProtocolValue(evidenceSchema,
          JSON.parse(new TextDecoder().decode((await store.readObject(graph.evidenceRef, 'evidence')).bytes)))
        let value = evidence
        const wrongRef = await putRaw(store, 'wrong-nested-domain', 'evidence')
        if (kind === 'evidence-output') {
          const body = { ...evidence }
          delete (body as { digest?: string }).digest
          value = sealEvidence({ ...body, outputs: [wrongRef] })
        } else {
          const receipt = sealPublicReceipt({
            v: 1, provider: wrongRef, operationId: 'run-1:verify', contractDigest: evidence.contractDigest,
            inputDigests: [], outputDigests: [], criteria: [], exit: { code: 0, signal: null }, timedOut: false,
          })
          const receiptRef = await putSealed(store, 'wrong-provider-receipt', 'object', receipt)
          const body = { ...evidence }
          delete (body as { digest?: string }).digest
          value = sealEvidence({ ...body, verification: { ...body.verification, publicReceipt: receiptRef } })
        }
        const valueRef = await putSealed(store, 'wrong-nested-evidence', 'evidence', value)
        const previous = graph.facts[graph.facts.length - 1]
        const fact = sealFact({
          v: 1, seq: graph.facts.length, commandId: `command-${kind}`, commandDigest: digestA,
          type: 'task/closed', actor, at, prev: previous.digest,
          data: { taskId: 'task-root', outcome: 'verified', reason: 'nested domain', evidenceRefs: [valueRef] },
        })
        const journalBefore = await readFile(store.journalPath)
        const unsealed = { ...fact }
        delete (unsealed as { digest?: string }).digest
        await rejectsWithCode(store.appendFact(unsealed), 'OBJECT_DOMAIN_MISMATCH')
        assert.deepEqual(await readFile(store.journalPath), journalBefore)
        await store.close()
        await writeFile(store.journalPath, `${journalBefore.toString()}${canonicalize(fact)}\n`)
        await rejectsWithCode(DomainStore.open({ root }), 'OBJECT_DOMAIN_MISMATCH')
      } finally {
        await store.close()
      }
    }))
  }
})
