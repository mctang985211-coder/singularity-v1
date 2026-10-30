import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import {
  admitRootTask,
  computeCommandDigest,
  computeDigest,
  computeDigestBytes,
  canonicalize,
  projectCommandFacts,
  replayJournal,
  seal,
  sealFact,
  sealMethodRevision,
  sealPublicReceipt,
  sealSubmissionManifest,
  validatePublicReceipt,
  validateSubmissionManifest,
  verifyFact,
} from '@singularity/protocol'
import type {
  CompositionPayload,
  Fact,
  FactActor,
  FactPayloadMap,
  FactType,
  JsonValue,
  NormalizedCommand,
  PublicReceipt,
  Ref,
  SubmissionManifest,
  TaskContract,
} from '@singularity/protocol'
import { CommandService, DomainStore, JOURNAL_FILENAME } from '../src/index.ts'
import { resumeSingleRun } from '../src/recovery.ts'
import { buildEvidence } from '../src/verification.ts'
import type { CasDigestDomain } from '../src/store.ts'

const actor = { kind: 'operator', id: 'operator-command-test' } satisfies FactActor
const now = 1_800_000_000_000
const clock = (): number => now
const encoder = new TextEncoder()

function makeCommand(commandId: string, goal = commandId): NormalizedCommand {
  return {
    v: 1,
    commandId,
    tool: 'singularity_task',
    toolVersion: 1,
    actor,
    scope: {},
    input: { goal },
  }
}

function cancelledRound(commandId: string): {
  readonly roundId: string
  readonly outcome: 'cancelled'
  readonly reason: string
} {
  return {
    roundId: `round-${commandId}`,
    outcome: 'cancelled',
    reason: 'command service test',
  }
}

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-command-service-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return root
}

async function openStore(t: TestContext, root: string): Promise<DomainStore> {
  const store = await DomainStore.open({ root })
  t.after(async () => {
    await store.close()
  })
  return store
}

async function openService(
  t: TestContext,
  root: string,
  serviceClock: () => number = clock,
): Promise<CommandService> {
  const service = await CommandService.open({ root, actor, clock: serviceClock })
  t.after(async () => {
    await service.close()
  })
  return service
}

async function listFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)))
    } else if (entry.isFile()) {
      files.push(path)
    }
  }
  return files
}

async function findJournal(root: string, firstLine: string): Promise<string> {
  for (const file of await listFiles(root)) {
    const content = await readFile(file, 'utf8')
    if (content === `${firstLine}\n` || content.startsWith(`${firstLine}\n`)) return file
  }
  throw new Error('journal file was not found under the store root')
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalize(value as JsonValue))
}

function replayCommand(commandId: string, input: JsonValue): NormalizedCommand {
  return {
    v: 1,
    commandId,
    tool: 'singularity_replay_evidence',
    toolVersion: 1,
    actor,
    scope: {},
    input,
  }
}

interface CommitInput<Type extends FactType> {
  readonly command: NormalizedCommand
  readonly type: Type
  readonly data: FactPayloadMap[Type]
}

interface CommittedCommand {
  readonly fact: Fact
  readonly command: NormalizedCommand
  replay(service: CommandService): Promise<Fact>
}

async function commitCommand<Type extends FactType>(
  service: CommandService,
  input: CommitInput<Type>,
): Promise<CommittedCommand> {
  const fact = await service.commit(input)
  return {
    fact,
    command: input.command,
    replay: replayService => replayService.commit(input),
  }
}

interface RunScene {
  readonly taskId: string
  readonly runId: string
  readonly sessionId: string
  readonly contract: TaskContract
  readonly contractRef: Ref
  readonly composition: CompositionPayload
  readonly compositionRef: Ref
  readonly acceptance: Ref
  readonly inputRef: Ref
  readonly outputRefs: readonly [Ref, Ref]
  readonly criterionId: string
  readonly manifest: SubmissionManifest
  readonly manifestRef: Ref
  readonly receipt: PublicReceipt
  readonly receiptRef: Ref
  readonly evidenceRef: Ref
  readonly submitted: CommittedCommand
  readonly submittedData: FactPayloadMap['run/submitted']
  readonly facts: readonly Fact[]
  readonly commands: readonly CommittedCommand[]
}

/**
 * Builds one complete committed Run over the real FS journal and CAS:
 * task/admitted, run/opened, run/submitted with a frozen manifest and output
 * objects, run/closed with a public receipt and Evidence, and task/closed.
 */
async function buildRunScene(
  service: CommandService,
  ids: {
    readonly taskId: string
    readonly runId: string
    readonly sessionId: string
  },
): Promise<RunScene> {
  const { taskId, runId, sessionId } = ids
  const put = (
    id: string,
    value: unknown,
    domain: CasDigestDomain = 'object',
  ): Promise<Ref> => service.putObject(id, jsonBytes(value), domain)

  const acceptance = await put(`${taskId}:acceptance`, { v: 1, policy: 'fixture-acceptance' })
  const guidance = await put(`${taskId}:guidance`, { v: 1, text: 'Produce both declared outputs.' })
  const example = await put(`${taskId}:example`, { v: 1, goal: 'fixture example' })
  const acceptancePolicy = await put(`${taskId}:acceptance-policy`, { v: 1, kind: 'fixture-policy' })
  const request = await put(`${taskId}:request`, { v: 1, request: taskId })
  const inputBytes = encoder.encode(`frozen input for ${taskId}\n`)
  const inputRef = await service.putObject(`${taskId}:input`, inputBytes)
  const seed = await put(`${taskId}:seed`, { v: 1, seed: taskId })
  const profile = await put(`${taskId}:profile`, { v: 1, profile: 'fixture' })

  const method = sealMethodRevision({
    v: 1,
    id: `${taskId}:method`,
    entryTemplateId: `${taskId}:template`,
    templates: [{
      id: `${taskId}:template`,
      brief: 'Produce two declared files.',
      guidance,
      example,
      instanceSchema: {},
      requiredCriteria: [],
      requiredOutputs: [],
      acceptancePolicy,
      skills: [],
      tools: [],
      children: [],
    }],
    skills: [],
    tools: [],
  })
  const methodRef: Ref = { id: method.id, digest: method.digest }
  const criterionId = `${taskId}:criterion`

  const contract = admitRootTask({
    taskId,
    spec: {
      goal: {
        summary: 'Replay one complete committed Run.',
        deliverable: 'Two frozen output files.',
        scope: ['s3-c11'],
        constraints: [],
      },
      criteria: [{
        id: criterionId,
        statement: 'Both declared outputs match the frozen bytes.',
        required: true,
      }],
      inputs: [{
        id: 'source',
        object: inputRef,
        path: 'inputs/source.bin',
        access: 'read',
      }],
      outputs: [
        { id: 'first', path: 'out/first.txt', kind: 'file', role: 'deliverable', required: true },
        { id: 'second', path: 'out/second.txt', kind: 'file', role: 'deliverable', required: true },
      ],
    },
    origin: { kind: 'root', purpose: 'work', requestRef: request },
    method: methodRef,
    template: { id: `${taskId}:template`, digest: method.digest },
    resources: { baseTools: [], skills: [], mcpServers: [] },
    acceptance,
    environment: { seed, profile },
    limits: {
      maxRuns: 1,
      maxStepsPerRun: 4,
      maxTokens: 10_000,
      deadlineAt: now + 3_600_000,
      maxDepth: 1,
      maxTasks: 1,
      maxBatchChildren: 1,
    },
  })
  const contractRef: Ref = { id: contract.taskId, digest: contract.digest }

  const dshConfig = await put(`${taskId}:dsh-config`, { v: 1, profile: 'fixture' })
  const templateObject = await put(`${taskId}:composition-template`, {
    v: 1,
    template: `${taskId}:template`,
  })
  const modelRoute = await put(`${taskId}:model-route`, { v: 1, route: 'fixture' })
  const resources = await put(`${taskId}:resources`, { v: 1, resources: [] })
  const composition: CompositionPayload = {
    v: 1,
    dsh: { package: '@deepseek-ai/dsh', version: '0.2.2-alpha.2', config: dshConfig },
    platformPrompt: computeDigest('object', { platformPrompt: `${taskId}:platform` }),
    contract: contractRef,
    template: templateObject,
    skills: [],
    mcpServers: [],
    modelRoute,
    resources,
    seed,
  }
  const sealedComposition = seal('composition', composition)
  const compositionRef: Ref = { id: `${runId}:composition`, digest: sealedComposition.digest }

  const firstBytes = encoder.encode(`first frozen output for ${taskId}\n`)
  const secondBytes = encoder.encode(`second frozen output for ${taskId}\n`)
  const outputRefs: readonly [Ref, Ref] = [
    { id: `${runId}:output-first`, digest: computeDigestBytes('object', firstBytes) },
    { id: `${runId}:output-second`, digest: computeDigestBytes('object', secondBytes) },
  ]

  const manifest = sealSubmissionManifest({
    v: 1,
    taskId,
    runId,
    contractDigest: contract.digest,
    includeLearningDrafts: false,
    outputs: [
      {
        id: 'first',
        path: 'out/first.txt',
        kind: 'file',
        role: 'deliverable',
        required: true,
        object: outputRefs[0],
      },
      {
        id: 'second',
        path: 'out/second.txt',
        kind: 'file',
        role: 'deliverable',
        required: true,
        object: outputRefs[1],
      },
    ],
    learningDrafts: [],
    checks: [
      { outputId: 'first', bytes: firstBytes.byteLength, symlinks: 'none' },
      { outputId: 'second', bytes: secondBytes.byteLength, symlinks: 'none' },
    ],
  })
  const manifestRef: Ref = { id: `${runId}:submission`, digest: manifest.digest }

  const receipt = sealPublicReceipt({
    v: 1,
    provider: acceptance,
    operationId: `${runId}:verify`,
    contractDigest: contract.digest,
    inputDigests: [inputRef.digest],
    outputDigests: [outputRefs[0].digest, outputRefs[1].digest],
    criteria: [{ id: criterionId, verdict: 'pass', reason: 'fixture outputs frozen' }],
    exit: { code: 0, signal: null },
    timedOut: false,
  })
  const receiptRef: Ref = { id: `${runId}:receipt`, digest: receipt.digest }
  const usage = { inputTokens: 7, outputTokens: 3, steps: 1, unknownRequests: 0 }
  const sessionCut = { sessionId, from: 0, to: 2 }
  const evidence = buildEvidence({
    contract,
    runId,
    composition: compositionRef,
    outputs: outputRefs,
    receipt,
    receiptRef,
    usage,
    sessionCut,
    environmentMode: 'workspace',
  })
  const evidenceRef: Ref = { id: `${runId}:evidence`, digest: evidence.digest }

  const sketchBytes = jsonBytes({
    v: 1,
    taskId,
    runId,
    contextEpoch: 'epoch',
    objective: 'submit',
    levels: [],
    directPlan: [],
    assumptions: [],
    sourceContract: contract.digest,
  })
  const sketchRef: Ref = {
    id: `${runId}:planning-sketch`,
    digest: computeDigestBytes('object', sketchBytes),
  }

  const commands: CommittedCommand[] = []
  await put(methodRef.id, method, 'method')
  await put(contractRef.id, contract, 'contract')
  commands.push(await commitCommand(service, {
    command: replayCommand(`task:${taskId}:admitted`, { taskId }),
    type: 'task/admitted',
    data: { taskId, contract: contractRef },
  }))
  await put(compositionRef.id, sealedComposition, 'composition')
  commands.push(await commitCommand(service, {
    command: replayCommand(`run:${runId}:opened`, { taskId, runId, sessionId }),
    type: 'run/opened',
    data: {
      taskId,
      runId,
      attempt: 1,
      sessionId,
      composition: compositionRef,
      workspaceKey: runId,
      workspaceSeed: seed,
      budgetReservation: {
        tokens: 1000,
        steps: 2,
        deadlineAt: contract.limits.deadlineAt,
      },
    },
  }))

  const submittedData: FactPayloadMap['run/submitted'] = {
    runId,
    outputs: manifestRef,
    transcriptOffset: { sessionId, seq: 2 },
    previewReceipts: [],
    readReceipts: [],
    planningSketchRef: sketchRef,
    feedbackRefs: [],
  }
  await service.putObject(outputRefs[0].id, firstBytes)
  await service.putObject(outputRefs[1].id, secondBytes)
  await service.putObject(sketchRef.id, sketchBytes)
  await put(manifestRef.id, manifest)
  const submitted = await commitCommand(service, {
    command: replayCommand(`run:${runId}:submitted`, {
      runId,
      outputs: [outputRefs[0].digest, outputRefs[1].digest],
    }),
    type: 'run/submitted',
    data: submittedData,
  })
  commands.push(submitted)
  await put(receiptRef.id, receipt)
  await put(evidenceRef.id, evidence, 'evidence')
  commands.push(await commitCommand(service, {
    command: replayCommand(`run:${runId}:closed`, { runId, evidence: evidenceRef.digest }),
    type: 'run/closed',
    data: {
      runId,
      classification: 'verified',
      reason: 'all required criteria passed',
      evidenceRef,
      usage,
      feedbackRefs: [],
    },
  }))
  commands.push(await commitCommand(service, {
    command: replayCommand(`task:${taskId}:closed`, { taskId, outcome: 'verified' }),
    type: 'task/closed',
    data: {
      taskId,
      outcome: 'verified',
      reason: 'root verified',
      decisiveRunId: runId,
      evidenceRefs: [evidenceRef],
    },
  }))

  return {
    taskId,
    runId,
    sessionId,
    contract,
    contractRef,
    composition,
    compositionRef,
    acceptance,
    inputRef,
    outputRefs,
    criterionId,
    manifest,
    manifestRef,
    receipt,
    receiptRef,
    evidenceRef,
    submitted,
    submittedData,
    facts: commands.map(command => command.fact),
    commands,
  }
}

function receiptExpectation(scene: RunScene) {
  return {
    provider: scene.acceptance,
    operationId: `${scene.runId}:verify`,
    contractDigest: scene.contract.digest,
    inputDigests: [scene.inputRef.digest],
    outputDigests: scene.outputRefs.map(ref => ref.digest),
    requiredCriteria: [scene.criterionId],
  }
}

async function snapshotCas(objectsPath: string): Promise<ReadonlyMap<string, string>> {
  const snapshot = new Map<string, string>()
  for (const file of await listFiles(objectsPath)) {
    const info = await stat(file, { bigint: true })
    const bytes = await readFile(file)
    snapshot.set(
      file.slice(objectsPath.length + 1),
      `${String(info.size)}:${String(info.mtimeNs)}:${bytes.toString('hex')}`,
    )
  }
  return snapshot
}

void test('same command after restart returns the original fact and does not grow the journal', async t => {
  const root = await temporaryRoot(t)
  const firstService = await openService(t, root)
  const command = makeCommand('command-idempotent')

  const fact = await firstService.commit({
    command,
    type: 'rsi/round-closed',
    data: cancelledRound(command.commandId),
  })

  assert.equal(fact.seq, 0)
  assert.equal(fact.prev, null)
  assert.equal(fact.commandId, command.commandId)
  assert.equal(fact.commandDigest, computeCommandDigest(command))
  assert.equal(fact.actor.kind, actor.kind)
  assert.equal(fact.actor.id, actor.id)
  assert.equal(fact.at, now)
  assert.equal(verifyFact(fact), true)

  const journal = await findJournal(root, canonicalize(fact))
  const journalBefore = await readFile(journal, 'utf8')
  const sizeBefore = (await stat(journal)).size

  await firstService.close()
  const restarted = await openService(t, root)
  const replayed = await restarted.commit({
    command,
    type: 'rsi/round-closed',
    data: cancelledRound(command.commandId),
  })

  assert.deepEqual(replayed, fact)
  assert.equal((await stat(journal)).size, sizeBefore)
  assert.equal(await readFile(journal, 'utf8'), journalBefore)
  assert.deepEqual(await (await openStore(t, root)).replay(), [fact])

  const nextCommand = makeCommand('command-after-restart')
  const next = await restarted.commit({
    command: nextCommand,
    type: 'rsi/round-closed',
    data: cancelledRound(nextCommand.commandId),
  })
  assert.equal(next.seq, 1)
  assert.equal(next.prev, fact.digest)
  assert.deepEqual(await (await openStore(t, root)).replay(), [fact, next])
})

void test('same commandId with a different payload conflicts without side effects', async t => {
  const root = await temporaryRoot(t)
  const service = await openService(t, root)
  const command = makeCommand('command-conflict', 'original goal')

  const fact = await service.commit({
    command,
    type: 'rsi/round-closed',
    data: cancelledRound(command.commandId),
  })
  const journal = await findJournal(root, canonicalize(fact))
  const journalBefore = await readFile(journal, 'utf8')
  const sizeBefore = (await stat(journal)).size

  const conflicting = makeCommand('command-conflict', 'different goal')
  assert.notEqual(computeCommandDigest(conflicting), fact.commandDigest)

  const conflictBytes = encoder.encode('must not be written on conflict')
  const conflictRef: Ref = {
    id: 'conflict-object',
    digest: computeDigestBytes('object', conflictBytes),
  }
  await assert.rejects(
    service.commit({
      command: conflicting,
      type: 'task/admitted',
      data: { taskId: 'task-conflict', contract: conflictRef },
    }),
    (error: unknown) => errorCode(error) === 'IDEMPOTENCY_CONFLICT',
  )

  assert.equal((await stat(journal)).size, sizeBefore)
  assert.equal(await readFile(journal, 'utf8'), journalBefore)
  const inspector = await openStore(t, root)
  assert.deepEqual(await inspector.replay(), [fact])
  await assert.rejects(inspector.readObject(conflictRef))

  const nextCommand = makeCommand('command-after-conflict')
  const next = await service.commit({
    command: nextCommand,
    type: 'rsi/round-closed',
    data: cancelledRound(nextCommand.commandId),
  })
  assert.equal(next.seq, 1)
  assert.equal(next.prev, fact.digest)
})

void test('twenty concurrent commits serialize seq, prev, and unique commandIds', async t => {
  const root = await temporaryRoot(t)
  const service = await openService(t, root)
  const commands = Array.from({ length: 20 }, (_, index) =>
    makeCommand(`command-concurrent-${String(index)}`, `goal-${String(index)}`),
  )

  const returned = await Promise.all(
    commands.map(command =>
      service.commit({
        command,
        type: 'rsi/round-closed',
        data: cancelledRound(command.commandId),
      }),
    ),
  )
  const ordered = [...returned].sort((left, right) => left.seq - right.seq)

  assert.deepEqual(
    ordered.map(fact => fact.seq),
    Array.from({ length: 20 }, (_, index) => index),
  )
  assert.equal(ordered[0].prev, null)
  for (let index = 1; index < ordered.length; index += 1) {
    assert.equal(ordered[index].prev, ordered[index - 1].digest)
    assert.equal(verifyFact(ordered[index]), true)
  }
  assert.equal(new Set(ordered.map(fact => fact.commandId)).size, 20)
  assert.deepEqual(
    new Set(ordered.map(fact => fact.commandId)),
    new Set(commands.map(command => command.commandId)),
  )
  for (const fact of ordered) {
    const command = commands.find(candidate => candidate.commandId === fact.commandId)
    assert.ok(command !== undefined)
    assert.equal(fact.commandDigest, computeCommandDigest(command))
  }

  const store = await openStore(t, root)
  const replay = await store.replay()
  assert.deepEqual(replay, ordered)

  const projection = projectCommandFacts(replay)
  assert.equal(projection.size, 20)
  for (const fact of ordered) {
    const entry = projection.get(fact.commandId)
    assert.ok(entry !== undefined)
    assert.equal(entry.commandDigest, fact.commandDigest)
    assert.equal(entry.seq, fact.seq)
    assert.equal(entry.factDigest, fact.digest)
    assert.deepEqual(entry.fact, fact)
  }

  const journal = await findJournal(root, canonicalize(ordered[0]))
  const source = await readFile(journal, 'utf8')
  assert.equal(source.endsWith('\n'), true)
  assert.equal(source.split('\n').length, 21)

  const rawReplay = replayJournal(source)
  assert.equal(rawReplay.tornTail, '')
  assert.deepEqual(rawReplay.facts, replay)
  assert.deepEqual(rawReplay.facts, ordered)
})

void test('putObject writes the supporting CAS object before the commit fact', async t => {
  const root = await temporaryRoot(t)
  const service = await openService(t, root)
  const command = makeCommand('command-with-object')
  const bytes = encoder.encode('seed object raw bytes')
  const ref: Ref = { id: 'seed-object', digest: computeDigestBytes('object', bytes) }

  assert.deepEqual(await service.putObject(ref.id, bytes), ref)
  const fact = await service.commit({
    command,
    type: 'rsi/round-closed',
    data: {
      roundId: 'round-with-object',
      outcome: 'cancelled',
      reason: 'command service object ordering',
      comparisonRef: ref,
    },
  })

  const store = await openStore(t, root)
  assert.deepEqual((await store.readObject(ref)).bytes, bytes)
  assert.deepEqual(await store.replay(), [fact])

  const journal = await findJournal(root, canonicalize(fact))
  let storedObject: string | undefined
  for (const file of await listFiles(root)) {
    if ((await readFile(file)).equals(bytes)) {
      storedObject = file
      break
    }
  }
  assert.ok(storedObject !== undefined)

  const objectStat = await stat(storedObject, { bigint: true })
  const journalStat = await stat(journal, { bigint: true })
  assert.ok(
    objectStat.mtimeNs <= journalStat.mtimeNs,
    'CAS object must be written before the fact append',
  )
})

void test('an orphan CAS object neither replays nor blocks a command with the same id', async t => {
  const root = await temporaryRoot(t)
  const service = await openService(t, root)
  const store = await openStore(t, root)
  const bytes = encoder.encode('orphan command object')
  const orphan = await store.putObject('command-orphan', bytes)

  assert.deepEqual(await store.readObject(orphan), { bytes })
  assert.deepEqual(await store.replay(), [])
  assert.equal(projectCommandFacts(await store.replay()).size, 0)

  const command = makeCommand('command-orphan')
  const fact = await service.commit({
    command,
    type: 'rsi/round-closed',
    data: cancelledRound(command.commandId),
  })

  assert.equal(fact.seq, 0)
  assert.equal(fact.prev, null)
  const replay = await (await openStore(t, root)).replay()
  assert.deepEqual(replay, [fact])
  const projection = projectCommandFacts(replay)
  assert.equal(projection.size, 1)
  assert.deepEqual(projection.get('command-orphan')?.fact, fact)
})

void test('a complete committed Run replays its original facts and refs through torn tail and closed resume', async t => {
  const root = await temporaryRoot(t)
  const journalPath = join(root, JOURNAL_FILENAME)
  const service = await openService(t, root)
  const scene = await buildRunScene(service, {
    taskId: 'task-replay-complete',
    runId: 'run-replay-complete',
    sessionId: 'session-replay-complete',
  })

  assert.deepEqual(
    scene.facts.map(fact => fact.type),
    ['task/admitted', 'run/opened', 'run/submitted', 'run/closed', 'task/closed'],
  )
  for (const [index, fact] of scene.facts.entries()) {
    assert.equal(fact.seq, index)
    assert.equal(fact.prev, index === 0 ? null : scene.facts[index - 1].digest)
    assert.equal(verifyFact(fact), true)
  }
  assert.equal(
    validateSubmissionManifest(scene.manifest, {
      contract: scene.contract,
      runId: scene.runId,
    }).valid,
    true,
  )
  assert.equal(validatePublicReceipt(scene.receipt, receiptExpectation(scene)).verdict, 'verified')

  const journalBefore = await readFile(journalPath)
  const journalText = journalBefore.toString('utf8')
  const committedReplay = replayJournal(journalText)
  assert.equal(committedReplay.tornTail, '')
  assert.deepEqual(committedReplay.facts, scene.facts)

  await service.close()

  const inspector = await DomainStore.open({ root })
  const casBefore = await snapshotCas(inspector.objectsPath)
  assert.deepEqual(await inspector.replay(), scene.facts)
  await inspector.close()

  const uncommittedCommand = replayCommand(`run:${scene.runId}:uncommitted`, {
    runId: scene.runId,
    uncommitted: true,
  })
  const uncommittedFact = sealFact({
    v: 1,
    seq: scene.facts.length,
    commandId: uncommittedCommand.commandId,
    commandDigest: computeCommandDigest(uncommittedCommand),
    type: 'rsi/round-closed',
    actor,
    at: now + 1,
    data: {
      roundId: 'round-torn-tail',
      outcome: 'cancelled',
      reason: 'torn tail fixture',
    },
    prev: scene.facts.at(-1)?.digest ?? null,
  })
  const tornTail = canonicalize(uncommittedFact)
  await appendFile(journalPath, tornTail, 'utf8')

  const reopened = await DomainStore.open({ root })
  assert.equal(reopened.tornTail(), tornTail)
  assert.deepEqual(await reopened.replay(), scene.facts)
  assert.deepEqual(await snapshotCas(reopened.objectsPath), casBefore)
  await reopened.close()
  assert.deepEqual(await readFile(journalPath), journalBefore)

  const replayService = await openService(t, root, () => {
    throw new Error('idempotent replay must not read the clock')
  })
  for (const committed of scene.commands) {
    assert.deepEqual(await committed.replay(replayService), committed.fact)
  }
  assert.deepEqual(
    await replayService.commit({
      command: scene.submitted.command,
      type: 'run/submitted',
      data: scene.submittedData,
    }),
    scene.submitted.fact,
  )
  await replayService.close()
  assert.deepEqual(await readFile(journalPath), journalBefore)

  const afterReplay = await DomainStore.open({ root })
  assert.deepEqual(await snapshotCas(afterReplay.objectsPath), casBefore)
  const replayedFacts = await afterReplay.replay()
  assert.deepEqual(replayedFacts, scene.facts)
  await afterReplay.close()

  const projection = projectCommandFacts(replayedFacts)
  assert.equal(projection.size, scene.commands.length)
  const replayedSubmitted = replayedFacts.find(
    (fact): fact is Extract<Fact, { readonly type: 'run/submitted' }> =>
      fact.type === 'run/submitted',
  )
  assert.ok(replayedSubmitted !== undefined)
  assert.deepEqual(replayedSubmitted.data.outputs, scene.manifestRef)
  const replayedClosed = replayedFacts.find(
    (fact): fact is Extract<Fact, { readonly type: 'run/closed' }> =>
      fact.type === 'run/closed',
  )
  assert.ok(replayedClosed !== undefined)
  if (!('evidenceRef' in replayedClosed.data)) {
    throw new Error('closed Run must carry Evidence')
  }
  assert.deepEqual(replayedClosed.data.evidenceRef, scene.evidenceRef)

  let verifierCalls = 0
  const resumed = await resumeSingleRun({
    ctx: {} as Context,
    journalRoot: root,
    workspace: root,
    runId: scene.runId,
    composition: scene.composition,
    agentOptions: {
      provider: 'fixture-provider',
      model: 'fixture-model',
    } as AgentOptions,
    maxOutputBytes: 1024,
    verifier: {
      provider: scene.acceptance,
      verify() {
        verifierCalls += 1
        return Promise.reject(new Error('closed Run resume must not verify'))
      },
    },
    actor,
    clock: () => now + 1_000,
  })
  assert.equal(resumed.classification, 'verified')
  assert.equal(resumed.compositionMatched, true)
  assert.equal(resumed.sessionAction, 'none')
  assert.equal(resumed.recoveredSubmission, false)
  assert.equal(verifierCalls, 0)
  assert.deepEqual(resumed.manifestRef, scene.manifestRef)
  assert.deepEqual(resumed.receiptRef, scene.receiptRef)
  assert.deepEqual(resumed.evidenceRef, scene.evidenceRef)
  assert.deepEqual(resumed.runFact, scene.facts[3])
  assert.deepEqual(resumed.taskFact, scene.facts[4])
  assert.deepEqual(resumed.facts, scene.facts)
  assert.deepEqual(await readFile(journalPath), journalBefore)

  const afterResume = await DomainStore.open({ root })
  assert.deepEqual(await snapshotCas(afterResume.objectsPath), casBefore)
  await afterResume.close()

  const trailingCommand = replayCommand(`run:${scene.runId}:trailing`, {
    runId: scene.runId,
    trailing: true,
  })
  const trailingFact = sealFact({
    v: 1,
    seq: scene.facts.length,
    commandId: trailingCommand.commandId,
    commandDigest: computeCommandDigest(trailingCommand),
    type: 'rsi/round-closed',
    actor,
    at: now + 2,
    data: {
      roundId: 'round-middle-corruption',
      outcome: 'cancelled',
      reason: 'middle corruption fixture',
    },
    prev: scene.facts.at(-1)?.digest ?? null,
  })
  const corrupted = `${journalText}{"not":"a fact"}\n${canonicalize(trailingFact)}\n`
  await writeFile(journalPath, corrupted, 'utf8')
  await assert.rejects(
    DomainStore.open({ root }),
    (error: unknown) => errorCode(error) === 'JOURNAL_INVALID_FACT',
  )
  assert.equal(await readFile(journalPath, 'utf8'), corrupted)
})

void test('different output order or refs change manifest/receipt/command identity and are rejected', async t => {
  const root = await temporaryRoot(t)
  const journalPath = join(root, JOURNAL_FILENAME)
  const service = await openService(t, root)
  const scene = await buildRunScene(service, {
    taskId: 'task-identity-negative',
    runId: 'run-identity-negative',
    sessionId: 'session-identity-negative',
  })

  const manifestBody = { ...scene.manifest } as Record<string, unknown>
  delete manifestBody['digest']
  const manifestOutputs = manifestBody['outputs'] as readonly Record<string, unknown>[]
  const manifestChecks = manifestBody['checks'] as readonly Record<string, unknown>[]
  const reversedManifest = sealSubmissionManifest({
    ...manifestBody,
    outputs: [manifestOutputs[1], manifestOutputs[0]],
    checks: [manifestChecks[1], manifestChecks[0]],
  })
  assert.notEqual(reversedManifest.digest, scene.manifest.digest)
  const reversedValidation = validateSubmissionManifest(reversedManifest, {
    contract: scene.contract,
    runId: scene.runId,
  })
  assert.equal(reversedValidation.valid, false)

  const receiptBody = { ...scene.receipt } as Record<string, unknown>
  delete receiptBody['digest']
  const reversedReceipt = sealPublicReceipt({
    ...receiptBody,
    outputDigests: [...(receiptBody['outputDigests'] as readonly string[])].reverse(),
  })
  assert.notEqual(reversedReceipt.digest, scene.receipt.digest)
  assert.equal(validatePublicReceipt(reversedReceipt, receiptExpectation(scene)).verdict, 'invalid')

  const alternateBytes = encoder.encode('alternate second output bytes\n')
  const alternateRef: Ref = {
    id: `${scene.runId}:alternate-second`,
    digest: computeDigestBytes('object', alternateBytes),
  }
  const replacedManifest = sealSubmissionManifest({
    ...manifestBody,
    outputs: [
      manifestOutputs[0],
      { ...manifestOutputs[1], object: alternateRef },
    ],
    checks: [
      manifestChecks[0],
      { ...manifestChecks[1], bytes: alternateBytes.byteLength },
    ],
  })
  assert.notEqual(replacedManifest.digest, scene.manifest.digest)
  assert.equal(
    validateSubmissionManifest(replacedManifest, {
      contract: scene.contract,
      runId: scene.runId,
    }).valid,
    true,
  )
  assert.equal(
    validatePublicReceipt(scene.receipt, {
      ...receiptExpectation(scene),
      outputDigests: [scene.outputRefs[0].digest, alternateRef.digest],
    }).verdict,
    'invalid',
  )

  const beforeStore = await DomainStore.open({ root })
  const journalBefore = await readFile(journalPath)
  const casBefore = await snapshotCas(beforeStore.objectsPath)
  await beforeStore.close()

  await service.close()
  const restarted = await openService(t, root)

  const conflicting = {
    ...scene.submitted.command,
    input: {
      runId: scene.runId,
      outputs: [scene.outputRefs[1].digest, scene.outputRefs[0].digest],
    },
  }
  assert.notEqual(computeCommandDigest(conflicting), scene.submitted.fact.commandDigest)
  await assert.rejects(
    restarted.commit({
      command: conflicting,
      type: 'run/submitted',
      data: scene.submittedData,
    }),
    (error: unknown) => errorCode(error) === 'IDEMPOTENCY_CONFLICT',
  )
  assert.deepEqual(await readFile(journalPath), journalBefore)

  const afterStore = await DomainStore.open({ root })
  try {
    assert.deepEqual(await snapshotCas(afterStore.objectsPath), casBefore)
    assert.deepEqual(afterStore.facts(), scene.facts)
  } finally {
    await afterStore.close()
  }
})
