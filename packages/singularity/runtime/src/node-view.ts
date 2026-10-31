import type { Ref, TaskContract, TaskTemplate } from '@singularity/protocol'

import { MethodResourceError } from './errors.ts'
import type { FrozenMcpServer } from './mcp-resources.ts'
import { mcpDispatchPlan } from './mcp-resources.ts'
import type { NodeView, RemainingBudgetPct } from './prompt.ts'
import { renderNodeView } from './prompt.ts'
import type { FrozenSkillResource } from './skill-resources.ts'
import type { RunToolController } from './tools.ts'

/** Longest fixed protocol denial code; used only as a static upper bound. */
const PREFLIGHT_DENIAL_CODE = 'REQUIRED_FEEDBACK_REPLAN'
const PREFLIGHT_DIGEST = `sha256:${'0'.repeat(64)}`

/** Static identities shared by the live NodeView and its admission preflight. */
export interface NodeViewCatalogInput {
  readonly contract: TaskContract
  readonly runId: string
  readonly workspace: string
  readonly baseToolNames: readonly string[]
  readonly template: TaskTemplate
  readonly skills: readonly FrozenSkillResource[]
  readonly mcpServers: readonly FrozenMcpServer[]
  readonly budget: RemainingBudgetPct
  readonly lastAttempt: NodeView['lastAttempt']
  readonly asOf: number
  readonly contextEpoch: string
}

interface ProjectionInput extends NodeViewCatalogInput {
  readonly phase: NodeView['task']['phase']
  readonly planningSketchRef: Ref | null
  readonly obligations: NodeView['obligations']
}

/** Single dynamic projection used by both live rendering and static preflight. */
function projectNodeView(input: ProjectionInput): NodeView {
  const toolNames = [...input.baseToolNames]
  if (input.skills.length > 0 && !toolNames.includes('skill')) toolNames.push('skill')
  const mcpPlan = mcpDispatchPlan(input.mcpServers)
  for (const name of [...mcpPlan.publicToolNames, ...mcpPlan.resourceToolNames]) {
    if (!toolNames.includes(name)) toolNames.push(name)
  }
  return {
    v: 1,
    asOf: input.asOf,
    contextEpoch: input.contextEpoch,
    task: {
      id: input.contract.taskId,
      runId: input.runId,
      goalSummary: input.contract.spec.goal.summary,
      contractDigest: input.contract.digest,
      phase: input.phase,
      mode: 'guided',
    },
    method: input.contract.method,
    ownTemplate: { id: input.template.id, brief: input.template.brief },
    documents: [],
    skills: input.skills.map(skill => ({ id: skill.id, name: skill.name })),
    tools: toolNames.map(name => ({ name })),
    childOptions: input.template.children.map(binding => ({
      bindingId: binding.bindingId,
      templateId: binding.templateId,
      brief: binding.brief,
      join: binding.join,
    })),
    requiredObligations: [],
    childBatch: null,
    childHistory: { total: 0, outcomes: {} },
    recentChildResults: [],
    obligations: input.obligations,
    planningSketchRef: input.planningSketchRef,
    feedback: { count: 0 },
    lastAttempt: input.lastAttempt,
    budget: input.budget,
    workspace: { cwd: input.workspace, outputs: input.contract.spec.outputs },
  }
}

export interface LiveNodeViewInput extends NodeViewCatalogInput {
  readonly controller: RunToolController
}

/** Actual live NodeView; dynamic state comes from the shared tool controller. */
function buildLiveNodeView(input: LiveNodeViewInput): NodeView {
  const tools = input.controller.snapshot()
  return projectNodeView({
    ...input,
    contextEpoch: tools.contextEpoch,
    phase: tools.submission === undefined ? 'working' : 'integrating',
    planningSketchRef: tools.planningSketchRef ?? null,
    obligations: input.controller.obligations(),
  })
}

/** Renders the live NodeView with the existing dynamic 8 KiB guard. */
export function renderLiveNodeView(input: LiveNodeViewInput): string {
  return renderNodeView(buildLiveNodeView(input))
}

/**
 * Admission preflight: renders the complete static catalog (own template,
 * skills, MCP tools, child options, workspace outputs) before any fact or
 * Agent exists. Dynamic state is represented by the initial obligation set.
 */
export function preflightNodeView(input: NodeViewCatalogInput): void {
  try {
    renderNodeView(projectNodeView({
      ...input,
      // Conservative post-plan/post-integration upper bound: a real delivered
      // sketch ref, the longer phase string, all-boolean false shape, the
      // longest fixed denial code, null token percentage, and a resolved path.
      phase: 'integrating',
      planningSketchRef: {
        id: `${input.runId}:planning-sketch`,
        digest: PREFLIGHT_DIGEST,
      },
      obligations: {
        readSelf: false,
        readPlanningSketch: false,
        requiredFailure: false,
        canDecompose: false,
        canSubmit: false,
        denialCodes: [PREFLIGHT_DENIAL_CODE],
      },
      budget: {
        tokensPct: null,
        stepsPct: 100,
        wallClockPct: 100,
        depthPct: 100,
        taskSlotsPct: 100,
      },
    }))
  } catch (error) {
    throw new MethodResourceError(
      'method',
      'CONTRACT_INVALID',
      `static NodeView exceeds its admission budget: ${errorMessage(error)}`,
      { cause: error },
    )
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
