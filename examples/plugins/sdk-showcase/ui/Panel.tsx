import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { gsap } from '@g-sap/plugin-sdk';
import {
  Button,
  CardShell,
  EmptyState,
  GsapThemeProvider,
  List,
  Select,
  SettingRow,
  Switch,
  TextInput,
} from '@g-sap/plugin-components';
import '@g-sap/plugin-components/styles.css';

type ThemeMode = 'inherit' | 'gsap' | 'custom';

function Panel() {
  const surface = document.getElementById('root')?.dataset.surface || 'page';
  const [themeMode, setThemeMode] = useState<ThemeMode>('inherit');
  const [title, setTitle] = useState('SDK Showcase');
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    gsap.ready();
    gsap.ui.resize({ height: surface === 'widget' ? 300 : 460 });
  }, [surface]);

  const customTheme = useMemo(() => (
    themeMode === 'custom'
      ? { bg: '#F7F4EF', bgCard: '#FFFDF8', accent: '#537D96' }
      : undefined
  ), [themeMode]);

  async function copyTitle() {
    await gsap.clipboard.writeText(title);
    await gsap.toast.show({ message: 'Copied title', type: 'success' });
  }

  return (
    <GsapThemeProvider mode={themeMode} theme={customTheme || (themeMode === 'gsap' ? 'warm-paper' : undefined)}>
      <CardShell
        title={title}
        description="A compact example using G-SAP plugin SDK packages."
        actions={<Button variant="ghost" onClick={() => gsap.external.open('https://example.com')}>Open</Button>}
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
                { value: 'inherit', label: 'Follow G-SAP' },
                { value: 'gsap', label: 'Warm paper' },
                { value: 'custom', label: 'Custom' },
              ]}
            />
          }
        />
        <TextInput label="Title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
        <List
          items={[
            { id: 'runtime', title: '@g-sap/plugin-runtime', meta: 'Node' },
            { id: 'sdk', title: '@g-sap/plugin-sdk', meta: 'iframe' },
            { id: 'components', title: '@g-sap/plugin-components', meta: 'React' },
          ]}
        />
        {!enabled && <EmptyState title="Paused" description="Turn the switch back on to resume actions." />}
      </CardShell>
    </GsapThemeProvider>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Panel />);
