import assert from 'node:assert/strict'
import test from 'node:test'

import {
  computeCommandDigest,
  decideCommandIdempotency,
  projectCommandFacts,
} from '../src/command.ts'
import type { CommandProjection, NormalizedCommand } from '../src/command.ts'
import { sealFact } from '../src/fact.ts'
import type { Fact } from '../src/fact.ts'
import * as protocol from '../src/index.ts'
import { canonicalize } from '../src/json.ts'
import { JournalError, foldFacts, replayJournal } from '../src/journal.ts'

const digestA = `sha256:${'a'.repeat(64)}`

const genesisCommand = {
  v: 1,
  commandId: 'command-genesis',
  tool: 'singularity_task',
  toolVersion: 1,
  actor: { kind: 'operator', id: 'operator-1' },
  scope: { taskId: 'task-genesis' },
  input: { goal: 'admit root task' },
} satisfies NormalizedCommand

const secondCommand = {
  v: 1,
  commandId: 'command-second',
  tool: 'singularity_decompose',
  toolVersion: 1,
  actor: { kind: 'operator', id: 'operator-1' },
  scope: { taskId: 'task-genesis', runId: 'run-1' },
  input: { goal: 'admit child task' },
} satisfies NormalizedCommand

function factFor(command: NormalizedCommand, seq: number, prev: string | null): Fact {
  return sealFact({
    v: 1,
    seq,
    commandId: command.commandId,
    commandDigest: computeCommandDigest(command),
    type: 'task/admitted',
    actor: command.actor,
    at: 1_800_000_000_000 + seq,
    data: {
      taskId: `task-${command.commandId}`,
      contract: { id: `contract-${command.commandId}`, digest: digestA },
    },
    prev,
  })
}

function journalSource(facts: readonly Fact[]): string {
  return facts.map(fact => `${canonicalize(fact)}\n`).join('')
}

function factChain(): readonly [Fact, Fact] {
  const genesis = factFor(genesisCommand, 0, null)
  const second = factFor(secondCommand, 1, genesis.digest)
  return [genesis, second]
}

void test('real replayJournal and foldFacts verify genesis and build the command projection', () => {
  const [genesis, second] = factChain()
  const replay = replayJournal(journalSource([genesis, second]))

  assert.equal(replay.tornTail, '')
  assert.equal(replay.facts.length, 2)
  assert.equal(replay.facts[0].seq, 0)
  assert.equal(replay.facts[0].prev, null)
  assert.equal(replay.facts[1].prev, replay.facts[0].digest)
  assert.equal(replay.facts[1].seq, 1)

  const folded = foldFacts<CommandProjection>(replay.facts, projectCommandFacts)
  assert.deepEqual(folded.facts, replay.facts)
  assert.equal(folded.commandProjection instanceof Map, true)
  assert.equal(folded.commandProjection.size, 2)

  const entry = folded.commandProjection.get(genesisCommand.commandId)
  assert.ok(entry !== undefined)
  assert.equal(entry.commandDigest, computeCommandDigest(genesisCommand))
  assert.equal(entry.seq, 0)
  assert.equal(entry.factDigest, replay.facts[0].digest)
  assert.strictEqual(entry.fact, folded.facts[0])
})

void test('real journal fold supports replay, conflict, and new idempotency decisions', () => {
  const [genesis, second] = factChain()
  const replay = replayJournal(journalSource([genesis, second]))
  const folded = foldFacts<CommandProjection>(replay.facts, projectCommandFacts)

  const replayDecision = decideCommandIdempotency(folded.commandProjection, genesisCommand)
  assert.equal(replayDecision.kind, 'replay')
  assert.strictEqual(replayDecision.fact, folded.facts[0])

  const sameIdDifferentDigest: NormalizedCommand = {
    ...genesisCommand,
    input: { goal: 'admit a different root task' },
  }
  assert.notEqual(computeCommandDigest(sameIdDifferentDigest), computeCommandDigest(genesisCommand))
  assert.deepEqual(
    decideCommandIdempotency(folded.commandProjection, sameIdDifferentDigest),
    { kind: 'conflict', code: 'IDEMPOTENCY_CONFLICT' },
  )

  assert.deepEqual(
    decideCommandIdempotency(folded.commandProjection, {
      ...genesisCommand,
      commandId: 'command-unknown',
    }),
    { kind: 'new' },
  )

  // The real journal fold is read-only: replay and conflict do not append or
  // rewrite the projection.
  assert.equal(folded.commandProjection.size, 2)
  assert.strictEqual(folded.commandProjection.get(genesisCommand.commandId)?.fact, folded.facts[0])
})

void test('real journal replay and fold reject a duplicate commandId before projection', () => {
  const genesis = factFor(genesisCommand, 0, null)
  const duplicate = factFor(genesisCommand, 1, genesis.digest)

  assert.throws(
    () => replayJournal(journalSource([genesis, duplicate])),
    (error: unknown) => {
      assert.ok(error instanceof JournalError)
      assert.equal(error.code, 'JOURNAL_COMMAND_ID_DUPLICATE')
      assert.equal(error.line, 2)
      return true
    },
  )

  let called = false
  assert.throws(
    () =>
      foldFacts([genesis, duplicate], facts => {
        called = true
        return projectCommandFacts(facts)
      }),
    (error: unknown) => {
      assert.ok(error instanceof JournalError)
      assert.equal(error.code, 'JOURNAL_COMMAND_ID_DUPLICATE')
      return true
    },
  )
  assert.equal(called, false)
})

void test('protocol index exports command and journal without a module cycle', () => {
  assert.strictEqual(protocol.computeCommandDigest, computeCommandDigest)
  assert.strictEqual(protocol.projectCommandFacts, projectCommandFacts)
  assert.strictEqual(protocol.decideCommandIdempotency, decideCommandIdempotency)
  assert.strictEqual(protocol.replayJournal, replayJournal)
  assert.strictEqual(protocol.foldFacts, foldFacts)
  assert.strictEqual(protocol.JournalError, JournalError)
})
