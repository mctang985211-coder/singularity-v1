import { randomUUID } from 'node:crypto'
import { mkdir, open as openFile, readFile, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  JournalError,
  canonicalize,
  computeDigest,
  computeDigestBytes,
  digestSchema,
  parseJsonText,
  parseProtocolValue,
  refSchema,
  replayJournal,
  sealFact,
  verifyDigest,
  verifyFact,
  compositionPayloadSchema,
  compositionSchema,
  executionRecordPayloadSchema,
  executionRecordSchema,
  evidenceSchema,
  publicReceiptSchema,
  submissionManifestSchema,
  methodRevisionPayloadSchema,
  methodRevisionSchema,
  taskContractPayloadSchema,
  taskContractSchema,
} from '@singularity/protocol'
import type {
  Composition,
  CompositionPayload,
  Digest,
  DigestDomain,
  ExecutionRecord,
  ExecutionRecordPayload,
  Fact,
  JsonValue,
  MethodRevision,
  MethodRevisionPayload,
  Ref,
  TaskContract,
  TaskContractPayload,
  UnsealedFact,
} from '@singularity/protocol'

import type { SealedTreeManifest } from './workspace.ts'

/** Journal file name inside the store root. */
export const JOURNAL_FILENAME = 'journal.ndjson'

/** CAS object directory name inside the store root. */
export const OBJECTS_DIRNAME = 'objects'

/** Digest domains that address CAS objects; `fact` and `command` do not. */
export const CAS_DIGEST_DOMAINS = [
  'object',
  'contract',
  'method',
  'composition',
  'evidence',
  'round-plan',
  'preview',
] as const satisfies readonly DigestDomain[]

export type CasDigestDomain = (typeof CAS_DIGEST_DOMAINS)[number]

export type DomainStoreErrorCode =
  | 'INVALID_ARGUMENT'
  | 'JOURNAL_CLOSED'
  | 'JOURNAL_INVALID_UTF8'
  | 'OBJECT_MISSING'
  | 'OBJECT_CORRUPT'
  | 'OBJECT_DOMAIN_MISMATCH'
  | 'REFERENCE_INVALID'

/** Stable storage failures; journal replay also throws protocol `JournalError`. */
export class DomainStoreError extends Error {
  override readonly name = 'DomainStoreError'
  readonly code: DomainStoreErrorCode

  constructor(code: DomainStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

export interface DomainStoreOptions {
  readonly root: string
}

interface JournalImage {
  readonly facts: readonly Fact[]
  readonly tornTail: string | undefined
  readonly committedBytes: number
}

interface DomainStoreState {
  readonly root: string
  readonly journalPath: string
  readonly objectsPath: string
  readonly journal: FileHandle
  readonly facts: readonly Fact[]
  readonly tornTail: string | undefined
  readonly committedBytes: number
}

const textEncoder = new TextEncoder()
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const looseUtf8 = new TextDecoder('utf-8', { ignoreBOM: true })

const casDigestDomainSet = new Set<string>(CAS_DIGEST_DOMAINS)

function isCasDigestDomain(value: unknown): value is CasDigestDomain {
  return typeof value === 'string' && casDigestDomainSet.has(value)
}

function assertCasDigestDomain(value: unknown): asserts value is CasDigestDomain {
  if (!isCasDigestDomain(value)) {
    throw new DomainStoreError(
      'INVALID_ARGUMENT',
      `Unsupported CAS digest domain ${JSON.stringify(value)}`,
    )
  }
}

interface SealedObject {
  readonly digest: Digest
  readonly value: JsonValue
}

function parseJsonBytes(bytes: Uint8Array): JsonValue | undefined {
  let text: string
  try {
    text = strictUtf8.decode(bytes)
  } catch {
    return undefined
  }
  try {
    return parseJsonText(text)
  } catch {
    return undefined
  }
}

/**
 * Detects a sealed structured object whose self digest is valid under the
 * requested domain. Raw bytes and unsealed payloads return undefined.
 */
function parseSealedObject(domain: CasDigestDomain, bytes: Uint8Array): SealedObject | undefined {
  const value = parseJsonBytes(bytes)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const digest: unknown = (value as { readonly digest?: unknown }).digest
  if (typeof digest !== 'string' || !digestSchema.safeParse(digest).success) return undefined
  try {
    if (computeDigest(domain, value) !== digest) return undefined
  } catch {
    return undefined
  }
  return { digest, value }
}

/**
 * Structured objects use their self digest (JCS without the outermost digest);
 * raw payload bytes use the raw-byte digest. Both are the same for an unsealed
 * canonical payload, so callers can use either representation.
 */
function digestForBytes(domain: CasDigestDomain, bytes: Uint8Array): Digest {
  return parseSealedObject(domain, bytes)?.digest ?? computeDigestBytes(domain, bytes)
}

function bytesMatchDigest(domain: CasDigestDomain, bytes: Uint8Array, expected: Digest): boolean {
  if (computeDigestBytes(domain, bytes) === expected) return true
  return parseSealedObject(domain, bytes)?.digest === expected
}

function findMatchingDomain(bytes: Uint8Array, expected: Digest): CasDigestDomain | undefined {
  for (const domain of CAS_DIGEST_DOMAINS) {
    if (bytesMatchDigest(domain, bytes, expected)) return domain
  }
  return undefined
}

async function readVerifiedObject(
  objectsPath: string,
  ref: Ref,
  domain: CasDigestDomain,
): Promise<Uint8Array> {
  const path = join(objectsPath, ref.digest.slice('sha256:'.length))
  const bytes = await readIfPresent(path)
  if (bytes === undefined) {
    throw new DomainStoreError('OBJECT_MISSING', `CAS object ${ref.digest} does not exist`)
  }
  if (bytesMatchDigest(domain, bytes, ref.digest)) {
    return new Uint8Array(bytes)
  }
  const actualDomain = findMatchingDomain(bytes, ref.digest)
  if (actualDomain !== undefined) {
    throw new DomainStoreError(
      'OBJECT_DOMAIN_MISMATCH',
      `CAS object ${ref.digest} is ${actualDomain}, not ${domain}`,
    )
  }
  throw new DomainStoreError(
    'OBJECT_CORRUPT',
    `CAS object ${ref.digest} does not match its ${domain} digest`,
  )
}

/**
 * One filesystem domain store: a single JCS NDJSON journal plus a raw-byte CAS.
 *
 * The store owns journal framing and durability. It deliberately does not
 * project business state, decide command idempotency, or validate fact payload
 * semantics beyond the frozen protocol schema.
 */
export class DomainStore {
  /** Resolved store root. */
  readonly root: string
  /** Absolute journal path. */
  readonly journalPath: string
  /** Absolute CAS object directory. */
  readonly objectsPath: string

  private readonly journal: FileHandle
  private pending: Promise<void> = Promise.resolve()
  private factsValue: readonly Fact[]
  private commandIds: Set<string>
  private tail: string | undefined
  private committedBytes: number
  private closed = false
  private closePromise: Promise<void> | undefined

  private constructor(state: DomainStoreState) {
    this.root = state.root
    this.journalPath = state.journalPath
    this.objectsPath = state.objectsPath
    this.journal = state.journal
    this.factsValue = state.facts
    this.commandIds = new Set(state.facts.map((fact) => fact.commandId))
    this.tail = state.tornTail
    this.committedBytes = state.committedBytes
  }

  /**
   * Opens the store root, replays committed facts, and truncates only an
   * unterminated EOF tail. Middle corruption rejects the open.
   */
  static async open(options: DomainStoreOptions | string): Promise<DomainStore> {
    const root = resolveRoot(options)
    await mkdir(root, { recursive: true })
    const objectsPath = join(root, OBJECTS_DIRNAME)
    await mkdir(objectsPath, { recursive: true })
    const journalPath = join(root, JOURNAL_FILENAME)
    const journal = await openFile(journalPath, 'a+')

    try {
      await syncDirectory(root)
      const image = await readJournalImage(journalPath)
      if (image.tornTail !== undefined) {
        await journal.truncate(image.committedBytes)
        await journal.sync()
      }
      await validateFactReferences(image.facts, objectsPath)
      return new DomainStore({
        root,
        journalPath,
        objectsPath,
        journal,
        facts: image.facts,
        tornTail: image.tornTail,
        committedBytes: image.committedBytes,
      })
    } catch (error) {
      await journal.close().catch(() => undefined)
      throw error
    }
  }

  /** Verified facts from open, replay, and successful appends. */
  facts(): readonly Fact[] {
    return this.factsValue
  }

  /** Text of the last unterminated EOF tail discarded by open or replay. */
  tornTail(): string | undefined {
    return this.tail
  }

  /** Absolute path of one object digest inside the CAS directory. */
  objectPath(digest: Digest): string {
    try {
      digestSchema.parse(digest)
    } catch (error) {
      throw new DomainStoreError('INVALID_ARGUMENT', 'Object digest is not a valid digest', {
        cause: error,
      })
    }
    return join(this.objectsPath, digest.slice('sha256:'.length))
  }

  /**
   * Writes raw bytes through a synced temp file, re-verifies the persisted
   * digest, atomically renames into the CAS, and fsyncs the directory.
   */
  async putObject(
    id: string,
    bytes: Uint8Array,
    domain: CasDigestDomain = 'object',
  ): Promise<Ref> {
    assertCasDigestDomain(domain)
    if (typeof id !== 'string' || id.length === 0 || !id.isWellFormed()) {
      throw new DomainStoreError('INVALID_ARGUMENT', 'Object id must be a non-empty string')
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new DomainStoreError('INVALID_ARGUMENT', 'Object bytes must be a Uint8Array')
    }

    const data = new Uint8Array(bytes)
    const digest = digestForBytes(domain, data)
    const finalPath = this.objectPath(digest)
    const existing = await readIfPresent(finalPath)
    if (existing !== undefined) {
      if (!bytesMatchDigest(domain, existing, digest)) {
        throw new DomainStoreError('OBJECT_CORRUPT', `CAS object ${digest} has different bytes`)
      }
      return { id, digest }
    }

    const temporaryPath = join(this.objectsPath, `.tmp-${randomUUID()}`)
    let renamed = false
    try {
      const handle = await openFile(temporaryPath, 'wx', 0o600)
      try {
        await handle.writeFile(data)
        await handle.sync()
      } finally {
        await handle.close()
      }

      const persisted = await readFile(temporaryPath)
      if (!bytesMatchDigest(domain, persisted, digest)) {
        throw new DomainStoreError('OBJECT_CORRUPT', 'CAS temporary object does not match its digest')
      }

      await rename(temporaryPath, finalPath)
      renamed = true
      await syncDirectory(this.objectsPath)
      return { id, digest }
    } finally {
      if (!renamed) {
        await unlink(temporaryPath).catch(() => undefined)
      }
    }
  }

  /** Reads raw bytes and re-verifies the supplied ref digest under `domain`. */
  async readObject(
    objectRef: Ref,
    domain: CasDigestDomain = 'object',
  ): Promise<{ bytes: Uint8Array }> {
    assertCasDigestDomain(domain)
    let parsed: Ref
    try {
      parsed = parseProtocolValue(refSchema, objectRef)
    } catch (error) {
      throw new DomainStoreError('INVALID_ARGUMENT', 'Object ref is not a valid ref', {
        cause: error,
      })
    }

    return { bytes: await readVerifiedObject(this.objectsPath, parsed, domain) }
  }

  /**
   * Appends one fact after validating its seq, prev link, and command identity.
   * Success is returned only after the complete LF-terminated line is fsynced.
   */
  appendFact(fact: UnsealedFact): Promise<Fact> {
    return this.enqueue(async () => {
      if (this.closed) {
        throw new DomainStoreError('JOURNAL_CLOSED', 'Domain store is closed')
      }

      const line = this.factsValue.length + 1
      let sealed: Fact
      try {
        sealed = sealFact(fact)
      } catch (error) {
        throw new JournalError('JOURNAL_INVALID_FACT', line, 'Appended value is not an unsealed fact', {
          cause: error,
        })
      }

      if (sealed.seq !== this.factsValue.length) {
        throw new JournalError(
          'JOURNAL_SEQ_MISMATCH',
          line,
          `Expected seq ${String(this.factsValue.length)}, found ${String(sealed.seq)}`,
        )
      }
      const previousDigest = this.factsValue.at(-1)?.digest ?? null
      if (sealed.prev !== previousDigest) {
        throw new JournalError(
          'JOURNAL_PREV_MISMATCH',
          line,
          'Fact prev does not match the previous fact digest',
        )
      }
      if (this.commandIds.has(sealed.commandId)) {
        throw new JournalError(
          'JOURNAL_COMMAND_ID_DUPLICATE',
          line,
          `Duplicate commandId ${JSON.stringify(sealed.commandId)}`,
        )
      }
      if (!verifyFact(sealed)) {
        throw new JournalError(
          'JOURNAL_FACT_DIGEST_MISMATCH',
          line,
          'Fact digest does not match its payload',
        )
      }

      // Reuse the same domain-aware reference validator as open/replay so the
      // commit point never appends a fact whose mapped CAS refs are missing,
      // wrong-domain, or corrupt. Validation completes before any journal write.
      await validateFactReferences([sealed], this.objectsPath)

      const encoded = textEncoder.encode(`${canonicalize(sealed)}\n`)
      const previousBytes = this.committedBytes
      try {
        await this.journal.writeFile(encoded)
        await this.journal.sync()
      } catch (error) {
        await this.rollbackAppend(previousBytes)
        throw error
      }

      this.committedBytes += encoded.byteLength
      this.factsValue = [...this.factsValue, sealed]
      this.commandIds.add(sealed.commandId)
      return sealed
    })
  }

  /**
   * Re-reads the journal, rejects middle corruption, truncates only an EOF
   * torn tail, and returns the verified chain.
   */
  replay(): Promise<Fact[]> {
    return this.enqueue(async () => {
      if (this.closed) {
        throw new DomainStoreError('JOURNAL_CLOSED', 'Domain store is closed')
      }

      const image = await readJournalImage(this.journalPath)
      if (image.tornTail !== undefined) {
        await this.journal.truncate(image.committedBytes)
        await this.journal.sync()
      }
      await validateFactReferences(image.facts, this.objectsPath)
      this.committedBytes = image.committedBytes
      this.tail = image.tornTail ?? this.tail
      this.factsValue = image.facts
      this.commandIds = new Set(image.facts.map((fact) => fact.commandId))
      return [...image.facts]
    })
  }

  /** Waits for queued journal operations and closes the append handle. */
  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closePromise = this.enqueue(async () => {
      this.closed = true
      await this.journal.close()
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

  private async rollbackAppend(previousBytes: number): Promise<void> {
    try {
      await this.journal.truncate(previousBytes)
      await this.journal.sync()
    } catch {
      this.closed = true
      await this.journal.close().catch(() => undefined)
    }
  }
}

type StructuredKind = 'task-contract' | 'method-revision' | 'composition' | 'execution-record'
  | 'evidence' | 'submission-manifest' | 'public-receipt'

async function validateFactReferences(facts: readonly Fact[], objectsPath: string): Promise<void> {
  const validator = new ReferenceValidator(objectsPath)
  for (const fact of facts) {
    await validator.validateFact(fact)
  }
}

/**
 * Validates every mapped fact/object ref against the CAS. This checks existence
 * and digest domain only; it does not project business state or re-run guards.
 * Frozen S3 structures use protocol schemas. Acceptance/private receipt bytes,
 * RoundPlan and preview objects remain opaque; their refs still verify integrity.
 */
class ReferenceValidator {
  private readonly objectsPath: string
  private readonly verifiedBytes = new Map<string, Promise<Uint8Array>>()
  private readonly validatedStructures = new Set<string>()

  constructor(objectsPath: string) {
    this.objectsPath = objectsPath
  }

  async validateFact(fact: Fact): Promise<void> {
    switch (fact.type) {
      case 'method/registered': {
        await this.validateStructured(fact.data.revision, 'method', 'method-revision')
        if (fact.data.parent !== undefined) {
          await this.validateStructured(fact.data.parent, 'method', 'method-revision')
        }
        if (fact.data.sourceProposal !== undefined) {
          await this.validateRef(fact.data.sourceProposal, 'object')
        }
        return
      }
      case 'method/activated': {
        if (fact.data.expectedPrevious !== undefined) {
          await this.validateStructured(fact.data.expectedPrevious, 'method', 'method-revision')
        }
        if (fact.data.previous !== undefined) {
          await this.validateStructured(fact.data.previous, 'method', 'method-revision')
        }
        await this.validateStructured(fact.data.next, 'method', 'method-revision')
        await this.validateRef(fact.data.approval, 'object')
        if (fact.data.evaluationRef !== undefined) {
          await this.validateRef(fact.data.evaluationRef, 'object')
        }
        return
      }
      case 'task/admitted': {
        await this.validateStructured(fact.data.contract, 'contract', 'task-contract')
        return
      }
      case 'run/opened': {
        await this.validateStructured(fact.data.composition, 'composition', 'composition')
        await this.validateRef(fact.data.workspaceSeed, 'object')
        return
      }
      case 'task/children-admitted': {
        for (const child of fact.data.children) {
          if (!verifyDigest('contract', child.contract)) {
            throw referenceInvalid('Inline TaskContract digest is invalid')
          }
          await this.validateTaskContractValue(child.contract)
          if (child.replacement !== undefined) {
            await this.validateRef(child.replacement.feedbackRef, 'object')
          }
        }
        return
      }
      case 'run/submitted': {
        await this.validateStructured(fact.data.outputs, 'object', 'submission-manifest')
        for (const receipt of fact.data.previewReceipts) {
          await this.validateRef(receipt, 'object')
        }
        for (const receipt of fact.data.readReceipts) {
          await this.validateRef(receipt, 'object')
        }
        await this.validateRef(fact.data.planningSketchRef, 'object')
        for (const feedback of fact.data.feedbackRefs) {
          await this.validateRef(feedback, 'object')
        }
        return
      }
      case 'run/closed': {
        if ('evidenceRef' in fact.data) {
          await this.validateStructured(fact.data.evidenceRef, 'evidence', 'evidence')
        } else {
          await this.validateStructured(
            fact.data.executionRecordRef,
            'object',
            'execution-record',
          )
        }
        if (fact.data.planningSketchRef !== undefined) {
          await this.validateRef(fact.data.planningSketchRef, 'object')
        }
        for (const feedback of fact.data.feedbackRefs) {
          await this.validateRef(feedback, 'object')
        }
        return
      }
      case 'task/closed': {
        for (const evidence of fact.data.evidenceRefs) {
          await this.validateStructured(evidence, 'evidence', 'evidence')
        }
        if (fact.data.cancellationCutRef !== undefined) {
          await this.validateRef(fact.data.cancellationCutRef, 'object')
        }
        return
      }
      case 'rsi/trace-sealed': {
        await this.validateRef(fact.data.trace, 'object')
        return
      }
      case 'rsi/round-opened': {
        await this.validateRef(fact.data.sourceTrace, 'object')
        await this.validateStructured(fact.data.baseMethod, 'method', 'method-revision')
        await this.validateRef(fact.data.plan, 'round-plan')
        return
      }
      case 'rsi/proposal-submitted': {
        await this.validateRef(fact.data.patch, 'object')
        return
      }
      case 'rsi/candidate-ready': {
        await this.validateRef(fact.data.patch, 'object')
        await this.validateRef(fact.data.precheckReceipt, 'object')
        await this.validateStructured(fact.data.candidateMethod, 'method', 'method-revision')
        return
      }
      case 'rsi/round-closed': {
        if (fact.data.comparisonRef !== undefined) {
          await this.validateRef(fact.data.comparisonRef, 'object')
        }
        if (fact.data.precheckReceipt !== undefined) {
          await this.validateRef(fact.data.precheckReceipt, 'object')
        }
        return
      }
    }
  }

  private async validateRef(ref: Ref, domain: CasDigestDomain): Promise<void> {
    await this.read(ref, domain)
  }

  private read(ref: Ref, domain: CasDigestDomain): Promise<Uint8Array> {
    const key = `${domain}\u0000${ref.digest}`
    const existing = this.verifiedBytes.get(key)
    if (existing !== undefined) return existing
    const pending = readVerifiedObject(this.objectsPath, ref, domain)
    this.verifiedBytes.set(key, pending)
    return pending
  }

  private async validateTree(ref: Ref): Promise<void> {
    const value = parseStructuredJson((await this.read(ref, 'object')), 'tree manifest') as Partial<SealedTreeManifest>
    if (value.v !== 1 || value.kind !== 'tree' || !Array.isArray(value.files) || !verifyDigest('object', value as JsonValue)) {
      throw referenceInvalid('Tree manifest is not a valid object-domain seal')
    }
    for (const file of value.files) {
      if (typeof file !== 'object' || file === null || Array.isArray(file)) {
        throw referenceInvalid('Tree manifest file entry is invalid')
      }
      const object = (file as { readonly object?: unknown }).object
      const parsed = parseProtocolValue(refSchema, object)
      await this.validateRef(parsed, 'object')
    }
  }

  private async validateStructured(
    ref: Ref,
    domain: CasDigestDomain,
    kind: StructuredKind,
  ): Promise<void> {
    const key = `${domain}\u0000${ref.digest}\u0000${kind}`
    if (this.validatedStructures.has(key)) return

    try {
      const bytes = await this.read(ref, domain)
      switch (kind) {
        case 'task-contract': {
          await this.validateTaskContractValue(parseTaskContractBytes(bytes))
          break
        }
        case 'method-revision': {
          await this.validateMethodRevisionValue(parseMethodRevisionBytes(bytes))
          break
        }
        case 'composition': {
          await this.validateCompositionValue(parseCompositionBytes(bytes))
          break
        }
        case 'execution-record': {
          await this.validateExecutionRecordValue(parseExecutionRecordBytes(bytes))
          break
        }
        case 'submission-manifest': {
          const manifest = parseProtocolValue(submissionManifestSchema, parseSealedObject(domain, bytes)?.value)
          for (const output of [...manifest.outputs, ...manifest.learningDrafts]) {
            if (output.object !== undefined) {
              await this.validateRef(output.object, 'object')
              if (output.kind === 'tree') await this.validateTree(output.object)
            }
          }
          break
        }
        case 'evidence': {
          const evidence = parseProtocolValue(evidenceSchema, parseSealedObject(domain, bytes)?.value)
          await this.validateStructured(evidence.task, 'contract', 'task-contract')
          await this.validateStructured(evidence.method, 'method', 'method-revision')
          await this.validateStructured(evidence.composition, 'composition', 'composition')
          for (const ref of [...evidence.inputs, ...evidence.outputs]) await this.validateRef(ref, 'object')
          await this.validateRef(evidence.verification.provider, 'object')
          await this.validateStructured(evidence.verification.publicReceipt, 'object', 'public-receipt')
          if (evidence.verification.privateReceipt !== undefined) {
            await this.validateRef(evidence.verification.privateReceipt, 'object')
          }
          break
        }
        case 'public-receipt': {
          const receipt = parseProtocolValue(publicReceiptSchema, parseSealedObject(domain, bytes)?.value)
          await this.validateRef(receipt.provider, 'object')
          break
        }
      }
      this.validatedStructures.add(key)
    } catch (error) {
      if (error instanceof DomainStoreError) throw error
      throw referenceInvalid(`CAS object is not a valid ${kind}`, error)
    }
  }

  private async validateTaskContractValue(
    contract: TaskContract | TaskContractPayload,
  ): Promise<void> {
    await this.validateStructured(contract.method, 'method', 'method-revision')
    await this.validateStructured(contract.template, 'method', 'method-revision')
    for (const input of contract.spec.inputs) {
      await this.validateRef(input.object, 'object')
    }
    for (const ref of contract.resources.baseTools) {
      await this.validateRef(ref, 'object')
    }
    for (const ref of contract.resources.skills) {
      await this.validateRef(ref, 'object')
    }
    for (const ref of contract.resources.mcpServers) {
      await this.validateRef(ref, 'object')
    }
    if (contract.resources.exploration !== undefined) {
      await this.validateRef(contract.resources.exploration, 'object')
    }
    await this.validateRef(contract.environment.seed, 'object')
    await this.validateRef(contract.environment.profile, 'object')
    if (contract.origin.kind === 'root') {
      await this.validateRef(contract.origin.requestRef, 'object')
    }
    // Amendment 002 fixes AcceptanceRef in the object domain.
    await this.validateRef(contract.acceptance, 'object')
  }

  private async validateMethodRevisionValue(
    method: MethodRevision | MethodRevisionPayload,
  ): Promise<void> {
    if (method.parent !== undefined) {
      await this.validateStructured(method.parent, 'method', 'method-revision')
    }
    for (const template of method.templates) {
      await this.validateRef(template.guidance, 'object')
      await this.validateRef(template.example, 'object')
      await this.validateRef(template.acceptancePolicy, 'object')
    }
    for (const skill of method.skills) {
      await this.validateRef(skill.bundle, 'object')
    }
    for (const tool of method.tools) {
      await this.validateRef(tool.server.bundle, 'object')
      await this.validateRef(tool.server.manifest, 'object')
      await this.validateRef(tool.server.sourceFiles, 'object')
      await this.validateRef(tool.server.config, 'object')
    }
  }

  private async validateCompositionValue(
    composition: Composition | CompositionPayload,
  ): Promise<void> {
    await this.validateRef(composition.dsh.config, 'object')
    // Composition.contract carries the contract-domain id/digest compared by
    // the Task/Run reducer; it is not an object-domain copy of the contract.
    await this.validateStructured(composition.contract, 'contract', 'task-contract')
    await this.validateRef(composition.template, 'object')
    if (composition.guidance !== undefined) {
      await this.validateRef(composition.guidance, 'object')
    }
    for (const skill of composition.skills) {
      await this.validateRef(skill, 'object')
    }
    for (const server of composition.mcpServers) {
      await this.validateRef(server.manifest, 'object')
      await this.validateRef(server.bundle, 'object')
      await this.validateRef(server.schema, 'object')
      await this.validateRef(server.config, 'object')
    }
    await this.validateRef(composition.modelRoute, 'object')
    await this.validateRef(composition.resources, 'object')
    await this.validateRef(composition.seed, 'object')
  }

  private async validateExecutionRecordValue(
    record: ExecutionRecord | ExecutionRecordPayload,
  ): Promise<void> {
    await this.validateStructured(record.method, 'method', 'method-revision')
    await this.validateStructured(record.composition, 'composition', 'composition')
    for (const input of record.inputs) {
      await this.validateRef(input, 'object')
    }
    for (const output of record.outputs ?? []) {
      await this.validateRef(output, 'object')
    }
  }
}

function referenceInvalid(message: string, cause?: unknown): DomainStoreError {
  return new DomainStoreError(
    'REFERENCE_INVALID',
    message,
    cause === undefined ? undefined : { cause },
  )
}

function parseStructuredJson(bytes: Uint8Array, label: string): JsonValue {
  const value = parseJsonBytes(bytes)
  if (value === undefined) {
    throw referenceInvalid(`${label} CAS object is not strict JSON`)
  }
  return value
}

function parseTaskContractBytes(bytes: Uint8Array): TaskContract | TaskContractPayload {
  const value = parseStructuredJson(bytes, 'TaskContract')
  let full: TaskContract | undefined
  try {
    full = parseProtocolValue(taskContractSchema, value)
  } catch {
    full = undefined
  }
  if (full !== undefined) {
    if (!verifyDigest('contract', full)) throw referenceInvalid('TaskContract digest is invalid')
    return full
  }
  try {
    return parseProtocolValue(taskContractPayloadSchema, value)
  } catch (error) {
    throw referenceInvalid('CAS object is not a TaskContract', error)
  }
}

function parseMethodRevisionBytes(
  bytes: Uint8Array,
): MethodRevision | MethodRevisionPayload {
  const value = parseStructuredJson(bytes, 'MethodRevision')
  let full: MethodRevision | undefined
  try {
    full = parseProtocolValue(methodRevisionSchema, value)
  } catch {
    full = undefined
  }
  if (full !== undefined) {
    if (!verifyDigest('method', full)) throw referenceInvalid('MethodRevision digest is invalid')
    return full
  }
  try {
    return parseProtocolValue(methodRevisionPayloadSchema, value)
  } catch (error) {
    throw referenceInvalid('CAS object is not a MethodRevision', error)
  }
}

function parseCompositionBytes(bytes: Uint8Array): Composition | CompositionPayload {
  const value = parseStructuredJson(bytes, 'Composition')
  let full: Composition | undefined
  try {
    full = parseProtocolValue(compositionSchema, value)
  } catch {
    full = undefined
  }
  if (full !== undefined) {
    if (!verifyDigest('composition', full)) throw referenceInvalid('Composition digest is invalid')
    return full
  }
  try {
    return parseProtocolValue(compositionPayloadSchema, value)
  } catch (error) {
    throw referenceInvalid('CAS object is not a Composition', error)
  }
}

function parseExecutionRecordBytes(
  bytes: Uint8Array,
): ExecutionRecord | ExecutionRecordPayload {
  const value = parseStructuredJson(bytes, 'ExecutionRecord')
  let full: ExecutionRecord | undefined
  try {
    full = parseProtocolValue(executionRecordSchema, value)
  } catch {
    full = undefined
  }
  if (full !== undefined) {
    if (!verifyDigest('object', full)) throw referenceInvalid('ExecutionRecord digest is invalid')
    return full
  }
  try {
    return parseProtocolValue(executionRecordPayloadSchema, value)
  } catch (error) {
    throw referenceInvalid('CAS object is not an ExecutionRecord', error)
  }
}

async function readJournalImage(journalPath: string): Promise<JournalImage> {
  let bytes: Buffer
  try {
    bytes = await readFile(journalPath)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return { facts: [], tornTail: undefined, committedBytes: 0 }
    }
    throw error
  }

  let committedBytes = bytes.byteLength
  let tornTail: string | undefined
  if (committedBytes > 0 && bytes[committedBytes - 1] !== 0x0a) {
    const lastLf = bytes.lastIndexOf(0x0a)
    committedBytes = lastLf < 0 ? 0 : lastLf + 1
    tornTail = looseUtf8.decode(bytes.subarray(committedBytes))
  } else {
    tornTail = undefined
  }

  let committedText: string
  try {
    committedText = strictUtf8.decode(bytes.subarray(0, committedBytes))
  } catch (error) {
    throw new DomainStoreError(
      'JOURNAL_INVALID_UTF8',
      'Committed journal bytes are not valid UTF-8',
      { cause: error },
    )
  }

  const replay = replayJournal(committedText)
  return { facts: replay.facts, tornTail, committedBytes }
}

function resolveRoot(options: DomainStoreOptions | string): string {
  const root = typeof options === 'string' ? options : options.root
  if (typeof root !== 'string' || root.length === 0) {
    throw new DomainStoreError('INVALID_ARGUMENT', 'Domain store root must be a non-empty path')
  }
  return resolve(root)
}

async function readIfPresent(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw error
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  )
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await openFile(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
