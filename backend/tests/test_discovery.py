import json

from app.discovery import Discovery


def manifest(slug="valid-tool", **overrides):
    return {"id": slug, "name": "Example", "description": "A test", "author": "Tests", "version": "1.0.0", **overrides}


def write_cap(root, slug, data=None, script="print('{}')"):
    folder = root / slug
    folder.mkdir(parents=True)
    (folder / "manifest.json").write_text(json.dumps(data or manifest(slug)), encoding="utf-8")
    if script is not None:
        (folder / "script.py").write_text(script, encoding="utf-8")
    return folder


def test_bad_folders_do_not_hide_healthy_capability(tmp_path):
    write_cap(tmp_path, "valid-tool")
    broken = write_cap(tmp_path, "bad-json")
    (broken / "manifest.json").write_text("{oops", encoding="utf-8")
    write_cap(tmp_path, "missing-script", script=None)
    write_cap(tmp_path, "wrong-id", manifest("different-id"))
    result = {cap.id: cap for cap in Discovery(tmp_path).scan()}
    assert result["valid-tool"].status == "READY"
    for slug in ["bad-json", "missing-script", "wrong-id"]:
        assert result[slug].status == "INVALID"
        assert result[slug].diagnostics


def test_field_list_normalized_and_dependency_options_rejected(tmp_path):
    write_cap(tmp_path, "valid-tool", manifest(input_schema=[{"name": "count", "type": "integer", "required": True, "default": 3}]))
    write_cap(tmp_path, "bad-deps", manifest("bad-deps", python_dependencies=["--index-url=https://evil.test"]))
    result = {cap.id: cap for cap in Discovery(tmp_path).scan()}
    assert result["valid-tool"].manifest.input_schema["required"] == ["count"]
    assert result["bad-deps"].status == "INVALID"
