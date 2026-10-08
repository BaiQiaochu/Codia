/**
 * net-utils.js — 网络相关的共享工具函数
 */

/**
 * 判断 URL 是否指向本机或私有网络地址。
 *
 * 本地/局域网模型服务（Ollama、SGLang、LM Studio 等）通常不需要 API key。
 * 这里故意只放行 loopback / RFC1918 / link-local，不把公网 HTTP 服务默认视为免鉴权。
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isLocalBaseUrl(url: unknown): boolean {
  const raw = String(url || "").trim();
  if (!raw) return false;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();

    if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
    if (host === "0.0.0.0") return true;
    if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;

    const parts = host.split(".").map((p) => Number(p));
    if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      const [a, b] = parts;
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true;
    }

    return false;
  } catch {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(raw);
  }
}

/**
 * 判断 provider 是否允许不填写 API key。
  *
 * @returns {boolean}
 */
export function allowsMissingApiKey(opts: { baseUrl?: string; authType?: string } | null | undefined = {}): boolean {
  return opts?.authType === "none" || opts?.authType === "optional" || isLocalBaseUrl(opts?.baseUrl);
}

/**
 * 规范化网页接入的公网基址。
 * 只允许 http/https，去掉 query/hash 和结尾多余斜杠。
 * @param {string} url
 * @returns {string}
 */
export function normalizePublicBaseUrl(url: unknown): string {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    parsed.search = "";
    parsed.hash = "";
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${pathname}`;
  } catch {
    return "";
  }
}

/**
 * 根据网页接入设置决定服务端监听地址。
 * 仅在显式开启外网访问时监听 0.0.0.0，其余情况仍保持本地回环。
  *
 * @returns {string}
 */
export function resolveWebAccessBindHost(webAccess: { external_enabled?: boolean } | null | undefined): string {
  return webAccess?.external_enabled ? "0.0.0.0" : "127.0.0.1";
}
