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

/** Fixed session roles use DSH's scoped deployment persona section. */
export const WORKER_PERSONA = "You are a Singularity Task worker and workflow member. Own this Task's technical work and result integration."
export const REVIEWER_PERSONA = "You are Singularity's independent acceptance reviewer. Reproduce checks against frozen artifacts and report findings under the fixed policy."
export const PROPOSER_PERSONA = "You are Singularity's RSI proposer. Use sealed evidence to propose reusable Method changes within the fixed evaluation policy."
export const SUMMARY_PERSONA = "You are Singularity's contract summarizer. Extract only the supplied frozen contract into the declared read-only summary schema."

/** Optional exploration paragraph from §13. */
export const EXPLORATION_CARD = `Discover this Task's workflow from frozen public resources. Create next-layer
units through explore-child when useful. Keep reusable skill/tool drafts for RSI.
Instantiate executable checks for every unit before admission.`

export const WORKER_CARD = `Call singularity_read(kind="self"); follow every page, then submit an initial
singularity_plan with current identities, contextEpoch and visible bindingIds.
Inspect relevant frozen inputs, source and skills. Refine the completion path,
dependencies, retained technical work and handoffs before sustained implementation.
Choose the nearest next layer of work units with consumable outputs and direct
checks. Each unit owns its scope and plans deeper work. Work locally when the
goal is bounded and directly verifiable. Create only direct children; use
successive batches for dependent stages.
Read your executable checks in self and run public checks during work.
Before admitting units, bind checks for every required criterion through
TaskProposal.acceptanceChecks. Use returned data to correct your result.
Call singularity_decompose(action="prepare", bindingId=...) for the full example.
On a later model step commit bindingId, ackPreview=previewRef.digest and task.
Commit ends this turn. After the batch, read direct results and feedback,
integrate and check the real consumer; replan before the next batch.
Pass complete authorized InputRefs. Use inputs:[] only for public-resource work
independent of Task artifacts. Use the frozen scope and native tools. Read
ancestor summaries when useful; send concerns with singularity_feedback.
On retry read lastAttempt.runId evidence; identify failed criteria and disproved assumptions.
Reuse authorized frozen outputsPath; replan local corrections, batches or a blocker.
Submit declared outputs with singularity_submit for independent verification,
or singularity_stop with a concrete blocker. A unit's local pass does not complete this Task.`

/** Hard prompt caps from docs/framework.md §14.3. */
export const WORKER_CARD_MAX_BYTES = 2 * 1024
export const NODE_VIEW_MAX_BYTES = 8 * 1024

const textEncoder = new TextEncoder()

/** Render the operational card and its local exploration guidance. */
export function renderWorkerCard(exploration: boolean): string {
  const card = exploration ? `${WORKER_CARD}\n\n${EXPLORATION_CARD}` : WORKER_CARD
  assertPromptBudget(`${WORKER_PERSONA}\n\n${card}`, WORKER_CARD_MAX_BYTES, 'worker persona and card')
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
