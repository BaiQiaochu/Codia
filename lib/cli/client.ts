// @ts-nocheck
import WebSocket from "ws";
import { DEFAULT_HOST } from "./args.ts";
import { CliError } from "./errors.ts";
import { parseOptionalJson } from "./json.ts";
import { normalizeApiPath } from "./runtime-paths.ts";

export { parseOptionalJson } from "./json.ts";

export class GsapClient {
  constructor(info, opts) {
    this.info = info;
    this.token = info.token;
    this.baseUrl = info.baseUrl || `http://${opts.host || DEFAULT_HOST}:${info.port}`;
  }

  async request(method, apiPath, { body = undefined, headers = {}, text = false } = {}) {
    const url = /^https?:\/\//i.test(apiPath) ? apiPath : `${this.baseUrl}${normalizeApiPath(apiPath)}`;
    const finalHeaders = { Authorization: `Bearer ${this.token}`, ...headers };
    let finalBody = body;
    if (body !== undefined && body !== null && typeof body !== "string" && !Buffer.isBuffer(body)) {
      finalHeaders["Content-Type"] = finalHeaders["Content-Type"] || "application/json";
      finalBody = JSON.stringify(body);
    }
    const res = await fetch(url, { method, headers: finalHeaders, body: finalBody });
    const raw = await res.text();
    if (text) {
      if (!res.ok) throw new CliError(raw || `HTTP ${res.status}`, { code: 4 });
      return raw;
    }
    const parsed = parseOptionalJson(raw);
    if (!res.ok) {
      const message = parsed?.error || parsed?.message || raw || `HTTP ${res.status}`;
      throw new CliError(message, { code: 4, details: parsed || raw });
    }
    return parsed ?? raw;
  }

  get(apiPath, options) { return this.request("GET", apiPath, options); }
  post(apiPath, body, options = {}) { return this.request("POST", apiPath, { ...options, body }); }
  put(apiPath, body, options = {}) { return this.request("PUT", apiPath, { ...options, body }); }
  delete(apiPath, options) { return this.request("DELETE", apiPath, options); }

  wsUrl() {
    const url = new URL("/ws", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", this.token);
    return url.toString();
  }
}

export function wsConnect(client) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(client.wsUrl());
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new CliError("WebSocket 连接超时", { code: 6 }));
    }, 10_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(new CliError(`WebSocket 连接失败: ${error.message}`, { code: 6 }));
    });
  });
}
