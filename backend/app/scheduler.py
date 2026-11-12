"""UTC schedules for a single-process host; no cron library or broker required."""
import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone

from jsonschema import Draft202012Validator

from .schemas import ScheduleCreate
from .executor import CapabilityChangedError, QueueFullError

log = logging.getLogger(__name__)
UTC = timezone.utc


def utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _field(expression: str, low: int, high: int) -> set[int]:
    values = set()
    for part in expression.split(','):
        match = re.fullmatch(r'(\*|[0-9]+(?:-[0-9]+)?)(?:/([0-9]+))?', part)
        if not match:
            raise ValueError(f"Invalid cron field: {expression!r}; use *, */n, lists or ranges")
        base, step_text = match.groups()
        step = int(step_text) if step_text else 1
        if step < 1:
            raise ValueError("Cron steps must be positive")
        if base == '*':
            start, end = low, high
        elif '-' in base:
            start, end = map(int, base.split('-'))
        else:
            start = end = int(base)
            if step_text:
                raise ValueError("Cron steps require * or a range")
        if not low <= start <= end <= high:
            raise ValueError(f"Cron field {expression!r} must be between {low} and {high} with ascending ranges")
        values.update(range(start, end + 1, step))
    return values


def compute_next_run(schedule_type: str, expression: str, from_time: datetime, *, min_interval: int = 10) -> datetime:
    """Return the next strictly later UTC occurrence. Naive input is interpreted as UTC.

    Day-of-month and day-of-week use cron's OR rule when both are restricted.
    The bounded day search covers leap-day schedules without minute-by-minute scans.
    """
    point = utc(from_time)
    if schedule_type == 'interval':
        if not re.fullmatch(r'[0-9]+', expression.strip()):
            raise ValueError("Interval must be a whole number of seconds")
        seconds = int(expression)
        if seconds < min_interval:
            raise ValueError(f"Interval must be at least {min_interval} seconds")
        try:
            return point + timedelta(seconds=seconds)
        except OverflowError as error:
            raise ValueError("Interval exceeds the supported datetime range") from error
    if schedule_type != 'cron':
        raise ValueError("Schedule type must be interval or cron")
    parts = expression.split()
    if len(parts) != 5:
        raise ValueError("Cron requires 5 fields: minute hour day_of_month month day_of_week (UTC)")
    minute, hour, dom, month, dow = [_field(part, *bounds) for part, bounds in zip(parts, [(0,59),(0,23),(1,31),(1,12),(0,7)])]
    dow = {day % 7 for day in dow}
    day = point.replace(hour=0, minute=0, second=0, microsecond=0)
    for _ in range(366 * 8):
        week_matches = (day.weekday() + 1) % 7 in dow
        date_matches = day.day in dom
        matches = (date_matches or week_matches) if parts[2] != '*' and parts[4] != '*' else (date_matches and week_matches)
        if day.month in month and matches:
            for h in sorted(hour):
                for m in sorted(minute):
                    candidate = day.replace(hour=h, minute=m)
                    if candidate > point:
                        return candidate
        try:
            day += timedelta(days=1)
        except OverflowError:
            break
    raise ValueError("Cron has no valid occurrence within the next 8 years")


class SchedulerError(Exception):
    def __init__(self, status: int, detail):
        self.status, self.detail = status, detail
        super().__init__(str(detail))


class SchedulerService:
    def __init__(self, store, discovery, executor, *, poll_interval: float = 1.0, min_interval: int = 10):
        if poll_interval <= 0 or min_interval < 1:
            raise ValueError("Scheduler poll interval and minimum interval must be positive")
        self.store, self.discovery, self.executor = store, discovery, executor
        self.poll_interval, self.min_interval = poll_interval, min_interval
        self._lock = asyncio.Lock()
        self._loop_task = None
        self._watchers: set[asyncio.Task] = set()
        self._stopping = False
        self._wake = asyncio.Event()

    def next_run(self, kind, expression, point):
        return compute_next_run(kind, expression, point, min_interval=self.min_interval).isoformat()

    async def start(self):
        if self._loop_task is None:
            self._stopping = False
            self._wake.clear()
            self._loop_task = asyncio.create_task(self._loop(), name='capability-scheduler')

    async def stop(self):
        self._stopping = True
        self._wake.set()
        if self._loop_task:
            await self._loop_task
        # Let an admitted trigger finish linking its run before cancelling observers.
        async with self._lock:
            pass
        tasks = list(self._watchers)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._watchers.clear()
        self._loop_task = None

    async def _loop(self):
        while not self._stopping:
            try:
                await self.tick()
            except Exception:
                log.exception("Scheduler tick failed; retrying on next poll")
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=self.poll_interval)
            except asyncio.TimeoutError:
                pass

    async def validate_target(self, capability_id, parameters):
        try:
            cap = await asyncio.to_thread(self.discovery.get, capability_id)
        except Exception as error:
            raise SchedulerError(409, f"Capability registry unavailable: {error}") from error
        if cap is None or cap.status != 'READY' or not cap.manifest:
            raise SchedulerError(409, "Capability is missing or INVALID; repair it before scheduling")
        inputs = dict(parameters)
        for key, field in cap.manifest.input_schema.get('properties', {}).items():
            if isinstance(field, dict) and key not in inputs and 'default' in field:
                inputs[key] = field['default']
        errors = [{"field": '.'.join(map(str, error.path)) or 'parameters', "message": error.message}
                  for error in Draft202012Validator(cap.manifest.input_schema).iter_errors(inputs)]
        if errors:
            raise SchedulerError(422, errors[:30])
        return cap.manifest, inputs

    async def create(self, request):
        async with self._lock:
            _, inputs = await self.validate_target(request.capability_id, request.parameters)
            try:
                next_at = self.next_run(request.schedule_type, request.expression, datetime.now(UTC))
            except ValueError as error:
                raise SchedulerError(422, str(error)) from error
            values = request.model_dump()
            values.update(parameters=inputs, next_run_at=next_at if request.enabled else None)
            return await asyncio.to_thread(self.store.create_schedule, values)

    async def update(self, schedule_id, request):
        async with self._lock:
            previous = await self.get(schedule_id)
            patch = request.model_dump(exclude_unset=True)
            merged = ScheduleCreate.model_validate({**{key: previous[key] for key in ScheduleCreate.model_fields}, **patch})
            if patch != {'enabled': False}:
                _, inputs = await self.validate_target(merged.capability_id, merged.parameters)
                if 'parameters' in patch:
                    patch['parameters'] = inputs
            try:
                next_at = self.next_run(merged.schedule_type, merged.expression, datetime.now(UTC))
            except ValueError as error:
                raise SchedulerError(422, str(error)) from error
            if not merged.enabled:
                patch['next_run_at'] = None
            elif patch.get('enabled') is True or {'schedule_type', 'expression'} & patch.keys():
                patch['next_run_at'] = next_at
            if patch.get('enabled') is True:
                patch['consecutive_failures'] = 0
            return await asyncio.to_thread(self.store.update_schedule, schedule_id, **patch)

    async def get(self, schedule_id):
        record = await asyncio.to_thread(self.store.schedule, schedule_id)
        if record is None:
            raise SchedulerError(404, 'Schedule not found')
        return record

    async def delete(self, schedule_id):
        async with self._lock:
            if not await asyncio.to_thread(self.store.delete_schedule, schedule_id):
                raise SchedulerError(404, 'Schedule not found')

    async def trigger(self, schedule_id):
        async with self._lock:
            if self._stopping:
                raise SchedulerError(503, 'Scheduler is stopping')
            schedule = await self.get(schedule_id)
            return await self._launch(schedule, datetime.now(UTC), manual=True)

    async def tick(self, at=None):
        async with self._lock:
            if self._stopping:
                return
            await asyncio.to_thread(self.store.recover_schedules, False)
            point = utc(at or datetime.now(UTC))
            schedules = await asyncio.to_thread(self.store.schedules, due_at=point.isoformat())
            for schedule in schedules:
                if self._stopping:
                    break
                if len(self._watchers) >= 32:
                    break
                try:
                    await self._launch(schedule, point)
                except SchedulerError:
                    # The per-schedule outcome is already recorded; continue the batch.
                    pass
                except Exception:
                    log.exception("Could not dispatch schedule %s", schedule['id'])

    async def _launch(self, schedule, point, manual=False):
        try:
            next_at = schedule['next_run_at'] if manual else self.next_run(schedule['schedule_type'], schedule['expression'], point)
        except ValueError as error:
            await asyncio.to_thread(self.store.update_schedule, schedule['id'], enabled=False, next_run_at=None, last_error=str(error))
            raise SchedulerError(422, str(error)) from error
        claimed = await asyncio.to_thread(self.store.claim_schedule, schedule['id'], point.isoformat(), next_at, manual)
        if claimed is None:
            if not manual and schedule['last_status'] == 'RUNNING':
                await asyncio.to_thread(self.store.advance_running_schedule, schedule['id'], next_at)
            raise SchedulerError(409, 'Schedule is already running or no longer due')
        try:
            manifest, inputs = await self.validate_target(schedule['capability_id'], schedule['parameters'])
        except SchedulerError as error:
            await asyncio.to_thread(self.store.finish_schedule, schedule['id'], 'INVALID_CAPABILITY', str(error))
            raise
        try:
            run_id = await self.executor.submit(manifest, inputs, trigger_type='scheduled', schedule_id=schedule['id'])
        except CapabilityChangedError as error:
            await asyncio.to_thread(self.store.finish_schedule, schedule['id'], 'INVALID_CAPABILITY', str(error))
            raise SchedulerError(409, str(error)) from error
        except QueueFullError as error:
            # Saturation is backpressure, not a failure of the capability.
            await asyncio.to_thread(self.store.update_schedule, schedule['id'], last_status=schedule['last_status'], last_run_id=schedule['last_run_id'], last_run_at=schedule['last_run_at'], last_error=schedule['last_error'], next_run_at=schedule['next_run_at'] if manual else (point+timedelta(seconds=self.poll_interval)).isoformat() if schedule['enabled'] else None)
            raise SchedulerError(429, str(error)) from error
        except Exception as error:
            await asyncio.to_thread(self.store.finish_schedule, schedule['id'], 'FAILED', str(error)[:8000])
            raise SchedulerError(500, 'Could not dispatch scheduled execution') from error
        await asyncio.to_thread(self.store.update_schedule, schedule['id'], last_run_id=run_id)
        watcher = asyncio.create_task(self._watch(schedule['id'], run_id), name=f"schedule-{schedule['id']}")
        self._watchers.add(watcher)
        watcher.add_done_callback(self._watchers.discard)
        return await asyncio.to_thread(self.store.get, run_id)

    async def _watch(self, schedule_id, run_id):
        try:
            run = await self.executor.wait(run_id)
            status = 'COMPLETED' if run['status'] == 'succeeded' else 'TIMED_OUT' if run['status'] == 'timed_out' else 'FAILED'
            await asyncio.to_thread(self.store.finish_schedule, schedule_id, status, run['error'])
        except asyncio.CancelledError:
            raise
        except Exception as error:
            log.exception('Scheduled execution observer failed')
            await asyncio.to_thread(self.store.finish_schedule, schedule_id, 'FAILED', str(error)[:8000])
