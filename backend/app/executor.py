"""Replaceable subprocess adapter; venvs isolate packages, not hostile code."""

import asyncio
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from .db import RunStore, now
from .discovery import Discovery
from .schemas import Manifest

OUTPUT_LIMIT = 512_000  # per stream; capture bytes before decoding


@dataclass
class ProcessResult:
    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool = False
    output_exceeded: bool = False


def child_environment() -> dict[str, str]:
    # Do not accidentally forward API secrets or PYTHONPATH into capabilities.
    allowed = {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE",
               "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "PIP_CERT"}
    env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    env.update(PYTHONUTF8="1", PYTHONUNBUFFERED="1", PIP_DISABLE_PIP_VERSION_CHECK="1", PIP_NO_CACHE_DIR="1")
    return env


async def terminate_tree(process: asyncio.subprocess.Process) -> None:
    if os.name == "nt":
        if process.returncode is None:
            killer = await asyncio.create_subprocess_exec(
                "taskkill", "/PID", str(process.pid), "/T", "/F",
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            await killer.wait()
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    await process.wait()


async def run_process(command: list[str], *, cwd: Path, timeout: float, payload: bytes | None = None,
                      output_limit: int = OUTPUT_LIMIT) -> ProcessResult:
    options = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}
    process = await asyncio.create_subprocess_exec(
        *command, cwd=cwd, env=child_environment(), stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, **options,
    )
    output, errors = bytearray(), bytearray()
    exceeded = asyncio.Event()

    async def drain(stream: asyncio.StreamReader, target: bytearray) -> None:
        while chunk := await stream.read(16_384):
            available = output_limit - len(target)
            target.extend(chunk[:available])
            if len(chunk) > available:
                exceeded.set()
                # Continue draining while termination closes pipes; never deadlock wait().

    async def feed() -> None:
        try:
            if payload:
                process.stdin.write(payload)
                await process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            process.stdin.close()

    tasks = [asyncio.create_task(drain(process.stdout, output)),
             asyncio.create_task(drain(process.stderr, errors)), asyncio.create_task(feed()),
             asyncio.create_task(process.wait())]
    completion = asyncio.gather(*tasks)
    overflow = asyncio.create_task(exceeded.wait())
    timed_out = False
    try:
        done, _ = await asyncio.wait([completion, overflow], timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        if not done or overflow in done:
            timed_out = not done
            await terminate_tree(process)
            await completion
        else:
            await completion
    except BaseException:
        await terminate_tree(process)
        raise
    finally:
        overflow.cancel()
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, overflow, return_exceptions=True)
        if not completion.done():
            completion.cancel()
        await asyncio.gather(completion, return_exceptions=True)
    return ProcessResult(process.returncode, output.decode("utf-8", errors="replace"),
                         errors.decode("utf-8", errors="replace"), timed_out, exceeded.is_set())


class EnvironmentError(RuntimeError):
    pass


class EnvironmentManager:
    def __init__(self, root: Path, provisioning_timeout: int = 180):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.provisioning_timeout = provisioning_timeout
        self.locks: dict[str, asyncio.Lock] = {}
        self.build_slots = asyncio.Semaphore(2)

    def key(self, manifest: Manifest) -> str:
        fingerprint = json.dumps([sys.version, sys.executable, sorted(manifest.python_dependencies)])
        return f"{manifest.id}-{hashlib.sha256(fingerprint.encode()).hexdigest()[:16]}"

    def interpreter(self, folder: Path) -> Path:
        return folder / ("Scripts/python.exe" if os.name == "nt" else "bin/python")

    def status(self, manifest: Manifest) -> dict:
        key = self.key(manifest)
        folder = self.root / key
        ready = (folder / ".ready").is_file() and self.interpreter(folder).is_file()
        return {"key": key, "status": "ready" if ready else "cold", "dependencies": manifest.python_dependencies}

    async def ensure(self, manifest: Manifest) -> Path:
        key = self.key(manifest)
        async with self.locks.setdefault(key, asyncio.Lock()):
            folder = self.root / key
            if self.status(manifest)["status"] == "ready":
                return self.interpreter(folder)
            async with self.build_slots:
                # A failed install never receives a readiness marker; retries rebuild it.
                if folder.is_symlink() or folder.resolve().parent != self.root:
                    raise EnvironmentError("Unsafe environment cache path")
                start = time.monotonic()
                result = await run_process([sys.executable, "-m", "venv", "--clear", str(folder)],
                                           cwd=self.root, timeout=self.provisioning_timeout)
                self.check(result, "Virtual environment creation")
                python = self.interpreter(folder)
                if manifest.python_dependencies:
                    remaining = max(1, self.provisioning_timeout - (time.monotonic() - start))
                    result = await run_process([str(python), "-m", "pip", "install", "--no-input", "--", *manifest.python_dependencies],
                                               cwd=folder, timeout=remaining)
                    self.check(result, "Dependency installation")
                (folder / ".ready").write_text(json.dumps({"dependencies": manifest.python_dependencies}), encoding="utf-8")
                return python

    @staticmethod
    def check(result: ProcessResult, action: str) -> None:
        if result.timed_out or result.output_exceeded or result.exit_code != 0:
            reason = "timed out" if result.timed_out else "exceeded output limit" if result.output_exceeded else "failed"
            raise EnvironmentError(f"{action} {reason}.\n{result.stderr[-4000:]}\n{result.stdout[-2000:]}")


class QueueFullError(RuntimeError):
    pass


class CapabilityChangedError(ValueError):
    pass


class Executor:
    def __init__(self, capabilities: Path, environments: EnvironmentManager, store: RunStore, concurrency: int = 4, discovery=None):
        self.capabilities = capabilities.resolve()
        self.discovery = discovery or Discovery(self.capabilities)
        self.environments = environments
        self.store = store
        self.slots = asyncio.Semaphore(concurrency)
        self.tasks: set[asyncio.Task] = set()
        self.admission = asyncio.Lock()
        self.run_tasks: dict[str, asyncio.Task] = {}
        self.run_capabilities: dict[str, str] = {}

    async def submit(self, manifest: Manifest, inputs: dict, *, trigger_type: str = "manual", schedule_id: str | None = None) -> str:
        async with self.admission:
            current = await asyncio.to_thread(self.discovery.get, manifest.id)
            if current is None or current.status != 'READY' or current.manifest != manifest:
                raise CapabilityChangedError('Capability changed before execution; reload its inputs and retry')
            if len(self.tasks) >= 32:
                raise QueueFullError("Run queue is full; retry shortly")
            run_id = await asyncio.to_thread(self.store.create, manifest.id, inputs, manifest.model_dump(), trigger_type, schedule_id)
            task = asyncio.create_task(self.execute(run_id, manifest.model_copy(deep=True), inputs))
            self.tasks.add(task)
            self.run_tasks[run_id] = task
            self.run_capabilities[run_id] = manifest.id
            task.add_done_callback(lambda _: self.run_capabilities.pop(run_id, None))
            task.add_done_callback(lambda _: self.run_tasks.pop(run_id, None))
            task.add_done_callback(self.tasks.discard)
            return run_id

    async def wait(self, run_id: str) -> dict:
        task = self.run_tasks.get(run_id)
        if task:
            await asyncio.shield(task)
        return await asyncio.to_thread(self.store.get, run_id)

    async def execute(self, run_id: str, manifest: Manifest, inputs: dict) -> None:
        started = time.monotonic()
        async def update(**values):
            await asyncio.to_thread(self.store.update, run_id, **values)
        try:
            async with self.slots:
                await update(status="preparing", started_at=now(), environment=self.environments.key(manifest))
                python = await self.environments.ensure(manifest)
                folder = self.capabilities / manifest.id
                script = folder / "script.py"
                if folder.is_symlink() or script.is_symlink() or folder.resolve().parent != self.capabilities:
                    raise ValueError("Unsafe capability script path")
                await update(status="running")
                result = await run_process([str(python), "-I", str(script)], cwd=folder,
                                           timeout=manifest.timeout_seconds,
                                           payload=json.dumps(inputs, allow_nan=False).encode("utf-8"))
                values = dict(stdout=result.stdout, stderr=result.stderr, exit_code=result.exit_code)
                if result.timed_out:
                    values.update(status="timed_out", error=f"Execution exceeded {manifest.timeout_seconds}s; process terminated")
                elif result.output_exceeded:
                    values.update(status="failed", error=f"Output exceeded {OUTPUT_LIMIT} bytes per stream; process terminated")
                elif result.exit_code:
                    values.update(status="failed", error=f"Script exited with code {result.exit_code}")
                else:
                    try:
                        parsed = json.loads(result.stdout, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(f"Non-finite JSON: {x}")))
                        values.update(status="succeeded", result=parsed)
                    except (ValueError, RecursionError) as error:
                        values.update(status="failed", error=f"stdout must contain one JSON value: {error}")
                await update(**values)
        except asyncio.CancelledError:
            await update(status="interrupted", error="API shutting down; execution cancelled")
            raise
        except Exception as error:
            await update(status="failed", error=str(error)[:8000])
        finally:
            await update(finished_at=now(), duration_ms=round((time.monotonic() - started) * 1000))

    async def close(self) -> None:
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
