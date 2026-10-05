import { useEffect, useMemo } from 'react';
import { useStore } from '../../stores';
import { usePluginIframe } from '../../hooks/use-plugin-iframe';
import { usePluginSurfaceUrl } from '../../hooks/use-plugin-surface-url';
import s from './PluginPageView.module.css';

interface Props {
  pluginId: string;
}

const KNOWLEDGE_GRAPH_PLUGIN_ID = 'knowledge-graph';
const MODAL_CAPABLE_PLUGIN_IDS = new Set([KNOWLEDGE_GRAPH_PLUGIN_ID, 'mind-map']);
const PAGE_SANDBOX = 'allow-scripts allow-forms allow-popups allow-same-origin';
const PAGE_SANDBOX_WITH_MODALS = `${PAGE_SANDBOX} allow-modals`;
const EMPTY_HOST_CAPABILITIES: readonly string[] = [];

export function PluginPageView({ pluginId }: Props) {
  const pages = useStore(st => st.pluginPages);
  const agentId = useStore(st => st.currentAgentId);
  const page = useMemo(() => pages.find(p => p.pluginId === pluginId), [pages, pluginId]);
  const sandboxPermissions = MODAL_CAPABLE_PLUGIN_IDS.has(pluginId)
    ? PAGE_SANDBOX_WITH_MODALS
    : PAGE_SANDBOX;

  const surfaceUrl = usePluginSurfaceUrl(page?.routeUrl ?? null, agentId);

  const { iframeRef, status: iframeStatus, postToIframe, retry: retryIframe } = usePluginIframe(surfaceUrl.iframeSrc, {
    pluginId,
    agentId,
    slot: 'page',
    readyOnTimeout: true,
    capabilityGrants: page?.hostCapabilities ?? EMPTY_HOST_CAPABILITIES,
  });
  const status = surfaceUrl.status === 'ready' ? iframeStatus : surfaceUrl.status;
  const retry = () => {
    surfaceUrl.retry();
    retryIframe();
  };

  useEffect(() => {
    if (status === 'ready') postToIframe('visibility-changed', { visible: true });
    return () => { postToIframe('visibility-changed', { visible: false }); };
  }, [status, postToIframe]);

  if (!page) {
    return (
      <div className={s.container}>
        <div className={s.error}>插件未找到</div>
      </div>
    );
  }

  return (
    <div className={s.container}>
      {status === 'loading' && (
        <div className={s.overlay}><div className={s.spinner} /></div>
      )}
      {status === 'error' && (
        <div className={s.overlay}>
          <p>插件加载失败</p>
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
