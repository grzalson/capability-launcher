import { useId, useRef, useState, type FormEvent } from 'react';
import { Modal } from './Modal';
import { createSchedule, updateSchedule } from './api';
import type { Capability, Json, ScheduleRecord } from './types';

function defaultParameters(capability?: Capability): Record<string, Json> {
  return Object.fromEntries(Object.entries(capability?.manifest?.input_schema.properties ?? {}).flatMap(([key, field]) =>
    field.default === undefined ? [] : [[key, field.default]]));
}

function parseParameters(text: string): Record<string, Json> {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('Enter valid JSON. Use double quotes and remove trailing commas.'); }
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('Input JSON must be an object, for example {"dry_run": true}.');
  }
  JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('JSON numbers must be finite.');
    return item;
  });
  if (new TextEncoder().encode(JSON.stringify(value)).length > 256000) throw new Error('Input JSON exceeds 256 KB.');
  return value as Record<string, Json>;
}

function requestMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Could not save schedule';
  try {
    const detail = JSON.parse(message);
    if (Array.isArray(detail)) return detail.map(item => {
      const field = item.field ?? (Array.isArray(item.loc) ? item.loc.filter((part: string) => part !== 'body').join('.') : 'Inputs');
      return `${field}: ${item.message ?? item.msg ?? 'Invalid value'}`;
    }).join('; ');
  } catch { /* Plain API errors already describe the problem. */ }
  return message;
}

export function ScheduleModal({ capabilities, capabilityId, parameters, schedule, onClose, onSaved }: {
  capabilities: Capability[]; capabilityId?: string; parameters?: Record<string, Json>; schedule?: ScheduleRecord;
  onClose: () => void; onSaved: (schedule: ScheduleRecord) => void;
}) {
  const valid = capabilities.filter(cap => cap.status === 'READY' && cap.manifest);
  const initialTarget = schedule?.capability_id ?? capabilityId ?? valid[0]?.id ?? '';
  const [selectedTarget, setTarget] = useState(initialTarget);
  const target = selectedTarget || valid[0]?.id || '';
  const capability = valid.find(cap => cap.id === target);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => ({
    [initialTarget]: JSON.stringify(schedule?.parameters ?? parameters ?? defaultParameters(valid.find(cap => cap.id === initialTarget)), null, 2),
  }));
  const input = drafts[target] ?? JSON.stringify(defaultParameters(capability), null, 2);
  const setInput = (value: string) => setDrafts(previous => ({ ...previous, [target]: value }));
  const [name, setName] = useState(schedule?.name ?? '');
  const [kind, setKind] = useState<'interval' | 'cron'>(schedule?.schedule_type ?? 'interval');
  const [expression, setExpression] = useState(schedule?.expression ?? '300');
  const [preset, setPreset] = useState(schedule ? `custom-${schedule.schedule_type}` : '300');
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [inputError, setInputError] = useState('');
  const editor = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  function choosePreset(value: string) {
    setPreset(value);
    if (value === 'daily') { setKind('cron'); setExpression('0 9 * * *'); }
    else if (value === 'custom-cron') { setKind('cron'); setExpression('*/15 * * * *'); }
    else { setKind('interval'); setExpression(value === 'custom-interval' ? '300' : value); }
  }
  function readInput(): Record<string, Json> | undefined {
    try { const parsed = parseParameters(input); setInputError(''); return parsed; }
    catch (error) { setInputError(error instanceof Error ? error.message : 'Invalid input JSON'); editor.current?.focus(); }
  }
  function formatInput() {
    const parsed = readInput();
    if (parsed) setInput(JSON.stringify(parsed, null, 2));
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setError('');
    const inputs = readInput();
    if (!inputs || !capability) return;
    setBusy(true);
    try {
      const payload = { name: name.trim(), schedule_type: kind, expression: expression.trim(), parameters: inputs, enabled };
      const saved = schedule ? await updateSchedule(schedule.id, payload) : await createSchedule({ ...payload, capability_id: target });
      onSaved(saved); onClose();
    } catch (error) { setError(requestMessage(error)); }
    finally { setBusy(false); }
  }
  return <Modal title={schedule ? 'Edit schedule' : 'New schedule'} onClose={onClose} busy={busy}>
    {capability?.manifest ? <form className="creator-form schedule-metadata" onSubmit={event => void save(event)}>
      <p className="modal-intro">Times use UTC. Overlapping executions are skipped; five consecutive failures pause the schedule.</p>
      <label>Capability<select value={target} disabled={busy || Boolean(schedule)} onChange={event => { setTarget(event.target.value); setInputError(''); setError(''); }}>{valid.map(cap => <option key={cap.id} value={cap.id}>{cap.manifest!.name}</option>)}</select></label>
      <label>Schedule name<input required maxLength={100} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <label>Cadence<select value={preset} disabled={busy} onChange={event => choosePreset(event.target.value)}><option value="60">Every 1 min</option><option value="300">Every 5 mins</option><option value="3600">Every 1 hour</option><option value="daily">Daily at 09:00 UTC</option><option value="custom-interval">Custom interval</option><option value="custom-cron">Custom cron</option></select></label>
      {preset.startsWith('custom-') && <label>{kind === 'cron' ? 'Cron expression (UTC)' : 'Interval (seconds)'}<input required value={expression} maxLength={120} disabled={busy} onChange={event => setExpression(event.target.value)} /><small>{kind === 'cron' ? 'minute hour day-of-month month day-of-week; use *, */n, lists or ranges.' : 'At least 10 seconds.'}</small></label>}
      <label className="schedule-enabled"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} />Enable schedule</label>
      <div className="schedule-json-heading"><label htmlFor={inputId}>Input JSON</label><div className="schedule-toolbar"><button type="button" className="button secondary" disabled={busy} onClick={formatInput}>Format JSON</button><button type="button" className="button secondary" disabled={busy} onClick={() => { setInput(JSON.stringify(defaultParameters(capability), null, 2)); setInputError(''); setError(''); }}>Load defaults</button></div></div>
      <p id={`${inputId}-hint`} className="category-hint">A JSON object is passed to the script on stdin. Use true/false for flags. Keys and values must match the input contract below.</p>
      <textarea ref={editor} id={inputId} className="code-input schedule-json-input" rows={12} value={input} disabled={busy} spellCheck={false} aria-invalid={Boolean(inputError)} aria-describedby={`${inputId}-hint${inputError ? ` ${inputId}-error` : ''}`} onChange={event => { setInput(event.target.value); setInputError(''); setError(''); }} />
      {inputError && <div id={`${inputId}-error`} className="inline-error" role="alert">{inputError}</div>}
      <details className="schedule-input-contract"><summary>Input contract (JSON Schema)</summary><pre className="json-output">{JSON.stringify(capability.manifest.input_schema, null, 2)}</pre></details>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'Saving…' : schedule ? 'Save schedule' : 'Create schedule'}</button></div>
    </form> : <div className="creator-form"><p className="modal-intro">A READY capability is required. Repair or register a capability first.</p><button className="button secondary" onClick={onClose}>Close</button></div>}
  </Modal>;
}
