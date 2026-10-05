/* global URL */

function trimTrailingSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isMiniMaxHost(hostname) {
  const host = lower(hostname);
  return host === "api.minimaxi.com" || host === "api.minimax.io";
}

function hostnameOf(baseUrl) {
  try {
    return lower(new URL(String(baseUrl || "")).hostname);
  } catch {
    return lower(baseUrl);
  }
}

export function isMiniMaxProvider(provider, baseUrl = "") {
  const providerId = lower(provider);
  if (providerId === "minimax" || providerId === "minimax-token-plan") return true;
  return false;
}

export function isMiniMaxAnthropicProvider({ provider, api, baseUrl }: any = {}) {
  return api === "anthropic-messages" && isMiniMaxProvider(provider, baseUrl);
}

export function normalizeProviderBaseUrl({ provider, api, baseUrl }: any = {}) {
  const raw = trimTrailingSlash(baseUrl);
  if (!raw) return raw;

  if (api === "openai-completions" || api === "openai-responses" || api === "openai-codex-responses") {
    try {
      const parsed = new URL(raw);
      const pathname = trimTrailingSlash(parsed.pathname);
      if (!pathname || pathname === "/") {
        parsed.pathname = "/v1";
        parsed.search = "";
        parsed.hash = "";
        return trimTrailingSlash(parsed.toString());
      }
    } catch {
      // Leave non-standard URLs unchanged; provider-specific rules below may still handle them.
    }
  }

  if (lower(provider) === "ollama" && api === "openai-completions") {
    try {
      const parsed = new URL(raw);
      const pathname = trimTrailingSlash(parsed.pathname);
      parsed.pathname = /\/v1$/i.test(pathname) ? pathname : `${pathname || ""}/v1`;
      parsed.search = "";
      parsed.hash = "";
      return trimTrailingSlash(parsed.toString());
    } catch {
      return /\/v1$/i.test(raw) ? raw : `${raw}/v1`;
    }
  }

  if (!isMiniMaxAnthropicProvider({ provider, api, baseUrl: raw })) {
    return raw;
  }

  try {
    const url = new URL(raw);
    if (isMiniMaxHost(url.hostname)) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "anthropic") return raw;
      if (parts.length === 0 || (parts.length === 1 && /^v\d+$/i.test(parts[0]))) {
        url.pathname = "/anthropic";
        url.search = "";
        url.hash = "";
        return trimTrailingSlash(url.toString());
      }
    }
  } catch {
    // Fall through to string cleanup for non-standard but still recognizable URLs.
  }

  return raw
    .replace(/\/(anthropic)(?:\/v\d+)?(?:\/messages)?$/i, "/$1")
    .replace(/\/v\d+(?:\/messages)?$/i, "/anthropic");
}

export function shouldUseBearerAuth({ provider, api, baseUrl }: any = {}) {
  if (api !== "anthropic-messages") return false;
  const providerId = lower(provider);
  const host = hostnameOf(baseUrl);
  if (providerId === "kimi-coding" || host === "api.kimi.com" || host.endsWith(".kimi.com")) {
    return true;
  }
  return false;
}

export function buildAnthropicMessagesUrl(baseUrl) {
  const base = trimTrailingSlash(baseUrl);
  if (/\/v\d+\/messages$/i.test(base)) return base;
  if (/\/messages$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return `${base}/messages`;
  return `${base}/v1/messages`;
}

export function buildOpenAiModelsUrl(baseUrl) {
  const base = trimTrailingSlash(baseUrl);
  if (/\/models$/i.test(base)) return base;
  if (/\/v\d+\/(?:chat\/completions|completions|responses)$/i.test(base)) {
    return base.replace(/\/(?:chat\/completions|completions|responses)$/i, "/models");
  }
  return `${base}/models`;
}

export function buildAnthropicModelsUrl(baseUrl, opts = {}) {
  const raw = trimTrailingSlash(baseUrl);
  if (/\/v\d+\/models$/i.test(raw)) return `${raw}?limit=1000`;
  if (/\/v\d+$/i.test(raw)) return `${raw}/models?limit=1000`;
  return `${raw}/v1/models?limit=1000`;
}
