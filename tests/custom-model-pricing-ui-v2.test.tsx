/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ request: vi.fn(), toast: vi.fn() }));
vi.mock('../desktop/src/react/settings/api', () => ({ codiaFetch: api.request }));
vi.mock('../desktop/src/react/settings/store', () => ({ useSettingsStore: () => ({ showToast: api.toast, providersSummary: { local: { api: 'openai-completions', base_url: 'http://localhost:11434/v1' } } }) }));
vi.mock('../desktop/src/react/settings/helpers', () => ({ t: (key: string) => key, lookupModelMeta: () => ({}), CONTEXT_PRESETS: [], OUTPUT_PRESETS: [] }));
import { ModelEditPanel } from '../desktop/src/react/settings/tabs/providers/ModelEditPanel';
afterEach(cleanup);
beforeEach(() => { api.request.mockReset(); api.toast.mockReset(); api.request.mockResolvedValue({ ok: true }); });
function setup() {
  const close = vi.fn(); render(<ModelEditPanel modelId="custom" providerId="local" anchorEl={null} onClose={close} />); return close;
}
function fill() {
  fireEvent.click(screen.getByLabelText('配置当前模型价格'));
  for (const [label, value] of [['输入价格', '2'], ['输出价格', '4'], ['价格来源说明', 'Test vendor published rates']]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
describe('custom model pricing panel', () => {
  it('requires explicit confirmation and keeps entered values after validation failure', async () => {
    setup(); fill(); fireEvent.click(screen.getByText('settings.api.save'));
    expect(api.request).not.toHaveBeenCalled(); expect(screen.getByRole('alert').textContent).toContain('explicitly confirmed');
    expect((screen.getByLabelText('输入价格') as HTMLInputElement).value).toBe('2');
    fireEvent.click(screen.getByLabelText('我已核对以上价格及当前模型/端点'));
    fireEvent.click(screen.getByText('settings.api.save'));
    await waitFor(() => expect(api.request).toHaveBeenCalledTimes(1));
    const body = JSON.parse(api.request.mock.calls[0][1].body);
    expect(body.pricing).toMatchObject({ currency: 'USD', confirmed: true, source: 'Test vendor published rates', cost: { input: 2, output: 4, cacheRead: null, cacheWrite: null } });
  });
  it('blocks repeated save and retains the draft after a request error', async () => {
    const close = setup(); fill(); fireEvent.click(screen.getByLabelText('我已核对以上价格及当前模型/端点'));
    let reject!: (reason: Error) => void; api.request.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    fireEvent.click(screen.getByText('settings.api.save'));
    fireEvent.click(screen.getByText('保存中…'));
    expect(api.request).toHaveBeenCalledTimes(1);
    reject(new Error('save conflict'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('save conflict'));
    expect(close).not.toHaveBeenCalled(); expect((screen.getByLabelText('输出价格') as HTMLInputElement).value).toBe('4');
  });
  it('does not close a newer editor when an unmounted save completes', async () => {
    const close = vi.fn(); const mounted = render(<ModelEditPanel modelId="old" providerId="local" anchorEl={null} onClose={close} />);
    let resolve!: (value: unknown) => void; api.request.mockImplementation(() => new Promise(done => { resolve = done; }));
    fireEvent.click(screen.getByText('settings.api.save')); mounted.unmount(); resolve({ ok: true });
    await waitFor(() => expect(api.toast).toHaveBeenCalled()); expect(close).not.toHaveBeenCalled();
  });
  it('supports explicitly unknown pricing without transmitting zero placeholders', async () => {
    setup(); fill(); fireEvent.click(screen.getByLabelText('配置当前模型价格')); fireEvent.click(screen.getByText('settings.api.save'));
    await waitFor(() => expect(api.request).toHaveBeenCalledTimes(1));
    expect(JSON.parse(api.request.mock.calls[0][1].body).pricing).toBeNull();
  });
});
