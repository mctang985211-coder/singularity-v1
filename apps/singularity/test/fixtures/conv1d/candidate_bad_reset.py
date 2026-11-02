"""Negative control: stream state is incorrectly reset at every chunk."""

import json
import sys


def kernel(x, weights, dilation):
    return [sum(weight * x[t - j * dilation] for j, weight in enumerate(weights)
                if t >= j * dilation) for t in range(len(x))]


if __name__ == "__main__":
    request = json.load(sys.stdin)
    x, weights, dilation = request["x"], request["kernel"], request["dilation"]
    if request["op"] == "kernel":
        y = kernel(x, weights, dilation)
    else:
        y, cursor = [], 0
        for count in request["chunks"]:
            y.extend(kernel(x[cursor:cursor + count], weights, dilation))
            cursor += count
    print(json.dumps({"y": y}))
