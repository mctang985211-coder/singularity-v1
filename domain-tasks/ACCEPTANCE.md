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
