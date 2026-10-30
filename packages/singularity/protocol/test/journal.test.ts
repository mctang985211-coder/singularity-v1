import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalize } from '../src/json.ts'
import { sealFact } from '../src/fact.ts'
import type { Fact } from '../src/fact.ts'
import {
  JournalError,
  foldFacts,
  replayJournal,
  verifyFactChain,
} from '../src/journal.ts'
import type { JournalErrorCode } from '../src/journal.ts'

const digestA = `sha256:${'a'.repeat(64)}`

function commandDigestFor(seq: number): string {
  return `sha256:${seq.toString(16).padStart(64, '0')}`
}

function admitFact(
  seq: number,
  commandId: string,
  prev: string | null,
  taskId = `task-${String(seq)}`,
): Fact {
  return sealFact({
    v: 1,
    seq,
    commandId,
    commandDigest: commandDigestFor(seq),
    type: 'task/admitted',
    actor: { kind: 'runtime', id: 'runtime-1' },
    at: 1_800_000_000_000 + seq,
    data: { taskId, contract: { id: `contract-${String(seq)}`, digest: digestA } },
    prev,
  })
}

function factChain(): readonly [Fact, Fact, Fact] {
  const genesis = admitFact(0, 'command-0', null)
  const second = admitFact(1, 'command-1', genesis.digest)
  const third = admitFact(2, 'command-2', second.digest)
  return [genesis, second, third]
}

function encodeFacts(facts: readonly Fact[]): string {
  return facts.map(fact => `${canonicalize(fact)}\n`).join('')
}

function expectJournalError(
  action: () => unknown,
  expected: { readonly code: JournalErrorCode; readonly line?: number },
): JournalError {
  try {
    action()
  } catch (error) {
    assert.ok(error instanceof JournalError, `expected JournalError, got ${String(error)}`)
    assert.equal(error.code, expected.code)
    if (expected.line !== undefined) assert.equal(error.line, expected.line)
    return error
  }
  assert.fail(`expected ${expected.code}`)
}

void test('an empty journal is a valid uninitialized state', () => {
  assert.deepEqual(replayJournal(''), { facts: [], tornTail: '' })
})

void test('replays a genesis fact and a contiguous multi-line JCS chain', () => {
  const facts = factChain()
  const replay = replayJournal(encodeFacts(facts))

  assert.deepEqual(replay.facts, facts)
  assert.equal(replay.tornTail, '')
  assert.equal(replay.facts[0].seq, 0)
  assert.equal(replay.facts[0].prev, null)
  assert.equal(replay.facts[1].prev, replay.facts[0].digest)
  assert.equal(replay.facts[2].prev, replay.facts[1].digest)
})

void test('an unterminated tail is discarded even when it is complete canonical JSON', () => {
  const [genesis, second, third] = factChain()
  const replay = replayJournal(`${encodeFacts([genesis, second])}${canonicalize(third)}`)

  assert.deepEqual(replay.facts, [genesis, second])
  assert.equal(replay.tornTail, canonicalize(third))

  const single = replayJournal(canonicalize(genesis))
  assert.deepEqual(single.facts, [])
  assert.equal(single.tornTail, canonicalize(genesis))
})

void test('an unterminated tail may contain arbitrary framing characters', () => {
  const [genesis] = factChain()
  const tornTail = '\r{"torn":'
  const replay = replayJournal(`${encodeFacts([genesis])}${tornTail}`)

  assert.deepEqual(replay.facts, [genesis])
  assert.equal(replay.tornTail, tornTail)
})

void test('BOM, CR, empty lines, and surrounding whitespace are framing errors', () => {
  const [genesis] = factChain()
  const line = canonicalize(genesis)
  const cases: readonly (readonly [string, JournalErrorCode, number])[] = [
    [`\uFEFF${line}\n`, 'JOURNAL_BOM', 1],
    [`${line}\r\n`, 'JOURNAL_CR', 1],
    [`${line}\n\n`, 'JOURNAL_EMPTY_LINE', 2],
    [`${line}\n\n{"torn":`, 'JOURNAL_EMPTY_LINE', 2],
    ['\n', 'JOURNAL_EMPTY_LINE', 1],
    [` ${line}\n`, 'JOURNAL_WHITESPACE', 1],
    [`${line} \n`, 'JOURNAL_WHITESPACE', 1],
    [`\t${line}\t\n`, 'JOURNAL_WHITESPACE', 1],
    [`${line}\n\uFEFF${line}\n`, 'JOURNAL_BOM', 2],
  ]

  for (const [source, code, lineNumber] of cases) {
    expectJournalError(() => replayJournal(source), { code, line: lineNumber })
  }
})

void test('a complete line must be JCS canonical, not merely valid JSON', () => {
  const [genesis] = factChain()
  const compact = JSON.stringify(genesis)
  assert.notEqual(compact, canonicalize(genesis))

  expectJournalError(() => replayJournal(`${compact}\n`), {
    code: 'JOURNAL_NON_CANONICAL',
    line: 1,
  })

  const spaced = canonicalize(genesis).replace(':', ': ')
  expectJournalError(() => replayJournal(`${spaced}\n`), {
    code: 'JOURNAL_NON_CANONICAL',
    line: 1,
  })
})

void test('an LF-terminated corrupt line is rejected instead of skipped', () => {
  const facts = factChain()
  const validPrefix = encodeFacts([facts[0]])

  expectJournalError(() => replayJournal(`${validPrefix}{"v":1,\n`), {
    code: 'JOURNAL_INVALID_JSON',
    line: 2,
  })
  expectJournalError(() => replayJournal(`${validPrefix}null\n`), {
    code: 'JOURNAL_INVALID_FACT',
    line: 2,
  })
  expectJournalError(
    () => replayJournal(`${validPrefix}{"broken":true}\n${encodeFacts([facts[1]])}`),
    { code: 'JOURNAL_INVALID_FACT', line: 2 },
  )

  const tampered = { ...facts[1], commandId: 'tampered-command' }
  expectJournalError(() => replayJournal(`${validPrefix}${canonicalize(tampered)}\n`), {
    code: 'JOURNAL_FACT_DIGEST_MISMATCH',
    line: 2,
  })

  const invalidCommandDigest = { ...facts[1], commandDigest: 'not-a-digest' }
  expectJournalError(
    () => replayJournal(`${validPrefix}${canonicalize(invalidCommandDigest)}\n`),
    { code: 'JOURNAL_INVALID_FACT', line: 2 },
  )
})

void test('verifyFactChain requires genesis at seq zero and contiguous sequence numbers', () => {
  expectJournalError(() => verifyFactChain([admitFact(1, 'command-1', null)]), {
    code: 'JOURNAL_SEQ_MISMATCH',
    line: 1,
  })

  const genesis = admitFact(0, 'command-0', null)
  const gap = admitFact(2, 'command-2', genesis.digest)
  expectJournalError(() => verifyFactChain([genesis, gap]), {
    code: 'JOURNAL_SEQ_MISMATCH',
    line: 2,
  })

  const duplicateSeq = admitFact(0, 'command-duplicate-seq', genesis.digest)
  expectJournalError(() => verifyFactChain([genesis, duplicateSeq]), {
    code: 'JOURNAL_SEQ_MISMATCH',
    line: 2,
  })
})

void test('verifyFactChain requires prev to be the previous fact digest and null at genesis', () => {
  const nonGenesis = admitFact(0, 'command-0', digestA)
  expectJournalError(() => verifyFactChain([nonGenesis]), {
    code: 'JOURNAL_PREV_MISMATCH',
    line: 1,
  })

  const genesis = admitFact(0, 'command-0', null)
  const wrongPrev = admitFact(1, 'command-1', null)
  expectJournalError(() => verifyFactChain([genesis, wrongPrev]), {
    code: 'JOURNAL_PREV_MISMATCH',
    line: 2,
  })
})

void test('verifyFactChain re-verifies fact digests and rejects non-facts', () => {
  const facts = factChain()
  const tampered = { ...facts[1], at: facts[1].at + 1 }

  expectJournalError(() => verifyFactChain([facts[0], tampered, facts[2]]), {
    code: 'JOURNAL_FACT_DIGEST_MISMATCH',
    line: 2,
  })
  expectJournalError(() => verifyFactChain([null]), { code: 'JOURNAL_INVALID_FACT', line: 1 })
  expectJournalError(() => verifyFactChain([{ v: 1 }]), {
    code: 'JOURNAL_INVALID_FACT',
    line: 1,
  })
})

void test('one commandId may appear at most once in the journal', () => {
  const genesis = admitFact(0, 'shared-command', null)
  const second = admitFact(1, 'shared-command', genesis.digest, 'task-second')

  expectJournalError(() => verifyFactChain([genesis, second]), {
    code: 'JOURNAL_COMMAND_ID_DUPLICATE',
    line: 2,
  })
})

void test('verifyFactChain returns the verified facts without mutating its input', () => {
  const facts = factChain()
  const snapshot = facts.map(fact => ({ ...fact }))

  const verified = verifyFactChain(facts)
  assert.deepEqual(verified, facts)
  assert.deepEqual(facts, snapshot)
  assert.deepEqual(verifyFactChain([]), [])
})

void test('foldFacts is deterministic and delegates command projection to its builder', () => {
  const facts = factChain()
  let calls = 0
  let received: readonly Fact[] = []

  const buildCommandProjection = (input: readonly Fact[]) => {
    calls += 1
    received = input
    return {
      commands: input.map(fact => ({
        commandId: fact.commandId,
        commandDigest: fact.commandDigest,
        seq: fact.seq,
        factDigest: fact.digest,
      })),
    }
  }

  const first = foldFacts(facts, buildCommandProjection)
  const second = foldFacts(facts, buildCommandProjection)

  assert.equal(calls, 2)
  assert.deepEqual(received, facts)
  assert.deepEqual(first, second)
  assert.deepEqual(first.facts, facts)
  assert.deepEqual(
    first.commandProjection.commands.map(command => command.commandId),
    ['command-0', 'command-1', 'command-2'],
  )
})

void test('foldFacts refuses an invalid chain before building any projection', () => {
  const [genesis] = factChain()
  const tampered = { ...genesis, at: genesis.at + 1 }
  let called = false

  expectJournalError(
    () =>
      foldFacts([tampered], () => {
        called = true
        return null
      }),
    { code: 'JOURNAL_FACT_DIGEST_MISMATCH', line: 1 },
  )
  assert.equal(called, false)
})

void test('replayJournal never treats a missing final LF as a committed fact', () => {
  const [genesis, second] = factChain()

  const replay = replayJournal(encodeFacts([genesis]) + canonicalize(second))
  assert.deepEqual(replay.facts, [genesis])
  assert.equal(replay.tornTail, canonicalize(second))

  const empty = replayJournal(encodeFacts([genesis]).slice(0, -1))
  assert.deepEqual(empty.facts, [])
  assert.equal(empty.tornTail, canonicalize(genesis))
})
