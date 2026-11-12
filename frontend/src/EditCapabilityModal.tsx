import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api';
import { Modal } from './Modal';
import type { Capability } from './types';

type Sources = { manifest_json: string; script: string; revision: string };
function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : 'Could not save capability';
  try {
    const details = JSON.parse(message);
    if (Array.isArray(details)) return details.map(item => `${item.loc?.filter((part: string) => part !== 'body').join('.') ?? 'Capability'}: ${item.msg ?? item.message}`).join('; ');
  } catch { /* Server text is already readable. */ }
  return message;
}
export function EditCapabilityModal({ capabilityId, onClose, onSaved }: {
  capabilityId: string; onClose: () => void; onSaved: (capability: Capability) => void;
}) {
  const [manifest, setManifest] = useState('');
  const [script, setScript] = useState('');
  const [revision, setRevision] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const manifestEditor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    api<Sources>(`/capabilities/${encodeURIComponent(capabilityId)}/files`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      setManifest(value.manifest_json); setScript(value.script); setRevision(value.revision);
    }).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [capabilityId, reload]);
  function parseManifest(): Record<string, unknown> | undefined {
    try {
      const value = JSON.parse(manifest);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch { setError('Manifest must be a valid JSON object.'); manifestEditor.current?.focus(); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setError('');
    const parsed = parseManifest();
    if (!parsed) return;
    if (parsed.id !== capabilityId) { setError('Capability ID cannot change. Keep the existing ID so schedules and history stay linked.'); manifestEditor.current?.focus(); return; }
    setBusy(true);
    try {
      const saved = await api<Capability>(`/capabilities/${encodeURIComponent(capabilityId)}`, { method: 'PUT', body: JSON.stringify({ manifest: parsed, script, revision }) });
      onSaved(saved); onClose();
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <Modal title="Edit capability" onClose={onClose} busy={busy}>
    {loading ? <div className="creator-form"><p className="modal-intro">Loading capability files…</p></div> : !revision ? <div className="creator-form"><div className="inline-error" role="alert">{error}</div><button className="button secondary" onClick={() => setReload(value => value + 1)}>Retry</button></div> : <form className="creator-form capability-editor" onSubmit={event => void save(event)}>
      <p className="modal-intro">Edit metadata, dependencies, input schema, and execution settings in the manifest, plus the Python source. Keep the ID <code>{capabilityId}</code>.</p>
      <div className="schedule-json-heading"><label htmlFor="edit-manifest">Manifest JSON</label><button type="button" className="button secondary" disabled={busy} onClick={() => { setError(''); const value = parseManifest(); if (value) setManifest(JSON.stringify(value, null, 2)); }}>Format JSON</button></div>
      <textarea ref={manifestEditor} id="edit-manifest" className="code-input" rows={14} required spellCheck={false} value={manifest} disabled={busy} onChange={event => setManifest(event.target.value)} />
      <label>Python script<textarea className="code-input" rows={10} required maxLength={100000} spellCheck={false} value={script} disabled={busy} onChange={event => setScript(event.target.value)} /></label>
      <p className="creator-note">Changes apply to future executions. Pause this capability’s schedules and let queued or running executions finish before saving.</p>
      {error && <div className="inline-error" role="alert">{error}{error.startsWith('Files changed') && <><p>Reloading replaces this draft.</p><button type="button" className="button secondary" onClick={() => setReload(value => value + 1)}>Reload latest files</button></>}</div>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button></div>
    </form>}
  </Modal>;
}
