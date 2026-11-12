import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import App from './App';
import { ScheduleModal } from './ScheduleModal';
import { TriggerBadge } from './TriggerBadge';
import { CapabilityErrorBoundary } from './CapabilityErrorBoundary';
import { DynamicForm } from './DynamicForm';
import { CustomCapabilityRegistry } from './CustomCapabilityRegistry';
import type { Manifest } from './types';

it('keeps the host alive when a custom widget throws', () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const Widget = CustomCapabilityRegistry.FaultDemoView;
  render(<><p>Host navigation</p><CapabilityErrorBoundary><Widget result={{ crash_widget: true }} manifest={{} as Manifest} /></CapabilityErrorBoundary></>);
  expect(screen.getByText('Host navigation')).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('Intentional widget crash');
  consoleError.mockRestore();
});

it('submits typed number, boolean, and JSON fields rather than strings', async () => {
  const onRun = vi.fn().mockResolvedValue(undefined);
  render(<DynamicForm busy={false} onRun={onRun} schema={{ type: 'object', required: ['count', 'rows'], properties: {
    count: { type: 'integer', title: 'Count', minimum: 1, default: 3 },
    rows: { type: 'array', title: 'Rows', default: [{ n: 2 }] },
    enabled: { type: 'boolean', title: 'Enabled', default: true },
  } }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Run capability' }));
  await waitFor(() => expect(onRun).toHaveBeenCalledWith({ count: 3, rows: [{ n: 2 }], enabled: true }));
});

it('isolates invalid JSON input to the form and supports reset', async () => {
  const onRun = vi.fn();
  render(<DynamicForm busy={false} onRun={onRun} schema={{ type: 'object', required: ['rows'], properties: { rows: { type: 'array', title: 'Rows', default: [] } } }} />);
  fireEvent.change(screen.getByLabelText(/Rows/), { target: { value: 'broken {' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run capability' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('enter valid JSON');
  expect(onRun).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Reset inputs' }));
  expect(screen.getByLabelText(/Rows/)).toHaveValue('[]');
});

it('enforces the schema before submitting an integer field', async () => {
  const onRun = vi.fn();
  const { container } = render(<DynamicForm busy={false} onRun={onRun} schema={{ type: 'object', required: ['count'], properties: { count: { type: 'integer', title: 'Count', minimum: 1, default: 1 } } }} />);
  fireEvent.change(screen.getByLabelText(/Count/), { target: { value: '1.5' } });
  fireEvent.submit(container.querySelector('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent('must be integer');
  expect(onRun).not.toHaveBeenCalled();
});


const schedulerCapability = { id: 'scheduled-tool', status: 'READY', diagnostics: [], manifest: {
  id: 'scheduled-tool', name: 'Scheduled tool', description: 'A test tool', author: 'Tests', version: '1.0.0',
  category: 'Tests', python_dependencies: [], timeout_seconds: 10, ui_component: null, output_type: 'json',
  input_schema: { type: 'object', required: ['count'], properties: { count: { type: 'integer', title: 'Count', default: 1 } } },
} };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('renders the Schedules navigation, saved jobs, and manual/scheduled history badges', async () => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const data = url === '/api/capabilities' ? [schedulerCapability] : url === '/api/schedules' ? [{
      id: 'schedule-one', capability_id: 'scheduled-tool', name: 'Hourly check', schedule_type: 'interval', expression: '3600', parameters: { count: 2 }, enabled: true,
      next_run_at: '2026-11-13T09:00:00Z', last_run_at: null, last_run_id: null, last_status: null, consecutive_failures: 0, created_at: '2026-11-12T09:00:00Z', last_error: null,
    }] : url.includes('/environment') ? { key: 'test', status: 'ready', dependencies: [] } : url.startsWith('/api/runs') ? ['manual', 'scheduled'].map((trigger_type, index) => ({
      id: `run-${index}`, capability_id: 'scheduled-tool', status: 'succeeded', created_at: '2026-11-12T09:00:00Z', duration_ms: 10, trigger_type, schedule_id: index ? 'schedule-one' : null,
    })) : [];
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  render(<App />);
  expect(await screen.findByText('MANUAL')).toBeVisible();
  expect(screen.getByText('SCHEDULED')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /Schedules 1/ }));
  expect(await screen.findByText('Hourly check')).toBeVisible();
  expect(screen.getByText('Every 1h (3600s)')).toBeVisible();
  expect(screen.getByText('ACTIVE')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Run now' })).toBeVisible();
});

it('copies typed current parameters to scheduling without executing the capability', async () => {
  const schedule = vi.fn(), run = vi.fn();
  render(<DynamicForm schema={schedulerCapability.manifest.input_schema as import('./types').InputSchema} busy={false} onRun={run} onSchedule={schedule} />);
  fireEvent.change(screen.getByLabelText(/Count/), { target: { value: '17' } });
  fireEvent.click(screen.getByRole('button', { name: 'Schedule…' }));
  await waitFor(() => expect(schedule).toHaveBeenCalledWith({ count: 17 }));
  expect(run).not.toHaveBeenCalled();
});

it('prefills a universal JSON editor and submits the saved cadence', async () => {
  const saved = vi.fn();
  const fetch = vi.fn(async (_url, options) => new Response(JSON.stringify({ id: 'new-schedule', ...JSON.parse(options.body) }), { status: 201 }));
  vi.stubGlobal('fetch', fetch);
  render(<ScheduleModal capabilities={[schedulerCapability as import('./types').Capability]} capabilityId="scheduled-tool" parameters={{ count: 17 }} onClose={() => {}} onSaved={saved} />);
  expect(JSON.parse(String((screen.getByLabelText('Input JSON') as HTMLTextAreaElement).value))).toEqual({ count: 17 });
  expect(screen.queryByLabelText(/Count/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Schedule name'), { target: { value: 'My schedule' } });
  fireEvent.change(screen.getByLabelText('Cadence'), { target: { value: 'daily' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ capability_id: 'scheduled-tool', schedule_type: 'cron', expression: '0 9 * * *', parameters: { count: 17 } });
});

it('provides a manual attribution fallback for legacy records', () => {
  render(<TriggerBadge />);
  expect(screen.getByText('MANUAL')).toBeVisible();
});


it.each(['broken {', '[]', 'null', '"--count=3"', '{"count":1e309}'])('rejects invalid or non-object schedule input before sending: %s', async input => {
  const fetch = vi.fn(), saved = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(<ScheduleModal capabilities={[schedulerCapability as import('./types').Capability]} onClose={() => {}} onSaved={saved} />);
  fireEvent.change(screen.getByLabelText('Schedule name'), { target: { value: 'JSON validation' } });
  fireEvent.change(screen.getByLabelText('Input JSON'), { target: { value: input } });
  fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.getByLabelText('Input JSON')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByLabelText('Input JSON')).toHaveFocus();
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps separate JSON drafts for different capabilities and loads defaults on request', () => {
  const other = { ...schedulerCapability, id: 'other-tool', manifest: { ...schedulerCapability.manifest, id: 'other-tool', name: 'Other tool', input_schema: { type: 'object', properties: { dry_run: { type: 'boolean', default: false } } } } } as import('./types').Capability;
  render(<ScheduleModal capabilities={[schedulerCapability as import('./types').Capability, other]} onClose={() => {}} onSaved={() => {}} />);
  expect(screen.getByLabelText('Input JSON')).toHaveValue(JSON.stringify({ count: 1 }, null, 2));
  fireEvent.change(screen.getByLabelText('Input JSON'), { target: { value: '{"count":9,"nested":{"flags":[true,false]}}' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Capability' }), { target: { value: 'other-tool' } });
  expect(screen.getByLabelText('Input JSON')).toHaveValue(JSON.stringify({ dry_run: false }, null, 2));
  fireEvent.change(screen.getByRole('combobox', { name: 'Capability' }), { target: { value: 'scheduled-tool' } });
  expect(screen.getByLabelText('Input JSON')).toHaveValue('{"count":9,"nested":{"flags":[true,false]}}');
  fireEvent.click(screen.getByRole('button', { name: 'Format JSON' }));
  expect(screen.getByLabelText('Input JSON')).toHaveValue(JSON.stringify({ count: 9, nested: { flags: [true, false] } }, null, 2));
  fireEvent.click(screen.getByRole('button', { name: 'Load defaults' }));
  expect(screen.getByLabelText('Input JSON')).toHaveValue(JSON.stringify({ count: 1 }, null, 2));
});

it('preserves arbitrary saved JSON parameters when editing a schedule', async () => {
  const parameters = { count: 8, dry_run: false, config: { paths: ['a', 'b'], optional: null } };
  const schedule = { id: 'saved-schedule', name: 'Existing', capability_id: 'scheduled-tool', parameters, enabled: false, schedule_type: 'interval', expression: '300', created_at: '2026-11-12T09:00:00Z', next_run_at: null, last_run_at: null, last_run_id: null, last_status: null, consecutive_failures: 0, last_error: null } as import('./types').ScheduleRecord;
  const saved = vi.fn();
  const fetch = vi.fn(async (_url, options) => new Response(JSON.stringify({ ...schedule, ...JSON.parse(options.body) }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  render(<ScheduleModal capabilities={[schedulerCapability as import('./types').Capability]} schedule={schedule} onClose={() => {}} onSaved={saved} />);
  expect(screen.getByLabelText('Input JSON')).toHaveValue(JSON.stringify(parameters, null, 2));
  fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(fetch.mock.calls[0][0]).toBe('/api/schedules/saved-schedule');
  expect(JSON.parse(fetch.mock.calls[0][1].body).parameters).toEqual(parameters);
});

it('shows server input-contract validation errors without losing the JSON draft', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: [{ field: 'count', message: 'must be an integer' }] }), { status: 422 })));
  render(<ScheduleModal capabilities={[schedulerCapability as import('./types').Capability]} onClose={() => {}} onSaved={() => {}} />);
  fireEvent.change(screen.getByLabelText('Schedule name'), { target: { value: 'Invalid parameters' } });
  fireEvent.change(screen.getByLabelText('Input JSON'), { target: { value: '{"count":"wrong"}' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('count: must be an integer');
  expect(screen.getByLabelText('Input JSON')).toHaveValue('{"count":"wrong"}');
});
