import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditCapabilityModal } from './EditCapabilityModal';
import { api } from './api';
vi.mock('./api', () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const manifest = { id: 'edit-tool', name: 'Original', description: 'Test', author: 'Team', version: '1.0', category: 'Utilities', python_dependencies: [], input_schema: { type: 'object', properties: {} }, timeout_seconds: 30, output_type: 'json' };
const source = { manifest_json: JSON.stringify(manifest, null, 2), script: "print('{}')", revision: 'a'.repeat(64) };
afterEach(() => { cleanup(); request.mockReset(); });

it('loads and saves full capability files with the revision it opened', async () => {
  request.mockResolvedValueOnce(source).mockResolvedValueOnce({ id: 'edit-tool', status: 'READY', manifest: { ...manifest, name: 'Updated' }, diagnostics: [] });
  const saved = vi.fn(), close = vi.fn();
  render(<EditCapabilityModal capabilityId="edit-tool" onClose={close} onSaved={saved} />);
  await screen.findByLabelText('Manifest JSON');
  fireEvent.change(screen.getByLabelText('Manifest JSON'), { target: { value: JSON.stringify({ ...manifest, name: 'Updated', version: '2.0', timeout_seconds: 50 }) } });
  fireEvent.change(screen.getByLabelText('Python script'), { target: { value: "print('updated')" } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(close).toHaveBeenCalledOnce();
  expect(request.mock.calls[1][0]).toBe('/capabilities/edit-tool');
  expect(request.mock.calls[1][1]?.method).toBe('PUT');
  expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toMatchObject({ manifest: { id: 'edit-tool', name: 'Updated', version: '2.0', timeout_seconds: 50 }, script: "print('updated')", revision: source.revision });
});

it.each(['{bad', '{"id":"changed-id"}'])('keeps invalid or renamed drafts out of the API: %s', async value => {
  request.mockResolvedValue(source);
  render(<EditCapabilityModal capabilityId="edit-tool" onClose={() => {}} onSaved={() => {}} />);
  await screen.findByLabelText('Manifest JSON');
  fireEvent.change(screen.getByLabelText('Manifest JSON'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.getByLabelText('Manifest JSON')).toHaveValue(value);
  expect(request).toHaveBeenCalledTimes(1);
});

it('preserves conflicting drafts and reloads only on explicit request', async () => {
  request.mockResolvedValueOnce(source).mockRejectedValueOnce(new Error('Files changed since this editor opened. Reload the latest files before saving.')).mockResolvedValueOnce({ ...source, script: "print('remote')", revision: 'b'.repeat(64) });
  render(<EditCapabilityModal capabilityId="edit-tool" onClose={() => {}} onSaved={() => {}} />);
  await screen.findByLabelText('Python script');
  fireEvent.change(screen.getByLabelText('Python script'), { target: { value: "print('draft')" } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Files changed');
  expect(screen.getByLabelText('Python script')).toHaveValue("print('draft')");
  fireEvent.click(screen.getByRole('button', { name: 'Reload latest files' }));
  await waitFor(() => expect(screen.getByLabelText('Python script')).toHaveValue("print('remote')"));
});
