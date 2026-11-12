import { useState, type FormEvent } from 'react';
import { api } from './api';
import type { Capability } from './types';
import { Modal } from './Modal';
import { CategoryField } from './CategoryField';

type Props = { capabilities: Capability[]; onClose: () => void; onUpdated: (capabilities: Capability[]) => void };
export function CategoryModal({ capabilities, onClose, onUpdated }: Props) {
  const names = [...new Set(capabilities.flatMap(cap => cap.manifest ? [cap.manifest.category] : []))].sort();
  const [source, setSource] = useState(names[0] ?? '');
  const [action, setAction] = useState('rename');
  const [destination, setDestination] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const members = capabilities.filter(cap => cap.manifest?.category === source);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!destination.trim() || destination.trim() === source) return;
    setBusy(true); setError('');
    const results = await Promise.allSettled(members.map(cap => api<Capability>(`/capabilities/${encodeURIComponent(cap.id)}/category`, { method: 'PATCH', body: JSON.stringify({ category: destination.trim() }) })));
    const updated = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    onUpdated(updated);
    const failed = results.flatMap((result, index) => result.status === 'rejected' ? [`${members[index].manifest?.name ?? members[index].id}: ${result.reason instanceof Error ? result.reason.message : 'Save failed'}`] : []);
    setBusy(false);
    if (failed.length) { setError(`${updated.length} saved. Retry the remaining capabilities: ${failed.join('; ')}`); }
    else onClose();
  }
  return <Modal title="Manage categories" onClose={onClose} busy={busy}><form className="creator-form" onSubmit={event => void submit(event)}>
    <p className="modal-intro">Create categories when registering or editing a capability. Renaming to an existing category merges its capabilities. Removing a category moves its capabilities to the destination you choose.</p>
    {names.length ? <><div className="table-scroll category-summary"><table><thead><tr><th>Category</th><th>Capabilities</th></tr></thead><tbody>{names.map(name => <tr key={name}><td>{name}</td><td>{capabilities.filter(cap => cap.manifest?.category === name).length}</td></tr>)}</tbody></table></div>
      <fieldset disabled={busy}><label>Category to manage<select value={source} onChange={event => { setSource(event.target.value); setError(''); }}>{names.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
        <label>Action<select value={action} onChange={event => setAction(event.target.value)}><option value="rename">Rename category</option><option value="remove">Remove category and move capabilities</option></select></label>
        <CategoryField label={action === 'rename' ? 'New category name' : 'Move capabilities to'} value={destination} onChange={setDestination} categories={names.filter(name => name !== source)} />
        <p className="category-hint">{members.length} {members.length === 1 ? 'capability' : 'capabilities'} will move. Scripts, environments, and recorded runs stay intact.</p>
      </fieldset></> : <p className="modal-intro">No categories yet. Register a capability to create one.</p>}
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>{names.length > 0 && <button className="button primary" disabled={busy || !destination.trim() || destination.trim() === source || !members.length}>{busy ? 'Saving…' : action === 'rename' ? 'Rename category' : 'Move and remove category'}</button>}</div>
  </form></Modal>;
}

export function AssignCategoryModal({ capability, categories, onClose, onUpdated }: {
  capability: Capability; categories: string[]; onClose: () => void; onUpdated: (capabilities: Capability[]) => void;
}) {
  const [value, setValue] = useState(capability.manifest?.category ?? 'Utilities');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const updated = await api<Capability>(`/capabilities/${encodeURIComponent(capability.id)}/category`, { method: 'PATCH', body: JSON.stringify({ category: value.trim() }) });
      onUpdated([updated]); onClose();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not save category'); }
    finally { setBusy(false); }
  }
  return <Modal title="Edit category" onClose={onClose} busy={busy}><form className="creator-form" onSubmit={event => void submit(event)}>
    <p className="modal-intro">{capability.manifest?.name}: choose an existing category or enter a new name.</p>
    <CategoryField value={value} onChange={setValue} categories={categories} disabled={busy} />
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !value.trim()}>{busy ? 'Saving…' : 'Save category'}</button></div>
  </form></Modal>;
}
