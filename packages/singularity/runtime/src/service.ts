import {
  computeCommandDigest,
  decideCommandIdempotency,
  factActorSchema,
  parseNormalizedCommand,
  parseProtocolValue,
  projectCommandFacts,
  unsealedFactSchema,
} from '@singularity/protocol'
import type {
  CommandProjectionEntry,
  Fact,
  FactActor,
  FactPayloadMap,
  FactType,
  NormalizedCommand,
  UnsealedFact,
} from '@singularity/protocol'

import { DomainStore } from './store.ts'

export type CommandServiceErrorCode = 'IDEMPOTENCY_CONFLICT' | 'INVALID_ARGUMENT'

/** Stable command-service rejection; idempotency conflicts expose `IDEMPOTENCY_CONFLICT`. */
export class CommandServiceError extends Error {
  override readonly name = 'CommandServiceError'
  readonly code: CommandServiceErrorCode

  constructor(code: CommandServiceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

export interface CommandServiceOptions {
  readonly root: string
  readonly actor: FactActor
  readonly clock: () => number
}

/** One supporting CAS object written before the command fact. */
export interface CommandObject {
  readonly id: string
  readonly bytes: Uint8Array
}

/**
 * CAS objects for one command. The ordered array is canonical; a string-keyed
 * record or Map is accepted as the same id-to-bytes mapping.
 */
export type CommandObjects =
  | readonly CommandObject[]
  | Readonly<Record<string, Uint8Array>>
  | ReadonlyMap<string, Uint8Array>

export interface CommandCommitInput<Type extends FactType = FactType> {
  readonly command: NormalizedCommand
  readonly type: Type
  readonly data: FactPayloadMap[Type]
  readonly objects?: CommandObjects
}

/**
 * Single command writer over one DomainStore.
 *
 * `open` rebuilds the in-memory command projection from replay. `commit`
 * serializes every command, writes supporting CAS objects first, then appends
 * exactly one fact after fsync. A repeated commandId with the same
 * commandDigest returns the original fact without appending; a different
 * digest rejects with `IDEMPOTENCY_CONFLICT`.
 */
export class CommandService {
  private readonly store: DomainStore
  private readonly actor: FactActor
  private readonly clock: () => number
  private factsValue: readonly Fact[]
  private projection: Map<string, CommandProjectionEntry>
  private pending: Promise<void> = Promise.resolve()
  private closed = false
  private closing = false
  private closePromise: Promise<void> | undefined

  private constructor(
    store: DomainStore,
    actor: FactActor,
    clock: () => number,
    facts: readonly Fact[],
    projection: Map<string, CommandProjectionEntry>,
  ) {
    this.store = store
    this.actor = actor
    this.clock = clock
    this.factsValue = facts
    this.projection = projection
  }

  /** Opens the store, replays the journal, and builds the command projection. */
  static async open(options: CommandServiceOptions): Promise<CommandService> {
    if (typeof options.clock !== 'function') {
      throw new CommandServiceError('INVALID_ARGUMENT', 'CommandService clock must be a function')
    }

    let actor: FactActor
    try {
      actor = parseProtocolValue(factActorSchema, options.actor)
    } catch (error) {
      throw new CommandServiceError('INVALID_ARGUMENT', 'CommandService actor is invalid', {
        cause: error,
      })
    }

    const store = await DomainStore.open({ root: options.root })
    try {
      const facts = await store.replay()
      return new CommandService(
        store,
        actor,
        options.clock,
        facts,
        new Map(projectCommandFacts(facts)),
      )
    } catch (error) {
      await store.close()
      throw error
    }
  }

  /** Verified facts known to this writer, including successful appends. */
  facts(): readonly Fact[] {
    return this.factsValue
  }

  /**
   * Commits one normalized command as exactly one fact.
   *
   * The command and fact are validated before any CAS write; supporting
   * objects are written before the fact append, and the returned fact exists
   * only after append + fsync.
   */
  async commit<Type extends FactType>(input: CommandCommitInput<Type>): Promise<Fact> {
    if (this.closed || this.closing) {
      throw new CommandServiceError('INVALID_ARGUMENT', 'CommandService is closed')
    }

    let command: NormalizedCommand
    try {
      command = parseNormalizedCommand(input.command)
    } catch (error) {
      throw new CommandServiceError('INVALID_ARGUMENT', 'Normalized command is invalid', {
        cause: error,
      })
    }
    if (command.actor.kind !== this.actor.kind || command.actor.id !== this.actor.id) {
      throw new CommandServiceError(
        'INVALID_ARGUMENT',
        'Normalized command actor does not match the host actor',
      )
    }
    const commandDigest = computeCommandDigest(command)

    return this.enqueue(async () => {
      if (this.closed) {
        throw new CommandServiceError('INVALID_ARGUMENT', 'CommandService is closed')
      }

      const decision = decideCommandIdempotency(this.projection, command)
      if (decision.kind === 'replay') return decision.fact
      if (decision.kind === 'conflict') {
        throw new CommandServiceError(
          'IDEMPOTENCY_CONFLICT',
          `Command ${JSON.stringify(command.commandId)} was committed with a different digest`,
        )
      }

      const at = this.clock()
      if (!Number.isSafeInteger(at) || at < 0) {
        throw new CommandServiceError(
          'INVALID_ARGUMENT',
          'CommandService clock must return a non-negative safe integer',
        )
      }

      const previous = this.factsValue.at(-1)
      const candidate = {
        v: 1,
        seq: this.factsValue.length,
        commandId: command.commandId,
        commandDigest,
        type: input.type,
        actor: this.actor,
        at,
        data: input.data,
        prev: previous?.digest ?? null,
      }
      let unsealed: UnsealedFact
      try {
        unsealed = parseProtocolValue(unsealedFactSchema, candidate)
      } catch (error) {
        throw new CommandServiceError('INVALID_ARGUMENT', 'Command fact payload is invalid', {
          cause: error,
        })
      }

      for (const object of commandObjectEntries(input.objects)) {
        await this.store.putObject(object.id, object.bytes)
      }

      const fact = await this.store.appendFact(unsealed)
      this.factsValue = [...this.factsValue, fact]
      this.projection.set(fact.commandId, {
        commandDigest: fact.commandDigest,
        seq: fact.seq,
        factDigest: fact.digest,
        fact,
      })
      return fact
    })
  }

  /** Waits for queued commits and closes the underlying store. */
  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closing = true
    this.closePromise = this.enqueue(async () => {
      this.closed = true
      await this.store.close()
    })
    return this.closePromise
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function commandObjectEntries(objects: CommandObjects | undefined): readonly CommandObject[] {
  if (objects === undefined) return []
  if (Array.isArray(objects)) return objects as readonly CommandObject[]
  if (isCommandObjectMap(objects)) {
    return [...objects].map(([id, bytes]) => ({ id, bytes }))
  }
  if (isObjectBytesRecord(objects)) {
    return Object.entries(objects).map(([id, bytes]) => ({ id, bytes }))
  }
  throw new CommandServiceError(
    'INVALID_ARGUMENT',
    'Command objects must be an ordered array, record, or Map',
  )
}

function isCommandObjectMap(value: unknown): value is ReadonlyMap<string, Uint8Array> {
  return value instanceof Map
}

function isObjectBytesRecord(
  value: unknown,
): value is Readonly<Record<string, Uint8Array>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Map) &&
    !ArrayBuffer.isView(value)
  )
}
