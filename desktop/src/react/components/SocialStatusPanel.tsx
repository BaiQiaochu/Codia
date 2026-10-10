import { useCallback, useEffect, useState } from 'react';
import { X, ArrowClockwise, Broadcast } from '@phosphor-icons/react';
import { codiaFetch } from '../hooks/use-codia-fetch';
import { useStore } from '../stores';
import fp from './FloatingPanels.module.css';

type PlatformStatus = { enabled?: boolean; configured?: boolean; status?: string; error?: string | null };
type Overview = { assistants: Array<{ id: string; name: string; platforms: Record<string, PlatformStatus> }>; generatedAt?: number };
type Delivery = { id: string; ts?: number; agentId?: string | null; platform?: string | null; direction?: string; summary?: string | null; deliveryStatus?: string; error?: string | null };

const platformNames: Record<string, string> = { telegram: 'Telegram', feishu: '飞书', dingtalk: '钉钉', whatsapp: 'WhatsApp', qq: 'QQ', wechat: '微信', agentlyMail: 'Agently Mail' };

export function SocialStatusPanel() {
  const visible = useStore(s => s.activePanel === 'social');
  const close = useCallback(() => useStore.getState().setActivePanel(null), []);
  const [overview, setOverview] = useState<Overview>({ assistants: [] });
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [overviewRes, deliveriesRes] = await Promise.all([codiaFetch('/api/bridge/overview'), codiaFetch('/api/bridge/deliveries?limit=80')]);
      if (overviewRes.ok) setOverview(await overviewRes.json());
      if (deliveriesRes.ok) setDeliveries((await deliveriesRes.json()).deliveries || []);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { if (visible) load(); }, [visible, load]);
  useEffect(() => { if (!visible) return; const id = window.setInterval(load, 30_000); return () => window.clearInterval(id); }, [visible, load]);
  if (!visible) return null;
  const statusLabel = (status?: string) => status === 'connected' || status === 'online' ? '正常' : status === 'connecting' ? '连接中' : status === 'error' ? '异常' : '未连接';
  return <div className={`${fp.floatingPanel} ${fp.bridgePanelWide}`} id="socialStatusPanel">
    <div className={fp.floatingPanelInner}>
      <div className={fp.floatingPanelHeader}><div className={fp.floatingPanelTitle}><Broadcast size={18} /> 社交状态</div><div className={fp.floatingPanelHeaderActions}><button type="button" className={fp.floatingPanelActionBtn} onClick={load} disabled={loading} aria-label="刷新"><ArrowClockwise size={16} /></button><button type="button" className={fp.floatingPanelActionBtn} onClick={close} aria-label="关闭"><X size={16} /></button></div></div>
      <div style={{ padding: '12px 16px', overflow: 'auto', flex: 1 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 13 }}>全部助手 · 全部平台</h3>
        {overview.assistants.length === 0 && <div className={fp.bridgeContactEmpty}>暂无助手或社交连接</div>}
        {overview.assistants.map(agent => <div key={agent.id} style={{ border: '1px solid var(--border-color, #eee5f5)', borderRadius: 10, padding: 10, marginBottom: 8 }}><strong>{agent.name}</strong><div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 6, marginTop: 8 }}>{Object.entries(agent.platforms).map(([platform, item]) => <div key={platform} style={{ fontSize: 11, color: 'var(--text-secondary, #766b83)' }}><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', marginRight: 5, background: item.status === 'connected' || item.status === 'online' ? '#53b98b' : item.status === 'error' ? '#e97777' : '#bbb' }} />{platformNames[platform] || platform} · {statusLabel(item.status)}{item.error ? ` · ${item.error}` : ''}</div>)}</div></div>)}
        <h3 style={{ margin: '16px 0 10px', fontSize: 13 }}>最近发送</h3>
        {deliveries.length === 0 && <div className={fp.bridgeContactEmpty}>暂无发送记录</div>}
        {deliveries.map(item => <div key={item.id} style={{ borderBottom: '1px solid var(--border-color, #f0eaf5)', padding: '8px 0', fontSize: 11 }}><div><strong>{platformNames[item.platform || ''] || item.platform || '未知平台'}</strong> · {item.direction === 'out' ? '发出' : '收到'} · {item.deliveryStatus || '未知'}</div><div style={{ color: 'var(--text-secondary, #766b83)', marginTop: 3 }}>{item.summary || '无摘要'}{item.error ? ` · ${item.error}` : ''}</div></div>)}
      </div>
    </div>
  </div>;
}
