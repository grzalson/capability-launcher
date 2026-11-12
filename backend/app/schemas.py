"""The manifest is data, never executable host code."""

import json
import re
from typing import Annotated, Any, Literal

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError as SchemaValidationError
from packaging.requirements import Requirement
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

SLUG = r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"


CategoryName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]


class Manifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=SLUG, max_length=64)
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=1000)
    author: str = Field(min_length=1, max_length=100)
    version: str = Field(min_length=1, max_length=40)
    timeout_seconds: int = Field(default=30, ge=1, le=300, strict=True)
    python_dependencies: list[str] = Field(default_factory=list, max_length=30)
    input_schema: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})
    ui_component: str | None = Field(default=None, max_length=80)
    output_type: Literal["json", "table", "markdown", "custom"] = "json"
    category: CategoryName = "Utilities"

    @field_validator("python_dependencies")
    @classmethod
    def pinned_packages(cls, dependencies: list[str]) -> list[str]:
        names: set[str] = set()
        for item in dependencies:
            requirement = Requirement(item)
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*==[A-Za-z0-9][A-Za-z0-9_.+!-]*", item):
                raise ValueError("Dependencies must be explicit package==version pins (no URLs or options)")
            name = requirement.name.lower().replace("_", "-").replace(".", "-")
            if name in names:
                raise ValueError(f"Duplicate dependency: {name}")
            names.add(name)
        return sorted(dependencies)

    @field_validator("input_schema", mode="before")
    @classmethod
    def normalize_schema(cls, schema: Any) -> dict[str, Any]:
        # Also accept the brief's concise list-of-field-definitions representation.
        if isinstance(schema, list):
            properties, required = {}, []
            for field in schema:
                if not isinstance(field, dict) or not isinstance(field.get("name"), str):
                    raise ValueError("Each field needs a string name")
                item = dict(field)
                name = item.pop("name")
                if name in properties:
                    raise ValueError(f"Duplicate input field: {name}")
                if item.pop("required", False):
                    required.append(name)
                if "label" in item:
                    item["title"] = item.pop("label")
                properties[name] = item
            schema = {"type": "object", "properties": properties, "required": required, "additionalProperties": False}
        if not isinstance(schema, dict) or schema.get("type") != "object":
            raise ValueError("input_schema must describe a JSON object")
        # References are deliberately excluded: validation must never perform network I/O.
        def check(value: Any) -> None:
            if isinstance(value, dict):
                if "$ref" in value or "$dynamicRef" in value:
                    raise ValueError("Schema references are not supported; inline the field schema")
                for child in value.values():
                    check(child)
            elif isinstance(value, list):
                for child in value:
                    check(child)
        check(schema)
        try:
            json.dumps(schema, allow_nan=False)
            Draft202012Validator.check_schema(schema)
        except (SchemaError, ValueError) as error:
            raise ValueError(f"Invalid input schema: {error}") from error
        return schema

    @model_validator(mode="after")
    def valid_defaults(self) -> "Manifest":
        for name, field in self.input_schema.get("properties", {}).items():
            if isinstance(field, dict) and "default" in field:
                try:
                    Draft202012Validator(field).validate(field["default"])
                except SchemaValidationError as error:
                    raise ValueError(f"Invalid default for {name}: {error.message}") from error
        return self


class Capability(BaseModel):
    id: str
    status: Literal["READY", "INVALID"]
    manifest: Manifest | None = None
    diagnostics: list[str] = Field(default_factory=list)


class Registration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    manifest: Manifest
    script: str = Field(min_length=1, max_length=100_000)


class CapabilityUpdate(Registration):
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")


class CapabilitySources(BaseModel):
    manifest_json: str
    script: str
    revision: str


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    inputs: dict[str, Any] = Field(default_factory=dict)

    @field_validator("inputs")
    @classmethod
    def bounded_inputs(cls, inputs: dict[str, Any]) -> dict[str, Any]:
        if len(json.dumps(inputs, allow_nan=False).encode()) > 256_000:
            raise ValueError("Input exceeds 256 KB")
        return inputs


class CategoryUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    category: CategoryName


class ExecutionRecord(BaseModel):
    id: str
    capability_id: str
    status: Literal["queued", "preparing", "running", "succeeded", "failed", "timed_out", "interrupted"]
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None
    duration_ms: int | None = None
    inputs: dict[str, Any]
    manifest: dict[str, Any]
    result: Any = None
    stdout: str = ""
    stderr: str = ""
    error: str | None = None
    exit_code: int | None = None
    environment: str | None = None
    trigger_type: Literal["manual", "scheduled"] = "manual"
    schedule_id: str | None = None


class ScheduleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    capability_id: str = Field(pattern=SLUG, max_length=64)
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    schedule_type: Literal["interval", "cron"]
    expression: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    parameters: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True
    # Overlap protection is mandatory for this single-worker host.
    skip_if_running: Literal[True] = True

    @field_validator("parameters")
    @classmethod
    def bounded_parameters(cls, value):
        if len(json.dumps(value, allow_nan=False).encode()) > 256_000:
            raise ValueError("Parameters exceed 256 KB")
        return value


class ScheduleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)] | None = None
    schedule_type: Literal["interval", "cron"] | None = None
    expression: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)] | None = None
    parameters: dict[str, Any] | None = None
    enabled: bool | None = None

    @model_validator(mode="after")
    def non_null_patch(self):
        if not self.model_fields_set or any(getattr(self, field) is None for field in self.model_fields_set):
            raise ValueError("Provide at least one non-null schedule field")
        if self.parameters is not None:
            ScheduleCreate.bounded_parameters(self.parameters)
        return self


class ScheduleRecord(ScheduleCreate):
    id: str
    last_run_at: str | None = None
    next_run_at: str | None = None
    last_run_id: str | None = None
    last_status: Literal["COMPLETED", "FAILED", "TIMED_OUT", "RUNNING", "INVALID_CAPABILITY"] | None = None
    last_error: str | None = None
    consecutive_failures: int = 0
    created_at: str
