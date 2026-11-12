"""Small, durable run ledger. One short-lived connection per operation."""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class RunStore:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self.connect()) as db, db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY, capability_id TEXT NOT NULL, status TEXT NOT NULL,
                created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
                duration_ms INTEGER, inputs TEXT NOT NULL, manifest TEXT NOT NULL,
                result TEXT, stdout TEXT NOT NULL DEFAULT '', stderr TEXT NOT NULL DEFAULT '',
                error TEXT, exit_code INTEGER, environment TEXT
            )""")
            columns = {row["name"] for row in db.execute("PRAGMA table_info(runs)")}
            if "trigger_type" not in columns:
                db.execute("ALTER TABLE runs ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'manual'")
            if "schedule_id" not in columns:
                db.execute("ALTER TABLE runs ADD COLUMN schedule_id TEXT")
            db.execute("""CREATE TABLE IF NOT EXISTS schedules (
                id TEXT PRIMARY KEY, capability_id TEXT NOT NULL, name TEXT NOT NULL,
                schedule_type TEXT NOT NULL, expression TEXT NOT NULL, parameters TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1, skip_if_running INTEGER NOT NULL DEFAULT 1,
                last_run_at TEXT, next_run_at TEXT, last_run_id TEXT, last_status TEXT,
                last_error TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled,next_run_at)")
            db.execute("CREATE INDEX IF NOT EXISTS runs_schedule ON runs(schedule_id,created_at DESC)")
            db.execute("CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at DESC)")
            db.execute("CREATE INDEX IF NOT EXISTS runs_capability ON runs(capability_id, created_at DESC)")

    def connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    def recover(self) -> None:
        with closing(self.connect()) as db, db:
            db.execute("""UPDATE runs SET status='interrupted', finished_at=?,
                error='API restarted before this run completed'
                WHERE status IN ('queued', 'preparing', 'running')""", (now(),))

    def create(self, capability_id: str, inputs: dict, manifest: dict, trigger_type: str = "manual", schedule_id: str | None = None) -> str:
        run_id = uuid.uuid4().hex
        with closing(self.connect()) as db, db:
            db.execute("INSERT INTO runs(id,capability_id,status,created_at,inputs,manifest,trigger_type,schedule_id) VALUES(?,?,?,?,?,?,?,?)",
                       (run_id, capability_id, "queued", now(), json.dumps(inputs), json.dumps(manifest), trigger_type, schedule_id))
        return run_id

    def update(self, run_id: str, **values: Any) -> None:
        allowed = {"status", "started_at", "finished_at", "duration_ms", "result", "stdout", "stderr", "error", "exit_code", "environment"}
        if not values or values.keys() - allowed:
            raise ValueError("Invalid run update")
        if "result" in values:
            values["result"] = json.dumps(values["result"], allow_nan=False)
        with closing(self.connect()) as db, db:
            db.execute(f"UPDATE runs SET {','.join(key + '=?' for key in values)} WHERE id=?", (*values.values(), run_id))

    @staticmethod
    def decode(row: sqlite3.Row) -> dict:
        value = dict(row)
        for key in ("inputs", "manifest", "result"):
            if key in value and value[key] is not None:
                value[key] = json.loads(value[key])
        return value

    def get(self, run_id: str) -> dict | None:
        with closing(self.connect()) as db:
            row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            return self.decode(row) if row else None

    def list(self, capability_id: str | None = None, limit: int = 50, offset: int = 0) -> list[dict]:
        columns = "id,capability_id,status,created_at,started_at,finished_at,duration_ms,error,exit_code,environment,trigger_type,schedule_id"
        query = f"SELECT {columns} FROM runs"
        args: list[Any] = []
        if capability_id:
            query += " WHERE capability_id=?"
            args.append(capability_id)
        query += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
        with closing(self.connect()) as db:
            return [dict(row) for row in db.execute(query, (*args, limit, offset))]


    @staticmethod
    def decode_schedule(row) -> dict:
        value = dict(row)
        value["parameters"] = json.loads(value["parameters"])
        value["enabled"] = bool(value["enabled"])
        value["skip_if_running"] = bool(value["skip_if_running"])
        return value

    def schedules(self, capability_id: str | None = None, due_at: str | None = None) -> list[dict]:
        query, args = "SELECT * FROM schedules", []
        if due_at is not None:
            query += " WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?"
            args.append(due_at)
        elif capability_id is not None:
            query += " WHERE capability_id=?"
            args.append(capability_id)
        query += " ORDER BY created_at,id"
        with closing(self.connect()) as db:
            return [self.decode_schedule(row) for row in db.execute(query, args)]

    def schedule(self, schedule_id: str) -> dict | None:
        with closing(self.connect()) as db:
            row = db.execute("SELECT * FROM schedules WHERE id=?", (schedule_id,)).fetchone()
            return self.decode_schedule(row) if row else None

    def create_schedule(self, values: dict) -> dict:
        values = {**values, "id": str(uuid.uuid4()), "created_at": now()}
        values["parameters"] = json.dumps(values["parameters"], allow_nan=False)
        with closing(self.connect()) as db, db:
            db.execute(f"INSERT INTO schedules ({','.join(values)}) VALUES ({','.join('?' for _ in values)})", tuple(values.values()))
        return self.schedule(values["id"])

    def update_schedule(self, schedule_id: str, **values) -> dict | None:
        allowed = {"name", "schedule_type", "expression", "parameters", "enabled", "next_run_at", "consecutive_failures", "last_run_at", "last_run_id", "last_status", "last_error"}
        if not values or values.keys() - allowed:
            raise ValueError("Invalid schedule update")
        if "parameters" in values:
            values["parameters"] = json.dumps(values["parameters"], allow_nan=False)
        with closing(self.connect()) as db, db:
            db.execute(f"UPDATE schedules SET {','.join(key+'=?' for key in values)} WHERE id=?", (*values.values(), schedule_id))
        return self.schedule(schedule_id)

    def claim_schedule(self, schedule_id: str, at: str, next_at: str | None, manual: bool = False) -> dict | None:
        with closing(self.connect()) as db, db:
            query = """UPDATE schedules SET last_status='RUNNING',last_run_at=?,last_run_id=NULL,last_error=NULL,next_run_at=?
                WHERE id=? AND (last_status IS NULL OR last_status!='RUNNING')"""
            args = [at, next_at, schedule_id]
            if not manual:
                query += " AND enabled=1 AND next_run_at<=?"
                args.append(at)
            if db.execute(query, args).rowcount != 1:
                return None
            return self.decode_schedule(db.execute("SELECT * FROM schedules WHERE id=?", (schedule_id,)).fetchone())

    def advance_running_schedule(self, schedule_id: str, next_at: str) -> None:
        with closing(self.connect()) as db, db:
            db.execute("UPDATE schedules SET next_run_at=? WHERE id=? AND enabled=1 AND last_status='RUNNING'", (next_at, schedule_id))

    def finish_schedule(self, schedule_id: str, status: str, error: str | None = None) -> None:
        with closing(self.connect()) as db, db:
            db.execute("""UPDATE schedules SET last_status=?,last_error=?,
                enabled=CASE WHEN ?!='COMPLETED' AND consecutive_failures+1>=5 THEN 0 ELSE enabled END,
                next_run_at=CASE WHEN ?!='COMPLETED' AND consecutive_failures+1>=5 THEN NULL ELSE next_run_at END,
                consecutive_failures=CASE WHEN ?='COMPLETED' THEN 0 ELSE consecutive_failures+1 END
                WHERE id=? AND last_status='RUNNING'""", (status, error, status, status, status, schedule_id))

    def recover_schedules(self, force: bool = True) -> None:
        with closing(self.connect()) as db:
            running = [self.decode_schedule(row) for row in db.execute("SELECT * FROM schedules WHERE last_status='RUNNING'")]
        for schedule in running:
            run = self.get(schedule["last_run_id"]) if schedule["last_run_id"] else None
            if run is None:
                # Attribution also lets us repair a crash between run creation and schedule linkage.
                with closing(self.connect()) as db:
                    row = db.execute("SELECT * FROM runs WHERE schedule_id=? AND created_at>=? ORDER BY created_at DESC LIMIT 1", (schedule["id"], schedule["last_run_at"])).fetchone()
                    run = self.decode(row) if row else None
                if run:
                    self.update_schedule(schedule['id'], last_run_id=run['id'])
            if not force and (run is None or not run['finished_at']):
                continue
            status = "COMPLETED" if run and run["status"] == "succeeded" else "TIMED_OUT" if run and run["status"] == "timed_out" else "FAILED"
            self.finish_schedule(schedule["id"], status, run.get("error") if run else "Scheduler restarted before dispatch completed")

    def delete_schedule(self, schedule_id: str) -> bool:
        with closing(self.connect()) as db, db:
            return db.execute("DELETE FROM schedules WHERE id=?", (schedule_id,)).rowcount == 1
