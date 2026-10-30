import { randomUUID } from 'node:crypto'
import { mkdir, open as openFile, readFile, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  JournalError,
  canonicalize,
  computeDigestBytes,
  digestSchema,
  parseProtocolValue,
  refSchema,
  replayJournal,
  sealFact,
  verifyFact,
} from '@singularity/protocol'
import type { Digest, Fact, Ref, UnsealedFact } from '@singularity/protocol'

/** Journal file name inside the store root. */
export const JOURNAL_FILENAME = 'journal.ndjson'

/** CAS object directory name inside the store root. */
export const OBJECTS_DIRNAME = 'objects'

export type DomainStoreErrorCode =
  | 'INVALID_ARGUMENT'
  | 'JOURNAL_CLOSED'
  | 'JOURNAL_INVALID_UTF8'
  | 'OBJECT_MISSING'
  | 'OBJECT_CORRUPT'

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
  async putObject(id: string, bytes: Uint8Array): Promise<Ref> {
    if (typeof id !== 'string' || id.length === 0 || !id.isWellFormed()) {
      throw new DomainStoreError('INVALID_ARGUMENT', 'Object id must be a non-empty string')
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new DomainStoreError('INVALID_ARGUMENT', 'Object bytes must be a Uint8Array')
    }

    const data = new Uint8Array(bytes)
    const digest = computeDigestBytes('object', data)
    const finalPath = this.objectPath(digest)
    const existing = await readIfPresent(finalPath)
    if (existing !== undefined) {
      if (computeDigestBytes('object', existing) !== digest) {
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
      if (computeDigestBytes('object', persisted) !== digest) {
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

  /** Reads raw bytes and re-verifies the supplied ref digest before returning. */
  async readObject(objectRef: Ref): Promise<{ bytes: Uint8Array }> {
    let parsed: Ref
    try {
      parsed = parseProtocolValue(refSchema, objectRef)
    } catch (error) {
      throw new DomainStoreError('INVALID_ARGUMENT', 'Object ref is not a valid ref', {
        cause: error,
      })
    }

    const bytes = await readIfPresent(this.objectPath(parsed.digest))
    if (bytes === undefined) {
      throw new DomainStoreError('OBJECT_MISSING', `CAS object ${parsed.digest} does not exist`)
    }
    if (computeDigestBytes('object', bytes) !== parsed.digest) {
      throw new DomainStoreError('OBJECT_CORRUPT', `CAS object ${parsed.digest} does not match its digest`)
    }
    return { bytes: new Uint8Array(bytes) }
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
