import React from 'react';
export function Unavailable({ feature = 'Native feature', detail }) {
  return <div role="note" data-acorn-unavailable={feature} style={{ padding: 12, minHeight: 48, boxSizing: 'border-box', background: '#f2f4f6', border: '1px dashed #b4bdc8', borderRadius: 6, color: '#46515f', font: '12px system-ui' }}><strong>{feature}</strong><div>{detail || 'Unavailable in web preview'}</div></div>;
}
export class FeatureBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidUpdate(previous) {
    if (this.state.error && (previous.children?.type !== this.props.children?.type || previous.children?.key !== this.props.children?.key)) this.setState({ error: null });
  }
  render() {
    if (this.state.error) return <Unavailable feature={this.props.feature} detail={'Preview error: ' + String(this.state.error.message || this.state.error).slice(0, 240)} />;
    return this.props.children;
  }
}
