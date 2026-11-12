"""Real venv tests; version checks require PyPI on a cold cache."""

import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from test_api import wait_for_run

SAMPLES = Path(__file__).resolve().parents[1] / "capabilities"


@pytest.fixture(scope="session")
def environment_cache(tmp_path_factory):
    return tmp_path_factory.mktemp("integration-environments")


@pytest.fixture
def client(tmp_path, environment_cache):
    root = tmp_path / "capabilities"
    shutil.copytree(SAMPLES, root)
    app = create_app(root, environment_cache, tmp_path / "data/runs.db")
    with TestClient(app) as value:
        yield value


def launch(client, slug, inputs=None):
    response = client.post(f"/api/capabilities/{slug}/runs", json={"inputs": inputs or {}})
    assert response.status_code == 202, response.text
    return response.json()["id"]


def test_conflicting_versions_execute_in_real_cached_venvs(client, environment_cache):
    legacy = launch(client, "legacy-report-formatter")
    modern = launch(client, "modern-data-profiler")
    started = time.monotonic()
    assert client.get("/api/health").json()["status"] == "ok"
    assert time.monotonic() - started < 2
    first = wait_for_run(client, legacy, timeout=120)
    second = wait_for_run(client, modern, timeout=120)
    assert first["status"] == "succeeded", first
    assert second["status"] == "succeeded", second
    assert first["result"]["library_version_used"] == "0.8.9"
    assert second["result"]["library_version_used"] == "0.9.0"
    assert first["environment"] != second["environment"]
    marker = environment_cache / first["environment"] / ".ready"
    initial_mtime = marker.stat().st_mtime_ns
    again = wait_for_run(client, launch(client, "legacy-report-formatter"))
    assert again["status"] == "succeeded"
    assert again["environment"] == first["environment"]
    assert marker.stat().st_mtime_ns == initial_mtime


@pytest.mark.parametrize(("mode", "status", "diagnostic"), [
    ("crash", "failed", "ZeroDivisionError"),
    ("timeout", "timed_out", "exceeded 2s"),
    ("syntax_error", "failed", "SyntaxError"),
    ("missing_dependency", "failed", "ModuleNotFoundError"),
    ("invalid_json", "failed", "stdout must contain one JSON value"),
    ("noisy", "failed", "Output exceeded"),
])
def test_failures_are_bounded_audited_and_do_not_block_other_tools(client, mode, status, diagnostic):
    failed_id = launch(client, "broken-experimental-script", {"mode": mode})
    healthy_id = launch(client, "cloud-cost-estimator")
    assert client.get("/api/health").status_code == 200
    failed = wait_for_run(client, failed_id, timeout=45)
    healthy = wait_for_run(client, healthy_id, timeout=45)
    assert failed["status"] == status, failed
    assert diagnostic in (failed["error"] or "") + failed["stderr"]
    assert "Starting isolation experiment" in failed["stderr"]
    assert len(failed["stdout"].encode()) <= 512000
    assert failed["finished_at"] and failed["duration_ms"] is not None
    assert healthy["status"] == "succeeded", healthy
    assert healthy["result"]["total_monthly_usd"] > 0
    assert client.get(f"/api/runs/{failed_id}").json()["stderr"] == failed["stderr"]


def test_malformed_hot_drop_does_not_break_registry_or_execution(client):
    root = client.app.state.discovery.root
    bad = root / "incomplete-drop"
    bad.mkdir()
    (bad / "manifest.json").write_text("{broken", encoding="utf-8")
    result = client.get("/api/capabilities").json()
    assert len(result) == 6
    invalid = next(item for item in result if item["id"] == "incomplete-drop")
    assert invalid["status"] == "INVALID" and invalid["diagnostics"]
    assert client.post("/api/capabilities/incomplete-drop/runs", json={}).status_code == 409
    run = wait_for_run(client, launch(client, "log-pattern-analyzer"))
    assert run["status"] == "succeeded", run
    assert run["result"]["summary"] == {"requests": 14, "errors": 3, "latency_spikes": 4, "pii_findings": 2, "p95_latency_ms": 2110.0}
    assert all("@example.com" not in log["line"] for log in run["result"]["logs"])
