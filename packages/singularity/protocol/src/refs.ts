import { z } from 'zod'

import { digestSchema } from './digest.ts'
import { closedObject } from './schema.ts'

/** Immutable reference to a stored object. */
export const refSchema = closedObject({
  id: z.string(),
  digest: digestSchema,
})

export type Ref = z.infer<typeof refSchema>

/** Two refs identify the same frozen object. */
export function sameRef(left: Ref, right: Ref): boolean {
  return left.id === right.id && left.digest === right.digest
}
