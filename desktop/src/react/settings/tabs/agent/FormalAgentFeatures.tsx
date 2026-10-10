import { useEffect, useState } from 'react';
import { codiaFetch } from '../../api';
import { SettingsSection } from '../../components/SettingsSection';
import { SettingsRow } from '../../components/SettingsRow';
import { Toggle } from '../../widgets/Toggle';

const IDS = ['memory.editable_facts', 'subagent.proactive_delegation'] as const;
export function FormalAgentFeatures() {
  const [values, setValues] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<string | null>(null);
  useEffect(() => { codiaFetch('/api/experiments').then(r => r.json()).then(data => { const next: Record<string, boolean> = {}; for (const item of data.experiments || []) if (IDS.includes(item.id)) next[item.id] = item.value === true || item.value === 'on'; setValues(next); }).catch(() => undefined); }, []);
  const update = async (id: string, enabled: boolean) => { setSaving(id); try { const r = await codiaFetch(`/api/experiments/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: enabled }) }); if (r.ok) setValues(prev => ({ ...prev, [id]: enabled })); } finally { setSaving(null); } };
  return <SettingsSection title="助手协作与记忆" description="正式助手设置，按当前助手配置生效。">
    <SettingsRow label="编辑长期记忆" hint="手动确认的事实不会被后台整理直接覆盖。" control={<Toggle on={values['memory.editable_facts'] === true} onChange={(next) => update('memory.editable_facts', next)} disabled={saving !== null} />} />
    <SettingsRow label="自动委派子助手" hint="复杂任务可委派检索、分析、编码或审阅，继承当前权限。" control={<Toggle on={values['subagent.proactive_delegation'] === true} onChange={(next) => update('subagent.proactive_delegation', next)} disabled={saving !== null} />} />
  </SettingsSection>;
}
