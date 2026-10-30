import { factSchema, verifyFact } from './fact.ts'
import type { Fact } from './fact.ts'
import { canonicalize, parseJsonText } from './json.ts'
import type { JsonValue } from './json.ts'

/**
 * Stable journal framing and replay rejection codes. Consumers branch on
 * these values; messages are diagnostics only.
 */
export type JournalErrorCode =
  | 'JOURNAL_BOM'
  | 'JOURNAL_CR'
  | 'JOURNAL_EMPTY_LINE'
  | 'JOURNAL_WHITESPACE'
  | 'JOURNAL_INVALID_JSON'
  | 'JOURNAL_NON_CANONICAL'
  | 'JOURNAL_INVALID_FACT'
  | 'JOURNAL_FACT_DIGEST_MISMATCH'
  | 'JOURNAL_SEQ_MISMATCH'
  | 'JOURNAL_PREV_MISMATCH'
  | 'JOURNAL_COMMAND_ID_DUPLICATE'

/** A journal framing or replay failure with its one-based committed line. */
export class JournalError extends Error {
  override readonly name = 'JournalError'
  readonly code: JournalErrorCode
  /** One-based line number in the committed part of the journal. */
  readonly line: number

  constructor(code: JournalErrorCode, line: number, message: string, options?: ErrorOptions) {
    super(`${message} (journal line ${String(line)})`, options)
    this.code = code
    this.line = line
  }
}

/** Result of replaying a journal text. */
export interface JournalReplay {
  /** Facts from LF-terminated lines, already chain-verified. */
  readonly facts: readonly Fact[]
  /**
   * Unterminated trailing segment that was not committed. It is always
   * discarded, even when it happens to be complete canonical JSON.
   */
  readonly tornTail: string
}

/**
 * Reads a UTF-8 journal text as JCS NDJSON.
 *
 * Every LF-terminated line must be one canonical fact. The final segment
 * without LF is reported as `tornTail` and never decoded. An LF-terminated
 * corrupt line rejects the journal instead of being skipped.
 */
export function replayJournal(source: string): JournalReplay {
  if (source.charCodeAt(0) === 0xfeff) {
    throw new JournalError('JOURNAL_BOM', 1, 'Journal must not start with a byte order mark')
  }

  let committedLength = source.length
  let tornTail = ''
  if (committedLength > 0 && source.charCodeAt(committedLength - 1) !== 0x0a) {
    const lastLf = source.lastIndexOf('\n')
    committedLength = lastLf < 0 ? 0 : lastLf + 1
    tornTail = source.slice(committedLength)
  }

  const decoded: Fact[] = []
  let offset = 0
  let line = 1
  while (offset < committedLength) {
    const lf = source.indexOf('\n', offset)
    decoded.push(decodeJournalFactLine(source.slice(offset, lf), line))
    offset = lf + 1
    line += 1
  }

  return { facts: verifyFactChain(decoded), tornTail }
}

/**
 * Decodes one LF-delimited journal line (without its terminating LF).
 * The line must be canonical JCS containing exactly one sealed fact.
 */
export function decodeJournalFactLine(encoded: string, line = 1): Fact {
  if (encoded.length === 0) {
    throw new JournalError('JOURNAL_EMPTY_LINE', line, 'Journal lines must not be empty')
  }
  if (encoded.charCodeAt(0) === 0xfeff) {
    throw new JournalError('JOURNAL_BOM', line, 'Journal lines must not contain a byte order mark')
  }
  if (encoded.includes('\r')) {
    throw new JournalError('JOURNAL_CR', line, 'Journal lines must not contain a carriage return')
  }
  if (
    isJsonWhitespace(encoded.charCodeAt(0)) ||
    isJsonWhitespace(encoded.charCodeAt(encoded.length - 1))
  ) {
    throw new JournalError(
      'JOURNAL_WHITESPACE',
      line,
      'Journal lines must not have leading or trailing whitespace',
    )
  }

  let value: JsonValue
  try {
    value = parseJsonText(encoded)
  } catch (error) {
    throw new JournalError('JOURNAL_INVALID_JSON', line, 'Journal line is not valid JSON text', {
      cause: error,
    })
  }

  if (canonicalize(value) !== encoded) {
    throw new JournalError(
      'JOURNAL_NON_CANONICAL',
      line,
      'Journal line must be JCS-canonical JSON',
    )
  }

  let fact: Fact
  try {
    fact = factSchema.parse(value)
  } catch (error) {
    throw new JournalError(
      'JOURNAL_INVALID_FACT',
      line,
      'Journal line is not a valid sealed fact',
      { cause: error },
    )
  }

  if (!verifyFact(fact)) {
    throw new JournalError(
      'JOURNAL_FACT_DIGEST_MISMATCH',
      line,
      'Fact digest does not match its payload',
    )
  }

  return fact
}

/**
 * Verifies a decoded fact sequence as the single journal chain:
 * genesis at seq 0, contiguous seq, prev linking, fact digests, and at most
 * one fact per commandId. Returns the verified facts without mutating input.
 */
export function verifyFactChain(candidates: readonly unknown[]): readonly Fact[] {
  const facts: Fact[] = []
  const commandIds = new Set<string>()
  let expectedSeq = 0
  let previousDigest: Fact['prev'] = null

  for (let index = 0; index < candidates.length; index += 1) {
    const line = index + 1
    let fact: Fact
    try {
      fact = factSchema.parse(candidates[index])
    } catch (error) {
      throw new JournalError('JOURNAL_INVALID_FACT', line, 'Journal entry is not a sealed fact', {
        cause: error,
      })
    }

    if (!verifyFact(fact)) {
      throw new JournalError(
        'JOURNAL_FACT_DIGEST_MISMATCH',
        line,
        'Fact digest does not match its payload',
      )
    }
    if (fact.seq !== expectedSeq) {
      throw new JournalError(
        'JOURNAL_SEQ_MISMATCH',
        line,
        `Expected seq ${String(expectedSeq)}, found ${String(fact.seq)}`,
      )
    }
    if (fact.prev !== previousDigest) {
      throw new JournalError(
        'JOURNAL_PREV_MISMATCH',
        line,
        'Fact prev does not match the previous fact digest',
      )
    }
    if (commandIds.has(fact.commandId)) {
      throw new JournalError(
        'JOURNAL_COMMAND_ID_DUPLICATE',
        line,
        `Duplicate commandId ${JSON.stringify(fact.commandId)}`,
      )
    }

    commandIds.add(fact.commandId)
    facts.push(fact)
    expectedSeq += 1
    previousDigest = fact.digest
  }

  return facts
}

/** Builds a command projection from a verified fact sequence. */
export type CommandProjectionBuilder<Projection> = (facts: readonly Fact[]) => Projection

/** Deterministic journal fold result. */
export interface JournalFold<Projection> {
  readonly facts: readonly Fact[]
  readonly commandProjection: Projection
}

/**
 * Pure journal fold: verifies the chain, then delegates command-idempotency
 * projection to the caller. `command.ts` owns `buildCommandProjection`; this
 * module deliberately does not duplicate that logic or persist a second ledger.
 */
export function foldFacts<Projection>(
  facts: readonly Fact[],
  buildCommandProjection: CommandProjectionBuilder<Projection>,
): JournalFold<Projection> {
  const verified = verifyFactChain(facts)
  return { facts: verified, commandProjection: buildCommandProjection(verified) }
}

function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
}
