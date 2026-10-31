import { createHash } from 'node:crypto'

import type { Session } from '@deepseek-ai/dsh-session'

/** Identity of the native Session lifecycle and its committed surface replacements. */
export type ContextEpoch = string

export function initialContextEpoch(sessionId: string): ContextEpoch {
  return contextEpoch(sessionId, 0, 0)
}

/** DSH owns lifecycle boundaries and replacement counting; no log replay here. */
export function deriveContextEpoch(session: Session): ContextEpoch {
  return contextEpoch(session.id, session.firstLiveSeq, session.surface.replaceGeneration)
}

function contextEpoch(sessionId: string, firstLiveSeq: number, replacements: number): ContextEpoch {
  const material = JSON.stringify(['singularity/context-epoch/v2', sessionId, firstLiveSeq, replacements])
  return `sha256:${createHash('sha256').update(material).digest('hex')}`
}
