/**
 * ChannelWarningModal -频道启用确认对话- *
  * */

import { useI18n } from '../../hooks/use-i18n';

interface ChannelWarningModalProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ChannelWarningModal({ open, onConfirm, onCancel }: ChannelWarningModalProps) {
  const { t } = useI18n();

  if (!open) return null;

  const bodyText = t('channel.warningBody') || '';
  const paragraphs = bodyText.split('\n\n');

  return (
    <div className="gsap-warning-overlay">
      <div className="gsap-warning-box">
        <h3 className="gsap-warning-title">{t('channel.warningTitle')}</h3>
        <div className="gsap-warning-body">
          {paragraphs.map((para, i) => {
            const lines = para.split('\n');
            return (
              <p key={`warning-para-${i}`}>
                {lines.map((line, j) => (
                  j === 0
                    ? <span key={`warning-line-${i}-${j}`}>{line}</span>
                    : <span key={`warning-line-${i}-${j}`}><br />{line}</span>
                ))}
              </p>
            );
          })}
        </div>
        <div className="gsap-warning-actions">
          <button type="button" className="gsap-warning-cancel" onClick={onCancel}>
            {t('channel.createCancel')}
          </button>
          <button type="button" className="gsap-warning-confirm" onClick={onConfirm}>
            {t('channel.warningConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
