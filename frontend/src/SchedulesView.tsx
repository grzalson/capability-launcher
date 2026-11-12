import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { deleteSchedule, triggerSchedule, updateSchedule } from './api';
import type { Capability, ScheduleRecord } from './types';

const time = (value: string | null) => value ? `${new Date(value).toLocaleString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })} UTC` : '—';
export function cadence(schedule: ScheduleRecord) {
  if (schedule.schedule_type === 'cron') return `cron: ${schedule.expression}`;
  const seconds = Number(schedule.expression);
  return `Every ${seconds % 3600 === 0 ? `${seconds / 3600}h` : seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`} (${seconds}s)`;
}
export function SchedulesView({ schedules, capabilities, onNew, onEdit, onRefresh, onCapability, onRun, compact = false, loading = false }: {
  schedules: ScheduleRecord[]; capabilities: Capability[]; onNew?: () => void; onEdit: (schedule: ScheduleRecord) => void;
  onRefresh: () => Promise<void>; onCapability: (id: string) => void; onRun: (id: string) => void; compact?: boolean; loading?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState('');
  async function action(schedule: ScheduleRecord, kind: 'toggle' | 'run' | 'delete') {
    setBusy(schedule.id); setError('');
    try {
      if (kind === 'delete') { await deleteSchedule(schedule.id); setDeleting(null); }
      else if (kind === 'toggle') await updateSchedule(schedule.id, { enabled: !schedule.enabled });
      else { const run = await triggerSchedule(schedule.id); onRun(run.id); }
      await onRefresh();
    } catch (error) { setError(error instanceof Error ? error.message : 'Schedule action failed'); }
    finally { setBusy(null); }
  }
  return <section className={compact ? 'capability-schedules' : 'schedules-page'}>
    <div className="page-heading"><div>{compact ? <h2>Schedules ({schedules.length})</h2> : <><h1>Schedules</h1><p>Recurring capability executions. All times are UTC.</p></>}</div><div className="schedule-toolbar"><button className="button secondary" onClick={() => void onRefresh().catch(error => setError(String(error)))}><RefreshCw size={15} />Refresh</button>{onNew && <button className="button primary" onClick={onNew}><Plus size={16} />New schedule</button>}</div></div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {loading ? <p className="modal-intro">Loading schedules…</p> : !schedules.length ? <div className="activity-empty">No schedules yet.{compact ? ' Use Schedule… beside Run capability to create one with the current inputs.' : ' Create a schedule to run a capability automatically.'}</div> : <div className="table-scroll run-table" role="region" aria-label="Schedules table" tabIndex={0}><table className="schedules-table"><thead><tr><th>Name / capability</th><th>Cadence</th><th>Status</th><th>Next / last run (UTC)</th><th>Actions</th></tr></thead><tbody>{schedules.map(schedule => {
      const running = schedule.last_status === 'RUNNING';
      const autoPaused = !schedule.enabled && schedule.consecutive_failures >= 5;
      const outcome = <span className={`status ${schedule.last_status === 'COMPLETED' ? 'status-ready' : running ? 'status-running' : 'status-failed'}`}>{schedule.last_status ?? 'No result'}</span>;
      const status = running ? 'RUNNING' : autoPaused ? 'AUTO-PAUSED (5 failures)' : schedule.enabled ? 'ACTIVE' : 'PAUSED';
      return <tr key={schedule.id}><td><strong>{schedule.name}</strong><button className="schedule-capability" onClick={() => onCapability(schedule.capability_id)}>{capabilities.find(cap => cap.id === schedule.capability_id)?.manifest?.name ?? schedule.capability_id}</button></td>
        <td><code className="cadence-badge">{cadence(schedule)}</code></td><td><span className={`status ${running ? 'status-running' : schedule.enabled ? 'status-ready' : autoPaused ? 'status-failed' : 'status-interrupted'}`}>{status}</span>{schedule.last_error && <p className="schedule-error">{schedule.last_error}</p>}</td>
        <td><div>Next: {time(schedule.next_run_at)}</div><div className="schedule-last">Last: {time(schedule.last_run_at)}</div>{schedule.last_run_id ? <button className="schedule-outcome" onClick={() => onRun(schedule.last_run_id!)}>{outcome}</button> : schedule.last_status && <span className="schedule-outcome">{outcome}</span>}</td>
        <td><div className="schedule-actions">{deleting === schedule.id ? <><span>Delete this schedule?{running && ' Its current run will finish.'}</span><button className="button secondary" disabled={busy !== null} onClick={() => void action(schedule, 'delete')}>Confirm delete</button><button className="button secondary" disabled={busy !== null} onClick={() => setDeleting(null)}>Cancel</button></> : <><button className="button secondary" disabled={busy !== null} aria-label={`${schedule.enabled ? 'Pause' : 'Resume'} ${schedule.name}`} onClick={() => void action(schedule, 'toggle')}>{schedule.enabled ? 'Pause' : 'Resume'}</button><button className="button secondary" disabled={busy !== null || running} onClick={() => void action(schedule, 'run')}>Run now</button><button className="button secondary" disabled={busy !== null} onClick={() => onEdit(schedule)}>Edit</button><button className="button secondary" disabled={busy !== null} aria-label={`Delete ${schedule.name}`} onClick={() => setDeleting(schedule.id)}>Delete</button></>}</div>{busy === schedule.id && <p role="status" className="category-hint">Saving…</p>}</td></tr>;
    })}</tbody></table></div>}
  </section>;
}
