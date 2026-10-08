import { LanguageDescription } from '@codemirror/language';

export const compactCodeLanguages = [
  LanguageDescription.of({
    name: 'JavaScript',
    alias: ['js', 'node'],
    extensions: ['js', 'mjs', 'cjs'],
    load: async () => (await import('@codemirror/lang-javascript')).javascript(),
  }),
  LanguageDescription.of({
    name: 'TypeScript',
    alias: ['ts'],
    extensions: ['ts'],
    load: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  }),
  LanguageDescription.of({
    name: 'JSX',
    extensions: ['jsx'],
    load: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  }),
  LanguageDescription.of({
    name: 'TSX',
    extensions: ['tsx'],
    load: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true }),
  }),
  LanguageDescription.of({
    name: 'HTML',
    alias: ['xhtml'],
    extensions: ['html', 'htm'],
    load: async () => (await import('@codemirror/lang-html')).html({ matchClosingTags: false }),
  }),
  LanguageDescription.of({
    name: 'CSS',
    extensions: ['css'],
    load: async () => (await import('@codemirror/lang-css')).css(),
  }),
  LanguageDescription.of({
    name: 'JSON',
    alias: ['json5'],
    extensions: ['json', 'map'],
    load: async () => (await import('@codemirror/lang-json')).json(),
  }),
  LanguageDescription.of({
    name: 'Python',
    alias: ['py'],
    extensions: ['py', 'pyw'],
    load: async () => (await import('@codemirror/lang-python')).python(),
  }),
  LanguageDescription.of({
    name: 'SQL',
    extensions: ['sql'],
    load: async () => (await import('@codemirror/lang-sql')).sql(),
  }),
  LanguageDescription.of({
    name: 'YAML',
    alias: ['yml'],
    extensions: ['yaml', 'yml'],
    load: async () => (await import('@codemirror/lang-yaml')).yaml(),
  }),
  LanguageDescription.of({
    name: 'XML',
    extensions: ['xml', 'svg'],
    load: async () => (await import('@codemirror/lang-xml')).xml(),
  }),
] as const;
