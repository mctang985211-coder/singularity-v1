import { createHash } from 'node:crypto'

import type { Session } from '@deepseek-ai/dsh-session'

/** Deterministic context-epoch identity; it changes on resume or compaction. */
export type ContextEpoch = string

const EPOCH_PREFIX = 'singularity/context-epoch/v1'

interface EpochMarkerEvent {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

/**
 * Initial epoch for a fresh session. Session identity alone produces the same
 * value as {@link deriveContextEpoch} before any resume or compaction marker,
 * so a harness can build a valid PlanningSketch before the first request.
 */
export function initialContextEpoch(sessionId: string): ContextEpoch {
  return deriveEpoch(sessionId, [])
}

/** Derive the current epoch from the raw committed DSH session log. */
export function deriveContextEpoch(session: Session): ContextEpoch {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- alpha2 exposes no replacement raw reader
  return deriveContextEpochFromEvents(session.id, session.snapshotEvents())
}

/**
 * Pure epoch fold over raw session events. Only resume boundaries
 * (`session/end-seed`) and successful compaction boundaries contribute
 * markers; the Session identity itself is always covered.
 */
export function deriveContextEpochFromEvents(
  sessionId: string,
  events: readonly EpochMarkerEvent[],
): ContextEpoch {
  const markers: string[] = []
  const started = new Set<string>()
  for (const event of events) {
    if (event.type === 'session/end-seed') {
      markers.push(`seed:${String(event.seq)}`)
      continue
    }
    if (event.type === 'compaction/start') {
      const id = recordField(event.data, 'compactionId')
      if (typeof id === 'string') started.add(id)
      continue
    }
    if (event.type === 'compaction/end') {
      const id = recordField(event.data, 'compactionId')
      const error = recordField(event.data, 'error')
      if (typeof id === 'string' && error === undefined && started.has(id)) {
        markers.push(`compaction:${id}:${String(event.seq)}`)
      }
    }
  }
  return deriveEpoch(sessionId, markers)
}

/** Whether a receipt-issuing epoch still matches the current raw log. */
export function isContextEpochCurrent(
  session: Session,
  epoch: ContextEpoch,
): boolean {
  return deriveContextEpoch(session) === epoch
}

function deriveEpoch(sessionId: string, markers: readonly string[]): ContextEpoch {
  const material = [EPOCH_PREFIX, sessionId, ...markers].join('\n')
  return `sha256:${createHash('sha256').update(material).digest('hex')}`
}

function recordField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return (value as Record<string, unknown>)[key]
}
