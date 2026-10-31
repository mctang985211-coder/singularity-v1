import { chmod } from 'node:fs/promises'
import { join } from 'node:path'

import type { InputRef,JsonValue,Ref,TaskRunState,TaskState,TaskTemplate } from '@singularity/protocol'
import { evidenceSchema,parseJsonText,parseProtocolValue,submissionManifestSchema } from '@singularity/protocol'

import { activeChildBatch } from './decompose-commit.ts'
import { DecomposeError } from './errors.ts'
import type { NodeView } from './prompt.ts'
import { readTreeBundle } from './resource-bundle.ts'
import type { CommandService } from './service.ts'
import { publicVerificationOf } from './verification.ts'
import { prepareWorkspace } from './workspace.ts'

export type ChildNodeView = Pick<NodeView,
  'requiredObligations' | 'childBatch' | 'childHistory' | 'recentChildResults'>

export interface DirectChildResult {
  readonly task: TaskState
  readonly evidenceRef?: Ref
  readonly executionRecordRef?: Ref
  readonly outputs: readonly (InputRef & { readonly kind: 'file' | 'tree' })[]
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
    const outputs: (InputRef & { readonly kind: 'file' | 'tree' })[] = []
    if (task.phase === 'closed' && lastRun?.submitted !== undefined) {
      const manifest = parseProtocolValue(submissionManifestSchema,
        parseJsonText(new TextDecoder('utf-8', { fatal: true }).decode(
          (await service.readObject(lastRun.submitted.outputs, 'object')).bytes)))
      for (const output of [...manifest.outputs, ...manifest.learningDrafts]) {
        if (output.object === undefined) continue
        outputs.push({
          id: `${childId}:${output.id}`,
          kind: output.kind,
          object: output.object,
          path: `children/${encodeURIComponent(childId)}/${encodeURIComponent(output.id)}`,
          access: 'read',
        })
      }
    }
    results.push({ task, outputs,
      ...(lastRun?.closed?.evidenceRef === undefined ? {} : { evidenceRef: lastRun.closed.evidenceRef }),
      ...(lastRun?.closed?.executionRecordRef === undefined ? {} : { executionRecordRef: lastRun.closed.executionRecordRef }),
    })
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
export async function mountDirectOutputs(service: CommandService, workspace: string, children: DirectChildren, mounted: Set<string>): Promise<void> {
  for (const result of children.results) {
    for (const input of result.outputs) {
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
}

/** All lookups are scoped to direct children or explicitly authorized inputs. */
export async function readChildData(
  service: CommandService,
  children: DirectChildren,
  inputs: readonly InputRef[],
  query: { readonly kind: string; readonly id?: string; readonly cursor?: string; readonly page?: number },
): Promise<{ readonly data: JsonValue; readonly objectRef?: Ref; readonly nextCursor?: string }> {
  if (query.kind === 'children') {
    const offset = Number(query.cursor ?? '0')
    const size = query.page ?? 5
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > children.results.length
      || !Number.isSafeInteger(size) || size < 1 || size > 20) {
      throw new DecomposeError('INVALID_ARGUMENT', 'invalid direct child page')
    }
    const rows = children.results.slice(offset, offset + size).map(result => ({
      taskId: result.task.taskId, parentRunId: result.task.parentRunId ?? '',
      batchId: result.task.batchId ?? '', bindingId: result.task.bindingId ?? '',
      join: result.task.join ?? 'probe', outcome: result.task.closed?.outcome ?? null,
      reason: result.task.closed?.reason ?? null, outputs: result.outputs,
      ...(result.evidenceRef === undefined ? {} : { evidenceRef: result.evidenceRef }),
      ...(result.executionRecordRef === undefined ? {} : { executionRecordRef: result.executionRecordRef }),
    }))
    const next = offset + rows.length
    return { data: rows as unknown as JsonValue,
      ...(next < children.results.length ? { nextCursor: String(next) } : {}) }
  }
  if (query.kind === 'evidence') {
    const child = children.results.find(result => result.task.taskId === query.id
      || result.evidenceRef?.id === query.id || result.executionRecordRef?.id === query.id)
    const ref = child?.evidenceRef ?? child?.executionRecordRef
    if (ref === undefined) throw new DecomposeError('INPUT_NOT_AUTHORIZED', 'no direct child result is authorized by this id')
    const { bytes } = await service.readObject(ref, child?.evidenceRef === undefined ? 'object' : 'evidence')
    const value = parseJsonText(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (child?.evidenceRef === undefined) return { data: value, objectRef: ref }
    const evidence = parseProtocolValue(evidenceSchema, value)
    return { data: { ...evidence, verification: publicVerificationOf(evidence.verification) } as unknown as JsonValue, objectRef: ref }
  }
  if (query.kind === 'resource') {
    const input = [...inputs, ...children.inputs].find(input => input.id === query.id || input.object.id === query.id)
    if (input === undefined) throw new DecomposeError('INPUT_NOT_AUTHORIZED', 'resource is not an authorized input or direct output')
    const { bytes } = await service.readObject(input.object, 'object')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const offset = Number(query.cursor ?? '0')
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
      throw new DecomposeError('INVALID_ARGUMENT', 'invalid resource cursor')
    }
    const end = Math.min(text.length, offset + 4096)
    return { data: text.slice(offset, end), objectRef: input.object,
      ...(end < text.length ? { nextCursor: String(end) } : {}) }
  }
  throw new DecomposeError('INVALID_ARGUMENT', 'unsupported read kind')
}
