import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CommandProjectionError,
  computeCommandDigest,
  decideCommandIdempotency,
  normalizedCommandSchema,
  parseNormalizedCommand,
  projectCommandFacts,
} from '../src/command.ts'
import type { NormalizedCommand } from '../src/command.ts'
import { computeDigest } from '../src/digest.ts'
import { sealFact } from '../src/fact.ts'
import type { Fact } from '../src/fact.ts'
import * as protocol from '../src/index.ts'
import { canonicalize } from '../src/json.ts'
import { parseProtocolValue } from '../src/schema.ts'

const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`

const baseCommand = {
  v: 1,
  commandId: 'command-1',
  tool: 'singularity_task',
  toolVersion: 1,
  actor: { kind: 'operator', id: 'operator-1' },
  scope: { taskId: 'task-1', runId: 'run-1', sessionId: 'session-1' },
  input: { goal: 'do the work', nested: [1, true, null] },
} satisfies NormalizedCommand

function makeCommand(overrides: Partial<NormalizedCommand> = {}): NormalizedCommand {
  return { ...baseCommand, ...overrides }
}

function makeFact(command: NormalizedCommand, seq: number, prev: string | null = null): Fact {
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

function withoutField(command: NormalizedCommand, field: keyof NormalizedCommand): Record<string, unknown> {
  const copy: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(command)) {
    if (key !== field) copy[key] = value
  }
  return copy
}

void test('normalized command schema accepts exactly the seven strict fields', () => {
  assert.deepEqual(parseNormalizedCommand(baseCommand), baseCommand)

  const minimal = {
    v: 1,
    commandId: 'command-minimal',
    tool: 'host_operation',
    toolVersion: 1,
    actor: { kind: 'runtime', id: 'runtime-1' },
    scope: {},
    input: null,
  } satisfies NormalizedCommand
  assert.deepEqual(parseNormalizedCommand(minimal), minimal)

  for (const field of [
    'v',
    'commandId',
    'tool',
    'toolVersion',
    'actor',
    'scope',
    'input',
  ] as const) {
    assert.throws(() => parseNormalizedCommand(withoutField(baseCommand, field)), field)
  }

  const invalid = [
    { ...baseCommand, v: 2 },
    { ...baseCommand, commandId: 1 },
    { ...baseCommand, tool: null },
    { ...baseCommand, toolVersion: 2 },
    { ...baseCommand, actor: { kind: 'model', id: 'model-1' } },
    { ...baseCommand, actor: { kind: 'operator' } },
    { ...baseCommand, actor: null },
    { ...baseCommand, scope: null },
    { ...baseCommand, scope: [] },
    { ...baseCommand, input: undefined },
    { ...baseCommand, input: 1n },
  ]

  for (const command of invalid) {
    assert.throws(() => parseNormalizedCommand(command))
  }
})

void test('normalized command rejects unknown root, actor, and scope fields', () => {
  assert.throws(() => parseNormalizedCommand({ ...baseCommand, extra: true }))
  assert.throws(() => parseNormalizedCommand({ ...baseCommand, digest: digestA }))
  assert.throws(() =>
    parseNormalizedCommand({
      ...baseCommand,
      actor: { ...baseCommand.actor, extra: true },
    }),
  )
  assert.throws(() =>
    parseNormalizedCommand({
      ...baseCommand,
      scope: { ...baseCommand.scope, extra: true },
    }),
  )

  // `input` is the tool's already strict-validated raw JSON; the normalized
  // envelope does not second-guess tool-specific keys.
  const arbitraryInput = { any: { nested: ['value', 1] } }
  assert.deepEqual(
    parseNormalizedCommand({ ...baseCommand, input: arbitraryInput }).input,
    arbitraryInput,
  )
})

void test('computeCommandDigest uses the command domain and is stable for identical input', () => {
  const digest = computeCommandDigest(baseCommand)
  assert.match(digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(digest, computeDigest('command', baseCommand))
  assert.notEqual(digest, computeDigest('object', baseCommand))
  assert.equal(digest, computeCommandDigest(makeCommand()))

  const reordered = makeCommand({
    actor: { id: 'operator-1', kind: 'operator' },
    scope: { sessionId: 'session-1', runId: 'run-1', taskId: 'task-1' },
    input: { nested: [1, true, null], goal: 'do the work' },
  })
  assert.equal(canonicalize(reordered), canonicalize(baseCommand))
  assert.equal(computeCommandDigest(reordered), digest)
})

void test('host-owned state cannot enter the command digest', () => {
  interface HostState {
    readonly currentState: string
    readonly contractDigest: string
    readonly methodDigest: string
    readonly planningSketch: string
    readonly batchId: string
    readonly feedbackRef: string
    readonly remainingBudgetPct: number
    readonly asOf: number
    readonly at: number
    readonly cursor: string
  }

  const hostA: HostState = {
    currentState: 'run-open',
    contractDigest: digestA,
    methodDigest: digestB,
    planningSketch: 'sketch-a',
    batchId: 'batch-a',
    feedbackRef: 'feedback-a',
    remainingBudgetPct: 80,
    asOf: 1_800_000_000_000,
    at: 1_800_000_000_001,
    cursor: 'cursor-a',
  }
  const hostB: HostState = { ...hostA, currentState: 'run-closed', remainingBudgetPct: 10, asOf: 1_900_000_000_000 }

  const withHostA = { ...baseCommand, hostA }
  const withHostB = { ...baseCommand, hostB }
  assert.throws(() => parseNormalizedCommand(withHostA))
  assert.throws(() => parseNormalizedCommand(withHostB))

  const normalizedA: NormalizedCommand = { ...baseCommand, input: { goal: 'same' } }
  const normalizedB: NormalizedCommand = { ...baseCommand, input: { goal: 'same' } }
  assert.equal(computeCommandDigest(normalizedA), computeCommandDigest(normalizedB))

  for (const field of [
    'state',
    'contractDigest',
    'methodDigest',
    'planningSketch',
    'batchId',
    'feedback',
    'budget',
    'asOf',
    'at',
    'cursor',
  ]) {
    assert.throws(() => parseNormalizedCommand({ ...baseCommand, [field]: 'host-value' }), field)
    assert.throws(
      () => computeCommandDigest({ ...baseCommand, [field]: 'host-value' } as unknown as NormalizedCommand),
      field,
    )
  }
})

void test('different command input produces a different digest, including actor and scope', () => {
  const baseDigest = computeCommandDigest(baseCommand)

  const variants: readonly NormalizedCommand[] = [
    makeCommand({ commandId: 'command-2' }),
    makeCommand({ tool: 'singularity_other' }),
    makeCommand({ actor: { kind: 'runtime', id: baseCommand.actor.id } }),
    makeCommand({ actor: { kind: baseCommand.actor.kind, id: 'operator-2' } }),
    makeCommand({ scope: { ...baseCommand.scope, taskId: 'task-2' } }),
    makeCommand({ scope: { ...baseCommand.scope, runId: 'run-2' } }),
    makeCommand({ scope: { ...baseCommand.scope, sessionId: 'session-2' } }),
    makeCommand({ scope: { taskId: 'task-1' } }),
    makeCommand({ input: { goal: 'do other work', nested: [1, true, null] } }),
    makeCommand({ input: { goal: 'do the work', nested: [true, 1, null] } }),
  ]

  for (const variant of variants) {
    assert.notEqual(computeCommandDigest(variant), baseDigest)
  }
})

void test('projection indexes one journal fact per commandId with replay fields', () => {
  const firstCommand = makeCommand({ commandId: 'command-a' })
  const secondCommand = makeCommand({ commandId: 'command-b' })
  const first = makeFact(firstCommand, 0)
  const second = makeFact(secondCommand, 1, first.digest)

  assert.equal(projectCommandFacts([]).size, 0)

  const projection = projectCommandFacts([first, second])
  assert.equal(projection.size, 2)

  const entry = projection.get(firstCommand.commandId)
  assert.ok(entry !== undefined)
  assert.deepEqual(Object.keys(entry).sort(), ['commandDigest', 'fact', 'factDigest', 'seq'])
  assert.equal(entry.commandDigest, computeCommandDigest(firstCommand))
  assert.equal(entry.seq, 0)
  assert.equal(entry.factDigest, first.digest)
  assert.strictEqual(entry.fact, first)

  const secondEntry = projection.get(secondCommand.commandId)
  assert.ok(secondEntry !== undefined)
  assert.equal(secondEntry.seq, 1)
  assert.strictEqual(secondEntry.fact, second)
})

void test('projection rejects any second fact for the same commandId', () => {
  const command = makeCommand()
  const first = makeFact(command, 0)
  const duplicate = makeFact(command, 1, first.digest)

  assert.throws(
    () => projectCommandFacts([first, duplicate]),
    (error: unknown) => {
      assert.ok(error instanceof CommandProjectionError)
      assert.equal(error.name, 'CommandProjectionError')
      assert.equal(error.code, 'DUPLICATE_COMMAND_FACT')
      assert.equal(error.commandId, command.commandId)
      assert.equal(error.previousSeq, 0)
      assert.equal(error.seq, 1)
      return true
    },
  )

  assert.throws(
    () => projectCommandFacts([first, first]),
    (error: unknown) => error instanceof CommandProjectionError,
  )
})

void test('idempotency decides new, replay, or conflict without journal side effects', () => {
  const command = makeCommand()
  const fact = makeFact(command, 0)
  const projection = projectCommandFacts([fact])
  const entriesBefore = [...projection.entries()]

  const unknown = decideCommandIdempotency(projection, makeCommand({ commandId: 'command-unknown' }))
  assert.deepEqual(unknown, { kind: 'new' })

  const replay = decideCommandIdempotency(projection, makeCommand())
  assert.deepEqual(replay, { kind: 'replay', fact })
  assert.equal(replay.kind, 'replay')
  assert.strictEqual(replay.fact, fact)
  assert.equal(replay.fact.type, 'task/admitted')
  assert.deepEqual(replay.fact.data, fact.data)

  for (const conflicting of [
    makeCommand({ input: { goal: 'different' } }),
    makeCommand({ actor: { kind: 'runtime', id: baseCommand.actor.id } }),
    makeCommand({ scope: { ...baseCommand.scope, runId: 'run-2' } }),
  ]) {
    const conflict = decideCommandIdempotency(projection, conflicting)
    assert.deepEqual(conflict, { kind: 'conflict', code: 'IDEMPOTENCY_CONFLICT' })
    assert.equal(conflict.kind, 'conflict')
    assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT')
    assert.equal('fact' in conflict, false)
    assert.equal('append' in conflict, false)
    assert.equal('reservation' in conflict, false)
  }

  // The pure decision never appends, reserves, dispatches, or rewrites the
  // in-memory projection; replay returns the original Fact by reference.
  assert.equal(projection.size, 1)
  assert.deepEqual([...projection.entries()], entriesBefore)
  assert.equal(computeCommandDigest(makeCommand()), computeCommandDigest(command))
})

void test('index exports the command surface alongside the existing protocol surface', () => {
  assert.strictEqual(protocol.normalizedCommandSchema, normalizedCommandSchema)
  assert.strictEqual(protocol.parseNormalizedCommand, parseNormalizedCommand)
  assert.strictEqual(protocol.computeCommandDigest, computeCommandDigest)
  assert.strictEqual(protocol.projectCommandFacts, projectCommandFacts)
  assert.strictEqual(protocol.decideCommandIdempotency, decideCommandIdempotency)
  assert.strictEqual(protocol.CommandProjectionError, CommandProjectionError)
  assert.equal(typeof protocol.sealFact, 'function')
})

void test('journal facts and normalized commands are separate representations', () => {
  const command = makeCommand()
  const parsed = parseProtocolValue(normalizedCommandSchema, command)
  assert.deepEqual(parsed, command)

  const fact = makeFact(command, 0)
  assert.equal('input' in fact, false)
  assert.equal(fact.commandId, command.commandId)
  assert.equal(fact.commandDigest, computeCommandDigest(command))
})
