---
name: ball-align
description: Align a Buckyball Ball's C tests, BEMU behavior, compiler lowering, MLIR tests, RTL, and UVM to one explicit contract. Use when a Ball semantic change spans layers, BEMU and RTL disagree, ISA fields are renamed, or tests must be synchronized after a contract change.
---

# Ball Alignment

Use this technical reference within the frozen Task scope and executable checks.
Read bundled files from the resourceBase returned by native `skill(name=...)`.
Choose a local workflow and retain actual evidence; the independent acceptance
policy determines completion.

Use the documented C semantics and independent oracle as references. The stages
below are a candidate debugging procedure. Select and arrange work from the Task
contract, actual dependencies and observed failures; local passes cover only their
stated boundary. Autonomous coupled changes within the experiment are authorized.
Load `skill(name="check")` for registration and `skill(name="workload-tests")`
for focused cases. The actual frontend graph/compiler/RTL path must agree.

## Stage 0 — Contract first (before any code)

Resolve and record from the Task goal, active configuration and consumers:

1. ISA fields and their source of truth.
2. Element width, address calculation, and per-iteration read/write footprint.
3. Valid inputs, invalid inputs, and the required failure behavior.
4. Output layout, including packing and zero-fill.
5. Every affected consumer: ISA macro, emulator, compiler lowering, MLIR test, C test, RTL, UVM, and regression list.

Hard rules:

- Register each Ball in the core/configuration actually selected by the design;
  verify the generated topology and its real compiler/RTL consumers.
- No field with multiple meanings; no compatibility fallback that hides an invalid input.
- Address and capacity from the active configuration and bank row width; do not
  raise limits before small tests are green.
- Load `skill(name="check")` to validate registration before and after registration work.

## Stage 1 — C test + BEMU golden model

Write the **C test first**: it pins the golden semantics every later layer must
match. Then write the **BEMU model** bit-for-bit against that C reference. Both
share the same legal/illegal checks and fail hard (panic/assert) — no soft defaults.

- Small tests: short shapes, hand vectors, edge and illegal inputs.
- Bank tests: `iter≈BANK_LINES`, `srand`/`rand`; soft numeric may report LOSS — **BEMU only**.

Retain the C/oracle comparison for the focused case. Small component BEMU runs
are allowed where supported; whole-model BEMU is excluded.

## Stage 2 — Compiler + MLIR test (on BEMU)

For compiler work:

- Keep the `bank` Op and the lowered `ball` Op separate (see transpose).
- Lower in order: bank Op → assign-physical-banks → ball Op → instruction. Keep
  lit files per layer; do not mix them.
- MLIR tests live under `examples/balls/<ball>/workloads/mlir_tests/` (not under
  the chip); FileCheck plus an mlirtest ELF.
- New ctest / mlirtest → add the bare-metal artifact to the chip BEMU `workloads-bare.toml` and the Linux program to `kernel/workloads.toml`; `workloads-linux.toml` selects the firmware boot ELF.

Check the generated lowering and focused mlirtest ELF against the same oracle.
Preserve the target and graph identity consumed by RTL integration.

## Stage 3 — RTL

For RTL work:

- Capture command fields on `cmdReq.fire`.
- Respect one-cycle SRAM read latency from request handshake to response.
- Keep `status.idle` / `status.running` consistent with the state machine.
- Use explicit Chisel widths; block in-place same-bank writes that overwrite unread source data.
- Verilator lists take **small tests only**, not bank tests.

Run small supported component RTL checks with diff enabled initially. Use
`mcp__buckyball__bbdev` and current `bebop-verilator`/`verilator` CLI help.
Retain first differences and terminal logs; inspect trace before large waveforms.
Full-chip simulation is outside this experiment.

## Stage 4 — PPA + UVM verification

For verification and synthesis:

- Sync integration tests (real consumers; update on contract changes).
- UVM: stimulus/scoreboard on the same contract and focused IP/parameter scope.
- PPA: area/power/timing from the DC flow; PMC from `bdb.ndjson` /
  `bdb.log` `pmctrace` (`elapsed`).

## Delivery

Report the contract, changed layers, actual consumer path, numerical evidence and
remaining gaps. Use `mcp__buckyball__bbdev` with the independent absolute checkout
and current CLI argv for allowed component checks and synthesis. Record terminal
status and command/config/source/report identities. P2E/FPGA, whole-model BEMU,
full-chip simulation and physical backend are outside the frontend experiment.
