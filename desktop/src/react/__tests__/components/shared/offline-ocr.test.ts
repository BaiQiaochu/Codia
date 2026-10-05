// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfflineOcrRuntime, getPackagedOcrAssetRoot, normalizeOcrText, withOcrTimeout } from '../../../components/shared/MediaViewer/offline-ocr';

describe('offline OCR runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates PP-OCRv5 with local HTTP wasm and model assets only', async () => {
    const create = vi.fn(async () => ({ predict: vi.fn(), dispose: vi.fn() }));

    await createOfflineOcrRuntime({
      PaddleOCR: { create },
      assetRoot: 'http://127.0.0.1:14500/ocr-runtime/',
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      textDetectionModelName: 'PP-OCRv5_mobile_det',
      textRecognitionModelName: 'PP-OCRv5_mobile_rec',
      textDetectionModelAsset: expect.objectContaining({
        url: 'http://127.0.0.1:14500/ocr-runtime/models/PP-OCRv5_mobile_det.tar',
      }),
      textRecognitionModelAsset: expect.objectContaining({
        url: 'http://127.0.0.1:14500/ocr-runtime/models/PP-OCRv5_mobile_rec.tar',
      }),
      ortOptions: expect.objectContaining({
        backend: 'wasm',
        wasmPaths: 'http://127.0.0.1:14500/ocr-runtime/ort/',
      }),
    }));
  });

  it('rejects file and remote OCR asset roots', async () => {
    await expect(createOfflineOcrRuntime({
      PaddleOCR: { create: vi.fn() },
      assetRoot: 'https://cdn.example.com/ocr/',
    })).rejects.toThrow(/local OCR assets/i);

    await expect(createOfflineOcrRuntime({
      PaddleOCR: { create: vi.fn() },
      assetRoot: 'file:///C:/Program Files/G-SAP/resources/ocr/',
    })).rejects.toThrow(/local HTTP OCR assets/i);
  });

  it('reads packaged OCR asset root from preload only', async () => {
    Object.assign(window, {
      platform: {
        getOcrAssetRoot: () => Promise.resolve('http://127.0.0.1:14500/ocr-runtime/'),
      },
    });

    await expect(getPackagedOcrAssetRoot()).resolves.toBe('http://127.0.0.1:14500/ocr-runtime/');
  });

  it('formats recognized lines as plain text', () => {
    expect(normalizeOcrText({
      items: [
        { text: '第一行', score: 0.98 },
        { text: 'Second line', score: 0.9 },
      ],
    })).toBe('第一行\nSecond line');
  });

  it('rejects stalled OCR operations instead of leaving the UI waiting forever', async () => {
    vi.useFakeTimers();
    const result = withOcrTimeout(new Promise<string>(() => undefined), 'OCR recognition', 5);
    const assertion = expect(result).rejects.toThrow(/OCR recognition timed out/i);

    await vi.advanceTimersByTimeAsync(5);

    await assertion;
  });
});
