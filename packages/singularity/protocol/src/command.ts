import { z } from 'zod'

import { computeDigest } from './digest.ts'
import type { Digest } from './digest.ts'
import type { ToolErrorCode } from './errors.ts'
import { factActorSchema } from './fact.ts'
import type { Fact } from './fact.ts'
import { jsonValueSchema } from './json.ts'
import { closedObject, parseProtocolValue } from './schema.ts'

/** Optional host-owned binding scope from docs/framework.md §10.1. */
export const commandScopeSchema = closedObject({
  taskId: z.string().optional(),
  runId: z.string().optional(),
  sessionId: z.string().optional(),
})

export type CommandScope = z.infer<typeof commandScopeSchema>

/**
 * Host-normalized command identity. `input` is the tool's already strict-
 * validated raw input; host-resolved state, budget, clocks, and cursors are
 * deliberately absent and therefore cannot enter the command digest.
 */
export const normalizedCommandSchema = closedObject({
  v: z.literal(1),
  commandId: z.string(),
  tool: z.string(),
  toolVersion: z.literal(1),
  actor: factActorSchema,
  scope: commandScopeSchema,
  input: jsonValueSchema,
})

export type NormalizedCommand = z.infer<typeof normalizedCommandSchema>

/** Validates a complete strict normalized command. */
export function parseNormalizedCommand(value: unknown): NormalizedCommand {
  return parseProtocolValue(normalizedCommandSchema, value)
}

/** Computes the command-domain digest after revalidating the strict shape. */
export function computeCommandDigest(command: NormalizedCommand): Digest {
  return computeDigest('command', parseNormalizedCommand(command))
}

/** One journal fact indexed by its host-assigned commandId. */
export interface CommandProjectionEntry {
  readonly commandDigest: Digest
  readonly seq: number
  readonly factDigest: Digest
  readonly fact: Fact
}

/** In-memory commandId projection rebuilt from the journal; never persisted. */
export type CommandProjection = ReadonlyMap<string, CommandProjectionEntry>

export type CommandProjectionErrorCode = 'DUPLICATE_COMMAND_FACT'

/** A replay rejection caused by more than one fact for one commandId. */
export class CommandProjectionError extends Error {
  override readonly name = 'CommandProjectionError'
  readonly code: CommandProjectionErrorCode = 'DUPLICATE_COMMAND_FACT'
  readonly commandId: string
  readonly seq: number
  readonly previousSeq: number

  constructor(commandId: string, seq: number, previousSeq: number) {
    super(
      `Command ${JSON.stringify(commandId)} has facts at seq ${String(previousSeq)} and ${String(seq)}`,
    )
    this.commandId = commandId
    this.seq = seq
    this.previousSeq = previousSeq
  }
}

/**
 * Rebuilds the pure commandId projection from journal facts. One command has
 * exactly one fact; any duplicate commandId is rejected by replay.
 */
export function projectCommandFacts(facts: readonly Fact[]): CommandProjection {
  const projection = new Map<string, CommandProjectionEntry>()
  for (const fact of facts) {
    const previous = projection.get(fact.commandId)
    if (previous !== undefined) {
      throw new CommandProjectionError(fact.commandId, fact.seq, previous.seq)
    }
    projection.set(fact.commandId, {
      commandDigest: fact.commandDigest,
      seq: fact.seq,
      factDigest: fact.digest,
      fact,
    })
  }
  return projection
}

export type CommandIdempotencyConflictCode = Extract<ToolErrorCode, 'IDEMPOTENCY_CONFLICT'>

/**
 * Pure idempotency decision. A replay returns the original Fact for the journal
 * to reconstruct the prior result; nothing is appended, reserved, dispatched,
 * or woken here.
 */
export type CommandIdempotencyDecision =
  | { readonly kind: 'new' }
  | { readonly kind: 'replay'; readonly fact: Fact }
  | { readonly kind: 'conflict'; readonly code: CommandIdempotencyConflictCode }

/** Decides new, replay, or conflict without executing command side effects. */
export function decideCommandIdempotency(
  projection: CommandProjection,
  command: NormalizedCommand,
): CommandIdempotencyDecision {
  const normalized = parseNormalizedCommand(command)
  const commandDigest = computeDigest('command', normalized)
  const existing = projection.get(normalized.commandId)
  if (existing === undefined) return { kind: 'new' }
  if (existing.commandDigest === commandDigest) {
    return { kind: 'replay', fact: existing.fact }
  }
  return { kind: 'conflict', code: 'IDEMPOTENCY_CONFLICT' }
}
