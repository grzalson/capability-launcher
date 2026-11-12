import ast
from pathlib import Path

from app.discovery import Discovery


def test_all_examples_have_valid_manifests_and_python():
    root = Path(__file__).resolve().parents[1] / "capabilities"
    capabilities = Discovery(root).scan()
    assert len(capabilities) == 5
    assert all(cap.status == "READY" for cap in capabilities)
    for cap in capabilities:
        ast.parse((root / cap.id / "script.py").read_text(encoding="utf-8"))
    pins = {dep for cap in capabilities for dep in cap.manifest.python_dependencies}
    assert pins == {"tabulate==0.8.9", "tabulate==0.9.0"}
