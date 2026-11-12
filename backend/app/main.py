"""Single-worker local host with an asynchronous, bounded execution queue."""

import ast
import asyncio
import json
import os
import shutil
import tempfile
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from jsonschema import Draft202012Validator

from .db import RunStore
from .discovery import Discovery
from .executor import CapabilityChangedError, EnvironmentManager, Executor
from .capability_files import CapabilityFileError, CapabilityFiles
from .schemas import CapabilitySources, CapabilityUpdate, CategoryUpdate, ExecutionRecord, Registration, RunRequest, ScheduleCreate, ScheduleUpdate, ScheduleRecord
from .scheduler import SchedulerError, SchedulerService

BACKEND = Path(__file__).resolve().parents[1]


class BodyLimitMiddleware:
    """Bound even chunked requests before JSON parsing or validation."""
    def __init__(self, app, limit: int = 512_000):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in {"POST", "PUT", "PATCH"}:
            return await self.app(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > self.limit:
                return await JSONResponse({"detail": "Request exceeds 512 KB"}, status_code=413)(scope, receive, send)
            if not message.get("more_body", False):
                break
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()
        await self.app(scope, replay, send)


def create_app(capabilities_dir: Path | None = None, environments_dir: Path | None = None,
               database_path: Path | None = None, *, scheduler_poll_interval: float = 1.0,
               scheduler_min_interval: int = 10) -> FastAPI:
    capabilities_dir = capabilities_dir or Path(os.environ.get("CAPABILITIES_DIR", BACKEND / "capabilities"))
    environments_dir = environments_dir or Path(os.environ.get("ENVIRONMENTS_DIR", BACKEND / ".venvs"))
    database_path = database_path or Path(os.environ.get("DATA_DIR", BACKEND / "data")) / "runs.db"

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.discovery = await asyncio.to_thread(Discovery, capabilities_dir, registration_lock)
        app.state.store = await asyncio.to_thread(RunStore, database_path)
        await asyncio.to_thread(app.state.store.recover)
        app.state.environments = await asyncio.to_thread(EnvironmentManager, environments_dir)
        app.state.executor = Executor(capabilities_dir, app.state.environments, app.state.store, discovery=app.state.discovery)
        await asyncio.to_thread(app.state.store.recover_schedules)
        app.state.scheduler = SchedulerService(app.state.store, app.state.discovery, app.state.executor,
                                               poll_interval=scheduler_poll_interval, min_interval=scheduler_min_interval)
        await app.state.scheduler.start()
        try:
            yield
        finally:
            await app.state.scheduler.stop()
            await app.state.executor.close()
            await asyncio.to_thread(app.state.store.recover_schedules)

    app = FastAPI(title="Capability Launcher", version="1.0.0", lifespan=lifespan)
    app.add_middleware(BodyLimitMiddleware)
    app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                       allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"], allow_headers=["Content-Type"])
    registration_lock = threading.RLock()

    async def capability(slug: str):
        cap = await asyncio.to_thread(app.state.discovery.get, slug)
        if cap is None:
            raise HTTPException(404, "Capability not found")
        return cap

    @app.exception_handler(CapabilityFileError)
    async def capability_file_error(request, error: CapabilityFileError):
        return JSONResponse({"detail": error.detail}, status_code=error.status)

    @app.exception_handler(SchedulerError)
    async def scheduler_error(request, error: SchedulerError):
        return JSONResponse({"detail": error.detail}, status_code=error.status)

    @app.get("/api/schedules", response_model=list[ScheduleRecord])
    async def schedules(capability_id: str | None = None):
        return await asyncio.to_thread(app.state.store.schedules, capability_id)

    @app.post("/api/schedules", response_model=ScheduleRecord, status_code=201)
    async def create_schedule(request: ScheduleCreate):
        return await app.state.scheduler.create(request)

    @app.patch("/api/schedules/{schedule_id}", response_model=ScheduleRecord)
    async def update_schedule(schedule_id: str, request: ScheduleUpdate):
        return await app.state.scheduler.update(schedule_id, request)

    @app.post("/api/schedules/{schedule_id}/trigger", response_model=ExecutionRecord)
    async def trigger_schedule(schedule_id: str):
        return await app.state.scheduler.trigger(schedule_id)

    @app.delete("/api/schedules/{schedule_id}", status_code=204)
    async def delete_schedule(schedule_id: str):
        await app.state.scheduler.delete(schedule_id)
        return Response(status_code=204)

    @app.get("/api/health")
    async def health():
        return {"status": "ok", "active_runs": len(app.state.executor.tasks), "execution_limit": 4}

    @app.get("/api/capabilities")
    async def capabilities():
        return await asyncio.to_thread(app.state.discovery.scan)

    @app.get("/api/capabilities/{slug}")
    async def get_capability(slug: str):
        return await capability(slug)

    @app.get("/api/capabilities/{slug}/files", response_model=CapabilitySources)
    def capability_files(slug: str):
        return CapabilityFiles(app.state.discovery).read(slug)

    @app.put("/api/capabilities/{slug}")
    async def edit_capability(slug: str, request: CapabilityUpdate):
        try:
            ast.parse(request.script)
        except (SyntaxError, ValueError, RecursionError) as error:
            raise HTTPException(422, f"Invalid Python source: {error}") from error
        async with app.state.executor.admission:
            if slug in app.state.executor.run_capabilities.values():
                raise HTTPException(409, "Capability has queued or running executions. Pause its schedules and wait for completion before saving.")
            return await asyncio.to_thread(CapabilityFiles(app.state.discovery).write, slug, request)

    @app.patch("/api/capabilities/{slug}/category")
    def update_category(slug: str, request: CategoryUpdate):
        with registration_lock:
            cap = app.state.discovery.get(slug)
            if cap is None:
                raise HTTPException(404, "Capability not found")
            if not cap.manifest or cap.status != "READY":
                raise HTTPException(409, "Fix this capability's manifest first")
            source = app.state.discovery.root / cap.id / "manifest.json"
            # Preserve every other manifest field and publish a complete JSON file atomically.
            temporary = None
            try:
                data = json.loads(source.read_text(encoding="utf-8"))
                data["category"] = request.category
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix=".category-", suffix=".json", dir=source.parent, delete=False) as handle:
                    temporary = Path(handle.name)
                    json.dump(data, handle, indent=2, ensure_ascii=False)
                    handle.write("\n")
                temporary.replace(source)
            except OSError as error:
                raise HTTPException(500, "Could not save category; check registry write permissions") from error
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
            return app.state.discovery.get(slug)

    @app.get("/api/capabilities/{slug}/environment")
    async def environment(slug: str):
        cap = await capability(slug)
        if not cap.manifest or cap.status != "READY":
            raise HTTPException(409, "Fix this capability's manifest first")
        return await asyncio.to_thread(app.state.environments.status, cap.manifest)

    @app.post("/api/capabilities/{slug}/runs", status_code=202)
    async def execute(slug: str, request: RunRequest):
        cap = await capability(slug)
        if cap.status != "READY" or not cap.manifest:
            raise HTTPException(409, {"message": "Capability is invalid", "diagnostics": cap.diagnostics})
        schema = cap.manifest.input_schema
        inputs = dict(request.inputs)
        for key, field in schema.get("properties", {}).items():
            if isinstance(field, dict) and key not in inputs and "default" in field:
                inputs[key] = field["default"]
        errors = [{"field": ".".join(map(str, error.path)) or "inputs", "message": error.message}
                  for error in Draft202012Validator(schema).iter_errors(inputs)]
        if errors:
            raise HTTPException(422, errors[:30])
        try:
            run_id = await app.state.executor.submit(cap.manifest, inputs)
        except CapabilityChangedError as error:
            raise HTTPException(409, str(error)) from error
        except RuntimeError as error:
            raise HTTPException(429, str(error)) from error
        return {"id": run_id, "status": "queued"}

    @app.get("/api/runs")
    async def history(capability_id: str | None = None, limit: int = Query(default=50, ge=1, le=100),
                      offset: int = Query(default=0, ge=0)):
        return await asyncio.to_thread(app.state.store.list, capability_id, limit, offset)

    @app.get("/api/runs/{run_id}", response_model=ExecutionRecord)
    async def run(run_id: str):
        value = await asyncio.to_thread(app.state.store.get, run_id)
        if value is None:
            raise HTTPException(404, "Run not found")
        return value

    @app.post("/api/capabilities", status_code=201)
    def register(request: Registration):
        try:
            ast.parse(request.script)
        except (SyntaxError, ValueError, RecursionError) as error:
            raise HTTPException(422, f"Invalid Python source: {error}") from error
        root = app.state.discovery.root
        target = root / request.manifest.id
        with registration_lock:
            if target.exists() or target.is_symlink():
                raise HTTPException(409, "That capability id already exists")
            # Hidden staging directories are excluded from discovery. Publish both files together.
            stage = Path(tempfile.mkdtemp(prefix=".register-", dir=root))
            try:
                (stage / "manifest.json").write_text(request.manifest.model_dump_json(indent=2), encoding="utf-8")
                (stage / "script.py").write_text(request.script, encoding="utf-8")
                stage.rename(target)
            finally:
                if stage.exists():
                    shutil.rmtree(stage)
        return app.state.discovery.get(request.manifest.id)

    # A production build is served from the same origin as the API.
    dist = Path(os.environ.get("FRONTEND_DIST", BACKEND.parent / "frontend" / "dist"))
    if (dist / "index.html").is_file():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/")
        async def index():
            return FileResponse(dist / "index.html")
    return app


app = create_app()
