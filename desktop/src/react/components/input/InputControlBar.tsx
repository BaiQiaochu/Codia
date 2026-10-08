import { memo } from 'react';
import { InputUtilityButtons } from './InputUtilityButtons';
import { PlanModeButton, type PermissionMode } from './PlanModeButton';
import { DocContextButton } from './DocContextButton';
import { ContextRing } from './ContextRing';
import { ThinkingLevelButton } from './ThinkingLevelButton';
import { ModelSelector } from './ModelSelector';
import { SendButton } from './SendButton';
import type { ThinkingLevel } from '../../stores/model-slice';
import type { Model } from '../../types';
import type { SessionModel } from '../../stores/chat-types';
import styles from './InputArea.module.css';

interface Props {
  t: (key: string) => string;
  onAttach: () => void;
  onBeforeOpenSkills?: () => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (v: PermissionMode) => void;
  planModeLocked: boolean;
  hasDoc: boolean;
  docContextAttached: boolean;
  onToggleDocContext: () => void;
  showThinking: boolean;
  thinkingLevel: ThinkingLevel;
  onThinkingChange: (level: ThinkingLevel) => void;
  availableThinkingLevels: ThinkingLevel[];
  models: Model[];
  sessionModel?: SessionModel;
  isStreaming: boolean;
  hasInput: boolean;
  canSend: boolean;
  onSend: () => void;
  onStop: () => void;
}

export const InputControlBar = memo(function InputControlBar(props: Props) {
  const {
    t, onAttach, onBeforeOpenSkills,
    permissionMode, onPermissionModeChange, planModeLocked, hasDoc, docContextAttached, onToggleDocContext,
    showThinking, thinkingLevel, onThinkingChange, availableThinkingLevels,
    models, sessionModel, isStreaming, hasInput, canSend, onSend, onStop,
  } = props;

  return (
    <div className={styles['input-bottom-bar']}>
      <div className={styles['input-actions']}>
        <InputUtilityButtons t={t} onAttach={onAttach} onBeforeOpenSkills={onBeforeOpenSkills} />
        <PlanModeButton mode={permissionMode} onChange={onPermissionModeChange} locked={planModeLocked} />
        {hasDoc && <DocContextButton active={docContextAttached} disabled={false} onToggle={onToggleDocContext} />}
        <ContextRing />
      </div>
      <div className={styles['input-controls']}>
        {showThinking && (
          <ThinkingLevelButton level={thinkingLevel} onChange={onThinkingChange} availableLevels={availableThinkingLevels} />
        )}
        <ModelSelector models={models} sessionModel={sessionModel} isStreaming={isStreaming} />
        <SendButton
          isStreaming={isStreaming}
          hasInput={hasInput}
          disabled={isStreaming ? false : !canSend}
          onSend={onSend}
          onStop={onStop}
        />
      </div>
    </div>
  );
});
