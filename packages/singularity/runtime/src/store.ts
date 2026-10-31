import { randomUUID } from 'node:crypto'
import { access,link,mkdir,readFile,unlink,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { Digest,DigestDomain,Fact,JsonValue,Ref,UnsealedFact } from '@singularity/protocol'
import {
computeDigest,computeDigestBytes,digestSchema,factSchema,parseJsonText,
parseProtocolValue,refSchema,sealFact
} from '@singularity/protocol'

export const DATABASE_FILENAME = 'domain.sqlite'
/** The process identity is never recovered or cleared. Old roots are archives. */
const processOwner = randomUUID()
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

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
  | 'ARCHIVE_READ_ONLY'
  | 'OBJECT_MISSING'
  | 'OBJECT_CORRUPT'
  | 'OBJECT_DOMAIN_MISMATCH'

/** Storage errors are host failures, never model feedback. */
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

/** SQLite owns event atomicity and uniqueness; DSH owns session persistence. */
export class DomainStore {
  readonly root: string
  readonly databasePath: string
  readonly objectsPath: string
  private readonly database: DatabaseSync
  private factsValue: readonly Fact[]
  private closed = false
  private writerClaimed = false
  private pending: Promise<void> = Promise.resolve()

  private constructor(root: string, database: DatabaseSync) {
    this.root = root
    this.databasePath = join(root, DATABASE_FILENAME)
    this.objectsPath = join(root, OBJECTS_DIRNAME)
    this.database = database
    this.factsValue = this.readFacts()
  }

  static async open(options: DomainStoreOptions | string): Promise<DomainStore> {
    const root = resolveRoot(options)
    try {
      await access(join(root, 'journal.ndjson'))
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
      return DomainStore.openDatabase(root)
    }
    throw new DomainStoreError('ARCHIVE_READ_ONLY', 'Legacy NDJSON roots are archives; use a fresh execution root')
  }

  private static async openDatabase(root: string): Promise<DomainStore> {
    await mkdir(join(root, OBJECTS_DIRNAME), { recursive: true })
    const database = new DatabaseSync(join(root, DATABASE_FILENAME))
    try {
      database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY CHECK(seq >= 0),
          command_id TEXT NOT NULL UNIQUE,
          command_digest TEXT NOT NULL,
          payload TEXT NOT NULL CHECK(json_valid(payload))
        );`)
      return new DomainStore(root, database)
    } catch (error) {
      database.close()
      throw error
    }
  }

  /** Claim once per process; an archive cannot become a new execution root. */
  claimWriter(): void {
    this.assertOpen()
    if (this.writerClaimed) return
    this.database.prepare('INSERT OR IGNORE INTO metadata VALUES (?, ?)').run('process-owner', processOwner)
    const owner = this.database.prepare('SELECT value FROM metadata WHERE key = ?').get('process-owner')
    if (owner?.['value'] !== processOwner) {
      throw new DomainStoreError('ARCHIVE_READ_ONLY', 'Execution roots cannot be reopened by another process; use a fresh root')
    }
    this.writerClaimed = true
  }

  facts(): readonly Fact[] { return this.factsValue }

  /** Read archived events. This does not repair files or resume execution. */
  replay(): Promise<Fact[]> {
    this.assertOpen()
    return Promise.resolve(this.readFacts())
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

  /** Trusted bytes are written once. A failed write aborts this process run. */
  putObject(id: string, bytes: Uint8Array, domain: CasDigestDomain = 'object'): Promise<Ref> {
    return this.enqueue(async () => {
      this.claimWriter()
      assertCasDigestDomain(domain)
      if (typeof id !== 'string' || id.length === 0 || !(bytes instanceof Uint8Array)) {
        throw new DomainStoreError('INVALID_ARGUMENT', 'Expected an object id and bytes')
      }
      const data = new Uint8Array(bytes)
      const digest = digestForBytes(domain, data)
      const path = this.objectPath(digest)
      const temporary = join(this.objectsPath, `.${randomUUID()}.tmp`)
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
      try {
        try {
          // Publish the complete file atomically without replacing an existing object.
          await link(temporary, path)
        } catch (error) {
          if (!isErrno(error, 'EEXIST')) throw error
          await readVerifiedObject(this.objectsPath, { id, digest }, domain)
        }
      } finally {
        await unlink(temporary)
      }
      return { id, digest }
    })
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

  /** SQLite's unique command index is the only idempotency index. */
  factByCommandId(commandId: string): Fact | undefined {
    this.assertOpen()
    const row = this.database.prepare('SELECT payload FROM events WHERE command_id = ?').get(commandId)
    return row === undefined ? undefined : parseProtocolValue(factSchema, JSON.parse(String(row['payload'])))
  }

  /** The serialized writer supplies the mandatory business guard inside the transaction. */
  appendFact(fact: UnsealedFact, guard: (candidate: Fact) => Promise<void>): Promise<Fact> {
    return this.enqueue(async () => {
      this.claimWriter()
      const sealed = sealFact(fact)
      this.database.exec('BEGIN IMMEDIATE')
      try {
        if (sealed.seq !== this.factsValue.length || sealed.prev !== (this.factsValue.at(-1)?.digest ?? null)) {
          throw new DomainStoreError('INVALID_ARGUMENT', 'Event sequence does not extend this writer')
        }
        await guard(sealed)
        this.database.prepare('INSERT INTO events VALUES (?, ?, ?, ?)')
          .run(sealed.seq, sealed.commandId, sealed.commandDigest, JSON.stringify(sealed))
        this.database.exec('COMMIT')
        this.factsValue = [...this.factsValue, sealed]
        return sealed
      } catch (error) {
        this.database.exec('ROLLBACK')
        throw error
      }
    })
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.pending.then(action)
    this.pending = operation.then(() => undefined, () => undefined)
    return operation
  }

  async close(): Promise<void> {
    await this.pending
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new DomainStoreError('JOURNAL_CLOSED', 'Domain store is closed')
  }

  private readFacts(): Fact[] {
    return this.database.prepare('SELECT payload FROM events ORDER BY seq').all()
      .map(row => parseProtocolValue(factSchema, JSON.parse(String(row['payload']))))
  }
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
