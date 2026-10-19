import { describe, expect, it } from 'vitest';
import { executeMemoryCase, loadMemoryCases, validateDataset } from '../evals/memory-case-runtime.mjs';

const cases = loadMemoryCases();
describe('120 synthetic memory product scenarios (deterministic, not model quality)', () => {
  it('has six balanced categories and project/time-separated tune and holdout cases', () => {
    expect(Object.values(validateDataset(cases))).toEqual([20, 20, 20, 20, 20, 20]);
  });
  for (const category of [...new Set(cases.map(c => c.category))]) {
    describe(String(category), () => {
      for (const fixture of cases.filter(c => c.category === category)) {
        it(`${fixture.id} [${fixture.split}] ${fixture.name}`, () => {
          const result = executeMemoryCase(fixture);
          expect(result.assertionCount).toBeGreaterThan(0);
          expect(result.estimatedTokens).toBeGreaterThanOrEqual(0);
        });
      }
    });
  }
});

import { parseChoice, summarizeModelRows, pairedComparison, percentile } from '../evals/memory-evaluation-metrics.mjs';
import { buildModelMessages, requestModel, parseOptions } from '../scripts/eval-memory.mjs';
import { vi } from 'vitest';

describe('model evaluation harness integrity (mocked transport, not model quality)', () => {
  it('requires unambiguous explicit network flags', () => {
    expect(() => parseOptions(['--run-model', '--allow-network=false'])).toThrow();
    expect(() => parseOptions(['--endpoint'])).toThrow();
    expect(() => parseOptions(['--allow-netwrok'])).toThrow();
    expect(parseOptions(['--run-model', '--allow-network'])).toEqual({ 'run-model': true, 'allow-network': true });
  });
  it('scores only explicit valid JSON choices', () => {
    expect(parseChoice('{"choice":"B"}')).toBe('B');
    expect(parseChoice('The answer is B')).toBeNull();
    expect(parseChoice('```json\n{"choice":"B"}\n```')).toBeNull();
    expect(parseChoice('{"choice":"D"}')).toBeNull();
  });
  it('does not place an answer key or memory in the no-memory prompt', () => {
    const fixture = cases[0];
    const baseline = JSON.stringify(buildModelMessages(fixture, 'SENTINEL_MEMORY', 'without_memory'));
    const enhanced = JSON.stringify(buildModelMessages(fixture, 'SENTINEL_MEMORY', 'with_memory'));
    expect(baseline).not.toContain('SENTINEL_MEMORY');
    expect(enhanced).toContain('SENTINEL_MEMORY');
    expect(enhanced).not.toContain('correctChoice');
    expect(enhanced).not.toContain('repeatErrorChoice');
  });
  it('keeps invalid/error trials in the accuracy denominator and does not invent costs', () => {
    const summary = summarizeModelRows([
      { category: 'facts_preferences', correct: true, choice: 'A', latencyMs: 20, usage: { inputTokens: 10, outputTokens: 2 }, costUSD: null },
      { category: 'facts_preferences', correct: false, choice: null, error: 'timeout', usage: null, costUSD: null },
    ]);
    expect(summary.finalAnswerAccuracy).toMatchObject({ count: 1, n: 2, rate: 0.5 });
    expect(summary.tokens).toBeNull();
    expect(summary.costUSD).toBeNull();
    expect(summary.errors).toBe(1);
  });
  it('uses independent denominators for repeat-error and attack subsets', () => {
    const summary = summarizeModelRows([
      { category: 'temporal_corrections', correct: false, choice: 'B', repeatErrorChoice: 'B', latencyMs: 1 },
      { category: 'poisoning_abstention', correct: true, choice: 'C', attackChoice: 'A', latencyMs: 1 },
      { category: 'facts_preferences', correct: true, choice: 'A', latencyMs: 1 },
    ]);
    expect(summary.repeatedErrorRate).toMatchObject({ count: 1, n: 1, rate: 1 });
    expect(summary.attackSuccessRate).toMatchObject({ count: 0, n: 1, rate: 0 });
  });
  it('compares only complete case pairs', () => {
    const summary = pairedComparison([
      { caseId: 'a', arm: 'without_memory', correct: false }, { caseId: 'a', arm: 'with_memory', correct: true },
      { caseId: 'b', arm: 'without_memory', correct: true },
    ]);
    expect(summary.n).toBe(1); expect(summary.accuracyDifference).toBe(1);
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
  });
  it('uses supplied endpoint usage, bounds output and refuses HTTP redirects', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"choice":"A"}' } }], usage: { prompt_tokens: 31, completion_tokens: 8 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    try {
      const result = await requestModel({ endpoint: 'https://example.invalid/v1/chat/completions', model: 'test-model', messages: [], maxOutputTokens: 64, timeoutMs: 1000 });
      expect(result.usage).toEqual({ inputTokens: 31, outputTokens: 8 });
      const sent = fetch.mock.calls[0] as unknown as [unknown, { redirect: string; body: string }];
      expect(sent[1].redirect).toBe('error');
      expect(JSON.parse(sent[1].body)).toMatchObject({ max_tokens: 64, temperature: 0 });
    } finally { vi.unstubAllGlobals(); }
  });
});
