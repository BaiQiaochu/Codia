import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { codia } from '@codia/plugin-sdk';
import {
  Button,
  CardShell,
  EmptyState,
  CodiaThemeProvider,
  List,
  Select,
  SettingRow,
  Switch,
  TextInput,
} from '@codia/plugin-components';
import '@codia/plugin-components/styles.css';

type ThemeMode = 'inherit' | 'codia' | 'custom';

function Panel() {
  const surface = document.getElementById('root')?.dataset.surface || 'page';
  const [themeMode, setThemeMode] = useState<ThemeMode>('inherit');
  const [title, setTitle] = useState('SDK Showcase');
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    codia.ready();
    codia.ui.resize({ height: surface === 'widget' ? 300 : 460 });
  }, [surface]);

  const customTheme = useMemo(() => (
    themeMode === 'custom'
      ? { bg: '#F7F4EF', bgCard: '#FFFDF8', accent: '#537D96' }
      : undefined
  ), [themeMode]);

  async function copyTitle() {
    await codia.clipboard.writeText(title);
    await codia.toast.show({ message: 'Copied title', type: 'success' });
  }

  return (
    <CodiaThemeProvider mode={themeMode} theme={customTheme || (themeMode === 'codia' ? 'warm-paper' : undefined)}>
      <CardShell
        title={title}
        description="A compact example using Codia plugin SDK packages."
        actions={<Button variant="ghost" onClick={() => codia.external.open('https://example.com')}>Open</Button>}
        footer={<Button variant="primary" onClick={copyTitle}>Copy title</Button>}
      >
        <SettingRow
          label="Enabled"
          hint="Switch state stays local to this iframe."
          control={<Switch checked={enabled} onChange={setEnabled} label={enabled ? 'On' : 'Off'} />}
        />
        <SettingRow
          label="Theme"
          control={
            <Select
              value={themeMode}
              onChange={(value) => setThemeMode(value as ThemeMode)}
              options={[
                { value: 'inherit', label: 'Follow Codia' },
                { value: 'codia', label: 'Warm paper' },
                { value: 'custom', label: 'Custom' },
              ]}
            />
          }
        />
        <TextInput label="Title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
        <List
          items={[
            { id: 'runtime', title: '@codia/plugin-runtime', meta: 'Node' },
            { id: 'sdk', title: '@codia/plugin-sdk', meta: 'iframe' },
            { id: 'components', title: '@codia/plugin-components', meta: 'React' },
          ]}
        />
        {!enabled && <EmptyState title="Paused" description="Turn the switch back on to resume actions." />}
      </CardShell>
    </CodiaThemeProvider>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Panel />);
