import json
import math
import statistics
import sys
import tabulate

records = json.load(sys.stdin)["records"]
rows = []
for key in sorted({key for row in records for key in row}):
    values = [row[key] for row in records if type(row.get(key)) in (int, float) and math.isfinite(row[key])]
    rows.append({"field": key, "numeric_values": len(values), "missing": sum(row.get(key) is None for row in records),
                 "min": min(values) if values else None, "max": max(values) if values else None,
                 "mean": round(statistics.mean(values), 2) if values else None})
print(json.dumps({"library_version_used": tabulate.__version__, "records_analyzed": len(records),
                  "columns": ["field", "numeric_values", "missing", "min", "max", "mean"], "rows": rows,
                  "markdown": tabulate.tabulate(rows, headers="keys", tablefmt="github")}, allow_nan=False))
