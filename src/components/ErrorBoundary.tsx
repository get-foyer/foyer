import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * React error boundary that catches render errors in any child panel.
 * Renders a fallback instead of white-screening the whole app.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Panel render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <section className="panel panel--error">
          <h2 className="panel__title">⚠ Panel Error</h2>
          <p className="panel__empty">Something went wrong rendering this panel.</p>
          <pre className="panel__error-detail">{this.state.error.message}</pre>
          <button className="panel__reload-btn" onClick={() => location.reload()} type="button">
            Reload dashboard
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}
