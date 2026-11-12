import json
import sys
import tabulate

payload = json.load(sys.stdin)
table = tabulate.tabulate([[row["service"], row["owner"]] for row in payload["rows"]], headers=["Service", "Owner"], tablefmt="github")
print(json.dumps({"library_version_used": tabulate.__version__, "markdown": f"# {payload['title']}\n\n{table}", "row_count": len(payload["rows"])}))
