import json
import sys

payload = json.load(sys.stdin)
rate = {"eu-central-1": .112, "us-east-1": .096, "ap-southeast-1": .12}[payload["region"]]
count = payload["instance_count"]
rows = [
    {"resource": "Compute", "quantity": f"{count} instances x 730 hours", "monthly_usd": round(count * rate * 730 * (.35 if payload["spot"] else 1), 2)},
    {"resource": "Block storage", "quantity": f"{count * 50} GB", "monthly_usd": round(count * 50 * .10, 2)},
    {"resource": "Data transfer", "quantity": f"{count * 20} GB", "monthly_usd": round(count * 20 * .09, 2)},
    {"resource": "Monitoring", "quantity": f"{count} instances", "monthly_usd": round(count * 3.5, 2)},
]
total = round(sum(row["monthly_usd"] for row in rows), 2)
print(json.dumps({"total_monthly_usd": total, "currency": "USD", "region": payload["region"], "environment": payload["environment"],
                  "columns": ["resource", "quantity", "monthly_usd"], "rows": rows,
                  "note": "Illustrative local rates only. No cloud APIs or credentials are used."}))
