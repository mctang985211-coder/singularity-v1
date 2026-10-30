import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'

import {
  canonicalize,
  computeCommandDigest,
  computeDigestBytes,
  projectCommandFacts,
  sealFact,
  verifyFact,
} from '@singularity/protocol'
import type { Digest, FactActor, NormalizedCommand, Ref, UnsealedFact } from '@singularity/protocol'
import { DomainStore } from '../src/index.ts'

const actor = { kind: 'operator', id: 'operator-journal-test' } satisfies FactActor
const encoder = new TextEncoder()
const at = 1_800_000_000_000

function commandFor(commandId: string): NormalizedCommand {
  return {
    v: 1,
    commandId,
    tool: 'singularity_task',
    toolVersion: 1,
    actor,
    scope: {},
    input: { commandId },
  }
}

function unsealedRoundClosed(args: {
  readonly seq: number
  readonly prev: Digest | null
  readonly commandId: string
}): UnsealedFact {
  return {
    v: 1,
    seq: args.seq,
    commandId: args.commandId,
    commandDigest: computeCommandDigest(commandFor(args.commandId)),
    type: 'rsi/round-closed',
    actor,
    at: at + args.seq,
    data: {
      roundId: `round-${args.commandId}`,
      outcome: 'cancelled',
      reason: 'journal framing test',
    },
    prev: args.prev,
  }
}

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-journal-cas-'))
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

async function filesWithBytes(root: string, bytes: Uint8Array): Promise<readonly string[]> {
  const matches: string[] = []
  for (const file of await listFiles(root)) {
    const content = await readFile(file)
    if (content.equals(bytes)) matches.push(file)
  }
  return matches
}

/**
 * Locates the single journal by its committed byte framing, without assuming
 * an internal file name. This is the real-file evidence used by the framing
 * cases below.
 */
async function findJournal(root: string, firstLine: string): Promise<string> {
  for (const file of await listFiles(root)) {
    const content = await readFile(file, 'utf8')
    if (content === `${firstLine}\n` || content.startsWith(`${firstLine}\n`)) return file
  }
  throw new Error('journal file was not found under the store root')
}

async function assertReplayRejects(root: string): Promise<void> {
  await assert.rejects(async () => {
    const store = await DomainStore.open({ root })
    try {
      await store.replay()
    } finally {
      await store.close()
    }
  })
}

void test('CAS stores raw bytes under an object-domain ref and rejects tampering', async t => {
  const root = await temporaryRoot(t)
  const store = await openStore(t, root)
  const bytes = encoder.encode('raw\0bytes\u0001with binary payload')

  const ref = await store.putObject('object-raw', bytes)
  assert.equal(ref.id, 'object-raw')
  assert.equal(ref.digest, computeDigestBytes('object', bytes))

  const read = await store.readObject(ref)
  assert.deepEqual(read.bytes, bytes)
  assert.deepEqual(await store.replay(), [])

  const storedFiles = await filesWithBytes(root, bytes)
  assert.equal(storedFiles.length, 1)

  const tampered = Uint8Array.from(bytes)
  tampered[0] = tampered[0] ^ 0xff
  await writeFile(storedFiles[0], tampered)

  const reopened = await openStore(t, root)
  await assert.rejects(reopened.readObject(ref))

  const otherBytes = encoder.encode('different raw bytes')
  const wrongDigestRef: Ref = {
    id: ref.id,
    digest: computeDigestBytes('object', otherBytes),
  }
  await assert.rejects(reopened.readObject(wrongDigestRef))
  await assert.rejects(
    reopened.readObject({ id: 'object-missing', digest: computeDigestBytes('object', bytes) }),
  )
})

void test('putting the same object bytes twice is idempotent and leaves one copy', async t => {
  const root = await temporaryRoot(t)
  const store = await openStore(t, root)
  const bytes = encoder.encode('idempotent object payload')

  const first = await store.putObject('object-same', bytes)
  const second = await store.putObject('object-same', bytes)

  assert.deepEqual(second, first)
  assert.deepEqual((await store.readObject(second)).bytes, bytes)
  assert.equal((await filesWithBytes(root, bytes)).length, 1)
  assert.deepEqual(await store.replay(), [])
})

void test('empty journal is uninitialized and only an unterminated tail is discarded', async t => {
  const root = await temporaryRoot(t)
  const store = await openStore(t, root)

  assert.deepEqual(await store.replay(), [])
  assert.equal(store.tornTail(), undefined)

  const first = await store.appendFact(
    unsealedRoundClosed({ seq: 0, prev: null, commandId: 'command-torn-0' }),
  )
  assert.equal(first.seq, 0)
  assert.equal(first.prev, null)
  assert.equal(first.commandId, 'command-torn-0')
  assert.equal(verifyFact(first), true)

  const journal = await findJournal(root, canonicalize(first))
  const torn = '{"torn":"unterminated"'
  await appendFile(journal, torn, 'utf8')

  const reopened = await openStore(t, root)
  assert.equal(reopened.tornTail(), torn)
  assert.deepEqual(await reopened.replay(), [first])

  const second = await reopened.appendFact(
    unsealedRoundClosed({ seq: 1, prev: first.digest, commandId: 'command-torn-1' }),
  )
  const restarted = await openStore(t, root)
  assert.deepEqual(await restarted.replay(), [first, second])
  assert.equal(restarted.tornTail(), undefined)

  const content = await readFile(journal, 'utf8')
  assert.equal(content.includes(torn), false)
  assert.equal(content, `${canonicalize(first)}\n${canonicalize(second)}\n`)
})

void test('a complete canonical fact without LF is still a torn tail and is truncated', async t => {
  const root = await temporaryRoot(t)
  const store = await openStore(t, root)
  const first = await store.appendFact(
    unsealedRoundClosed({ seq: 0, prev: null, commandId: 'command-no-lf-0' }),
  )
  const journal = await findJournal(root, canonicalize(first))

  const completeButUncommitted = sealFact(
    unsealedRoundClosed({ seq: 1, prev: first.digest, commandId: 'command-no-lf-1' }),
  )
  await appendFile(journal, canonicalize(completeButUncommitted), 'utf8')

  const reopened = await openStore(t, root)
  assert.equal(reopened.tornTail(), canonicalize(completeButUncommitted))
  assert.deepEqual(await reopened.replay(), [first])

  const committed = await reopened.appendFact(
    unsealedRoundClosed({ seq: 1, prev: first.digest, commandId: 'command-no-lf-next' }),
  )
  const restarted = await openStore(t, root)
  assert.deepEqual(await restarted.replay(), [first, committed])
  assert.equal(restarted.tornTail(), undefined)

  const content = await readFile(journal, 'utf8')
  assert.equal(content.includes(canonicalize(completeButUncommitted)), false)
  assert.equal(content, `${canonicalize(first)}\n${canonicalize(committed)}\n`)
})

void test('CR-framed lines and mid-journal corruption reject without truncating', async t => {
  const root = await temporaryRoot(t)
  const store = await openStore(t, root)
  const first = await store.appendFact(
    unsealedRoundClosed({ seq: 0, prev: null, commandId: 'command-corrupt-0' }),
  )
  const journal = await findJournal(root, canonicalize(first))
  const second = sealFact(
    unsealedRoundClosed({ seq: 1, prev: first.digest, commandId: 'command-corrupt-1' }),
  )

  const crSource = `${canonicalize(first)}\n${canonicalize(second)}\r\n`
  await writeFile(journal, crSource, 'utf8')
  await assertReplayRejects(root)
  assert.equal(await readFile(journal, 'utf8'), crSource)

  const middleCorruption = `${canonicalize(first)}\n{"not":"a fact"}\n${canonicalize(second)}\n`
  await writeFile(journal, middleCorruption, 'utf8')
  const sizeBefore = (await stat(journal)).size
  await assertReplayRejects(root)
  assert.equal((await stat(journal)).size, sizeBefore)
  assert.equal(await readFile(journal, 'utf8'), middleCorruption)
})

void test('an unreferenced CAS object is not a journal success', async t => {
  const root = await temporaryRoot(t)
  const store = await openStore(t, root)
  const bytes = encoder.encode('orphan object bytes')

  const orphan = await store.putObject('orphan-command', bytes)
  assert.deepEqual((await store.readObject(orphan)).bytes, bytes)
  assert.deepEqual(await store.replay(), [])
  assert.equal(projectCommandFacts(await store.replay()).size, 0)

  const fact = await store.appendFact(
    unsealedRoundClosed({ seq: 0, prev: null, commandId: 'orphan-command' }),
  )
  const restarted = await openStore(t, root)
  const replay = await restarted.replay()
  assert.deepEqual(replay, [fact])
  const projection = projectCommandFacts(replay)
  assert.equal(projection.size, 1)
  assert.ok(projection.get('orphan-command') !== undefined)
  assert.deepEqual(projection.get('orphan-command')?.fact, fact)
})
