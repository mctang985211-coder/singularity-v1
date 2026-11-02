---
name: report
description: Report actual frontend artifacts, commands, numerical checks, synthesis conditions and remaining integration gaps. Use for delivery or retry evidence provenance.
---

# Frontend Evidence Report

Report the current Task's frozen goal, declared outputs and actual consumer path.
For each check bind source/config/input/output/checker/report identities, command,
exit status, coverage and observed data. Distinguish this Run's new execution,
changed-and-rerun checks, reused frozen evidence and unverified work. Prior local
passes cover only their recorded scope; a changed mapping needs new applicability
checks. Do not rename an old log to imply a new run.

For synthesis PPA state the workload/offload boundary, active instances, memory
model, library/corner/clock/activity, measurement method and actual report values.
Keep estimates distinct from hardware measurements. Preserve failed experiments,
unsupported stages and incomplete integration. Deliver reproducible commands with
implementation patches and explain what the parent or final consumer must check.
