import asyncio
import json
import sys

import pytest

from app.db import RunStore
from app.executor import run_process


@pytest.mark.asyncio
async def test_timeout_crash_and_output_bound_are_independent(tmp_path):
    async def run(code, **kwargs):
        return await run_process([sys.executable, "-c", code], cwd=tmp_path, timeout=kwargs.pop("timeout", 5), **kwargs)
    timeout, crash, healthy, noisy = await asyncio.gather(
        run("import time; print('before sleep', flush=True); time.sleep(30)", timeout=0.5),
        run("1/0"), run("print('{}')"), run("print('x'*100000)", output_limit=1000),
    )
    assert timeout.timed_out and "before sleep" in timeout.stdout
    assert crash.exit_code != 0 and "ZeroDivisionError" in crash.stderr
    assert healthy.exit_code == 0 and json.loads(healthy.stdout) == {}
    assert noisy.output_exceeded and len(noisy.stdout) == 1000


def test_run_store_recovers_incomplete_runs(tmp_path):
    store = RunStore(tmp_path / "runs.db")
    run_id = store.create("example", {"n": 1}, {"version": "1.0"})
    store.update(run_id, status="running", stderr="partial diagnostic")
    store.recover()
    run = store.get(run_id)
    assert run["status"] == "interrupted"
    assert run["inputs"] == {"n": 1}
    assert run["stderr"] == "partial diagnostic"
    assert len(store.list("example")) == 1


@pytest.mark.asyncio
async def test_admission_rejects_a_manifest_edited_after_input_validation(tmp_path):
    from app.discovery import Discovery
    from app.executor import CapabilityChangedError, EnvironmentManager, Executor
    from test_discovery import manifest, write_cap
    root = tmp_path/'caps'
    folder = write_cap(root, 'edited-tool')
    discovery = Discovery(root)
    stale = discovery.get('edited-tool').manifest
    (folder/'manifest.json').write_text(json.dumps(manifest('edited-tool', name='Changed')), encoding='utf-8')
    store = RunStore(tmp_path/'runs.db')
    executor = Executor(root, EnvironmentManager(tmp_path/'venvs'), store, discovery=discovery)
    with pytest.raises(CapabilityChangedError):
        await executor.submit(stale, {})
    assert store.list() == [] and not executor.tasks
