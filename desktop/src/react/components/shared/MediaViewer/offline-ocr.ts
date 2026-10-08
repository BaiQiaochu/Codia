import type { FileRef } from '../../../types/file-ref';
import { loadMediaSource } from './media-source';

type PaddleOcrInstance = {
  predict(input: unknown, params?: Record<string, unknown>): Promise<unknown[]>;
  dispose?: () => void | Promise<void>;
};

type PaddleOcrFactory = {
  create(options: Record<string, unknown>): Promise<PaddleOcrInstance>;
};

export interface OfflineOcrRuntimeDeps {
  PaddleOCR: PaddleOcrFactory;
  assetRoot: string | Promise<string>;
}

const DET_MODEL_NAME = 'PP-OCRv5_mobile_det';
const REC_MODEL_NAME = 'PP-OCRv5_mobile_rec';
export const OCR_RUNTIME_LOAD_TIMEOUT_MS = 60_000;
export const OCR_IMAGE_READ_TIMEOUT_MS = 30_000;
export const OCR_PREDICT_TIMEOUT_MS = 60_000;

let runtimePromise: Promise<PaddleOcrInstance> | null = null;

export function withOcrTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms. 请确认本地 OCR 资源已加载后重试。`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost'
    || host === '::1'
    || host === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function isLocalHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export function normalizeOcrAssetRoot(assetRoot: string): string {
  const root = String(assetRoot || '').trim();
  if (!root || !isLocalHttpUrl(root)) {
    throw new Error('Packaged local OCR assets require local HTTP OCR assets; file and remote OCR assets are disabled.');
  }
  return root.endsWith('/') ? root : `${root}/`;
}

function assertLocalOcrUrl(url: string): void {
  if (!url || !isLocalHttpUrl(url)) {
    throw new Error('Packaged local OCR assets require local HTTP OCR assets; file and remote OCR assets are disabled.');
  }
}

function localOcrFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  assertLocalOcrUrl(url);
  return fetch(input, init);
}

export async function getPackagedOcrAssetRoot(): Promise<string> {
  const platform = window.platform;
  if (typeof platform?.getOcrAssetRoot === 'function') {
    return normalizeOcrAssetRoot(await platform.getOcrAssetRoot());
  }
  if (typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)) {
    return normalizeOcrAssetRoot(`${window.location.origin}/ocr-runtime/`);
  }
  throw new Error('Packaged local OCR assets require local HTTP OCR assets; the local server is not ready.');
}

export async function createOfflineOcrRuntime(deps: OfflineOcrRuntimeDeps): Promise<PaddleOcrInstance> {
  const assetRoot = normalizeOcrAssetRoot(await deps.assetRoot);
  const detUrl = `${assetRoot}models/${DET_MODEL_NAME}.tar`;
  const recUrl = `${assetRoot}models/${REC_MODEL_NAME}.tar`;
  assertLocalOcrUrl(detUrl);
  assertLocalOcrUrl(recUrl);

  return deps.PaddleOCR.create({
    lang: 'ch',
    ocrVersion: 'PP-OCRv5',
    worker: false,
    fetch: localOcrFetch,
    textDetectionModelName: DET_MODEL_NAME,
    textRecognitionModelName: REC_MODEL_NAME,
    textDetectionModelAsset: { url: detUrl },
    textRecognitionModelAsset: { url: recUrl },
    ortOptions: {
      backend: 'wasm',
      wasmPaths: `${assetRoot}ort/`,
      numThreads: 1,
      simd: true,
      proxy: false,
    },
  });
}

async function getRuntime(): Promise<PaddleOcrInstance> {
  if (!runtimePromise) {
    runtimePromise = withOcrTimeout(import('@paddleocr/paddleocr-js')
      .then(({ PaddleOCR }) => createOfflineOcrRuntime({
        PaddleOCR,
        assetRoot: getPackagedOcrAssetRoot(),
      })), 'OCR runtime loading', OCR_RUNTIME_LOAD_TIMEOUT_MS)
      .catch((err) => {
        runtimePromise = null;
        throw err;
      });
  }
  return runtimePromise;
}

export function normalizeOcrText(result: unknown): string {
  const items = result && typeof result === 'object' && 'items' in result
    ? (result as { items?: unknown }).items
    : null;
  if (!Array.isArray(items)) return '';
  return items
    .map((item) => item && typeof item === 'object' && 'text' in item ? String((item as { text?: unknown }).text || '').trim() : '')
    .filter(Boolean)
    .join('\n');
}

async function fileRefToBlob(file: FileRef): Promise<Blob> {
  if (file.inlineData?.base64) {
    const binary = atob(file.inlineData.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: file.inlineData.mimeType || 'image/png' });
  }

  const source = await loadMediaSource(file);
  const response = await withOcrTimeout(fetch(source.url), 'OCR image loading', OCR_IMAGE_READ_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`Failed to read image for OCR: HTTP ${response.status}`);
  }
  return response.blob();
}

export async function recognizeImageWithOfflineOcr(file: FileRef): Promise<string> {
  if (file.kind !== 'image') {
    throw new Error('Offline OCR is only available for bitmap images.');
  }
  const [runtime, blob] = await Promise.all([
    getRuntime(),
    withOcrTimeout(fileRefToBlob(file), 'OCR image loading', OCR_IMAGE_READ_TIMEOUT_MS),
  ]);
  const [result] = await withOcrTimeout(runtime.predict(blob), 'OCR recognition', OCR_PREDICT_TIMEOUT_MS);
  return normalizeOcrText(result);
}
