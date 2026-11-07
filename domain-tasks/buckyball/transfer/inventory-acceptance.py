import csv
import json
from pathlib import Path

with Path("records.csv").open(newline="", encoding="utf-8") as source:
    reader = csv.DictReader(source)
    if reader.fieldnames != ["sku", "delta"]:
        raise SystemExit("records.csv must have exactly the sku,delta header")
    rows = list(reader)

totals = {}
for row in rows:
    sku = row["sku"]
    if not sku:
        raise SystemExit("SKU must be nonempty")
    totals[sku] = totals.get(sku, 0) + int(row["delta"])
expected = {
    "rowCount": len(rows),
    "totals": [{"sku": sku, "quantity": totals[sku]} for sku in sorted(totals)],
}
actual = json.loads(Path("report.json").read_text(encoding="utf-8"))
valid = (
    type(actual) is dict
    and set(actual) == {"rowCount", "totals"}
    and type(actual["rowCount"]) is int
    and type(actual["totals"]) is list
    and all(
        type(row) is dict
        and set(row) == {"sku", "quantity"}
        and type(row["sku"]) is str
        and type(row["quantity"]) is int
        for row in actual["totals"]
    )
)
if not valid:
    raise SystemExit("report must contain only an integer rowCount and {sku, integer quantity} entries")
if actual != expected:
    raise SystemExit(f"report mismatch\nexpected: {expected}\nactual: {actual}")
print("Exact row count, SKU coverage, integer totals and ascending order verified.")
