import type { Ref,RoundPlan,TaskLimits,TaskSpec } from '@singularity/protocol'

const maxWallClockMs = 12 * 60 * 60 * 1000
const maxReportedTokens = 1_600_000_000

/** All agents share the campaign cap; child budgets do not multiply it. */
export const BUCKYBALL_FRONTEND_CAMPAIGN = {
  maxWallClockMs,
  maxReportedTokens,
  maxRequests: 16000,
  maxActive: 4,
  maxOutputBytes: 256 * 1024 * 1024,
  task: { maxRuns: 3, maxStepsPerRun: 4096, maxTokens: maxReportedTokens,
    maxDepth: 8, maxTasks: 256, maxBatchChildren: 8 } satisfies Omit<TaskLimits, 'deadlineAt'>,
  proposerBudget: { maxSteps: 4096, maxTokens: maxReportedTokens,
    maxWallClockMs } satisfies RoundPlan['proposerBudget'],
  evaluationBudget: { maxRuns: 6 * 256 * 3, maxTokens: maxReportedTokens,
    maxWallClockMs, maxActiveRuns: 4 } satisfies RoundPlan['budget'],
} as const

/** Operator owns acceptance; the empty Method does not prescribe a chip or workflow. */
export function buckyballFrontendTaskSpec(project: Ref): TaskSpec {
  return {
    goal: {
      summary: 'Design and implement a Buckyball chip frontend for Fun-CosyVoice3-0.5B-2512. Read project.json for pinned source, checkpoint, public resources and execution limits. Discover the model and repository, choose and justify the design, implement its model recipe and hardware integration, and deliver independently reproducible frontend evidence.',
      deliverable: 'frontend/ with implementation patches, design contracts, software reference vectors and focused verification evidence.',
      scope: ['All inference stages: text/prompt processing, language model, Flow/DiT, HiFT and output handling.',
        'Chip frontend: architecture, dataflow, numerical contracts, compiler/emulator mapping, RTL, logic synthesis and component verification.'],
      constraints: ['Preserve the original checkpoint and independent software reference; record accelerator and host execution explicitly.',
        'Use the isolated Buckyball checkout and existing bbdev, native tools and public skills.',
        'Exclude all full-chip simulation, including whole-model BEMU and chip-level RTL runs; exclude P2E, FPGA bitstreams and physical backend work.',
        'Run focused component tests within the operator resource limits. RTL elaboration is allowed.',
        'Discover each Task\'s local workflow from the repository; refine the initial plan after exploration, delegate long-chain stages to direct children in successive batches, and perform bounded local technical work plus integration and checks.',
        'Report incomplete or unsupported stages and failed experiments with their evidence.'],
    },
    criteria: [
      { id: 'model-reference', required: true, statement: 'Pinned original model and inputs are identified; all inference stages and their interfaces are accounted for; original software reference vectors and numerical comparison rules are reproducible.' },
      { id: 'design-contract', required: true, statement: 'The implemented chip frontend has explicit topology, resource, memory, layout, precision, streaming/cache and host/accelerator contracts with a workload-based rationale.' },
      { id: 'implementation', required: true, statement: 'Submitted patches apply to the pinned checkout, connect model recipes and RTL through current repository interfaces, and reproduce RTL elaboration and logic synthesis without unresolved implementation stubs. Declare clock/reset constraints and report actual static checks without inventing a frequency target.' },
      { id: 'component-verification', required: true, statement: 'Independent checks exercise the changed operators, numerical boundaries and hardware interfaces using small component/IP/subgraph cases; retain actual inputs, outputs, commands and terminal results. Every model stage has implementation and component evidence or fails this criterion.' },
      { id: 'ppa-evidence', required: true, statement: 'Reproduce logical-synthesis estimates of total power (mW), achieved critical-path delay (ns) and mapped cell area (um2) for the implemented accelerator boundary actually used by the workload, accounting for active core/Ball instances and memory models. Standalone component or unused-IP reports alone do not establish frontend PPA. Record library/corner/clock/activity and host-offload boundaries. Compare only identical conditions; use PPA weights 0.30/0.40/0.30. Static power is an estimate, not measured chip power.' },
      { id: 'delivery', required: true, statement: 'A reviewer can reproduce the frontend checks from frozen artifacts and source identities. Report actual coverage and remaining integration gaps without claiming full-chip execution or measured chip performance.' },
    ],
    inputs: [{ id: 'project', object: project, path: 'project.json', access: 'copy-to-work' }],
    outputs: [{ id: 'frontend', path: 'frontend', kind: 'tree', role: 'deliverable', required: true }],
  }
}
