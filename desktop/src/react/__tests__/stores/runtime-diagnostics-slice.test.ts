import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../stores';

describe('runtime diagnostics slice', () => {
  beforeEach(() => {
    useStore.setState({
      runtimeDiagnosticsById: {},
      runtimeDiagnosticIds: [],
      runtimeRecords: [],
      runtimeTimelineByTrace: {},
      runtimeTimelineTraceIdsBySession: {},
    });
  });

  it('records diagnostics, redacts secrets, and builds a copyable diagnostic package', () => {
    useStore.getState().upsertRuntimeTimelineEvent({
      id: 'trace-secret:failed',
      turnTraceId: 'trace-secret',
      sessionPath: 'E:/sessions/a.jsonl',
      type: 'failed',
      label: 'Failed',
      status: 'error',
      startedAt: '2026-05-21T00:00:00.000Z',
    });

    const diagnosticId = useStore.getState().recordRuntimeDiagnostic({
      traceId: 'trace-secret',
      sessionPath: 'E:/sessions/a.jsonl',
      severity: 'error',
      category: 'model',
      userMessage: 'Model call failed. Diagnostics were saved.',
      technicalMessage: 'provider rejected api key sk-secret-token at C:/Users/ghost/.codia/config.json',
      suggestion: 'Check provider credentials and retry.',
      model: { provider: 'openai', id: 'gpt-5.5' },
      sanitizedDetails: {
        authorization: 'Bearer sk-secret-token',
        filePath: 'C:/Users/ghost/.codia/config.json',
      },
    });

    const diagnostic = useStore.getState().runtimeDiagnosticsById[diagnosticId];
    expect(diagnostic.technicalMessage).not.toContain('sk-secret-token');
    expect(JSON.stringify(diagnostic.sanitizedDetails)).not.toContain('sk-secret-token');
    expect(JSON.stringify(diagnostic.sanitizedDetails)).toContain('config.json');

    const payload = useStore.getState().buildRuntimeDiagnosticExport(diagnosticId, {
      surface: 'desktop',
      platform: 'win32',
    });
    expect(payload).toMatchObject({
      schemaVersion: 1,
      app: 'Codia',
      diagnostic: expect.objectContaining({
        id: diagnosticId,
        traceId: 'trace-secret',
      }),
      environment: {
        surface: 'desktop',
        platform: 'win32',
      },
    });
    expect(JSON.stringify(payload)).not.toContain('sk-secret-token');
    expect(payload.timeline.map(event => event.type)).toEqual(['failed']);
  });

  it('keeps a bounded runtime record list for the diagnostics center', () => {
    for (let i = 0; i < 125; i += 1) {
      useStore.getState().recordRuntimeRecord({
        id: `record-${i}`,
        timestamp: `2026-05-21T00:00:${String(i).padStart(2, '0')}.000Z`,
        severity: i % 2 === 0 ? 'info' : 'error',
        category: 'tool',
        title: `Tool event ${i}`,
        detail: `detail ${i}`,
      });
    }

    const records = useStore.getState().runtimeRecords;
    expect(records).toHaveLength(100);
    expect(records[0].id).toBe('record-124');
    expect(records[records.length - 1].id).toBe('record-25');
  });
});
