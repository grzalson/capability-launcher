import json
import time

from fastapi.testclient import TestClient

from app.main import create_app
from test_discovery import manifest, write_cap


def wait_for_run(client, run_id, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = client.get(f"/api/runs/{run_id}")
        assert result.status_code == 200
        run = result.json()
        if run["status"] not in {"queued", "preparing", "running"}:
            # Final status and duration are persisted in separate short transactions.
            if run["finished_at"]:
                return run
        time.sleep(.05)
    raise AssertionError(f"Run {run_id} did not finish: {run}")


def test_registry_registration_execution_and_validation(tmp_path):
    root = tmp_path / "capabilities"
    write_cap(root, "broken-tool", script=None)
    app = create_app(root, tmp_path / "venvs", tmp_path / "data/runs.db")
    with TestClient(app) as client:
        assert client.get("/api/health").json()["status"] == "ok"
        assert client.get("/api/capabilities").json()[0]["status"] == "INVALID"
        assert client.post("/api/capabilities/broken-tool/runs", json={}).status_code == 409
        data = manifest("echo-tool", input_schema={"type": "object", "required": ["count"], "additionalProperties": False,
                        "properties": {"count": {"type": "integer", "minimum": 1, "default": 2}}})
        request = {"manifest": data, "script": "import json,sys; print(json.dumps(json.load(sys.stdin)))"}
        assert client.post("/api/capabilities", json=request).status_code == 201
        assert client.post("/api/capabilities", json=request).status_code == 409
        assert client.get("/api/capabilities/echo-tool/environment").json()["status"] == "cold"
        assert client.post("/api/capabilities/echo-tool/runs", json={"inputs": {"count": -1}}).status_code == 422
        run_id = client.post("/api/capabilities/echo-tool/runs", json={}).json()["id"]
        run = wait_for_run(client, run_id)
        assert run["status"] == "succeeded", run
        assert run["result"] == {"count": 2}
        assert client.get("/api/capabilities/echo-tool/environment").json()["status"] == "ready"
        assert client.get("/api/runs").json()[0]["id"] == run_id
        assert client.get("/api/runs/missing").status_code == 404
        assert client.post("/api/capabilities", content=b"x" * 512001, headers={"Content-Type": "application/json"}).status_code == 413


def test_registration_rejects_paths_and_bad_python(tmp_path):
    app = create_app(tmp_path / "caps", tmp_path / "venvs", tmp_path / "runs.db")
    with TestClient(app) as client:
        for slug in ["../escape", "UPPER", "has space"]:
            assert client.post("/api/capabilities", json={"manifest": manifest(slug), "script": "print('{}')"}).status_code == 422
        assert client.post("/api/capabilities", json={"manifest": manifest(), "script": "broken ("}).status_code == 422
        for schema in [{"type": "object", "properties": {"a": {"type": "wrong"}}},
                       [{"type": "string"}],
                       {"type": "object", "properties": {"a": {"type": "integer", "default": "wrong"}}}]:
            assert client.post("/api/capabilities", json={"manifest": manifest(input_schema=schema), "script": "print('{}')"}).status_code == 422
        assert client.get("/api/capabilities").json() == []


def test_category_updates_persist_without_changing_execution_or_history(tmp_path):
    root = tmp_path / "caps"
    data = manifest("category-tool", category="Original")
    folder = write_cap(root, "category-tool", data)
    script = (folder / "script.py").read_bytes()
    app = create_app(root, tmp_path / "venvs", tmp_path / "runs.db")
    with TestClient(app) as client:
        before = client.get("/api/capabilities/category-tool/environment").json()
        recorded = app.state.store.create("category-tool", {}, data)
        result = client.patch("/api/capabilities/category-tool/category", json={"category": "  Engineering  "})
        assert result.status_code == 200
        assert result.json()["manifest"]["category"] == "Engineering"
        assert client.get("/api/capabilities").json()[0]["manifest"]["category"] == "Engineering"
        assert json.loads((folder / "manifest.json").read_text(encoding="utf-8"))["category"] == "Engineering"
        assert (folder / "script.py").read_bytes() == script
        assert client.get("/api/capabilities/category-tool/environment").json() == before
        assert client.get(f"/api/runs/{recorded}").json()["manifest"]["category"] == "Original"
        assert not list(folder.glob(".category-*"))
        preflight = client.options("/api/capabilities/category-tool/category", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "PATCH"})
        assert preflight.status_code == 200
    with TestClient(create_app(root, tmp_path / "venvs", tmp_path / "runs.db")) as client:
        assert client.get("/api/capabilities/category-tool").json()["manifest"]["category"] == "Engineering"


def test_category_updates_validate_and_reject_invalid_capabilities(tmp_path):
    root = tmp_path / "caps"
    write_cap(root, "valid-tool")
    write_cap(root, "broken-tool", script=None)
    with TestClient(create_app(root, tmp_path / "venvs", tmp_path / "runs.db")) as client:
        for value in ["", "  ", "x" * 41, None, 123]:
            assert client.patch("/api/capabilities/valid-tool/category", json={"category": value}).status_code == 422
        assert client.patch("/api/capabilities/valid-tool/category", json={"category": "Other", "script": "modified"}).status_code == 422
        assert client.patch("/api/capabilities/missing-tool/category", json={"category": "Other"}).status_code == 404
        assert client.patch("/api/capabilities/broken-tool/category", json={"category": "Other"}).status_code == 409
        assert client.get("/api/capabilities/valid-tool").json()["manifest"]["category"] == "Utilities"
        assert client.post("/api/capabilities", json={"manifest": manifest("new-tool", category="  "), "script": "print('{}')"}).status_code == 422


def test_edit_capability_persists_full_settings_and_keeps_history(tmp_path):
    root = tmp_path / 'caps'
    original = manifest('edit-tool', category='Original')
    folder = write_cap(root, 'edit-tool', original)
    (folder / 'asset.txt').write_text('keep this asset', encoding='utf-8')
    app = create_app(root, tmp_path / 'venvs', tmp_path / 'runs.db')
    with TestClient(app) as client:
        source = client.get('/api/capabilities/edit-tool/files').json()
        run_id = app.state.store.create('edit-tool', {}, original)
        before_environment = client.get('/api/capabilities/edit-tool/environment').json()['key']
        changed = {**original, 'name': 'Updated tool', 'description': 'Updated description', 'version': '2.0', 'category': 'Engineering', 'timeout_seconds': 42, 'output_type': 'table', 'python_dependencies': ['tabulate==0.9.0'], 'input_schema': {'type': 'object', 'properties': {'count': {'type': 'integer', 'default': 3}}}}
        response = client.put('/api/capabilities/edit-tool', json={'manifest': changed, 'script': "print('[]')", 'revision': source['revision']})
        assert response.status_code == 200, response.text
        assert response.json()['manifest']['name'] == 'Updated tool'
        saved = client.get('/api/capabilities/edit-tool/files').json()
        assert saved['script'] == "print('[]')" and saved['revision'] != source['revision']
        assert json.loads(saved['manifest_json'])['timeout_seconds'] == 42
        assert (folder/'asset.txt').read_text() == 'keep this asset'
        assert not list(folder.glob('.edit-*'))
        assert client.get(f'/api/runs/{run_id}').json()['manifest']['name'] == 'Example'
        assert client.get('/api/capabilities/edit-tool/environment').json()['key'] != before_environment
        assert client.put('/api/capabilities/edit-tool', json={'manifest': changed, 'script': "print('{}')", 'revision': source['revision']}).status_code == 409
        preflight = client.options('/api/capabilities/edit-tool', headers={'Origin': 'http://localhost:5173', 'Access-Control-Request-Method': 'PUT'})
        assert preflight.status_code == 200


def test_edit_capability_validation_repair_and_rollback(tmp_path, monkeypatch):
    from pathlib import Path
    root = tmp_path/'caps'
    folder = write_cap(root, 'edit-tool')
    with TestClient(create_app(root, tmp_path/'venvs', tmp_path/'runs.db')) as client:
        source = client.get('/api/capabilities/edit-tool/files').json()
        request = {'manifest': manifest('edit-tool'), 'script': "print('{}')", 'revision': source['revision']}
        assert client.put('/api/capabilities/edit-tool', json={**request, 'script': 'broken ('}).status_code == 422
        assert client.put('/api/capabilities/edit-tool', json={**request, 'manifest': manifest('another-id')}).status_code == 409
        assert client.put('/api/capabilities/edit-tool', json={**request, 'manifest': manifest('edit-tool', python_dependencies=['requests'])}).status_code == 422
        assert client.get('/api/capabilities/edit-tool/files').json() == source
        original_replace = Path.replace
        def fail_manifest(self, target):
            if self.name == 'after-manifest.json':
                raise OSError('Simulated write failure')
            return original_replace(self, target)
        with monkeypatch.context() as context:
            context.setattr(Path, 'replace', fail_manifest)
            assert client.put('/api/capabilities/edit-tool', json={**request, 'script': "print('new')"}).status_code == 500
        assert client.get('/api/capabilities/edit-tool/files').json() == source
        assert not list(folder.glob('.edit-*'))
        (folder/'manifest.json').write_text('{bad json', encoding='utf-8')
        (folder/'script.py').unlink()
        broken = client.get('/api/capabilities/edit-tool/files').json()
        assert broken['manifest_json'] == '{bad json' and broken['script'] == ''
        assert client.put('/api/capabilities/edit-tool', json={**request, 'revision': broken['revision']}).json()['status'] == 'READY'
        assert client.get('/api/capabilities/missing-tool/files').status_code == 404
        assert client.get('/api/capabilities/UPPER/files').status_code == 422


def test_edit_is_rejected_while_execution_is_admitted(tmp_path):
    import asyncio
    import sys
    root = tmp_path/'caps'
    write_cap(root, 'busy-tool')
    write_cap(root, 'other-tool')
    app = create_app(root, tmp_path/'venvs', tmp_path/'runs.db')
    async def delayed_environment(manifest):
        await asyncio.sleep(30)
        return sys.executable
    with TestClient(app) as client:
        app.state.environments.ensure = delayed_environment
        source = client.get('/api/capabilities/busy-tool/files').json()
        assert client.post('/api/capabilities/busy-tool/runs', json={}).status_code == 202
        assert client.put('/api/capabilities/busy-tool', json={'manifest': manifest('busy-tool'), 'script': "print('changed')", 'revision': source['revision']}).status_code == 409
        assert client.get('/api/capabilities/busy-tool/files').json() == source
        other = client.get('/api/capabilities/other-tool/files').json()
        assert client.put('/api/capabilities/other-tool', json={'manifest': manifest('other-tool'), 'script': "print('{}')", 'revision': other['revision']}).status_code == 200
