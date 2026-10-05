import fs from "fs";
import path from "path";

export const VSCODE_COMPAT_ROUTE_FILE = "gsap-vscode-compat.cjs";
export const VSCODE_COMPAT_PAGE_ROUTE = "/gsap-vscode-compat/page";

export const VSCODE_DECLARATIVE_CONTRIBUTIONS = [
  "commands",
  "configuration",
  "configurationDefaults",
  "themes",
  "languages",
  "grammars",
  "snippets",
  "keybindings",
  "menus",
  "views",
  "viewsContainers",
  "iconThemes",
  "productIconThemes",
  "customEditors",
  "debuggers",
  "notebooks",
  "walkthroughs",
  "jsonValidation",
  "colors",
  "semanticTokenTypes",
  "semanticTokenModifiers",
  "terminal",
  "problemMatchers",
  "problemPatterns",
  "taskDefinitions",
];

export function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export function containsVsCodePackage(dirPath) {
  const packagePath = path.join(dirPath, "package.json");
  if (!fs.existsSync(packagePath)) return false;
  const pkg = readJsonFile(packagePath);
  return typeof pkg?.name === "string"
    && (
      typeof pkg?.engines?.vscode === "string"
      || typeof pkg?.publisher === "string"
      || typeof pkg?.contributes === "object"
      || typeof pkg?.main === "string"
      || typeof pkg?.browser === "string"
    );
}

export function sanitizeDirName(value, fallback = "extension") {
  const clean = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return clean || fallback;
}

export function vscodePackageIdentity(pkg) {
  const publisher = sanitizeDirName(pkg?.publisher || "vscode", "vscode");
  const name = sanitizeDirName(pkg?.name || "extension", "extension");
  return {
    publisher,
    name,
    id: `${publisher}.${name}`,
  };
}

export function vscodeContributionKeys(pkg) {
  const contributes = pkg?.contributes && typeof pkg.contributes === "object" ? pkg.contributes : {};
  return VSCODE_DECLARATIVE_CONTRIBUTIONS.filter((key) => contributes[key] !== undefined);
}

export function isVsCodeCompatManifest(manifest) {
  return manifest?.compatibility?.kind === "vscode-extension"
    && manifest?.compatibility?.runtime === "declarative-compat";
}

export function isGeneratedVsCodeCompatPage(manifest, page) {
  return isVsCodeCompatManifest(manifest)
    && page?.compatibilityGenerated === true
    && page?.route === VSCODE_COMPAT_PAGE_ROUTE;
}

export function isGeneratedVsCodeCompatRouteFile(fileName) {
  return fileName === VSCODE_COMPAT_ROUTE_FILE;
}

function safeResolveInside(baseDir, relPath) {
  if (!relPath || typeof relPath !== "string") return null;
  const resolved = path.resolve(baseDir, relPath);
  const relative = path.relative(baseDir, resolved);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
  return null;
}

function mimeForAsset(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  return null;
}

function readIconAssetDataUrl(filePath) {
  try {
    const mime = mimeForAsset(filePath);
    if (!mime) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
    return `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
  } catch {
    return null;
  }
}

function normalizeIconMap(value, iconDefinitions) {
  if (!value || typeof value !== "object") return {};
  const out = {};
  for (const [key, iconId] of Object.entries(value)) {
    if (typeof key !== "string" || typeof iconId !== "string") continue;
    const icon = iconDefinitions[iconId];
    if (icon) out[key.toLowerCase()] = icon;
  }
  return out;
}

function normalizeIconRef(value, iconDefinitions) {
  return typeof value === "string" ? iconDefinitions[value] || null : null;
}

function readIconTheme(pluginDir, contribution) {
  if (!contribution || typeof contribution !== "object" || typeof contribution.path !== "string") return null;
  const themePath = safeResolveInside(pluginDir, contribution.path);
  if (!themePath || !fs.existsSync(themePath)) return null;
  const theme = readJsonFile(themePath);
  if (!theme || typeof theme !== "object") return null;

  const themeDir = path.dirname(themePath);
  const iconDefinitions = {};
  for (const [id, definition] of Object.entries(theme.iconDefinitions || {}) as Array<[string, any]>) {
    if (!id || !definition || typeof definition !== "object") continue;
    const iconPath = typeof definition.iconPath === "string"
      ? safeResolveInside(themeDir, definition.iconPath)
      : null;
    const image = iconPath ? readIconAssetDataUrl(iconPath) : null;
    if (image) iconDefinitions[id] = image;
  }

  return {
    themeId: contribution.id || theme.id || path.basename(themePath, path.extname(themePath)),
    label: contribution.label || theme.label || contribution.id || path.basename(themePath),
    defaultFile: normalizeIconRef(theme.file, iconDefinitions),
    defaultFolder: normalizeIconRef(theme.folder, iconDefinitions),
    defaultFolderExpanded: normalizeIconRef(theme.folderExpanded, iconDefinitions),
    fileExtensions: normalizeIconMap(theme.fileExtensions, iconDefinitions),
    fileNames: normalizeIconMap(theme.fileNames, iconDefinitions),
    languageIds: normalizeIconMap(theme.languageIds, iconDefinitions),
    folderNames: normalizeIconMap(theme.folderNames, iconDefinitions),
    folderNamesExpanded: normalizeIconMap(theme.folderNamesExpanded, iconDefinitions),
    rootFolderNames: normalizeIconMap(theme.rootFolderNames, iconDefinitions),
    rootFolderNamesExpanded: normalizeIconMap(theme.rootFolderNamesExpanded, iconDefinitions),
  };
}

export function loadVsCodeFileIconThemes(pluginDir, pluginId = null) {
  const pkg = readJsonFile(path.join(pluginDir, "package.json"));
  const iconThemes = Array.isArray(pkg?.contributes?.iconThemes) ? pkg.contributes.iconThemes : [];
  return iconThemes
    .map((contribution) => readIconTheme(pluginDir, contribution))
    .filter(Boolean)
    .map((theme) => ({
      pluginId: pluginId || `vscode.${vscodePackageIdentity(pkg).id}`,
      ...theme,
    }))
    .filter((theme) => Object.keys(theme.fileExtensions).length > 0
      || Object.keys(theme.fileNames).length > 0
      || Object.keys(theme.languageIds).length > 0
      || Object.keys(theme.folderNames).length > 0
      || theme.defaultFile
      || theme.defaultFolder);
}

function contributionCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return value === undefined ? 0 : 1;
}

function compactValue(value, maxLength = 120) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function contributionTitle(key, item) {
  if (!item || typeof item !== "object") return compactValue(item);
  if (key === "commands") return compactValue(item.title || item.command);
  if (key === "languages") return compactValue(item.id || item.aliases?.[0]);
  if (key === "grammars") return compactValue(item.language || item.scopeName || item.path);
  if (key === "snippets") return compactValue(item.language || item.path);
  if (key === "themes" || key === "iconThemes" || key === "productIconThemes") {
    return compactValue(item.label || item.id || item.path);
  }
  if (key === "customEditors") return compactValue(item.displayName || item.viewType);
  return compactValue(item.title || item.label || item.name || item.id || item.command || item.viewType || item.path || JSON.stringify(item));
}

function contributionMeta(key, item) {
  if (!item || typeof item !== "object") return "";
  if (key === "languages") return compactValue([item.aliases?.join(", "), item.extensions?.join(", ")].filter(Boolean).join(" | "));
  if (key === "grammars") return compactValue([item.scopeName, item.path].filter(Boolean).join(" | "));
  if (key === "snippets") return compactValue(item.path);
  if (key === "themes") return compactValue([item.uiTheme, item.path].filter(Boolean).join(" | "));
  if (key === "iconThemes" || key === "productIconThemes") return compactValue(item.path);
  if (key === "commands") return compactValue(item.command);
  if (key === "keybindings") return compactValue([item.key, item.command].filter(Boolean).join(" | "));
  if (key === "customEditors") return compactValue([item.viewType, item.selector?.map(s => s.filenamePattern).filter(Boolean).join(", ")].filter(Boolean).join(" | "));
  return "";
}

function contributionItems(key, value) {
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => ({
      title: contributionTitle(key, item),
      meta: contributionMeta(key, item),
    })).filter(item => item.title || item.meta);
  }
  if (value && typeof value === "object") {
    return Object.entries(value).slice(0, 40).map(([name, item]) => ({
      title: compactValue(name),
      meta: contributionTitle(key, item),
    }));
  }
  return [];
}

export function summarizeVsCodePackage(pkg) {
  const identity = vscodePackageIdentity(pkg);
  const displayName = pkg?.displayName || pkg?.name || identity.id;
  const contributes = pkg?.contributes && typeof pkg.contributes === "object" ? pkg.contributes : {};
  const contributionKeys = vscodeContributionKeys(pkg);
  return {
    id: identity.id,
    publisher: identity.publisher,
    name: identity.name,
    displayName,
    version: pkg?.version || "0.0.0",
    description: pkg?.description || "",
    engines: pkg?.engines || {},
    categories: Array.isArray(pkg?.categories) ? pkg.categories : [],
    keywords: Array.isArray(pkg?.keywords) ? pkg.keywords : [],
    extensionKind: pkg?.extensionKind || null,
    main: pkg?.main || null,
    browser: pkg?.browser || null,
    activationEvents: Array.isArray(pkg?.activationEvents) ? pkg.activationEvents : [],
    contributions: contributionKeys.map((key) => ({
      key,
      count: contributionCount(contributes[key]),
      items: contributionItems(key, contributes[key]),
    })),
  };
}

function safeJsJson(value) {
  return JSON.stringify(value, null, 2)
    .replace(/<\//g, "<\\/")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function createCompatRouteSource(summary) {
  return `const DATA = ${safeJsJson(summary)};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    if (ch === ">") return "&gt;";
    if (ch === '"') return "&quot;";
    if (ch === "'") return "&#39;";
    return ch;
  });
}

function tag(text) {
  return '<span class="tag">' + esc(text) + '</span>';
}

function contributionCard(entry) {
  const items = (entry.items || []).map(item => (
    '<li><strong>' + esc(item.title || entry.key) + '</strong>' +
    (item.meta ? '<span>' + esc(item.meta) + '</span>' : '') + '</li>'
  )).join('');
  return '<section class="card"><div class="card-head"><h2>' + esc(entry.key) + '</h2>' +
    '<span class="count">' + esc(entry.count) + '</span></div>' +
    (items ? '<ul>' + items + '</ul>' : '<p class="muted">Metadata imported.</p>') + '</section>';
}

function renderPage() {
  const contributions = DATA.contributions || [];
  const cards = contributions.length
    ? contributions.map(contributionCard).join('')
    : '<section class="card"><p class="muted">No declarative VS Code contributions were found.</p></section>';
  const categories = (DATA.categories || []).map(tag).join('');
  return '<!doctype html><html><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width,initial-scale=1" />' +
    '<title>' + esc(DATA.displayName) + '</title>' +
    '<style>body{margin:0;padding:22px;font:14px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text,#222);background:var(--bg,#fff)}.shell{max-width:1040px;margin:0 auto}.hero{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}.eyebrow{font-size:12px;color:var(--accent,#6b7);font-weight:700;letter-spacing:.04em;text-transform:uppercase}h1{margin:4px 0 6px;font-size:24px;line-height:1.2}p{margin:0}.muted{color:var(--text-muted,#777)}.tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.tag,.count{display:inline-flex;align-items:center;border-radius:999px;padding:2px 8px;background:color-mix(in srgb,var(--accent,#789) 12%,transparent);color:var(--accent,#567);font-size:12px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.card{border:1px solid var(--overlay-light,#ddd);border-radius:8px;padding:14px;background:var(--bg-card,var(--bg,#fff));min-width:0}.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}h2{font-size:15px;margin:0}ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}li{display:flex;flex-direction:column;gap:1px;min-width:0}li strong,li span{overflow-wrap:anywhere}li span{font-size:12px;color:var(--text-muted,#777)}.meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;font-size:12px;color:var(--text-muted,#777)}@media(max-width:640px){body{padding:14px}.hero{display:block}h1{font-size:20px}}</style>' +
    '</head><body><main class="shell"><header class="hero"><div><div class="eyebrow">VS Code compatibility</div>' +
    '<h1>' + esc(DATA.displayName) + '</h1><p class="muted">' + esc(DATA.description || DATA.id) + '</p>' +
    '<div class="meta"><span>' + esc(DATA.publisher) + '</span><span>v' + esc(DATA.version) + '</span><span>runtime: declarative compat</span></div>' +
    '<div class="tags">' + categories + '</div></div></header><div class="grid">' + cards + '</div></main></body></html>';
}

module.exports = function register(app) {
  app.get("${VSCODE_COMPAT_PAGE_ROUTE}", (c) => c.html(renderPage()));
  app.get("/gsap-vscode-compat/data", (c) => c.json(DATA));
}
`;
}

export function createGsapManifestFromVsCodePackage(pkg, currentManifest = null) {
  const identity = vscodePackageIdentity(pkg);
  const displayName = pkg?.displayName || pkg?.name || identity.id;
  const contributionKeys = vscodeContributionKeys(pkg);
  const base = currentManifest && typeof currentManifest === "object" ? currentManifest : {};
  const contributes = base.contributes && typeof base.contributes === "object" ? base.contributes : {};
  return {
    ...base,
    id: base.id || `vscode.${identity.id}`,
    name: base.name || displayName,
    version: base.version || pkg?.version || "0.0.0",
    description: base.description || pkg?.description || "",
    trust: "restricted",
    contributes: {
      ...contributes,
      page: {
        title: contributes.page?.title || displayName,
        route: VSCODE_COMPAT_PAGE_ROUTE,
        icon: contributes.page?.icon || null,
        compatibilityGenerated: true,
      },
    },
    compatibility: {
      ...(base.compatibility || {}),
      kind: "vscode-extension",
      runtime: "declarative-compat",
      vscode: {
        ...(base.compatibility?.vscode || {}),
        id: identity.id,
        publisher: identity.publisher,
        name: identity.name,
        displayName,
        engines: pkg?.engines || {},
        categories: Array.isArray(pkg?.categories) ? pkg.categories : [],
        keywords: Array.isArray(pkg?.keywords) ? pkg.keywords : [],
        activationEvents: Array.isArray(pkg?.activationEvents) ? pkg.activationEvents : [],
        extensionKind: pkg?.extensionKind || null,
        contributions: contributionKeys,
      },
    },
  };
}

export function ensureVsCodeCompatibilityManifest(targetDir) {
  if (!containsVsCodePackage(targetDir)) return false;
  const packagePath = path.join(targetDir, "package.json");
  const manifestPath = path.join(targetDir, "manifest.json");
  const pkg = readJsonFile(packagePath);
  const currentManifest = readJsonFile(manifestPath);
  if (currentManifest && !isVsCodeCompatManifest(currentManifest)) return false;

  const manifest = createGsapManifestFromVsCodePackage(pkg, currentManifest);
  const summary = summarizeVsCodePackage(pkg);
  const routesDir = path.join(targetDir, "routes");
  fs.mkdirSync(routesDir, { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  fs.writeFileSync(path.join(routesDir, VSCODE_COMPAT_ROUTE_FILE), createCompatRouteSource(summary), "utf-8");
  fs.writeFileSync(path.join(targetDir, ".gsap-vscode-extension.json"), `${JSON.stringify({
    source: "vscode-extension",
    generatedAt: new Date().toISOString(),
    package: {
      name: pkg?.name || "",
      publisher: pkg?.publisher || "",
      version: pkg?.version || "",
      main: pkg?.main || null,
      browser: pkg?.browser || null,
    },
    runtime: "declarative-compat",
    summary,
    note: "The application imports declarative VS Code contributions and generates a compatibility page. Extension activation scripts are not executed.",
  }, null, 2)}\n`, "utf-8");
  return true;
}
