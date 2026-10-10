/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../../store';

const mocks = vi.hoisted(() => ({
  autoSaveGlobalModels: vi.fn(),
  codiaFetch: vi.fn(),
  modelWidgetProps: [] as Array<{
    value: unknown;
    modelsPath?: string;
    allowClear?: boolean;
    onSelect: (ref: { id: string; provider: string } | null) => void;
  }>,
}));

vi.mock('../../../helpers', () => ({
  t: (key: string) => key,
  lookupModelMeta: vi.fn(),
  formatContext: (n: number) => String(n),
  autoSaveGlobalModels: mocks.autoSaveGlobalModels,
}));

vi.mock('../../../api', () => ({
  codiaFetch: (...args: unknown[]) => mocks.codiaFetch(...args),
}));

vi.mock('../../../actions', () => ({
  loadSettingsConfig: vi.fn(),
}));

vi.mock('../../../widgets/ModelWidget', () => ({
  ModelWidget: (props: {
    value: unknown;
    modelsPath?: string;
    allowClear?: boolean;
    onSelect: (ref: { id: string; provider: string } | null) => void;
  }) => {
    mocks.modelWidgetProps.push(props);
    return (
    <button
      type="button"
      data-testid="model-widget"
      data-value={typeof props.value === 'string' ? props.value : JSON.stringify(props.value)}
      onClick={() => props.onSelect({ id: 'gpt-4o', provider: 'openai' })}
    >
      model-widget
    </button>
    );
  },
}));

vi.mock('../../../widgets/SelectWidget', () => ({
  SelectWidget: ({
    options = [],
    value,
    onChange,
  }: {
    options?: Array<{ value: string; label: string }>;
    value?: string;
    onChange?: (value: string) => void;
  }) => (
    <select
      data-testid="select-widget"
      value={value || ''}
      onChange={(event) => onChange?.(event.currentTarget.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
}));

vi.mock('../../../widgets/KeyInput', () => ({
  KeyInput: ({ value, onChange, placeholder }: { value: string; onChange: (next: string) => void; placeholder?: string }) => (
    <input
      data-testid="key-input"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

vi.mock('../../../widgets/Toggle', () => ({
  Toggle: ({ on, onChange, label }: { on: boolean; onChange: (next: boolean) => void; label?: string }) => (
    <button
      type="button"
      data-testid={`toggle-${on ? 'on' : 'off'}`}
      onClick={() => onChange(!on)}
    >
      {label}
    </button>
  ),
}));

import { OtherModelsSection } from '../OtherModelsSection';

describe('OtherModelsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.modelWidgetProps.length = 0;
    mocks.codiaFetch.mockResolvedValue({ json: async () => ({ ok: true }) });
    useSettingsStore.setState({
      globalModelsConfig: {
        models: {
          utility: 'legacy-utility',
          utility_large: null,
          vision: { id: 'gpt-4o', provider: 'openai' },
          vision_enabled: false,
        },
        search: { provider: 'auto', api_key: '', api_keys: {} },
        utility_api: {},
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the auxiliary vision toggle above the vision model picker and saves the global flag', () => {
    render(<OtherModelsSection providers={{ openai: { models: ['gpt-4o'] } }} />);

    const visionLabel = screen.getByText('settings.api.visionModel');
    const toggle = screen.getByRole('button', { name: 'settings.api.visionAuxiliaryToggle' });
    const visionModelWidget = screen.getAllByTestId('model-widget')[2];

    expect(visionLabel.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.compareDocumentPosition(visionModelWidget) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(toggle);

    expect(mocks.autoSaveGlobalModels).toHaveBeenCalledWith({
      models: { vision_enabled: true },
    });

    expect(mocks.modelWidgetProps[2]).toMatchObject({
      modelsPath: '/api/models?include=vision',
      allowClear: true,
    });

    fireEvent.click(visionModelWidget);

    expect(mocks.autoSaveGlobalModels).toHaveBeenCalledWith({
      models: { vision: { id: 'gpt-4o', provider: 'openai' } },
    });
  });

  it('keeps model test buttons visible for legacy bare model ids', () => {
    const { container } = render(<OtherModelsSection providers={{ openai: { models: ['gpt-4o'] } }} />);

    const iconOnlyButtons = Array.from(container.querySelectorAll('button'))
      .filter((button) => !button.textContent?.trim());

    expect(iconOnlyButtons).toHaveLength(2);
  });

  it('uses the responsive provider form layout for the bottom model controls', () => {
    const { container } = render(<OtherModelsSection providers={{ openai: { models: ['gpt-4o'] } }} />);

    expect(container.firstElementChild?.className).toContain('providers-other-models');

    const rows = Array.from(container.querySelectorAll('[class*="settings-form-grid"]'));
    expect(rows).toHaveLength(3);

    for (const row of rows) {
      expect(row.className).toContain('provider-model-grid');
    }

    for (const field of container.querySelectorAll('[class*="settings-form-field-half"]')) {
      expect(field.className).toContain('provider-model-field');
    }
  });

  it('verifies individual search API keys while staying in auto search mode', async () => {
    useSettingsStore.setState({
      globalModelsConfig: {
        models: {
          utility: 'legacy-utility',
          utility_large: null,
          vision: null,
          vision_enabled: false,
        },
        search: { provider: 'auto', api_key: '', api_keys: { brave: 'old-brave' } },
        utility_api: {},
      },
    });

    render(<OtherModelsSection providers={{ openai: { models: ['gpt-4o'] } }} />);

    const keyInputs = screen.getAllByTestId('key-input');
    expect(keyInputs).toHaveLength(4);
    expect(screen.getAllByText('AnySearch').length).toBeGreaterThan(0);
    expect(screen.getByText('settings.api.searchApiKeysAutoHint')).toBeTruthy();

    fireEvent.change(keyInputs[1], { target: { value: 'tvly-secret' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'settings.search.verify' })[1]);

    await waitFor(() => expect(mocks.codiaFetch).toHaveBeenCalledWith('/api/search/verify', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        provider: 'tavily',
        api_key: 'tvly-secret',
        search_provider: 'auto',
      }),
    })));
  });

  it('lets paid AnySearch be selected directly and shows its API key input', () => {
    useSettingsStore.setState({
      globalModelsConfig: {
        models: {
          utility: 'legacy-utility',
          utility_large: null,
          vision: null,
          vision_enabled: false,
        },
        search: { provider: 'anysearch', api_key: 'paid-any', api_keys: { anysearch: 'paid-any' } },
        utility_api: {},
      },
    });

    render(<OtherModelsSection providers={{ openai: { models: ['gpt-4o'] } }} />);

    const select = screen.getByTestId('select-widget') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(expect.arrayContaining([
      'anysearch',
      'anysearch_free',
    ]));
    expect(select.value).toBe('anysearch');
    expect(screen.getAllByTestId('key-input')).toHaveLength(1);
    expect((screen.getByTestId('key-input') as HTMLInputElement).value).toBe('paid-any');
  });

  it('lets AnySearch free be selected directly without showing API key inputs', () => {
    useSettingsStore.setState({
      globalModelsConfig: {
        models: {
          utility: 'legacy-utility',
          utility_large: null,
          vision: null,
          vision_enabled: false,
        },
        search: { provider: 'anysearch_free', api_key: '', api_keys: { brave: 'old-brave' } },
        utility_api: {},
      },
    });

    render(<OtherModelsSection providers={{ openai: { models: ['gpt-4o'] } }} />);

    const select = screen.getByTestId('select-widget') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toContain('anysearch_free');
    expect(select.value).toBe('anysearch_free');
    expect(screen.queryAllByTestId('key-input')).toHaveLength(0);
    expect(screen.getByText('settings.api.searchApiKeyNotRequired')).toBeTruthy();

    fireEvent.change(select, { target: { value: 'anysearch_free' } });
    expect(mocks.autoSaveGlobalModels).toHaveBeenCalledWith({
      search: { provider: 'anysearch_free', api_key: '' },
    });
  });
});
