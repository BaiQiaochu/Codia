type DevWebClientConfig = {
  serverPort: string;
  apiBaseUrl: string;
};

type ApiFetchOptions = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

/**
 * platform.ts - platform adapter for the web fallback.
 * In Electron, preload injects window.gsap/window.platform already.
 * In the browser, we expose the same surface over HTTP.
 */
(function () {
  if (window.gsap || window.platform) {
    if (!window.platform) window.platform = window.gsap;
    return;
  }

  const params = new URLSearchParams(location.search);
  const devWeb = normalizeDevWebConfig(window.__GSAP_DEV_WEB__);
  const token = params.get("token") || localStorage.getItem("gsap-token") || "";
  const baseUrl = devWeb.apiBaseUrl || `${location.protocol}//${location.host}`;
  const serverPort = devWeb.serverPort || safePortFromBaseUrl(baseUrl) || location.port || "3000";

  function normalizeDevWebConfig(value: unknown): DevWebClientConfig {
    if (!value || typeof value !== "object") return { serverPort: "", apiBaseUrl: "" };
    const config = value as Partial<DevWebClientConfig>;
    return {
      serverPort: typeof config.serverPort === "string" && config.serverPort.trim() ? config.serverPort.trim() : "",
      apiBaseUrl: typeof config.apiBaseUrl === "string" && config.apiBaseUrl.trim() ? config.apiBaseUrl.trim().replace(/\/+$/, "") : "",
    };
  }

  function safePortFromBaseUrl(value: string): string {
    try {
      return new URL(value).port;
    } catch {
      return "";
    }
  }

  function apiFetch(path: string, opts: ApiFetchOptions = {}) {
    const headers = { ...opts.headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${baseUrl}${path}`, { ...opts, headers });
  }

  window.platform = {
    getServerPort: async () => serverPort,
    getServerToken: async () => token,
    getOcrAssetRoot: async () => `${baseUrl}/ocr-runtime/`,
    runConsoleCommand: async () => ({ ok: false, code: 1, output: "System console is only available in the desktop app." }),
    appReady: async () => {},
    syncWindowTheme: () => {},
    runEditCommand: async () => false,

    readFile: (p: string) => apiFetch(`/api/fs/read?path=${encodeURIComponent(p)}`).then((r) => (r.ok ? r.text() : null)),
    readFileSnapshot: (p: string) => apiFetch(`/api/fs/read-snapshot?path=${encodeURIComponent(p)}`).then((r) => (r.ok ? r.json() : null)),
    readFileBase64: (p: string) => apiFetch(`/api/fs/read-base64?path=${encodeURIComponent(p)}`).then((r) => (r.ok ? r.text() : null)),
    readDocxHtml: (p: string) => apiFetch(`/api/fs/docx-html?path=${encodeURIComponent(p)}`).then((r) => (r.ok ? r.text() : null)),
    readXlsxHtml: (p: string) => apiFetch(`/api/fs/xlsx-html?path=${encodeURIComponent(p)}`).then((r) => (r.ok ? r.text() : null)),
    readDesignDocumentPreview: (p: string) => apiFetch(`/api/fs/design-preview?path=${encodeURIComponent(p)}`).then((r) => (r.ok ? r.json() : null)),

    writeFile: async (p: string, content: string) => apiFetch("/api/fs/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p, content }),
    }).then((r) => r.ok).catch(() => false),
    writeFileIfUnchanged: async (p: string, content: string, expectedVersion?: string | null) => apiFetch("/api/fs/write-if-unchanged", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p, content, expectedVersion: expectedVersion || null }),
    }).then((r) => (r.ok ? r.json() : { ok: false })).catch(() => ({ ok: false })),
    writeFileBinary: async () => false,
    copyFile: async () => false,
    watchFile: async () => false,
    unwatchFile: async () => false,
    onFileChanged: () => {},
    watchWorkspace: async () => false,
    unwatchWorkspace: async () => false,
    onWorkspaceChanged: () => {},
    spawnViewer: async () => null,
    onViewerLoad: () => {},
    viewerClose: () => {},
    onViewerClosed: () => {},
    openEditorWindow: () => {},
    onEditorLoad: () => {},
    editorDock: async () => false,
    editorClose: async () => false,
    onEditorDockFile: () => {},
    onEditorDetached: () => {},

    getFilePath: () => null,
    getAvatarPath: () => null,
    getSplashInfo: async () => ({}),

    selectFolder: async () => null,
    selectFiles: async () => [],
    selectSkill: async () => null,
    selectPlugin: async () => null,

    openFolder: () => {},
    openFile: () => {},
    openExternal: (url: string) => { try { window.open(url, "_blank"); } catch { /* ignore popup blocker */ } },
    showInFinder: () => {},
    startDrag: () => {},

    openSettings: () => {},
    reloadMainWindow: () => location.reload(),

    settingsChanged: () => {},
    onSettingsChanged: () => {},
    onOpenSettingsModal: () => {},

    openBrowserViewer: () => {},
    closeBrowserViewer: () => {},
    onBrowserUpdate: () => {},
    browserGoBack: () => {},
    browserGoForward: () => {},
    browserReload: () => {},
    browserNavigateTo: (url: string) => { try { window.open(url, "_blank"); } catch { /* ignore popup blocker */ } },
    browserNewTab: () => {},
    browserSwitchTab: () => {},
    browserCloseTab: () => {},
    browserEmergencyStop: () => {},

    openSkillViewer: () => {},
    listSkillFiles: async () => [],
    readSkillFile: async () => null,
    onSkillViewerLoad: () => {},
    closeSkillViewer: () => {},

    onboardingComplete: async () => {},
    debugOpenOnboarding: async () => {},
    debugOpenOnboardingPreview: async () => {},

    getPlatform: async () => "web",
    windowMinimize: () => {},
    windowMaximize: () => {},
    windowClose: () => {},
    windowIsMaximized: async () => false,
    onMaximizeChange: () => {},
  } as typeof window.platform;
})();

(async function initPlatform() {
  const p = window.platform;
  if (!p?.getPlatform) return;
  const plat = await p.getPlatform();
  document.documentElement.setAttribute("data-platform", plat);
})();

export {};
