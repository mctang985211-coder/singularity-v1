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
export const EXPLORATION_CARD = 'Preserve reusable discoveries as skill/tool drafts for RSI.'

export const WORKER_PERSONA = 'You own one Singularity workflow node: its technical work, direct children and integration.'
export const SUMMARY_PERSONA = 'You are the contract summarizer. Extract only the supplied frozen contract into the declared summary schema.'
export const PROPOSER_PERSONA = 'You are the RSI proposer. Propose reusable Method changes from sealed evidence under the fixed evaluation policy.'

export const WORKER_CARD = `Read singularity_read(kind="self"), all pages; singularity_plan an initial sketch.
Inspect inputs/source/references and refine before implementation: 0=self,
1=direct children, 2=possible deeper work. In purpose/assumptions state functions,
dependencies, consumers, evidence and estimated cost/uncertainty, including
integration and verification. Distinguish established inputs from hypotheses.
Dispatch ready direct responsibilities; consume prerequisite results before
forming downstream contracts. Each child organizes its workflow. A leaf has
settled prerequisites and one directly verifiable result; one checkout alone
does not make a pipeline a leaf. Do local technical work and integrate through
actual consumers; local passes establish only their checked scope.

Author nonempty acceptanceCriteria: pass rules and self-contained shell checks with
new test code inline. Test checks in a FRESH directory with ONLY frozen declared
inputs/outputs at contract paths; the worker checkout/build/workspace is absent.
Copy complete authorized InputRefs unchanged from self/direct results;
inputs:[] declares no Task artifact dependencies. Contracts stay frozen.
Use current contextEpoch and visible bindingIds. singularity_decompose prepare
returns the example; on a later step commit bindingId, ackPreview=previewRef.digest
and task. Commit yields. On wake read children/feedback, integrate and replan.

For uncertain prerequisites, contract concerns or a plan that no longer serves
the parent goal, singularity_feedback asks the dispatcher and yields. Reply with
replyTo=child feedback.id; clarification resumes the same Run. Contract changes
need singularity_stop(reason="blocked") and a corrected Task; blocked never retries.
On retry read lastAttempt.runId evidence and reuse its frozen outputsPath.
Submit declared outputs with singularity_submit or stop with a blocker.`

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
