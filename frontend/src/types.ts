export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type FieldSchema = {
  type?: string; title?: string; description?: string; format?: string;
  enum?: Json[]; default?: Json; minimum?: number; maximum?: number;
  minLength?: number; maxLength?: number; multipleOf?: number;
};
export type InputSchema = { type: 'object'; properties?: Record<string, FieldSchema>; required?: string[]; [key: string]: unknown };
export type Manifest = {
  id: string; name: string; description: string; author: string; version: string;
  category: string; timeout_seconds: number; python_dependencies: string[];
  input_schema: InputSchema; ui_component: string | null;
  output_type: 'json' | 'markdown' | 'table' | 'custom';
};
export type Capability = { id: string; status: 'READY' | 'INVALID'; manifest: Manifest | null; diagnostics: string[] };
export type RunStatus = 'queued' | 'preparing' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'interrupted';
export type RunSummary = {
  id: string; capability_id: string; status: RunStatus; created_at: string;
  trigger_type: 'manual' | 'scheduled'; schedule_id: string | null;
  duration_ms: number | null; error: string | null; exit_code: number | null; environment: string | null;
};
export type Run = RunSummary & {
  inputs: Record<string, Json>; manifest: Manifest; result: Json; stdout: string; stderr: string;
  started_at: string | null; finished_at: string | null;
};
export type Environment = { key: string; status: 'cold' | 'ready'; dependencies: string[] };
export const isActive = (status?: string) => ['queued', 'preparing', 'running'].includes(status ?? '');

export type ExecutionRecord = Run;
export type ScheduleCreatePayload = {
  capability_id: string; name: string; schedule_type: 'interval' | 'cron'; expression: string;
  parameters: Record<string, Json>; enabled: boolean; skip_if_running?: true;
};
export type ScheduleUpdatePayload = Partial<Omit<ScheduleCreatePayload, 'capability_id' | 'skip_if_running'>>;
export type ScheduleRecord = ScheduleCreatePayload & {
  id: string; created_at: string; next_run_at: string | null; last_run_at: string | null;
  last_run_id: string | null; last_status: 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'RUNNING' | 'INVALID_CAPABILITY' | null;
  consecutive_failures: number; last_error: string | null;
};
