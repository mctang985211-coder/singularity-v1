import type { Ref,TaskSpec } from '@singularity/protocol'

export function buckyballBallTaskSpec(project: Ref): TaskSpec {
  return {
    goal: {
      summary: 'Implement reusable capacity-aware MXFP8 matrix multiplication on the existing Buckyball MXMM Ball. Read project.json. Starting from the pinned repository, deliver a callable implementation that tiles matrices exceeding physical bank capacity and executes them through the real repository ISA and BEMU consumer.',
      deliverable: 'ball/ with applicable source patches, callable consumer, independent numerical checks and reproduction commands.',
      scope: ['One MXMM Ball, its host packing/tiling/ISA interface and focused component verification.',
        'C = A * B^T: row-major E4M3 codes and per-row E8M0 scales per 32 K elements; FP32 output. Support M=1 or multiples of 16 up to 64, N positive multiples of 16 up to 80, K positive multiples of 32 up to 4096.'],
      constraints: ['Use the pinned poly configuration and its actual bank capacities. Preserve existing ISA and numerical semantics; packed panels or legal K-windows are implementation choices.',
        'Expose dimensions and input data at a callable interface; do not hardcode case outputs. Include multiple back-to-back products without stale accumulator state.',
        'Compile and run actual RISC-V ELF on focused BEMU with the MXMM core selected. A JSON schedule, Python-only emulator or existing unrelated test pass is insufficient.',
        'Use independent prepared checkouts and existing bbdev/native tools. Keep baseline, Singularity and verifier unchanged.',
        'Exclude chip/core redesign, full-chip simulation, model porting, synthesis/PPA, FPGA and physical backend. Change RTL/compiler only if a demonstrated Ball-interface defect requires it.',
      ],
    },
    criteria: [
      { id: 'executable-mapping', required: true, statement: 'Patches apply to the pinned checkout. A callable tiling/packing implementation emits and executes real MXMM instructions for supplied matrices, with legal three-bank fields, byte capacities including scales/output base, DMA, K partitions and first/last accumulation. Identify the actual consumer and command; metadata or a mathematical reference alone fails.' },
      { id: 'target-correctness', required: true, statement: 'Independently build fresh RISC-V ELF and run focused MXMM BEMU for every supplied case and additional reviewer-selected boundary inputs. Compare actual target outputs with an independent decoded-input reference, including signed/zero codes and varying finite scales. Require exact results on exactly representable subsets; justify and measure FP32 error bounds otherwise. Exercise multi-K accumulation, M/N output tiling, repeated calls and output guards. Missing execution or any unmet clause fails.' },
      { id: 'regression', required: true, statement: 'Reproduce relevant existing MXMM capacity/window/chain regressions and test the changed consumer itself. If RTL or compiler changes, reproduce focused tests at that changed boundary; BEMU alone does not prove RTL correctness. Record actual terminal results and distinguish existing from newly exercised coverage.' },
      { id: 'delivery', required: true, statement: 'Frozen ball/ artifacts contain complete patches (including affected submodules), source/config identities, callable input/output layout, numerical rules, commands and actual inputs/outputs. A fresh reviewer can reproduce without worker workspaces/build outputs. Identify remaining gaps; all required outcomes must be satisfied.' },
    ],
    inputs: [{ id: 'project', object: project, path: 'project.json', access: 'copy-to-work' }],
    outputs: [{ id: 'ball', path: 'ball', kind: 'tree', role: 'deliverable', required: true }],
  }
}
