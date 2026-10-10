type CspDirectives = Record<string, string[]>;
type SourceSet = Record<string, true>;

(function installConnectionCsp() {
  const STORAGE_KEYS = ["codia-server-connections-v1", "codia-server-connections-v1"];
  const BASE_CSP: CspDirectives = {
    "default-src": ["'self'"],
    "connect-src": ["'self'", "ws://127.0.0.1:*", "http://127.0.0.1:*"],
    "img-src": ["'self'", "data:", "blob:", "file:", "http://127.0.0.1:*"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "script-src": ["'self'", "'wasm-unsafe-eval'", "'unsafe-eval'"],
    "font-src": ["'self'", "data:"],
    "frame-src": ["blob:", "data:", "file:", "http://127.0.0.1:*", "http://localhost:*"],
  };

  function addOrigin(out: SourceSet, value: unknown): void {
    if (!value || typeof value !== "string") return;
    try {
      const url = new URL(value);
      if (!/^(http|https|ws|wss):$/.test(url.protocol)) return;
      out[`${url.protocol}//${url.host}`] = true;
    } catch {}
  }

  function readPersistedConnections(): Record<string, unknown> | null {
    for (const storageKey of STORAGE_KEYS) {
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) return JSON.parse(raw) as Record<string, unknown>;
      } catch {}
    }
    return null;
  }

  function readActiveConnectionSources(): SourceSet {
    const out: SourceSet = {};
    try {
      const parsed = readPersistedConnections();
      const id = parsed?.activeServerConnectionId;
      const connections = parsed?.serverConnections;
      const connection = typeof id === "string" && connections && typeof connections === "object"
        ? (connections as Record<string, Record<string, unknown>>)[id]
        : null;
      if (!connection || connection.kind === "local") return out;
      addOrigin(out, connection.baseUrl);
      addOrigin(out, connection.wsUrl);
      if (typeof connection.baseUrl === "string" && !connection.wsUrl) {
        const base = new URL(connection.baseUrl);
        addOrigin(out, `${base.protocol === "https:" ? "wss:" : "ws:"}//${base.host}`);
      }
    } catch {}
    return out;
  }

  function addDevSources(out: SourceSet): void {
    try {
      const host = window.location?.host;
      const hostname = window.location?.hostname;
      if (!host || !/^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(hostname)) return;
      out[`http://${host}`] = true;
      out[`ws://${host}`] = true;
      BASE_CSP["script-src"].push("'unsafe-inline'");
    } catch {}
  }

  const scopedSources = readActiveConnectionSources();
  addDevSources(scopedSources);
  const connectSources = BASE_CSP["connect-src"].concat(Object.keys(scopedSources));
  const directives: CspDirectives = { ...BASE_CSP, "connect-src": connectSources };
  const content = Object.keys(directives)
    .map((key) => `${key} ${directives[key].join(" ")}`)
    .join("; ");

  document.write(`<meta http-equiv="Content-Security-Policy" content="${content.replace(/"/g, "&quot;")}">`);
})();

export {};
