import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { api } from './api';
import type { Capability } from './types';

vi.mock('./api', () => ({ api: vi.fn(), fetchSchedules: vi.fn(async () => []) }));
const request = vi.mocked(api);
const capabilities = ['one', 'two'].map(id => ({ id, status: 'READY', diagnostics: [], manifest: {
  id, name: id, description: 'Test capability', author: 'Team', version: '1.0.0', category: 'Utilities',
  timeout_seconds: 10, python_dependencies: [], input_schema: { type: 'object', properties: {} },
  ui_component: null, output_type: 'json',
} })) as Capability[];

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  request.mockImplementation(async path => {
    if (path === '/capabilities') return capabilities;
    if (path === '/runs?limit=50') return [{ id: 'a', status: 'succeeded', capability_id: 'one', created_at: '2026-11-12T10:00:00Z', duration_ms: 10 }, { id: 'b', status: 'failed', capability_id: 'two', created_at: '2026-11-12T10:00:00Z', duration_ms: 10 }];
    return { key: path, status: path.includes('/one/') ? 'ready' : 'cold', dependencies: [] };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); request.mockReset(); });

it('counts cached environments rather than assuming every valid manifest is healthy', async () => {
  render(<App />);
  await waitFor(() => expect(screen.getByText('Healthy environments')).toHaveTextContent('1'));
  expect(screen.getByText('Active capabilities')).toHaveTextContent('2');
  expect(screen.getByText('Dependency environments')).toHaveTextContent('1');
  expect(screen.getByText('Recent executions')).toHaveTextContent('2/ 1 successful');
});

it('keeps the catalog available when environment inspection fails', async () => {
  request.mockImplementation(async path => {
    if (path === '/capabilities') return capabilities;
    if (path === '/runs?limit=50') return [];
    throw new Error('Inspection unavailable');
  });
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'one' })).toBeVisible();
  await waitFor(() => expect(screen.getByText('Active capabilities')).toHaveTextContent('2'));
  expect(screen.getByText('Healthy environments')).toHaveTextContent('—');
  expect(screen.getByText('Dependency environments')).toHaveTextContent('—');
});
