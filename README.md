# Capability Launcher

A local workspace for sharing and running independent Python tools. FastAPI hosts the registry, React builds forms from manifests, and each script runs in a dedicated cached Python environment. No external credentials or cloud services are required.

## Quick start

Prerequisites: **Python 3.11+ with pip/venv**, **Node.js 22+ / npm**, and Internet access for initial dependency downloads. On Debian/Ubuntu, install `python3-venv` if needed.

macOS/Linux, from the repository root:

```bash
./run.sh
```

Windows PowerShell:

```powershell
.\run.ps1
```

Both scripts install dependencies, build the frontend, and start one API worker serving the complete application at **[http://127.0.0.1:8000](http://127.0.0.1:8000)**. Stop with Ctrl+C. On Unix, use `PYTHON_BIN=python3.12 ./run.sh` to select Python; Windows uses `py -3` for the initial venv. If Windows execution policy blocks scripts, run the commands from `run.ps1` directly without changing your policy.

With Docker Desktop / Docker Engine running:

```bash
docker compose up --build
# Legacy Compose CLI: docker-compose up --build
```

Compose publishes to loopback and persists registry folders, virtual environments, and history in named volumes. Existing registry volumes keep their contents across image rebuilds, so new image examples do not overwrite a populated volume. The application runs as a non-root user. The image was built and the healthy Compose service passed HTTP checks for all five tools, real conflicting dependency versions, crashes, and timeouts.

**Trust model:** scripts and their packages are trusted internal code running with local process permissions. Virtual environments isolate dependencies, not filesystem/network access or hostile code. Keep the prototype on loopback and use sample data. First runs create a venv and download declared packages; later runs reuse it. Execution deadlines start after setup, which has its own 180-second budget.

## Try the examples

The request says four examples but names five folders; all five are included:

| Capability | Demonstrates |
| --- | --- |
| Log Pattern Analyzer | Log parsing, severity filtering, PII masking, custom timeline and event table |
| Legacy Report Formatter | Real `tabulate==0.8.9`, runtime version proof, Markdown output |
| Modern Data Profiler | Real `tabulate==0.9.0` alongside the legacy version, numeric profile table |
| Cloud Cost Estimator | Enum, integer, text and boolean inputs; simulated monthly USD breakdown |
| Failure Isolation Lab | Crash, timeout, syntax error, missing import, invalid JSON, excessive output, widget crash |

Run both reporting tools and compare `library_version_used` in their **Raw JSON** output. In the lab, select `crash` or `timeout`, then run another capability: navigation and the API remain responsive; the failed run retains diagnostics. Select `ui_crash` to exercise the React error boundary. Switching tools or launching a successful experiment recovers the view.

## Add a capability in 60 seconds

1. Click **New capability**, name it, and keep the working scaffold or import your `manifest.json` and `script.py` files.
2. Click **Register capability**. The new folder appears immediately without API route or frontend form changes.
3. Fill the generated inputs and run it; inspect output and stdout/stderr in **Run history**.

Alternatively, create `backend/capabilities/hello-team/` with these two files.

`manifest.json`:

```json
{
  "id": "hello-team",
  "name": "Hello Team",
  "description": "A small standalone greeting capability.",
  "author": "Internal Tools",
  "version": "1.0.0",
  "timeout_seconds": 10,
  "python_dependencies": [],
  "output_type": "json",
  "input_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["name"],
    "properties": {
      "name": {"type": "string", "title": "Your name", "minLength": 1, "default": "Team"}
    }
  }
}
```

`script.py`:

```python
import json
import sys

payload = json.load(sys.stdin)
print("Preparing greeting", file=sys.stderr)
print(json.dumps({"message": f"Hello, {payload['name']}!"}))
```

Use lowercase hyphenated IDs matching folder names and explicit dependencies such as `tabulate==0.9.0`. A script reads one JSON object from stdin, writes **one JSON value** to stdout, and logs to stderr. Inline JSON Schema objects or field-definition lists are supported; schema references are excluded. `output_type` accepts `json`, `table` (`columns` plus object `rows`), `markdown` (`markdown` string), and `custom`. Optional `ui_component` selects a reviewed widget from `frontend/src/CustomCapabilityRegistry.tsx`. A new widget needs a frontend build; missing keys fall back to the standard renderer. The form targets simple fields; complex input schemas can use the execution API.

Discovery rescans every registry request; the browser refreshes every five seconds or on Refresh. Malformed folders remain visible as **Needs attention**. Browser registration checks Python syntax, publishes both files together, and refuses existing IDs. To update a capability, edit its folder. A run snapshots its manifest; script bytes are not snapshotted, so leave source unchanged while it executes.

## Development and verification

After startup creates `.venv`:

```bash
.venv/bin/python -m pip install -r backend/requirements-dev.txt
.venv/bin/python -m pytest
cd frontend
npm test
npm run build
```

Windows:

```powershell
.\.venv\Scripts\python.exe -m pip install -r backend/requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest
cd frontend
npm test
npm run build
```

The full backend suite provisions real venvs and downloads both tabulate versions into temporary test environments; no isolation checks are mocked or skipped. It covers corrupt manifests, registration/path/schema validation, conflicting dependencies and cache reuse, concurrent host health, crashes/timeouts/syntax/import failures, bounded noisy output, malformed results, PII masking, audit logs, and restart recovery. Frontend tests cover typed form submission, invalid inputs, and custom-widget failure containment. Browser checks covered registration and execution, log filtering, history, and a mobile viewport.

To verify a running local or Docker deployment over HTTP:

```bash
python scripts/smoke.py http://127.0.0.1:8000
```

This launches the real examples concurrently, checks actual library versions and captured diagnostics, and measures API health while they run. Windows and Linux Docker backend test results are recorded in [VERIFICATION.md](VERIFICATION.md).

For frontend development, start the API and Vite in separate terminals:

```bash
.venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
# Separate terminal:
cd frontend && npm run dev
```

On Windows, substitute `.\.venv\Scripts\python.exe`; run **without `--reload`**, so asyncio subprocesses use the Windows Proactor loop. Visit [http://127.0.0.1:5173](http://127.0.0.1:5173); Vite proxies API calls to port 8000. Default CORS allows localhost/127.0.0.1:5173. The startup scripts serve a production frontend build from FastAPI on port 8000. Use **one API worker**: queue ownership and install locks are not distributed.

## Editing capabilities

Click **Edit** on a capability card or **Edit capability** in its detail view. The shared editor loads the full manifest JSON and Python source, including version, timeout, category, dependency pins, input schema, output type, and optional custom-view key. Existing malformed manifests or missing scripts can be repaired through the same editor. Keep the capability ID unchanged so schedules and history remain linked.

Saving validates the manifest and Python syntax before writing. Pause that capability's schedules and wait for its queued/running executions to finish; the API rejects edits while a run is admitted. A revision hash detects concurrent changes, including category edits. A conflict retains your draft and offers **Reload latest files** explicitly. Manifest files are limited to 128 KB; scripts to 100000 characters. Other files in the capability folder are preserved. Dependency changes select a new cached environment on the next run; old audit records retain their original manifest snapshots. Existing schedules are revalidated against the new input schema before their next execution.

Writes are staged and serialized against discovery and execution admission, with rollback on ordinary write failures. Direct edits by external programs must still avoid concurrent execution; multi-process registry writers and filesystem crash transactions are outside this single-instance host's guarantees.

## Categories

Choose an existing category or enter a new name in **New capability**. For an existing tool, open it and click **Edit category** beside its category/version. **Manage categories** above the capability library renames categories, merges them into existing categories, or removes a category by moving its tools to a chosen destination. Empty categories disappear automatically. Names are trimmed and limited to 40 characters.

Changes persist in `manifest.json`; scripts, dependency environments, and historical run snapshots are preserved. Bulk edits report individual failures and let you retry the remaining tools.

## Capability Scheduler

Open **Schedules** in the sidebar to create, edit, pause/resume, run, or delete a job. The badge counts enabled schedules. In a capability's input form, **Schedule…** validates and copies the current values into a universal **Input JSON** editor. Every capability uses this same schedule creator; adding a capability requires no scheduler-specific frontend fields. Enter one JSON object, including booleans for script flags. Scripts receive it through their existing JSON-stdin contract; the scheduler does not interpret shell command lines. **Format JSON** checks and formats the document, **Load defaults** reads manifest defaults, and **Input contract** exposes the selected capability's schema as a read-only reference. Draft JSON is preserved separately when switching capabilities within the dialog. Presets include every minute, five minutes, one hour, and daily at 09:00 UTC. Saved parameters are validated by the server on creation/update and again before dispatch, using the current manifest. Run history and output panels identify `MANUAL` and `SCHEDULED` executions.

Scheduling uses an in-process `asyncio` service started and stopped by FastAPI's lifespan. It polls SQLite every second and dispatches through the existing bounded executor: no Redis, Celery, cron package, extra pip dependency, or external broker. Run with **one API worker and one application instance per database**. The SQLite claim protects concurrent ticks and manual triggers within this host; it is not a distributed scheduler or a hostile-script sandbox.

- **Intervals:** whole seconds, minimum 10; e.g. `30`, `60`, `300`, `3600`. The next occurrence is measured from the dispatch attempt. Tests may use `create_app(..., scheduler_min_interval=1, scheduler_poll_interval=0.02)`.
- **Cron:** five numeric fields, `minute hour day_of_month month day_of_week`, in UTC. Supports `*`, steps (`*/15`, `1-10/2`), lists (`1,3,5`), and ascending ranges (`1-5`). Sunday is 0 or 7. When both day fields are restricted, either may match. Example: `0 9 * * 1-5` runs weekdays at 09:00 UTC. Seconds, named months/weekdays, timezones in expressions, Quartz syntax, and macros are unsupported. Impossible calendars are rejected with an eight-year bounded day search; leap days are supported.
- **Overlap:** `skip_if_running` is always true. A job remains RUNNING while queued, preparing, or executing. A due occurrence during that period is skipped and its next time advances. Concurrent **Run now** returns 409 while that schedule is running. Different schedules and manual capability runs retain normal executor concurrency.
- **Failures:** crashes, timeouts, invalid parameters/manifests, missing tools, and dispatch errors stay local to the schedule. `last_error` records diagnostics. Five consecutive failures disable the schedule and clear its next time; a success resets the counter. Repair the tool and **Resume** to reset the breaker and compute a fresh next time. Queue saturation is deferred without counting as a capability failure.
- **Pause / trigger / delete:** pausing stops future dispatches while the current run finishes. Run now works even while paused, uses saved parameters, and preserves cadence. Deleting a schedule removes future dispatches, lets an admitted run finish, and preserves run history with its original schedule ID.
- **Restart / misfires:** schedules and next times persist in SQLite. Interrupted runs are marked failed and reconciled into their schedule counters at startup. Overdue occurrences coalesce into one attempt, then advance from the current time; there is no backlog replay. A crash between claim and run linkage can lose that occurrence. Exactly-once side effects are not guaranteed; scripts that change external state should be idempotent.

Existing databases upgrade in place with additive `trigger_type` and `schedule_id` columns. Historical runs default to `manual`. Schedule deletion intentionally does not cascade to the audit ledger.

## API and persistence

Interactive API docs: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs).

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/api/health` | Host health and active run count |
| GET | `/api/capabilities` | Registry including invalid entries and diagnostics |
| GET | `/api/capabilities/{id}` | Manifest and status |
| GET | `/api/capabilities/{id}/files` | Raw manifest JSON, Python source, and revision hash |
| PUT | `/api/capabilities/{id}` | Validate and save `{ "manifest": {...}, "script": "...", "revision": "..." }` |
| GET | `/api/capabilities/{id}/environment` | Cache key, pins, cold/ready status |
| PATCH | `/api/capabilities/{id}/category` | Persist `{ "category": "Engineering" }` without changing execution settings |
| POST | `/api/capabilities` | Register `{ "manifest": {...}, "script": "..." }` |
| POST | `/api/capabilities/{id}/runs` | Validate `{ "inputs": {...} }`; return 202 and run ID |
| GET | `/api/runs/{run_id}` | Lifecycle, manifest snapshot, inputs, result, stdout/stderr |
| GET | `/api/runs?capability_id=...&limit=50&offset=0` | Paginated summaries, maximum page size 100 |
| GET | `/api/schedules?capability_id=...` | Persisted schedules, optionally filtered by capability |
| POST | `/api/schedules` | Validate and create a schedule; return 201 |
| PATCH | `/api/schedules/{id}` | Update cadence/parameters/name or pause/resume |
| POST | `/api/schedules/{id}/trigger` | Admit one scheduled execution immediately; return its run record |
| DELETE | `/api/schedules/{id}` | Delete future dispatches; return 204 and retain history |

States: `queued → preparing → running → succeeded / failed / timed_out`; shutdown/restart yields `interrupted`. Capacity is 32 admitted runs, four execution slots, and two environment-build slots. Request bodies are limited to 512 KB, inputs to 256 KB, each output stream to 512 KB. `duration_ms` includes queue and setup time. Logs become available after completion. Inputs/results are stored verbatim locally; use synthetic assessment data.

Defaults: `backend/data/runs.db`, `backend/.venvs/`, and `backend/capabilities/`. Override with `DATA_DIR`, `ENVIRONMENTS_DIR`, `CAPABILITIES_DIR`, or `FRONTEND_DIST`. Startup marks unfinished records interrupted without replaying work. [DESIGN.md](DESIGN.md) covers assumptions, alternatives, scope cuts, and roadmap.
