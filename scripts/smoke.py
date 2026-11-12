"""Verify a running deployment over HTTP: python scripts/smoke.py [base-url]."""

import json
import sys
import time
from urllib.request import Request, urlopen

base = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")


def request(path, payload=None):
    body = json.dumps(payload).encode() if payload is not None else None
    req = Request(base + path, data=body, headers={"Content-Type": "application/json"})
    with urlopen(req, timeout=10) as response:
        return json.load(response)


with urlopen(base, timeout=10) as response:
    html = response.read().decode()
    assert 'id="root"' in html and "/assets/" in html
caps = request("/api/capabilities")
assert len(caps) >= 5 and all(cap["status"] == "READY" for cap in caps), caps
experiments = [
    ("legacy-report-formatter", {}, "succeeded"),
    ("modern-data-profiler", {}, "succeeded"),
    ("log-pattern-analyzer", {}, "succeeded"),
    ("cloud-cost-estimator", {}, "succeeded"),
    ("broken-experimental-script", {"mode": "crash"}, "failed"),
    ("broken-experimental-script", {"mode": "timeout"}, "timed_out"),
]
pending = {}
for slug, inputs, status in experiments:
    accepted = request(f"/api/capabilities/{slug}/runs", {"inputs": inputs})
    pending[accepted["id"]] = (slug, inputs, status)
results = []
deadline = time.monotonic() + 180
max_health_latency = 0
while pending and time.monotonic() < deadline:
    started = time.monotonic()
    assert request("/api/health")["status"] == "ok"
    max_health_latency = max(max_health_latency, time.monotonic() - started)
    for run_id, (slug, inputs, expected) in list(pending.items()):
        run = request(f"/api/runs/{run_id}")
        if not run["finished_at"]:
            continue
        assert run["status"] == expected, run
        if slug == "legacy-report-formatter":
            assert run["result"]["library_version_used"] == "0.8.9", run
        elif slug == "modern-data-profiler":
            assert run["result"]["library_version_used"] == "0.9.0", run
        elif slug == "log-pattern-analyzer":
            assert run["result"]["summary"]["requests"] == 14
        elif slug == "cloud-cost-estimator":
            assert run["result"]["total_monthly_usd"] > 0
        elif inputs["mode"] == "crash":
            assert "ZeroDivisionError" in run["stderr"]
        elif inputs["mode"] == "timeout":
            assert "exceeded 2s" in run["error"]
        results.append(run)
        print(f"PASS {slug} {inputs.get('mode', '')}: {run['status']}", flush=True)
        del pending[run_id]
    time.sleep(.1)
assert not pending, f"Runs did not finish: {pending}"
versions = [run for run in results if "library_version_used" in (run["result"] or {})]
assert len({run["environment"] for run in versions}) == 2
assert max_health_latency < 2, f"Host health was slow: {max_health_latency:.2f}s"
print(f"PASS frontend served, registry healthy, real dependency isolation, durable logs, concurrent host health ({max_health_latency * 1000:.0f}ms worst case)")
