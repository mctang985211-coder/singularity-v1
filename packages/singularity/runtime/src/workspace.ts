import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import {
  canonicalize,
  seal,
  sealSubmissionManifest,
  validateSubmissionManifest,
} from '@singularity/protocol'
import type {
  InputRef,
  JsonValue,
  OutputSpec,
  Ref,
  SubmittedLearningDraft,
  SubmittedOutput,
  SubmissionCheck,
  SubmissionManifest,
  TaskContract,
} from '@singularity/protocol'

import type { CasDigestDomain } from './store.ts'

/** Stable local submit rejection; the tool layer maps these to INVALID_ARGUMENT. */
export type SubmissionErrorCode =
  | 'OUTPUT_ID_INVALID'
  | 'OUTPUT_PATH_INVALID'
  | 'OUTPUT_MISSING'
  | 'OUTPUT_SYMLINK'
  | 'OUTPUT_UNSUPPORTED'
  | 'OUTPUT_TOO_LARGE'
  | 'OUTPUT_READ_FAILED'

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

/** One host-authorized input materialization requested by the frozen contract. */
export type WorkspaceInput = InputRef

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

interface TreeFile {
  readonly path: string
  readonly bytes: number
  readonly object: Ref
}

interface SealedTreeManifest {
  readonly v: 1
  readonly kind: 'tree'
  readonly files: readonly TreeFile[]
  readonly digest: string
}

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
}

/** Frozen submission snapshot; all refs point at immutable CAS bytes. */
export interface FrozenSubmission {
  readonly manifest: SubmissionManifest
  readonly manifestRef: Ref
  /** Authorized verifier input snapshot in frozen contract order. */
  readonly inputRefs: readonly Ref[]
  /** Frozen verifier output snapshot: manifest outputs then learning drafts. */
  readonly outputRefs: readonly Ref[]
  readonly checks: readonly SubmissionCheck[]
  readonly bytes: number
}

/**
 * Materializes declared `copy-to-work` inputs into the Run workspace. Reads
 * happen through the CAS reader only. `read` inputs stay in CAS and do not
 * create mutable workspace copies.
 */
export async function prepareWorkspace(
  workspace: string,
  inputs: readonly WorkspaceInput[],
  reader: CasObjectReader,
): Promise<string> {
  const root = resolve(workspace)
  await mkdir(root, { recursive: true })
  const canonicalRoot = await realpath(root)
  for (const input of inputs) {
    if (input.access !== 'copy-to-work') continue
    assertWorkspaceRelativePath(input.path, 'input.path')
    const target = resolveInside(canonicalRoot, input.path)
    await assertNoSymlinkAncestors(canonicalRoot, input.path)
    await mkdir(dirname(target), { recursive: true })
    const existing = await lstatOrUndefined(target)
    if (existing?.isSymbolicLink() === true) {
      throw new SubmissionError('OUTPUT_SYMLINK', `input path ${JSON.stringify(input.path)} is a symlink`)
    }
    const { bytes } = await reader.readObject(input.object, 'object')
    await writeFile(target, bytes)
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
    if (!ids.has(output.id)) {
      if (output.required) {
        throw new SubmissionError(
          'OUTPUT_MISSING',
          `required output ${JSON.stringify(output.id)} is absent from outputIds`,
        )
      }
      continue
    }
    const budget = options.maxOutputBytes - bytes
    const frozen = await freezeDeclaredPath({
      workspace,
      runId: options.runId,
      output,
      maxBytes: budget,
      writer: options.writer,
    })
    if (frozen === undefined) {
      if (output.required) {
        throw new SubmissionError(
          'OUTPUT_MISSING',
          `required output ${JSON.stringify(output.id)} does not exist at ${JSON.stringify(output.path)}`,
        )
      }
      continue
    }
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
  const validation = validateSubmissionManifest(manifest, {
    contract: options.contract,
    runId: options.runId,
  })
  if (!validation.valid) {
    throw new SubmissionError('OUTPUT_ID_INVALID', `submission manifest is invalid: ${validation.reason}`)
  }

  const manifestRef = await options.writer.putObject(
    `${options.runId}:submission`,
    textEncoder.encode(canonicalize(manifest as unknown as JsonValue)),
    'object',
  )
  if (manifestRef.digest !== manifest.digest) {
    throw new SubmissionError('OUTPUT_READ_FAILED', 'manifest CAS digest does not match its seal')
  }

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
    inputRefs: options.contract.spec.inputs.map(input => input.object),
    outputRefs,
    checks,
    bytes,
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
  assertOutputPath(options.output.path, `output ${JSON.stringify(options.output.id)}`)
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
  const absolute = resolveInside(options.workspace, options.path)
  let stat
  try {
    stat = await lstat(absolute)
  } catch (error) {
    if (isErrno(error, 'ENOENT') && options.missingAllowed) return undefined
    throw new SubmissionError('OUTPUT_MISSING', `cannot stat ${JSON.stringify(options.path)}`, {
      cause: error,
    })
  }
  if (stat.isSymbolicLink()) {
    throw new SubmissionError('OUTPUT_SYMLINK', `${JSON.stringify(options.path)} is a symlink`)
  }
  if (!stat.isFile()) {
    throw new SubmissionError(
      'OUTPUT_UNSUPPORTED',
      `${JSON.stringify(options.path)} is not a regular file`,
    )
  }
  if (stat.size > options.maxBytes) {
    throw new SubmissionError(
      'OUTPUT_TOO_LARGE',
      `${JSON.stringify(options.path)} is ${String(stat.size)} bytes, above the remaining ${String(options.maxBytes)}`,
    )
  }
  const bytes = await readNoFollowFile(absolute, options.path)
  if (bytes.byteLength > options.maxBytes) {
    throw new SubmissionError('OUTPUT_TOO_LARGE', `${JSON.stringify(options.path)} grew above its cap`)
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
  const absolute = resolveInside(options.workspace, options.path)
  let rootStat
  try {
    rootStat = await lstat(absolute)
  } catch (error) {
    if (isErrno(error, 'ENOENT') && options.missingAllowed) return undefined
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

  const files: TreeFile[] = []
  let bytes = 0
  const visit = async (directory: string, relative: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const childRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`
      const childAbsolute = join(directory, entry.name)
      const stat = await lstat(childAbsolute)
      if (stat.isSymbolicLink()) {
        throw new SubmissionError(
          'OUTPUT_SYMLINK',
          `${JSON.stringify(childRelative)} is a symlink`,
        )
      }
      if (stat.isDirectory()) {
        await visit(childAbsolute, childRelative)
        continue
      }
      if (!stat.isFile()) {
        throw new SubmissionError(
          'OUTPUT_UNSUPPORTED',
          `${JSON.stringify(childRelative)} is not a regular file`,
        )
      }
      bytes += stat.size
      if (bytes > options.maxBytes) {
        throw new SubmissionError(
          'OUTPUT_TOO_LARGE',
          `${JSON.stringify(options.path)} exceeds the ${String(options.maxBytes)} byte cap`,
        )
      }
      const data = await readNoFollowFile(childAbsolute, childRelative)
      bytes += data.byteLength - stat.size
      if (bytes > options.maxBytes) {
        throw new SubmissionError(
          'OUTPUT_TOO_LARGE',
          `${JSON.stringify(options.path)} exceeds the ${String(options.maxBytes)} byte cap`,
        )
      }
      const object = await options.writer.putObject(
        `${options.runId}:${options.objectId}:${childRelative}`,
        data,
        'object',
      )
      files.push({ path: childRelative, bytes: data.byteLength, object })
    }
  }
  await visit(absolute, '')

  const manifest = seal('object', {
    v: 1,
    kind: 'tree',
    files: files as unknown as JsonValue,
  }) as unknown as SealedTreeManifest
  const object = await options.writer.putObject(
    `${options.runId}:${options.objectId}`,
    textEncoder.encode(canonicalize(manifest as unknown as JsonValue)),
    'object',
  )
  if (object.digest !== manifest.digest) {
    throw new SubmissionError('OUTPUT_READ_FAILED', 'tree manifest CAS digest does not match its seal')
  }
  return { object, bytes }
}

async function readNoFollowFile(absolute: string, relative: string): Promise<Uint8Array> {
  let handle
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isErrno(error, 'ELOOP')) {
      throw new SubmissionError('OUTPUT_SYMLINK', `${JSON.stringify(relative)} is a symlink`)
    }
    throw new SubmissionError('OUTPUT_READ_FAILED', `cannot open ${JSON.stringify(relative)}`, {
      cause: error,
    })
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) {
      throw new SubmissionError(
        'OUTPUT_UNSUPPORTED',
        `${JSON.stringify(relative)} is not a regular file`,
      )
    }
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

function assertOutputPath(path: string, label: string): void {
  assertWorkspaceRelativePath(path, label)
  if (path === 'learning-drafts' || path.startsWith('learning-drafts/')) {
    throw new SubmissionError(
      'OUTPUT_PATH_INVALID',
      `${label} must not use the reserved learning-drafts path`,
    )
  }
}

function assertWorkspaceRelativePath(path: string, label: string): void {
  if (path.length === 0 || isAbsolute(path) || path.includes('\\')) {
    throw new SubmissionError('OUTPUT_PATH_INVALID', `${label} must be a relative POSIX path`)
  }
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new SubmissionError('OUTPUT_PATH_INVALID', `${label} must not contain empty or dot segments`)
  }
}

function resolveInside(root: string, relative: string): string {
  const target = resolve(root, ...relative.split('/'))
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new SubmissionError('OUTPUT_PATH_INVALID', `${JSON.stringify(relative)} escapes the workspace`)
  }
  return target
}

async function assertNoSymlinkAncestors(root: string, relative: string): Promise<void> {
  const segments = relative.split('/').slice(0, -1)
  let current = root
  for (const segment of segments) {
    current = join(current, segment)
    const stat = await lstatOrUndefined(current)
    if (stat === undefined) return
    if (stat.isSymbolicLink()) {
      throw new SubmissionError('OUTPUT_SYMLINK', `path ancestor ${JSON.stringify(segment)} is a symlink`)
    }
    if (!stat.isDirectory()) {
      throw new SubmissionError('OUTPUT_UNSUPPORTED', `path ancestor ${JSON.stringify(segment)} is not a directory`)
    }
  }
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw error
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
