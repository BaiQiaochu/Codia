import { describe, expect, it } from 'vitest';
import { getVsCodeFileIcon, getVsCodeFolderIcon } from '../../components/desk/desk-types';
import type { VsCodeFileIconThemeInfo } from '../../types';

const demoIcon = 'data:image/svg+xml;base64,PHN2Zy8+';
const folderIcon = 'data:image/svg+xml;base64,PGZvbGRlci8+';

const theme: VsCodeFileIconThemeInfo = {
  pluginId: 'vscode.demo.icons',
  themeId: 'demo',
  label: 'Demo',
  defaultFile: demoIcon,
  defaultFolder: folderIcon,
  defaultFolderExpanded: null,
  fileExtensions: {
    'test.ts': demoIcon,
    md: demoIcon,
  },
  fileNames: {
    dockerfile: demoIcon,
  },
  languageIds: {},
  folderNames: {
    src: folderIcon,
  },
  folderNamesExpanded: {},
  rootFolderNames: {},
  rootFolderNamesExpanded: {},
};

describe('VS Code file icon theme mapping', () => {
  it('maps exact file names and compound extensions', () => {
    expect(getVsCodeFileIcon('Dockerfile', [theme])).toContain(demoIcon);
    expect(getVsCodeFileIcon('component.test.ts', [theme])).toContain(demoIcon);
    expect(getVsCodeFileIcon('README.md', [theme])).toContain(demoIcon);
  });

  it('maps named folders and falls back to default folder icon', () => {
    expect(getVsCodeFolderIcon('src', [theme])).toContain(folderIcon);
    expect(getVsCodeFolderIcon('unknown', [theme])).toContain(folderIcon);
  });
});
