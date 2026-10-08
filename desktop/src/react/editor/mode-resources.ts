import type { Extension } from '@codemirror/state';
import type { Highlighter } from '@lezer/highlight';
import type { MarkdownImageContext } from '../utils/markdown';

type EditorMode = 'markdown' | 'code' | 'csv' | 'text';

export interface EditorModeOptions {
  markdownImageContext?: MarkdownImageContext;
}

export interface EditorModeResources {
  languageExtension: Extension;
  highlightStyle: Highlighter;
  themeExtension: Extension;
  extraExtensions: Extension[];
  showLineNumbers: boolean;
  highlightActiveLine: boolean;
}

export async function loadEditorModeResources(
  mode: EditorMode,
  options: EditorModeOptions = {},
): Promise<EditorModeResources> {
  if (mode === 'markdown') {
    const [
      { markdown, markdownLanguage },
      { compactCodeLanguages },
      { markdownHighlight },
      { markdownTheme },
      { markdownBlockDecoField, markdownDecoPlugin, markdownImageContextFacet },
      { linkClickHandler },
      { tableDecoField },
      { markdownCoverField },
      { mermaidDecoField },
    ] = await Promise.all([
      import('@codemirror/lang-markdown'),
      import('./code-languages'),
      import('./highlight'),
      import('./theme'),
      import('./md-decorations'),
      import('./link-handler'),
      import('./table-field'),
      import('./cover-field'),
      import('./mermaid-field'),
    ]);

    return {
      languageExtension: markdown({ base: markdownLanguage, codeLanguages: compactCodeLanguages }),
      highlightStyle: markdownHighlight,
      themeExtension: markdownTheme,
      extraExtensions: [
        markdownImageContextFacet.of(options.markdownImageContext ?? {}),
        markdownCoverField,
        markdownDecoPlugin,
        markdownBlockDecoField,
        mermaidDecoField,
        tableDecoField,
        linkClickHandler,
      ],
      showLineNumbers: false,
      highlightActiveLine: false,
    };
  }

  if (mode === 'csv') {
    const [
      { codeHighlight },
      { markdownTheme },
      { linkClickHandler },
      { csvTableField },
    ] = await Promise.all([
      import('./highlight'),
      import('./theme'),
      import('./link-handler'),
      import('./csv-field'),
    ]);

    return {
      languageExtension: [],
      highlightStyle: codeHighlight,
      themeExtension: markdownTheme,
      extraExtensions: [csvTableField, linkClickHandler],
      showLineNumbers: false,
      highlightActiveLine: false,
    };
  }

  const [
    { codeHighlight },
    { codeTheme },
    { linkClickHandler },
  ] = await Promise.all([
    import('./highlight'),
    import('./theme'),
    import('./link-handler'),
  ]);

  return {
    languageExtension: [],
    highlightStyle: codeHighlight,
    themeExtension: codeTheme,
    extraExtensions: [linkClickHandler],
    showLineNumbers: true,
    highlightActiveLine: true,
  };
}

export type { EditorMode };
