import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { LoaderCircle, Play, RotateCcw } from 'lucide-react';
import Ajv from 'ajv';
import type { InputSchema, Json } from './types';

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

export function defaults(schema: InputSchema, initialInputs?: Record<string, Json>): Record<string, string | boolean> {
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, field]) => {
    const value = initialInputs && key in initialInputs ? initialInputs[key] : field.default;
    return [key, field.type === 'boolean' ? Boolean(value) : value === undefined ? '' :
      field.type === 'object' || field.type === 'array' ? JSON.stringify(value, null, 2) : String(value)];
  }));
}

export function DynamicForm({ schema, busy, onRun, onSchedule, initialInputs, header, submitLabel = 'Run capability', busyLabel = 'Running capability…' }: {
  schema: InputSchema; busy: boolean; onRun: (inputs: Record<string, Json>) => Promise<void>;
  onSchedule?: (inputs: Record<string, Json>) => void; initialInputs?: Record<string, Json>;
  header?: ReactNode; submitLabel?: string; busyLabel?: string;
}) {
  const prefix = useId();
  const [values, setValues] = useState(() => defaults(schema, initialInputs));
  const [errors, setErrors] = useState<string[]>([]);
  function reset() { setValues(defaults(schema, initialInputs)); setErrors([]); }
  async function submit(event: FormEvent, action = onRun) {
    event.preventDefault();
    const inputs: Record<string, Json> = {};
    try {
      for (const [key, field] of Object.entries(schema.properties ?? {})) {
        const raw = values[key];
        if (raw === '' && !schema.required?.includes(key) && field.default === undefined) continue;
        if (field.enum) {
          inputs[key] = field.enum.find(value => String(value) === String(raw)) ?? null;
        } else if (field.type === 'array' || field.type === 'object') {
          try { inputs[key] = JSON.parse(String(raw)); } catch { throw new Error(`${field.title ?? key}: enter valid JSON`); }
        } else if (field.type === 'number' || field.type === 'integer') {
          inputs[key] = raw === '' ? null : Number(raw);
        } else { inputs[key] = raw as Json; }
      }
      const validate = ajv.compile(schema);
      if (!validate(inputs)) {
        setErrors(validate.errors?.map(error => `${error.instancePath.slice(1) || 'Inputs'} ${error.message}`) ?? ['Check your inputs']);
        return;
      }
      setErrors([]);
      await action(inputs);
    } catch (error) { setErrors([error instanceof Error ? error.message : 'Could not run capability']); }
  }
  return <form onSubmit={event => void submit(event)} className="dynamic-form">
    {header}
    {Object.entries(schema.properties ?? {}).map(([key, field]) => {
      const id = `${prefix}-input-${key}`;
      const isJson = ['object', 'array'].includes(field.type ?? '');
      const required = schema.required?.includes(key);
      const update = (value: string | boolean) => setValues(previous => ({ ...previous, [key]: value }));
      if (field.type === 'boolean') return <label className="toggle-field" key={key} htmlFor={id}>
        <span><strong>{field.title ?? key}</strong>{field.description && <small>{field.description}</small>}</span>
        <input id={id} type="checkbox" checked={Boolean(values[key])} onChange={event => update(event.target.checked)} disabled={busy} />
      </label>;
      return <div className="field" key={key}>
        <label htmlFor={id}>{field.title ?? key}{required && <span className="required">*</span>}{isJson && <span className="field-tag">JSON</span>}</label>
        {field.description && <p className="field-description" id={`${id}-hint`}>{field.description}</p>}
        {field.enum ? <select id={id} value={String(values[key])} onChange={event => update(event.target.value)} disabled={busy} aria-describedby={field.description ? `${id}-hint` : undefined}>
          <option value="" disabled>Select an option</option>{field.enum.map(value => <option key={String(value)} value={String(value)}>{String(value).replaceAll('_', ' ')}</option>)}
        </select> : isJson || field.format === 'textarea' ?
          <textarea id={id} className="code-input" rows={key === 'logs' ? 12 : 7} value={String(values[key] ?? '')} onChange={event => update(event.target.value)} disabled={busy} spellCheck={false} aria-describedby={field.description ? `${id}-hint` : undefined} /> :
          <input id={id} type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
            min={field.minimum} max={field.maximum} step={field.type === 'integer' ? 1 : field.multipleOf ?? 'any'}
            minLength={field.minLength} maxLength={field.maxLength} value={String(values[key] ?? '')}
            onChange={event => update(event.target.value)} disabled={busy} aria-describedby={field.description ? `${id}-hint` : undefined} />}
      </div>;
    })}
    {errors.length > 0 && <div className="inline-error" role="alert">{errors.map((error, i) => <p key={i}>{error}</p>)}</div>}
    <div className="form-actions"><button className="button primary" type="submit" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <Play size={15} fill="currentColor" />}{busy ? busyLabel : submitLabel}</button>
      {onSchedule && <button type="button" className="button secondary" disabled={busy} onClick={event => void submit(event, async inputs => onSchedule(inputs))}>Schedule…</button>}
      <button type="button" className="icon-button" title="Reset inputs" aria-label="Reset inputs" onClick={reset} disabled={busy}><RotateCcw size={16} /></button></div>
  </form>;
}
