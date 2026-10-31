import type { GlobalResourceSnapshot,Ref } from '@singularity/protocol'
import {
EXPLORE_EXAMPLE,
EXPLORE_EXAMPLE_REF,
EXPLORE_GUIDANCE,
EXPLORE_GUIDANCE_REF,
canonicalize,
explorationTemplate,
globalResourceSnapshotSchema,
parseJsonText,
parseProtocolValue,
} from '@singularity/protocol'

import { DecomposeError,MethodResourceError } from './errors.ts'
import { readMcpServers } from './mcp-resources.ts'
import { readSkills } from './skill-resources.ts'
import type { TaskReadQuery,TaskReadResult } from './tools.ts'
import type { CasObjectReader,CasObjectWriter } from './workspace.ts'

/** Reads only the explicit frozen public catalog; no host-directory discovery. */
export async function loadGlobalResources(reader: CasObjectReader, ref: Ref): Promise<GlobalResourceSnapshot> {
  const { bytes } = await reader.readObject(ref, 'object')
  try {
    return parseProtocolValue(globalResourceSnapshotSchema,
      parseJsonText(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch (error) {
    throw new MethodResourceError('method', 'CONTRACT_INVALID', 'frozen exploration resources are invalid', { cause: error })
  }
}

/** Domain/operator freezes its chosen catalog and the fixed platform examples. */
export async function freezeGlobalResources(writer: CasObjectWriter & CasObjectReader, id: string, input: Omit<GlobalResourceSnapshot, 'v' | 'fallbackJoin'> & {
  readonly fallbackJoin?: GlobalResourceSnapshot['fallbackJoin']
}): Promise<Ref> {
  const snapshot = parseProtocolValue(globalResourceSnapshotSchema, { ...input, v: 1, fallbackJoin: input.fallbackJoin ?? 'probe' })
  const template = explorationTemplate(snapshot)
  if (new Set(snapshot.documents.map(document => document.id)).size !== snapshot.documents.length) {
    throw new MethodResourceError('method', 'CONTRACT_INVALID', 'public documents must have distinct ids')
  }
  await readSkills(writer, snapshot, template, snapshot.skills.map(skill => skill.bundle))
  await readMcpServers(writer, snapshot, template, snapshot.tools.map(tool => tool.server.bundle))
  for (const ref of [...snapshot.documents.map(document => document.object), ...snapshot.baseTools, snapshot.fallbackAcceptance]) {
    await writer.readObject(ref, 'object')
  }
  const encoder = new TextEncoder()
  await writer.putObject(EXPLORE_GUIDANCE_REF.id, encoder.encode(canonicalize(EXPLORE_GUIDANCE)), 'object')
  await writer.putObject(EXPLORE_EXAMPLE_REF.id, encoder.encode(canonicalize(EXPLORE_EXAMPLE)), 'object')
  return writer.putObject(id, encoder.encode(canonicalize(snapshot)), 'object')
}

/** Public document reads use the same bounded text pages as explicit inputs. */
export async function readGlobalResource(reader: CasObjectReader, snapshot: GlobalResourceSnapshot, query: TaskReadQuery): Promise<TaskReadResult | undefined> {
  const document = snapshot.documents.find(document => document.id === query.id || document.object.id === query.id)
  if (document === undefined) return undefined
  const text = new TextDecoder('utf-8', { fatal: true }).decode((await reader.readObject(document.object, 'object')).bytes)
  const offset = Number(query.cursor ?? '0')
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || query.page !== undefined) {
    throw new DecomposeError('INVALID_ARGUMENT', 'invalid public document cursor')
  }
  const end = Math.min(text.length, offset + 4096)
  return { data: text.slice(offset, end), objectRef: document.object,
    ...(end < text.length ? { nextCursor: String(end) } : {}) }
}
