import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'

import {
  computeCommandDigest,
  computeDigestBytes,
  canonicalize,
  projectCommandFacts,
  replayJournal,
  verifyFact,
} from '@singularity/protocol'
import type { FactActor, NormalizedCommand, Ref } from '@singularity/protocol'
import { CommandService, DomainStore } from '../src/index.ts'

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

async function openService(t: TestContext, root: string): Promise<CommandService> {
  const service = await CommandService.open({ root, actor, clock })
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
      objects: [{ id: conflictRef.id, bytes: conflictBytes }],
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

void test('commit writes referenced CAS objects before returning the journal fact', async t => {
  const root = await temporaryRoot(t)
  const service = await openService(t, root)
  const command = makeCommand('command-with-object')
  const bytes = encoder.encode('seed object raw bytes')
  const ref: Ref = { id: 'seed-object', digest: computeDigestBytes('object', bytes) }

  const fact = await service.commit({
    command,
    type: 'rsi/round-closed',
    data: {
      roundId: 'round-with-object',
      outcome: 'cancelled',
      reason: 'command service object ordering',
      comparisonRef: ref,
    },
    objects: [{ id: ref.id, bytes }],
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
