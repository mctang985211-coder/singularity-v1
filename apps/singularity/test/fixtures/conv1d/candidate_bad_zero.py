"""Negative control: process succeeds but returns numerically wrong values."""

import json
import sys


if __name__ == "__main__":
    request = json.load(sys.stdin)
    print(json.dumps({"y": [0] * len(request["x"])}))
