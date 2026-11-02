---
name: chip-designer
description: "Lead creation of a new Buckyball chip: choose topology and core composition, define inter-core contracts, create the chip configuration skeleton, and sequence integration. Use when creating or leading a chip rather than implementing one Ball or core. Use current bbdev CLI through the prepared domain MCP."
---

# Chip Design

Use this technical reference within the frozen Task scope and executable checks.
Read bundled files from the resourceBase returned by native `skill(name=...)`.
Choose a local workflow and retain actual evidence; the independent acceptance
policy determines completion.

Own the topology and integration responsibilities assigned by the Task contract. Include coupled core/Ball/compiler/RTL work when that scope needs it, retaining explicit interfaces and executable checks. Change framework code only for a demonstrated reusable gap.

## Design Flow

1. Explain why an existing chip does not fit the workload. Identify independent compute stages, data exchanged between them, and their relative latency.
2. Choose topology before implementation. Prefer a small number of core types; choose replica counts from measured or estimated stage latency. Define SharedMem regions, shape/dtype/layout contracts, ownership, and mismatch behavior. Invalid shape or layout must fail explicitly.
3. Create the configuration skeleton using existing chips as templates:
   - `examples/chips/<chip>/configs/chip.toml` selects `designs/*.toml` and simulation configs;
   - `configs/designs/*.toml` declares tiles;
   - `configs/designs/tiles/*.toml` declares `sharedMem` and `[[cores]]` entries that include `examples/cores/<core>/configs/default.toml`;
   - `arch/src/main/scala/CustomConfigs.scala`, `sims/verilator/TargetConfigs.scala`, and `sims/p2e/TargetConfigs.scala` define target configs;
   - add chip `emu/`, `workloads/`, and regression TOMLs only when their consumers exist.
4. Give each core owner a brief containing its mission, fixed inter-core contract, acceptance tests, and non-goals. Do not delegate topology or contract decisions as an open-ended task.
5. Integrate in order: core/slice unit test, pairwise SharedMem test, then the actual supported frontend consumer boundary. Add a regression entry only for a supported binary; exclude an unsupported binary from a batch list without deleting its CMake target.

## Existing References

- `examples/chips/poly/`: heterogeneous prefill/decode cores with SharedMem and chip-level emulation.
- `examples/chips/goban/`: multi-core chip configuration and emulation.
- `examples/chips/toy/`: minimal virtual single-core chip layout.

## Constraints

- Do not add a private model partitioning flow unless the repository contains and documents the required tooling.
- Do not silently resize, truncate, or default mismatched inter-core data.
- Keep registration, compiler/ISA and Ball implementation consistent for the coupled changes required by this Task.
- Invoke allowed build, focused tests and synthesis through `mcp__buckyball__bbdev` with the absolute independent checkout and current CLI argv. Retain terminal outcomes. Whole-model BEMU, full-chip simulation, P2E/FPGA and physical backend are outside this experiment.
