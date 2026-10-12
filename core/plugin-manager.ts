// @ts-nocheck
import fs from "fs";
import path from "path";
import { createPluginContext } from "./plugin-context.ts";
import { createPluginRouteRequestContext } from "./plugin-route-request-context.ts";
import { normalizePluginConfigSchema } from "./plugin-config.ts";
import { freshImport } from "./fresh-import.ts";
import { detectIncompatiblePluginFormat } from "../lib/plugin-format-guard.ts";
import { getToolSessionPath, normalizeToolRuntimeContext } from "../lib/tools/tool-session.ts";
import {
  ensureVsCodeCompatibilityManifest,
  isGeneratedVsCodeCompatPage,
  isGeneratedVsCodeCompatRouteFile,
  isVsCodeCompatManifest,
  loadVsCodeFileIconThemes,
} from "../shared/vscode-extension-compat.ts";

const KNOWN_CONTRIBUTION_DIRS = [
  "tools", "routes", "skills", "agents", "commands", "providers",
];
const KNOWN_UI_HOST_CAPABILITIES = new Set([
  "external.open",
  "clipboard.writeText",
  "sessionFile.open",
]);
const VSCODE_COMPAT_CONTRIBUTION_PREFIX = "vscode:";
const PLUGIN_RUNTIME_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const SCRIPT_PLUGIN_RUNTIME_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

function canLoadPluginRuntimeFile(filePath) {
  const ext = path.extname(filePath);
  if (SCRIPT_PLUGIN_RUNTIME_EXTENSIONS.has(ext)) return true;
  return PLUGIN_RUNTIME_EXTENSIONS.has(ext) && process.features?.typescript === "strip";
}

function listPluginRuntimeFiles(dir, { cjs = false } = {}) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((file) => {
      const ext = path.extname(file);
      if (!PLUGIN_RUNTIME_EXTENSIONS.has(ext)) return false;
      if (!cjs && ext === ".cjs") return false;
      return canLoadPluginRuntimeFile(path.join(dir, file));
    })
    .sort((a, b) => {
      const stemCompare = path.basename(a, path.extname(a)).localeCompare(path.basename(b, path.extname(b)));
      if (stemCompare) return stemCompare;
      return extensionPriority(a) - extensionPriority(b);
    });

  const seen = new Set();
  const deduped = [];
  for (const file of files) {
    const stem = path.basename(file, path.extname(file));
    if (seen.has(stem)) continue;
    seen.add(stem);
    deduped.push(file);
  }
  return deduped;
}

function extensionPriority(file) {
  const ext = path.extname(file);
  if (ext === ".js") return 0;
  if (ext === ".mjs") return 1;
  if (ext === ".cjs") return 2;
  if (ext === ".ts") return 3;
  if (ext === ".mts") return 4;
  if (ext === ".cts") return 5;
  return 9;
}

function resolvePluginRuntimeFile(dir, basename) {
  for (const ext of [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]) {
    const candidate = path.join(dir, `${basename}${ext}`);
    if (fs.existsSync(candidate) && canLoadPluginRuntimeFile(candidate)) return candidate;
  }
  return null;
}

function addContribution(contributions, name) {
  if (!contributions.includes(name)) contributions.push(name);
}

function hasConfigProperties(schema) {
  return Object.keys(schema?.properties || {}).length > 0;
}

function isVsCodeCompatPlugin(entry) {
  return isVsCodeCompatManifest(entry?.manifest);
}

function normalizeUiHostCapabilities(raw, pluginId) {
  if (!Array.isArray(raw)) return [];
  const result = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== "string" || item.trim() === "") continue;
    const capability = item.trim();
    if (!KNOWN_UI_HOST_CAPABILITIES.has(capability)) {
      console.warn(`[plugin-manager] plugin "${pluginId}" declares unknown UI host capability "${capability}", ignoring`);
      continue;
    }
    if (seen.has(capability)) continue;
    seen.add(capability);
    result.push(capability);
  }
  return result;
}

function normalizeCapabilityList(capabilities) {
  const raw = Array.isArray(capabilities)
    ? capabilities
    : capabilities && typeof capabilities === "object"
      ? Object.entries(capabilities).filter(([, enabled]) => enabled === true).map(([key]) => key)
      : [];
  return [...new Set(raw
    .filter((capability) => typeof capability === "string" && capability.trim())
    .map((capability) => capability.trim()))];
}

/** Semver compare: returns true if a >= b */
function semverGte(a, b) {
  const pa = (a || "0.0.0").split(".").map(Number);
  const pb = (b || "0.0.0").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return true;
}

function normalizePluginToolResult(raw, pluginId) {
  let result;
  if (typeof raw === "string") {
    result = { content: [{ type: "text", text: raw }] };
  } else if (raw && raw.content) {
    result = raw;
  } else {
    result = { content: [{ type: "text", text: String(raw ?? "") }] };
  }
  if (pluginId) {
    result.details = result.details && typeof result.details === "object" ? result.details : {};
    if (!result.details.pluginId) result.details.pluginId = pluginId;
  }
  if (result.details?.card && pluginId && !result.details.card.pluginId) {
    result.details.card.pluginId = pluginId;
  }
  return result;
}

export class PluginManager {
  /**
   * @param {{ pluginsDirs: string[], dataDir: string, bus: object }} opts
 * pluginsDirs: 多个扫描目录，先内嵌后用户（靠前的优先）
 * 兼容旧签-{ pluginsDir: string } -自动转为单元素数- */
  constructor({
    pluginsDirs,
    pluginsDir,
    dataDir,
    bus,
    preferencesManager,
    appVersion,
    getSessionPath,
    getWorkspaceDir,
    registerSessionFile,
    emitResourceChanged,
    resourceIO,
    slashRegistry,
    logSink,
    runtimeContext,
  }) {
    this._pluginsDirs = pluginsDirs || (pluginsDir ? [pluginsDir] : []);
    this._dataDir = dataDir;
    this._bus = bus;
    this._preferencesManager = preferencesManager || null;
    this._appVersion = appVersion || "0.0.0";
    this._getSessionPath = getSessionPath || (() => null);
    this._getWorkspaceDir = getWorkspaceDir || (() => null);
    this._registerSessionFile = registerSessionFile || null;
    this._emitResourceChanged = typeof emitResourceChanged === "function" ? emitResourceChanged : null;
    this._resourceIO = resourceIO || null;
    this._slashRegistry = slashRegistry || null;
    this._logSink = typeof logSink === "function" ? logSink : null;
    this._runtimeContext = runtimeContext || null;
    this._plugins = new Map();
    this._scanned = [];
    this._opQueue = Promise.resolve();
    this.routeRegistry = new Map();

    // Contribution registries
    this._tools = [];
    this._commands = [];
    this._skillPaths = [];
    this._agentTemplates = [];
    this._providerPlugins = [];
    this._configSchemas = [];
    // extensionFactories: Array<{ pluginId: string, factory: Function }>
    this._extensionFactories = [];
    this._pages = [];
    this._widgets = [];
    this._settingsTabs = [];
    this._vscodeFileIconThemes = [];
  }

  scan() {
    const results = [];
    const seen = new Set();
    for (let i = 0; i < this._pluginsDirs.length; i++) {
      const dir = this._pluginsDirs[i];
      const source = i === 0 ? "builtin" : "community";
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);
        const pluginDir = path.join(dir, entry.name);
        try {
          ensureVsCodeCompatibilityManifest(pluginDir);
          const desc = this._readPluginDescriptor(pluginDir, entry.name);
          desc.source = source;
          if (seen.has(`id:${desc.id}`)) {
            console.warn(`[plugin-manager] plugin id "${desc.id}" conflicts with "${entry.name}"; skipping`);
            continue;
          }
          seen.add(`id:${desc.id}`);
          results.push(desc);
        } catch (err) {
          console.error(`[plugin-manager] failed to read plugin "${entry.name}":`, err.message);
        }
      }
    }
    this._scanned = results;
    return results;
  }

  _readPluginDescriptor(pluginDir, dirName) {
    const formatIssue = detectIncompatiblePluginFormat(pluginDir);
    const manifestPath = path.join(pluginDir, "manifest.json");
    let manifest = null;
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    }
    const id = manifest?.id || formatIssue?.id || dirName;
    const name = manifest?.name || formatIssue?.name || dirName;
    const version = manifest?.version || formatIssue?.version || "0.0.0";
    const description = manifest?.description || "";
    const uiHostCapabilities = normalizeUiHostCapabilities(manifest?.ui?.hostCapabilities, id);
    const contributions = [];
    const vscodeCompat = isVsCodeCompatManifest(manifest);
    if (vscodeCompat) {
      if (manifest?.contributes?.page) addContribution(contributions, "page");
    } else {
      for (const dir of KNOWN_CONTRIBUTION_DIRS) {
        if (fs.existsSync(path.join(pluginDir, dir))) addContribution(contributions, dir);
      }
      if (manifest?.contributes?.page) addContribution(contributions, "page");
      if (manifest?.contributes?.widget) addContribution(contributions, "widget");
      if (manifest?.contributes?.settingsTab) addContribution(contributions, "settingsTab");
      if (fs.existsSync(path.join(pluginDir, "extensions"))) addContribution(contributions, "extensions");
      if (resolvePluginRuntimeFile(pluginDir, "index")) addContribution(contributions, "lifecycle");
    }
    const vscodeContributions = manifest?.compatibility?.kind === "vscode-extension"
      && Array.isArray(manifest?.compatibility?.vscode?.contributions)
      ? manifest.compatibility.vscode.contributions
      : [];
    for (const contribution of vscodeContributions) {
      if (typeof contribution === "string" && contribution) {
        addContribution(contributions, `${VSCODE_COMPAT_CONTRIBUTION_PREFIX}${contribution}`);
      }
    }
    const trust = manifest?.trust === "full-access" ? "full-access" : "restricted";
    const hidden = !!manifest?.hidden;
    const configSchema = normalizePluginConfigSchema(id, manifest?.contributes?.configuration || {});
    const capabilities = normalizeCapabilityList(manifest?.capabilities);
    const sensitiveCapabilities = normalizeCapabilityList(manifest?.sensitiveCapabilities);
    if (hasConfigProperties(configSchema)) addContribution(contributions, "configuration");
    return { id, name, version, description, pluginDir, manifest, contributions, trust, hidden, uiHostCapabilities, configSchema, capabilities, sensitiveCapabilities, formatIssue };
  }

  readPluginDescriptor(pluginDir, dirName = path.basename(pluginDir)) {
    return this._readPluginDescriptor(pluginDir, dirName);
  }

  async loadAll() {
    const descriptors = this._scanned.length > 0 ? this._scanned : this.scan();
    const disabledList = this._preferencesManager?.getDisabledPlugins() || [];
    for (const desc of descriptors) {
      const entry = { ...desc, status: "loading", instance: null, _disposables: [] };

      if (desc.formatIssue) {
        entry.status = "incompatible";
        entry.error = desc.formatIssue.message;
        this._plugins.set(desc.id, entry);
        continue;
      }

 // builtin 插件不受 disabled 列表和全权开关约束，始终加载
      if (desc.source !== "builtin" && disabledList.includes(desc.id)) {
        entry.status = "disabled";
        this._plugins.set(desc.id, entry);
        continue;
      }

      if (desc.source === "community" && desc.trust === "full-access") {
        const allowed = this._preferencesManager?.getAllowFullAccessPlugins() || false;
        if (!allowed) {
          entry.status = "restricted";
          this._plugins.set(desc.id, entry);
          continue;
        }
      }

      // minAppVersion check
      const minVer = desc.manifest?.minAppVersion;
      if (minVer && !semverGte(this._appVersion, minVer)) {
        entry.status = "incompatible";
        entry.error = `requires app v${minVer}+, current v${this._appVersion}`;
        this._plugins.set(desc.id, entry);
        console.warn(`[plugin-manager] "${desc.id}" skipped: ${entry.error}`);
        continue;
      }

      this._plugins.set(desc.id, entry);
      try {
        await this._loadPlugin(entry);
        entry.status = "loaded";
      } catch (err) {
        entry.status = "failed";
        entry.error = err.message;
        console.error(`[plugin-manager] plugin "${desc.id}" failed to load:`, err.message);
      }
    }
  }

  async _loadPlugin(entry) {
    const accessLevel = (entry.source === "builtin" || entry.trust === "full-access")
      ? "full-access"
      : "restricted";
    entry.accessLevel = accessLevel;
    const vscodeCompat = isVsCodeCompatPlugin(entry);

    entry.ctx = createPluginContext({
      pluginId: entry.id,
      source: entry.source,
      pluginDir: entry.pluginDir,
      dataDir: path.join(this._dataDir, entry.id),
      bus: this._bus,
      accessLevel,
      permissions: entry.manifest?.permissions,
      capabilities: entry.capabilities,
      sensitiveCapabilities: entry.sensitiveCapabilities,
      registerSessionFile: this._registerSessionFile,
      emitResourceChanged: this._emitResourceChanged,
      resourceIO: this._resourceIO,
      configSchema: entry.configSchema,
      getWorkspaceDir: this._getWorkspaceDir,
      logSink: this._logSink,
      runtimeContext: this._runtimeContext,
      network: entry.manifest?.network,
    });

    if (vscodeCompat) {
      await this._loadRoutes(entry);
      this._loadPage(entry);
      this._loadVsCodeFileIconThemes(entry);
      return;
    }

    // All Codia plugins: declarative contributions
    await this._loadTools(entry);
    await this._loadSkillPaths(entry);
    await this._loadCommands(entry);
    await this._loadAgentTemplates(entry);  // JSON declaration, no code execution
    this._loadConfiguration(entry);

    // Full-access only: system-level extension points
    if (accessLevel === "full-access") {
      await this._loadRoutes(entry);
      await this._loadExtensions(entry);
      await this._loadProviders(entry);
      this._loadPage(entry);
      this._loadWidget(entry);
      this._loadSettingsTab(entry);

      // Lifecycle entry can be .js in packaged/runtime output or .ts in source on Node versions with type stripping.
      const indexPath = resolvePluginRuntimeFile(entry.pluginDir, "index");
      if (indexPath) {
        const mod = await freshImport(indexPath);
        const PluginClass = mod.default;
        if (PluginClass && typeof PluginClass === "function") {
          const instance = new PluginClass();
          entry.instance = instance;
          instance.ctx = entry.ctx;
          instance.register = (disposable) => {
            if (typeof disposable === "function") entry._disposables.push(disposable);
          };
          instance.ctx.registerTool = (toolDef) => this.addTool(entry.id, toolDef);
          if (typeof instance.onload === "function") await instance.onload();
        }
      }
    }
  }

  // ── Task 5: Tool loader ──────────────────────────────────────────────────

  async _loadTools(entry) {
    const toolsDir = path.join(entry.pluginDir, "tools");
    const files = listPluginRuntimeFiles(toolsDir);
    if (files.length === 0) return;
    const ctx = entry.ctx;
    entry.disabledTools = [];
    for (const file of files) {
        const filePath = path.join(toolsDir, file);
        try {
          const mod = await freshImport(filePath);
          if (mod.disabled === true) {
            entry.disabledTools.push({
              file,
              name: mod.name || path.basename(file, path.extname(file)),
              reason: mod.disabledReason || mod.description || "disabled by plugin module",
            });
            continue;
          }
          if (!mod.name || !mod.description || typeof mod.execute !== "function") continue;
        const origExecute = mod.execute;
        this._tools.push({
          name: `${entry.id}_${mod.name}`,
          description: mod.description,
          parameters: mod.parameters ?? {},
          ...(mod.promptSnippet ? { promptSnippet: mod.promptSnippet } : {}),
          ...(mod.promptGuidelines ? { promptGuidelines: mod.promptGuidelines } : {}),
          execute: async (_toolCallId, params, signalOrRuntimeCtx, _onUpdate, piCtx) => {
            const { ctx: runtimeCtx, hasExplicitCtx } = normalizeToolRuntimeContext(signalOrRuntimeCtx, piCtx);
            const sessionPath = runtimeCtx?.sessionPath
              || getToolSessionPath(runtimeCtx)
              || (!hasExplicitCtx ? this._getSessionPath?.() : null)
              || null;
            const sessionCtx = { sessionPath };
            const mergedCtx = hasExplicitCtx
              ? { ...ctx, ...runtimeCtx, ...sessionCtx }
              : { ...ctx, ...sessionCtx };
            const raw = await origExecute(params, mergedCtx);
            return normalizePluginToolResult(raw, ctx.pluginId);
          },
          _pluginId: entry.id,
        });
      } catch (err) {
        console.error(`[plugin-manager] tool "${file}" in "${entry.id}" failed to load:`, err.message);
      }
    }
  }

  /**
  *
    *
 * @returns {Function} 清理函数（调用即移除该工具）
   */
  addTool(pluginId, toolDef) {
    const origExecute = toolDef.execute;
    const tool = {
      name: `${pluginId}_${toolDef.name}`,
      description: toolDef.description || "",
      parameters: toolDef.parameters || { type: "object", properties: {} },
      execute: async (toolCallId, params, signalOrRuntimeCtx, onUpdate, piCtx) => {
        const { ctx: runtimeCtx } = normalizeToolRuntimeContext(signalOrRuntimeCtx, piCtx);
        const sessionPath = runtimeCtx?.sessionPath || getToolSessionPath(runtimeCtx) || null;
        const mergedCtx = sessionPath ? { ...runtimeCtx, sessionPath } : runtimeCtx;
        const raw = toolDef.invocationStyle === "pi_tool" || toolDef.metadata?.codiaInvocationStyle === "pi_tool"
          ? origExecute.length >= 5
            ? await origExecute(toolCallId, params, signalOrRuntimeCtx, onUpdate, mergedCtx)
            : await origExecute(toolCallId, params, mergedCtx)
          : await origExecute(params, mergedCtx);
        return normalizePluginToolResult(raw, pluginId);
      },
      _pluginId: pluginId,
      _dynamic: true,
    };
    if (typeof toolDef.isEnabledForAgentConfig === "function") {
      tool.isEnabledForAgentConfig = toolDef.isEnabledForAgentConfig;
    }
    if (toolDef.metadata && typeof toolDef.metadata === "object") {
      tool.metadata = { ...toolDef.metadata };
    }
    this._tools.push(tool);
    return () => {
      const idx = this._tools.indexOf(tool);
      if (idx !== -1) this._tools.splice(idx, 1);
    };
  }

  getAllTools() {
    return [...this._tools];
  }

  getPluginTool(pluginId, toolName) {
    if (!pluginId || !toolName) return null;
    const requestedToolName = String(toolName).trim();
    if (!requestedToolName) return null;
    const prefixedToolName = `${pluginId}_${requestedToolName}`;
    return this.getAllTools().find((candidate) => (
      candidate?._pluginId === pluginId
      && (candidate.name === prefixedToolName || candidate.name === requestedToolName)
    )) || null;
  }

  async executePluginTool(tool, { toolCallId, input = {}, runtimeCtx = {} } = {}) {
    if (!tool || typeof tool.execute !== "function") throw new Error("plugin tool is not executable");
    const callId = toolCallId || `plugin-tool-${Date.now()}`;
    const raw = await tool.execute(callId, input, runtimeCtx);
    return normalizePluginToolResult(raw, tool._pluginId);
  }

  // ── Task 6: Skill paths + Command loader ────────────────────────────────

  async _loadSkillPaths(entry) {
    const skillsDir = path.join(entry.pluginDir, "skills");
    if (!fs.existsSync(skillsDir)) return;
    this._skillPaths.push({
      dirPath: skillsDir,
      label: `plugin:${entry.id}`,
      builtin: entry.source === "builtin",
    });
  }

  getSkillPaths() {
    return [...this._skillPaths];
  }

  async _loadCommands(entry) {
    const cmdsDir = path.join(entry.pluginDir, "commands");
    const files = listPluginRuntimeFiles(cmdsDir);
    if (files.length === 0) return;
    for (const file of files) {
      const filePath = path.join(cmdsDir, file);
      try {
        const mod = await freshImport(filePath);
        if (!mod.name) continue;
        const hasHandler = typeof mod.handler === "function";
        const hasExecute = typeof mod.execute === "function";
        if (!hasHandler && !hasExecute) continue;

        if (hasHandler) {
          if (entry.accessLevel !== "full-access") {
            console.warn(
              `[plugin-manager] "${entry.id}/${file}" declares slash handler but plugin is restricted; skipped. ` +
              `Requires builtin source or manifest.trust="full-access".`,
            );
            continue;
          }
          this._slashRegistry?.registerCommand?.(
            {
              name: mod.name,
              aliases: Array.isArray(mod.aliases) ? mod.aliases : [],
              description: mod.description ?? "",
              scope: mod.scope || "session",
              permission: mod.permission || "owner",
              handler: mod.handler,
              usage: mod.usage,
            },
            { source: "plugin", sourceId: entry.source === "builtin" ? `builtin:${entry.id}` : entry.id },
          );
        } else {
          this._commands.push({
            name: `${entry.id}.${mod.name}`,
            description: mod.description ?? "",
            execute: mod.execute,
            _pluginId: entry.id,
          });
        }
      } catch (err) {
        console.error(`[plugin-manager] command "${file}" in "${entry.id}" failed to load:`, err.message);
      }
    }
  }

  getAllCommands() {
    return [...this._commands];
  }

  // ── Task 7: Route loader ─────────────────────────────────────────────────

  async _loadRoutes(entry) {
    const routesDir = path.join(entry.pluginDir, "routes");
    if (!fs.existsSync(routesDir)) return;
    const { Hono } = await import("hono");
    const app = new Hono();
    const ctx = entry.ctx;

    // Error isolation: Hono's onError is the correct hook for handler throws
    app.onError((err, c) => {
      ctx.log.error("route error:", err.message);
      return c.json({ error: "Plugin internal error", plugin: entry.id }, 500);
    });

    // Middleware: inject ctx + agentId (from proxy header)
    app.use("*", async (c, next) => {
      c.set("pluginCtx", ctx);
      const request = c.env?.pluginRouteRequest || null;
      const agentId = request?.agentId
        || c.req.header("X-CODIA-Agent-Id")
        || c.req.header("X-codia-Agent-Id")
        || null;
      c.set("agentId", agentId);
      c.set("pluginRequestContext", createPluginRouteRequestContext({
        pluginCtx: ctx,
        accessLevel: entry.accessLevel,
        capabilities: entry.manifest && Object.prototype.hasOwnProperty.call(entry.manifest, "capabilities")
          ? entry.capabilities
          : null,
        sensitiveCapabilities: entry.manifest && Object.prototype.hasOwnProperty.call(entry.manifest, "sensitiveCapabilities")
          ? entry.sensitiveCapabilities
          : null,
        principal: request?.principal || null,
        agentId,
      }));
      await next();
    });

    const files = listPluginRuntimeFiles(routesDir, { cjs: true });
    const routeFiles = isVsCodeCompatPlugin(entry)
      ? files.filter(isGeneratedVsCodeCompatRouteFile)
      : files;
    for (const file of routeFiles) {
      const filePath = path.join(routesDir, file);
      try {
        const mod = await freshImport(filePath);
        if (typeof mod.default === "function") {
          const sub = mod.default;
          if (sub && typeof sub.fetch === "function") {
 //
            sub.use("*", async (c, next) => {
              c.set("pluginCtx", ctx);
              const request = c.env?.pluginRouteRequest || null;
              const agentId = request?.agentId
                || c.req.header("X-CODIA-Agent-Id")
                || c.req.header("X-codia-Agent-Id")
                || null;
              c.set("agentId", agentId);
              c.set("pluginRequestContext", createPluginRouteRequestContext({
                pluginCtx: ctx,
                accessLevel: entry.accessLevel,
                capabilities: entry.manifest && Object.prototype.hasOwnProperty.call(entry.manifest, "capabilities")
                  ? entry.capabilities
                  : null,
                sensitiveCapabilities: entry.manifest && Object.prototype.hasOwnProperty.call(entry.manifest, "sensitiveCapabilities")
                  ? entry.sensitiveCapabilities
                  : null,
                principal: request?.principal || null,
                agentId,
              }));
              await next();
            });
            const prefix = "/" + path.basename(file, path.extname(file));
            app.route(prefix, sub);
          } else if (typeof sub === "function") {
 //
            sub(app, ctx);
          }
        }
        if (mod.register && typeof mod.register === "function") {
          mod.register(app, ctx);
        }
      } catch (err) {
        console.error(`[plugin-manager] route "${file}" in "${entry.id}" failed to load:`, err.message);
      }
    }
    this.routeRegistry.set(entry.id, app);
  }

  // ── Task 8: Extension loader ─────────────────────────────────────────────

  /**
 * 加载 extensions/ 目录下的 Pi SDK extension 工厂函数- * 每个 .js 文件导出 (pi: ExtensionAPI) => void，在 session 创建时被 Pi SDK 调用- */
  async _loadExtensions(entry) {
    const extDir = path.join(entry.pluginDir, "extensions");
    const files = listPluginRuntimeFiles(extDir);
    if (files.length === 0) return;
    for (const file of files) {
      const filePath = path.join(extDir, file);
      try {
        const mod = await freshImport(filePath);
        const factory = mod.default ?? mod;
        if (typeof factory !== "function") {
          console.warn(`[plugin-manager] extension "${file}" in "${entry.id}" does not export a function, skipped`);
          continue;
        }
        this._extensionFactories.push({ pluginId: entry.id, factory });
      } catch (err) {
        console.error(`[plugin-manager] extension "${file}" in "${entry.id}" failed to load:`, err.message);
      }
    }
  }

  // ── Task 9: Configuration loader ─────────────────────────────────────────

  _loadConfiguration(entry) {
    const schema = entry.configSchema;
    if (!schema || Object.keys(schema.properties || {}).length === 0) return;
    this._configSchemas.push({ pluginId: entry.id, schema });
  }

  getConfigSchema(pluginId) {
    return this._configSchemas.find((s) => s.pluginId === pluginId)?.schema ?? null;
  }

  getAllConfigSchemas() {
    return [...this._configSchemas];
  }

  getConfig(pluginId, options = {}) {
    const entry = this._plugins.get(pluginId);
    if (!entry?.ctx?.config) return null;
    return {
      pluginId,
      schema: entry.ctx.config.getSchema(),
      values: entry.ctx.config.getAll({ ...options, redacted: true }),
    };
  }

  setConfig(pluginId, values, options = {}) {
    const entry = this._plugins.get(pluginId);
    if (!entry?.ctx?.config) throw new Error(`Plugin "${pluginId}" not found`);
    const nextValues = entry.ctx.config.setMany(values, options);
    this._bus?.emit?.({ type: "plugin_config_changed", pluginId, scope: options.scope || "global" });
    return {
      pluginId,
      schema: entry.ctx.config.getSchema(),
      values: entry.ctx.config.getAll({ ...options, redacted: true }),
      rawValues: nextValues,
    };
  }

  // ── Page / Widget loader ──────────────────────────────────────────────────

  _loadPage(entry) {
    const page = entry.manifest?.contributes?.page;
    if (!page) return;
    if (entry.accessLevel !== 'full-access' && !isGeneratedVsCodeCompatPage(entry.manifest, page)) {
      entry.ctx?.log?.warn('page contribution requires full-access, skipping');
      return;
    }
    const routesDir = path.join(entry.pluginDir, 'routes');
    if (!fs.existsSync(routesDir)) {
      entry.ctx?.log?.warn(`page declares route "${page.route}" but routes/ directory not found`);
      return;
    }
    this._pages.push({
      pluginId: entry.id,
      title: page.title || entry.id,
      icon: page.icon || null,
      route: page.route,
      hostCapabilities: [...(entry.uiHostCapabilities || [])],
    });
  }

  _loadWidget(entry) {
    const widget = entry.manifest?.contributes?.widget;
    if (!widget) return;
    if (entry.accessLevel !== 'full-access') {
      entry.ctx?.log?.warn('widget contribution requires full-access, skipping');
      return;
    }
    const routesDir = path.join(entry.pluginDir, 'routes');
    if (!fs.existsSync(routesDir)) {
      entry.ctx?.log?.warn(`widget declares route "${widget.route}" but routes/ directory not found`);
      return;
    }
    this._widgets.push({
      pluginId: entry.id,
      title: widget.title || entry.id,
      icon: widget.icon || null,
      route: widget.route,
      hostCapabilities: [...(entry.uiHostCapabilities || [])],
    });
  }

  // ── Task 10: Agent templates + Provider loader ───────────────────────────

  _loadSettingsTab(entry) {
    const settingsTab = entry.manifest?.contributes?.settingsTab;
    if (!settingsTab) return;
    if (entry.source !== "builtin") {
      entry.ctx?.log?.warn("settingsTab contribution is only available to bundled built-in plugins, skipping");
      return;
    }
    if (entry.accessLevel !== "full-access") {
      entry.ctx?.log?.warn("settingsTab contribution requires full-access, skipping");
      return;
    }
    if (typeof settingsTab.nativeComponent !== "string" || !settingsTab.nativeComponent) {
      entry.ctx?.log?.warn("settingsTab contribution requires nativeComponent, skipping");
      return;
    }
    this._settingsTabs.push({
      pluginId: entry.id,
      id: settingsTab.id || entry.id,
      title: settingsTab.title || entry.name || entry.id,
      icon: settingsTab.icon || null,
      nativeComponent: settingsTab.nativeComponent,
    });
  }

  _loadVsCodeFileIconThemes(entry) {
    const themes = loadVsCodeFileIconThemes(entry.pluginDir, entry.id);
    if (themes.length > 0) this._vscodeFileIconThemes.push(...themes);
  }

  async _loadAgentTemplates(entry) {
    const agentsDir = path.join(entry.pluginDir, "agents");
    if (!fs.existsSync(agentsDir)) return;
    const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(agentsDir, file);
      try {
        const template = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        template._pluginId = entry.id;
        this._agentTemplates.push(template);
      } catch (err) {
        console.error(`[plugin-manager] agent template "${file}" in "${entry.id}" failed to load:`, err.message);
      }
    }
  }

  getAgentTemplates() {
    return [...this._agentTemplates];
  }

  async _loadProviders(entry) {
    const providersDir = path.join(entry.pluginDir, "providers");
    if (!fs.existsSync(providersDir)) return;
    const files = listPluginRuntimeFiles(providersDir);
    if (files.length === 0) return;
    for (const file of files) {
      const filePath = path.join(providersDir, file);
      try {
        const mod = await freshImport(filePath);
        if (!mod.id) continue;
        this._providerPlugins.push({ ...mod, _pluginId: entry.id });
      } catch (err) {
        console.error(`[plugin-manager] provider "${file}" in "${entry.id}" failed to load:`, err.message);
      }
    }
  }

  getProviderPlugins() {
    return [...this._providerPlugins];
  }

  // ── Operation queue ───────────────────────────────────────────────────────

  _enqueue(fn) {
    const op = this._opQueue.then(fn);
    this._opQueue = op.catch(err => {
      console.error("[plugin-manager] op failed:", err);
    });
    return op; // caller gets success/failure
  }

  // ── Hot operations ───────────────────────────────────────────────────────

  _isFullAccessAllowed(entryOrDesc, options = {}) {
    if (entryOrDesc?.source === "dev") return options.allowFullAccess === true;
    return this._preferencesManager?.getAllowFullAccessPlugins() || false;
  }

  async installPlugin(pluginDir, options = {}) {
    return this._enqueue(async () => {
      const dirName = path.basename(pluginDir);
      const source = options.source === "dev" ? "dev" : "community";
      const desc = this._readPluginDescriptor(pluginDir, dirName);
      desc.source = source;
      // Check for existing (upgrade scenario)
      const existing = [...this._plugins.values()].find(
        p => p.id === (options.pluginId || desc.id) || path.basename(p.pluginDir) === dirName
      );
      if (existing) {
        await this.unloadPlugin(existing.id);
        this._plugins.delete(existing.id);
      }

      const disabledList = source === "dev"
        ? []
        : (this._preferencesManager?.getDisabledPlugins() || []);

      const entry = { ...desc, status: "loading", instance: null, _disposables: [] };
      this._plugins.set(desc.id, entry);

      if (desc.formatIssue) {
        entry.status = "incompatible";
        entry.error = desc.formatIssue.message;
        return entry;
      }

      if (disabledList.includes(desc.id)) {
        entry.status = "disabled";
        return entry;
      }

      if (desc.trust === "full-access" && !this._isFullAccessAllowed(entry, options)) {
        entry.status = "restricted";
        return entry;
      }

      try {
        await this._loadPlugin(entry);
        entry.status = "loaded";
      } catch (err) {
        entry.status = "failed";
        entry.error = err.message;
      }
      this._bus?.emit({ type: "plugin_ui_changed" });
      return entry;
    });
  }

  async removePlugin(pluginId, options = {}) {
    return this._enqueue(async () => {
      const entry = this._plugins.get(pluginId);
      if (!entry) throw new Error(`Plugin "${pluginId}" not found`);
      if (entry.source === "builtin") throw new Error(`Builtin plugin "${pluginId}" cannot be removed`);
      if (entry.status === "loaded" || entry.status === "failed") {
        await this.unloadPlugin(pluginId);
      }
      this._plugins.delete(pluginId);
      if (entry.source === "dev" || options.persist === false) {
        // Dev plugin removal is scoped to its dev slot and must not mutate normal preferences.
      } else if (this._preferencesManager) {
        const disabled = this._preferencesManager.getDisabledPlugins();
        this._preferencesManager.setDisabledPlugins(
          disabled.filter(id => id !== pluginId)
        );
      } else {
        console.warn("[plugin-manager] removePlugin: preferencesManager unavailable, disabled list not updated");
      }
      this._bus?.emit({ type: "plugin_ui_changed" });
      return entry.pluginDir;
    });
  }

  async disablePlugin(pluginId, options = {}) {
    return this._enqueue(async () => {
      const entry = this._plugins.get(pluginId);
      if (!entry) throw new Error(`Plugin "${pluginId}" not found`);
      if (entry.source === "builtin") throw new Error(`Builtin plugin "${pluginId}" cannot be disabled`);
      if (entry.status === "loaded") {
        await this.unloadPlugin(pluginId);
      }
      entry.status = "disabled";
      if (entry.source === "dev" || options.persist === false) {
        // Dev plugin enablement is scoped to the dev slot and must not persist.
      } else if (this._preferencesManager) {
        const disabled = this._preferencesManager.getDisabledPlugins();
        if (!disabled.includes(pluginId)) {
          this._preferencesManager.setDisabledPlugins([...disabled, pluginId]);
        }
      } else {
        console.warn("[plugin-manager] disablePlugin: preferencesManager unavailable, preference not persisted");
      }
      this._bus?.emit({ type: "plugin_ui_changed" });
    });
  }

  async enablePlugin(pluginId, options = {}) {
    return this._enqueue(async () => {
      const entry = this._plugins.get(pluginId);
      if (!entry) throw new Error(`Plugin "${pluginId}" not found`);
      // Built-in plugins are always loaded; do not persist an enable preference.
      if (entry.source === "builtin") return;
      if (entry.source === "dev" || options.persist === false) {
        // Dev plugin enablement is scoped to the dev slot and must not persist.
      } else if (this._preferencesManager) {
        const disabled = this._preferencesManager.getDisabledPlugins();
        this._preferencesManager.setDisabledPlugins(
          disabled.filter(id => id !== pluginId)
        );
      } else {
        console.warn("[plugin-manager] enablePlugin: preferencesManager unavailable, preference not persisted");
      }
      if (entry.trust === "full-access" && !this._isFullAccessAllowed(entry, options)) {
        entry.status = "restricted";
        this._bus?.emit({ type: "plugin_ui_changed" });
        return entry;
      }
      // Guard: unload before re-loading to prevent duplicate tool/command/route registration
      if (entry.status === "loaded") {
        await this.unloadPlugin(pluginId);
      }
      try {
        await this._loadPlugin(entry);
        entry.status = "loaded";
      } catch (err) {
        entry.status = "failed";
        entry.error = err.message;
      }
      this._bus?.emit({ type: "plugin_ui_changed" });
      return entry;
    });
  }

  async setFullAccess(allow) {
    return this._enqueue(async () => {
      if (this._preferencesManager) {
        this._preferencesManager.setAllowFullAccessPlugins(allow);
      } else {
        console.warn("[plugin-manager] setFullAccess: preferencesManager unavailable, preference not persisted");
      }
      for (const entry of this._plugins.values()) {
        if (entry.source !== "community" || entry.trust !== "full-access") continue;
        const disabledList = this._preferencesManager?.getDisabledPlugins() || [];
        if (disabledList.includes(entry.id)) continue;

        if (allow && entry.status === "restricted") {
          try {
            await this._loadPlugin(entry);
            entry.status = "loaded";
          } catch (err) {
            entry.status = "failed";
            entry.error = err.message;
          }
        } else if (!allow && entry.status === "loaded") {
          await this.unloadPlugin(entry.id);
          entry.status = "restricted";
        }
      }
      this._bus?.emit({ type: "plugin_ui_changed" });
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async unloadPlugin(pluginId) {
    const entry = this._plugins.get(pluginId);
    if (!entry) return;

    // 1. Lifecycle cleanup: onunload + disposables.
    if (entry.instance) {
      if (typeof entry.instance.onunload === "function") {
        try { await entry.instance.onunload(); } catch (err) {
          console.error(`[plugin-manager] "${pluginId}" onunload error:`, err.message);
        }
      }
      for (const d of entry._disposables.reverse()) {
        try { d(); } catch (err) {
          console.error(`[plugin-manager] "${pluginId}" disposable error:`, err.message);
        }
      }
      entry._disposables = [];
    }

 //
    this._tools = this._tools.filter(t => t._pluginId !== pluginId);
    this._commands = this._commands.filter(c => c._pluginId !== pluginId);
    this._skillPaths = this._skillPaths.filter(s => s.label !== `plugin:${pluginId}`);
    this._agentTemplates = this._agentTemplates.filter(t => t._pluginId !== pluginId);
    this._providerPlugins = this._providerPlugins.filter(p => p._pluginId !== pluginId);
    this._configSchemas = this._configSchemas.filter(s => s.pluginId !== pluginId);
    this._extensionFactories = this._extensionFactories.filter(e => e.pluginId !== pluginId);
    this._pages = this._pages.filter(p => p.pluginId !== pluginId);
    this._widgets = this._widgets.filter(w => w.pluginId !== pluginId);
    this._settingsTabs = this._settingsTabs.filter(t => t.pluginId !== pluginId);
    this._vscodeFileIconThemes = this._vscodeFileIconThemes.filter(t => t.pluginId !== pluginId);
    this._slashRegistry?.unregisterBySource?.("plugin", pluginId);
    this._slashRegistry?.unregisterBySource?.("plugin", `builtin:${pluginId}`);
    this.routeRegistry.delete(pluginId);

    entry.status = "unloaded";
  }

 //

 /** 用户（社区）插件目录 */
  getUserPluginsDir() {
    return this._pluginsDirs[this._pluginsDirs.length - 1] || null;
  }

 /** 是否允许 full-access 社区插件 */
  getAllowFullAccess() {
    return this._preferencesManager?.getAllowFullAccessPlugins() || false;
  }

 /** */
  isValidPluginDir(dirPath) {
    if (detectIncompatiblePluginFormat(dirPath)) return true;
    const validMarkers = [
      ...KNOWN_CONTRIBUTION_DIRS,
      "manifest.json", "index.js", "index.ts", "extensions",
    ];
    return validMarkers.some(marker => {
      const p = path.join(dirPath, marker);
      return fs.existsSync(p);
    });
  }

 /** */
  getRouteApp(pluginId) {
    return this.routeRegistry.get(pluginId) || null;
  }

 /** */
  getExtensionFactories() {
    return this._extensionFactories.map(e => e.factory);
  }

  getPages() { return [...this._pages]; }
  getWidgets() { return [...this._widgets]; }
  getSettingsTabs() { return [...this._settingsTabs]; }
  getVsCodeFileIconThemes() { return [...this._vscodeFileIconThemes]; }
  getDiagnostics() {
    return [...this._plugins.values()].map((entry) => {
      const pluginId = entry.id;
      return {
        id: pluginId,
        name: entry.name,
        version: entry.version,
        source: entry.source || "community",
        trust: entry.trust || "restricted",
        hidden: !!entry.hidden,
        status: entry.status,
        error: entry.error || null,
        formatIssue: entry.formatIssue || null,
        uiHostCapabilities: Array.isArray(entry.uiHostCapabilities) ? [...entry.uiHostCapabilities] : [],
        activationState: entry.activationState || null,
        activationEvents: Array.isArray(entry.activationEvents) ? [...entry.activationEvents] : [],
        activationReason: entry.activationReason || null,
        activationError: entry.activationError || null,
        contributions: Array.isArray(entry.contributions) ? [...entry.contributions] : [],
        routes: {
          hasRouteApp: this.routeRegistry.has(pluginId),
          pages: this._pages.filter((item) => item.pluginId === pluginId).map(clonePlain),
          widgets: this._widgets.filter((item) => item.pluginId === pluginId).map(clonePlain),
          settingsTabs: this._settingsTabs.filter((item) => item.pluginId === pluginId).map(clonePlain),
        },
        tools: this._tools
          .filter((item) => item._pluginId === pluginId)
          .map((item) => ({ name: item.name, dynamic: !!item._dynamic })),
        commands: this._commands
          .filter((item) => item._pluginId === pluginId)
          .map((item) => ({ name: item.name })),
        providers: this._providerPlugins
          .filter((item) => item._pluginId === pluginId)
          .map((item) => ({ id: item.id, name: item.name || item.id })),
        config: {
          hasSchema: !!entry.configSchema,
          keys: Object.keys(entry.configSchema?.properties || {}),
        },
      };
    });
  }

  getUiHostCapabilityGrants() {
    return [...this._plugins.values()]
      .filter(entry => entry.status === "loaded" && Array.isArray(entry.uiHostCapabilities) && entry.uiHostCapabilities.length > 0)
      .map(entry => ({
        pluginId: entry.id,
        hostCapabilities: [...entry.uiHostCapabilities],
      }));
  }

  getPlugin(id) { return this._plugins.get(id) || null; }
  listPlugins() { return [...this._plugins.values()]; }
}

function clonePlain(value) {
  return structuredClone(value);
}
