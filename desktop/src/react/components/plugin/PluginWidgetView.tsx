import { useMemo } from 'react';
import { useStore } from '../../stores';
import { usePluginIframe } from '../../hooks/use-plugin-iframe';
import { usePluginSurfaceUrl } from '../../hooks/use-plugin-surface-url';
import s from './PluginWidgetView.module.css';

interface Props {
  pluginId: string;
}

const KNOWLEDGE_GRAPH_PLUGIN_ID = 'knowledge-graph';
const WIDGET_SANDBOX = 'allow-scripts allow-forms allow-popups allow-same-origin';
const WIDGET_SANDBOX_WITH_MODALS = `${WIDGET_SANDBOX} allow-modals`;
const EMPTY_HOST_CAPABILITIES: readonly string[] = [];

export function PluginWidgetView({ pluginId }: Props) {
  const widgets = useStore(st => st.pluginWidgets);
  const agentId = useStore(st => st.currentAgentId);
  const widget = useMemo(() => widgets.find(w => w.pluginId === pluginId), [widgets, pluginId]);
  const sandboxPermissions = pluginId === KNOWLEDGE_GRAPH_PLUGIN_ID
    ? WIDGET_SANDBOX_WITH_MODALS
    : WIDGET_SANDBOX;

  const surfaceUrl = usePluginSurfaceUrl(widget?.routeUrl ?? null, agentId);

  const { iframeRef, status: iframeStatus, retry: retryIframe } = usePluginIframe(surfaceUrl.iframeSrc, {
    pluginId,
    agentId,
    slot: 'widget',
    capabilityGrants: widget?.hostCapabilities ?? EMPTY_HOST_CAPABILITIES,
  });
  const status = surfaceUrl.status === 'ready' ? iframeStatus : surfaceUrl.status;
  const retry = () => {
    surfaceUrl.retry();
    retryIframe();
  };

  if (!widget) {
    return <div className={s.error}>组件未找到</div>;
  }

  return (
    <div className={s.container}>
      {status === 'loading' && (
        <div className={s.overlay}><div className={s.spinner} /></div>
      )}
      {status === 'error' && (
        <div className={s.overlay}>
          <p>加载失败</p>
          <button type="button" className={s.retryBtn} onClick={retry}>重试</button>
        </div>
      )}
      <iframe
        ref={iframeRef}
        className={s.iframe}
        src={surfaceUrl.iframeSrc || undefined}
        sandbox={sandboxPermissions}
        style={{ opacity: status === 'ready' ? 1 : 0 }}
      />
    </div>
  );
}
