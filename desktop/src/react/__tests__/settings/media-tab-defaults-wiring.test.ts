import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('MediaTab default media model wiring', () => {
  it('saves selected global defaults, reflects local state, and clears with null', () => {
    const source = read('settings/tabs/MediaTab.tsx');

    expect(source).toContain('defaultImageModel');
    expect(source).toContain('defaultAudioModel');
    expect(source).toContain('defaultMusicModel');
    expect(source).toContain('defaultVideoModel');
    expect(source).toContain('body: JSON.stringify({ values: updates })');
    expect(source).toContain('const [config, setConfig] = useState<ImageGenConfigPayload | null>(null)');
    expect(source).toContain('const [imageConfigLoading, setImageConfigLoading] = useState(true)');
    expect(source).toContain('setConfig(prev => ({ ...(prev || {}), ...updates }))');
    expect(source).toContain('saveConfig({ [configKey]: null');
    expect(source).toContain("saveConfig({ [configKey]: { id: rest.join('/'), provider } })");
  });

  it('keeps the original media shell while exposing local voice controls and scan diagnostics', () => {
    const source = read('settings/tabs/MediaTab.tsx');

    expect(source).toContain("settings.media.speechRecognition");
    expect(source).toContain("settings.media.speechSynthesis");
    expect(source).toContain("settings.media.scanDiagnostics");
    expect(source).toContain('const [speechConfig, setSpeechConfig] = useState<SpeechConfig | null>(null)');
    expect(source).toContain('const [speechConfigLoading, setSpeechConfigLoading] = useState(true)');
    expect(source).toContain('<Toggle');
    expect(source).toContain("media-defaults-grid");
    expect(source).toContain("media-default-field");
    expect(source).toContain("voice-input-device");
    expect(source).toContain("voice-synthesis-voice");
    expect(source).toContain("media-diagnostics");
  });

  it('keeps recognition language labels readable', () => {
    const source = read('settings/tabs/MediaTab.tsx');

    expect(source).toContain("{ value: 'zh-CN', label: '简体中文' }");
    expect(source).toContain("{ value: 'zh-TW', label: '繁体中文' }");
    expect(source).toContain("{ value: 'en-US', label: '英语（美国）' }");
    expect(source).toContain("{ value: 'ja-JP', label: '日语' }");
    expect(source).toContain("{ value: 'ko-KR', label: '韩语' }");
  });

  it('does not reinsert stale defaults that were not imported as actual media models', () => {
    const source = read('settings/tabs/MediaTab.tsx');

    expect(source).not.toContain('includeCurrentDefaultModel');
    expect(source).not.toContain('findDefaultModelOption');
    expect(source).toContain('const allImageModels = collectActualDefaultModels(providers,');
    expect(source).toContain('{models.map(m => (');
  });

  it('does not merge hard-coded media provider presets into the settings page', () => {
    const source = read('settings/tabs/MediaTab.tsx');

    expect(source).not.toContain('FALLBACK_MEDIA_PROVIDERS');
    expect(source).not.toContain('withMediaProviderFallback');
    expect(source).not.toContain('VOLCENGINE_IMAGE_MODELS');
    expect(source).not.toContain('OPENAI_IMAGE_MODELS');
  });
});
