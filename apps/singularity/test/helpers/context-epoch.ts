import { createHash } from 'node:crypto'

// Load the public SessionEventMap augmentation owned by dsh-compaction.
import type {} from '@deepseek-ai/dsh-compaction'
import { deriveContextEpoch } from '@singularity/runtime'
export { deriveContextEpoch } from '@singularity/runtime'
import type { Session, SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

/**
 * Test-local deterministic context-epoch identity.
 *
 * The runtime uses native lifecycle offsets and surface replacement generations.
 */
export type ContextEpoch = string

/** A test-local receipt for one persisted, surface-visible source event. */
export interface ContextEpochReceipt {
  /** Persisted event whose content this receipt covers. */
  readonly sourceEventSeq: SessionSeq
  /** Session identity the receipt was issued against. */
  readonly sessionId: SessionId
  /** Context epoch derived from the raw session log at issue time. */
  readonly epoch: ContextEpoch
  /** Test-local SHA-256 digest of the source event's type and data. */
  readonly digest: string
}

/** Independent validity dimensions for one receipt. */
export interface ContextEpochReceiptStatus {
  /** True only when every other field below is true. */
  readonly current: boolean
  readonly sessionMatches: boolean
  readonly epochMatches: boolean
  readonly digestMatches: boolean
  /** The source event is still present in the raw session log. */
  readonly eventExists: boolean
  /** The source event still belongs to the current model-visible surface. */
  readonly surfaceMember: boolean
}

/**
 * Read the committed session log for test assertions; production receipt and
 * usage readers share the separately documented alpha2 compatibility boundary.
 */
function readSessionEvents(session: Session): readonly SessionEvent[] {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- test-only durable log inspection
  return session.snapshotEvents()
}

function findEvent(session: Session, seq: SessionSeq): SessionEvent | undefined {
  return readSessionEvents(session).find(event => event.seq === seq)
}

function digestEvent(event: SessionEvent): string {
  const serialized = JSON.stringify({ type: event.type, data: event.data })
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`
}

/**
 * Issue one receipt for a currently surface-visible source event.
 *
 * Issuing fails when the event is absent from the raw log or has already been
 * shadowed from the current surface. Callers that need to model an old receipt
 * across a resume or compaction retain the returned value instead of reissuing.
 */
export function issueContextEpochReceipt(session: Session, sourceEventSeq: SessionSeq): ContextEpochReceipt {
  const event = findEvent(session, sourceEventSeq)
  if (event === undefined) {
    throw new Error(`cannot issue receipt for missing session event ${String(sourceEventSeq)}`)
  }
  if (!session.surface.nodes.includes(sourceEventSeq)) {
    throw new Error(`cannot issue receipt for non-surface session event ${String(sourceEventSeq)}`)
  }
  return Object.freeze({
    sourceEventSeq,
    sessionId: session.id,
    epoch: deriveContextEpoch(session),
    digest: digestEvent(event),
  })
}

/**
 * Evaluate one receipt against the current session.
 *
 * Raw-log existence and digest stability are not enough: a receipt is current
 * only when it also matches the current context epoch and its source event is
 * still a member of the current surface.
 */
export function evaluateContextEpochReceipt(session: Session, receipt: ContextEpochReceipt): ContextEpochReceiptStatus {
  const sessionMatches = receipt.sessionId === session.id
  const epochMatches = receipt.epoch === deriveContextEpoch(session)
  const event = findEvent(session, receipt.sourceEventSeq)
  const eventExists = event !== undefined
  const digestMatches = event !== undefined && digestEvent(event) === receipt.digest
  const surfaceMember = event !== undefined && session.surface.nodes.includes(receipt.sourceEventSeq)
  return {
    current: sessionMatches && epochMatches && digestMatches && surfaceMember,
    sessionMatches,
    epochMatches,
    digestMatches,
    eventExists,
    surfaceMember,
  }
}
