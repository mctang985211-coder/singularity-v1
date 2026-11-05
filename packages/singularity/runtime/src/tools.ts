import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition,ToolExecution } from '@deepseek-ai/dsh-tools'
import { defineTool,ToolArgsError } from '@deepseek-ai/dsh-tools'
import type {
DecomposeCommit,
JsonValue,
PlanningSketch,
Ref,
TaskContract,
TaskFeedback,
} from '@singularity/protocol'
import {
canonicalize,
decomposeCommitSchema,decomposePrepareSchema,
errorMessage,
parseProtocolValue,
planningSketchSchema,
taskFeedbackInputSchema,
} from '@singularity/protocol'

import type { DecomposeCommitResult } from './decompose-commit.ts'
import { readPrepareDeliveries } from './decompose-deliveries.ts'
import type { DecomposeToolContext } from './decompose.ts'
import { prepareDecompose } from './decompose.ts'
import type { ContextEpoch } from './epoch.ts'
import { deriveContextEpoch } from './epoch.ts'
import { DecomposeError } from './errors.ts'
import type { McpDispatchPlan } from './mcp-resources.ts'
import { MCP_RESOURCE_TOOL_NAMES } from './mcp-resources.ts'
import type { NodeView,RemainingBudgetPct } from './prompt.ts'
import { assertPromptBudget } from './prompt.ts'
import { createTaskFeedback,feedbackRefsFromSession } from './task-feedback.ts'
import { budgetValueSchema,decomposeInputSchema,decomposeOutputSchema,decomposeParameters,planningInputSchema,planningParameters,refValueSchema,taskToolExamples } from './task-tool-schema.ts'
import { withToolExample } from './tool-example.ts'
import type { CasObjectWriter,FrozenSubmission } from './workspace.ts'
import { freezeSubmission,SubmissionError } from './workspace.ts'

class TaskToolRefusal extends Error {}

const TOOL_ERROR_NEXT_ACTIONS: Readonly<Record<string, string>> = {
  INVALID_ARGUMENT: 'Fix the tool arguments and retry with declared fields only.',
  READ_SELF_FIRST: 'Call singularity_read(kind="self") and follow nextCursor through the complete contract, then continue.',
  PLAN_FIRST: 'Call singularity_plan with the current contextEpoch, then continue.',
  BINDING_FIXED: 'Use a bindingId from the current NodeView childOptions, then continue.',
  PREVIEW_REQUIRED: 'Call singularity_decompose with action="prepare" for a visible child binding first.',
  PREVIEW_STALE: 'Read the current self contract and prepare the child example again in this context epoch.',
  NEXT_STEP_REQUIRED: 'Continue on a later model step with the preview receipt delivered by the prepare result.',
  CHILD_BATCH_ACTIVE: 'Wait for the current child batch to finish before committing another batch.',
  REQUIRED_FEEDBACK_REPLAN: 'Read direct child results and feedback, revise the plan, then create a replacement child for each unresolved required binding.',
  INPUT_NOT_AUTHORIZED: 'Use only input objects or skills/MCP tools authorized by the current Task and NodeView.',
  IDEMPOTENCY_CONFLICT: 'Use a fresh tool call; the original command identity already has a different payload.',
  ALREADY_SUBMITTED: 'The submission is already frozen; stop calling tools.',
  RUN_CLOSED: 'This Run is already settling; stop calling tools.',
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
  readonly commitChildBatch?: (
    args: DecomposeCommit,
    callId: string,
  ) => Promise<DecomposeCommitResult>
  /** True when a committed child batch is still active for this parent Run. */
  readonly childBatchActive?: boolean
  readonly readTask?: (query: TaskReadQuery) => Promise<TaskReadResult>
  readonly submitDenial?: () => 'CHILD_BATCH_ACTIVE' | 'REQUIRED_FEEDBACK_REPLAN' | undefined
  readonly requiredFailure?: () => boolean
  readonly verifierInputs?: readonly Ref[]
  readonly replyTarget?: (id: string) => TaskFeedback | undefined
}

export interface TaskReadQuery {
  readonly kind: string
  readonly id?: string
  readonly cursor?: string
  readonly page?: number
}

export interface TaskReadResult {
  readonly data: JsonValue
  readonly objectRef?: Ref
  readonly nextCursor?: string
}

export interface RunToolSnapshot {
  readonly failure?: Error
  readonly planningSketchRef?: Ref
  readonly submission?: FrozenSubmission
  readonly stopped?: { readonly reason: 'blocked' | 'unsolved'; readonly message: string }
  readonly contextEpoch: ContextEpoch
  readonly feedbackRefs?: readonly Ref[]
  readonly feedbackWait?: Ref
}

interface MutableRunToolState {
  epoch: ContextEpoch
  readSelf: boolean
  selfReadEnd: number
  submitted: boolean
  childBatchPending: boolean
  childBatchActive: boolean
  feedbackWait?: Ref
  planningSketchRef?: Ref
  submission?: FrozenSubmission
  stopped?: { readonly reason: 'blocked' | 'unsolved'; readonly message: string }
}

/**
 * Runtime-owned Task tool surface for one Run. It registers read/plan,
 * decompose prepare/commit, submit, and stop on the DSH scoped tool registry
 * and applies one guard shared by Task and base/domain tools. It is not a second
 * registry: all registrations live in DSH's scoped tool service and unwind with
 * the Agent.
 */
export class RunToolController {
  private readonly options: RunToolControllerOptions
  private readonly childBindingIds: readonly string[]
  private readonly state: MutableRunToolState
  private agent: Agent | undefined
  private failure: Error | undefined

  constructor(options: RunToolControllerOptions) {
    this.options = options
    this.childBindingIds = options.childBindingIds ?? []
    this.state = {
      epoch: options.epoch(),
      readSelf: false,
      selfReadEnd: 0,
      submitted: false,
      childBatchPending: false,
      childBatchActive: options.childBatchActive === true,
    }
  }

  /** Register Task tools and their shared dispatch guard in the Agent scope. */
  register(agentCtx: Context, agent: Agent): void {
    this.agent = agent
    this.options.onAgent?.(agent)
    const tools: ToolDefinition[] = [this.readTool(), this.planTool(), this.feedbackTool(),
      ...(this.options.decompose === undefined ? [] : [this.decomposeTool(this.options.decompose, agent)]), this.submitTool(), this.stopTool()]
    for (const tool of tools) {
      agentCtx.tools.register(withToolExample({ ...tool, execute: async (args, exec) => {
        this.refreshEpoch()
        const code = this.denialCode(tool.name, exec.agent, args)
        if (code !== undefined) throw this.toolError(code)
        try {
          return await tool.execute(args, exec)
        } catch (error) {
          if (error instanceof TaskToolRefusal) throw error
          if (error instanceof ToolArgsError) throw error
          if (error instanceof DecomposeError) throw this.toolError(error.code, error.message)
          if (error instanceof SubmissionError) {
            throw this.toolError('INVALID_ARGUMENT', `${error.code}: ${error.message}`)
          }
          this.failure = error instanceof Error ? error : new Error('Task tool failed', { cause: error })
          agent.cancel({ kind: 'hook', reason: 'task-tool-error' })
          throw error
        }
      } }, taskToolExamples[tool.name]))
    }
    // Task bodies and base/domain dispatch share one condition source, once per call.
    agentCtx.tools.guard(execution => tools.some(tool => tool.name === execution.name)
      ? undefined : this.checkGuard(execution))
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
    return {
      readSelf: !this.state.readSelf,
      readPlanningSketch: this.state.planningSketchRef === undefined,
      requiredFailure: this.options.requiredFailure?.() === true,
      denialCodes: code === undefined ? [] : [code],
    }
  }

  private denialCode(name: string, agent: Agent | undefined, args: unknown): string | undefined {
    if (this.state.submitted) return 'ALREADY_SUBMITTED'
    if (this.state.stopped !== undefined || this.state.feedbackWait !== undefined || this.failure !== undefined) return 'RUN_CLOSED'
    if (this.agent === undefined || agent !== this.agent) return 'INVALID_ARGUMENT'
    // A committed (or in-flight) child batch makes the parent waiting-children.
    // Reads and dispatcher feedback remain available; implementation waits.
    if ((this.state.childBatchPending || this.state.childBatchActive)
      && name !== 'singularity_read' && name !== 'singularity_feedback') {
      return 'CHILD_BATCH_ACTIVE'
    }
    if (name === 'singularity_submit') {
      const denial = this.options.submitDenial?.()
      if (denial !== undefined) return denial
    }
    if (this.options.requiredFailure?.() === true
      && !['singularity_read', 'singularity_plan', 'singularity_feedback', 'singularity_decompose', 'singularity_stop'].includes(name)) {
      return 'REQUIRED_FEEDBACK_REPLAN'
    }
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
      if (action !== undefined && action !== 'prepare' && action !== 'commit') return 'INVALID_ARGUMENT'
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
    if (name === 'singularity_plan' || name === 'singularity_feedback') return undefined
    if (this.state.planningSketchRef === undefined) return 'PLAN_FIRST'
    return undefined
  }

  /** Current durable tool facts for settlement; no extra state authority. */
  snapshot(): RunToolSnapshot {
    this.refreshEpoch()
    return {
      ...(this.failure === undefined ? {} : { failure: this.failure }),
      feedbackRefs: this.agent === undefined ? [] : feedbackRefsFromSession(this.agent.session),
      ...(this.state.feedbackWait === undefined ? {} : { feedbackWait: this.state.feedbackWait }),
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
      description: 'Read Task views/resources; follow nextCursor. evidence accepts child ID or lastAttempt.runId.',
      parameters: {
        kind: { type: 'string', enum: ['self', 'status', 'resource', 'children', 'evidence', 'ancestor', 'feedback'], required: true, description: 'Authorized Task view.' },
        id: { type: 'string', description: 'Visible resource, child, evidence, lastAttempt.runId, feedback, or ancestor digest.' },
        cursor: { type: 'string', description: 'nextCursor from the same read object.' },
        page: { type: 'integer', description: 'List page size.' },
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
        const asOf = this.options.clock()
        if (args.kind !== 'self' && args.kind !== 'status') {
          const readTask = this.options.readTask
          if (readTask === undefined) throw this.toolError('INPUT_NOT_AUTHORIZED')
          const result = await readTask({
            kind: args.kind,
            ...(args.id === undefined ? {} : { id: args.id }),
            ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
            ...(args.page === undefined ? {} : { page: args.page }),
          })
          const response = { ...result, asOf, contextEpoch: this.state.epoch, remainingBudgetPct: this.options.budget() }
          assertPromptBudget(JSON.stringify(response), 16 * 1024, 'Task read page')
          return response
        }
        if (args.id !== undefined || args.page !== undefined) throw this.toolError('INVALID_ARGUMENT')
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
          inputs: contract.spec.inputs,
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
    const definition = defineTool({
      name: 'singularity_plan',
      description: 'Store or refine this Run PlanningSketch after discovery; creates no Task and changes no contract.',
      parameters: planningParameters,
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
        let sketch: PlanningSketch
        try {
          sketch = parseProtocolValue(planningSketchSchema, args.sketch)
        } catch (error) {
          throw this.toolError('INVALID_ARGUMENT', errorMessage(error, 'unknown error'))
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
    return { ...definition, parameters: planningInputSchema }
  }

  private decomposeTool(context: DecomposeToolContext, agent: Agent) {
    const definition = defineTool({
      name: 'singularity_decompose',
      description: 'Prepare a visible child example, then commit its batch on a later model step.',
      parameters: decomposeParameters,
      output: {
        schema: decomposeOutputSchema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        const action = decomposeActionOf(args)
        if (action === 'commit') {
          let commit: DecomposeCommit
          try {
            commit = parseProtocolValue(decomposeCommitSchema, args)
          } catch (error) {
            throw this.toolError('INVALID_ARGUMENT', errorMessage(error, 'unknown error'))
          }
          const commitChildBatch = this.options.commitChildBatch
          if (commitChildBatch === undefined) {
            throw this.toolError('INVALID_ARGUMENT', 'child batch commit is unavailable')
          }
          this.state.childBatchPending = true
          let result: DecomposeCommitResult
          try {
            result = await commitChildBatch(commit, String(exec.callId))
          } catch (error) {
            this.state.childBatchPending = false
            throw error
          }
          this.state.childBatchPending = false
          this.state.childBatchActive = true
          exec.concludeTurn()
          return {
            status: 'admitted' as const,
            batchId: result.batchId,
            parentRunId: result.parentRunId,
            children: result.children as unknown as JsonValue,
            remainingBudgetPct: this.options.budget(),
          }
        }
        const parsed = decomposePrepareSchema.safeParse(args)
        if (!parsed.success) throw this.toolError('INVALID_ARGUMENT', parsed.error.message)
        // The shared dispatch guard admits prepare only after a plan exists.
        const planningSketchRef = this.state.planningSketchRef as Ref
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
        }, parsed.data.bindingId)
        return {
          ...prepared.response,
          example: prepared.response.example as unknown as JsonValue,
          interface: prepared.response.interface as unknown as JsonValue,
          resolved: prepared.response.resolved as unknown as JsonValue,
        }
      },
    })
    return { ...definition, parameters: decomposeInputSchema }
  }

  private feedbackTool() {
    return defineTool({
      name: 'singularity_feedback',
      description: 'Ask dispatcher and yield, or replyTo=child feedback.id. Frozen contract changes need stop(blocked).',
      parameters: {
        kind: { type: 'string', enum: ['needs-replan', 'input-invalid', 'acceptance-concern', 'blocked'], required: true },
        summary: { type: 'string', required: true },
        replyTo: { type: 'string', description: 'Omit to ask your direct parent; set to a direct child feedback.id to reply.' },
        refs: { type: 'array', items: { type: 'json' }, required: true, description: 'Frozen public refs from this Run, or [].' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            feedbackRef: refValueSchema(true),
            directParentTaskId: { type: 'string', required: true },
            remainingBudgetPct: budgetValueSchema(),
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        let input
        try { input = parseProtocolValue(taskFeedbackInputSchema, args) }
        catch (error) { throw this.toolError('INVALID_ARGUMENT', errorMessage(error, 'unknown error')) }
        const feedbackRef = await createTaskFeedback({
          contract: this.options.contract,
          runId: this.options.runId,
          callId: String(exec.callId),
          input,
          createdAt: this.options.clock(),
          writer: this.options.writer,
          authorizedRefs: this.options.verifierInputs ?? [],
          ...(input.replyTo === undefined ? {} : { reply: this.options.replyTarget?.(input.replyTo) }),
        })
        const origin = this.options.contract.origin
        if (input.replyTo === undefined) { this.state.feedbackWait = feedbackRef; exec.concludeTurn() }
        return { feedbackRef, directParentTaskId: origin.kind === 'child' && input.replyTo === undefined ? origin.parentId : this.options.contract.taskId, remainingBudgetPct: this.options.budget() }
      },
    })
  }

  private submitTool() {
    // DSH defaults to exclusive execution; this call is the output-freeze barrier.
    return defineTool({
      name: 'singularity_submit',
      description: 'Freeze declared outputs and submit this Run for independent verification.',
      parameters: {
        outputIds: { type: 'array', items: { type: 'string' }, required: true, description: 'Declared non-draft output IDs to freeze.' },
        includeLearningDrafts: { type: 'boolean', required: true, description: 'Also freeze learning-drafts/skills and learning-drafts/mcp-servers.' },
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
        const frozen = await freezeSubmission({
          contract: this.options.contract,
          runId: this.options.runId,
          workspace: this.options.workspace,
          outputIds: args.outputIds,
          includeLearningDrafts: args.includeLearningDrafts,
          maxOutputBytes: this.options.maxOutputBytes,
          writer: this.options.writer,
          ...(this.options.verifierInputs === undefined ? {} : { inputRefs: this.options.verifierInputs }),
        })
        const seq = exec.agent?.session.seq ?? 0
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
      },
    })
  }

  private stopTool() {
    return defineTool({
      name: 'singularity_stop',
      description: 'End this Run with its blocker for settlement.',
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
    return new TaskToolRefusal(JSON.stringify({
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
