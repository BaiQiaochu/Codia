// @ts-nocheck
import { t } from "../i18n.ts";
import {
  buildAnthropicMessagesUrl,
  buildOpenAiModelsUrl,
  normalizeProviderBaseUrl,
  shouldUseBearerAuth,
} from "../../shared/provider-endpoints.ts";
import { normalizeProviderHeaders } from "../../shared/provider-auth.ts";

export const DEFAULT_PROVIDER_USER_AGENT = "G-SAP/1.0";

type ProviderRequestHeaderOptions = {
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  provider?: string;
  baseUrl?: string;
  anthropicAuthScheme?: string;
  allowMissingApiKey?: boolean;
};

function hasHeader(headers, name) {
  const target = String(name || "").toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === target);
}

export function withDefaultProviderHeaders(headers = {}) {
  if (hasHeader(headers, "User-Agent")) return headers;
  return {
    ...headers,
    "User-Agent": DEFAULT_PROVIDER_USER_AGENT,
  };
}

export function buildProviderAuthHeaders(api, apiKey, opts = {}) {
  const allowMissingApiKey = opts.allowMissingApiKey === true;
  if (!api) {
    throw new Error(t("error.missingApiProtocol"));
  }
  if (!apiKey && !allowMissingApiKey) {
    throw new Error(t("error.missingApiKey"));
  }

  if (api === "anthropic-messages") {
    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (apiKey) {
      if (opts.anthropicAuthScheme === "bearer" || shouldUseBearerAuth({ provider: opts.provider, api, baseUrl: opts.baseUrl })) {
        headers.Authorization = `Bearer ${apiKey}`;
      } else {
        headers["x-api-key"] = apiKey;
      }
    }
    return headers;
  }

  if (api === "openai-completions" || api === "openai-codex-responses" || api === "openai-responses") {
    const headers = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  }

  if (api === "google-generative-ai") {
    const headers = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers["x-goog-api-key"] = apiKey;
    return headers;
  }

  throw new Error(t("error.unsupportedApiProtocol", { api }));
}

export function buildProviderRequestHeaders({
  api,
  apiKey,
  headers,
  provider,
  baseUrl,
  anthropicAuthScheme,
  allowMissingApiKey = false,
}: ProviderRequestHeaderOptions = {}): Record<string, string> {
  const customHeaders = normalizeProviderHeaders(headers);
  const requestHeaders = api
    ? buildProviderAuthHeaders(api, apiKey, {
        provider,
        baseUrl,
        anthropicAuthScheme,
        allowMissingApiKey: allowMissingApiKey || Object.keys(customHeaders).length > 0,
      })
    : { "Content-Type": "application/json" };
  return withDefaultProviderHeaders({ ...requestHeaders, ...customHeaders });
}

export function buildProbeUrl(baseUrl, api, opts = {}) {
  const normalizedBaseUrl = normalizeProviderBaseUrl({ provider: opts.provider, api, baseUrl });
  const base = String(normalizedBaseUrl || "").replace(/\/+$/, "");
  if (api === "anthropic-messages") {
    return { url: buildAnthropicMessagesUrl(base), method: "POST" };
  }
  return { url: buildOpenAiModelsUrl(base), method: "GET" };
}

export async function probeProvider({ baseUrl, api, apiKey, modelId, provider, headers: customHeaders }) {
  if (api === "openai-codex-responses") {
    return { ok: true, status: 0, skipped: t("error.codexNoHealthCheck") };
  }

  const probe = buildProbeUrl(baseUrl, api, { provider });
  if (api === "anthropic-messages") {
    const doProbe = (anthropicAuthScheme) => fetch(probe.url, {
      method: probe.method,
      headers: buildProviderRequestHeaders({
        api,
        apiKey,
        headers: customHeaders,
        provider,
        baseUrl: probe.url,
        allowMissingApiKey: true,
        anthropicAuthScheme,
      }),
      body: JSON.stringify({
        model: modelId || "test",
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    let res = await doProbe(undefined);
    if (apiKey && (res.status === 401 || res.status === 403)) {
      res = await doProbe("bearer");
    }
    const authOk = res.status !== 401 && res.status !== 403;
    return { ok: authOk, status: res.status };
  }

  const headers = buildProviderRequestHeaders({
    api,
    apiKey,
    headers: customHeaders,
    provider,
    baseUrl: probe.url,
    allowMissingApiKey: true,
  });
  const res = await fetch(probe.url, { headers, signal: AbortSignal.timeout(10000) });
  const authOk = res.status !== 401 && res.status !== 403;
  return { ok: authOk, status: res.status };
}
