import { usePanel } from '../hooks/use-panel';
import fp from './FloatingPanels.module.css';
import { AutomationJobsSection } from './automation/AutomationJobsSection';

export function AutomationPanel() {
  const t = window.t ?? ((path: string) => path);
  const { visible, close } = usePanel('automation');

  if (!visible) return null;

  return (
    <div className={fp.floatingPanel} id="automationPanel">
      <div className={fp.floatingPanelInner}>
        <div className={fp.floatingPanelHeader}>
          <h2 className={fp.floatingPanelTitle}>{t('automation.title')}</h2>
          <button className={fp.floatingPanelClose} type="button" onClick={close}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className={fp.floatingPanelBody}>
          <AutomationJobsSection />
        </div>
      </div>
    </div>
  );
}
