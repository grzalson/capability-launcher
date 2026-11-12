import { useState, type FormEvent } from 'react';
import { Code2, FileJson, LoaderCircle, Plus } from 'lucide-react';
import { api } from './api';
import type { Capability } from './types';
import { Modal } from './Modal';
import { CategoryField } from './CategoryField';

const defaultScript = 'import json\nimport sys\n\npayload = json.load(sys.stdin)\nprint(json.dumps({"message": f"Hello, {payload[\'name\']}!"}))\n';
const exampleSchema = JSON.stringify({ type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', title: 'Your name', minLength: 1, default: 'World' } } }, null, 2);

export function RegisterModal({ onClose, onCreated, categories = [] }: { onClose: () => void; onCreated: (capability: Capability) => void; categories?: string[] }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('Utilities');
  const [author, setAuthor] = useState('Internal Tools');
  const [dependencies, setDependencies] = useState('');
  const [schema, setSchema] = useState(exampleSchema);
  const [script, setScript] = useState(defaultScript);
  const [manifestOverride, setManifestOverride] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function uploadManifest(file?: File) {
    if (!file) return;
    try {
      if (file.size > 128000) throw new Error('Manifest exceeds 128 KB');
      const data = JSON.parse(await file.text());
      setCategory(data.category ?? 'Utilities');
      setName(data.name ?? ''); setSlug(data.id ?? ''); setDescription(data.description ?? ''); setAuthor(data.author ?? '');
      setDependencies((data.python_dependencies ?? []).join('\n')); setSchema(JSON.stringify(data.input_schema ?? {}, null, 2));
      setManifestOverride(data); setError('');
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not read manifest'); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const manifest = { version: '1.0.0', timeout_seconds: 30, output_type: 'json', ...manifestOverride,
        id: slug, name, description, author, category: category.trim(), python_dependencies: dependencies.split(/[\n,]/).map(value => value.trim()).filter(Boolean), input_schema: JSON.parse(schema) };
      const cap = await api<Capability>('/capabilities', { method: 'POST', body: JSON.stringify({ manifest, script }) });
      onCreated(cap);
    } catch (error) { setError(error instanceof Error ? error.message : 'Registration failed'); }
    finally { setBusy(false); }
  }
  return <Modal title="Register a capability" onClose={onClose} busy={busy}>
    <form onSubmit={submit} className="creator-form">
      <p className="modal-intro">Edit the scaffold or import a manifest and Python script.</p>
      <div className="upload-row"><label>Import manifest.json<input aria-label="Import manifest.json" type="file" accept=".json" onChange={event => void uploadManifest(event.target.files?.[0])} /></label>
        <label>Import script.py<input aria-label="Import script.py" type="file" accept=".py" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 100000) { setError('Script exceeds 100 KB'); return; } try { setScript(await file.text()); } catch { setError('Could not read script'); } }} /></label></div>
      <div className="two-fields"><label>Capability name<input required value={name} maxLength={100} placeholder="e.g. Release notes builder" onChange={event => { setName(event.target.value); if (!slug || slug === name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }} /></label>
        <label>Capability ID<input required pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*" maxLength={64} placeholder="release-notes-builder" value={slug} onChange={event => setSlug(event.target.value)} /></label></div>
      <CategoryField value={category} onChange={setCategory} categories={categories} disabled={busy} />
      <label>Description<input required value={description} maxLength={1000} onChange={event => setDescription(event.target.value)} /></label>
      <div className="two-fields"><label>Author<input required maxLength={100} value={author} onChange={event => setAuthor(event.target.value)} /></label><label>Dependencies <small>one pin per line</small><textarea rows={2} placeholder="tabulate==0.9.0" value={dependencies} onChange={event => setDependencies(event.target.value)} /></label></div>
      <label><span><FileJson size={14} /> Input schema</span><textarea className="code-input" rows={8} value={schema} spellCheck={false} onChange={event => setSchema(event.target.value)} /></label>
      <label><span><Code2 size={14} /> Python script</span><textarea className="code-input" rows={7} value={script} spellCheck={false} onChange={event => setScript(event.target.value)} /></label>
      <p className="creator-note">For trusted internal scripts. Registration writes a local folder; Python code runs with this machine's permissions.</p>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="modal-actions"><button className="button secondary" type="button" onClick={onClose}>Cancel</button><button className="button primary" type="submit" disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={16} />}{busy ? 'Registering…' : 'Register capability'}</button></div>
    </form>
  </Modal>;
}
