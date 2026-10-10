import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const PI_BUILTIN_TOOL_NAMES = Object.freeze([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
]);

export const CODIA_PI_EXTENSION_TOOL_NAMES = Object.freeze([
  "codemode",
  "tool_search",
]);

function readPiCodingAgentVersion() {
  let dir = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  while (dir && dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.name === "@earendil-works/pi-coding-agent" && typeof pkg.version === "string") {
        return pkg.version;
      }
    }
    dir = path.dirname(dir);
  }
  throw new Error("Unable to resolve @earendil-works/pi-coding-agent package version");
}

export const PI_CODING_AGENT_VERSION = readPiCodingAgentVersion();

export function getPiCodingAgentVersion() {
  return PI_CODING_AGENT_VERSION;
}

export function isPiSdkNameAllowlistVersion(version = getPiCodingAgentVersion()) {
  const [major, minor] = String(version).split(".").map(part => Number.parseInt(part, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    throw new Error(`Unsupported @earendil-works/pi-coding-agent version: ${version}`);
  }
  return major > 0 || (major === 0 && minor >= 68);
}

export function assertAgentTool(tool, owner = "createAgentSession.tools") {
  if (!tool || typeof tool !== "object") {
    throw new TypeError(`${owner} must contain tool objects`);
  }
  if (typeof tool.name !== "string" || tool.name.length === 0) {
    throw new TypeError(`${owner} contains a tool without a non-empty string name`);
  }
  if (typeof tool.execute !== "function") {
    throw new TypeError(`${owner}.${tool.name} must have an execute function`);
  }
}

export function getToolDefinitionName(tool, owner = "createAgentSession.customTools") {
  if (!tool || typeof tool !== "object") {
    throw new TypeError(`${owner} must contain tool definition objects`);
  }
  if (typeof tool.name !== "string" || tool.name.length === 0) {
    throw new TypeError(`${owner} contains a tool without a non-empty string name`);
  }
  return tool.name;
}

export function agentToolToToolDefinition(tool) {
  assertAgentTool(tool);
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    prepareArguments: tool.prepareArguments,
    executionMode: tool.executionMode,
    renderCall: tool.renderCall,
    renderResult: tool.renderResult,
    renderShell: tool.renderShell,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
    execute: async (toolCallId, params, signal, onUpdate, ctx) =>
      tool.execute(toolCallId, params, signal, onUpdate, ctx),
  };
}

export function uniqueToolNames(names) {
  return [...new Set(
    names.filter(name => typeof name === "string" && name.length > 0),
  )];
}

export function normalizeCreateAgentSessionOptions(options, version = getPiCodingAgentVersion()) {
  if (!options || typeof options !== "object") {
    return options;
  }

  if (!isPiSdkNameAllowlistVersion(version)) {
    return options;
  }

  const rawTools = Array.isArray(options.tools) ? options.tools : [];
  const rawCustomTools = Array.isArray(options.customTools) ? options.customTools : [];

  for (const tool of rawTools) assertAgentTool(tool);
  const convertedBaseTools = rawTools.map(agentToolToToolDefinition);
  const hasToolAccess = rawTools.length > 0 || rawCustomTools.length > 0;
  const allowedNames = uniqueToolNames([
    ...rawTools.map(tool => tool.name),
    ...rawCustomTools.map(tool => getToolDefinitionName(tool)),
    ...(hasToolAccess ? CODIA_PI_EXTENSION_TOOL_NAMES : []),
  ]);

  return {
    ...options,
    tools: allowedNames,
    customTools: [
      ...convertedBaseTools,
      ...rawCustomTools,
    ],
  };
}
