import { useStore } from '../../stores';
import { AutomationJobsSection } from '../automation/AutomationJobsSection';
import styles from './Channels.module.css';

function localText(key: string, fallback: string) {
  const value = window.t?.(key);
  return value && value !== key ? value : fallback;
}

export function ChannelAutomationSection() {
  const currentChannel = useStore(state => state.currentChannel);
  const channelMembers = useStore(state => state.channelMembers);

  if (!currentChannel) {
    return (
      <div className={`channel-info-section ${styles.channelAutomationSection}`} data-channel-automation-empty="select-channel">
        <div className="channel-info-label">{localText('automation.title', '任务计划')}</div>
        <div className={styles.channelAutomationEmpty}>
          {localText('channel.automationSelectChannel', '请先选择一个频道查看任务计划')}
        </div>
      </div>
    );
  }

  return (
    <div className={`channel-info-section ${styles.channelAutomationSection}`} data-channel-automation={currentChannel}>
      <div className={styles.channelSectionHeaderRow}>
        <div>
          <div className="channel-info-label">{localText('automation.title', '任务计划')}</div>
          <div className={styles.channelAutomationHint}>
            {localText('channel.automationMemberHint', '仅显示并创建当前频道成员的计划')}
          </div>
        </div>
      </div>
      <AutomationJobsSection
        allowedAgentIds={channelMembers}
        emptyMessage={localText('channel.automationNoMembers', '当前频道没有可创建计划的 Agent 成员')}
        listId="channelAutomationList"
      />
    </div>
  );
}
