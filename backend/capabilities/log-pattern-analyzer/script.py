"""Standalone JSON-in/JSON-out log analysis. No host imports."""
import collections
import json
import math
import re
import sys

payload = json.load(sys.stdin)
threshold = payload.get("latency_threshold_ms", 500)
email = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")
logs = []
timeline = collections.defaultdict(lambda: {"requests": 0, "errors": 0, "slow": 0})
for index, line in enumerate(payload["logs"].splitlines()):
    if not line.strip():
        continue
    status_match = re.search(r"status=(\d{3})", line)
    latency_match = re.search(r"latency=([\d.]+)ms", line)
    route = re.search(r"\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S+)", line)
    status = int(status_match[1]) if status_match else None
    latency = float(latency_match[1]) if latency_match else None
    findings = []
    if status is not None and status >= 500:
        findings.append("Server error")
    elif status is not None and status >= 400:
        findings.append("Client error")
    if latency is not None and latency > threshold:
        findings.append("Latency spike")
    if email.search(line):
        findings.append("PII exposure")
    severity = "error" if status is not None and status >= 500 else "warning" if findings else "info"
    timestamp = line.split()[0]
    minute = timestamp[11:16] if re.match(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", timestamp) else "Unknown"
    bucket = timeline[minute]
    bucket["requests"] += 1
    bucket["errors"] += int(severity == "error")
    bucket["slow"] += int("Latency spike" in findings)
    logs.append({"id": index, "timestamp": timestamp, "method": route[1] if route else "-",
                 "path": route[2] if route else "-", "status": status, "latency_ms": latency,
                 "severity": severity, "findings": findings,
                 "line": email.sub("[redacted]", line) if payload.get("redact_pii", True) else line})
latencies = sorted(item["latency_ms"] for item in logs if item["latency_ms"] is not None)
result = {"summary": {"requests": len(logs), "errors": sum(item["severity"] == "error" for item in logs),
                       "latency_spikes": sum("Latency spike" in item["findings"] for item in logs),
                       "pii_findings": sum("PII exposure" in item["findings"] for item in logs),
                       "p95_latency_ms": latencies[max(0, math.ceil(len(latencies) * .95) - 1)] if latencies else 0},
          "timeline": [{"time": key, **value} for key, value in sorted(timeline.items())], "logs": logs}
print(f"Analyzed {len(logs)} lines; threshold={threshold}ms", file=sys.stderr)
print(json.dumps(result, allow_nan=False))
