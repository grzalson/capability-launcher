"""Fault-tolerant filesystem registry. No capability is imported into the API."""

from pathlib import Path
import threading

from .schemas import Capability, Manifest

MAX_MANIFEST_BYTES = 128_000


class Discovery:
    def __init__(self, root: Path, lock=None):
        self.lock = lock or threading.RLock()
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def scan(self) -> list[Capability]:
        with self.lock:
            return self._scan()

    def _scan(self) -> list[Capability]:
        result = []
        for folder in sorted(self.root.iterdir()):
            if folder.name.startswith(".") or (not folder.is_symlink() and not folder.is_dir()):
                continue
            try:
                if folder.is_symlink() or folder.resolve().parent != self.root:
                    raise ValueError("Capability folders must not be symbolic links")
                source = folder / "manifest.json"
                if source.is_symlink() or source.stat().st_size > MAX_MANIFEST_BYTES:
                    raise ValueError("Manifest is a symlink or exceeds 128 KB")
                manifest = Manifest.model_validate_json(source.read_text(encoding="utf-8"))
                if manifest.id != folder.name:
                    raise ValueError("Manifest id must match its folder name")
                script = folder / "script.py"
                if not script.is_file() or script.is_symlink():
                    raise ValueError("Missing regular script.py")
                result.append(Capability(id=folder.name, status="READY", manifest=manifest))
            except Exception as error:
                # Filesystem races, JSON/schema errors and incomplete drops are local failures.
                result.append(Capability(id=folder.name, status="INVALID", diagnostics=[str(error)[:2000]]))
        return result

    def get(self, capability_id: str) -> Capability | None:
        return next((cap for cap in self.scan() if cap.id == capability_id), None)
