import asyncio
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.db import RunStore, now
from app.discovery import Discovery
from app.executor import EnvironmentManager, Executor, QueueFullError
from app.main import create_app
from app.scheduler import SchedulerService, SchedulerError, compute_next_run
from app.schemas import ScheduleCreate, ScheduleUpdate
from test_api import wait_for_run
from test_discovery import manifest, write_cap

UTC = timezone.utc
POINT = datetime(2026, 11, 12, 8, 17, 32, tzinfo=UTC)

@pytest.mark.parametrize('kind,expression,expected', [
    ('interval', '30', '2026-11-12T08:18:02+00:00'),
    ('cron', '*/15 * * * *', '2026-11-12T08:30:00+00:00'),
    ('cron', '0 9 * * *', '2026-11-12T09:00:00+00:00'),
    ('cron', '1,3,5 10-12 * * 1-5', '2026-11-12T10:01:00+00:00'),
    ('cron', '0 0 29 2 *', '2028-02-29T00:00:00+00:00'),
    ('cron', '0 0 * * 7', '2026-11-15T00:00:00+00:00'),
    ('cron', '0 0 31 2 1', '2027-02-01T00:00:00+00:00'),
])
def test_next_occurrence(kind, expression, expected):
    assert compute_next_run(kind, expression, POINT).isoformat() == expected
    exact = datetime(2026, 11, 12, 9, tzinfo=UTC)
    assert compute_next_run('cron', '0 9 * * *', exact) == exact + timedelta(days=1)

@pytest.mark.parametrize('kind,expression', [
    ('interval', '9'), ('interval', '0'), ('interval', '-10'), ('interval', '10.5'),
    ('cron', '* * * *'), ('cron', '60 * * * *'), ('cron', '*/0 * * * *'),
    ('cron', '0 24 * * *'), ('cron', '0 0 0 * *'), ('cron', '0 0 * 13 *'),
    ('cron', '0 0 * * 8'), ('cron', '5-2 * * * *'), ('cron', '1,,2 * * * *'),
    ('cron', '0 0 31 2 *'), ('cron', '@daily'), ('invalid', '30'),
])
def test_invalid_expressions(kind, expression):
    with pytest.raises(ValueError):
        compute_next_run(kind, expression, POINT)


def test_interval_test_override_and_timezone():
    assert compute_next_run('interval', '1', POINT, min_interval=1) == POINT + timedelta(seconds=1)
    local = POINT.astimezone(timezone(timedelta(hours=3)))
    assert compute_next_run('cron', '0 9 * * *', local).hour == 9
    assert compute_next_run('interval', '10', POINT.replace(tzinfo=None)).tzinfo == UTC


def test_api_lifecycle_trigger_validation_and_restart(tmp_path):
    root = tmp_path / 'caps'
    data = manifest('scheduled-tool', input_schema={'type': 'object', 'additionalProperties': False, 'properties': {'n': {'type': 'integer', 'minimum': 1, 'default': 2}}, 'required': ['n']})
    write_cap(root, 'scheduled-tool', data, script="import json,sys; print(json.dumps(json.load(sys.stdin)))")
    db = tmp_path / 'runs.db'
    def app():
        return create_app(root, tmp_path / 'venvs', db, scheduler_poll_interval=.05, scheduler_min_interval=1)
    payload = dict(capability_id='scheduled-tool', name='Saved job', schedule_type='interval', expression='60', parameters={})
    with TestClient(app()) as client:
        for changed in [{'expression': '0'}, {'parameters': {'n': 0}}, {'capability_id': 'missing'}, {'parameters': {'extra': 1}}]:
            assert client.post('/api/schedules', json={**payload, **changed}).status_code in (409, 422)
        response = client.post('/api/schedules', json=payload)
        assert response.status_code == 201, response.text
        schedule = response.json()
        sid = schedule['id']
        assert schedule['parameters'] == {'n': 2}
        assert client.get('/api/schedules?capability_id=other').json() == []
        assert len(client.get('/api/schedules?capability_id=scheduled-tool').json()) == 1
        paused = client.patch(f'/api/schedules/{sid}', json={'enabled': False}).json()
        assert paused['next_run_at'] is None
        run = client.post(f'/api/schedules/{sid}/trigger').json()
        assert run['trigger_type'] == 'scheduled' and run['schedule_id'] == sid
        assert wait_for_run(client, run['id'])['result'] == {'n': 2}
        assert client.get('/api/runs').json()[0]['trigger_type'] == 'scheduled'
        assert client.get('/api/schedules').json()[0]['enabled'] is False
        updated = client.patch(f'/api/schedules/{sid}', json={'name': 'Daily', 'schedule_type': 'cron', 'expression': '0 9 * * *', 'parameters': {'n': 3}, 'enabled': True}).json()
        assert updated['parameters'] == {'n': 3} and updated['next_run_at'] and updated['consecutive_failures'] == 0
        for patch in [{'parameters': {'n': 0}}, {'expression': 'bad'}, {'enabled': None}, {}, {'capability_id': 'other'}]:
            assert client.patch(f'/api/schedules/{sid}', json=patch).status_code == 422
    with TestClient(app()) as client:
        assert client.get('/api/schedules').json()[0]['name'] == 'Daily'
        assert client.delete(f'/api/schedules/{sid}').status_code == 204
        assert client.delete(f'/api/schedules/{sid}').status_code == 404
        assert client.patch(f'/api/schedules/{sid}', json={'enabled': True}).status_code == 404
        assert client.get('/api/runs').json()[0]['schedule_id'] == sid


async def setup_service(tmp_path):
    root = tmp_path / 'caps'
    for slug, code in [('healthy', "print('{}')"), ('crash', '1/0'), ('slow', "import time;time.sleep(.3);print('{}')"), ('timeout', 'import time;time.sleep(5)')]:
        write_cap(root, slug, manifest(slug, timeout_seconds=1), code)
    store = RunStore(tmp_path / 'runs.db')
    environments = EnvironmentManager(tmp_path / 'venvs')
    async def interpreter(_):
        return sys.executable
    environments.ensure = interpreter
    executor = Executor(root, environments, store)
    service = SchedulerService(store, Discovery(root), executor, poll_interval=.02, min_interval=1)
    return store, executor, service

async def finish(service):
    while service._watchers:
        await asyncio.gather(*list(service._watchers))

async def due(store, service, capability_id):
    job = await service.create(ScheduleCreate(capability_id=capability_id, name=capability_id, schedule_type='interval', expression='1'))
    store.update_schedule(job['id'], next_run_at=(datetime.now(UTC)-timedelta(seconds=1)).isoformat())
    return job['id']

@pytest.mark.asyncio
async def test_tick_isolation_breaker_overlap_and_resume(tmp_path):
    store, executor, service = await setup_service(tmp_path)
    healthy, crash, slow, timeout = [await due(store, service, slug) for slug in ['healthy', 'crash', 'slow', 'timeout']]
    gate = asyncio.Event()
    original_ensure = executor.environments.ensure
    async def guarded_ensure(manifest):
        if manifest.id == 'slow':
            await gate.wait()
        return await original_ensure(manifest)
    executor.environments.ensure = guarded_ensure
    try:
        await asyncio.gather(service.tick(), service.tick())
        with pytest.raises(SchedulerError) as error:
            await service.trigger(slow)
        assert error.value.status == 409
        store.update_schedule(slow, next_run_at=(datetime.now(UTC)-timedelta(seconds=1)).isoformat())
        await service.tick()
        assert len(store.list('slow')) == 1
        gate.set()
        await finish(service)
        assert store.schedule(healthy)['last_status'] == 'COMPLETED'
        assert store.schedule(timeout)['last_status'] == 'TIMED_OUT'
        assert store.schedule(crash)['consecutive_failures'] == 1
        for _ in range(4):
            await service.trigger(crash)
            await finish(service)
        broken = store.schedule(crash)
        assert broken['consecutive_failures'] == 5 and broken['enabled'] is False and broken['next_run_at'] is None
        resumed = await service.update(crash, ScheduleUpdate(enabled=True))
        assert resumed['consecutive_failures'] == 0 and resumed['next_run_at']
        # A missing/invalid capability records its own failure without blocking healthy jobs.
        (tmp_path/'caps'/'crash'/'script.py').unlink()
        store.update_schedule(crash, next_run_at=(datetime.now(UTC)-timedelta(seconds=1)).isoformat())
        await service.tick()
        assert store.schedule(crash)['last_status'] == 'INVALID_CAPABILITY'
        assert store.schedule(crash)['last_error']
        await finish(service)
        await service.trigger(healthy)
        await finish(service)
        assert store.schedule(healthy)['consecutive_failures'] == 0
    finally:
        await service.stop()
        await executor.close()

@pytest.mark.asyncio
async def test_background_loop_stop_and_recovery(tmp_path):
    store, executor, service = await setup_service(tmp_path)
    sid = await due(store, service, 'healthy')
    await service.start()
    for _ in range(100):
        if store.schedule(sid)['last_status'] == 'COMPLETED':
            break
        await asyncio.sleep(.02)
    assert store.schedule(sid)['last_status'] == 'COMPLETED'
    await service.stop()
    await executor.close()
    assert service._loop_task is None and not service._watchers
    store.update_schedule(sid, last_status='RUNNING', last_run_id=None, last_run_at=now(), consecutive_failures=4)
    store.recover_schedules()
    assert store.schedule(sid)['enabled'] is False


def test_legacy_database_migration(tmp_path):
    path = tmp_path/'runs.db'
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE runs (id TEXT PRIMARY KEY, capability_id TEXT, status TEXT, created_at TEXT, started_at TEXT, finished_at TEXT, duration_ms INTEGER, inputs TEXT, manifest TEXT, result TEXT, stdout TEXT, stderr TEXT, error TEXT, exit_code INTEGER, environment TEXT)")
    db.execute("INSERT INTO runs (id,capability_id,status,created_at,inputs,manifest) VALUES ('old','tool','succeeded',?,'{}','{}')", (now(),))
    db.commit(); db.close()
    store = RunStore(path)
    RunStore(path)  # idempotent migration
    assert store.get('old')['trigger_type'] == 'manual' and store.get('old')['schedule_id'] is None
    assert store.schedules() == []


@pytest.mark.asyncio
async def test_pause_and_delete_while_running_preserve_audit(tmp_path):
    store, executor, service = await setup_service(tmp_path)
    sid = await due(store, service, 'slow')
    run = await service.trigger(sid)
    await service.update(sid, ScheduleUpdate(enabled=False))
    assert store.schedule(sid)['next_run_at'] is None
    await service.delete(sid)
    await finish(service)
    assert store.schedule(sid) is None
    assert store.get(run['id'])['schedule_id'] == sid
    assert store.get(run['id'])['status'] == 'succeeded'
    await service.stop(); await executor.close()


@pytest.mark.asyncio
async def test_queue_backpressure_does_not_trip_breaker_or_shift_manual_cadence(tmp_path):
    store, executor, service = await setup_service(tmp_path)
    sid = await due(store, service, 'healthy')
    async def full(*args, **kwargs):
        raise QueueFullError('Run queue is full; retry shortly')
    executor.submit = full
    store.update_schedule(sid, last_error='Previous diagnostic')
    await service.tick()
    job = store.schedule(sid)
    assert job['consecutive_failures'] == 0 and job['last_status'] is None
    assert job['last_error'] == 'Previous diagnostic'
    with pytest.raises(SchedulerError) as error:
        await service.trigger(sid)
    assert error.value.status == 429
    assert store.schedule(sid)['next_run_at'] == job['next_run_at']
    await service.stop(); await executor.close()


@pytest.mark.asyncio
async def test_tick_reconciles_a_completed_run_after_observer_loss(tmp_path):
    store, executor, service = await setup_service(tmp_path)
    sid = await due(store, service, 'slow')
    run = await service.trigger(sid)
    store.update_schedule(sid, next_run_at=(datetime.now(UTC)+timedelta(hours=1)).isoformat())
    for task in list(service._watchers):
        task.cancel()
    await asyncio.gather(*list(service._watchers), return_exceptions=True)
    await executor.wait(run['id'])
    await service.tick()
    assert store.schedule(sid)['last_status'] == 'COMPLETED'
    await service.stop(); await executor.close()
