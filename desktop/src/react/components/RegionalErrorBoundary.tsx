import { Component, type ReactNode } from 'react';

interface Props {
  region: string;
  resetKeys?: unknown[];
  onDisableRegion?: (error: Error, info: React.ErrorInfo) => void;
  fallback?: ReactNode | ((args: { error: Error; region: string; reset: () => void }) => ReactNode);
  children: ReactNode;
}

interface State {
  error: Error | null;
  prevResetKeys: unknown[];
}

export class RegionalErrorBoundary extends Component<Props, State> {
  state: State = {
    error: null,
    prevResetKeys: this.props.resetKeys || [],
  };

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKeys && state.error) {
      const changed = props.resetKeys.some((key, index) => key !== state.prevResetKeys[index]);
      if (changed) {
        return {
          error: null,
          prevResetKeys: props.resetKeys,
        };
      }
    }
    if (props.resetKeys) return { prevResetKeys: props.resetKeys };
    return null;
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[RegionalErrorBoundary:${this.props.region}]`, error, info.componentStack);
    this.props.onDisableRegion?.(error, info);
    import('../../../../shared/error-bus.ts').then(({ errorBus }) => {
      import('../../../../shared/errors.ts').then(({ AppError }) => {
        errorBus.report(new AppError('RENDER_CRASH', {
          cause: error,
          context: { region: this.props.region, componentStack: info.componentStack?.slice(0, 500) },
        }));
      });
    }).catch(() => { /* best effort - error reporting itself failed */ });
  }

  private reset = () => {
    this.setState({ error: null, prevResetKeys: this.props.resetKeys || [] });
  };

  render() {
    if (this.state.error) {
      const { fallback, region } = this.props;
      if (!fallback) return null;
      return typeof fallback === 'function'
        ? fallback({ error: this.state.error, region, reset: this.reset })
        : fallback;
    }
    return this.props.children;
  }
}
