// @ts-nocheck
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import YAML from "js-yaml";

function isZhLocale(locale) {
  return String(locale || "zh-CN").startsWith("zh");
}

export function fillAgentTemplate(content, agent) {
  return String(content || "")
    .replace(/\{\{userName\}\}/g, agent.userName || "User")
    .replace(/\{\{agentName\}\}/g, agent.agentName || agent.id || "助手")
    .replace(/\{\{agentId\}\}/g, agent.id || "");
}

function normalizeContent(content) {
  return String(content || "").replace(/\r\n/g, "\n").trim();
}

function readConfig(agentDir) {
  try {
    const configPath = path.join(agentDir, "config.yaml");
    return YAML.load(fsSync.readFileSync(configPath, "utf-8")) || {};
  } catch {
    return {};
  }
}

export function isBrokenGeneratedPrompt(content, kind) {
  if (kind !== "identity") return false;
  const normalized = normalizeContent(content);
  return /^#\s+[^\n]+\n+的个人助手。?$/.test(normalized)
    || /^#\s+[^\n]+\n+'s personal assistant\.?$/.test(normalized);
}

function isKongIncompatibleGeneratedPrompt(content, kind) {
  const normalized = normalizeContent(content);
  if (!normalized) return false;

  if (kind === "identity") {
    return (
      (normalized.includes("个人助手") && normalized.includes("感性与理性兼备"))
      || (normalized.includes("personal assistant") && normalized.includes("emotional") && normalized.includes("rational"))
    );
  }

  return (
    normalized.includes("# 人格定义")
    || normalized.includes("# Persona")
    || normalized.includes("MOOD")
    || normalized.includes("意识流")
    || normalized.includes("stream-of-consciousness")
    || normalized.includes("Codia Balance")
    || normalized.includes("Codia 均衡")
  );
}

function promptFiles(kind) {
  return kind === "identity"
    ? { ownFile: "identity.md", templateDir: "identity-templates", exampleFile: "identity.example.md" }
    : { ownFile: "ishiki.md", templateDir: "ishiki-templates", exampleFile: "ishiki.example.md" };
}

function editMarkerFile(kind) {
  return kind === "identity" ? ".identity.user-edited" : ".ishiki.user-edited";
}

function editMarkerPath(agent, kind) {
  return path.join(agent.agentDir, editMarkerFile(kind));
}

function hasUserEditedPrompt(agent, kind) {
  return fsSync.existsSync(editMarkerPath(agent, kind));
}

async function writeUserEditedMarker(agent, kind) {
  await fs.mkdir(agent.agentDir, { recursive: true });
  await fs.writeFile(editMarkerPath(agent, kind), `${new Date().toISOString()}\n`, "utf-8");
}

async function clearUserEditedMarker(agent, kind) {
  await fs.rm(editMarkerPath(agent, kind), { force: true }).catch(() => {});
}

function templatePathsForYuan(agent, kind, yuan = agent.yuan, includeExample = true) {
  const { templateDir, exampleFile } = promptFiles(kind);
  const paths = [];
  if (!isZhLocale(agent.locale)) {
    paths.push(path.join(agent.productDir, templateDir, "en", `${yuan}.md`));
  }
  paths.push(path.join(agent.productDir, templateDir, `${yuan}.md`));
  if (includeExample) paths.push(path.join(agent.productDir, exampleFile));
  return paths;
}

function listTemplatePathsSync(productDir, kind) {
  const { templateDir, exampleFile } = promptFiles(kind);
  const paths = [];
  const root = path.join(productDir, templateDir);
  const walk = (dir) => {
    let entries = [];
    try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) paths.push(full);
    }
  };
  walk(root);
  paths.push(path.join(productDir, exampleFile));
  return [...new Set(paths)];
}

function contentMatchesTemplate(content, templateContent, agents) {
  const normalized = normalizeContent(content);
  if (!normalized) return false;
  for (const agent of agents) {
    if (!agent) continue;
    if (normalized === normalizeContent(templateContent)) return true;
    if (normalized === normalizeContent(fillAgentTemplate(templateContent, agent))) return true;
  }
  return false;
}

function isGeneratedPromptForYuanSync(content, kind, agent, yuan = agent.yuan) {
  const specificPaths = templatePathsForYuan(agent, kind, yuan, false)
    .filter((candidate) => fsSync.existsSync(candidate));
  const paths = specificPaths.length > 0
    ? specificPaths
    : templatePathsForYuan(agent, kind, yuan, true).slice(-1);

  for (const candidate of paths) {
    try {
      if (contentMatchesTemplate(content, fsSync.readFileSync(candidate, "utf-8"), [agent])) return true;
    } catch {
      // Missing templates are ignored; fallback readers handle them separately.
    }
  }
  return false;
}

export function isGeneratedDefaultPrompt(content, kind, agent, extraAgents = []) {
  const agents = [agent, ...extraAgents].filter(Boolean);
  for (const candidate of listTemplatePathsSync(agent.productDir, kind)) {
    try {
      if (contentMatchesTemplate(content, fsSync.readFileSync(candidate, "utf-8"), agents)) return true;
    } catch {
      // Ignore missing or unreadable optional templates.
    }
  }
  return false;
}

function shouldUseOwnPrompt(content, kind, agent, userEdited = false) {
  if (!normalizeContent(content)) return false;
  if (userEdited) return true;
  if (isBrokenGeneratedPrompt(content, kind)) return false;
  if (agent.yuan === "kong" && isKongIncompatibleGeneratedPrompt(content, kind)) return false;
  if (isGeneratedPromptForYuanSync(content, kind, agent, agent.yuan)) return true;
  if (isGeneratedDefaultPrompt(content, kind, agent)) return false;
  return true;
}

function shouldRefreshOwnPrompt(content, kind, previousAgent, nextAgent) {
  if (!normalizeContent(content)) return true;
  if (hasUserEditedPrompt(previousAgent, kind) || hasUserEditedPrompt(nextAgent, kind)) return false;
  if (isBrokenGeneratedPrompt(content, kind)) return true;
  if (nextAgent.yuan === "kong" && isKongIncompatibleGeneratedPrompt(content, kind)) return true;
  return isGeneratedDefaultPrompt(content, kind, previousAgent, [nextAgent]);
}

async function readFirstExisting(paths, kind) {
  for (const candidate of paths) {
    try {
      const content = await fs.readFile(candidate, "utf-8");
      if (content.trim() && !isBrokenGeneratedPrompt(content, kind)) return content;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  return "";
}

function resolveAgentInfo(engine, agentOrId) {
  const runtimeAgent = typeof agentOrId === "string" ? engine.getAgent?.(agentOrId) : agentOrId;
  const id = runtimeAgent?.id || (typeof agentOrId === "string" ? agentOrId : engine.currentAgentId);
  const agentDir = runtimeAgent?.agentDir || path.join(engine.agentsDir, id);
  const config = runtimeAgent?.config || readConfig(agentDir);
  const locale = config?.locale || runtimeAgent?._locale?.() || engine.getLocale?.() || engine.config?.locale || "zh-CN";
  const userName = runtimeAgent?.userName || config?.user?.name || (isZhLocale(locale) ? "\u7528\u6237" : "User");
  const agentName = runtimeAgent?.agentName || config?.agent?.name || id || "助手";
  return {
    id,
    agentDir,
    productDir: runtimeAgent?.productDir || engine.productDir,
    locale,
    yuan: config?.agent?.yuan || "codia",
    userName,
    agentName,
  };
}

function mergeAgentInfo(agent, partial = {}) {
  return {
    ...agent,
    locale: partial.locale ?? agent.locale,
    yuan: partial.agent?.yuan ?? agent.yuan,
    agentName: partial.agent?.name ?? agent.agentName,
    userName: partial.user?.name ?? agent.userName,
  };
}

export function readBundledEditableTemplateSync(agent, kind) {
  for (const candidate of templatePathsForYuan(agent, kind)) {
    try {
      const content = fsSync.readFileSync(candidate, "utf-8");
      if (normalizeContent(content) && !isBrokenGeneratedPrompt(content, kind)) return content;
    } catch {
      // Try the next fallback template.
    }
  }
  return "";
}

export function readEditablePromptSync(agent, kind) {
  const { ownFile } = promptFiles(kind);
  try {
    const own = fsSync.readFileSync(path.join(agent.agentDir, ownFile), "utf-8");
    if (shouldUseOwnPrompt(own, kind, agent, hasUserEditedPrompt(agent, kind))) return fillAgentTemplate(own, agent);
  } catch {
    // Missing editable files fall through to bundled templates.
  }
  return fillAgentTemplate(readBundledEditableTemplateSync(agent, kind), agent);
}

export async function refreshEditablePromptsForConfigChange(engine, agentOrId, partial = {}) {
  const mayAffectEditablePrompts = Object.prototype.hasOwnProperty.call(partial, "locale")
    || Object.prototype.hasOwnProperty.call(partial?.agent || {}, "yuan")
    || Object.prototype.hasOwnProperty.call(partial?.agent || {}, "name")
    || Object.prototype.hasOwnProperty.call(partial?.user || {}, "name");
  if (!mayAffectEditablePrompts) return { updated: [] };

  if (!agentOrId || !engine?.agentsDir || !engine?.productDir) return { updated: [] };

  const previousAgent = resolveAgentInfo(engine, agentOrId);
  const nextAgent = mergeAgentInfo(previousAgent, partial);
  const relevantChange = previousAgent.yuan !== nextAgent.yuan
    || previousAgent.agentName !== nextAgent.agentName
    || previousAgent.userName !== nextAgent.userName
    || previousAgent.locale !== nextAgent.locale;
  if (!relevantChange) return { updated: [] };

  const updated = [];
  for (const kind of ["identity", "ishiki"]) {
    const { ownFile } = promptFiles(kind);
    const ownPath = path.join(nextAgent.agentDir, ownFile);
    let content = "";
    try { content = await fs.readFile(ownPath, "utf-8"); } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    if (!shouldRefreshOwnPrompt(content, kind, previousAgent, nextAgent)) continue;
    const replacement = readBundledEditableTemplateSync(nextAgent, kind);
    if (!normalizeContent(replacement)) continue;
    await fs.mkdir(nextAgent.agentDir, { recursive: true });
    await fs.writeFile(ownPath, fillAgentTemplate(replacement, nextAgent), "utf-8");
    await clearUserEditedMarker(nextAgent, kind);
    updated.push(kind);
  }
  return { updated };
}

export async function readAgentEditablePrompt(engine, agentOrId, kind) {
  const agent = resolveAgentInfo(engine, agentOrId);
  const { ownFile } = promptFiles(kind);
  try {
    const own = await fs.readFile(path.join(agent.agentDir, ownFile), "utf-8");
    if (shouldUseOwnPrompt(own, kind, agent, hasUserEditedPrompt(agent, kind))) return fillAgentTemplate(own, agent);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const raw = await readFirstExisting(templatePathsForYuan(agent, kind), kind);
  return fillAgentTemplate(raw, agent);
}

export async function writeAgentEditablePrompt(engine, agentOrId, kind, content) {
  const agent = resolveAgentInfo(engine, agentOrId);
  const { ownFile } = promptFiles(kind);
  await fs.mkdir(agent.agentDir, { recursive: true });
  await fs.writeFile(path.join(agent.agentDir, ownFile), content, "utf-8");
  await writeUserEditedMarker(agent, kind);
  return { ok: true, agentId: agent.id, kind, content };
}

export async function readAgentPromptTemplateSnapshot(engine, agentOrId, kind) {
  const agent = resolveAgentInfo(engine, agentOrId);
  const current = await readAgentEditablePrompt(engine, agentOrId, kind);
  const template = fillAgentTemplate(readBundledEditableTemplateSync(agent, kind), agent);
  return {
    kind,
    yuan: agent.yuan,
    current,
    template,
    diff: buildPromptDiff(current, template),
  };
}

export async function readAgentPromptTemplateState(engine, agentOrId) {
  const agent = resolveAgentInfo(engine, agentOrId);
  const [identity, ishiki] = await Promise.all([
    readAgentPromptTemplateSnapshot(engine, agentOrId, "identity"),
    readAgentPromptTemplateSnapshot(engine, agentOrId, "ishiki"),
  ]);
  return {
    agentId: agent.id,
    yuan: agent.yuan,
    prompts: {
      identity: buildPromptState(identity),
      ishiki: buildPromptState(ishiki),
    },
  };
}

export async function resetAgentEditablePromptToTemplate(engine, agentOrId, kind) {
  const agent = resolveAgentInfo(engine, agentOrId);
  const { ownFile } = promptFiles(kind);
  const template = fillAgentTemplate(readBundledEditableTemplateSync(agent, kind), agent);
  await fs.mkdir(agent.agentDir, { recursive: true });
  await fs.writeFile(path.join(agent.agentDir, ownFile), template, "utf-8");
  await clearUserEditedMarker(agent, kind);
  return template;
}

export async function resetAgentEditablePrompt(engine, agentOrId, kind) {
  const agent = resolveAgentInfo(engine, agentOrId);
  const content = await resetAgentEditablePromptToTemplate(engine, agentOrId, kind);
  return { ok: true, agentId: agent.id, yuan: agent.yuan, kind, content };
}

function buildPromptState(snapshot) {
  const changedLines = Array.isArray(snapshot.diff?.lines) ? snapshot.diff.lines : [];
  const added = changedLines
    .filter((line) => line.type === "removed" || line.type === "changed")
    .map((line) => line.current)
    .filter(Boolean);
  const removed = changedLines
    .filter((line) => line.type === "added" || line.type === "changed")
    .map((line) => line.template)
    .filter(Boolean);
  return {
    kind: snapshot.kind,
    yuan: snapshot.yuan,
    current: snapshot.current,
    template: snapshot.template,
    hasCustomChanges: changedLines.length > 0,
    diff: {
      changed: snapshot.diff?.changed || 0,
      added,
      removed,
      lines: changedLines,
    },
  };
}

function buildPromptDiff(current, template) {
  const currentLines = String(current || "").replace(/\r\n/g, "\n").split("\n");
  const templateLines = String(template || "").replace(/\r\n/g, "\n").split("\n");
  const max = Math.max(currentLines.length, templateLines.length);
  const lines = [];
  let changed = 0;
  let added = 0;
  let removed = 0;
  for (let i = 0; i < max; i += 1) {
    const currentLine = currentLines[i];
    const templateLine = templateLines[i];
    if (currentLine === templateLine) {
      lines.push({ line: i + 1, type: "same", current: currentLine || "", template: templateLine || "" });
      continue;
    }
    if (currentLine === undefined) added += 1;
    else if (templateLine === undefined) removed += 1;
    else changed += 1;
    lines.push({
      line: i + 1,
      type: currentLine === undefined ? "added" : templateLine === undefined ? "removed" : "changed",
      current: currentLine || "",
      template: templateLine || "",
    });
  }
  return {
    changed,
    added,
    removed,
    lines: lines.filter((line) => line.type !== "same").slice(0, 80),
  };
}
