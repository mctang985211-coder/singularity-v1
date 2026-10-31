import type { Session,SessionEvent } from '@deepseek-ai/dsh-session'

/** Alpha2 compatibility boundary for committed receipts and usage observations. */
export function readSessionEvents(session: Session): readonly SessionEvent[] {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the native API cost comparison in docs/progress.md
  return session.snapshotEvents()
}
