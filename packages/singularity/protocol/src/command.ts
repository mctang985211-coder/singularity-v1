import { z } from 'zod'

import { computeDigest } from './digest.ts'
import type { Digest } from './digest.ts'
import { factActorSchema } from './fact.ts'
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
