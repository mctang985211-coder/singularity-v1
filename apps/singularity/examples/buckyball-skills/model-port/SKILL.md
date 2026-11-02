---
name: model-port
description: Prepare original model references, chip recipes and frontend integration. During recipe design load model-optimize; load ball-align when a contract spans compiler and RTL.
---

# Model Port for the Frontend Experiment

Use this skill as technical guidance within the frozen Task goal and executable
checks. Own the current Task's completion path, local work and integration. Select
bounded next-layer units and dependent batches when they produce useful interfaces.
Load related references with native `skill(name="model-optimize")`,
`skill(name="debug-compiler")`, `skill(name="workload-tests")`, or
`skill(name="ball-align")` as the current work requires.

## Establish the port

Identify target chips/configurations, checkpoint, input shape/preprocessing,
reference outputs, numerical rules and any explicit performance target. Preserve
the original model before chip-specific rewrites. Compare designs with the same
prepared checkpoint and inputs. Read current implementations and recipes.

- Shared preparation, packaging and evaluation: `stack/models/models/<model>/`.
- Chip recipes: `stack/models/archs/buckyball/<chip>/<model>/`; `examples/models/` links here.
- Topology/configuration: `examples/chips/<chip>/configs/`.
- Operator implementations: `examples/balls/` and `examples/cores/`.

## Design and integration

Choose the numerical and execution contract from actual workload evidence. Retain
layout, bank and scheduling decisions in the recipe and design records. Verify
model rewrites independently from the actual compiled/mapped accelerator arm.
A build alone does not establish execution or numerical parity. Preserve compiler
targets, generated graphs, core/Ball/ISA identities and the RTL consumer path.

Run focused operator/IP/subgraph checks and affected supported consumers. Inspect
small RTL cases with diff enabled and waveform capture off initially. Diagnose
failed boundaries with their actual input/output differences before rerunning.
Treat whole-model BEMU, full-chip simulation, P2E/FPGA and physical backend as
outside this experiment. Completion is the frozen frontend acceptance, including
actual mapped-arm numerical evidence, implementation and synthesis-estimated PPA.
Local IP results establish only their tested boundary.

## Tools and delivery

Call `mcp__buckyball__bbdev` with your independent absolute checkout and current
CLI argv; it activates the prepared Nix environment. Examples are
`["compiler", "--build", "--chip <chip>"]` and
`["model", "--build", "--chip <chip> --model <model>"]`.
Keep all sub-arguments after an operation such as `--build` in one argv string.
Use native files/bash for source inspection and standalone tools. Read current
CLI help for operation parameters; retain command, exit status and terminal logs.

Deliver checkpoint/input identities, implementation patches, recipe/graph/mapping
contracts, actual numerical reports, regression coverage and reproducible commands.
Record library/corner/clock/activity, active instances, memory assumptions and the
workload/offload boundary for synthesis estimates. Distinguish weights, executable
and generated RTL sizes. A single input does not establish dataset accuracy;
Top-5 agreement does not establish equality of all logits. Preserve actual failures
and remaining gaps. Autonomous design choices and routine fixes within this scope
are authorized; record evidence and rationale.
