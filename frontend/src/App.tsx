import { useCallback, useEffect, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Boxes, Braces, Check, CheckCircle2, ChevronRight, Clock3, Cloud, Code2, FileText, FlaskConical, History, Layers3, LayoutGrid, LoaderCircle, Plus, RefreshCw, Search, ShieldCheck, Terminal, X, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, fetchSchedules } from './api';
import { ScheduleModal } from './ScheduleModal';
import { SchedulesView } from './SchedulesView';
import { TriggerBadge } from './TriggerBadge';
import { CapabilityErrorBoundary } from './CapabilityErrorBoundary';
import { CustomCapabilityRegistry, RawResult, StandardResult } from './CustomCapabilityRegistry';
import { DynamicForm } from './DynamicForm';
import { Modal } from './Modal';
import { AssignCategoryModal, CategoryModal } from './CategoryModal';
import { RegisterModal } from './RegisterModal';
import { EditCapabilityModal } from './EditCapabilityModal';
import { isActive, type Capability, type Environment, type Json, type Run, type RunSummary, type ScheduleRecord } from './types';

const icons: Record<string, LucideIcon> = { 'log-pattern-analyzer': Activity, 'legacy-report-formatter': FileText, 'modern-data-profiler': Braces, 'cloud-cost-estimator': Cloud, 'broken-experimental-script': FlaskConical };
const tones: Record<string, string> = { 'log-pattern-analyzer': 'mint', 'legacy-report-formatter': 'sand', 'modern-data-profiler': 'blue', 'cloud-cost-estimator': 'purple', 'broken-experimental-script': 'rose' };
const pretty = (value: string) => value.replaceAll('_', ' ');
const duration = (ms: number | null) => ms === null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
const localTime = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function CapabilityIcon({ id, small = false }: { id: string; small?: boolean }) {
  const Icon = icons[id] ?? Code2;
  return <span className={`capability-icon ${tones[id] ?? 'mint'} ${small ? 'small' : ''}`}><Icon size={small ? 16 : 23} strokeWidth={1.7} /></span>;
}

function Status({ status }: { status: string }) {
  return <span className={`status status-${status.toLowerCase()}`}><i />{pretty(status === 'READY' ? 'Ready' : status === 'INVALID' ? 'Needs attention' : status)}</span>;
}

export default function App() {
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [environments, setEnvironments] = useState<Environment[] | null>(null);
  const [view, setView] = useState<'capabilities' | 'schedules'>('capabilities');
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [schedulesLoaded, setSchedulesLoaded] = useState(false);
  const [schedulesError, setSchedulesError] = useState('');
  const [scheduleDraft, setScheduleDraft] = useState<{ capabilityId?: string; parameters?: Record<string, Json>; schedule?: ScheduleRecord } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [editCapability, setEditCapability] = useState<string | null>(null);
  const [register, setRegister] = useState(false);
  const [manageCategories, setManageCategories] = useState(false);
  const [editCategory, setEditCategory] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [historyRun, setHistoryRun] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const refresh = useCallback(async () => {
    void fetchSchedules().then(values => { setSchedules(values); setSchedulesLoaded(true); setSchedulesError(''); }).catch(error => { setSchedulesError(error instanceof Error ? error.message : 'Could not load schedules'); setSchedulesLoaded(true); });
    try {
      const [caps, recent] = await Promise.all([api<Capability[]>('/capabilities'), api<RunSummary[]>('/runs?limit=50')]);
      setCapabilities(caps); setRuns(recent); setError('');
      const statuses = await Promise.allSettled(caps.filter(cap => cap.status === 'READY').map(cap => api<Environment>(`/capabilities/${encodeURIComponent(cap.id)}/environment`)));
      setEnvironments(statuses.every(status => status.status === 'fulfilled') ? statuses.flatMap(status => status.status === 'fulfilled' ? [status.value] : []) : null);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not connect to the API'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [selected]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4500); return () => clearTimeout(timer); }, [toast]);
  const openCapability = (id: string | null) => { setView('capabilities'); setSelected(id); };
  const active = capabilities.find(cap => cap.id === selected);
  const activeCount = capabilities.filter(cap => cap.status === 'READY').length;
  const healthyEnvironments = environments?.filter(environment => environment.status === 'ready').length;
  const cachedEnvironments = environments && new Set(environments.filter(environment => environment.status === 'ready').map(environment => environment.key)).size;
  const categories = ['', ...new Set(capabilities.map(cap => cap.manifest?.category ?? 'Needs attention'))];
  const filtered = capabilities.filter(cap => (category === '' || (cap.manifest?.category ?? 'Needs attention') === category) && `${cap.manifest?.name ?? cap.id} ${cap.manifest?.description ?? ''} ${cap.manifest?.author ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const updateCategories = (updated: Capability[]) => { setCapabilities(previous => previous.map(cap => updated.find(value => value.id === cap.id) ?? cap)); setCategory(''); };
  const openRun = (id: string) => { setHistoryRun(id); setHistory(true); };
  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => openCapability(null)} aria-label="Capability Launcher home"><span className="brand-mark"><Zap size={22} fill="currentColor" /></span><span>capability<span className="brand-sub">LAUNCHER</span></span></button>
      <p className="nav-label">WORKSPACE</p>
      <nav aria-label="Workspace"><button className={`nav-item ${view === 'capabilities' && selected === null ? 'active' : ''}`} onClick={() => openCapability(null)}><LayoutGrid size={17} />Capabilities<span className="nav-count">{capabilities.length}</span></button>
        <button className={`nav-item ${view === 'schedules' ? 'active' : ''}`} onClick={() => setView('schedules')}><Clock3 size={17} />Schedules<span className="nav-count">{schedules.filter(schedule => schedule.enabled).length}</span></button>
        <button className="nav-item" onClick={() => { setHistoryRun(null); setHistory(true); }}><History size={17} />Run history{runs.some(run => isActive(run.status)) && <span className="live-dot" />}</button></nav>
      <div className="nav-section-heading"><p className="nav-label">CAPABILITIES</p><button className="icon-button" title="Register a capability" aria-label="Register a capability" onClick={() => setRegister(true)}><Plus size={14} /></button></div>
      <nav aria-label="Capabilities" className="capability-nav">{capabilities.map(cap => <button key={cap.id} className={`nav-item capability-nav-item ${view === 'capabilities' && selected === cap.id ? 'active' : ''}`} onClick={() => openCapability(cap.id)}><CapabilityIcon id={cap.id} small /><span>{cap.manifest?.name ?? cap.id}</span>{cap.status === 'INVALID' && <i className="severity-dot error" />}</button>)}</nav>
    </aside>
    <div className="main-shell">
      <header className="topbar"><nav className="breadcrumb" aria-label="Breadcrumb"><button onClick={() => openCapability(null)}>Workspace</button><ChevronRight size={14} /><span aria-current="page">{view === 'schedules' ? 'Schedules' : active?.manifest?.name ?? active?.id ?? 'Capabilities'}</span></nav></header>
      <main>
        {error && <div className="connection-error" role="alert"><span>Connection interrupted · {error}</span><button onClick={() => void refresh()}><RefreshCw size={14} /> Retry</button></div>}
        {schedulesError && (view === 'schedules' || selected) && <div className="inline-error" role="alert">{schedulesError}</div>}
        {view === 'schedules' ? <SchedulesView schedules={schedules} capabilities={capabilities} loading={!schedulesLoaded} onNew={() => setScheduleDraft({})} onEdit={schedule => setScheduleDraft({ schedule })} onRefresh={refresh} onCapability={openCapability} onRun={openRun} /> : selected && active ? <CapabilityErrorBoundary key={selected}><CapabilityDetail capability={active} onBack={() => openCapability(null)} onComplete={refresh} onHistory={openRun} onEditCategory={() => setEditCategory(active.id)} onEditCapability={() => setEditCapability(active.id)} schedules={schedules.filter(schedule => schedule.capability_id === active.id)} capabilities={capabilities} onSchedule={parameters => setScheduleDraft({ capabilityId: active.id, parameters })} onEditSchedule={schedule => setScheduleDraft({ schedule })} /></CapabilityErrorBoundary> : selected && !loading ? <div className="empty-state"><Boxes size={35} /><h2>Capability no longer available</h2><button className="button secondary" onClick={() => openCapability(null)}>Back to capabilities</button></div> : <>
          <div className="page-heading"><div><h1>Internal Capabilities</h1><p>Manage and execute isolated Python automation scripts.</p></div><button className="button primary" onClick={() => setRegister(true)}><Plus size={17} />New capability</button></div>
          <div className="overview-stats" aria-label="Workspace summary"><div><span className="stat-icon"><Boxes size={19} /></span><p>Active capabilities<strong>{loading ? '—' : activeCount}<small>{schedules.filter(schedule => schedule.enabled).length} scheduled jobs</small></strong></p></div><div><span className="stat-icon"><CheckCircle2 size={19} /></span><p>Healthy environments<strong>{healthyEnvironments ?? '—'}</strong></p></div><div title="Cached virtual environments for current capabilities"><span className="stat-icon"><Layers3 size={19} /></span><p>Dependency environments<strong>{cachedEnvironments ?? '—'}</strong></p></div><div title="Latest 50 executions"><span className="stat-icon"><Terminal size={19} /></span><p>Recent executions<strong>{loading ? '—' : runs.length}<small>/ {runs.filter(run => run.status === 'succeeded').length} successful</small></strong></p></div></div>
          <div className="catalog-heading"><div><h2>Capability library <span>{capabilities.length}</span></h2></div><div className="search"><Search size={17} /><input placeholder="Find a capability…" aria-label="Find a capability" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="icon-button" aria-label="Clear search" onClick={() => setQuery('')}><X size={14} /></button>}</div></div>
          <div className="filter-row"><div className="category-tabs" aria-label="Filter capabilities">{categories.map(item => <button key={item} className={category === item ? 'selected' : ''} onClick={() => setCategory(item)}>{item || 'All capabilities'}</button>)}</div><div className="filter-actions"><button className="refresh-button" disabled={loading} onClick={() => setManageCategories(true)}>Manage categories</button><button className="refresh-button" onClick={() => void refresh()} title="Rescan capability folders"><RefreshCw size={14} />Refresh</button></div></div>
          {loading ? <div className="empty-state"><LoaderCircle size={28} className="spin" /><p>Loading capabilities…</p></div> : filtered.length ? <div className="capability-grid">{filtered.map(cap => <CapabilityErrorBoundary key={cap.id}><article className={`capability-card ${cap.status === 'INVALID' ? 'invalid' : ''}`}>
            <div className="card-top"><CapabilityIcon id={cap.id} /><div className="card-actions"><Status status={cap.status} /><button className="button secondary" aria-label={`Edit ${cap.manifest?.name ?? cap.id}`} onClick={() => setEditCapability(cap.id)}>Edit</button></div></div><div className="card-category">{cap.manifest?.category ?? 'Needs attention'}</div><h3><button className="capability-title" onClick={() => openCapability(cap.id)}>{cap.manifest?.name ?? cap.id}</button></h3><p>{cap.manifest?.description ?? cap.diagnostics[0]}</p>
            <div className="card-tags">{cap.manifest?.ui_component && <span><Boxes size={11} />Custom view</span>}{cap.manifest?.python_dependencies.length ? cap.manifest.python_dependencies.map(dep => <span className="dependency-chip" key={dep}>{dep.replace('==', ' ')}</span>) : <span><Code2 size={11} />Python standard library</span>}</div>
            <div className="card-footer"><span>{cap.manifest?.author ?? 'Invalid manifest'}</span><button className="card-open" aria-label={`Open ${cap.manifest?.name ?? cap.id}`} onClick={() => openCapability(cap.id)}>Open capability <ArrowUpRight size={15} /></button></div>
          </article></CapabilityErrorBoundary>)}</div> : <div className="empty-state"><Search size={30} /><h3>No capabilities found</h3><p>Try a different search or category.</p><button className="button secondary" onClick={() => { setCategory(''); setQuery(''); }}>Clear filters</button></div>}
          <div className="recent-heading"><h2>Recent activity</h2><button onClick={() => { setHistoryRun(null); setHistory(true); }}>View run history <ArrowRight size={14} /></button></div>
          {runs.length ? <RunTable runs={runs.slice(0, 4)} capabilities={capabilities} onSelect={openRun} /> : <div className="activity-empty"><Terminal size={20} /><p>No executions yet. Run a capability to record its output and logs.</p></div>}

        </>}
      </main>
    </div>
    {editCapability && <EditCapabilityModal key={editCapability} capabilityId={editCapability} onClose={() => setEditCapability(null)} onSaved={saved => { setCapabilities(previous => previous.map(cap => cap.id === saved.id ? saved : cap)); setCategory(''); setToast(`${saved.manifest?.name ?? saved.id} updated`); void refresh(); }} />}
    {scheduleDraft && <ScheduleModal {...scheduleDraft} capabilities={capabilities} onClose={() => setScheduleDraft(null)} onSaved={saved => { setSchedules(previous => [...previous.filter(schedule => schedule.id !== saved.id), saved]); void refresh(); }} />}
    {manageCategories && <CategoryModal capabilities={capabilities.filter(cap => cap.status === 'READY')} onClose={() => setManageCategories(false)} onUpdated={updateCategories} />}
    {editCategory && capabilities.find(cap => cap.id === editCategory) && <AssignCategoryModal key={editCategory} capability={capabilities.find(cap => cap.id === editCategory)!} categories={categories.filter(Boolean)} onClose={() => setEditCategory(null)} onUpdated={updateCategories} />}
    {register && <RegisterModal categories={categories.filter(Boolean)} onClose={() => setRegister(false)} onCreated={cap => { setRegister(false); openCapability(cap.id); setCapabilities(previous => [...previous, cap]); setToast(`${cap.manifest?.name} registered`); void refresh(); }} />}
    {history && <HistoryDrawer runs={runs} capabilities={capabilities} initialRun={historyRun} onClose={() => setHistory(false)} />}
    {toast && <div className="toast" role="status"><CheckCircle2 size={17} />{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></button></div>}
  </div>;
}

function CapabilityDetail({ capability, onBack, onComplete, onHistory, onEditCategory, onEditCapability, schedules, capabilities, onSchedule, onEditSchedule }: {
  capability: Capability; onBack: () => void; onComplete: () => Promise<void>; onHistory: (id: string) => void; onEditCategory: () => void; onEditCapability: () => void;
  schedules: ScheduleRecord[]; capabilities: Capability[]; onSchedule: (parameters: Record<string, Json>) => void; onEditSchedule: (schedule: ScheduleRecord) => void;
}) {
  const manifest = capability.manifest;
  const [run, setRun] = useState<Run | null>(null);
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [tab, setTab] = useState('result');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let disposed = false;
    api<RunSummary[]>(`/runs?capability_id=${encodeURIComponent(capability.id)}&limit=1`).then(async recent => {
      if (recent[0]) { const last = await api<Run>(`/runs/${recent[0].id}`); if (!disposed) setRun(previous => previous ?? last); }
    }).catch(() => {});
    const checkEnvironment = () => { if (manifest) api<Environment>(`/capabilities/${capability.id}/environment`).then(value => { if (!disposed) setEnvironment(value); }).catch(() => {}); };
    checkEnvironment(); const timer = setInterval(checkEnvironment, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [capability.id, manifest]);
  useEffect(() => {
    if (!run || run.finished_at) return;
    const id = run.id;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await api<Run>(`/runs/${id}`);
        if (disposed) return;
        setRun(value); setError('');
        if (value.finished_at) { void onComplete(); return; }
      } catch (error) { if (!disposed) setError(error instanceof Error ? error.message : 'Status polling interrupted'); }
      if (!disposed) timer = setTimeout(poll, 700);
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [run?.id, run?.finished_at, onComplete]);
  async function launch(inputs: Record<string, Json>) {
    if (!manifest) return;
    setSubmitting(true); setError('');
    try {
      const queued = await api<{ id: string }> (`/capabilities/${capability.id}/runs`, { method: 'POST', body: JSON.stringify({ inputs }) });
      setRun({ id: queued.id, capability_id: capability.id, status: 'queued', created_at: new Date().toISOString(), started_at: null, finished_at: null, duration_ms: null, error: null, exit_code: null, environment: null, trigger_type: 'manual', schedule_id: null, inputs, manifest, result: null, stdout: '', stderr: '' });
      setTab('result'); void onComplete();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not launch capability'); }
    finally { setSubmitting(false); }
  }
  if (!manifest || capability.status === 'INVALID') return <section><button className="back-link" onClick={onBack}><ArrowLeft size={15} />All capabilities</button><h1>{capability.id}</h1><button className="button secondary" onClick={onEditCapability}>Edit capability</button><div className="error-panel"><h3>Capability needs attention</h3><p>Repair the files in this capability's folder. Discovery will pick up your changes automatically.</p>{capability.diagnostics.map((diagnostic, i) => <pre key={i}>{diagnostic}</pre>)}</div></section>;
  const resultManifest = run?.manifest ?? manifest;
  const ResultWidget = resultManifest.ui_component ? CustomCapabilityRegistry[resultManifest.ui_component] : null;
  const Widget = manifest.ui_component ? CustomCapabilityRegistry[manifest.ui_component] : null;
  const busy = submitting || isActive(run?.status);
  return <section className="detail-page">
    <button className="back-link" onClick={onBack}><ArrowLeft size={15} />All capabilities</button>
    <div className="detail-heading"><CapabilityIcon id={capability.id} /><div><h1>{manifest.name}</h1><p className="detail-category">{manifest.category} · v{manifest.version} <button className="text-action" onClick={onEditCategory}>Edit category</button></p></div><div className="detail-actions"><button className="button secondary" onClick={onEditCapability}>Edit capability</button><Status status={capability.status} /></div></div>
    <p className="detail-description">{manifest.description}</p>
    <div className="detail-meta"><span>By {manifest.author}</span><span><ClockIcon />{manifest.timeout_seconds}s timeout</span><span><ShieldCheck size={13} />Isolated environment</span>{manifest.ui_component && <span><Boxes size={13} />{Widget ? 'Custom view' : 'Standard fallback view'}</span>}</div>
    <div className="dependency-inspector"><div><Layers3 size={17} /><strong>Dependency environment</strong><span className={`environment-state ${environment?.status === 'ready' ? 'warm' : ''}`}><i />{environment?.status === 'ready' ? 'Cached & ready' : 'Created on first run'}</span></div><div>{manifest.python_dependencies.length ? manifest.python_dependencies.map(dep => <code key={dep}>{dep}</code>) : <code>Python standard library</code>}<details><summary>Inspect</summary><p>Cache key: <code>{environment?.key ?? 'Checking…'}</code></p><p>Packages are installed in a dedicated virtual environment, separate from the API and every other capability.</p></details></div></div>
    <div className="execution-layout"><div className="panel input-panel"><div className="panel-heading"><div><h2>Configure inputs</h2></div><span>JSON Schema</span></div><CapabilityErrorBoundary key={`${manifest.id}-form-${JSON.stringify(manifest.input_schema)}`}><DynamicForm schema={manifest.input_schema} busy={busy} onRun={launch} onSchedule={onSchedule} /></CapabilityErrorBoundary>{error && <div className="inline-error" role="alert">{error}</div>}</div>
      <div className="panel output-panel"><div className="panel-heading"><div><h2>Execution output</h2></div>{run && <div className="run-context"><TriggerBadge triggerType={run.trigger_type} /><Status status={run.status} /></div>}</div>
        <div className="output-tabs"><div>{['result', 'raw JSON', 'logs'].map(item => <button key={item} className={tab === item ? 'selected' : ''} onClick={() => setTab(item)}>{item === 'result' ? <LayoutGrid size={13} /> : item === 'logs' ? <Terminal size={13} /> : <Braces size={13} />}{item}</button>)}</div>{run && <button className="icon-button" title="Open run details" aria-label="Open run details" onClick={() => onHistory(run.id)}><ArrowUpRight size={15} /></button>}</div>
        {!run ? <div className="output-empty"><span className="output-empty-icon"><Terminal size={31} strokeWidth={1.3} /></span><h3>No execution output</h3><p>Run this capability to inspect its result and logs.</p></div> : busy ? <div className="output-empty"><LoaderCircle size={31} className="spin" /><h3>{run.status === 'preparing' ? 'Preparing an isolated environment' : run.status === 'queued' ? 'Waiting for an execution slot' : 'Running capability'}</h3><p>{run.status === 'preparing' ? 'First runs create a virtual environment and install declared packages. This can take a moment.' : `Execution is limited to ${manifest.timeout_seconds} seconds after setup.`}</p><code className="muted">run/{run.id.slice(0, 8)}</code></div> : <div className="output-content">
          {run.error && <div className="inline-error" role="alert"><strong>{pretty(run.status)}</strong><p>{run.error}</p><small>Other capabilities remain available. Open Logs for diagnostics.</small></div>}
          {tab === 'logs' ? <RunLogs run={run} /> : tab === 'raw JSON' ? <RawResult result={run.result} /> : run.status === 'succeeded' ? <CapabilityErrorBoundary key={run.id} fallback={<RawResult result={run.result} />}>{ResultWidget ? <ResultWidget result={run.result} manifest={resultManifest} /> : <StandardResult result={run.result} manifest={resultManifest} />}</CapabilityErrorBoundary> : <RunLogs run={run} />}
        </div>}
        {run && !busy && <div className="run-footer"><span><CheckCircle2 size={13} />{duration(run.duration_ms)}<span>·</span>{localTime(run.created_at)}</span><button onClick={async () => { try { await navigator.clipboard.writeText(JSON.stringify(run.result, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('Clipboard unavailable. Use Raw JSON to copy the result.'); } }}>{copied ? <Check size={13} /> : <ArrowDownToLine size={13} />}{copied ? 'Copied' : 'Copy result'}</button></div>}
      </div>
    </div>
    <SchedulesView compact schedules={schedules} capabilities={capabilities} onEdit={onEditSchedule} onRefresh={onComplete} onCapability={() => {}} onRun={onHistory} />
  </section>;
}

function ClockIcon() { return <Clock3 size={14} />; }

function RunLogs({ run }: { run: Run }) {
  return <div className="run-logs"><h4>STDOUT <span>{new Blob([run.stdout]).size} bytes</span></h4><pre>{run.stdout || 'No stdout captured.'}</pre><h4>STDERR <span>exit {run.exit_code ?? '—'}</span></h4><pre className={run.status !== 'succeeded' ? 'stderr-error' : ''}>{run.stderr || 'No stderr captured.'}</pre></div>;
}

function RunTable({ runs, capabilities, onSelect }: { runs: RunSummary[]; capabilities: Capability[]; onSelect: (id: string) => void }) {
  return <div className="table-scroll run-table"><table><thead><tr><th>Capability</th><th>Trigger</th><th>Status</th><th>Duration</th><th>Started</th><th /></tr></thead><tbody>{runs.map(run => <tr key={run.id}><td><button className="run-name" onClick={() => onSelect(run.id)}><CapabilityIcon id={run.capability_id} small /><span>{capabilities.find(cap => cap.id === run.capability_id)?.manifest?.name ?? run.capability_id}<small>{run.id.slice(0, 8)}</small></span></button></td><td><TriggerBadge triggerType={run.trigger_type} /></td><td><Status status={run.status} /></td><td>{duration(run.duration_ms)}</td><td>{localTime(run.created_at)}</td><td><button className="icon-button" onClick={() => onSelect(run.id)} aria-label={`Inspect run ${run.id.slice(0, 8)}`}><ArrowUpRight size={15} /></button></td></tr>)}</tbody></table></div>;
}

function HistoryDrawer({ runs, capabilities, initialRun, onClose }: { runs: RunSummary[]; capabilities: Capability[]; initialRun: string | null; onClose: () => void }) {
  const [selected, setSelected] = useState(initialRun);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!selected) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const value = await api<Run>(`/runs/${selected}`); if (!disposed) { setRun(value); setError(''); if (!value.finished_at) timer = setTimeout(poll, 1000); } }
      catch (error) { if (!disposed) setError(error instanceof Error ? error.message : 'Could not load run'); }
    }
    setRun(null); void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [selected]);
  return <Modal title="Run history" onClose={onClose} drawer><div className="history-content">{selected ? <><button className="back-link" onClick={() => { setSelected(null); setError(''); }}><ArrowLeft size={14} />All recent runs</button>{error && <div className="inline-error" role="alert">{error}</div>}{run ? <><div className="history-run-heading"><h3>{run.manifest.name}</h3><div className="run-context"><TriggerBadge triggerType={run.trigger_type} /><Status status={run.status} /></div></div><code className="run-id">{run.id}</code><dl className="run-facts"><div><dt>Created</dt><dd>{localTime(run.created_at)}</dd></div><div><dt>Total duration</dt><dd>{duration(run.duration_ms)}</dd></div><div><dt>Environment</dt><dd>{run.environment ?? 'Not prepared'}</dd></div></dl>{run.error && <div className="inline-error">{run.error}</div>}<h3 className="history-subtitle">Inputs</h3><RawResult result={run.inputs} /><h3 className="history-subtitle">Result</h3><RawResult result={run.result} /><RunLogs run={run} /></> : !error && <div className="empty-state"><LoaderCircle className="spin" />Loading execution…</div>}</> : <><p className="modal-intro">The latest 50 executions, including inputs, results, and diagnostic logs. Stored locally in SQLite.</p>{runs.length ? <RunTable runs={runs} capabilities={capabilities} onSelect={setSelected} /> : <div className="empty-state"><History size={32} /><h3>No runs yet</h3><p>Launch a capability to begin your run history.</p></div>}</>}</div></Modal>;
}
