import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
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
import type { DecomposeToolContext } from './decompose.ts'
import { prepareDecompose, readPrepareDeliveries } from './decompose.ts'
import { DecomposeError } from './errors.ts'
import { MCP_RESOURCE_TOOL_NAMES } from './mcp-resources.ts'
import type { McpDispatchPlan } from './mcp-resources.ts'
import type { NodeView, RemainingBudgetPct } from './prompt.ts'
import { assertPromptBudget } from './prompt.ts'
import { freezeSubmission } from './workspace.ts'
import type { FrozenSubmission, CasObjectWriter } from './workspace.ts'

const TOOL_ERROR_NEXT_ACTIONS: Readonly<Record<string, string>> = {
  INVALID_ARGUMENT: 'Fix the tool arguments and retry with declared fields only.',
  READ_SELF_FIRST: 'Call singularity_read(kind="self") and follow nextCursor through the complete contract, then continue.',
  PLAN_FIRST: 'Call singularity_plan with the current contextEpoch, then continue.',
  BINDING_FIXED: 'Use a bindingId from the current NodeView childOptions, then continue.',
  PREVIEW_REQUIRED: 'Call singularity_decompose with action="prepare" for a visible child binding first.',
  PREVIEW_STALE: 'Read the current self contract and prepare the child example again in this context epoch.',
  NEXT_STEP_REQUIRED: 'Continue on a later model step with the preview receipt delivered by the prepare result.',
  INPUT_NOT_AUTHORIZED: 'Use only skills and MCP servers/tools listed in the session catalog and NodeView.',
  ALREADY_SUBMITTED: 'The submission is already frozen; stop calling tools.',
  RUN_CLOSED: 'This Run is already settling; stop calling tools.',
  ACTIVE_JOB: 'Wait for active jobs to finish or stop them with the listed job tools, then retry submission.',
  LIMIT_EXCEEDED: 'Reduce the requested scope or stop with a concrete blocker.',
}

const textEncoder = new TextEncoder()
// UTF-16 text chunks; the encoded response envelope is capped separately.
const SELF_PAGE_CHARS = 4096

export interface RunToolControllerOptions {
  readonly contract: TaskContract
  readonly runId: string
  readonly sessionId: string
  readonly workspace: string
  readonly skillNames: readonly string[]
  /** Frozen MCP server/tool/resource identities admitted for this Run. */
  readonly mcpPlan: McpDispatchPlan
  /** Current parent template binding ids, used by plan/decompose guards. */
  readonly childBindingIds?: readonly string[]
  /** Present when decompose prepare is available for this Run. */
  readonly decompose?: DecomposeToolContext
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
  readonly planningSketchRef?: Ref
  readonly submission?: FrozenSubmission
  readonly stopped?: { readonly reason: 'blocked' | 'unsolved'; readonly message: string }
  readonly contextEpoch: ContextEpoch
}

interface MutableRunToolState {
  epoch: ContextEpoch
  readSelf: boolean
  selfReadEnd: number
  submitting: boolean
  submitted: boolean
  planningSketchRef?: Ref
  submission?: FrozenSubmission
  stopped?: { readonly reason: 'blocked' | 'unsolved'; readonly message: string }
}

/**
 * Runtime-owned Task tool surface for one Run. It registers read/plan,
 * prepare-only decompose, submit, and stop on the DSH scoped tool registry and
 * applies one guard shared by Task and base/domain tools. It is not a second
 * registry: all registrations live in DSH's scoped tool service and unwind with
 * the Agent.
 */
export class RunToolController {
  private readonly options: RunToolControllerOptions
  private readonly childBindingIds: readonly string[]
  private readonly state: MutableRunToolState
  private agent: Agent | undefined
  private jobs: JobRegistry | undefined

  constructor(options: RunToolControllerOptions) {
    this.options = options
    this.childBindingIds = options.childBindingIds ?? []
    this.state = {
      epoch: options.epoch(),
      readSelf: false,
      selfReadEnd: 0,
      submitting: false,
      submitted: false,
    }
  }

  /** Register the four Task tools and the shared guard in the Agent scope. */
  register(agentCtx: Context, agent: Agent): void {
    this.agent = agent
    this.jobs = agentCtx.get('jobs', false)
    this.options.onAgent?.(agent)
    agentCtx.tools.register(this.readTool())
    agentCtx.tools.register(this.planTool())
    if (this.options.decompose !== undefined) {
      agentCtx.tools.register(this.decomposeTool())
    }
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
    const code = this.denialCode(execution.name, execution.agent, execution.arguments)
    return code === undefined ? undefined : this.refusal(code)
  }

  /** NodeView projects the same submission gate used by actual dispatch. */
  obligations(): NodeView['obligations'] {
    this.refreshEpoch()
    const code = this.denialCode('singularity_submit', this.agent, undefined)
    const decomposeCode = this.options.decompose === undefined
      ? 'BINDING_FIXED'
      : this.denialCode('singularity_decompose', this.agent, { action: 'prepare' })
    return {
      readSelf: !this.state.readSelf,
      readPlanningSketch: this.state.planningSketchRef === undefined,
      requiredFailure: false,
      canDecompose: decomposeCode === undefined,
      canSubmit: code === undefined,
      denialCodes: code === undefined ? [] : [code],
    }
  }

  private denialCode(name: string, agent: Agent | undefined, args: unknown): string | undefined {
    if (this.state.submitted) return 'ALREADY_SUBMITTED'
    if (this.state.stopped !== undefined) return 'RUN_CLOSED'
    if (this.state.submitting) return 'ACTIVE_JOB'
    if (this.agent === undefined || agent !== this.agent) return 'INVALID_ARGUMENT'
    if (name === 'skill') {
      const skillName = skillNameOf(args)
      if (skillName === undefined || !this.options.skillNames.includes(skillName)) {
        return 'INPUT_NOT_AUTHORIZED'
      }
      if (!this.options.checkBudget()) return 'LIMIT_EXCEEDED'
      return undefined
    }
    if (name === 'singularity_read' || name === 'singularity_stop') return undefined
    if (name === 'singularity_decompose') {
      if (this.options.decompose === undefined || this.childBindingIds.length === 0) {
        return 'BINDING_FIXED'
      }
      const action = decomposeActionOf(args)
      if (action !== undefined && action !== 'prepare') return 'INVALID_ARGUMENT'
      if (!this.options.checkBudget()) return 'LIMIT_EXCEEDED'
      if (!this.state.readSelf) return 'READ_SELF_FIRST'
      if (this.state.planningSketchRef === undefined) return 'PLAN_FIRST'
      return undefined
    }
    if (isMcpResourceTool(name)) {
      if (!this.options.mcpPlan.resourceToolNames.includes(name)) return 'INPUT_NOT_AUTHORIZED'
      if (!this.options.checkBudget()) return 'LIMIT_EXCEEDED'
      const serverName = serverNameOf(args)
      return serverName !== undefined && this.options.mcpPlan.serverNames.includes(serverName)
        ? undefined
        : 'INPUT_NOT_AUTHORIZED'
    }
    if (name.startsWith('mcp__') && !this.options.mcpPlan.publicToolNames.includes(name)) {
      return 'INPUT_NOT_AUTHORIZED'
    }
    if (!this.options.checkBudget()) return 'LIMIT_EXCEEDED'
    if (!this.state.readSelf) return 'READ_SELF_FIRST'
    if (name === 'singularity_plan') return undefined
    if (this.state.planningSketchRef === undefined) return 'PLAN_FIRST'
    if (name === 'singularity_submit' && this.jobs?.list(this.agent.session.id)
      .some(job => job.owner === this.agent?.session.id
        && (job.status === 'running' || job.status === 'stopping'))) return 'ACTIVE_JOB'
    return undefined
  }

  /** Current durable tool facts for settlement; no extra state authority. */
  snapshot(): RunToolSnapshot {
    this.refreshEpoch()
    return {
      ...(this.state.planningSketchRef === undefined
        ? {}
        : { planningSketchRef: this.state.planningSketchRef }),
      ...(this.state.submission === undefined ? {} : { submission: this.state.submission }),
      ...(this.state.stopped === undefined ? {} : { stopped: this.state.stopped }),
      contextEpoch: this.state.epoch,
    }
  }

  private readTool() {
    return defineTool({
      name: 'singularity_read',
      description: 'Read the Task contract or status. For paged self data, follow nextCursor and concatenate the JSON text pages before planning.',
      parameters: {
        kind: { type: 'string', enum: ['self', 'status'], required: true, description: 'Read the complete self contract or compact status.' },
        cursor: { type: 'string', description: 'The nextCursor from an earlier self page in this context epoch.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            data: { type: 'json', required: true },
            objectRef: refValueSchema(false),
            nextCursor: { type: 'string' },
            asOf: { type: 'integer', required: true },
            contextEpoch: { type: 'string', required: true },
            remainingBudgetPct: budgetValueSchema(),
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        assertExactKeys(args, args.cursor === undefined ? ['kind'] : ['kind', 'cursor'])
        this.refreshEpoch()
        const asOf = this.options.clock()
        if (args.kind === 'status') {
          if (args.cursor !== undefined) throw this.toolError('INVALID_ARGUMENT')
          const context = this.options.decompose
          const agent = this.agent
          let previews: {
            readonly bindingId: string
            readonly previewRef: Ref
            readonly deliveryReceiptRef: Ref
            readonly state: 'current' | 'next-step-required' | 'stale'
          }[] = []
          if (context !== undefined && agent !== undefined) {
            try {
              const deliveries = await readPrepareDeliveries({
                contract: this.options.contract,
                runId: this.options.runId,
                resources: context.methodResources,
                reader: context.reader,
                session: agent.session,
                currentCallId: String(exec.callId),
              })
              const byBinding = new Map<string, (typeof deliveries)[number]>()
              for (const delivery of deliveries) {
                const previous = byBinding.get(delivery.bindingId)
                if (previous === undefined || delivery.resultSeq > previous.resultSeq) {
                  byBinding.set(delivery.bindingId, delivery)
                }
              }
              previews = [...byBinding.values()].map(delivery => ({
                bindingId: delivery.bindingId,
                previewRef: delivery.previewRef,
                deliveryReceiptRef: delivery.deliveryReceiptRef,
                state: delivery.state,
              }))
            } catch (error) {
              if (error instanceof DecomposeError) throw this.toolError(error.code, error.message)
              throw this.toolError('INVALID_ARGUMENT', errorMessage(error))
            }
          }
          return {
            data: {
              taskId: this.options.contract.taskId,
              runId: this.options.runId,
              phase: this.state.submitted ? 'integrating' : 'working',
              readSelf: this.state.readSelf,
              hasPlanningSketch: this.state.planningSketchRef !== undefined,
              submitted: this.state.submitted,
              stopped: this.state.stopped !== undefined,
              previews,
            },
            asOf,
            contextEpoch: this.state.epoch,
            remainingBudgetPct: this.options.budget(),
          }
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
          contextEpoch: this.state.epoch,
        }
        const text = JSON.stringify(data)
        const prefix = `${contract.digest}:${this.state.epoch}:`
        const offset = args.cursor === undefined ? 0 : Number(args.cursor.slice(prefix.length))
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.state.selfReadEnd
          || offset % SELF_PAGE_CHARS !== 0
          || (args.cursor !== undefined && args.cursor !== `${prefix}${String(offset)}`)) {
          throw this.toolError('INVALID_ARGUMENT')
        }
        const end = Math.min(text.length, offset + SELF_PAGE_CHARS)
        const response = {
          data: text.length > SELF_PAGE_CHARS ? text.slice(offset, end) : data,
          objectRef: { id: contract.taskId, digest: contract.digest },
          ...(end < text.length ? { nextCursor: `${prefix}${String(end)}` } : {}),
          asOf,
          contextEpoch: this.state.epoch,
          remainingBudgetPct: this.options.budget(),
        }
        assertPromptBudget(JSON.stringify(response), 16 * 1024, 'self read page')
        this.state.selfReadEnd = Math.max(this.state.selfReadEnd, end)
        this.state.readSelf ||= end === text.length
        return Promise.resolve(response)
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
        const visibleBindings = new Set(this.childBindingIds)
        for (const entry of sketch.directPlan) {
          if (!visibleBindings.has(entry.bindingId)) {
            throw this.toolError(
              'BINDING_FIXED',
              `directPlan binding ${JSON.stringify(entry.bindingId)} is not visible`,
            )
          }
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

  private decomposeTool() {
    return defineTool({
      name: 'singularity_decompose',
      description: 'Prepare one visible child binding: read its complete example and keep the preview receipt for a later step. Commit is not available in this slice.',
      parameters: {
        action: { type: 'string', required: true, description: 'Only "prepare" is available in this slice.' },
        bindingId: { type: 'string', description: 'A bindingId from the current NodeView childOptions.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', const: 'preview', required: true },
            previewRef: refValueSchema(true),
            deliveryReceiptRef: refValueSchema(true),
            bindingId: { type: 'string', required: true },
            parentTaskId: { type: 'string', required: true },
            parentRunId: { type: 'string', required: true },
            templateId: { type: 'string', required: true },
            templateRef: refValueSchema(true),
            methodRef: refValueSchema(true),
            join: { type: 'string', enum: ['required', 'probe'], required: true },
            brief: { type: 'string', required: true },
            example: { type: 'json', required: true },
            interface: { type: 'json', required: true },
            resolved: { type: 'json', required: true },
            reminder: { type: 'string', required: true },
            planningSketchRef: refValueSchema(true),
            contextEpoch: { type: 'string', required: true },
            asOf: { type: 'integer', required: true },
            remainingBudgetPct: budgetValueSchema(),
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        assertExactKeys(args, args.bindingId === undefined ? ['action'] : ['action', 'bindingId'])
        this.refreshEpoch()
        if (this.state.submitted) throw this.toolError('ALREADY_SUBMITTED')
        if (this.state.stopped !== undefined) throw this.toolError('RUN_CLOSED')
        if (args.action === 'commit') {
          throw this.toolError('INVALID_ARGUMENT', 'commit is not available in this slice')
        }
        if (args.action !== 'prepare') {
          throw this.toolError('INVALID_ARGUMENT', 'only action="prepare" is available')
        }
        if (typeof args.bindingId !== 'string' || args.bindingId.length === 0) {
          throw this.toolError('INVALID_ARGUMENT', 'bindingId is required for prepare')
        }
        const context = this.options.decompose
        if (context === undefined || this.childBindingIds.length === 0) {
          throw this.toolError('BINDING_FIXED')
        }
        if (!this.state.readSelf) throw this.toolError('READ_SELF_FIRST')
        const planningSketchRef = this.state.planningSketchRef
        if (planningSketchRef === undefined) throw this.toolError('PLAN_FIRST')
        const agent = this.agent
        if (agent === undefined) throw this.toolError('INVALID_ARGUMENT')
        try {
          const prepared = await prepareDecompose({
            contract: this.options.contract,
            runId: this.options.runId,
            sessionId: this.options.sessionId,
            resources: context.methodResources,
            reader: context.reader,
            writer: this.options.writer,
            session: agent.session,
            callId: String(exec.callId),
            epoch: this.state.epoch,
            planningSketchRef,
            remainingBudgetPct: this.options.budget(),
            asOf: this.options.clock(),
          }, args.bindingId)
          return {
            ...prepared.response,
            example: prepared.response.example as unknown as JsonValue,
            interface: prepared.response.interface as unknown as JsonValue,
            resolved: prepared.response.resolved as unknown as JsonValue,
          }
        } catch (error) {
          if (error instanceof DecomposeError) {
            throw this.toolError(error.code, error.message)
          }
          throw this.toolError('INVALID_ARGUMENT', errorMessage(error))
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
    this.state.selfReadEnd = 0
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

function decomposeActionOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const action = (value as { readonly action?: unknown }).action
  return typeof action === 'string' ? action : undefined
}

function skillNameOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const name = (value as { readonly name?: unknown }).name
  return typeof name === 'string' ? name : undefined
}

function serverNameOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const server = (value as { readonly server?: unknown }).server
  return typeof server === 'string' ? server : undefined
}

function isMcpResourceTool(name: string): boolean {
  return (MCP_RESOURCE_TOOL_NAMES as readonly string[]).includes(name)
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
