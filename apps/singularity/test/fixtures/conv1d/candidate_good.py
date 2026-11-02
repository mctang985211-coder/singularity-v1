"""A correct example submission; not provided to a future task-solving model."""

import json
import sys


def solve(request):
    x, weights, dilation = request["x"], request["kernel"], request["dilation"]
    if request["op"] == "kernel":
        return [sum(weight * x[t - j * dilation] for j, weight in enumerate(weights)
                    if t - j * dilation >= 0) for t in range(len(x))]
    history, output, cursor = [], [], 0
    for count in request["chunks"]:
        for value in x[cursor:cursor + count]:
            history.append(value)
            t = len(history) - 1
            output.append(sum(weight * history[t - j * dilation]
                              for j, weight in enumerate(weights) if t >= j * dilation))
        cursor += count
    return output


if __name__ == "__main__":
    print(json.dumps({"y": solve(json.load(sys.stdin))}))
