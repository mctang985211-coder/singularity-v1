#!/usr/bin/env python3
"""Standalone public-data example. Not a Singularity runtime or RTL verifier."""

import argparse
import hashlib
import json
import random
import subprocess
import sys
from pathlib import Path


SPEC = {
    "operation": "causal-int8-conv1d",
    "equation": "y[t] = sum(kernel[j] * x[t-j*dilation]); x[t<0]=0",
    "arithmetic": "exact signed integer; int8 inputs/weights, int32 outputs",
    "kernel_sizes": [1, 2, 3, 5],
    "dilations": [1, 2, 3],
    "stream": "chunk partition preserves the concatenated batch result",
}


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def reference(x, kernel, dilation):
    # The oracle accumulates shifted input vectors independently of the candidates.
    y = [0] * len(x)
    for j, weight in enumerate(kernel):
        offset = j * dilation
        for source, value in enumerate(x[: max(0, len(x) - offset)]):
            y[source + offset] += weight * value
    return y


def cases():
    fixed = [
        ([], [1], 1),
        ([127], [-128], 1),
        ([127, -128, 127, -128], [127, -128, 127], 1),
        ([1, 2, 3, 4, 5, 6], [3, -2, 1], 2),
        ([-3, 0, 4, 8, -9, 2, 1, 5, 6], [1, -2, 3, -4, 5], 3),
    ]
    rng = random.Random(20261102)
    for index in range(24):
        count = [1, 2, 5, 11, 17, 23][index % 6]
        width = SPEC["kernel_sizes"][index % 4]
        dilation = SPEC["dilations"][index % 3]
        fixed.append(([rng.randint(-128, 127) for _ in range(count)],
                      [rng.randint(-128, 127) for _ in range(width)], dilation))
    for index, (x, kernel, dilation) in enumerate(fixed):
        chunks = []
        remaining = len(x)
        while remaining:
            size = min(remaining, 1 + (len(chunks) % 3))
            chunks.append(size)
            remaining -= size
        yield {"id": f"case-{index:02d}", "x": x, "kernel": kernel,
               "dilation": dilation, "chunks": chunks}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--suite", choices=["kernel", "stream", "all"], required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    candidate = args.candidate.resolve()
    test_cases = list(cases())
    profiles = ["kernel", "stream"] if args.suite == "all" else [args.suite]
    failures = []
    compared = 0
    mismatches = 0
    largest_error = 0
    execution_errors = 0
    candidate_digest = digest(candidate.read_bytes()) if candidate.is_file() else None
    verifier_digest = digest(Path(__file__).read_bytes())
    for profile in profiles:
        for case in test_cases:
            request = {**case, "op": profile}
            expected = reference(case["x"], case["kernel"], case["dilation"])
            try:
                process = subprocess.run(
                    [sys.executable, str(candidate)], input=json.dumps(request),
                    capture_output=True, text=True, timeout=3, cwd=candidate.parent,
                )
                if process.returncode != 0:
                    raise ValueError(f"candidate exit={process.returncode}: {process.stderr[:250]}")
                actual = json.loads(process.stdout)["y"]
                if (not isinstance(actual, list) or len(actual) != len(expected)
                        or any(type(value) is not int or not -(2**31) <= value < 2**31
                               for value in actual)):
                    raise ValueError("candidate y must contain one int32 per input element")
            except (ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
                execution_errors += 1
                failures.append({"caseId": case["id"], "profile": profile,
                                 "kind": "execution-error", "reason": str(error)})
                continue
            errors = [abs(a - b) for a, b in zip(actual, expected)]
            count = sum(value != 0 for value in errors)
            compared += len(expected)
            mismatches += count
            largest_error = max([largest_error, *errors])
            if count:
                first = next(i for i, value in enumerate(errors) if value)
                failures.append({"caseId": case["id"], "profile": profile,
                                 "kind": "mismatch", "count": count,
                                 "firstIndex": first, "expected": expected[first],
                                 "observed": actual[first]})
    passed = not failures and compared > 0
    report = {
        "schema": "local-check-result/v1", "checkId": args.suite,
        "verdict": "pass" if passed else "fail",
        "candidateDigest": candidate_digest, "verifierDigest": verifier_digest,
        "specDigest": digest(json.dumps(SPEC, sort_keys=True).encode()),
        "caseSetDigest": digest(json.dumps(test_cases, sort_keys=True).encode()),
        "metrics": {"casesRun": len(test_cases) * len(profiles),
                    "valuesCompared": compared, "mismatches": mismatches,
                    "maxAbsError": largest_error, "executionErrors": execution_errors},
        "failures": failures,
    }
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text)
    sys.stdout.write(text)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
