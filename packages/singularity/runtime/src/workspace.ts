import { constants } from 'node:fs'
import {
lstat,
mkdir,
open,
readdir,
realpath,
writeFile
} from 'node:fs/promises'
import { dirname,join,relative,resolve } from 'node:path'
import type { TreeBundleFile } from './resource-bundle.ts'
import { compareBundlePath,sealTreeManifest } from './resource-bundle.ts'

import type {
InputRef,
JsonValue,
OutputSpec,
Ref,
SubmissionCheck,
SubmissionManifest,
SubmittedLearningDraft,
SubmittedOutput,
TaskContract,
} from '@singularity/protocol'
import {
canonicalize,
sealSubmissionManifest,
} from '@singularity/protocol'

import type { CasDigestDomain } from './store.ts'

/** Stable local submit rejection; the tool layer maps these to INVALID_ARGUMENT. */
export type SubmissionErrorCode =
  | 'OUTPUT_ID_INVALID'
  | 'OUTPUT_MISSING'
  | 'OUTPUT_SYMLINK'
  | 'OUTPUT_UNSUPPORTED'
  | 'OUTPUT_TOO_LARGE'

/** Submission freeze failure with a stable diagnostic code. */
export class SubmissionError extends Error {
  override readonly name = 'SubmissionError'
  readonly code: SubmissionErrorCode

  constructor(code: SubmissionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

/** Single CAS object writer; DomainStore and CommandService both satisfy it. */
export interface CasObjectWriter {
  putObject(id: string, bytes: Uint8Array, domain?: CasDigestDomain): Promise<Ref>
}

/** Single CAS object reader; it can never expose mutable workspace state. */
export interface CasObjectReader {
  readObject(ref: Ref, domain?: CasDigestDomain): Promise<{ readonly bytes: Uint8Array }>
}

const textEncoder = new TextEncoder()

interface DraftSpec {
  readonly id: SubmittedLearningDraft['id']
  readonly path: SubmittedLearningDraft['path']
  readonly kind: 'tree'
  readonly role: SubmittedLearningDraft['role']
  readonly required: false
}

const draftSpecs = [
  {
    id: '__skill-drafts',
    path: 'learning-drafts/skills',
    kind: 'tree',
    role: 'skill-draft',
    required: false,
  },
  {
    id: '__mcp-drafts',
    path: 'learning-drafts/mcp-servers',
    kind: 'tree',
    role: 'mcp-draft',
    required: false,
  },
] as const satisfies readonly DraftSpec[]

export type { SealedTreeManifest } from './resource-bundle.ts'

interface FrozenPath {
  readonly object: Ref
  readonly bytes: number
}

export interface FreezeSubmissionOptions {
  readonly contract: TaskContract
  readonly runId: string
  readonly workspace: string
  readonly outputIds: readonly string[]
  readonly includeLearningDrafts: boolean
  /** Deployment cap over all frozen output bytes in this submission. */
  readonly maxOutputBytes: number
  readonly writer: CasObjectWriter
  /** Host-authorized snapshot: initial inputs followed by frozen direct outputs. */
  readonly inputRefs?: readonly Ref[]
}

/** Frozen submission snapshot; all refs point at immutable CAS bytes. */
export interface FrozenSubmission {
  readonly manifest: SubmissionManifest
  readonly manifestRef: Ref
  /** Authorized verifier input snapshot in frozen contract order. */
  readonly inputRefs: readonly Ref[]
  /** Frozen verifier output snapshot: manifest outputs then learning drafts. */
  readonly outputRefs: readonly Ref[]
}

/**
 * Materializes declared `copy-to-work` inputs into the Run workspace. Reads
 * happen through the CAS reader only. `read` inputs stay in CAS and do not
 * create mutable workspace copies.
 */
export async function prepareWorkspace(
  workspace: string,
  inputs: readonly InputRef[],
  reader: CasObjectReader,
): Promise<string> {
  const root = resolve(workspace)
  await mkdir(root, { recursive: true })
  const canonicalRoot = await realpath(root)
  for (const input of inputs) {
    if (input.access !== 'copy-to-work') continue
    const target = join(canonicalRoot, input.path)
    await mkdir(dirname(target), { recursive: true })
    const { bytes } = await reader.readObject(input.object, 'object')
    await writeFile(target, bytes, { flag: 'wx', mode: 0o644 })
  }
  return canonicalRoot
}

/**
 * Freezes the declared non-draft outputs and learning drafts into CAS with
 * no-follow checks, then seals and validates the strict SubmissionManifest.
 * The activity workspace is read exactly once here; verifier execution never
 * receives this reader or the workspace path.
 */
export async function freezeSubmission(
  options: FreezeSubmissionOptions,
): Promise<FrozenSubmission> {
  const workspace = await realpath(resolve(options.workspace))
  const declared = options.contract.spec.outputs.filter(isNonDraftOutput)
  const declaredById = new Map(declared.map(output => [output.id, output]))
  const ids = validateOutputIds(options.outputIds, declaredById)

  const frozenOutputs = new Map<string, FrozenPath>()
  const checks: SubmissionCheck[] = []
  let bytes = 0

  for (const output of declared) {
    if (!ids.has(output.id)) continue
    const budget = options.maxOutputBytes - bytes
    const frozen = await freezeDeclaredPath({
      workspace,
      runId: options.runId,
      output,
      maxBytes: budget,
      writer: options.writer,
    })
    if (frozen === undefined) continue
    bytes += frozen.bytes
    frozenOutputs.set(output.id, frozen)
    checks.push({ outputId: output.id, bytes: frozen.bytes, symlinks: 'none' })
  }

  const learningDrafts: SubmittedLearningDraft[] = []
  if (options.includeLearningDrafts) {
    for (const draft of draftSpecs) {
      const budget = options.maxOutputBytes - bytes
      const frozen = await freezeTree({
        workspace,
        runId: options.runId,
        objectId: draft.id,
        path: draft.path,
        maxBytes: budget,
        writer: options.writer,
        missingAllowed: true,
      })
      if (frozen === undefined) continue
      bytes += frozen.bytes
      learningDrafts.push({
        id: draft.id,
        path: draft.path,
        kind: 'tree',
        role: draft.role,
        required: false,
        object: frozen.object,
      } as SubmittedLearningDraft)
      checks.push({ outputId: draft.id, bytes: frozen.bytes, symlinks: 'none' })
    }
  }

  const outputs: SubmittedOutput[] = declared.map(output => {
    const frozen = frozenOutputs.get(output.id)
    return {
      id: output.id,
      path: output.path,
      kind: output.kind,
      role: output.role,
      required: output.required,
      ...(frozen === undefined ? {} : { object: frozen.object }),
    }
  })

  const manifest = sealSubmissionManifest({
    v: 1,
    taskId: options.contract.taskId,
    runId: options.runId,
    contractDigest: options.contract.digest,
    includeLearningDrafts: options.includeLearningDrafts,
    outputs,
    learningDrafts,
    checks,
  })
  const manifestRef = await options.writer.putObject(
    `${options.runId}:submission`,
    textEncoder.encode(canonicalize(manifest as unknown as JsonValue)),
    'object',
  )

  const outputRefs: Ref[] = []
  for (const output of manifest.outputs) {
    if (output.object !== undefined) outputRefs.push(output.object)
  }
  for (const draft of manifest.learningDrafts) {
    outputRefs.push(draft.object)
  }

  return {
    manifest,
    manifestRef,
    inputRefs: options.inputRefs ?? options.contract.spec.inputs.map(input => input.object),
    outputRefs,
  }
}

function isNonDraftOutput(
  output: OutputSpec,
): output is OutputSpec & { readonly role: 'deliverable' | 'supporting' } {
  return output.role === 'deliverable' || output.role === 'supporting'
}

function validateOutputIds(
  outputIds: readonly string[],
  declared: ReadonlyMap<string, { readonly required: boolean }>,
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const id of outputIds) {
    if (ids.has(id)) {
      throw new SubmissionError('OUTPUT_ID_INVALID', `outputIds contains duplicate id ${JSON.stringify(id)}`)
    }
    if (!declared.has(id)) {
      throw new SubmissionError('OUTPUT_ID_INVALID', `outputIds contains undeclared id ${JSON.stringify(id)}`)
    }
    ids.add(id)
  }
  for (const [id, output] of declared) {
    if (output.required && !ids.has(id)) {
      throw new SubmissionError('OUTPUT_MISSING', `required output ${JSON.stringify(id)} is missing`)
    }
  }
  return ids
}

interface FreezeDeclaredPathOptions {
  readonly workspace: string
  readonly runId: string
  readonly output: TaskContract['spec']['outputs'][number]
  readonly maxBytes: number
  readonly writer: CasObjectWriter
}

async function freezeDeclaredPath(
  options: FreezeDeclaredPathOptions,
): Promise<FrozenPath | undefined> {
  if (options.output.kind === 'file') {
    return freezeFile({
      workspace: options.workspace,
      runId: options.runId,
      objectId: `output:${options.output.id}`,
      path: options.output.path,
      maxBytes: options.maxBytes,
      writer: options.writer,
      missingAllowed: !options.output.required,
    })
  }
  return freezeTree({
    workspace: options.workspace,
    runId: options.runId,
    objectId: `output:${options.output.id}`,
    path: options.output.path,
    maxBytes: options.maxBytes,
    writer: options.writer,
    missingAllowed: !options.output.required,
  })
}

interface FreezeFileOptions {
  readonly workspace: string
  readonly runId: string
  readonly objectId: string
  readonly path: string
  readonly maxBytes: number
  readonly writer: CasObjectWriter
  readonly missingAllowed: boolean
}

async function freezeFile(options: FreezeFileOptions): Promise<FrozenPath | undefined> {
  if (options.maxBytes < 0) {
    throw new SubmissionError('OUTPUT_TOO_LARGE', 'submission size cap is exhausted')
  }
  const absolute = join(options.workspace, options.path)
  let bytes
  try {
    bytes = await readNoFollowFile(absolute, options.path, options.maxBytes)
  } catch (error) {
    if (options.missingAllowed && error instanceof SubmissionError && error.code === 'OUTPUT_MISSING') return undefined
    throw error
  }
  const object = await options.writer.putObject(
    `${options.runId}:${options.objectId}`,
    bytes,
    'object',
  )
  return { object, bytes: bytes.byteLength }
}

interface FreezeTreeOptions {
  readonly workspace: string
  readonly runId: string
  readonly objectId: string
  readonly path: string
  readonly maxBytes: number
  readonly writer: CasObjectWriter
  readonly missingAllowed: boolean
}

async function freezeTree(options: FreezeTreeOptions): Promise<FrozenPath | undefined> {
  if (options.maxBytes < 0) {
    throw new SubmissionError('OUTPUT_TOO_LARGE', 'submission size cap is exhausted')
  }
  const absolute = join(options.workspace, options.path)
  let rootStat
  try {
    rootStat = await lstat(absolute)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
    if (options.missingAllowed) return undefined
    throw new SubmissionError('OUTPUT_MISSING', `cannot stat ${JSON.stringify(options.path)}`, {
      cause: error,
    })
  }
  if (rootStat.isSymbolicLink()) {
    throw new SubmissionError('OUTPUT_SYMLINK', `${JSON.stringify(options.path)} is a symlink`)
  }
  if (!rootStat.isDirectory()) {
    throw new SubmissionError(
      'OUTPUT_UNSUPPORTED',
      `${JSON.stringify(options.path)} is not a directory`,
    )
  }

  const files: TreeBundleFile[] = []
  let bytes = 0
  const entries = await readdir(absolute, { recursive: true, withFileTypes: true })
  const paths = entries.map(entry => ({ entry, path: relative(absolute, join(entry.parentPath, entry.name)) }))
    .sort((left, right) => compareBundlePath(left.path, right.path))
  for (const { entry, path } of paths) {
    if (entry.isSymbolicLink()) {
      throw new SubmissionError('OUTPUT_SYMLINK', `${JSON.stringify(path)} is a symlink`)
    }
    if (entry.isDirectory()) continue
    if (!entry.isFile()) {
      throw new SubmissionError('OUTPUT_UNSUPPORTED', `${JSON.stringify(path)} is not a regular file`)
    }
    const data = await readNoFollowFile(join(absolute, path), path, options.maxBytes - bytes)
    bytes += data.byteLength
    const object = await options.writer.putObject(`${options.runId}:${options.objectId}:${path}`, data, 'object')
    files.push({ path, bytes: data.byteLength, object })
  }

  const manifest = sealTreeManifest(files)
  const object = await options.writer.putObject(
    `${options.runId}:${options.objectId}`,
    textEncoder.encode(canonicalize(manifest as unknown as JsonValue)),
    'object',
  )
  return { object, bytes }
}

async function readNoFollowFile(absolute: string, relative: string, maxBytes: number): Promise<Uint8Array> {
  let handle
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (isErrno(error, 'ELOOP')) {
      throw new SubmissionError('OUTPUT_SYMLINK', `${JSON.stringify(relative)} is a symlink`)
    }
    if (isErrno(error, 'ENOENT')) {
      throw new SubmissionError('OUTPUT_MISSING', `${JSON.stringify(relative)} is missing`, { cause: error })
    }
    throw error
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) {
      throw new SubmissionError(
        'OUTPUT_UNSUPPORTED',
        `${JSON.stringify(relative)} is not a regular file`,
      )
    }
    if (stat.size > maxBytes) throw new SubmissionError('OUTPUT_TOO_LARGE', `${JSON.stringify(relative)} exceeds the remaining output cap`)
    const data = await handle.readFile()
    if (data.byteLength > maxBytes) throw new SubmissionError('OUTPUT_TOO_LARGE', `${JSON.stringify(relative)} exceeds the remaining output cap`)
    return data
  } finally {
    await handle.close()
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
