import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AssignCategoryModal, CategoryModal } from './CategoryModal';
import { RegisterModal } from './RegisterModal';
import { api } from './api';
import type { Capability } from './types';

vi.mock('./api', () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const cap = (id: string, category = 'Original') => ({ id, status: 'READY', diagnostics: [], manifest: { id, name: id, category, description: 'Test', author: 'Team', version: '1.0.0', timeout_seconds: 10, python_dependencies: [], input_schema: { type: 'object', properties: {} }, ui_component: null, output_type: 'json' } }) as Capability;
afterEach(() => { cleanup(); request.mockReset(); });

it('assigns a capability to a newly named category', async () => {
  const updated = vi.fn(), close = vi.fn();
  request.mockResolvedValue(cap('one', 'Engineering'));
  render(<AssignCategoryModal capability={cap('one')} categories={['Original', 'Utilities']} onClose={close} onUpdated={updated} />);
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: ' Engineering ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save category' }));
  await waitFor(() => expect(updated).toHaveBeenCalledWith([cap('one', 'Engineering')]));
  expect(request).toHaveBeenCalledWith('/capabilities/one/category', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ category: 'Engineering' }) }));
  expect(close).toHaveBeenCalledOnce();
});

it('reports partial bulk failures and retries only the remaining capabilities', async () => {
  const closed = vi.fn();
  function Harness() {
    const [caps, setCaps] = useState([cap('one'), cap('two')]);
    return <CategoryModal capabilities={caps} onClose={closed} onUpdated={updated => setCaps(previous => previous.map(item => updated.find(value => value.id === item.id) ?? item))} />;
  }
  request.mockResolvedValueOnce(cap('one', 'Engineering')).mockRejectedValueOnce(new Error('Read-only registry')).mockResolvedValueOnce(cap('two', 'Engineering'));
  render(<Harness />);
  fireEvent.change(screen.getByLabelText('New category name'), { target: { value: 'Engineering' } });
  fireEvent.click(screen.getByRole('button', { name: 'Rename category' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('1 saved. Retry the remaining capabilities: two: Read-only registry');
  expect(closed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Rename category' }));
  await waitFor(() => expect(closed).toHaveBeenCalledOnce());
  expect(request.mock.calls.map(call => call[0])).toEqual(['/capabilities/one/category', '/capabilities/two/category', '/capabilities/two/category']);
});

it('removes a category by moving its capabilities to the chosen destination', async () => {
  request.mockResolvedValue(cap('one', 'Utilities'));
  const updated = vi.fn();
  render(<CategoryModal capabilities={[cap('one')]} onClose={() => {}} onUpdated={updated} />);
  fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'remove' } });
  fireEvent.change(screen.getByLabelText('Move capabilities to'), { target: { value: 'Utilities' } });
  fireEvent.click(screen.getByRole('button', { name: 'Move and remove category' }));
  await waitFor(() => expect(updated).toHaveBeenCalledWith([cap('one', 'Utilities')]));
});

it('includes the selected category when registering a capability', async () => {
  request.mockResolvedValue(cap('new-tool', 'Engineering'));
  const created = vi.fn();
  render(<RegisterModal categories={['Engineering']} onClose={() => {}} onCreated={created} />);
  fireEvent.change(screen.getByLabelText('Capability name'), { target: { value: 'New tool' } });
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Registration test' } });
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Engineering' } });
  fireEvent.click(screen.getByRole('button', { name: 'Register capability' }));
  await waitFor(() => expect(created).toHaveBeenCalledOnce());
  expect(JSON.parse(String(request.mock.calls[0][1]?.body)).manifest.category).toBe('Engineering');
});
