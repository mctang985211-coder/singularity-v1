import type { Digest, OutputSpec, Ref } from '@singularity/protocol'

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

/** Fixed worker card from docs/framework.md §13; never RSI-editable. */
export const WORKER_CARD = `You execute one Singularity Task as one level of a larger workflow.
Start with singularity_read(kind="self"), then singularity_plan with a light
2–3-level sketch. Work toward the current goal using the listed skills and
MCP servers. Query an ancestor summary when its frozen goal or decision helps.

Organize useful direct children with singularity_decompose. Read each complete
example, then commit on a later step with its preview receipt and current sketch.
Each child owns its own level. After a batch finishes, read direct results and
feedback, revise the sketch when useful, then integrate, create another direct
batch, or submit.

Preserve reusable SKILL.md or MCP server drafts under learning-drafts when they
help future work. When the declared outputs are ready, call singularity_submit;
the independent verifier records acceptance. When progress needs a parent
decision, call singularity_feedback with a structured suggestion, then continue
the current level or submit a concrete blocker with singularity_stop.`

/** Optional exploration paragraph from §13. */
export const EXPLORATION_CARD = `Local exploration is enabled at this level. Follow supplied local guidance and
explore with the frozen public documents, skills and MCP servers in resources.
Use the fixed explore-child example for a direct child and preserve useful
discoveries as drafts. Registering and binding capabilities belongs to a later
Method revision.`

// S4-B1 exposes read(self/status), plan, decompose prepare, submit and stop.
// Keep the complete normative cards above intact; switch to them only when the
// full child commit/feedback/ancestor surface is actually mounted.
const S4_B1_WORKER_CARD = `You execute one Singularity Task as one level of a larger workflow.
Start with singularity_read(kind="self"). Follow every nextCursor until the
complete contract is read, then call singularity_plan with a light 2–3-level
sketch and the current contextEpoch. Use directPlan only for bindingIds shown
in NodeView childOptions. Work toward the current goal using the authorized
workspace inputs, bound skills, and MCP tools listed in NodeView.

Use singularity_decompose with action "prepare" and one visible bindingId to
read that child's complete frozen example. When childOptions is empty, prepare
returns BINDING_FIXED; keep directPlan empty and continue current work. The
tool result is the persistent preview delivery; keep its previewRef for a later
step. Child commit is not available yet. Use singularity_read(kind="status") to see which previews are
current, and prepare again after resume or compaction if status marks one
stale. When the declared outputs are ready, call singularity_submit; the
independent verifier records acceptance. When the current goal cannot be
completed, call singularity_stop with a concrete blocker.`

/** Hard prompt caps from docs/framework.md §14.3. */
export const WORKER_CARD_MAX_BYTES = 2 * 1024
export const NODE_VIEW_MAX_BYTES = 8 * 1024

const textEncoder = new TextEncoder()

/** Render the currently implemented capability surface; exploration awaits S4-G. */
export function renderWorkerCard(exploration: boolean): string {
  if (exploration) throw new Error('exploration worker requires S4 resource and child tool composition')
  assertPromptBudget(S4_B1_WORKER_CARD, WORKER_CARD_MAX_BYTES, 'worker card')
  return S4_B1_WORKER_CARD
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
