// @ts-nocheck
import {
  Agent as UndiciAgent,
  ProxyAgent as UndiciProxyAgent,
  Socks5ProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import { ProxyAgent as NodeProxyAgent } from "proxy-agent";
import {
  normalizeNetworkProxyConfig,
  proxyConfigFromEnvironment,
  resolveProxyForUrl,
} from "../../shared/network-proxy.ts";

const originalGlobalDispatcher = getGlobalDispatcher();
let currentConfig = normalizeNetworkProxyConfig();
let currentDispatcher = null;
let nodeProxyAgentCache = new Map();
let undiciProxyDispatcherCache = new Map();

function proxyProtocol(proxyUrl) {
  try {
    return new URL(proxyUrl).protocol;
  } catch {
    return "";
  }
}

function createUndiciProxyDispatcher(proxyUrl) {
  const protocol = proxyProtocol(proxyUrl);
  if (protocol === "http:" || protocol === "https:") {
    return new UndiciProxyAgent(proxyUrl);
  }
  if (protocol === "socks:" || protocol === "socks5:") {
    return new Socks5ProxyAgent(proxyUrl);
  }
  throw new Error(`unsupported proxy protocol: ${protocol || "(unknown)"}`);
}

function collectUnique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildEffectiveProxyConfig(config, env) {
  const normalized = normalizeNetworkProxyConfig(config);
  if (normalized.mode === "system") return proxyConfigFromEnvironment(env);
  return normalized;
}

function hasUsableProxy(config) {
  return !!(config.httpProxy || config.httpsProxy || config.wsProxy || config.wssProxy);
}

function createGlobalDispatcher(config, env = process.env) {
  const effective = buildEffectiveProxyConfig(config, env);
  if (effective.mode === "direct" || !hasUsableProxy(effective)) return null;

  const direct = new UndiciAgent();
  const proxyUrls = collectUnique([
    effective.httpProxy,
    effective.httpsProxy,
    effective.wsProxy,
    effective.wssProxy,
  ]);
  const proxyDispatchers = new Map(proxyUrls.map(url => [url, createUndiciProxyDispatcher(url)]));

  return {
    dispatch(opts, handler) {
      const origin = opts?.origin ? String(opts.origin) : "";
      const proxyUrl = origin ? resolveProxyForUrl(origin, effective, env) : "";
      const dispatcher = proxyUrl ? proxyDispatchers.get(proxyUrl) : null;
      return (dispatcher || direct).dispatch(opts, handler);
    },
    async close() {
      await Promise.allSettled([
        direct.close?.(),
        ...[...proxyDispatchers.values()].map(dispatcher => dispatcher.close?.()),
      ]);
    },
    destroy(err) {
      direct.destroy?.(err);
      for (const dispatcher of proxyDispatchers.values()) {
        dispatcher.destroy?.(err);
      }
    },
  };
}

function resetNodeProxyAgentCache() {
  for (const agent of nodeProxyAgentCache.values()) {
    agent.destroy?.();
  }
  nodeProxyAgentCache = new Map();
}

function resetUndiciProxyDispatcherCache() {
  for (const dispatcher of undiciProxyDispatcherCache.values()) {
    closeDispatcher(dispatcher);
  }
  undiciProxyDispatcherCache = new Map();
}

function closeDispatcher(dispatcher) {
  if (!dispatcher) return;
  try {
    dispatcher.close?.().catch?.(() => {});
  } catch {}
}

function describeProxyMode(config, env = process.env) {
  const effective = buildEffectiveProxyConfig(config, env);
  if (config.mode === "system") {
    return hasUsableProxy(effective) ? "system-env" : "system";
  }
  return config.mode;
}

export function createOutboundProxyRuntime({ log = () => {}, warn = () => {}, env = process.env } = {}) {
  return {
    apply(config) {
      const normalized = normalizeNetworkProxyConfig(config, { strict: true });
      const nextDispatcher = createGlobalDispatcher(normalized, env);
      closeDispatcher(currentDispatcher);
      resetNodeProxyAgentCache();
      resetUndiciProxyDispatcherCache();
      currentConfig = normalized;
      currentDispatcher = nextDispatcher;
      setGlobalDispatcher(nextDispatcher || originalGlobalDispatcher);
      const modeDesc = describeProxyMode(normalized, env);
      log(`[proxy] outbound mode=${modeDesc}`);
      if (modeDesc === "system-env") {
        const effective = buildEffectiveProxyConfig(normalized, env);
        const proxyAddr = effective.httpsProxy || effective.httpProxy || effective.wssProxy || effective.wsProxy || "";
        warn(
          `[proxy] outbound traffic is using system proxy ${proxyAddr}; `
          + `switch to direct mode in Settings > Network to bypass it.`
        );
      }
      return normalized;
    },
    getConfig() {
      return currentConfig;
    },
    reset() {
      closeDispatcher(currentDispatcher);
      resetNodeProxyAgentCache();
      resetUndiciProxyDispatcherCache();
      currentConfig = normalizeNetworkProxyConfig();
      currentDispatcher = null;
      setGlobalDispatcher(originalGlobalDispatcher);
    },
  };
}

export function getOutboundProxyConfig() {
  return currentConfig;
}

export function getNodeProxyAgentForUrl(targetUrl, env = process.env) {
  const proxyUrl = resolveProxyForUrl(targetUrl, currentConfig, env);
  if (!proxyUrl) return null;
  let agent = nodeProxyAgentCache.get(proxyUrl);
  if (!agent) {
    agent = new NodeProxyAgent(proxyUrl);
    nodeProxyAgentCache.set(proxyUrl, agent);
  }
  return agent;
}

export function fetchDispatcherForUrl(targetUrl, env = process.env) {
  const proxyUrl = resolveProxyForUrl(targetUrl, currentConfig, env);
  if (!proxyUrl) return { dispatcher: null, proxyUrl: "" };
  let dispatcher = undiciProxyDispatcherCache.get(proxyUrl);
  if (!dispatcher) {
    dispatcher = createUndiciProxyDispatcher(proxyUrl);
    undiciProxyDispatcherCache.set(proxyUrl, dispatcher);
  }
  return { dispatcher, proxyUrl };
}

export function webSocketOptionsForUrl(targetUrl) {
  const agent = getNodeProxyAgentForUrl(targetUrl);
  return agent ? { agent } : {};
}

export function telegramBotOptions(baseOptions = {}) {
  const agent = getNodeProxyAgentForUrl("https://api.telegram.org");
  if (!agent) return { ...baseOptions };
  return {
    ...baseOptions,
    request: {
      ...(baseOptions.request || {}),
      agent,
    },
  };
}
