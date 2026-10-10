import fs from "fs";
import path from "path";

export const SERVER_RUNTIME_ASSET_FILES = [
  "codia.png",
  "codia-rational.jpg",
  "codia-original-background.jpg",
  "MiaoFei-Logo.jpg",
];

export const SERVER_RUNTIME_ASSET_DIRS = [
  "character-cards",
  "cover-gallery",
];

export const SERVER_RUNTIME_RENDERER_REQUIRED_FILES = [
  "index.html",
  "mobile.html",
  "styles.css",
  "manifest.webmanifest",
  "sw.js",
  "icon.png",
];

export const SERVER_RUNTIME_RENDERER_DIRS = [
  "lib",
  "themes",
  "locales",
];

const SERVER_RUNTIME_RENDERER_REFERENCE_FILES = SERVER_RUNTIME_RENDERER_REQUIRED_FILES.filter(
  (fileName) => /\.(?:html|css|js|json|webmanifest)$/i.test(fileName),
);

function assertRequiredAssetExists(fsImpl, sourcePath, label) {
  if (!fsImpl.existsSync(sourcePath)) {
    throw new Error(`[build-server] required runtime asset missing: ${label}`);
  }
}

export function copyServerRuntimeAssets({ rootDir, outDir, fsImpl = fs }) {
  const copied = [];
  const sourceAssetsDir = path.join(rootDir, "desktop", "src", "assets");
  const targetAssetsDir = path.join(outDir, "desktop", "src", "assets");
  fsImpl.mkdirSync(targetAssetsDir, { recursive: true });

  for (const fileName of SERVER_RUNTIME_ASSET_FILES) {
    const sourcePath = path.join(sourceAssetsDir, fileName);
    assertRequiredAssetExists(fsImpl, sourcePath, path.join("desktop", "src", "assets", fileName));
    fsImpl.copyFileSync(sourcePath, path.join(targetAssetsDir, fileName));
    copied.push(path.join("desktop", "src", "assets", fileName));
  }

  for (const dirName of SERVER_RUNTIME_ASSET_DIRS) {
    const sourcePath = path.join(sourceAssetsDir, dirName);
    assertRequiredAssetExists(fsImpl, sourcePath, path.join("desktop", "src", "assets", dirName));
    fsImpl.cpSync(sourcePath, path.join(targetAssetsDir, dirName), { recursive: true });
    copied.push(path.join("desktop", "src", "assets", dirName) + path.sep);
  }

  copyServerRuntimeRenderer({ rootDir, outDir, fsImpl });
  copied.push(path.join("desktop", "dist-renderer") + path.sep);

  return copied;
}

function copyServerRuntimeRenderer({ rootDir, outDir, fsImpl }) {
  const sourceRendererDir = path.join(rootDir, "desktop", "dist-renderer");
  const targetRendererDir = path.join(outDir, "desktop", "dist-renderer");
  assertRequiredAssetExists(fsImpl, sourceRendererDir, path.join("desktop", "dist-renderer"));

  for (const fileName of SERVER_RUNTIME_RENDERER_REQUIRED_FILES) {
    assertRequiredAssetExists(
      fsImpl,
      path.join(sourceRendererDir, fileName),
      path.join("desktop", "dist-renderer", fileName),
    );
  }
  assertRequiredAssetExists(fsImpl, path.join(sourceRendererDir, "assets"), path.join("desktop", "dist-renderer", "assets"));

  fsImpl.rmSync(targetRendererDir, { recursive: true, force: true });
  fsImpl.mkdirSync(path.dirname(targetRendererDir), { recursive: true });

  for (const fileName of SERVER_RUNTIME_RENDERER_REQUIRED_FILES) {
    const sourcePath = path.join(sourceRendererDir, fileName);
    const targetPath = path.join(targetRendererDir, fileName);
    if (fileName === "mobile.html") {
      copyRuntimeTextFile(fsImpl, targetPath, ensureMobileRuntimeScripts(fsImpl.readFileSync(sourcePath, "utf-8")));
    } else {
      copyRuntimeFile(fsImpl, sourcePath, targetPath);
    }
  }
  copyRuntimeAssets({
    fsImpl,
    sourceAssetsDir: path.join(sourceRendererDir, "assets"),
    targetAssetsDir: path.join(targetRendererDir, "assets"),
    entryFiles: SERVER_RUNTIME_RENDERER_REFERENCE_FILES.map((fileName) => path.join(sourceRendererDir, fileName)),
  });
  for (const dirName of SERVER_RUNTIME_RENDERER_DIRS) {
    const sourceDir = path.join(sourceRendererDir, dirName);
    if (!fsImpl.existsSync(sourceDir)) continue;
    copyRuntimeDir(fsImpl, sourceDir, path.join(targetRendererDir, dirName));
  }
}

function copyRuntimeAssets({ fsImpl, sourceAssetsDir, targetAssetsDir, entryFiles }) {
  const assetNames = new Set();
  const queued = [];

  function addAsset(name) {
    const normalized = normalizeAssetName(name);
    if (!normalized || assetNames.has(normalized)) return;
    if (!fsImpl.existsSync(path.join(sourceAssetsDir, normalized))) return;
    assetNames.add(normalized);
    queued.push(normalized);
  }

  for (const name of listFilesRecursive(fsImpl, sourceAssetsDir)) {
    if (shouldExcludeRuntimeFile(name)) continue;
    if (!/\.(?:js|css)$/i.test(name)) addAsset(name);
  }

  for (const filePath of entryFiles) {
    collectAssetReferences(fsImpl.readFileSync(filePath, "utf-8"), addAsset);
  }

  while (queued.length > 0) {
    const name = queued.shift();
    if (!/\.(?:js|css)$/i.test(name)) continue;
    const sourcePath = path.join(sourceAssetsDir, name);
    if (!fsImpl.existsSync(sourcePath)) continue;
    collectAssetReferences(fsImpl.readFileSync(sourcePath, "utf-8"), addAsset);
  }

  for (const name of assetNames) {
    copyRuntimeFile(fsImpl, path.join(sourceAssetsDir, name), path.join(targetAssetsDir, name));
  }
}

function collectAssetReferences(content, addAsset) {
  const patterns = [
    /(?:href|src)=["'](?:\.\/)?assets\/([^"'?#]+)/g,
    /["']\.\/([^"'?#]+)["']/g,
    /url\(\s*["']?(?!data:|https?:|\/)(?:\.\/)?assets\/([^"')?#]+)["']?\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) addAsset(match[1]);
  }
}

function normalizeAssetName(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^assets\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  if (shouldExcludeRuntimeFile(normalized)) return null;
  return parts.join(path.sep);
}

function shouldExcludeRuntimeFile(relativePath) {
  return relativePath.split(/[\\/]/).some((part) => part === ".DS_Store" || part.endsWith(".map"));
}

function copyRuntimeFile(fsImpl, sourcePath, targetPath) {
  fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true });
  fsImpl.copyFileSync(sourcePath, targetPath);
}

function copyRuntimeTextFile(fsImpl, targetPath, content) {
  fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true });
  fsImpl.writeFileSync(targetPath, content, "utf-8");
}

function ensureMobileRuntimeScripts(html) {
  const scripts = [
    '<script type="module" src="lib/i18n.js"></script>',
    '<script type="module" src="lib/theme.js"></script>',
  ].filter((script) => !hasScriptSrc(html, scriptSrc(script)));
  if (scripts.length === 0) return html;

  const block = scripts.map((script) => `    ${script}`).join("\n");
  const appScript = /(\s*<script\b(?=[^>]*\bsrc=["'](?:\.\/)?assets\/)[^>]*><\/script>)/i;
  if (appScript.test(html)) {
    return html.replace(appScript, `\n${block}$1`);
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${block}\n</body>`);
  }
  return `${html}\n${block}\n`;
}

function hasScriptSrc(html, src) {
  const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<script\\b(?=[^>]*\\bsrc=["'](?:\\./)?${escaped}["'])`, "i").test(html);
}

function scriptSrc(script) {
  return script.match(/\bsrc="([^"]+)"/)?.[1] || "";
}

function copyRuntimeDir(fsImpl, sourceDir, targetDir) {
  fsImpl.cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(sourceDir, source);
      return !relative || !shouldExcludeRuntimeFile(relative);
    },
  });
}

function listFilesRecursive(fsImpl, rootDir) {
  const names = [];
  function visit(dir, prefix = "") {
    for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, relative);
      } else if (entry.isFile()) {
        names.push(relative);
      }
    }
  }
  visit(rootDir);
  return names;
}
