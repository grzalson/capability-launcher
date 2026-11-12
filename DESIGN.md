# Capability Launcher — Architecture & Design Decisions

## 1. Core Assumptions & Resolving the Target-User Ambiguity
The prompt describes a scenario where a team produces standalone Python scripts ("capabilities") that are slow to share via CLI, rely on tribal knowledge, and cause new colleagues to struggle. This introduces an important product ambiguity: **Is this an internal engineering platform for developers to host/maintain scripts, or a self-service portal for non-technical/adjacent coworkers to run tools without touching a terminal?**

**Decision:** I designed the system around a **dual-persona model** that bridges both needs:
1. **Capability Creators (Script Authors / Engineers):** Need a zero-friction way to publish, edit (`EditCapabilityModal`), or drop in a Python script with its own exact library versions (`python_dependencies`) and input contract (`input_schema`) without worrying about breaking other capabilities or spinning up a separate microservice.
2. **Capability Consumers (New Teammates, On-Call Engineers, & Non-CLI Coworkers):** Need a self-service catalog where tribal knowledge is encoded directly into validated UI forms (`DynamicForm.tsx`), preset schedules (`SchedulesView.tsx`), and structured outputs—allowing anyone to run or schedule a capability safely in the browser without installing Python locally.

**Additional Operational Assumptions:**
- **Trust Model:** Capabilities are authored by internal teammates (trusted-but-fallible code, not hostile public untrusted code). Isolation therefore prioritizes **dependency conflict resolution** and **fault/crash containment** over kernel-level multi-tenant security.
- **Workload Profile:** Scripts are interactive or periodic automation tasks (running from milliseconds to a few minutes) that accept structured JSON parameters and emit structured JSON to `stdout` alongside diagnostic logs on `stderr`.

---

## 2. Key Architectural Decisions & Trade-offs

### A. Dependency Isolation: Per-Capability Cached Virtual Environments (`executor.py`)
* **The Problem:** Capability A (`legacy-report-formatter`) requires `tabulate==0.8.9`, while Capability B (`modern-data-profiler`) requires `tabulate==0.9.0`, yet both must be hosted and triggered through a single Python API.
* **Decision:** `EnvironmentManager` hashes each capability's sorted dependency list (`SHA-256`) and provisions a dedicated, cached Python virtual environment under `.venvs/<capability_id>-<dep_hash>`. Scripts execute as isolated async subprocesses (`asyncio.create_subprocess_exec`) using their respective `.venv` interpreter.
* **Alternatives Considered:**
  * *In-process dynamic `importlib`*: Rejected immediately because Python's `sys.modules` is process-global; two versions of the same package cannot safely coexist in one interpreter process.
  * *Docker-in-Docker / Containers per capability*: Offers stronger OS-level isolation, but requires reviewers to run a Docker daemon with socket mounting and introduces slow image build times for a local prototype. Abstracting execution behind `CapabilityExecutor` makes swapping in a `ContainerRunner` later trivial.

### B. Blast-Radius & Fault Isolation (`discovery.py`, `executor.py`, `CapabilityErrorBoundary.tsx`)
A broken script—or a mistake made while adding/editing one—must never take down the application or block other scripts:
1. **Discovery Fault Isolation (`discovery.py`):** Capabilities are discovered dynamically from `backend/capabilities/<slug>/`. If a capability has a malformed `manifest.json`, invalid schema, or missing `script.py`, the discovery engine catches the validation error and returns the capability with `status="INVALID"` and diagnostic details rather than crashing the FastAPI startup or `/api/capabilities` endpoint.
2. **Runtime Process Isolation (`executor.py`):** Every run executes in a separate OS process with strict timeout enforcement (`asyncio.wait_for`), non-zero exit code handling, and invalid-JSON output guards. Demonstrated live by `broken-experimental-script` (*Failure Isolation Lab*).
3. **Frontend UI Isolation (`CapabilityErrorBoundary.tsx`):** Capabilities can opt into custom React views via `CustomCapabilityRegistry.tsx`. Every capability workspace and custom widget is wrapped in a dedicated React Error Boundary so a rendering exception inside one capability's custom UI is caught and isolated to that view.

### C. UI Extensibility: Hybrid JSON Schema Forms + Custom Component Registry
* **Decision:** 90% of internal scripts only need validated inputs and clean table/JSON/Markdown output, which `DynamicForm.tsx` generates automatically from `manifest.json`. For capabilities requiring bespoke visualizations (like `log-pattern-analyzer`), `manifest.json` specifies a `ui_component` key mapped in `CustomCapabilityRegistry.tsx`.
* **Why:** Avoids the complexity of webpack Module Federation while still allowing rich, capability-specific React interfaces where needed.

### D. Zero-Dependency Background Scheduler (`scheduler.py`)
* **Decision:** Built an in-process `asyncio` scheduler tied to FastAPI's `lifespan` and backed by SQLite (`schedules` table), supporting both fixed intervals (`interval`) and 5-field cron expressions (`cron`) using pure Python standard library.
* **Safety Guards:** Includes an **overlap guard (`skip_if_running`)** so slow jobs don't pile up, and a **5-strike circuit breaker** (`consecutive_failures >= 5`) that automatically pauses chronically failing schedules so broken capabilities don't spam error logs indefinitely.

---

## 3. What Was Cut Intentionally (Scope Management)
To keep the prototype focused, high-quality, and runnable with zero external infrastructure, I deliberately left out:
- **External Task Brokers (Celery / Redis / RabbitMQ):** Replaced with SQLite + `asyncio` subprocess management to guarantee a 1-command local setup.
- **Authentication & RBAC Enforcement:** Kept open for frictionless reviewer testing (see *What I'd Build Next* for the Creator/Consumer auth design).
- **Real-time WebSocket Log Streaming:** Used structured execution records and polling on completion instead of WebSocket/SSE log tailing.
- **Container / Filesystem Sandboxing:** Scripts currently share the host filesystem; network and disk quotas are not enforced in local venv mode.

---

## 4. What I'd Build Next (Production Roadmap)

### 1. Authentication & Creator / Consumer Role-Based Access Control (RBAC)
To formally address the ambiguity between technical script authors and non-technical coworkers running tools, the next step is introducing OAuth/OIDC login with two distinct roles:
- **Creator Role (Engineers):** Full access to register new capabilities (`RegisterModal`), edit Python code/manifests (`EditCapabilityModal`), manage category taxonomies, and configure system-wide schedules.
- **Consumer Role (Coworkers / Support / Ops):** A streamlined, read/execute-only workspace. Consumers can browse healthy capabilities, fill out validated parameter forms, run capabilities, view outputs, and trigger allowed schedules—while code editing, dependency mutation, and broken/sandbox capabilities are hidden or locked.
- **Audit Attribution:** Tie every `ExecutionRecord` and `ScheduleRecord` in SQLite/Postgres to the authenticated `user_id` and `role`.

### 2. High-Signal AI Integration (Solving Tribal Knowledge & Onboarding Friction)
Rather than adding a generic chatbot, AI should be embedded directly into the moments where creators and consumers experience friction—implemented via a **Provider Strategy pattern** (using live LLM APIs when keys are configured, with deterministic Python `ast`/heuristic fallbacks for offline use):
- **A. Legacy CLI-to-Capability Importer (For Creators):** An *"Auto-Extract from Raw Python Script"* action in the registration modal. Engineers paste an existing standalone CLI script (using `argparse`, `click`, or `sys.argv`), and an AST + LLM analyzer automatically extracts `python_dependencies`, generates the `input_schema` with human-readable descriptions/defaults, and wraps the entrypoint to read JSON from `stdin`.
- **B. Natural Language Intent Router & Form Auto-Filler (For Consumers):** An intent command bar where a new colleague can type *"Estimate cloud cost in eu-west-1 for 15 spot instances"*. The router matches the intent against registered `manifest.json` schemas, selects `cloud-cost-estimator`, and pre-fills the `DynamicForm` fields (`region="eu-west-1"`, `instance_count=15`, `use_spot=true`) for human review before clicking Run.
- **C. Automated Failure & Traceback Diagnostics:** When a capability run fails or times out, an *"Explain Failure"* assistant inspects the `stderr` traceback alongside `manifest.json` and `script.py` to provide two targeted remediations: a **Consumer Fix** (e.g., *"Parameter X was out of range; try value Y"*) and a **Creator Fix** (the exact code/dependency patch).
- **D. Smart Output Summarization:** For capabilities that return large raw JSON payloads without a custom React component, generate a concise Markdown executive summary highlighting anomalies and key takeaways.

### 3. Hardened Execution & Secret Management
- **Containerized Runner Backend:** Implement a `DockerRunner` / `KubernetesJobRunner` behind the executor interface for capabilities requiring system-level binaries (`ffmpeg`, `wkhtmltopdf`) or strict CPU/memory/network sandboxing.
- **Scoped Secret Injection:** Allow capabilities to declare required secret keys in `manifest.json` (e.g., `["READONLY_DB_URL"]`) injected at runtime from Vault/AWS Secrets Manager as environment variables without exposing credentials in the UI or run history.