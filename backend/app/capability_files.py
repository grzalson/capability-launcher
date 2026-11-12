"""Validated, conflict-aware edits to the two capability source files."""
import hashlib
import re
import shutil
import tempfile
from pathlib import Path

from .schemas import SLUG


class CapabilityFileError(Exception):
    def __init__(self, status: int, detail: str):
        self.status, self.detail = status, detail
        super().__init__(detail)


class CapabilityFiles:
    def __init__(self, discovery):
        self.discovery = discovery

    def _folder(self, slug):
        if not re.fullmatch(SLUG, slug) or len(slug) > 64:
            raise CapabilityFileError(422, 'Capability ID must be a lowercase hyphenated name')
        folder = self.discovery.root / slug
        if folder.is_symlink() or folder.resolve().parent != self.discovery.root:
            raise CapabilityFileError(409, 'Symbolic links are not editable')
        if not folder.is_dir():
            raise CapabilityFileError(404, 'Capability not found')
        return folder

    def _read(self, slug):
        folder = self._folder(slug)
        files = {}
        digest = hashlib.sha256()
        for name, limit in [('manifest.json', 128000), ('script.py', 400000)]:
            source = folder / name
            if source.is_symlink() or (source.exists() and not source.is_file()):
                raise CapabilityFileError(409, f'{name} must be a regular file')
            if source.exists() and source.stat().st_size > limit:
                raise CapabilityFileError(413, f'{name} exceeds the editor size limit')
            content = source.read_bytes() if source.exists() else None
            files[name] = content
            digest.update(name.encode() + b'\0' + (b'MISSING' if content is None else b'FILE\0' + content))
        return folder, files, digest.hexdigest()

    def read(self, slug):
        with self.discovery.lock:
            try:
                _, files, revision = self._read(slug)
                script = (files['script.py'] or b'').decode('utf-8')
                if len(script) > 100000:
                    raise CapabilityFileError(413, 'Python source exceeds 100000 characters')
                return {'manifest_json': (files['manifest.json'] or b'').decode('utf-8'), 'script': script, 'revision': revision}
            except UnicodeError as error:
                raise CapabilityFileError(409, 'Capability files must use UTF-8; repair their encoding on disk') from error
            except OSError as error:
                raise CapabilityFileError(500, 'Could not read capability files; check registry permissions') from error

    def write(self, slug, request):
        if request.manifest.id != slug:
            raise CapabilityFileError(409, 'Capability ID cannot change; schedules and history use this ID')
        manifest = request.manifest.model_dump_json(indent=2).encode('utf-8')
        if len(manifest) > 128000:
            raise CapabilityFileError(413, 'Manifest exceeds 128 KB')
        with self.discovery.lock:
            stage = None
            replaced = []
            try:
                folder, previous, revision = self._read(slug)
                if request.revision != revision:
                    raise CapabilityFileError(409, 'Files changed since this editor opened. Reload the latest files before saving.')
                stage = Path(tempfile.mkdtemp(prefix='.edit-', dir=folder)).resolve()
                assert stage.parent == folder.resolve()
                contents = {'script.py': request.script.encode('utf-8'), 'manifest.json': manifest}
                for name, data in contents.items():
                    (stage / ('after-' + name)).write_bytes(data)
                    if previous[name] is not None:
                        (stage / ('before-' + name)).write_bytes(previous[name])
                try:
                    for name in contents:
                        (stage / ('after-' + name)).replace(folder / name)
                        replaced.append(name)
                except OSError:
                    for name in reversed(replaced):
                        if previous[name] is None:
                            (folder / name).unlink(missing_ok=True)
                        else:
                            (stage / ('before-' + name)).replace(folder / name)
                    raise
            except OSError as error:
                raise CapabilityFileError(500, 'Could not save capability files; check registry permissions') from error
            finally:
                if stage is not None:
                    assert stage.parent == folder.resolve() and stage.name.startswith('.edit-')
                    shutil.rmtree(stage)
            return self.discovery.get(slug)
