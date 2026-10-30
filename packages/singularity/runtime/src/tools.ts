import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { canonicalize, parseProtocolValue, planningSketchSchema } from '@singularity/protocol'
import type {
  JsonValue,
  PlanningSketch,
  Ref,
  TaskContract,
} from '@singularity/protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

import type { ContextEpoch } from './epoch.ts'
import { deriveContextEpoch } from './epoch.ts'
import type { RemainingBudgetPct } from './prompt.ts'
import { freezeSubmission } from './workspace.ts'
import type { FrozenSubmission, CasObjectWriter } from './workspace.ts'

const TOOL_ERROR_NEXT_ACTIONS: Readonly<Record<string, string>> = {
  INVALID_ARGUMENT: 'Fix the tool arguments and retry with declared fields only.',
  READ_SELF_FIRST: 'Call singularity_read(kind="self"), then continue.',
  PLAN_FIRST: 'Call singularity_plan with the current contextEpoch, then continue.',
  ALREADY_SUBMITTED: 'The submission is already frozen; stop calling tools.',
  RUN_CLOSED: 'This Run is already settling; stop calling tools.',
  ACTIVE_JOB: 'Wait for the current submission to settle, then continue.',
  LIMIT_EXCEEDED: 'Reduce the requested scope or stop with a concrete blocker.',
}

const textEncoder = new TextEncoder()

export interface RunToolControllerOptions {
  readonly contract: TaskContract
  readonly runId: string
  readonly sessionId: string
  readonly workspace: string
  readonly writer: CasObjectWriter
  readonly maxOutputBytes: number
  readonly clock: () => number
  readonly budget: () => RemainingBudgetPct
  /** Exact host budget/deadline check; percentages are presentation only. */
  readonly checkBudget: () => boolean
  readonly epoch: () => ContextEpoch
  /** Called once when DSH hands the composed Agent to setup. */
  readonly onAgent?: (agent: Agent) => void
  readonly commitSubmission: (
    frozen: FrozenSubmission,
    sessionId: string,
    transcriptSeq: number,
  ) => Promise<Ref>
}

export interface RunToolSnapshot {
  readonly readSelf: boolean
  readonly planningSketchRef?: Ref
  readonly submission?: FrozenSubmission
  readonly submitted: boolean
  readonly stopped?: { readonly reason: 'blocked' | 'unsolved'; readonly message: string }
  readonly contextEpoch: ContextEpoch
}

interface MutableRunToolState {
  epoch: ContextEpoch
  readSelf: boolean
  submitting: boolean
  submitted: boolean
  planningSketchRef?: Ref
  submission?: FrozenSubmission
  stopped?: { readonly reason: 'blocked' | 'unsolved'; readonly message: string }
}

/**
 * Runtime-owned Task tool surface for one Run. It registers only
 * read/plan/submit/stop on the DSH scoped tool registry and applies one guard
 * shared by Task and base/domain tools. It is not a second registry: all
 * registrations live in DSH's scoped tool service and unwind with the Agent.
 */
export class RunToolController {
  private readonly options: RunToolControllerOptions
  private readonly state: MutableRunToolState
  private agent: Agent | undefined

  constructor(options: RunToolControllerOptions) {
    this.options = options
    this.state = {
      epoch: options.epoch(),
      readSelf: false,
      submitting: false,
      submitted: false,
    }
  }

  /** Register the four Task tools and the shared guard in the Agent scope. */
  register(agentCtx: Context, agent: Agent): void {
    this.agent = agent
    this.options.onAgent?.(agent)
    agentCtx.tools.register(this.readTool())
    agentCtx.tools.register(this.planTool())
    agentCtx.tools.register(this.submitTool())
    agentCtx.tools.register(this.stopTool())
    agentCtx.tools.guard(execution => this.checkGuard(execution))
  }

  /**
   * Shared dispatch gate. `undefined` allows the call; a returned short JSON
   * string is a fail-closed protocol refusal with a positive next action.
   */
  checkGuard(execution: Readonly<ToolExecution>): string | undefined {
    this.refreshEpoch()
    if (this.state.submitted) return this.refusal('ALREADY_SUBMITTED')
    if (this.state.stopped !== undefined) return this.refusal('RUN_CLOSED')
    if (this.state.submitting) return this.refusal('ACTIVE_JOB')
    if (this.agent === undefined || execution.agent !== this.agent) {
      return this.refusal('INVALID_ARGUMENT')
    }
    if (execution.name === 'singularity_read' || execution.name === 'singularity_stop') {
      return undefined
    }
    if (!this.options.checkBudget()) return this.refusal('LIMIT_EXCEEDED')
    if (!this.state.readSelf) return this.refusal('READ_SELF_FIRST')
    if (execution.name === 'singularity_plan') return undefined
    if (this.state.planningSketchRef === undefined) return this.refusal('PLAN_FIRST')
    return undefined
  }

  /** Current durable tool facts for settlement; no extra state authority. */
  snapshot(): RunToolSnapshot {
    this.refreshEpoch()
    return {
      readSelf: this.state.readSelf,
      ...(this.state.planningSketchRef === undefined
        ? {}
        : { planningSketchRef: this.state.planningSketchRef }),
      ...(this.state.submission === undefined ? {} : { submission: this.state.submission }),
      submitted: this.state.submitted,
      ...(this.state.stopped === undefined ? {} : { stopped: this.state.stopped }),
      contextEpoch: this.state.epoch,
    }
  }

  private readTool() {
    return defineTool({
      name: 'singularity_read',
      description: 'Read the current Task contract, status, output paths, and remaining budget percentages.',
      parameters: {
        kind: { type: 'string', enum: ['self', 'status'], required: true, description: 'Read the complete self contract or compact status.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            data: { type: 'json', required: true },
            objectRef: refValueSchema(false),
            asOf: { type: 'integer', required: true },
            contextEpoch: { type: 'string', required: true },
            remainingBudgetPct: budgetValueSchema(),
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: (args) => {
        assertExactKeys(args, ['kind'])
        this.refreshEpoch()
        const asOf = this.options.clock()
        if (args.kind === 'status') {
          return Promise.resolve({
            data: {
              taskId: this.options.contract.taskId,
              runId: this.options.runId,
              phase: this.state.submitted ? 'integrating' : 'working',
              readSelf: this.state.readSelf,
              hasPlanningSketch: this.state.planningSketchRef !== undefined,
              submitted: this.state.submitted,
              stopped: this.state.stopped !== undefined,
            },
            asOf,
            contextEpoch: this.state.epoch,
            remainingBudgetPct: this.options.budget(),
          })
        }

        const contract = this.options.contract
        const data = {
          taskId: contract.taskId,
          runId: this.options.runId,
          contractDigest: contract.digest,
          goal: contract.spec.goal,
          criteria: contract.spec.criteria,
          localGuidance: contract.spec.localGuidance ?? [],
          inputs: contract.spec.inputs.map(input => ({
            id: input.id,
            path: input.path,
            access: input.access,
          })),
          outputs: contract.spec.outputs,
          acceptance: {
            provider: contract.acceptance,
            criteria: contract.spec.criteria.filter(criterion => criterion.required),
          },
          workspace: this.options.workspace,
          planningSketchRef: this.state.planningSketchRef ?? null,
          contextEpoch: this.state.epoch,
        }
        this.state.readSelf = true
        return Promise.resolve({
          data,
          ...(this.state.planningSketchRef === undefined
            ? {}
            : { objectRef: this.state.planningSketchRef }),
          asOf,
          contextEpoch: this.state.epoch,
          remainingBudgetPct: this.options.budget(),
        })
      },
    })
  }

  private planTool() {
    return defineTool({
      name: 'singularity_plan',
      description: 'Store the current Run PlanningSketch. It creates no Task and changes no contract.',
      parameters: {
        sketch: {
          type: 'object',
          additionalProperties: false,
          required: true,
          description: 'Strict PlanningSketch with ordered levels [0,1] or [0,1,2].',
          properties: {
            v: { type: 'integer', const: 1, required: true },
            taskId: { type: 'string', required: true },
            runId: { type: 'string', required: true },
            contextEpoch: { type: 'string', required: true },
            objective: { type: 'string', required: true },
            levels: { type: 'array', items: { type: 'json' }, required: true },
            directPlan: { type: 'array', items: { type: 'json' }, required: true },
            assumptions: { type: 'array', items: { type: 'string' }, required: true },
            sourceContract: { type: 'string', required: true },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            planningSketchRef: refValueSchema(true),
            contextEpoch: { type: 'string', required: true },
            remainingBudgetPct: budgetValueSchema(),
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => {
        assertExactKeys(args, ['sketch'])
        this.refreshEpoch()
        if (!this.state.readSelf) throw this.toolError('READ_SELF_FIRST')
        let sketch: PlanningSketch
        try {
          sketch = parseProtocolValue(planningSketchSchema, args.sketch)
        } catch (error) {
          throw this.toolError('INVALID_ARGUMENT', errorMessage(error))
        }
        if (sketch.taskId !== this.options.contract.taskId
          || sketch.runId !== this.options.runId
          || sketch.contextEpoch !== this.state.epoch
          || sketch.sourceContract !== this.options.contract.digest) {
          throw this.toolError('PLAN_FIRST', 'sketch does not match the current task/run/epoch/contract')
        }
        const bytes = textEncoder.encode(canonicalize(sketch as unknown as JsonValue))
        const planningSketchRef = await this.options.writer.putObject(
          `${this.options.runId}:planning-sketch`,
          bytes,
          'object',
        )
        this.state.planningSketchRef = planningSketchRef
        return {
          planningSketchRef,
          contextEpoch: this.state.epoch,
          remainingBudgetPct: this.options.budget(),
        }
      },
    })
  }

  private submitTool() {
    return defineTool({
      name: 'singularity_submit',
      description: 'Freeze the declared outputs and submit this Run to the independent verifier.',
      parameters: {
        outputIds: { type: 'array', items: { type: 'string' }, required: true, description: 'Declared non-draft output IDs to freeze.' },
        includeLearningDrafts: { type: 'boolean', required: true, description: 'Whether to freeze learning-drafts/skills and learning-drafts/mcp-servers.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            submitted: { type: 'boolean', const: true, required: true },
            runId: { type: 'string', required: true },
            submissionRef: refValueSchema(true),
            remainingBudgetPct: budgetValueSchema(),
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        assertExactKeys(args, ['outputIds', 'includeLearningDrafts'])
        this.refreshEpoch()
        if (this.state.submitted) throw this.toolError('ALREADY_SUBMITTED')
        if (!this.state.readSelf) throw this.toolError('READ_SELF_FIRST')
        if (this.state.planningSketchRef === undefined) throw this.toolError('PLAN_FIRST')
        this.state.submitting = true
        try {
          let frozen: FrozenSubmission
          try {
            frozen = await freezeSubmission({
              contract: this.options.contract,
              runId: this.options.runId,
              workspace: this.options.workspace,
              outputIds: args.outputIds,
              includeLearningDrafts: args.includeLearningDrafts,
              maxOutputBytes: this.options.maxOutputBytes,
              writer: this.options.writer,
            })
          } catch (error) {
            throw this.toolError('INVALID_ARGUMENT', submissionMessage(error))
          }
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- alpha2 exposes no replacement raw reader
          const seq = exec.agent?.session.snapshotEvents().length ?? 0
          await this.options.commitSubmission(frozen, this.options.sessionId, seq)
          this.state.submission = frozen
          this.state.submitted = true
          exec.concludeTurn()
          return {
            submitted: true,
            runId: this.options.runId,
            submissionRef: frozen.manifestRef,
            remainingBudgetPct: this.options.budget(),
          }
        } finally {
          this.state.submitting = false
        }
      },
    })
  }

  private stopTool() {
    return defineTool({
      name: 'singularity_stop',
      description: 'Stop this Run with a concrete blocker for the fixed settlement policy.',
      parameters: {
        reason: { type: 'string', enum: ['blocked', 'unsolved'], required: true, description: 'Stable stop category.' },
        message: { type: 'string', required: true, description: 'Concrete blocker or reason.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            stopped: { type: 'boolean', const: true, required: true },
            runId: { type: 'string', required: true },
            remainingBudgetPct: budgetValueSchema(),
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: (args, exec) => {
        assertExactKeys(args, ['reason', 'message'])
        this.refreshEpoch()
        if (this.state.submitted) throw this.toolError('ALREADY_SUBMITTED')
        if (args.message.length === 0) {
          throw this.toolError('INVALID_ARGUMENT', 'message must be non-empty')
        }
        this.state.stopped = { reason: args.reason, message: args.message }
        exec.concludeTurn()
        return Promise.resolve({
          stopped: true,
          runId: this.options.runId,
          remainingBudgetPct: this.options.budget(),
        })
      },
    })
  }

  private refreshEpoch(): void {
    const current = deriveContextEpochFromAgent(this.agent, this.options.epoch)
    if (current === this.state.epoch) return
    this.state.epoch = current
    this.state.readSelf = false
    this.state.planningSketchRef = undefined
  }

  private refusal(code: string): string {
    return JSON.stringify({
      code,
      nextAction: TOOL_ERROR_NEXT_ACTIONS[code] ?? TOOL_ERROR_NEXT_ACTIONS.INVALID_ARGUMENT,
      remainingBudgetPct: this.options.budget(),
    })
  }

  private toolError(code: string, detail?: string): Error {
    return new Error(JSON.stringify({
      code,
      ...(detail === undefined ? {} : { detail }),
      nextAction: TOOL_ERROR_NEXT_ACTIONS[code] ?? TOOL_ERROR_NEXT_ACTIONS.INVALID_ARGUMENT,
      remainingBudgetPct: this.options.budget(),
    }))
  }
}

function deriveContextEpochFromAgent(agent: Agent | undefined, fallback: () => ContextEpoch): ContextEpoch {
  return agent === undefined ? fallback() : deriveContextEpoch(agent.session)
}

function refValueSchema(required: boolean) {
  return {
    type: 'object' as const,
    additionalProperties: false as const,
    ...(required ? { required: true as const } : {}),
    properties: {
      id: { type: 'string' as const, required: true as const },
      digest: { type: 'string' as const, required: true as const },
    },
  }
}

function budgetValueSchema() {
  return {
    type: 'object' as const,
    additionalProperties: false as const,
    required: true as const,
    properties: {
      tokensPct: {
        oneOf: [
          { type: 'number' as const },
          { type: 'null' as const },
        ] as const,
        required: true as const,
      },
      stepsPct: { type: 'number' as const, required: true as const },
      wallClockPct: { type: 'number' as const, required: true as const },
      depthPct: { type: 'number' as const, required: true as const },
      taskSlotsPct: { type: 'number' as const, required: true as const },
    },
  }
}

function assertExactKeys(value: unknown, keys: readonly string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(JSON.stringify({ code: 'INVALID_ARGUMENT', nextAction: TOOL_ERROR_NEXT_ACTIONS.INVALID_ARGUMENT }))
  }
  const actual = Object.keys(value)
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) {
    throw new Error(JSON.stringify({ code: 'INVALID_ARGUMENT', nextAction: TOOL_ERROR_NEXT_ACTIONS.INVALID_ARGUMENT }))
  }
}

function submissionMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code
    if (typeof code === 'string') return `${code}: ${error instanceof Error ? error.message : 'submission rejected'}`
  }
  return errorMessage(error)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
