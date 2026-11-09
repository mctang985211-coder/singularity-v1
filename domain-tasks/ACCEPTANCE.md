# Domain acceptance protocol v1

Domain acceptance is a host boundary. A domain directory supplies a `TaskSpec`
criterion and its executable `check` command; the Singularity runtime supplies
the same invocation for every domain.

For each required criterion with `acceptance: "checks"`, the host:

1. creates a fresh temporary work directory;
2. copies every frozen `InputRef` into its declared path;
3. materializes declared submitted outputs at their declared paths;
4. runs the frozen command with `set -e -o pipefail`, the run deadline and the
   host cancellation signal; and
5. records the process exit status in the standard `PublicReceipt` criterion
   result.

The command receives no worker workspace, transcript, Task tree, Method state,
or scheduler handle. It must derive its result only from the files declared by
the contract. A non-zero exit, timeout, or signal is a failed check; a missing
or malformed receipt remains an invalid host result. The host never interprets
domain-specific verdict text or a script's self-reported total verdict.

`acceptance.py` is therefore an ordinary frozen input, not an imported plugin.
It may implement domain mathematics and invoke a prepared external consumer,
but its process contract is always the one above. New domains only provide
their task JSON and check command; they do not add a scheduler, verifier Agent,
retry policy, budget, or experiment entry point.

The Buckyball example freezes `bemu.py` alongside `acceptance.py`. The operator
pins focused BEMU executable paths in `project.bemu` before loading the domain.
The checker inspects the submitted ELF's loadable input symbols and independently
replays that ELF with the pinned binary; candidate command records do not select
the trusted executable. These are domain checks, with no Buckyball branches in
the host. See `buckyball/README.md` for the device output interface and preparation.

For performance objectives, domain.json can select `metric: {criterion, name,
unit}`. That required criterion declares `checkOutput: "metric-json"`; its
successful stdout is exactly one `{name, unit, value}` JSON object. The trusted
frozen check independently measures the submitted consumer, including correctness,
and owns the baseline, formula, workloads, tool versions and raw reports. A fixed
reference scores 1; positive finite scores are higher-is-better with no artificial
ceiling. Missing/truncated/malformed measurements are invalid. Failed correctness
cannot earn performance. The host aggregates all public measurements geometrically
and keeps validation separate; domain bundles do not own RSI control or activation.
