import { mkdir, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  computeCommandDigest,
  compositionSchema,
  decideCommandIdempotency,
  factActorSchema,
  methodRevisionSchema,
  parseJsonText,
  parseNormalizedCommand,
  parseProtocolValue,
  projectCommandFacts,
  reduceTaskRunFacts,
  sealFact,
  taskContractSchema,
  unsealedFactSchema,
} from '@singularity/protocol'
import type {
  CommandProjectionEntry,
  Composition,
  Fact,
  FactActor,
  FactPayloadMap,
  FactType,
  MethodRevision,
  NormalizedCommand,
  Ref,
  TaskContract,
  TaskRunState,
  UnsealedFact,
} from '@singularity/protocol'

import { DomainStore } from './store.ts'
import type { CasDigestDomain } from './store.ts'

export type CommandServiceErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_ARGUMENT'
  | 'WRITER_ALREADY_OPEN'

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
  /** Digest domain for the object; defaults to `object`. */
  readonly domain?: CasDigestDomain
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
 * Process-local writer ownership only. This is not a second business state or
 * fact ledger; it prevents two live CommandService instances from writing the
 * same canonical root.
 */
const activeWriterRoots = new Set<string>()

/**
 * Single command writer over one DomainStore.
 *
 * `open` claims process-local writer ownership for the canonical root, replays
 * the journal, and rebuilds the in-memory command projection. A second live
 * service for the same root rejects with `WRITER_ALREADY_OPEN`; a successful
 * close releases ownership. `commit` serializes every command, writes
 * supporting CAS objects first, then appends exactly one fact after fsync. A
 * repeated commandId with the same commandDigest returns the original fact
 * without appending; a different digest rejects with `IDEMPOTENCY_CONFLICT`.
 */
export class CommandService {
  private readonly store: DomainStore
  private readonly root: string
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
    root: string,
    actor: FactActor,
    clock: () => number,
    facts: readonly Fact[],
    projection: Map<string, CommandProjectionEntry>,
  ) {
    this.store = store
    this.root = root
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

    const requestedRoot = normalizeRoot(options.root)
    await mkdir(requestedRoot, { recursive: true })
    const root = await realpath(requestedRoot)
    if (activeWriterRoots.has(root)) {
      throw new CommandServiceError(
        'WRITER_ALREADY_OPEN',
        `A CommandService is already open for ${root}`,
      )
    }
    activeWriterRoots.add(root)

    let store: DomainStore | undefined
    try {
      store = await DomainStore.open({ root })
      const facts = await store.replay()
      return new CommandService(
        store,
        root,
        actor,
        options.clock,
        facts,
        new Map(projectCommandFacts(facts)),
      )
    } catch (error) {
      if (store !== undefined) {
        await store.close().catch(() => undefined)
      }
      activeWriterRoots.delete(root)
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
    return this.commitCommand(input)
  }

  /** Production Task/Run commands share this writer and the protocol fold. */
  commitTaskRun<Type extends FactType>(
    input: CommandCommitInput<Type>,
    transientInvalidReasons: readonly string[],
  ): Promise<Fact> {
    return this.commitCommand(input, transientInvalidReasons)
  }

  /** Rebuilds the sole Task/Run projection from verified journal and CAS. */
  taskRunState(transientInvalidReasons: readonly string[]): Promise<TaskRunState> {
    return this.projectTaskRuns(this.factsValue, transientInvalidReasons)
  }

  private async commitCommand<Type extends FactType>(
    input: CommandCommitInput<Type>,
    transientInvalidReasons?: readonly string[],
  ): Promise<Fact> {
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
        await this.store.putObject(object.id, object.bytes, object.domain ?? 'object')
      }

      if (transientInvalidReasons !== undefined) {
        await this.projectTaskRuns([...this.factsValue, sealFact(unsealed)], transientInvalidReasons)
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

  private async projectTaskRuns(
    facts: readonly Fact[],
    transientInvalidReasons: readonly string[],
  ): Promise<TaskRunState> {
    const contracts = new Map<string, TaskContract>()
    const methods = new Map<string, MethodRevision>()
    const compositions = new Map<string, Composition>()
    const load = async (ref: Ref, domain: CasDigestDomain) =>
      parseJsonText(new TextDecoder('utf-8', { fatal: true }).decode((await this.readObject(ref, domain)).bytes))
    for (const fact of facts) {
      const admitted = fact.type === 'task/admitted'
        ? [parseProtocolValue(taskContractSchema, await load(fact.data.contract, 'contract'))]
        : fact.type === 'task/children-admitted' ? fact.data.children.map(child => child.contract) : []
      for (const contract of admitted) {
        contracts.set(fact.type === 'task/admitted' ? fact.data.contract.id : contract.taskId, contract)
        methods.set(contract.method.id, parseProtocolValue(methodRevisionSchema, await load(contract.method, 'method')))
      }
      if (fact.type === 'run/opened') {
        compositions.set(fact.data.composition.id, parseProtocolValue(compositionSchema, await load(fact.data.composition, 'composition')))
      }
    }
    return reduceTaskRunFacts(
      facts.filter(fact => fact.type.startsWith('task/') || fact.type.startsWith('run/')),
      { contracts, methods, compositions, transientInvalidReasons },
    )
  }

  /**
   * Writes one supporting CAS object through this single writer's store.
   * Objects are immutable and content-addressed; this never appends a fact.
   */
  putObject(
    id: string,
    bytes: Uint8Array,
    domain: CasDigestDomain = 'object',
  ): Promise<Ref> {
    if (this.closed || this.closing) {
      return Promise.reject(
        new CommandServiceError('INVALID_ARGUMENT', 'CommandService is closed'),
      )
    }
    return this.store.putObject(id, bytes, domain)
  }

  /** Reads and re-verifies one CAS object without exposing a writable store. */
  readObject(
    ref: Ref,
    domain: CasDigestDomain = 'object',
  ): Promise<{ readonly bytes: Uint8Array }> {
    if (this.closed) {
      return Promise.reject(
        new CommandServiceError('INVALID_ARGUMENT', 'CommandService is closed'),
      )
    }
    return this.store.readObject(ref, domain)
  }

  /** Waits for queued commits and closes the underlying store. */
  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closing = true
    this.closePromise = this.enqueue(async () => {
      this.closed = true
      await this.store.close()
      activeWriterRoots.delete(this.root)
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

function normalizeRoot(root: unknown): string {
  if (typeof root !== 'string' || root.length === 0) {
    throw new CommandServiceError('INVALID_ARGUMENT', 'CommandService root must be a non-empty path')
  }
  return resolve(root)
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
