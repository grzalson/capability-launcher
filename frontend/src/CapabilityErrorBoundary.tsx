import { Component, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

export class CapabilityErrorBoundary extends Component<{
  children: ReactNode; fallback?: ReactNode;
}, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="error-panel" role="alert">
      <AlertTriangle size={23} /><h3>Capability view failed</h3>
      <p>{this.state.error}</p>
      <button className="button secondary" onClick={() => this.setState({ error: null })}><RotateCcw size={14} /> Retry view</button>
      {this.props.fallback && <details><summary>Inspect raw result</summary>{this.props.fallback}</details>}
    </div>;
  }
}
