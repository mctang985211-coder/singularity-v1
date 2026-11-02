import type { Digest,Ref } from '@singularity/protocol'
import { closedObject,computeDigest,digestSchema,errorMessage,parseJsonText,parseProtocolValue,refSchema,seal,workspaceRelativePathSchema } from '@singularity/protocol'
import { z } from 'zod'

import type { CasObjectReader } from './workspace.ts'

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/** Stable resource-bundle rejection; the Method resource layer maps it to a protocol code. */
export class TreeBundleError extends Error {
  override readonly name = 'TreeBundleError'
}

const treeFileSchema = closedObject({
  path: workspaceRelativePathSchema,
  bytes: z.number().int().nonnegative(),
  object: refSchema,
})

/** One codec shared by resource readers and workspace output producers. */
export const sealedTreeManifestSchema = closedObject({
  v: z.literal(1), kind: z.literal('tree'), files: z.array(treeFileSchema), digest: digestSchema,
}).superRefine((manifest, ctx) => {
  const seen = new Set<string>()
  for (let index = 0; index < manifest.files.length; index += 1) {
    const path = manifest.files[index].path
    if (seen.has(path)) ctx.addIssue({ code: 'custom', message: `duplicate path ${path}` })
    const parts = path.split('/')
    for (let depth = 1; depth < parts.length; depth += 1) {
      if (seen.has(parts.slice(0, depth).join('/'))) ctx.addIssue({ code: 'custom', message: `file/directory conflict ${path}` })
    }
    if (index > 0 && compareBundlePath(manifest.files[index - 1].path, path) >= 0) {
      ctx.addIssue({ code: 'custom', message: 'files must use deterministic DFS name order' })
    }
    seen.add(path)
  }
})
export type SealedTreeManifest = z.infer<typeof sealedTreeManifestSchema>
export type TreeBundleFile = z.infer<typeof treeFileSchema>

export function sealTreeManifest(files: readonly TreeBundleFile[]): SealedTreeManifest {
  return parseProtocolValue(sealedTreeManifestSchema, seal('object', { v: 1, kind: 'tree', files: [...files] }))
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
 * manifest shape and path ordering use the shared `sealedTreeManifestSchema`
 * and `sealTreeManifest` codec with `workspace.ts`: relative POSIX paths,
 * DFS name order. No workspace or host directory is read.
 */
export async function readTreeBundle(
  reader: CasObjectReader,
  ref: Ref,
  maxBytes: number,
): Promise<TreeBundle> {
  const manifest = await readTreeManifest(reader, ref, maxBytes)
  const contents = new Map<string, Uint8Array>()
  for (const file of manifest.files) {
    const bytes = await readObject(reader, file.object)
    if (bytes.byteLength !== file.bytes) {
      throw new TreeBundleError(
        `tree bundle file ${JSON.stringify(file.path)} is ${String(bytes.byteLength)} bytes, expected ${String(file.bytes)}`,
      )
    }
    contents.set(file.path, bytes)
  }
  return { manifest, contents }
}

/** Resolve declared tree leaves without loading every file into a model view. */
export async function readTreeManifest(reader: CasObjectReader, ref: Ref, maxBytes: number): Promise<SealedTreeManifest> {
  const manifestBytes = await readObject(reader, ref)
  let manifest: SealedTreeManifest
  try {
    manifest = parseProtocolValue(sealedTreeManifestSchema, parseJsonText(strictUtf8.decode(manifestBytes)))
  } catch (error) {
    throw new TreeBundleError(`invalid tree bundle manifest: ${errorMessage(error)}`)
  }
  if (computeDigest('object', manifest) !== manifest.digest || manifest.digest !== ref.digest) {
    throw new TreeBundleError('tree bundle manifest digest does not match its structured object ref')
  }
  const declaredBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0)
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
    throw new TreeBundleError(`tree bundle declares ${String(declaredBytes)} bytes, above the ${String(maxBytes)} byte cap`)
  }
  return manifest
}

async function readObject(reader: CasObjectReader, ref: Ref): Promise<Uint8Array> {
  return (await reader.readObject(ref, 'object')).bytes
}

export function compareBundlePath(left: string, right: string): number {
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
