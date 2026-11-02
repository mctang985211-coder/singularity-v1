---
name: check
description: Validate Buckyball Ball registration consistency. Use when users ask to inspect registration status, validate a BallDomain configuration, troubleshoot registration issues, or check a registration change.
---

# Registration Check

Use this technical reference within the frozen Task scope and executable checks.
Read bundled files from the resourceBase returned by native `skill(name=...)`.
Choose a local workflow and retain actual evidence; the independent acceptance
policy determines completion.

Inspect the active chip and generated BallDomain through native files/bash.
The prepared repository has validation code in `bbdev/mcp/common.py`
(`_validate_chip`/`_validate_domain`); use that implementation for a standalone
focused check when needed. This session exposes `mcp__buckyball__bbdev`, rather
than the old MCP tool named `validate`. Select the actual Task target.

The tool resolves the selected BallDomain from the chip's generated topology. Registrations live under `examples/cores/<core>/configs/balldomains/`, not under the chip directory. The current implementation requires the chip to resolve to one unique topology core; for heterogeneous chips, validate each core's BallDomain explicitly. Pass a stem such as `default` or a `.toml` path only when selecting a non-default domain.

Report the tool's pass/fail result for:

1. `ballNum` equals `ballIdMappings` length.
2. `ballId` is exactly `0, 1, 2, ...` with no duplicates or gaps.
3. `ballName`, `funct7`, and mnemonic are unique within this BallDomain.
4. Each ISA `bid` exists and every Ball has at least one ISA entry.
5. Each Ball config path exists and `inBW`/`outBW` are positive.

Expand each Ball's nested `isa` entries into a summary table with `ballId`, `ballName`, `funct7`, `mnemonic`, `inBW`, `outBW`, and `config`.

`validate` does not scan source headers or MLIR for hardcoded encodings. When that check is needed, inspect the relevant Ball/compiler sources separately and report it as a distinct result.

A check reports findings. When this Task includes a registration repair, autonomous
correction is authorized; record any ISA semantic change and update actual consumers.
Recheck generated topology, headers, compiler and RTL identities after the repair.
