import { useEffect, useState } from 'react';
import { codiaFetch } from '../../api';
import { SettingsSection } from '../../components/SettingsSection';
import { SettingsRow } from '../../components/SettingsRow';
import { Toggle } from '../../widgets/Toggle';

const ID = 'provider.deepseek_roleplay_reasoning_patch';
export function DeepSeekFeature() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => { codiaFetch('/api/experiments').then(r => r.json()).then(data => { const item = (data.experiments || []).find((x: { id: string }) => x.id === ID); setEnabled(item?.value === true || item?.value === 'on'); }).catch(() => undefined); }, []);
  const update = async (next: boolean) => { const r = await codiaFetch(`/api/experiments/${ID}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: next }) }); if (r.ok) setEnabled(next); };
  return <SettingsSection title="DeepSeek 高级设置" description="仅在明确支持该协议的 DeepSeek 模型上启用角色沉浸推理。"><SettingsRow label="角色沉浸推理" hint="不会改写用户消息、工具参数或结构化结果。" control={<Toggle on={enabled} onChange={update} />} /></SettingsSection>;
}
