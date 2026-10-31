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
  readonly lastAttempt: { readonly runId: string; readonly reason: string } | null
  readonly budget: RemainingBudgetPct
  readonly workspace: { readonly cwd: string; readonly outputs: readonly OutputSpec[] }
}

/** Optional exploration paragraph from §13. */
export const EXPLORATION_CARD = `Local exploration is enabled at this level. Follow supplied local guidance and
explore with the frozen public documents, skills and MCP servers in resources.
Use the fixed explore-child example for a direct child and preserve useful
discoveries as drafts. Registering and binding capabilities belongs to a later
Method revision.`

// Compact operational card keeps the frozen example/ack sequence explicit.
export const WORKER_CARD = `You execute one Singularity Task as one level of a larger workflow.
Start with singularity_read(kind="self"). Follow every nextCursor until the
complete contract is read, then call singularity_plan with levels [0,1] or
[0,1,2]: 0 is this Task, 1 direct children, 2 possible grandchildren, not
sequential work steps. Commit only level 1; each child replans its own level.
Use the current contextEpoch and directPlan only for bindingIds shown
in NodeView childOptions. Work toward the current goal using the authorized
workspace inputs, bound skills, and MCP tools listed in NodeView.

Use singularity_decompose with action "prepare" and one visible bindingId to
read that child's complete frozen example. With no useful child, keep directPlan
empty and do current work. On a later model step, commit
children with bindingId, ackPreview equal to previewRef.digest, and task filled
with goal, localCriteria, authorized inputs and localOutputs. A successful
commit concludes this turn and releases the parent while its batch is active.
Use singularity_read(kind="status") to inspect previews; prepare again when
status marks one stale. After a batch, read direct child results and feedback,
then integrate or prepare the next batch. Read an ancestor summary when useful.
Use singularity_feedback for a direct-parent suggestion and continue local work.
When the declared outputs are ready, call singularity_submit; the
independent verifier records acceptance. When the current goal cannot be
completed, call singularity_stop with a concrete blocker.`

/** Hard prompt caps from docs/framework.md §14.3. */
export const WORKER_CARD_MAX_BYTES = 2 * 1024
export const NODE_VIEW_MAX_BYTES = 8 * 1024

const textEncoder = new TextEncoder()

/** Render the operational card and its local exploration guidance. */
export function renderWorkerCard(exploration: boolean): string {
  const card = exploration ? `${WORKER_CARD}\n\n${EXPLORATION_CARD}` : WORKER_CARD
  assertPromptBudget(card, WORKER_CARD_MAX_BYTES, 'worker card')
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
