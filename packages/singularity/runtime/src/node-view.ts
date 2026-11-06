import type { GlobalResourceSnapshot, Ref, TaskContract, TaskTemplate } from '@singularity/protocol'

import type { ChildNodeView } from './children.ts'

import type { FrozenMcpServer } from './mcp-resources.ts'
import { mcpDispatchPlan } from './mcp-resources.ts'
import type { NodeView, RemainingBudgetPct } from './prompt.ts'
import { renderNodeView } from './prompt.ts'
import type { FrozenSkillResource } from './skill-resources.ts'
import type { RunToolController } from './tools.ts'

/** Frozen identities used to render the live NodeView. */
export interface NodeViewCatalogInput {
  readonly contract: TaskContract
  readonly runId: string
  readonly workspace: string
  readonly baseToolNames: readonly string[]
  readonly template: TaskTemplate
  readonly skills: readonly FrozenSkillResource[]
  readonly mcpServers: readonly FrozenMcpServer[]
  readonly mcpResources?: boolean
  readonly budget: RemainingBudgetPct
  readonly lastAttempt: NodeView['lastAttempt']
  readonly asOf: number
  readonly contextEpoch: string
  readonly children?: ChildNodeView
  readonly feedback?: NodeView['feedback']
  readonly exploration?: GlobalResourceSnapshot
}

interface ProjectionInput extends NodeViewCatalogInput {
  readonly phase: NodeView['task']['phase']
  readonly planningSketchRef: Ref | null
  readonly obligations: NodeView['obligations']
}

/** Project the live NodeView from frozen identities and current tool state. */
function projectNodeView(input: ProjectionInput): NodeView {
  const toolNames = [...input.baseToolNames]
  if (input.skills.length > 0 && !toolNames.includes('skill')) toolNames.push('skill')
  const mcpPlan = mcpDispatchPlan(input.mcpServers, input.mcpResources !== false)
  for (const name of [...mcpPlan.publicToolNames, ...mcpPlan.resourceToolNames]) {
    if (!toolNames.includes(name)) toolNames.push(name)
  }
  return {
    v: 1,
    asOf: input.asOf,
    contextEpoch: input.contextEpoch,
    task: {
      id: input.contract.taskId,
      ...(input.contract.origin.kind === 'child' ? { parentId: input.contract.origin.parentId } : {}),
      runId: input.runId,
      goalSummary: input.contract.spec.goal.summary,
      contractDigest: input.contract.digest,
      phase: input.phase,
      mode: input.exploration === undefined ? 'guided' : 'exploration',
    },
    method: input.contract.method,
    ownTemplate: { id: input.template.id, brief: input.template.brief },
    documents: input.exploration?.documents.map(document => ({ id: document.id, description: document.description })) ?? [],
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
    ...input.children,
    obligations: input.obligations,
    planningSketchRef: input.planningSketchRef,
    feedback: input.feedback ?? { count: 0 },
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
    phase: input.children?.childBatch !== undefined && input.children.childBatch !== null
      ? 'waiting-children' : (input.children?.childHistory.total ?? 0) > 0 || tools.submission !== undefined ? 'integrating' : 'working',
    planningSketchRef: tools.planningSketchRef ?? null,
    obligations: input.controller.obligations(),
  })
}

/** Renders the live NodeView with the existing dynamic 8 KiB guard. */
export function renderLiveNodeView(input: LiveNodeViewInput): string {
  return renderNodeView(buildLiveNodeView(input))
}
