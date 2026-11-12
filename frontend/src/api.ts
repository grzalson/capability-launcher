import type { ExecutionRecord, ScheduleCreatePayload, ScheduleUpdatePayload, ScheduleRecord } from './types';

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options, headers: { 'Content-Type': 'application/json', ...options?.headers },
    signal: options?.signal ?? AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.detail ?? `Request failed (${response.status})`;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return body as T;
}

export const fetchSchedules = (capabilityId?: string) => api<ScheduleRecord[]>(`/schedules${capabilityId ? `?capability_id=${encodeURIComponent(capabilityId)}` : ''}`);
export const createSchedule = (payload: ScheduleCreatePayload) => api<ScheduleRecord>('/schedules', { method: 'POST', body: JSON.stringify(payload) });
export const updateSchedule = (id: string, payload: ScheduleUpdatePayload) => api<ScheduleRecord>(`/schedules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
export const triggerSchedule = (id: string) => api<ExecutionRecord>(`/schedules/${encodeURIComponent(id)}/trigger`, { method: 'POST' });
export const deleteSchedule = (id: string) => api<void>(`/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
