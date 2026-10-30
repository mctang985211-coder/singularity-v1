import { computeDigest, parseJsonText, parseProtocolValue, refSchema } from '@singularity/protocol'
import type { Digest, JsonValue, Ref } from '@singularity/protocol'

import type { CasObjectReader } from './workspace.ts'

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/** Stable resource-bundle rejection; the Method resource layer maps it to a protocol code. */
export class TreeBundleError extends Error {
  override readonly name = 'TreeBundleError'
}

export interface TreeBundleFile {
  readonly path: string
  readonly bytes: number
  readonly object: Ref
}

export interface TreeBundle {
  readonly manifest: {
    readonly v: 1
    readonly kind: 'tree'
    readonly files: readonly TreeBundleFile[]
    readonly digest: Digest
  }
  readonly contents: ReadonlyMap<string, Uint8Array>
}

/**
 * Reads one sealed tree manifest and every referenced file from CAS. The
 * manifest shape and path ordering mirror `workspace.ts`'s `freezeTree`: a
 * relative POSIX path per file, directories sorted by name and emitted in DFS
 * pre-order. No workspace or host directory is read.
 */
export async function readTreeBundle(
  reader: CasObjectReader,
  ref: Ref,
  maxBytes: number,
): Promise<TreeBundle> {
  const manifestBytes = await readObject(reader, ref, 'tree bundle manifest')
  let value: JsonValue
  try {
    value = parseJsonText(strictUtf8.decode(manifestBytes))
  } catch (error) {
    throw new TreeBundleError(`tree bundle manifest is not strict UTF-8 JSON: ${errorMessage(error)}`)
  }
  if (!isRecord(value)) throw new TreeBundleError('tree bundle manifest must be a JSON object')
  const keys = Object.keys(value)
  if (keys.length !== 4
    || !keys.includes('v')
    || !keys.includes('kind')
    || !keys.includes('files')
    || !keys.includes('digest')) {
    throw new TreeBundleError('tree bundle manifest must contain exactly v, kind, files, digest')
  }
  if (value['v'] !== 1 || value['kind'] !== 'tree') {
    throw new TreeBundleError('tree bundle manifest must be { v: 1, kind: "tree" }')
  }
  const digest = value['digest']
  if (typeof digest !== 'string' || computeDigest('object', value) !== digest) {
    throw new TreeBundleError('tree bundle manifest digest is not its structured object digest')
  }
  if (digest !== ref.digest) {
    throw new TreeBundleError('tree bundle manifest digest does not match its ref')
  }
  const entries = value['files']
  if (!Array.isArray(entries)) throw new TreeBundleError('tree bundle files must be an array')

  const files: TreeBundleFile[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!isRecord(entry)) throw new TreeBundleError('tree bundle file entry must be an object')
    const fileKeys = Object.keys(entry)
    if (fileKeys.length !== 3
      || !fileKeys.includes('path')
      || !fileKeys.includes('bytes')
      || !fileKeys.includes('object')) {
      throw new TreeBundleError('tree bundle file entry must contain exactly path, bytes, object')
    }
    const path = entry['path']
    if (typeof path !== 'string') throw new TreeBundleError('tree bundle file path must be a string')
    assertBundlePath(path)
    if (seen.has(path)) throw new TreeBundleError(`tree bundle path ${JSON.stringify(path)} is duplicated`)
    seen.add(path)
    const bytes = entry['bytes']
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new TreeBundleError(`tree bundle file ${JSON.stringify(path)} has an invalid byte count`)
    }
    let object: Ref
    try {
      object = parseProtocolValue(refSchema, entry['object'])
    } catch {
      throw new TreeBundleError(`tree bundle file ${JSON.stringify(path)} has an invalid object ref`)
    }
    files.push({ path, bytes, object })
  }

  const sorted = [...files].sort((left, right) => compareBundlePath(left.path, right.path))
  for (let index = 0; index < files.length; index += 1) {
    if (files[index]?.path !== sorted[index]?.path) {
      throw new TreeBundleError('tree bundle files must use deterministic DFS name order')
    }
  }
  for (let index = 0; index < files.length; index += 1) {
    for (let other = index + 1; other < files.length; other += 1) {
      const parent = files[index]?.path ?? ''
      const child = files[other]?.path ?? ''
      if (child.startsWith(`${parent}/`) || parent.startsWith(`${child}/`)) {
        throw new TreeBundleError(
          `tree bundle path ${JSON.stringify(parent)} conflicts with file/directory ancestor ${JSON.stringify(child)}`,
        )
      }
    }
  }

  const declaredBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
    throw new TreeBundleError(`tree bundle declares ${String(declaredBytes)} bytes, above the ${String(maxBytes)} byte cap`)
  }
  const contents = new Map<string, Uint8Array>()
  for (const file of files) {
    const bytes = await readObject(reader, file.object, `tree bundle file ${JSON.stringify(file.path)}`)
    if (bytes.byteLength !== file.bytes) {
      throw new TreeBundleError(
        `tree bundle file ${JSON.stringify(file.path)} is ${String(bytes.byteLength)} bytes, expected ${String(file.bytes)}`,
      )
    }
    contents.set(file.path, bytes)
  }
  return {
    manifest: { v: 1, kind: 'tree', files, digest },
    contents,
  }
}

async function readObject(reader: CasObjectReader, ref: Ref, label: string): Promise<Uint8Array> {
  try {
    const { bytes } = await reader.readObject(ref, 'object')
    return bytes
  } catch (error) {
    throw new TreeBundleError(`${label} CAS object is missing or unreadable: ${errorMessage(error)}`)
  }
}

function assertBundlePath(path: string): void {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\')) {
    throw new TreeBundleError(`tree bundle path ${JSON.stringify(path)} must be a relative POSIX path`)
  }
  const segments = path.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TreeBundleError(`tree bundle path ${JSON.stringify(path)} must not contain empty or dot segments`)
  }
}

function compareBundlePath(left: string, right: string): number {
  const leftSegments = left.split('/')
  const rightSegments = right.split('/')
  const length = Math.min(leftSegments.length, rightSegments.length)
  for (let index = 0; index < length; index += 1) {
    const a = leftSegments[index]
    const b = rightSegments[index]
    if (a !== b) return a < b ? -1 : 1
  }
  return leftSegments.length - rightSegments.length
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
