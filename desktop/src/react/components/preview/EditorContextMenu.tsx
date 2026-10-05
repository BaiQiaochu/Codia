import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { undo, redo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { useStore } from '../../stores';
import type { ArtifactEditorHandle } from '../PreviewEditor';
import {
  insertCodeBlock,
  insertHorizontalRule,
  setHeading,
  toggleBlockquote,
  toggleBold,
  toggleInlineCode,
  toggleItalic,
  toggleList,
  toggleStrikethrough,
} from '../../editor/markdown-commands';

interface MenuState {
  x: number;
  y: number;
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

interface Props {
  editorRef: RefObject<ArtifactEditorHandle | null>;
  containerRef: RefObject<HTMLDivElement | null>;
}

function hasSelection(view: EditorView): boolean {
  return view.state.selection.ranges.some(range => !range.empty);
}

function canRun(command: (target: { state: EditorView['state']; dispatch: EditorView['dispatch'] }) => boolean, view: EditorView): boolean {
  return command({ state: view.state, dispatch: () => {} });
}

function label(key: string, fallback: string): string {
  const value = window.t?.(key);
  return value && value !== key ? value : fallback;
}

export function EditorContextMenu({ editorRef, containerRef }: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const getView = useCallback(() => editorRef.current?.getView() ?? null, [editorRef]);
  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const handleContextMenu = (event: MouseEvent) => {
      const view = getView();
      if (!view) return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || !container.contains(target)) return;

      event.preventDefault();
      event.stopPropagation();
      useStore.getState().clearQuoteCandidate();
      setMenu({
        x: event.clientX,
        y: event.clientY,
        hasSelection: hasSelection(view),
        canUndo: canRun(undo, view),
        canRedo: canRun(redo, view),
      });
    };

    container.addEventListener('contextmenu', handleContextMenu);
    return () => container.removeEventListener('contextmenu', handleContextMenu);
  }, [containerRef, getView]);

  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const element = menuRef.current;
    const rect = element.getBoundingClientRect();
    const x = Math.max(4, Math.min(menu.x, window.innerWidth - rect.width - 4));
    const y = Math.max(4, Math.min(menu.y, window.innerHeight - rect.height - 4));
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
  }, [menu]);

  useEffect(() => {
    if (!menu) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onPointer, true);
    document.addEventListener('contextmenu', onPointer, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onPointer, true);
      document.removeEventListener('contextmenu', onPointer, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [close, menu]);

  const runEditCommand = useCallback(async (command: 'cut' | 'copy' | 'paste' | 'selectAll') => {
    const view = getView();
    if (!view) return;
    view.focus();
    await window.platform?.runEditCommand?.(command);
  }, [getView]);

  const runCodeMirrorCommand = useCallback((command: (view: EditorView) => void) => {
    const view = getView();
    if (view) command(view);
  }, [getView]);

  if (!menu) return null;

  const isMac = navigator.platform?.startsWith('Mac') || navigator.userAgent.includes('Mac');
  const mod = isMac ? 'Cmd+' : 'Ctrl+';

  return createPortal(
    <div ref={menuRef} className="context-menu" style={{ left: menu.x, top: menu.y }}>
      <MenuItem label={label('ctx.cut', '剪切')} shortcut={`${mod}X`} disabled={!menu.hasSelection} onClick={() => { close(); void runEditCommand('cut'); }} />
      <MenuItem label={label('ctx.copy', '复制')} shortcut={`${mod}C`} disabled={!menu.hasSelection} onClick={() => { close(); void runEditCommand('copy'); }} />
      <MenuItem label={label('ctx.paste', '粘贴')} shortcut={`${mod}V`} onClick={() => { close(); void runEditCommand('paste'); }} />
      <div className="context-menu-divider" />
      <MenuItem label={label('ctx.selectAll', '全选')} shortcut={`${mod}A`} onClick={() => { close(); void runEditCommand('selectAll'); }} />
      <div className="context-menu-divider" />
      <MenuItem label={label('ctx.undo', '撤销')} shortcut={`${mod}Z`} disabled={!menu.canUndo} onClick={() => { close(); runCodeMirrorCommand(undo); }} />
      <MenuItem label={label('ctx.redo', '重做')} shortcut={isMac ? 'Shift+Cmd+Z' : 'Ctrl+Y'} disabled={!menu.canRedo} onClick={() => { close(); runCodeMirrorCommand(redo); }} />
      <div className="context-menu-divider" />
      <div className="context-menu-fmt-row">
        <FmtButton title={label('ctx.bold', '加粗')} onClick={() => { close(); runCodeMirrorCommand(toggleBold); }}>B</FmtButton>
        <FmtButton title={label('ctx.italic', '斜体')} onClick={() => { close(); runCodeMirrorCommand(toggleItalic); }}><span style={{ fontStyle: 'italic' }}>I</span></FmtButton>
        <FmtButton title={label('ctx.strikethrough', '删除线')} onClick={() => { close(); runCodeMirrorCommand(toggleStrikethrough); }}><span style={{ textDecoration: 'line-through' }}>S</span></FmtButton>
        <FmtButton title={label('ctx.inlineCode', '行内代码')} onClick={() => { close(); runCodeMirrorCommand(toggleInlineCode); }}>{'<>'}</FmtButton>
        <FmtButton title={label('ctx.heading1', '一级标题')} onClick={() => { close(); runCodeMirrorCommand(view => setHeading(view, 1)); }}>H1</FmtButton>
        <FmtButton title={label('ctx.heading2', '二级标题')} onClick={() => { close(); runCodeMirrorCommand(view => setHeading(view, 2)); }}>H2</FmtButton>
        <FmtButton title={label('ctx.heading3', '三级标题')} onClick={() => { close(); runCodeMirrorCommand(view => setHeading(view, 3)); }}>H3</FmtButton>
      </div>
      <div className="context-menu-fmt-row">
        <FmtButton title={label('ctx.blockquote', '引用')} onClick={() => { close(); runCodeMirrorCommand(toggleBlockquote); }}>“</FmtButton>
        <FmtButton title={label('ctx.codeBlock', '代码块')} onClick={() => { close(); runCodeMirrorCommand(insertCodeBlock); }}>```</FmtButton>
        <FmtButton title={label('ctx.horizontalRule', '分隔线')} onClick={() => { close(); runCodeMirrorCommand(insertHorizontalRule); }}>--</FmtButton>
        <FmtButton title={label('ctx.list', '列表')} onClick={() => { close(); runCodeMirrorCommand(toggleList); }}>•</FmtButton>
      </div>
    </div>,
    document.body,
  );
}

function MenuItem(props: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`context-menu-item${props.disabled ? ' disabled' : ''}`}
      disabled={props.disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        if (!props.disabled) props.onClick();
      }}
    >
      <span className="context-menu-label">{props.label}</span>
      {props.shortcut && <span className="context-menu-shortcut">{props.shortcut}</span>}
    </button>
  );
}

function FmtButton(props: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="context-menu-fmt-btn"
      title={props.title}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
    >
      <span className="context-menu-fmt-text">{props.children}</span>
    </button>
  );
}
