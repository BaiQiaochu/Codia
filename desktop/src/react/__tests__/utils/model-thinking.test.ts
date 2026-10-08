import { describe, expect, it } from 'vitest';
import { modelSupportsXhigh, shouldShowThinkingControl } from '../../utils/model-thinking';

describe('model thinking controls', () => {
  it('shows thinking controls for Qwen-style controllable models even when default reasoning is off', () => {
    expect(shouldShowThinkingControl({
      id: 'qwen3.6-apex',
      provider: 'dashscope',
      reasoning: false,
      quirks: ['enable_thinking'],
    })).toBe(true);

    expect(shouldShowThinkingControl(
      { id: 'qwen3.6-apex', provider: 'dashscope', reasoning: false },
      [{
        id: 'qwen3.6-apex',
        provider: 'dashscope',
        reasoning: false,
        compat: { thinkingFormat: 'qwen' },
      }],
    )).toBe(true);
  });

  it('keeps reasoning=false hidden for models without a controllable thinking channel', () => {
    expect(shouldShowThinkingControl({
      id: 'plain-text-model',
      provider: 'local',
      reasoning: false,
    })).toBe(false);
  });

  it('infers extreme thinking support for GPT-5 series models even without a persisted xhigh flag', () => {
    expect(modelSupportsXhigh({ id: 'gpt-5', provider: 'openai', reasoning: true })).toBe(true);
    expect(modelSupportsXhigh({ id: 'gpt-5.1-codex', provider: 'openai', reasoning: true })).toBe(true);
    expect(modelSupportsXhigh({ id: 'gpt-5.5', provider: 'openai', reasoning: true })).toBe(true);
    expect(modelSupportsXhigh({ id: 'gpt-5.2-mini', provider: 'openai', reasoning: true })).toBe(true);
    expect(modelSupportsXhigh({ id: 'GPT5.5', provider: 'gppt', reasoning: true })).toBe(true);
    expect(modelSupportsXhigh({ id: 'gppt / gpt 5.5', provider: 'gppt', reasoning: true })).toBe(true);
  });

  it('infers extreme thinking support from GPT display names when provider ids are generic', () => {
    expect(modelSupportsXhigh({ id: 'chat-model-1', name: 'GPT-5.5', provider: 'gppt', reasoning: true })).toBe(true);
    expect(modelSupportsXhigh({ id: 'default', displayName: 'gppt / gpt 5.5', provider: 'relay', reasoning: true })).toBe(true);
  });

  it('uses the full model registry entry when the session model projection omits xhigh', () => {
    expect(modelSupportsXhigh(
      { id: 'max-model', provider: 'openai', reasoning: true },
      [{ id: 'max-model', provider: 'openai', reasoning: true, xhigh: true }],
    )).toBe(true);
  });
});
