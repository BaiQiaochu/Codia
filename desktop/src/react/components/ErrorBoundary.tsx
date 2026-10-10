import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
 /** */
  region?: string;
}

interface State {
  error: Error | null;
  errorType: 'render' | 'network' | 'unknown';
}

function tr(key: string, fallback: string, vars?: Record<string, string | number>): string {
  const translate = typeof window !== 'undefined' ? window.t : undefined;
  if (typeof translate !== 'function') return fallback;
  try {
    const value = translate(key, vars);
    return value && value !== key ? value : fallback;
  } catch {
    return fallback;
  }
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, errorType: 'unknown' };

  static getDerivedStateFromError(error: Error): State {
 // 区分错误类型
    const msg = error.message?.toLowerCase() || '';
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('abort') || msg.includes('timeout')) {
      return { error, errorType: 'network' };
    }
    return { error, errorType: 'render' };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
    window.__codiaLog?.('error', 'react', `${error.message}\n${info.componentStack}`);
  }

  handleRetry = () => {
    this.setState({ error: null, errorType: 'unknown' });
  };

  render() {
    if (this.state.error) {
      const { errorType } = this.state;
      const region = this.props.region;

      const title = errorType === 'network'
        ? tr('error.connectionIssue', '连接异常')
        : tr('error.unexpectedTitle', '此区域出现问题');

      const hint = errorType === 'network'
        ? tr('error.checkConnection', '请检查网络连接后重试。')
        : region
          ? tr('error.regionCrashed', '{region} 区域发生错误。', { region })
          : tr('error.unexpected', '发生了未预期的错误。');

      return (
        <div style={{
          padding: '24px',
          color: 'var(--text-secondary, #888)',
          fontSize: '13px',
          textAlign: 'center',
        }}>
          <p style={{ marginBottom: '4px', fontWeight: 500 }}>{title}</p>
          <p style={{ marginBottom: '12px', fontSize: '12px', opacity: 0.7 }}>{hint}</p>
          <button type="button"
            onClick={this.handleRetry}
            style={{
              background: 'none',
              border: '1px solid var(--border-light, #ddd)',
              borderRadius: '4px',
              padding: '4px 12px',
              cursor: 'pointer',
              color: 'inherit',
              fontSize: '12px',
            }}
          >
            {tr('action.retry', '重试')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
