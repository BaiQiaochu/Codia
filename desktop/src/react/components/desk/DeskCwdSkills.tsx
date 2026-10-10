/**
  *
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { codiaFetch } from '../../hooks/use-codia-fetch';
import { resolveBrowserFilePaths } from '../../utils/browser-file-paths';
import { isWebRuntime } from '../../utils/platform-runtime';
import type { CwdSkillInfo } from '../../stores/desk-slice';
import css from './Desk.module.css';

//

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function loadCwdSkills() {
  const s = useStore.getState();
  if (!s.deskBasePath) return;
  const snapshot = {
    sessionPath: s.currentSessionPath || null,
    deskBasePath: s.deskBasePath,
    selectedAgentId: s.selectedAgentId || null,
  };
  try {
    const params = new URLSearchParams({ dir: snapshot.deskBasePath });
    if (snapshot.selectedAgentId) params.set('agentId', snapshot.selectedAgentId);
    const res = await codiaFetch(
      `/api/desk/skills?${params}`,
    );
    const data = await res.json();
    const now = useStore.getState();
    if ((now.currentSessionPath || null) !== snapshot.sessionPath) return;
    if ((now.deskBasePath || '') !== snapshot.deskBasePath) return;
    if ((now.selectedAgentId || null) !== snapshot.selectedAgentId) return;
    now.setCwdSkills(data.skills || []);
  } catch { /* ignore */ }
}

function useCwdSkillsOpen() {
  const cwdSkills = useStore(s => s.cwdSkills);
  const cwdSkillsOpen = useStore(s => s.cwdSkillsOpen);
  return {
    open: cwdSkillsOpen,
    skills: cwdSkills,
    toggle: () => useStore.getState().toggleCwdSkillsOpen(),
    setSkills: (skills: CwdSkillInfo[]) => useStore.getState().setCwdSkills(skills),
  };
}

// ── CWD Skills 按钮 ──

export function DeskCwdSkillsButton() {
  const deskBasePath = useStore(s => s.deskBasePath);
  const { open, skills, toggle } = useCwdSkillsOpen();
  const loadedRef = useRef('');

  useEffect(() => {
    if (deskBasePath && deskBasePath !== loadedRef.current) {
      loadCwdSkills().then(() => { loadedRef.current = deskBasePath; });
    }
  }, [deskBasePath]);

  const handleClick = useCallback(() => {
    if (!open) loadCwdSkills();
    toggle();
  }, [open, toggle]);

  if (!deskBasePath) return null;

  const t = window.t ?? ((p: string) => p);
  const label = skills.length > 0
    ? `${t('desk.cwdSkills')} 路 ${skills.length}`
    : t('desk.cwdSkills');

  return (
    <button type="button"
      className={`${css.cwdBtn} ${css.headerCwdBtn}${open ? ` ${css.active}` : ''}`}
      onClick={handleClick}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
      <span>{label}</span>
    </button>
  );
}

// ── CWD Skills 面板 ──

export function DeskCwdSkillsPanel() {
  const { open, skills } = useCwdSkillsOpen();
  const t = window.t ?? ((p: string) => p);
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setVisible(true);
      setClosing(false);
    } else if (visible) {
      setClosing(true);
      const timer = setTimeout(() => { setVisible(false); setClosing(false); }, 80);
      return () => clearTimeout(timer);
    }
 // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const [dragging, setDragging] = useState(false);
  const [cmPos, setCmPos] = useState<{ x: number; y: number } | null>(null);
  const [cmSkill, setCmSkill] = useState<CwdSkillInfo | null>(null);

  useEffect(() => {
    if (!cmPos) return;
    const close = () => { setCmPos(null); setCmSkill(null); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [cmPos]);

  const deleteSkill = useCallback(async (skill: CwdSkillInfo) => {
    if (!skill.baseDir) return;
    try {
      await codiaFetch('/api/desk/delete-skill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillDir: skill.baseDir }),
      });
      await loadCwdSkills();
    } catch (err) {
      console.error('[cwd-skills] delete failed:', err);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    const dir = useStore.getState().deskBasePath;
    console.log('[cwd-skills] drop: files=', files.length, 'dir=', dir);
    if (!dir) return;
    let installed = false;
    const { paths, nameMap } = await resolveBrowserFilePaths(files);
    for (const filePath of paths) {
      console.log('[cwd-skills] filePath=', filePath, 'file.name=', nameMap[filePath]);
      try {
        const s = useStore.getState();
        const res = await codiaFetch('/api/desk/install-skill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath, dir, ...(s.selectedAgentId ? { agentId: s.selectedAgentId } : {}) }),
        });
        const data = await res.json();
        if (data.error) {
          console.warn('[cwd-skills] install failed:', data.error);
        } else {
          console.log('[cwd-skills] installed:', data.name);
          installed = true;
        }
      } catch (err) {
        console.error('[cwd-skills] install failed:', err);
      }
    }
    const handledNames = new Set(paths.map(filePath => nameMap[filePath]).filter(Boolean));
    const uploadOnlyFiles = files.filter(file => !handledNames.has(file.name));
    for (const file of uploadOnlyFiles) {
      try {
        const s = useStore.getState();
        const res = await codiaFetch('/api/desk/install-skill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dir,
            ...(s.selectedAgentId ? { agentId: s.selectedAgentId } : {}),
            file: {
              filename: file.name,
              contentBase64: await fileToBase64(file),
            },
          }),
        });
        const data = await res.json();
        if (data.error) {
          console.warn('[cwd-skills] upload install failed:', data.error);
        } else {
          console.log('[cwd-skills] uploaded:', data.name);
          installed = true;
        }
      } catch (err) {
        console.error('[cwd-skills] upload install failed:', err);
      }
    }
    if (installed) await loadCwdSkills();
    window.__loadDeskSkills?.();
  }, []);

  if (!visible) return null;

  const grouped: Record<string, CwdSkillInfo[]> = {};
  for (const s of skills) {
    (grouped[s.source] ??= []).push(s);
  }

  return (
    <div className={`${css.cwdPanelWrap}${closing ? ` ${css.closing}` : ''}`}>
      <div
        className={`${css.cwdPanel}${dragging ? ` ${css.dragOver}` : ''}`}
        data-desk-cwd-panel=""
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCmPos({ x: e.clientX, y: e.clientY });
        }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { handleDrop(e); }}
      >
        <div className={css.cwdDescLine}>
          <span className={css.cwdDescDeco} />
          <span className={css.cwdDescText}>{t('desk.cwdSkillsDesc')}</span>
          <span className={css.cwdDescDeco} />
        </div>

        {skills.length === 0 ? (
          <>
            <p className={css.cwdEmpty}>{t('desk.cwdSkillsEmpty')}</p>
            <p className={css.cwdHint}>{t('desk.cwdSkillsDrop')}</p>
          </>
        ) : (
          <>
            {Object.entries(grouped).map(([source, items]) => (
              <div key={source}>
                <div className={css.cwdGroupLabel}>{source}</div>
                {items.map(s => {
                  let desc = s.description || '';
                  if (desc.length > 60) desc = desc.slice(0, 60) + '...';
                  return (
                    <div
                      className={css.cwdSkillItem}
                      key={s.name}
                      onDoubleClick={() => {
                        window.platform?.openSkillViewer?.({
                          name: s.name,
                          baseDir: s.baseDir,
                          filePath: s.filePath,
                          installed: false,
                        });
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setCmPos({ x: e.clientX, y: e.clientY });
                        setCmSkill(s);
                      }}
                    >
                      <span className={css.cwdSkillName}>{s.name}</span>
                      {desc && <span className={css.cwdSkillDesc}>{desc}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
            <p className={css.cwdHint}>{t('desk.cwdSkillsDrop')}</p>
          </>
        )}
        {cmPos && (
          <div className={css.cwdCtxMenu} style={{ position: 'fixed', left: cmPos.x, top: cmPos.y, zIndex: 9999 }}>
            {!isWebRuntime() && (
              <button type="button" onClick={() => {
                const target = cmSkill?.baseDir || (useStore.getState().deskBasePath + '/.agents/skills');
                window.platform?.showInFinder?.(target);
                setCmPos(null);
              }}>
                {t('desk.openInFinder')}
              </button>
            )}
            {cmSkill && (
              <button type="button" className={css.cwdCtxDanger} onClick={() => {
                deleteSkill(cmSkill);
                setCmPos(null);
              }}>
                {t('desk.deleteSkill')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
