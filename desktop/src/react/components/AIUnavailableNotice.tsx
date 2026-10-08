import { openProviderModelSettings } from '../utils/model-settings-navigation';
import { switchTab } from './channels/tab-router';

/** File-only onboarding does not create a dummy provider or pretend chat is ready. */
export function AIUnavailableNotice() {
  return <section className="ai-unavailable-notice" role="status" aria-label="AI 尚未配置">
    <strong>还没有可用的 AI 模型</strong>
    <p>文件与工作空间可以继续使用。添加服务商和模型后，即可启用 AI 聊天。</p>
    <div>
      <button type="button" onClick={() => openProviderModelSettings()}>配置 AI</button>
      <button type="button" onClick={() => switchTab('cloud')}>打开文件工作空间</button>
    </div>
  </section>;
}
