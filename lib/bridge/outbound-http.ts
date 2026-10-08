import { fetch as undiciFetch } from "undici";
import { fetchDispatcherForUrl } from "../net/outbound-proxy.ts";

export const BRIDGE_HTTP_TIMEOUT_MS = 30_000;
export const BRIDGE_HTTP_MAX_RETRIES = 2;
export const BRIDGE_HTTP_RETRY_BASE_DELAY_MS = 500;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function hostForUrl(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function sanitizeProxyUrl(proxyUrl: string) {
  if (!proxyUrl) return "";
  try {
    const u = new URL(proxyUrl);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return proxyUrl.replace(/\/\/[^@/]+@/, "//");
  }
}

function causeCode(err: any) {
  return err?.cause?.code || err?.code || err?.name || "";
}

function isAbortError(err: any) {
  return err?.name === "AbortError" || String(err?.message || "").toLowerCase().includes("aborted");
}

export class BridgeHttpError extends Error {
  stage: string;
  host: string;
  attempts: number;
  proxied: boolean;
  proxyUrl: string;
  timedOut: boolean;
  cause: any;

  constructor(message: string, details: any = {}) {
    super(message);
    this.name = "BridgeHttpError";
    this.stage = details.stage || "";
    this.host = details.host || "";
    this.attempts = details.attempts || 1;
    this.proxied = details.proxied === true;
    this.proxyUrl = details.proxyUrl || "";
    this.timedOut = details.timedOut === true;
    this.cause = details.cause;
  }
}

function buildErrorMessage({ platform, stage, host, proxyUrl, attempts, timeoutMs, timedOut, err }: any) {
  const safeProxy = sanitizeProxyUrl(proxyUrl || "");
  const route = safeProxy ? ` via proxy ${safeProxy}` : " direct";
  const timeout = timedOut ? ` after ${timeoutMs}ms` : "";
  const code = causeCode(err);
  const reason = code ? `${code}: ${err?.message || err}` : String(err?.message || err || "request failed");
  return `[${platform}:${stage}] request to ${host}${route} failed${timeout} after ${attempts} attempt(s): ${reason}`;
}

export function createBridgeOutboundHttp({
  platform,
  fetchImpl = undiciFetch,
  resolveDispatcher = fetchDispatcherForUrl,
  sleep: sleepImpl = sleep,
}: {
  platform: string;
  fetchImpl?: any;
  resolveDispatcher?: (url: string) => { dispatcher: any; proxyUrl: string };
  sleep?: (ms: number) => Promise<void>;
}) {
  if (!platform) throw new Error("Bridge outbound HTTP requires platform");

  async function request(opts: any) {
    const stage = typeof opts?.stage === "string" ? opts.stage.trim() : "";
    if (!stage) throw new Error("Bridge outbound HTTP request requires stage");
    const url = String(opts.url || "");
    const host = hostForUrl(url);
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : BRIDGE_HTTP_TIMEOUT_MS;
    const maxRetries = Number.isInteger(opts.maxRetries) ? opts.maxRetries : BRIDGE_HTTP_MAX_RETRIES;
    const retries = opts.idempotent === true ? Math.max(0, maxRetries) : 0;
    let lastErr: any = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const { dispatcher, proxyUrl } = resolveDispatcher(url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const init: any = {
          ...opts,
          signal: controller.signal,
        };
        delete init.stage;
        delete init.url;
        delete init.timeoutMs;
        delete init.idempotent;
        delete init.maxRetries;
        if (dispatcher) init.dispatcher = dispatcher;

        const res = await fetchImpl(url, init);
        clearTimeout(timer);
        if (opts.idempotent === true && RETRYABLE_STATUS.has(Number(res?.status)) && attempt < retries) {
          await res?.body?.cancel?.().catch?.(() => {});
          await sleepImpl(BRIDGE_HTTP_RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        return res;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (attempt < retries) {
          await sleepImpl(BRIDGE_HTTP_RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        const safeProxy = sanitizeProxyUrl(proxyUrl || "");
        const timedOut = isAbortError(err);
        throw new BridgeHttpError(
          buildErrorMessage({
            platform,
            stage,
            host,
            proxyUrl,
            attempts: attempt + 1,
            timeoutMs,
            timedOut,
            err,
          }),
          {
            stage,
            host,
            attempts: attempt + 1,
            proxied: !!proxyUrl,
            proxyUrl: safeProxy,
            timedOut,
            cause: err,
          },
        );
      }
    }
    throw lastErr;
  }

  return { request };
}
