import { useState, type ComponentType } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Clock3, Search, ShieldAlert } from 'lucide-react';
import type { Json, Manifest } from './types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type ViewProps = { result: Json; manifest: Manifest };
type LogResult = {
  summary: { requests: number; errors: number; latency_spikes: number; pii_findings: number; p95_latency_ms: number };
  timeline: { time: string; requests: number; errors: number; slow: number }[];
  logs: { id: number; timestamp: string; method: string; path: string; status: number | null; latency_ms: number | null; severity: string; findings: string[]; line: string }[];
};

export function LogAnalyzerView({ result }: ViewProps) {
  const data = result as unknown as LogResult;
  const [severity, setSeverity] = useState('all');
  const [query, setQuery] = useState('');
  const max = Math.max(1, ...data.timeline.map(item => item.requests));
  const filtered = data.logs.filter(log => (severity === 'all' || log.severity === severity) && `${log.path} ${log.line}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="log-analysis">
    <div className="result-metrics">
      <div><span><Activity size={14} /> Requests</span><strong>{data.summary.requests}</strong></div>
      <div><span><AlertTriangle size={14} /> Errors</span><strong className={data.summary.errors ? 'text-red' : ''}>{data.summary.errors}</strong></div>
      <div><span><Clock3 size={14} /> Slow</span><strong className="text-amber">{data.summary.latency_spikes}</strong></div>
      <div><span><ShieldAlert size={14} /> PII flags</span><strong>{data.summary.pii_findings}</strong></div>
    </div>
    <div className="timeline-header"><h3>Request timeline</h3><span>p95 <b>{data.summary.p95_latency_ms}ms</b></span></div>
    <div className="timeline" role="img" aria-label="Requests and errors per minute">
      {data.timeline.map(item => <div className="timeline-column" key={item.time} title={`${item.time}: ${item.requests} requests, ${item.errors} errors`}>
        <div className="timeline-track"><div className="timeline-bar" style={{ height: `${item.requests / max * 100}%` }}><div style={{ height: `${item.errors / item.requests * 100}%` }} /></div></div><span>{item.time}</span>
      </div>)}
    </div>
    <div className="chart-legend"><span><i /> Requests</span><span><i className="red" /> Server errors</span></div>
    <div className="log-table-header"><h3>Parsed events <span>{filtered.length}</span></h3><select aria-label="Filter log severity" value={severity} onChange={event => setSeverity(event.target.value)}><option value="all">All severities</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Info</option></select></div>
    <div className="search small-search"><Search size={15} /><input aria-label="Search log events" placeholder="Filter by route or message…" value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div className="table-scroll"><table className="event-table"><thead><tr><th>Event / route</th><th>Status</th><th>Latency</th><th>Findings</th></tr></thead><tbody>
      {filtered.map(log => <tr key={log.id}><td><span className="event-route"><i className={`severity-dot ${log.severity}`} /><code>{log.method} {log.path}</code></span><small>{log.timestamp}</small></td><td>{log.status ?? '—'}</td><td className={log.findings.includes('Latency spike') ? 'text-amber' : ''}>{log.latency_ms === null ? '—' : `${log.latency_ms}ms`}</td><td>{log.findings.length ? log.findings.map(finding => <span className={`finding ${finding === 'Server error' ? 'danger' : ''}`} key={finding}>{finding}</span>) : <span className="muted">Healthy</span>}</td></tr>)}
      {!filtered.length && <tr><td colSpan={4} className="empty-cell">No matching events.</td></tr>}
    </tbody></table></div>
  </div>;
}

function FaultDemoView({ result }: ViewProps) {
  const data = result as { crash_widget?: boolean; message?: string };
  if (data.crash_widget) throw new Error('Intentional widget crash. The React error boundary isolated this view.');
  return <div className="success-panel"><CheckCircle2 size={30} /><h3>Experiment completed</h3><p>{data.message}</p></div>;
}

export const CustomCapabilityRegistry: Record<string, ComponentType<ViewProps>> = { LogAnalyzerView, FaultDemoView };

export function RawResult({ result }: { result: Json }) { return <pre className="json-output">{JSON.stringify(result, null, 2)}</pre>; }

export function StandardResult({ result, manifest }: ViewProps) {
  const data = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  const markdown = typeof data.markdown === 'string' ? data.markdown : null;
  const rows = Array.isArray(data.rows) ? data.rows : null;
  const columns = Array.isArray(data.columns) ? data.columns.map(String) : rows?.length && typeof rows[0] === 'object' && rows[0] !== null ? Object.keys(rows[0]) : [];
  return <>
    {typeof data.total_monthly_usd === 'number' && <div className="cost-summary"><span>ESTIMATED MONTHLY TOTAL</span><strong>${data.total_monthly_usd.toLocaleString('en-US', { minimumFractionDigits: 2 })}<small> / month</small></strong><p>{String(data.region)} · {String(data.environment)} · USD</p></div>}
    {manifest.output_type === 'markdown' && markdown ? <div className="markdown-output"><ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown></div> :
      rows && columns.length ? <div className="table-scroll"><table><thead><tr>{columns.map(column => <th key={column}>{column.replaceAll('_', ' ')}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{columns.map(column => <td key={column}>{displayCell(row, column)}</td>)}</tr>)}</tbody></table></div> : <RawResult result={result} />}
    {typeof data.note === 'string' && <p className="output-note">{data.note}</p>}
  </>;
}

function displayCell(row: Json, column: string) {
  const value = row && typeof row === 'object' && !Array.isArray(row) ? row[column] : null;
  return value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
}
