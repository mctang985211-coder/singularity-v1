import { isUtf8 } from 'node:buffer'
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'

import type { InputRef,JsonValue,Ref,RunState,TaskRunState,TaskState,TaskTemplate } from '@singularity/protocol'
import { canonicalize,evidenceSchema,parseJsonText,parseProtocolValue,publicReceiptSchema,submissionManifestSchema } from '@singularity/protocol'

import { activeChildBatch } from './decompose-commit.ts'
import { DecomposeError } from './errors.ts'
import type { NodeView } from './prompt.ts'
import { readTreeBundle } from './resource-bundle.ts'
import type { CommandService } from './service.ts'
import { publicVerificationOf } from './verification.ts'
import { prepareWorkspace } from './workspace.ts'

export type ChildNodeView = Pick<NodeView,
  'requiredObligations' | 'childBatch' | 'childHistory' | 'recentChildResults'>

interface RunResult {
  readonly runId?: string
  readonly evidenceRef?: Ref
  readonly executionRecordRef?: Ref
  readonly outputs: readonly (InputRef & { readonly kind: 'file' | 'tree' })[]
}

const inputRefs = ({ outputs }: RunResult): InputRef[] => outputs.map(({ id, object, path, access }) => ({ id, object, path, access }))

export interface DirectChildResult extends RunResult {
  readonly task: TaskState
}

/** Only a closed Run's frozen submission can supply artifacts to another Run. */
export async function loadRunResult(service: CommandService, run: RunState | undefined, path: string, idPrefix?: string): Promise<RunResult> {
  const outputs: RunResult['outputs'][number][] = []
  if (run?.closed !== undefined && run.submitted !== undefined) {
    const manifest = parseProtocolValue(submissionManifestSchema, parseJsonText(new TextDecoder('utf-8', { fatal: true }).decode(
      (await service.readObject(run.submitted.outputs, 'object')).bytes)))
    for (const output of [...manifest.outputs, ...manifest.learningDrafts]) {
      if (output.object === undefined) continue
      outputs.push({ id: `${idPrefix ?? run.runId}:${output.id}`, kind: output.kind, object: output.object,
        path: `${path}/${encodeURIComponent(output.id)}`, access: 'read' })
    }
  }
  return { outputs,
    ...(run === undefined ? {} : { runId: run.runId }),
    ...(run?.closed?.evidenceRef === undefined ? {} : { evidenceRef: run.closed.evidenceRef }),
    ...(run?.closed?.executionRecordRef === undefined ? {} : { executionRecordRef: run.closed.executionRecordRef }),
  }
}

/** One journal cut supplies mounts, reads, join guards and verifier inputs. */
export interface DirectChildren {
  readonly results: readonly DirectChildResult[]
  readonly inputs: readonly InputRef[]
  readonly view: ChildNodeView
  readonly requiredFailure: boolean
  readonly submitDenial?: 'CHILD_BATCH_ACTIVE' | 'REQUIRED_FEEDBACK_REPLAN'
}

export async function loadDirectChildren(
  service: CommandService,
  state: TaskRunState,
  taskId: string,
  runId: string,
  template: TaskTemplate,
): Promise<DirectChildren> {
  const results: DirectChildResult[] = []
  for (const childId of state.tasks.get(taskId)?.childIds ?? []) {
    const task = state.tasks.get(childId)
    if (task === undefined) continue
    const lastRun = state.runs.get(task.runIds.at(-1) ?? '')
    let result = await loadRunResult(service, task.phase === 'closed' ? lastRun : undefined, `children/${encodeURIComponent(childId)}`, childId)
    if (task.phase === 'closed' && lastRun?.submitted === undefined) {
      const frozen = task.runIds.map(id => state.runs.get(id)).findLast(run => run?.submitted !== undefined && run.closed !== undefined)
      result = { ...result, outputs: (await loadRunResult(service, frozen, `children/${encodeURIComponent(childId)}`, childId)).outputs }
    }
    results.push({ ...result, task })
  }
  const current = results.filter(result => result.task.parentRunId === runId)
  const requiredObligations = template.children.filter(binding => binding.join === 'required').map(binding => {
    const children = current.filter(result => result.task.bindingId === binding.bindingId
      && result.task.supersededBy === undefined)
    const winner = children.find(result => result.task.closed?.outcome === 'verified')
    return {
      bindingId: binding.bindingId,
      status: winner === undefined ? 'unresolved' as const : 'winner' as const,
      ...(winner === undefined ? {} : { winnerChildId: winner.task.taskId }),
      replacementAllowed: winner === undefined && children.length > 0
        && children.every(result => result.task.phase === 'closed'),
    }
  })
  const active = activeChildBatch(state, runId)
  const outcomes: Record<string, number> = {}
  for (const result of results) {
    const outcome = result.task.closed?.outcome ?? 'active'
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
  }
  const requiredFailure = requiredObligations.some(obligation => obligation.replacementAllowed)
  const submitDenial = active !== undefined ? 'CHILD_BATCH_ACTIVE'
    : current.some(result => result.task.phase !== 'closed')
      ? 'CHILD_BATCH_ACTIVE'
      : requiredObligations.some(obligation => obligation.status !== 'winner')
        ? 'REQUIRED_FEEDBACK_REPLAN' : undefined
  return {
    results,
    inputs: results.flatMap(result => result.outputs),
    requiredFailure,
    ...(submitDenial === undefined ? {} : { submitDenial }),
    view: {
      requiredObligations,
      childBatch: active === undefined ? null : {
        id: active.batchId, total: active.childIds.length,
        terminal: active.childIds.filter(id => state.tasks.get(id)?.phase === 'closed').length,
        detailsCursor: '0',
      },
      childHistory: { total: results.length, outcomes, ...(results.length > 0 ? { detailsCursor: '0' } : {}) },
      recentChildResults: results.slice(-3).map(({ task, evidenceRef, outputs }) => ({
        id: task.taskId, batchId: task.batchId ?? '',
        outcome: task.closed?.outcome ?? null, publicReason: task.closed?.reason ?? null,
        ...(evidenceRef === undefined ? {} : { evidenceRef }),
        ...(outputs.length === 0 ? {} : { outputsPath: `children/${encodeURIComponent(task.taskId)}` }),
      })),
    },
  }
}

/** Materialize declared frozen outputs only; never copy a child workspace. */
export async function mountRunOutputs(service: CommandService, workspace: string, outputs: RunResult['outputs'], mounted: Set<string>): Promise<void> {
  for (const input of outputs) {
    if (mounted.has(input.id)) continue
    if (input.kind === 'tree') {
      const bundle = await readTreeBundle(service, input.object, Number.MAX_SAFE_INTEGER)
      for (const file of bundle.manifest.files) {
        const path = `${input.path}/${file.path}`
        await prepareWorkspace(workspace, [{ ...input, object: file.object, path, access: 'copy-to-work' }], service)
        await chmod(join(workspace, path), 0o444)
      }
    } else {
      await prepareWorkspace(workspace, [{ ...input, access: 'copy-to-work' }], service)
      await chmod(join(workspace, input.path), 0o444)
    }
    mounted.add(input.id)
  }
}

/** All lookups are scoped to direct children, the previous attempt or explicit inputs. */
export async function readChildData(
  service: CommandService,
  children: DirectChildren,
  inputs: readonly InputRef[],
  query: { readonly kind: string; readonly id?: string; readonly cursor?: string; readonly page?: number },
  previous?: RunResult,
): Promise<{ readonly data: JsonValue; readonly objectRef?: Ref; readonly nextCursor?: string }> {
  if (query.kind === 'children') {
    const offset = Number(query.cursor ?? '0')
    const size = query.page ?? 5
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > children.results.length
      || !Number.isSafeInteger(size) || size < 1 || size > 20) {
      throw new DecomposeError('INVALID_ARGUMENT', 'invalid direct child page')
    }
    const rows = []
    let next = offset
    for (; next < children.results.length && rows.length < size; next += 1) {
      const result = children.results[next]
      const row = {
        taskId: result.task.taskId, parentRunId: result.task.parentRunId ?? '',
        goalSummary: result.task.contract.spec.goal.summary,
        deliverable: result.task.contract.spec.goal.deliverable,
        batchId: result.task.batchId ?? '', bindingId: result.task.bindingId ?? '',
        join: result.task.join ?? 'probe', outcome: result.task.closed?.outcome ?? null,
        reason: result.task.closed?.reason ?? null, outputs: inputRefs(result),
        ...(result.evidenceRef === undefined ? {} : { evidenceRef: result.evidenceRef }),
        ...(result.executionRecordRef === undefined ? {} : { executionRecordRef: result.executionRecordRef }),
      }
      if (Buffer.byteLength(JSON.stringify([...rows, row])) > 12 * 1024) {
        if (rows.length > 0) break
        throw new DecomposeError('INVALID_ARGUMENT', 'one child record exceeds the read budget; read its evidence by ID instead')
      }
      rows.push(row)
    }
    return { data: rows as unknown as JsonValue,
      ...(next < children.results.length ? { nextCursor: String(next) } : {}) }
  }
  if (query.kind === 'evidence') {
    const result = children.results.find(result => result.task.taskId === query.id
      || result.runId === query.id || result.evidenceRef?.id === query.id || result.executionRecordRef?.id === query.id)
      ?? (previous !== undefined && (previous.runId === query.id || previous.evidenceRef?.id === query.id
        || previous.executionRecordRef?.id === query.id) ? previous : undefined)
    const ref = result?.evidenceRef ?? result?.executionRecordRef
    if (result === undefined || ref === undefined) throw new DecomposeError('INPUT_NOT_AUTHORIZED', 'no direct child or previous attempt result is authorized by this id')
    const { bytes } = await service.readObject(ref, result.evidenceRef === undefined ? 'object' : 'evidence')
    const value = parseJsonText(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (result.evidenceRef === undefined) return readPage(canonicalize({ outputs: inputRefs(result), result: value }), ref, query.cursor)
    const evidence = parseProtocolValue(evidenceSchema, value)
    const receipt = parseProtocolValue(publicReceiptSchema, parseJsonText(new TextDecoder('utf-8', { fatal: true }).decode(
      (await service.readObject(evidence.verification.publicReceipt, 'object')).bytes)))
    return readPage(canonicalize({ outputs: inputRefs(result), result: { ...evidence, verification: publicVerificationOf(evidence.verification) }, publicReceipt: receipt }), ref, query.cursor)
  }
  if (query.kind === 'resource') {
    const input = [...inputs, ...children.inputs, ...(previous?.outputs ?? [])].find(input => input.id === query.id || input.object.id === query.id)
    if (input === undefined) throw new DecomposeError('INPUT_NOT_AUTHORIZED', 'resource is not an authorized input or direct output')
    const { bytes } = await service.readObject(input.object, 'object')
    if (!isUtf8(bytes)) throw new DecomposeError('INVALID_ARGUMENT', `Resource is binary. Use native file tools at the declared path ${input.path}; binary inputs require copy-to-work. Pass its frozen Ref as a child input when needed.`)
    const text = new TextDecoder().decode(bytes)
    return readPage(text, input.object, query.cursor)
  }
  throw new DecomposeError('INVALID_ARGUMENT', 'unsupported read kind')
}

function readPage(text: string, objectRef: Ref, cursor = '0'): { data: JsonValue; objectRef: Ref; nextCursor?: string } {
  const offset = Number(cursor)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
    throw new DecomposeError('INVALID_ARGUMENT', 'invalid result/resource cursor')
  }
  const end = Math.min(text.length, offset + 4096)
  return { data: text.slice(offset, end), objectRef,
    ...(end < text.length ? { nextCursor: String(end) } : {}) }
}
