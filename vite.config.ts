import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import { build as esbuildBuild } from 'esbuild';

const projectRoot = fs.realpathSync(path.resolve(__dirname));
const rendererRoot = fs.realpathSync(path.resolve(__dirname, 'desktop/src'));
const packageVersion = (() => {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof packageJson.version === 'string' && packageJson.version.trim()
      ? packageJson.version.trim()
      : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

interface DevWebClientConfig {
  serverPort: string;
  apiBaseUrl: string;
}

type RuntimeScriptFormat = 'esm' | 'iife';

interface RuntimeScriptBuild {
  source: string;
  dest: string;
  format: RuntimeScriptFormat;
}

const RUNTIME_SCRIPT_BUILDS: RuntimeScriptBuild[] = [
  { source: 'lib/i18n.ts', dest: 'lib/i18n.js', format: 'esm' },
  { source: 'lib/theme.ts', dest: 'lib/theme.js', format: 'esm' },
  { source: 'modules/platform.ts', dest: 'modules/platform.js', format: 'esm' },
  { source: 'modules/connection-csp.ts', dest: 'modules/connection-csp.js', format: 'iife' },
  { source: 'mobile-sw.ts', dest: 'sw.js', format: 'iife' },
];

const RUNTIME_MODULE_ALIASES = new Map(
  RUNTIME_SCRIPT_BUILDS
    .filter((entry) => entry.dest !== 'sw.js' && entry.dest !== 'modules/connection-csp.js')
    .map((entry) => [entry.dest, entry.source]),
);

function normalizeRuntimeRequest(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\//, '')
    .replace(/^\.\//, '');
}

async function buildRuntimeScriptContent(srcDir: string, entry: RuntimeScriptBuild): Promise<string> {
  const result = await esbuildBuild({
    entryPoints: [path.join(srcDir, entry.source)],
    bundle: true,
    write: false,
    format: entry.format,
    platform: 'browser',
    target: 'es2022',
    minify: false,
    sourcemap: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0]?.text || '';
}

/**
 * Centralized Content Security Policy profiles.
 * Vite injects these profiles during dev/build while the source HTML keeps a
 * conservative fallback for loadFile.
 */
const CSP_PROFILES: Record<string, string> = {
  'index.html':
    "default-src 'self'; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; img-src 'self' data: blob: file: http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; font-src 'self' data:; frame-src blob: data: file: http://127.0.0.1:* http://localhost:*",
  'settings.html':
    "default-src 'self'; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; img-src 'self' data: file: http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:",
  'quick-chat.html':
    "default-src 'self'; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; img-src 'self' data: blob: file: http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:",
  'onboarding.html':
    "default-src 'self'; connect-src 'self' http: https: ws: wss:; img-src 'self' data: file: http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:",
  // Mobile PWA: hosted from the backend itself, so API and WebSocket calls stay same-origin.
  'mobile.html':
    "default-src 'self'; connect-src 'self' ws: wss: ws://127.0.0.1:* http://127.0.0.1:*; img-src 'self' data: blob: file: http://127.0.0.1:*; media-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; frame-src 'self' blob: data:",
  'splash.html':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' file:; font-src 'self' data:",
  'browser-viewer.html':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' file:",
  'viewer-window.html':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: file:",
  'editor-window.html':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'",
};

function injectCsp(): Plugin {
  return {
    name: 'codia-inject-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const filename = path.basename(ctx.filename);
        const profile = CSP_PROFILES[filename];
        if (!profile) return html;

        let csp = profile;
        // Dev 妯″紡鏀惧锛歊eact Refresh 闇€瑕?unsafe-inline锛孷ite HMR 闇€瑕?ws
        if (process.env.NODE_ENV !== 'production') {
          if (!/script-src[^;]*'unsafe-inline'/.test(csp)) {
            csp = csp.replace(
              /script-src 'self'/,
              "script-src 'self' 'unsafe-inline'",
            );
          }
          if (csp.includes('connect-src')) {
            csp = csp.replace(
              /connect-src 'self'/,
              "connect-src 'self' ws://localhost:5173",
            );
          }
        }

        return html.replace(
          /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*\/?>/,
          `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
        );
      },
    },
  };
}

/**
 * 淇濈暀鏃?CSS link 鏍囩锛? * Vite 榛樿浼氭妸 <link rel="stylesheet" href="..."> 鎵撳寘杩?bundle銆? * 娓愯繘杩佺Щ鏈熼棿锛宻tyles.css 鍜?themes/*.css 蹇呴』淇濇寔涓虹嫭绔嬫枃浠? * 锛坱heme.js 杩愯鏃跺姩鎬佸垏鎹?themeSheet 鐨?href锛夈€? *
 * 鍋氭硶锛氬湪 HTML 澶勭悊鍓嶆妸鏃?CSS link 鏇挎崲鎴愬崰浣嶇锛宐uild 鍚庡啀杩樺師銆? */
function preserveLegacyCss(): Plugin {
  return {
    name: 'codia-preserve-legacy-css',
    enforce: 'pre',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(
          /<link\s+rel="stylesheet"\s+href="([^"]+)"([^>]*)>/g,
          (_match, href, rest) => `<!--CODIA_CSS:${href}${rest}-->`
        );
      },
    },
  };
}

function restoreLegacyCss(): Plugin {
  return {
    name: 'codia-restore-legacy-css',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        // 鎶婂崰浣嶇杩樺師涓?<link> 鏍囩
        return html.replace(
          /<!--CODIA_CSS:(.*?)-->/g,
          (_match, content) => {
            // content 鏄?"styles.css" 鎴?"themes/warm-paper.css" id="themeSheet"
            const parts = content.split(/\s+/);
            const href = parts[0];
            const rest = parts.slice(1).join(' ');
            return `<link rel="stylesheet" href="${href}"${rest ? ' ' + rest : ''}>`;
          }
        );
      },
    },
  };
}

/**
 * Build 鍚庡鍒舵棫鏂囦欢鍒?dist-renderer/锛? * 鏃?JS 妯″潡銆丆SS銆佷富棰樸€佽祫婧愩€佽瑷€鍖呯瓑锛? * 鍦ㄦ笎杩涜縼绉诲畬鎴愬墠杩橀渶瑕佷粠 dist-renderer/ 鍔犺浇銆? */
function preserveClassicScripts(): Plugin {
  const classicScripts = new Set(['modules/connection-csp.js']);
  return {
    name: 'codia-preserve-classic-scripts',
    enforce: 'pre',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(
          /<script\s+src="([^"]+)"\s*><\/script>/g,
          (match, src) => classicScripts.has(src) ? `<!--CODIA_SCRIPT:${src}-->` : match,
        );
      },
    },
  };
}

function restoreClassicScripts(): Plugin {
  return {
    name: 'codia-restore-classic-scripts',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html.replace(
          /<!--CODIA_SCRIPT:(.*?)-->/g,
          (_match, src) => `<script src="${src}"></script>`,
        );
      },
    },
  };
}

function resolveRuntimeTsScripts(): Plugin {
  return {
    name: 'codia-resolve-runtime-ts-scripts',
    enforce: 'pre',
    resolveId(source) {
      const mapped = RUNTIME_MODULE_ALIASES.get(normalizeRuntimeRequest(source));
      return mapped ? path.join(rendererRoot, mapped) : null;
    },
  };
}

function serveCompiledRuntimeScripts(): Plugin {
  const srcDir = path.resolve(__dirname, 'desktop/src');
  const entries = new Map(RUNTIME_SCRIPT_BUILDS.map((entry) => [entry.dest, entry]));
  return {
    name: 'codia-serve-compiled-runtime-scripts',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = decodeURIComponent(req.url?.split('?')[0] || '');
        const entry = entries.get(normalizeRuntimeRequest(pathname));
        if (!entry) {
          next();
          return;
        }
        try {
          const js = await buildRuntimeScriptContent(srcDir, entry);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(js);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

function copyLegacyFiles(): Plugin {
  return {
    name: 'codia-copy-legacy-files',
    async closeBundle() {
      const srcDir = path.resolve(__dirname, 'desktop/src');
      const outDir = path.resolve(__dirname, 'desktop/dist-renderer');

      const dirs = ['themes', 'assets', 'locales'];
      const files = [
        { src: 'styles.css', dest: 'styles.css' },
        { src: 'mobile-manifest.webmanifest', dest: 'manifest.webmanifest' },
        { src: 'icon.png', dest: 'icon.png' },
      ];

      for (const dir of dirs) {
        const src = path.join(srcDir, dir);
        const dest = path.join(outDir, dir);
        if (fs.existsSync(src)) {
          fs.cpSync(src, dest, { recursive: true });
        }
      }

      for (const file of files) {
        const src = path.join(srcDir, file.src);
        const dest = path.join(outDir, file.dest);
        if (fs.existsSync(src)) {
          fs.cpSync(src, dest);
        }
      }

      for (const entry of RUNTIME_SCRIPT_BUILDS) {
        const js = await buildRuntimeScriptContent(srcDir, entry);
        const dest = path.join(outDir, entry.dest);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, js, 'utf-8');
      }
    },
  };
}

function rendererManualChunks(id: string): string | undefined {
  const normalized = id.replace(/\\/g, '/');

  if (normalized.includes('/node_modules/')) {
    if (
      normalized.includes('/@codemirror/lang-javascript/') ||
      normalized.includes('/@lezer/javascript/')
    ) {
      return 'codemirror-lang-javascript';
    }
    if (
      normalized.includes('/@codemirror/lang-html/') ||
      normalized.includes('/@lezer/html/')
    ) {
      return 'codemirror-lang-html';
    }
    if (
      normalized.includes('/@codemirror/lang-css/') ||
      normalized.includes('/@lezer/css/')
    ) {
      return 'codemirror-lang-css';
    }
    if (
      normalized.includes('/@codemirror/lang-json/') ||
      normalized.includes('/@lezer/json/')
    ) {
      return 'codemirror-lang-json';
    }
    if (
      normalized.includes('/@codemirror/lang-python/') ||
      normalized.includes('/@lezer/python/')
    ) {
      return 'codemirror-lang-python';
    }
    if (normalized.includes('/@codemirror/lang-sql/')) {
      return 'codemirror-lang-sql';
    }
    if (
      normalized.includes('/@codemirror/lang-yaml/') ||
      normalized.includes('/@lezer/yaml/')
    ) {
      return 'codemirror-lang-yaml';
    }
    if (
      normalized.includes('/@codemirror/lang-xml/') ||
      normalized.includes('/@lezer/xml/')
    ) {
      return 'codemirror-lang-xml';
    }
    if (
      normalized.includes('/@codemirror/autocomplete/') ||
      normalized.includes('/@codemirror/lint/') ||
      normalized.includes('/@codemirror/search/')
    ) {
      return 'codemirror-language-support';
    }
    if (
      normalized.includes('/@codemirror/view/') ||
      normalized.includes('/@codemirror/state/') ||
      normalized.includes('/@codemirror/commands/')
    ) {
      return 'codemirror-foundation';
    }
    if (normalized.includes('/@codemirror/language/')) {
      return 'codemirror-language';
    }
    if (
      normalized.includes('/@codemirror/lang-markdown/') ||
      normalized.includes('/@lezer/markdown/')
    ) {
      return 'codemirror-markdown';
    }
    if (normalized.includes('/@codemirror/') || normalized.includes('/codemirror/')) {
      return 'codemirror-core';
    }
    if (normalized.includes('/@mermaid-js/parser/')) {
      return 'mermaid-parser-vendor';
    }
    if (normalized.includes('/@tiptap/') || normalized.includes('/prosemirror-')) {
      return 'tiptap-vendor';
    }
    if (normalized.includes('/katex')) {
      return 'katex-vendor';
    }
    if (
      normalized.includes('/markdown-it') ||
      normalized.includes('/@traptitech/markdown-it-katex')
    ) {
      return 'markdown-it-vendor';
    }
  }

  if (
    normalized.includes('/desktop/src/react/components/ArtifactEditor.tsx')
  ) {
    return 'editor-shell';
  }

  if (
    normalized.endsWith('/desktop/src/react/utils/markdown-cover.ts') ||
    normalized.endsWith('/desktop/src/react/utils/markdown-cover-drop.ts') ||
    normalized.endsWith('/desktop/src/react/utils/markdown-attachments.ts') ||
    normalized.endsWith('/desktop/src/react/utils/app-file-drag.ts') ||
    normalized.endsWith('/desktop/src/react/utils/checkpoints.ts')
  ) {
    return 'editor-markdown-support';
  }

  if (normalized.includes('/desktop/src/react/editor/')) {
    return undefined;
  }

  if (normalized.includes('/desktop/src/react/settings/')) {
    if (normalized.includes('/desktop/src/react/settings/tabs/')) {
      if (
        normalized.includes('/desktop/src/react/settings/tabs/providers/') ||
        normalized.includes('/desktop/src/react/settings/tabs/ProvidersTab.tsx')
      ) {
        return 'settings-providers';
      }
      if (
        normalized.includes('/desktop/src/react/settings/tabs/media/') ||
        normalized.includes('/desktop/src/react/settings/tabs/MediaTab.tsx')
      ) {
        return 'settings-media';
      }
      if (
        normalized.includes('/desktop/src/react/settings/tabs/skills/') ||
        normalized.includes('/desktop/src/react/settings/tabs/SkillsTab.tsx')
      ) {
        return 'settings-skills';
      }
      if (
        normalized.includes('/desktop/src/react/settings/tabs/PluginsTab.tsx') ||
        normalized.includes('/desktop/src/react/settings/tabs/PluginMarketplaceTab.tsx')
      ) {
        return 'settings-plugins';
      }
      if (normalized.includes('/desktop/src/react/settings/tabs/DiagnosticsTab.tsx')) {
        return 'settings-diagnostics';
      }
      if (
        normalized.includes('/desktop/src/react/settings/tabs/bridge/') ||
        normalized.includes('/desktop/src/react/settings/tabs/BridgeTab.tsx')
      ) {
        return 'settings-bridge';
      }
      return 'settings-tabs';
    }
    if (normalized.includes('/desktop/src/react/settings/overlays/')) {
      return 'settings-overlays';
    }
    return 'settings-core';
  }

  return undefined;
}

function readDevWebClientConfig(): DevWebClientConfig | null {
  if (process.env.CODIA_DEV_WEB !== '1') return null;
  const apiBaseUrl = process.env.CODIA_DEV_WEB_API_BASE_URL?.trim();
  if (!apiBaseUrl) throw new Error('CODIA_DEV_WEB requires CODIA_DEV_WEB_API_BASE_URL');
  const parsed = new URL(apiBaseUrl);
  const serverPort = process.env.CODIA_DEV_WEB_CLIENT_PORT?.trim() || parsed.port;
  if (!serverPort) {
    throw new Error('CODIA_DEV_WEB requires CODIA_DEV_WEB_CLIENT_PORT or a port in CODIA_DEV_WEB_API_BASE_URL');
  }
  return { serverPort, apiBaseUrl };
}

function injectDevWebConfig(): Plugin {
  return {
    name: 'codia-inject-dev-web-config',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (path.basename(ctx.filename) !== 'index.html') return html;
        const config = readDevWebClientConfig();
        if (!config) return html;
        const payload = JSON.stringify(config).replace(/</g, '\\u003c');
        return html.replace('</head>', `<script>window.__CODIA_DEV_WEB__=${payload};</script>\n</head>`);
      },
    },
  };
}

function createDevWebProxy(): Record<string, ProxyOptions> | undefined {
  if (process.env.CODIA_DEV_WEB !== '1') return undefined;
  const target = process.env.CODIA_DEV_WEB_SERVER_URL?.trim();
  const token = process.env.CODIA_DEV_WEB_SERVER_TOKEN?.trim();
  if (!target || !token) {
    throw new Error('CODIA_DEV_WEB proxy requires CODIA_DEV_WEB_SERVER_URL and CODIA_DEV_WEB_SERVER_TOKEN');
  }
  const auth = `Bearer ${token}`;
  const targetUrl = new URL(target);
  const wsTarget = `${targetUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${targetUrl.host}`;
  const withAuth = (proxyTarget: string, extra: ProxyOptions = {}): ProxyOptions => ({
    target: proxyTarget,
    changeOrigin: true,
    ...extra,
    headers: {
      ...(extra.headers || {}),
      Authorization: auth,
    },
    configure(proxy, options) {
      proxy.on('proxyReq', (proxyReq) => {
        proxyReq.setHeader('Authorization', auth);
      });
      proxy.on('proxyReqWs', (proxyReq) => {
        proxyReq.setHeader('Authorization', auth);
      });
      extra.configure?.(proxy, options);
    },
  });
  return {
    '/api': withAuth(target),
    '/preview': withAuth(target),
    '/plugins': withAuth(target),
    '/ws': withAuth(wsTarget, { ws: true }),
  };
}

function serveMobilePwaStaticFiles(): Plugin {
  const srcDir = path.resolve(__dirname, 'desktop/src');
  const filesByUrl = new Map<string, { file: string; contentType: string }>([
    ['/manifest.webmanifest', { file: path.join(srcDir, 'mobile-manifest.webmanifest'), contentType: 'application/manifest+json; charset=utf-8' }],
    ['/icon.png', { file: path.join(srcDir, 'icon.png'), contentType: 'image/png' }],
  ]);

  return {
    name: 'codia-serve-mobile-pwa-static-files',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split('?')[0] || '';
        const asset = filesByUrl.get(pathname);
        if (!asset) {
          next();
          return;
        }
        fs.readFile(asset.file, (err, data) => {
          if (err) {
            next(err);
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', asset.contentType);
          res.setHeader('Cache-Control', 'no-cache');
          res.end(data);
        });
      });
    },
  };
}

export default defineConfig({
  define: {
    __CODIA_PRODUCT_VARIANT__: JSON.stringify(process.env.CODIA_PRODUCT_VARIANT || 'codia-professional'),
    __CODIA_APP_VERSION__: JSON.stringify(packageVersion),
  },
  root: rendererRoot,
  base: './',
  plugins: [
    preserveLegacyCss(),
    preserveClassicScripts(),
    resolveRuntimeTsScripts(),
    react(),
    injectCsp(),
    injectDevWebConfig(),
    serveCompiledRuntimeScripts(),
    serveMobilePwaStaticFiles(),
    restoreLegacyCss(),
    restoreClassicScripts(),
    copyLegacyFiles(),
  ],
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, 'desktop/src/react') },
      { find: '@codia/plugin-components', replacement: path.resolve(__dirname, 'packages/plugin-components/src/index.ts') },
      { find: '@codia/plugin-protocol', replacement: path.resolve(__dirname, 'packages/plugin-protocol/src/index.ts') },
      { find: '@codia/plugin-runtime', replacement: path.resolve(__dirname, 'packages/plugin-runtime/src/index.ts') },
      { find: '@codia/plugin-sdk', replacement: path.resolve(__dirname, 'packages/plugin-sdk/src/index.ts') },
      { find: '@codia/plugin-components', replacement: path.resolve(__dirname, 'packages/plugin-components/src/index.ts') },
      { find: '@codia/plugin-protocol', replacement: path.resolve(__dirname, 'packages/plugin-protocol/src/index.ts') },
      { find: '@codia/plugin-runtime', replacement: path.resolve(__dirname, 'packages/plugin-runtime/src/index.ts') },
      { find: '@codia/plugin-sdk', replacement: path.resolve(__dirname, 'packages/plugin-sdk/src/index.ts') },
      { find: /^katex$/, replacement: path.resolve(__dirname, 'node_modules/katex/dist/katex.min.js') },
    ],
  },
  build: {
    outDir: '../dist-renderer',
    emptyOutDir: true,
    chunkSizeWarningLimit: 11000,
    rollupOptions: {
      checks: {
        pluginTimings: false,
      },
      input: {
        main: path.join(rendererRoot, 'index.html'),
        mobile: path.join(rendererRoot, 'mobile.html'),
        settings: path.join(rendererRoot, 'settings.html'),
        'quick-chat': path.join(rendererRoot, 'quick-chat.html'),
        onboarding: path.join(rendererRoot, 'onboarding.html'),
        splash: path.join(rendererRoot, 'splash.html'),
        'browser-viewer': path.join(rendererRoot, 'browser-viewer.html'),
        'viewer-window': path.join(rendererRoot, 'viewer-window.html'),
        'editor-window': path.join(rendererRoot, 'editor-window.html'),
      },
      output: {
        manualChunks: rendererManualChunks,
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: createDevWebProxy(),
  },
  test: {
    root: path.resolve(__dirname),
    include: [
      'tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      'plugins/**/tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      'desktop/src/react/**/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      'desktop/src/react/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-server/**",
      "**/dist-renderer/**",
      "**/dist-server-bundle/**",
      "**/dist-folder/**",
      "**/coverage/**",
      "**/codia-0.*/**",
      "**/codia-main1.6/**",
      "**/hermes-agent-main/**",
      `${projectRoot.replace(/\\/g, '/')}/dist/**`,
      `${projectRoot.replace(/\\/g, '/')}/dist-server/**`,
      `${projectRoot.replace(/\\/g, '/')}/dist-renderer/**`,
      `${projectRoot.replace(/\\/g, '/')}/dist-server-bundle/**`,
      `${projectRoot.replace(/\\/g, '/')}/dist-folder/**`,
      `${projectRoot.replace(/\\/g, '/')}/codia-main1.6/**`,
      `${projectRoot.replace(/\\/g, '/')}/codia-0.101.4/**`,
      `${projectRoot.replace(/\\/g, '/')}/hermes-agent-main/**`,
    ],
  },
});
