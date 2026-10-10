import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { codiaFetch } from '../api';
import { t } from '../helpers';
import { getErrorMessage, type TextContentPayload } from '../shared-types';
import { renderMarkdown } from '../../utils/markdown';
import { useMermaidDiagrams } from '../../hooks/use-mermaid-diagrams';
import styles from '../Settings.module.css';

export function CompiledMemoryViewer() {
  const [visible, setVisible] = useState(false);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const contentRef = React.useRef<HTMLDivElement>(null);
  useMermaidDiagrams(contentRef, [content, loading]);

  useEffect(() => {
    const handler = () => { setVisible(true); load(); };
    window.addEventListener('codia-view-compiled-memory', handler);
    return () => window.removeEventListener('codia-view-compiled-memory', handler);
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const aid = useSettingsStore.getState().getSettingsAgentId();
      const res = await codiaFetch(`/api/memories/compiled?agentId=${aid}`);
      const data = await res.json() as TextContentPayload;
      setContent(data.content || '');
    } catch (err: unknown) {
      setContent(`Error: ${getErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const clearCompiled = async () => {
    try {
      const aid = useSettingsStore.getState().getSettingsAgentId();
      await codiaFetch(`/api/memories/compiled?agentId=${aid}`, { method: 'DELETE' });
      setContent('');
      useSettingsStore.getState().showToast(t('settings.memory.compiledCleared'), 'success');
    } catch (err: unknown) {
      useSettingsStore.getState().showToast(getErrorMessage(err), 'error');
    }
  };

  const close = () => setVisible(false);

  if (!visible) return null;

  return (
    <div className={`${styles['memory-viewer-overlay']} ${styles['visible']}`} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className={styles['memory-viewer']}>
        <div className={styles['memory-viewer-header']}>
          <h3 className={styles['memory-viewer-title']}>{t('settings.memory.compiled')}</h3>
          <div className={styles['memory-viewer-header-actions']}>
            <button type="button" className={styles['compiled-clear-btn']} onClick={clearCompiled}>
              {t('settings.memory.compiledClear')}
            </button>
            <button type="button" className={styles['memory-viewer-close']} onClick={close}>×</button>
          </div>
        </div>
        <div className={`${styles['memory-viewer-body']} ${styles['compiled-memory-body']}`}>
          {loading ? (
            <div className="memory-viewer-empty">Loading...</div>
          ) : content.trim() ? (
            <div ref={contentRef} className={`${styles['compiled-memory-md']} ${'md-content'}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
          ) : (
            <div className="memory-viewer-empty">{t('settings.memory.compiledEmpty')}</div>
          )}
        </div>
      </div>
    </div>
  );
}
