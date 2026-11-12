export function TriggerBadge({ triggerType = 'manual' }: { triggerType?: 'manual' | 'scheduled' }) {
  return <span className={`trigger-badge trigger-${triggerType}`}>{triggerType === 'scheduled' ? 'SCHEDULED' : 'MANUAL'}</span>;
}
