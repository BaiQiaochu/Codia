import { useEffect, useState } from 'react';
import { codiaFetch } from '../api';
import { t } from '../helpers';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { SelectWidget } from '../widgets/SelectWidget';
import styles from '../Settings.module.css';

const ID = 'session.compaction_mode';
const options = [
  { value: 'auto', label: '自动' },
  { value: 'cache_preserving', label: '缓存优先' },
  { value: 'pi_compatible', label: '兼容优先' },
];

export function ContextTab() {
  const [value, setValue] = useState('auto');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    codiaFetch('/api/experiments').then(r => r.json()).then(data => {
      const item = (data.experiments || []).find((entry: { id: string }) => entry.id === ID);
      if (item?.value) setValue(item.value);
    }).finally(() => setLoading(false));
  }, []);
  const save = async (next: string) => {
    setSaving(true);
    try {
      const response = await codiaFetch(`/api/experiments/${ID}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: next }) });
      if (!response.ok) throw new Error('save failed');
      setValue(next);
    } finally { setSaving(false); }
  };
  return <div className={styles.settingsTabContent}>
    <SettingsSection title="上下文管理" description="保留目标、决定、未完成事项和文件状态，减少重复工具输出。">
      <SettingsRow label="压缩策略" hint="取消、认证失败和限流不会触发重复压缩。" control={<SelectWidget value={value} options={options} disabled={loading || saving} onChange={save} />} />
    </SettingsSection>
    <SettingsSection title="运行说明" description="完整历史仍保留在本地；只有送入模型的上下文会按策略裁剪。工具调用与图片资源引用保持成对。"><div /></SettingsSection>
  </div>;
}
