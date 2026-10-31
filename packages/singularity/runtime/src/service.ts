import { mkdir,realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import type {
Composition,
DomainState,
Fact,
FactActor,
FactPayloadMap,
FactType,
GlobalResourceSnapshot,
MethodRevision,
MethodRoundState,
NormalizedCommand,
Ref,
RoundPlan,
TaskContract,
TaskRunState,
UnsealedFact,
} from '@singularity/protocol'
import {
compositionSchema,
computeCommandDigest,
factActorSchema,
globalResourceSnapshotSchema,
methodRevisionSchema,
parseJsonText,
parseNormalizedCommand,
parseProtocolValue,
reduceDomainFacts,
roundPlanSchema,
taskContractSchema,
unsealedFactSchema,
} from '@singularity/protocol'

import { DecomposeError } from './errors.ts'
import type { CasDigestDomain } from './store.ts'
import { DomainStore } from './store.ts'

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
  /** Frozen domain retry policy supplied by the host, shared by every facet. */
  readonly transientInvalidReasons?: readonly string[]
}

export interface CommandCommitInput<Type extends FactType = FactType> {
  readonly command: NormalizedCommand
  readonly type: Type
  readonly data: FactPayloadMap[Type]
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
 * `open` claims process-local writer ownership for the canonical root, reads archived events, and queries SQLite for command identity. A second live
 * service for the same root rejects with `WRITER_ALREADY_OPEN`; a successful
 * close releases ownership. Callers write supporting CAS objects through
 * `putObject` before invoking `commit`, which serializes every command and
 * appends exactly one fact after a SQLite transaction. A repeated commandId with the same
 * commandDigest returns the original fact without appending; a different
 * digest rejects with `IDEMPOTENCY_CONFLICT`.
 */
export class CommandService {
  private readonly store: DomainStore
  private readonly root: string
  private readonly actor: FactActor
  private readonly clock: () => number
  private readonly transientInvalidReasons: readonly string[] | undefined
  private stateCache: { readonly facts: readonly Fact[]; readonly policy: string; readonly state: DomainState } | undefined
  private readonly objectValues = new Map<string, Promise<unknown>>()
  private factsValue: readonly Fact[]
  private pending: Promise<void> = Promise.resolve()
  private closed = false
  private closing = false
  private closePromise: Promise<void> | undefined

  private constructor(
    store: DomainStore,
    root: string,
    actor: FactActor,
    clock: () => number,
    transientInvalidReasons: readonly string[] | undefined,
    facts: readonly Fact[],
  ) {
    this.store = store
    this.root = root
    this.actor = actor
    this.clock = clock
    this.transientInvalidReasons = transientInvalidReasons
    this.factsValue = facts
  }

  /** Opens the event archive and claims this process execution root. */
  static async open(options: CommandServiceOptions): Promise<CommandService> {
    const transientInvalidReasons = options.transientInvalidReasons
    if (typeof options.clock !== 'function') {
      throw new CommandServiceError('INVALID_ARGUMENT', 'CommandService clock must be a function')
    }
    if (options.transientInvalidReasons !== undefined
      && (!Array.isArray(options.transientInvalidReasons)
        || options.transientInvalidReasons.some(reason => typeof reason !== 'string' || reason.length === 0))) {
      throw new CommandServiceError('INVALID_ARGUMENT', 'Transient invalid reasons must be nonempty strings')
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
      store.claimWriter()
      return new CommandService(
        store,
        root,
        actor,
        options.clock,
        transientInvalidReasons === undefined ? undefined : Object.freeze([...transientInvalidReasons]),
        store.facts(),
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

  /** A configured host policy cannot be replaced by a per-call legacy list. */
  retryPolicy(explicit?: readonly string[]): readonly string[] {
    return this.transientInvalidReasons ?? explicit ?? []
  }

  /**
   * Commits one normalized command as exactly one fact.
   *
   * The command and fact are validated before commit; the returned fact exists
   * only after transaction commit. Supporting CAS objects must already be written
   * through `putObject`.
   */
  async commit<Type extends FactType>(
    input: CommandCommitInput<Type>,
    transientInvalidReasons?: readonly string[],
    canOpenRun?: () => boolean,
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

      const existing = this.store.factByCommandId(command.commandId)
      if (existing?.commandDigest === commandDigest) return existing
      if (existing !== undefined) {
        throw new CommandServiceError(
          'IDEMPOTENCY_CONFLICT',
          `Command ${JSON.stringify(command.commandId)} was committed with a different digest`,
        )
      }
      if (input.type === 'run/opened' && canOpenRun !== undefined && !canOpenRun()) {
        throw new DecomposeError('LIMIT_EXCEEDED', 'evaluation run budget exhausted')
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

      const policy = this.retryPolicy(transientInvalidReasons)
      let state: DomainState | undefined
      const fact = await this.store.appendFact(unsealed, async candidate => {
        state = await this.projectDomain([...this.factsValue, candidate], policy)
      })
      this.factsValue = this.store.facts()
      if (state !== undefined) this.stateCache = { facts: this.factsValue, policy: JSON.stringify(policy), state }
      return fact
    })
  }

  /** Returns the sole cached Task/Run projection of committed facts and frozen CAS. */
  taskRunState(transientInvalidReasons?: readonly string[]): Promise<TaskRunState> {
    return this.domainState(transientInvalidReasons)
  }

  /** Method/Round is a facet of the same fact fold. */
  methodRoundState(transientInvalidReasons?: readonly string[]): Promise<MethodRoundState> {
    return this.domainState(transientInvalidReasons)
  }

  /** The sole domain-state entry, also used by serialized command guards. */
  domainState(transientInvalidReasons?: readonly string[]): Promise<DomainState> {
    const policy = this.retryPolicy(transientInvalidReasons)
    const key = JSON.stringify(policy)
    if (this.stateCache?.facts === this.factsValue && this.stateCache.policy === key) {
      return Promise.resolve(this.stateCache.state)
    }
    const facts = this.factsValue
    return this.projectDomain(facts, policy).then(state => {
      this.stateCache = { facts, policy: key, state }
      return state
    })
  }

  private async projectDomain(
    facts: readonly Fact[],
    transientInvalidReasons: readonly string[],
  ): Promise<DomainState> {
    const contracts = new Map<string, TaskContract>()
    const methods = new Map<string, MethodRevision>()
    const compositions = new Map<string, Composition>()
    const plans = new Map<string, RoundPlan>()
    const explorations = new Map<string, GlobalResourceSnapshot>()
    const load = (ref: Ref, domain: CasDigestDomain): Promise<unknown> => {
      const key = `${domain}:${ref.digest}`
      let value = this.objectValues.get(key)
      if (value === undefined) {
        value = this.readObject(ref, domain).then(result =>
          parseJsonText(new TextDecoder('utf-8', { fatal: true }).decode(result.bytes)))
        this.objectValues.set(key, value)
      }
      return value
    }
    for (const fact of facts) {
      const admitted = fact.type === 'task/admitted'
        ? [parseProtocolValue(taskContractSchema, await load(fact.data.contract, 'contract'))]
        : fact.type === 'task/children-admitted' ? fact.data.children.map(child => child.contract) : []
      for (const contract of admitted) {
        contracts.set(fact.type === 'task/admitted' ? fact.data.contract.id : contract.taskId, contract)
        methods.set(contract.method.id, parseProtocolValue(methodRevisionSchema, await load(contract.method, 'method')))
        if (contract.resources.exploration !== undefined) {
          const ref = contract.resources.exploration
          explorations.set(ref.digest, parseProtocolValue(globalResourceSnapshotSchema, await load(ref, 'object')))
        }
      }
      if (fact.type === 'run/opened') {
        compositions.set(fact.data.composition.id, parseProtocolValue(compositionSchema, await load(fact.data.composition, 'composition')))
      }
      const revision = fact.type === 'method/registered' ? fact.data.revision
        : fact.type === 'rsi/candidate-ready' ? fact.data.candidateMethod : undefined
      if (revision !== undefined) methods.set(revision.id, parseProtocolValue(methodRevisionSchema, await load(revision, 'method')))
      if (fact.type === 'rsi/round-opened') plans.set(fact.data.plan.id, parseProtocolValue(roundPlanSchema, await load(fact.data.plan, 'round-plan')))
    }
    return reduceDomainFacts(facts, { contracts, methods, compositions, explorations, plans, transientInvalidReasons })
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
      try { await this.store.close() } finally { activeWriterRoots.delete(this.root) }
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
