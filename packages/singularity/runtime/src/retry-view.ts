import type { Composition,CompositionPayload,Fact,JsonValue,Ref,TaskContract,TaskRunState } from '@singularity/protocol'
import { canonicalize,compositionPayloadSchema,compositionSchema,parseJsonText,parseProtocolValue,verifyDigest } from '@singularity/protocol'
import { SingleRunError } from './errors.ts'
import type { CommandService } from './service.ts'
import type { CasDigestDomain } from './store.ts'
import type { CasObjectReader } from './workspace.ts'
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/** Frozen journal view for one known Run. */
export interface RunJournalView {
  readonly state: TaskRunState
  readonly taskId: string
  readonly contract: TaskContract
  readonly composition: Composition
  readonly compositionRef: Ref
  readonly runOpened: Extract<Fact, { readonly type: 'run/opened' }>
  readonly runSubmitted?: Extract<Fact, { readonly type: 'run/submitted' }>
  readonly runClosed?: Extract<Fact, { readonly type: 'run/closed' }>
  readonly taskClosed?: Extract<Fact, { readonly type: 'task/closed' }>
  readonly runIds: readonly string[]
}

export async function readRunJournalView(
  reader: CommandService,
  runId: string,
  transientInvalidReasons: readonly string[],
): Promise<RunJournalView> {
  const facts = reader.facts()
  const state = await reader.taskRunState(transientInvalidReasons)
  const runOpened = facts.find((fact): fact is Extract<Fact, { type: 'run/opened' }> =>
    fact.type === 'run/opened' && fact.data.runId === runId)
  if (runOpened === undefined) {
    throw new SingleRunError('RUN_NOT_FOUND', `Run ${JSON.stringify(runId)} has no run/opened fact`)
  }
  const taskId = runOpened.data.taskId
  const task = state.tasks.get(taskId)
  if (task === undefined) throw new SingleRunError('RUN_NOT_FOUND', 'Run Task is missing from the projection')
  const contract = task.contract
  const compositionRef = runOpened.data.composition
  const composition = await readFrozenComposition(reader, compositionRef)
  const runSubmitted = facts.find((fact): fact is Extract<Fact, { type: 'run/submitted' }> =>
    fact.type === 'run/submitted' && fact.data.runId === runId)
  const runClosed = facts.find((fact): fact is Extract<Fact, { type: 'run/closed' }> =>
    fact.type === 'run/closed' && fact.data.runId === runId)
  const taskClosed = facts.find((fact): fact is Extract<Fact, { type: 'task/closed' }> =>
    fact.type === 'task/closed' && fact.data.taskId === taskId)
  return {
    state,
    taskId,
    contract,
    composition,
    compositionRef,
    runOpened,
    ...(runSubmitted === undefined ? {} : { runSubmitted }),
    ...(runClosed === undefined ? {} : { runClosed }),
    ...(taskClosed === undefined ? {} : { taskClosed }),
    runIds: task.runIds,
  }
}

/** Reads and verifies the Composition frozen by `run/opened`. */
async function readFrozenComposition(
  reader: CasObjectReader,
  ref: Ref,
): Promise<Composition> {
  const value = await readJsonValue(reader, ref, 'composition')
  let composition: Composition
  try {
    composition = parseProtocolValue(compositionSchema, value)
  } catch (error) {
    throw new SingleRunError('COMPOSITION_MISMATCH', 'frozen Composition is not strict JSON', { cause: error })
  }
  if (!verifyDigest('composition', composition)) {
    throw new SingleRunError('COMPOSITION_MISMATCH', 'frozen Composition digest does not verify')
  }
  if (composition.digest !== ref.digest) {
    throw new SingleRunError('COMPOSITION_MISMATCH', 'frozen Composition digest does not match its ref')
  }
  return composition
}

/** Strips the seal from a frozen Composition for comparison. */
export function compositionPayloadOf(composition: Composition): CompositionPayload {
  const { digest, ...payload } = composition
  if (typeof digest !== 'string') {
    throw new SingleRunError('COMPOSITION_MISMATCH', 'frozen Composition has no digest')
  }
  return parseProtocolValue(compositionPayloadSchema, payload)
}

/** Compares the complete actual and frozen Composition payloads. */
export function compareCompositionPayload(
  frozen: Composition,
  actual: CompositionPayload,
): boolean {
  let parsed: CompositionPayload
  try {
    parsed = parseProtocolValue(compositionPayloadSchema, actual)
  } catch {
    return false
  }
  try {
    return canonicalize(parsed as unknown as JsonValue)
      === canonicalize(compositionPayloadOf(frozen) as unknown as JsonValue)
  } catch {
    return false
  }
}

async function readJsonValue(
  reader: CasObjectReader,
  ref: Ref,
  domain: CasDigestDomain,
): Promise<JsonValue> {
  const { bytes } = await reader.readObject(ref, domain)
  let text: string
  try {
    text = strictUtf8.decode(bytes)
  } catch (error) {
    throw new SingleRunError('INVALID_ARGUMENT', 'frozen CAS object is not UTF-8', { cause: error })
  }
  return parseJsonText(text)
}
