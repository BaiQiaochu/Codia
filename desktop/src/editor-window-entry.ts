/**
 * editor-window-entry.ts
 *
 * Standalone CodeMirror 6 entry for the detached editor window. Core
 * CodeMirror modules and mode-specific resources are loaded asynchronously so
 * the editor window shares less eager code with the preview path.
 */

import { loadCodeMirrorCore } from './react/editor/codemirror-core';
import { loadEditorModeResources } from './react/editor/mode-resources';
import { getDesktopApi } from './react/utils/desktop-api';
import type { MarkdownImageContext } from './react/utils/markdown';
import registry from './shared/theme-registry';

const SAVE_DELAY = 600;

interface EditorLoadData {
  filePath: string;
  title: string;
  type: string;
}

type EditorWindowApi = NonNullable<ReturnType<typeof getDesktopApi>> & {
  onEditorLoad?: (callback: (data: EditorLoadData) => void) => void;
  editorDock?: () => void;
  editorClose?: () => void;
};

const codia = getDesktopApi() as EditorWindowApi | undefined;
const titleEl = document.getElementById('editorTitle')!;
const bodyEl = document.getElementById('editorBody')!;
const btnDock = document.getElementById('btnDock')!;
const btnClose = document.getElementById('btnClose')!;

let filePath: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSavedContent = '';
let editorView: import('@codemirror/view').EditorView | null = null;
let fileWatcherBound = false;

function mapTypeToMode(type: string): 'markdown' | 'code' | 'csv' | 'text' {
  if (type === 'markdown') return 'markdown';
  if (type === 'csv') return 'csv';
  if (type === 'code') return 'code';
  return 'text';
}

async function createEditor(content: string, mode: 'markdown' | 'code' | 'csv' | 'text') {
  if (editorView) {
    editorView.destroy();
    editorView = null;
  }
  bodyEl.innerHTML = '';
  const markdownImageContext: MarkdownImageContext = {
    filePath,
    getFileUrl: codia?.getFileUrl?.bind(codia),
  };

  const [cm, modeResources] = await Promise.all([
    loadCodeMirrorCore(),
    loadEditorModeResources(mode, { markdownImageContext }),
  ]);

  const langComp = new cm.Compartment();
  const highlightComp = new cm.Compartment();
  const gutterComp = new cm.Compartment();
  const themeComp = new cm.Compartment();

  const extensions = [
    cm.drawSelection(),
    cm.history(),
    cm.bracketMatching(),
    cm.keymap.of([...cm.defaultKeymap, ...cm.historyKeymap]),
    cm.EditorView.lineWrapping,
    cm.EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const text = update.state.doc.toString();
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveContent(text), SAVE_DELAY);
    }),
    gutterComp.of(modeResources.showLineNumbers ? cm.lineNumbers() : []),
    langComp.of(modeResources.languageExtension),
    highlightComp.of(cm.syntaxHighlighting(modeResources.highlightStyle)),
    themeComp.of(modeResources.themeExtension),
    ...modeResources.extraExtensions,
  ];

  if (modeResources.highlightActiveLine) {
    extensions.push(cm.highlightActiveLine());
  }

  const state = cm.EditorState.create({ doc: content, extensions });
  editorView = new cm.EditorView({ state, parent: bodyEl });
}

async function saveContent(text: string) {
  if (!filePath) return;
  lastSavedContent = text;
  await codia?.writeFile(filePath, text);
}

async function loadContent(data: EditorLoadData) {
  filePath = data.filePath;
  titleEl.textContent = data.title || filePath.split('/').pop() || 'Editor';

  const mode = mapTypeToMode(data.type);
  if (mode === 'markdown' || mode === 'csv') bodyEl.classList.add('mode-markdown');
  else bodyEl.classList.remove('mode-markdown');

  const content = await codia?.readFile(filePath);
  if (content == null) return;

  await createEditor(content, mode);

  if (!fileWatcherBound && filePath) {
    fileWatcherBound = true;
    codia?.onFileChanged((changedPath: string) => {
      if (changedPath !== filePath) return;
      codia?.readFile(filePath).then((newContent: string | null) => {
        if (newContent == null || !editorView) return;
        if (newContent === lastSavedContent) return;
        const current = editorView.state.doc.toString();
        if (current === newContent) return;
        lastSavedContent = newContent;
        editorView.dispatch({
          changes: { from: 0, to: current.length, insert: newContent },
        });
      });
    });
  }

  codia?.watchFile(filePath);
}

codia?.onEditorLoad?.((data) => {
  loadContent(data);
});

btnDock.addEventListener('click', () => codia?.editorDock?.());
btnClose.addEventListener('click', () => codia?.editorClose?.());

const saved = registry.migrateSavedTheme(
  localStorage.getItem(registry.STORAGE_KEY) || localStorage.getItem(registry.LEGACY_STORAGE_KEY) || 'auto',
);
const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const theme = registry.resolveSavedTheme(saved, isDark).concrete;
const themeEntry = registry.THEMES[theme];
document.documentElement.setAttribute('data-theme', theme);
document.getElementById('themeSheet')!.setAttribute('href', themeEntry.cssPath);
