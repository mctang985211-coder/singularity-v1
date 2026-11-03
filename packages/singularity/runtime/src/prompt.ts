import type { Digest,OutputSpec,Ref } from '@singularity/protocol'

/** Model-visible remaining budget; exact counters stay in host guards. */
export interface RemainingBudgetPct {
  readonly tokensPct: number | null
  readonly stepsPct: number
  readonly wallClockPct: number
  readonly depthPct: number
  readonly taskSlotsPct: number
}

/** Required dynamic NodeView from docs/framework.md §12.2. */
export interface NodeView {
  readonly v: 1
  readonly asOf: number
  readonly contextEpoch: string
  readonly task: {
    readonly id: string
    readonly runId: string
    readonly parentId?: string
    readonly goalSummary: string
    readonly contractDigest: Digest
    readonly phase: 'working' | 'waiting-children' | 'integrating'
    readonly mode: 'guided' | 'exploration'
  }
  readonly method: Ref
  readonly ownTemplate: { readonly id: string; readonly brief: string }
  readonly documents: readonly { readonly id: string; readonly description: string }[]
  readonly skills: readonly { readonly id: string; readonly name: string }[]
  readonly tools: readonly { readonly name: string }[]
  readonly childOptions: readonly {
    readonly bindingId: string
    readonly templateId: string
    readonly brief: string
    readonly join: 'required' | 'probe'
  }[]
  readonly requiredObligations: readonly {
    readonly bindingId: string
    readonly status: 'unresolved' | 'winner'
    readonly winnerChildId?: string
    readonly replacementAllowed: boolean
  }[]
  readonly childBatch: {
    readonly id: string
    readonly total: number
    readonly terminal: number
    readonly detailsCursor?: string
  } | null
  readonly childHistory: {
    readonly total: number
    readonly outcomes: Readonly<Record<string, number>>
    readonly detailsCursor?: string
  }
  readonly recentChildResults: readonly {
    readonly id: string
    readonly batchId: string
    readonly outcome: string | null
    readonly publicReason: string | null
    readonly evidenceRef?: Ref
    readonly outputsPath?: string
  }[]
  readonly obligations: {
    readonly readSelf: boolean
    readonly readPlanningSketch: boolean
    readonly requiredFailure: boolean
    readonly canDecompose: boolean
    readonly canSubmit: boolean
    readonly denialCodes: readonly string[]
  }
  readonly planningSketchRef: Ref | null
  readonly feedback: { readonly count: number; readonly cursor?: string }
  readonly lastAttempt: { readonly runId: string; readonly reason: string; readonly outputsPath?: string } | null
  readonly budget: RemainingBudgetPct
  readonly workspace: { readonly cwd: string; readonly outputs: readonly OutputSpec[] }
}

/** Optional exploration paragraph from §13. */
export const EXPLORATION_CARD = `Discover the workflow from available resources. Use explore-child for direct
responsibilities and preserve reusable discoveries as skill/tool drafts for RSI.`

export const WORKER_PERSONA = 'You own a Singularity Task: one workflow node responsible for its technical work, direct children and integration.'
export const SUMMARY_PERSONA = 'You are the contract summarizer. Extract only the supplied frozen contract into the declared summary schema.'
export const PROPOSER_PERSONA = 'You are the RSI proposer. Propose reusable Method changes from sealed evidence under the fixed evaluation policy.'

export const WORKER_CARD = `Read singularity_read(kind="self"), following all pages, then singularity_plan.
Inspect relevant inputs, source and references; refine the completion path,
dependencies, work retained here and interfaces before sustained implementation.
Levels describe responsibility scopes: 0=this Task, 1=direct children, 2=possible
deeper work. Create only direct children; each discovers its own workflow.
Use current contextEpoch and visible bindingIds. A bounded, directly verifiable
leaf may finish locally. Use later batches for work that consumes earlier results.

Define each child's input source, output consumer and interface before dispatch.
Author acceptanceCriteria with goal-specific pass rules and self-contained
shell checks, including any new test code inline.
Checks run from the workspace root using declared input/output paths. Run your
checks during work and use observed data to correct failures. They are frozen
in the contract and independently rerun after submission.
Call singularity_decompose(action="prepare", bindingId=...) for the example;
on a later step commit children with bindingId, ackPreview=previewRef.digest
and task. Commit ends this turn. When children finish, read their outputs and
findings, integrate through the actual consumer, check and update your plan.
A child's pass does not complete this Task. Copy complete authorized InputRefs
from self or direct results; inputs:[] means no dependency on Task artifacts.
Use singularity_feedback for contract concerns. On retry read lastAttempt.runId
evidence and reuse its frozen outputsPath; revise the failed work or handoff.
Call singularity_submit for declared outputs, or singularity_stop with a concrete blocker.`

/** Hard prompt caps from docs/framework.md §14.3. */
export const WORKER_CARD_MAX_BYTES = 2 * 1024
export const NODE_VIEW_MAX_BYTES = 8 * 1024

const textEncoder = new TextEncoder()

/** Render the operational card and its local exploration guidance. */
export function renderWorkerCard(exploration: boolean): string {
  const card = exploration ? `${WORKER_CARD}\n\n${EXPLORATION_CARD}` : WORKER_CARD
  assertPromptBudget(`${WORKER_PERSONA}\n${card}`, WORKER_CARD_MAX_BYTES, 'worker card')
  return card
}

/** Render the required NodeView context as compact JSON. */
export function renderNodeView(view: NodeView): string {
  const text = JSON.stringify(view)
  assertPromptBudget(text, NODE_VIEW_MAX_BYTES, 'NodeView')
  return text
}

/** Enforces a prompt contribution cap with a stable diagnostic. */
export function assertPromptBudget(text: string, limit: number, label: string): void {
  const bytes = textEncoder.encode(text).byteLength
  if (bytes > limit) {
    throw new Error(`${label} is ${String(bytes)} bytes, above the ${String(limit)} byte budget`)
  }
}

/** Clamp one remaining percentage to 0–100 and floor it. */
export function clampPercent(remaining: number, total: number): number {
  if (!Number.isFinite(remaining) || !Number.isFinite(total) || total <= 0) return 0
  const value = Math.floor((remaining / total) * 100)
  return Math.max(0, Math.min(100, value))
}
