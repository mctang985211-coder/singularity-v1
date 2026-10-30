import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  JournalError,
  canonicalize,
  computeCommandDigest,
  computeDigestBytes,
  verifyFact,
} from '@singularity/protocol'
import type {
  Digest,
  Fact,
  FactActor,
  FactPayloadMap,
  JsonValue,
  NormalizedCommand,
  Ref,
  UnsealedFact,
} from '@singularity/protocol'

import {
  CommandService,
  DomainStore,
  JOURNAL_FILENAME,
} from '../src/index.ts'

const digestA: Digest = `sha256:${'a'.repeat(64)}`
const digestB: Digest = `sha256:${'b'.repeat(64)}`
const actor: FactActor = { kind: 'operator', id: 'operator-1' }

const textEncoder = new TextEncoder()

function ref(id: string, digest: Digest = digestA): Ref {
  return { id, digest }
}

function normalized(commandId: string, input: JsonValue): NormalizedCommand {
  return {
    v: 1,
    commandId,
    tool: 'singularity_store_smoke',
    toolVersion: 1,
    actor,
    scope: {},
    input,
  }
}

type MethodRegisteredData = FactPayloadMap['method/registered']

function unsealedFact(args: {
  readonly seq: number
  readonly prev: Digest | null
  readonly commandId: string
  readonly data?: MethodRegisteredData
  readonly at?: number
}): UnsealedFact {
  return {
    v: 1,
    seq: args.seq,
    commandId: args.commandId,
    commandDigest: computeCommandDigest(normalized(args.commandId, { commandId: args.commandId })),
    type: 'method/registered',
    actor,
    at: args.at ?? 1_800_000_000_000 + args.seq,
    data: args.data ?? { revision: ref(`method-${args.commandId}`) },
    prev: args.prev,
  }
}

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-s3a-store-'))
  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function withStore<T>(run: (store: DomainStore, root: string) => Promise<T>): Promise<T> {
  return withRoot(async (root) => {
    const store = await DomainStore.open({ root })
    try {
      return await run(store, root)
    } finally {
      await store.close()
    }
  })
}

function errorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return error.code
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(errorCode(error), code)
    return true
  })
}

void test('CAS stores raw bytes by digest, verifies reads, and rejects corruption', async () => {
  await withStore(async (store) => {
    const bytes = textEncoder.encode('raw-object-bytes\n')
    const objectRef = await store.putObject('object-1', bytes)

    assert.equal(objectRef.id, 'object-1')
    assert.equal(objectRef.digest, computeDigestBytes('object', bytes))
    assert.equal(
      store.objectPath(objectRef.digest),
      join(store.objectsPath, objectRef.digest.slice('sha256:'.length)),
    )
    assert.deepEqual(new Uint8Array(await readFile(store.objectPath(objectRef.digest))), bytes)
    assert.deepEqual(await readdir(store.objectsPath), [
      objectRef.digest.slice('sha256:'.length),
    ])

    const read = await store.readObject(objectRef)
    assert.deepEqual(read.bytes, bytes)

    const deduplicated = await store.putObject('object-2', bytes)
    assert.equal(deduplicated.digest, objectRef.digest)
    assert.deepEqual(await readdir(store.objectsPath), [
      objectRef.digest.slice('sha256:'.length),
    ])

    await writeFile(store.objectPath(objectRef.digest), textEncoder.encode('tampered'))
    await rejectsWithCode(store.readObject(objectRef), 'OBJECT_CORRUPT')
    await rejectsWithCode(store.readObject({ id: 'missing', digest: digestB }), 'OBJECT_MISSING')
    await rejectsWithCode(store.putObject('', bytes), 'INVALID_ARGUMENT')
  })
})

void test('appendFact seals a strict seq/prev chain as one fsynced LF line', async () => {
  await withStore(async (store) => {
    const first = await store.appendFact(
      unsealedFact({ seq: 0, prev: null, commandId: 'command-0' }),
    )

    assert.equal(first.seq, 0)
    assert.equal(first.prev, null)
    assert.equal(first.commandId, 'command-0')
    assert.equal(verifyFact(first), true)

    const committed = await readFile(store.journalPath)
    assert.equal(committed.at(-1), 0x0a)
    assert.equal(committed.toString('utf8'), `${canonicalize(first)}\n`)
    assert.deepEqual(await store.replay(), [first])
    assert.equal(store.tornTail(), undefined)

    const beforeRejectedAppends = await readFile(store.journalPath)
    await rejectsWithCode(
      store.appendFact(
        unsealedFact({ seq: 2, prev: first.digest, commandId: 'command-2' }),
      ),
      'JOURNAL_SEQ_MISMATCH',
    )
    await rejectsWithCode(
      store.appendFact(unsealedFact({ seq: 1, prev: null, commandId: 'command-1' })),
      'JOURNAL_PREV_MISMATCH',
    )
    await rejectsWithCode(
      store.appendFact(
        unsealedFact({ seq: 1, prev: first.digest, commandId: 'command-0' }),
      ),
      'JOURNAL_COMMAND_ID_DUPLICATE',
    )
    assert.deepEqual(await readFile(store.journalPath), beforeRejectedAppends)

    const second = await store.appendFact(
      unsealedFact({ seq: 1, prev: first.digest, commandId: 'command-1' }),
    )
    assert.equal(second.prev, first.digest)
    assert.deepEqual(await store.replay(), [first, second])
  })
})

void test('open truncates only an unterminated EOF tail, including complete JSON and split UTF-8', async () => {
  await withRoot(async (root) => {
    const initial = await DomainStore.open({ root })
    const first = await initial.appendFact(
      unsealedFact({ seq: 0, prev: null, commandId: 'command-0' }),
    )
    await initial.close()

    const committed = await readFile(initial.journalPath)
    const next = unsealedFact({ seq: 1, prev: first.digest, commandId: 'command-1' })
    const completeJsonWithoutLf = canonicalize(next)
    const tornBytes = Buffer.concat([
      Buffer.from(completeJsonWithoutLf, 'utf8'),
      Buffer.from([0xe2, 0x82]),
    ])
    await writeFile(initial.journalPath, Buffer.concat([committed, tornBytes]))

    const reopened = await DomainStore.open({ root })
    let second: Fact
    try {
      assert.deepEqual(await reopened.replay(), [first])
      assert.equal(reopened.tornTail(), `${completeJsonWithoutLf}\uFFFD`)
      assert.deepEqual(await readFile(reopened.journalPath), committed)

      second = await reopened.appendFact(next)
      assert.equal(second.seq, 1)
      assert.deepEqual(await reopened.replay(), [first, second])
    } finally {
      await reopened.close()
    }

    const final = await DomainStore.open({ root })
    try {
      assert.equal(final.tornTail(), undefined)
      assert.deepEqual(await final.replay(), [first, second])
    } finally {
      await final.close()
    }
  })
})

void test('open rejects middle corruption instead of skipping or truncating it', async () => {
  await withRoot(async (root) => {
    const initial = await DomainStore.open({ root })
    const first = await initial.appendFact(
      unsealedFact({ seq: 0, prev: null, commandId: 'command-0' }),
    )
    await initial.close()
    const committed = await readFile(initial.journalPath)

    await writeFile(initial.journalPath, Buffer.concat([committed, Buffer.from('not-json\n')]))
    const corruptLength = (await readFile(initial.journalPath)).length
    await assert.rejects(DomainStore.open({ root }), (error: unknown) => {
      assert.ok(error instanceof JournalError)
      assert.equal(error.code, 'JOURNAL_INVALID_JSON')
      assert.equal(error.line, 2)
      return true
    })
    assert.equal((await readFile(initial.journalPath)).length, corruptLength)

    await writeFile(
      initial.journalPath,
      Buffer.concat([committed, Buffer.from([0xff, 0x0a])]),
    )
    await rejectsWithCode(DomainStore.open({ root }), 'JOURNAL_INVALID_UTF8')
    assert.deepEqual(await readFile(initial.journalPath), Buffer.concat([
      committed,
      Buffer.from([0xff, 0x0a]),
    ]))
    assert.equal(first.seq, 0)
  })
})

void test('CommandService writes CAS objects before one fact and replays the original fact', async () => {
  await withRoot(async (root) => {
    let tick = 1_800_000_000_000
    const clock = (): number => tick++
    const service = await CommandService.open({ root, actor, clock })
    const inspector = await DomainStore.open({ root })
    try {
      const command = normalized('command-1', { value: 'one' })
      const first = await service.commit({
        command,
        type: 'method/registered',
        data: { revision: ref('method-1') },
      })

      assert.equal(first.seq, 0)
      assert.equal(first.prev, null)
      assert.equal(first.commandId, command.commandId)
      assert.equal(first.commandDigest, computeCommandDigest(command))
      assert.deepEqual(first.actor, actor)
      assert.equal(first.at, 1_800_000_000_000)
      assert.deepEqual(await inspector.replay(), [first])
      const afterFirst = await readFile(join(root, JOURNAL_FILENAME))

      const replayed = await service.commit({
        command,
        type: 'method/registered',
        data: { revision: ref('method-1') },
      })
      assert.strictEqual(replayed, first)
      assert.equal(tick, 1_800_000_000_001)
      assert.deepEqual(await readFile(join(root, JOURNAL_FILENAME)), afterFirst)

      const objectBytes = textEncoder.encode('{"proposal":true}')
      const objectDigest = computeDigestBytes('object', objectBytes)
      const second = await service.commit({
        command: normalized('command-2', { value: 'two' }),
        type: 'method/registered',
        data: {
          revision: ref('method-2'),
          sourceProposal: ref('proposal-1', objectDigest),
        },
        objects: [{ id: 'proposal-1', bytes: objectBytes }],
      })
      assert.equal(second.seq, 1)
      assert.equal(second.prev, first.digest)
      assert.deepEqual(
        await inspector.readObject({ id: 'proposal-1', digest: objectDigest }),
        { bytes: objectBytes },
      )

      const beforeFailedObject = await readFile(join(root, JOURNAL_FILENAME))
      await rejectsWithCode(
        service.commit({
          command: normalized('command-3', { value: 'three' }),
          type: 'method/registered',
          data: { revision: ref('method-3') },
          objects: [{ id: '', bytes: objectBytes }],
        }),
        'INVALID_ARGUMENT',
      )
      assert.deepEqual(await readFile(join(root, JOURNAL_FILENAME)), beforeFailedObject)
    } finally {
      await inspector.close()
      await service.close()
    }
  })
})

void test('CommandService rejects digest conflicts and keeps idempotency across restart', async () => {
  await withRoot(async (root) => {
    const clock = (): number => 1_800_000_000_000
    const service = await CommandService.open({ root, actor, clock })
    const command = normalized('command-1', { value: 'one' })
    const first = await service.commit({
      command,
      type: 'method/registered',
      data: { revision: ref('method-1') },
    })
    await service.close()
    const committed = await readFile(join(root, JOURNAL_FILENAME))

    const reopened = await CommandService.open({ root, actor, clock })
    try {
      const replayed = await reopened.commit({
        command,
        type: 'method/registered',
        data: { revision: ref('method-1') },
      })
      assert.deepEqual(replayed, first)
      assert.deepEqual(await readFile(join(root, JOURNAL_FILENAME)), committed)

      const conflicting = normalized('command-1', { value: 'different' })
      const conflictBytes = textEncoder.encode('must-not-be-written')
      const conflictDigest = computeDigestBytes('object', conflictBytes)
      await rejectsWithCode(
        reopened.commit({
          command: conflicting,
          type: 'method/registered',
          data: { revision: ref('method-1') },
          objects: [{ id: 'conflict-object', bytes: conflictBytes }],
        }),
        'IDEMPOTENCY_CONFLICT',
      )
      assert.deepEqual(await readFile(join(root, JOURNAL_FILENAME)), committed)

      const inspector = await DomainStore.open({ root })
      try {
        await rejectsWithCode(
          inspector.readObject({ id: 'conflict-object', digest: conflictDigest }),
          'OBJECT_MISSING',
        )
      } finally {
        await inspector.close()
      }

      await rejectsWithCode(
        reopened.commit({
          command: { ...command, actor: { kind: 'runtime', id: 'other-runtime' } },
          type: 'method/registered',
          data: { revision: ref('method-1') },
        }),
        'INVALID_ARGUMENT',
      )
      assert.deepEqual(await readFile(join(root, JOURNAL_FILENAME)), committed)
    } finally {
      await reopened.close()
    }
  })
})

void test('CommandService owns one writer per normalized root and releases it on close', async () => {
  await withRoot(async (root) => {
    let tick = 1_800_000_000_000
    const clock = (): number => tick++
    const first = await CommandService.open({ root, actor, clock })
    let reopened: CommandService | undefined
    try {
      await assert.rejects(
        CommandService.open({ root: join(root, '.'), actor, clock }),
        (error: unknown) => errorCode(error) === 'WRITER_ALREADY_OPEN',
      )

      const command = normalized('command-owner', { value: 'owner' })
      const fact = await first.commit({
        command,
        type: 'method/registered',
        data: { revision: ref('method-owner') },
      })
      await first.close()

      reopened = await CommandService.open({ root: `${root}/`, actor, clock })
      const replayed = await reopened.commit({
        command,
        type: 'method/registered',
        data: { revision: ref('method-owner') },
      })
      assert.deepEqual(replayed, fact)
    } finally {
      await first.close()
      await reopened?.close()
    }
  })
})

void test('CommandService serializes concurrent commits into one contiguous chain', async () => {
  await withRoot(async (root) => {
    let tick = 1_800_000_000_000
    const clock = (): number => tick++
    const service = await CommandService.open({ root, actor, clock })
    try {
      const sameCommand = normalized('command-same', { value: 'same' })
      const sameInput = {
        command: sameCommand,
        type: 'method/registered',
        data: { revision: ref('method-same') },
      } as const
      const [sameA, sameB] = await Promise.all([
        service.commit(sameInput),
        service.commit(sameInput),
      ])
      assert.strictEqual(sameA, sameB)

      const [second, third] = await Promise.all([
        service.commit({
          command: normalized('command-2', { value: 'two' }),
          type: 'method/registered',
          data: { revision: ref('method-2') },
        }),
        service.commit({
          command: normalized('command-3', { value: 'three' }),
          type: 'method/registered',
          data: { revision: ref('method-3') },
        }),
      ])
      assert.equal(second.seq, 1)
      assert.equal(third.seq, 2)
      assert.equal(second.prev, sameA.digest)
      assert.equal(third.prev, second.digest)

      const inspector = await DomainStore.open({ root })
      try {
        const facts = await inspector.replay()
        assert.deepEqual(facts.map((fact) => fact.seq), [0, 1, 2])
        assert.deepEqual(
          facts.map((fact) => fact.commandId),
          ['command-same', 'command-2', 'command-3'],
        )
        assert.equal(facts[1]?.prev, facts[0]?.digest)
        assert.equal(facts[2]?.prev, facts[1]?.digest)
        assert.equal(facts[0]?.digest, sameA.digest)
      } finally {
        await inspector.close()
      }
    } finally {
      await service.close()
    }
  })
})

void test('DomainStore exports a deterministic journal path', () => {
  assert.equal(JOURNAL_FILENAME, 'journal.ndjson')
})
