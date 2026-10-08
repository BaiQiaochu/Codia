// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";

const execFileAsync = promisify(execFile);

const RESULT_MARKER = "__GSAP_HERMES_RESULT__";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_HERMES_HOME_SUBDIR = "hermes";
const HERMES_UNAVAILABLE_COOLDOWN_MS = 5 * 60 * 1000;
const HERMES_ERROR_DETAIL_MAX_CHARS = 900;
const DEFAULT_HERMES_ENABLED_TOOLSETS = Object.freeze([
  "file",
  "terminal",
  "todo",
  "memory",
  "skills",
]);

let hermesUnavailableUntil = 0;
let hermesUnavailableReason = "";

const PROVIDER_ENV_MAP = {
  openai: { key: "OPENAI_API_KEY", base: "OPENAI_BASE_URL" },
  openrouter: { key: "OPENROUTER_API_KEY", base: "OPENAI_BASE_URL" },
  anthropic: { key: "ANTHROPIC_API_KEY", base: "ANTHROPIC_BASE_URL" },
  deepseek: { key: "DEEPSEEK_API_KEY", base: "DEEPSEEK_BASE_URL" },
  minimax: { key: "MINIMAX_API_KEY", base: "MINIMAX_BASE_URL" },
  "minimax-cn": { key: "MINIMAX_API_KEY", base: "MINIMAX_CN_BASE_URL" },
  kimi: { key: "MOONSHOT_API_KEY", base: "OPENAI_BASE_URL" },
  moonshot: { key: "MOONSHOT_API_KEY", base: "OPENAI_BASE_URL" },
  "kimi-coding": { key: "MOONSHOT_API_KEY", base: "OPENAI_BASE_URL" },
  "kimi-coding-cn": { key: "MOONSHOT_API_KEY", base: "OPENAI_BASE_URL" },
  zai: { key: "ZAI_API_KEY", base: "OPENAI_BASE_URL" },
  glm: { key: "ZAI_API_KEY", base: "OPENAI_BASE_URL" },
  xai: { key: "XAI_API_KEY", base: "OPENAI_BASE_URL" },
  groq: { key: "GROQ_API_KEY", base: "OPENAI_BASE_URL" },
  mistral: { key: "MISTRAL_API_KEY", base: "OPENAI_BASE_URL" },
};

const PROVIDER_ALIAS_MAP = {
  "kimi-coding": "kimi-for-coding",
  "kimi-coding-cn": "kimi-for-coding",
  moonshot: "kimi-for-coding",
  glm: "zai",
  zhipu: "zai",
};

const API_MODE_ALIAS_MAP = {
  "openai-completions": "chat_completions",
  "openai-responses": "codex_responses",
  "openai-codex-responses": "codex_responses",
  "anthropic-messages": "anthropic_messages",
};

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveHermesGitBashPath({
  env = process.env,
  resourcesPath = process.resourcesPath,
  cwd = process.cwd(),
} = {}) {
  const candidates = [
    env.HERMES_GIT_BASH_PATH,
    resourcesPath ? path.join(resourcesPath, "git", "bin", "bash.exe") : "",
    resourcesPath ? path.join(resourcesPath, "git", "usr", "bin", "bash.exe") : "",
    resourcesPath ? path.join(resourcesPath, "git", "mingw64", "bin", "bash.exe") : "",
    resourcesPath ? path.join(resourcesPath, "git", "mingw64", "bin", "sh.exe") : "",
    resourcesPath ? path.join(resourcesPath, "git", "mingw64", "bin", "ash.exe") : "",
    resourcesPath ? path.join(resourcesPath, "git", "cmd", "ash.exe") : "",
    path.join(cwd, "vendor", "git-portable", "bin", "bash.exe"),
    path.join(cwd, "vendor", "git-portable", "usr", "bin", "bash.exe"),
    path.join(cwd, "vendor", "git-portable", "mingw64", "bin", "bash.exe"),
    path.join(cwd, "vendor", "git-portable", "mingw64", "bin", "sh.exe"),
    path.join(cwd, "vendor", "git-portable", "mingw64", "bin", "ash.exe"),
    path.join(cwd, "vendor", "git-portable", "cmd", "ash.exe"),
    process.execPath ? path.join(path.dirname(process.execPath), "git", "bin", "bash.exe") : "",
    process.execPath ? path.join(path.dirname(process.execPath), "git", "usr", "bin", "bash.exe") : "",
    process.execPath ? path.join(path.dirname(process.execPath), "git", "mingw64", "bin", "bash.exe") : "",
    process.execPath ? path.join(path.dirname(process.execPath), "git", "mingw64", "bin", "sh.exe") : "",
    process.execPath ? path.join(path.dirname(process.execPath), "git", "mingw64", "bin", "ash.exe") : "",
    process.execPath ? path.join(path.dirname(process.execPath), "git", "cmd", "ash.exe") : "",
  ];

  if (truthyEnv(env.HERMES_ALLOW_SYSTEM_GIT)) {
    candidates.push(
      path.join(env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
      path.join(env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "bash.exe"),
      path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
      path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "usr", "bin", "bash.exe"),
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe") : "",
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "Git", "usr", "bin", "bash.exe") : "",
    );
  }

  for (const candidate of candidates.filter(Boolean)) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved)) return resolved;
    } catch {
      // Ignore invalid candidate paths.
    }
  }

  return "";
}

const BRIDGE_SCRIPT = String.raw`
import base64
import json
import sys
import traceback

RESULT_MARKER = "__GSAP_HERMES_RESULT__"

def _emit(data):
    print(RESULT_MARKER + json.dumps(data, ensure_ascii=False))

def _normalize_toolsets(value):
    if isinstance(value, str):
        raw_items = value.split(",")
    elif isinstance(value, (list, tuple)):
        raw_items = value
    else:
        return None
    items = []
    for item in raw_items:
        if isinstance(item, str):
            cleaned = item.strip()
        else:
            cleaned = str(item).strip()
        if cleaned and cleaned not in items:
            items.append(cleaned)
    return items or None

try:
    root = sys.argv[1]
    payload = json.loads(base64.b64decode(sys.argv[2]).decode("utf-8"))
    sys.path.insert(0, root)

    from run_agent import AIAgent

    def _normalize_model(value):
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, dict):
            raw = value.get("id") or value.get("model") or ""
            if isinstance(raw, str):
                return raw.strip()
        return ""

    kwargs = {
        "quiet_mode": True,
        "tool_delay": 0.0,
        "max_iterations": payload.get("max_iterations", 12),
    }
    for key in ("model", "base_url", "api_key", "provider", "api_mode"):
        value = _normalize_model(payload.get(key)) if key == "model" else payload.get(key)
        if value:
            kwargs[key] = value
    for key in ("enabled_toolsets", "disabled_toolsets"):
        value = _normalize_toolsets(payload.get(key))
        if value:
            kwargs[key] = value

    agent = AIAgent(**kwargs)
    result = agent.run_conversation(
        payload["prompt"],
        system_message=payload.get("system_prompt"),
    )

    if isinstance(result, dict):
        data = {
            "final_response": result.get("final_response") or result.get("response") or "",
            "completed": result.get("completed", True),
            "error": result.get("error"),
            "model": getattr(agent, "model", "") or "",
            "provider": getattr(agent, "provider", "") or "",
        }
    else:
        data = {
            "final_response": str(result),
            "completed": True,
            "error": None,
            "model": getattr(agent, "model", "") or "",
            "provider": getattr(agent, "provider", "") or "",
        }

    _emit(data)
except Exception as exc:
    _emit({
        "final_response": "",
        "completed": False,
        "error": f"{type(exc).__name__}: {exc}",
        "traceback": traceback.format_exc(),
    })
`;

export function resolveHermesAgentRoot({
  env = process.env,
  resourcesPath = process.resourcesPath,
  cwd = process.cwd(),
  execPath = process.execPath,
} = {}) {
  const candidates = [];
  const devMode = truthyEnv(env.HERMES_ALLOW_DEV_RUNTIME) || env.NODE_ENV === "development";

  if (env.HERMES_AGENT_ROOT) {
    candidates.push(env.HERMES_AGENT_ROOT);
  }
  if (env.GSAP_ROOT) {
    candidates.push(path.join(env.GSAP_ROOT, "hermes-agent-runtime"));
  }
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, "server", "hermes-agent-runtime"));
  }
  if (execPath) {
    candidates.push(path.join(path.dirname(execPath), "resources", "server", "hermes-agent-runtime"));
    candidates.push(path.join(path.dirname(execPath), "hermes-agent-runtime"));
  }
  candidates.push(path.join(cwd, "hermes-agent-runtime"));

  if (devMode) {
    candidates.push(path.join(cwd, "hermes-agent-main"));
    candidates.push(path.resolve(cwd, "..", "hermes-agent-main"));
  }

  for (const candidate of candidates.filter(Boolean)) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(path.join(resolved, "run_agent.py"))) {
        return resolved;
      }
    } catch {
      // Ignore invalid candidate paths.
    }
  }
  return null;
}

export function normalizeHermesProvider(provider) {
  const normalized = String(provider || "").trim().toLowerCase();
  if (!normalized) return "";
  return PROVIDER_ALIAS_MAP[normalized] || normalized;
}

export function normalizeHermesApiMode(apiMode) {
  const normalized = String(apiMode || "").trim().toLowerCase();
  if (!normalized) return "";
  return API_MODE_ALIAS_MAP[normalized] || normalized;
}

export function normalizeHermesModel(model) {
  if (typeof model === "string") return model.trim();
  if (!model || typeof model !== "object") return "";

  const directId = asTrimmedString(model.id);
  if (directId) return directId;

  const directModel = asTrimmedString(model.model);
  if (directModel) return directModel;

  if (model.model && typeof model.model === "object") {
    const nestedId = asTrimmedString(model.model.id);
    if (nestedId) return nestedId;
    const nestedModel = asTrimmedString(model.model.model);
    if (nestedModel) return nestedModel;
  }

  return "";
}

function deriveHermesProvider(model, fallback = "") {
  const directProvider = normalizeHermesProvider(
    asTrimmedString(model?.provider)
    || asTrimmedString(model?.model?.provider)
    || fallback,
  );
  return directProvider;
}

function resolveHermesRoot() {
  return resolveHermesAgentRoot();
}

function truthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function getHermesSitePackages(root) {
  const candidates = process.platform === "win32"
    ? [
        path.join(root, ".venv", "Lib", "site-packages"),
        path.join(root, "venv", "Lib", "site-packages"),
      ]
    : [
        path.join(root, ".venv", "lib"),
        path.join(root, "venv", "lib"),
      ];

  const found = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    if (process.platform === "win32") {
      found.push(candidate);
      continue;
    }

    for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("python")) continue;
      const sitePackages = path.join(candidate, entry.name, "site-packages");
      if (fs.existsSync(sitePackages)) found.push(sitePackages);
    }
  }
  return found;
}

export function resolveHermesPythonCandidates(root, {
  env = process.env,
  allowSystem = truthyEnv(env.HERMES_ALLOW_SYSTEM_PYTHON) || truthyEnv(env.HERMES_ALLOW_SYSTEM_HERMES),
  platform = process.platform,
} = {}) {
  const candidates = [];
  const push = (command, args = []) => {
    if (!command) return;
    if (path.isAbsolute(command) && !fs.existsSync(command)) return;
    if (!candidates.some((item) => item.command === command && item.args.join("\0") === args.join("\0"))) {
      candidates.push({ command, args });
    }
  };

  push(env.HERMES_AGENT_PYTHON);
  push(path.join(root, "python", platform === "win32" ? "python.exe" : "bin/python"));
  push(path.join(root, ".venv", platform === "win32" ? "Scripts/python.exe" : "bin/python"));
  push(path.join(root, "venv", platform === "win32" ? "Scripts/python.exe" : "bin/python"));

  if (allowSystem) {
    push("uv", ["run", "--project", root, "python"]);
    push("py", ["-3"]);
    push("python");
    push("python3");
  }
  return candidates;
}

function ensureBridgeScript() {
  const scriptPath = path.join(os.tmpdir(), "gsap-hermes-agent-bridge.py");
  const current = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, "utf-8") : null;
  if (current !== BRIDGE_SCRIPT) {
    fs.writeFileSync(scriptPath, BRIDGE_SCRIPT, "utf-8");
  }
  return scriptPath;
}

function parseHermesResult(stdout = "") {
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reverse()
    .find((entry) => entry.startsWith(RESULT_MARKER));

  if (!line) return null;
  return JSON.parse(line.slice(RESULT_MARKER.length));
}

function sanitizeHermesErrorText(value) {
  return String(value?.message || value?.error || value || "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/((?:api[_-]?key|authorization|bearer)\s*[:=]\s*)["']?[^"',;\s]+/ig, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted-key]")
    .trim();
}

function limitHermesErrorText(value) {
  const text = sanitizeHermesErrorText(value);
  if (text.length <= HERMES_ERROR_DETAIL_MAX_CHARS) return text;
  return `${text.slice(0, HERMES_ERROR_DETAIL_MAX_CHARS - 1)}...`;
}

function containsCjk(text) {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

export function classifyHermesFailure(errorText = "") {
  const text = sanitizeHermesErrorText(errorText);
  const lower = text.toLowerCase();

  if (!lower) {
    return {
      category: "unknown",
      reasonEn: "Hermes returned an empty error",
      reasonZh: "Hermes 返回了空错误",
      tripCircuit: false,
    };
  }

  if (lower.includes("no llm provider configured") || lower.includes("api credentials") || lower.includes("missing api key")) {
    return {
      category: "configuration",
      reasonEn: "Hermes model or API credentials are not configured",
      reasonZh: "Hermes 模型或 API 凭证未配置",
      tripCircuit: false,
    };
  }

  if (lower.includes("runtime not found") || lower.includes("python runtime not found")) {
    return {
      category: "runtime",
      reasonEn: "Hermes runtime is missing or incomplete",
      reasonZh: "Hermes 运行时缺失或不完整",
      tripCircuit: true,
    };
  }

  if (lower.includes("modulenotfounderror") || lower.includes("importerror")) {
    return {
      category: "dependencies",
      reasonEn: "Hermes bundled Python dependencies are incomplete",
      reasonZh: "Hermes 内置 Python 依赖不完整",
      tripCircuit: true,
    };
  }

  if (
    lower.includes("sandbox")
    || lower.includes("bridge")
    || lower.includes("backend")
    || lower.includes("econnreset")
    || lower.includes("econnrefused")
    || lower.includes("brokenpipe")
    || lower.includes("broken pipe")
  ) {
    return {
      category: "bridge",
      reasonEn: "Hermes bridge or sandbox backend failed",
      reasonZh: "Hermes 桥接或沙箱后端失败",
      tripCircuit: true,
    };
  }

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return {
      category: "timeout",
      reasonEn: "Hermes execution timed out",
      reasonZh: "Hermes 执行超时",
      tripCircuit: true,
    };
  }

  if (lower.includes("spawn") || lower.includes("enoent") || lower.includes("eacces") || lower.includes("permissionerror")) {
    return {
      category: "launcher",
      reasonEn: "Hermes launcher could not start",
      reasonZh: "Hermes 启动器无法启动",
      tripCircuit: true,
    };
  }

  return {
    category: "unknown",
    reasonEn: "Hermes returned an error",
    reasonZh: "Hermes 返回了错误",
    tripCircuit: false,
  };
}

function getOpenHermesCircuit(now = Date.now()) {
  if (hermesUnavailableUntil <= now) return null;
  return {
    reason: hermesUnavailableReason || "Hermes Agent is temporarily unavailable",
    retryAfterMs: hermesUnavailableUntil - now,
  };
}

function tripHermesCircuit(reason, now = Date.now()) {
  hermesUnavailableReason = sanitizeHermesErrorText(reason) || "Hermes Agent is temporarily unavailable";
  hermesUnavailableUntil = now + HERMES_UNAVAILABLE_COOLDOWN_MS;
}

function throwHermesFailure(message) {
  const failure = classifyHermesFailure(message);
  if (failure.tripCircuit) tripHermesCircuit(message);
  throw new Error(message);
}

function uniqueStrings(values) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function resolveHermesWorkingDirectory(cwd = null) {
  const candidates = [
    cwd,
    process.env.TERMINAL_CWD,
    process.env.GSAP_WORKSPACE,
    process.env.GSAP_ROOT,
    process.env.GSAP_ROOT,
    process.cwd(),
  ];
  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (!text) continue;
    try {
      const resolved = path.resolve(text);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        return resolved;
      }
    } catch {
      // Ignore invalid candidate paths.
    }
  }
  return process.cwd();
}

export function buildHermesLaunchPayload(payload = {}) {
  const enabledToolsets = uniqueStrings(payload.enabled_toolsets);
  return {
    ...payload,
    cwd: resolveHermesWorkingDirectory(payload.cwd),
    enabled_toolsets: enabledToolsets.length > 0
      ? enabledToolsets
      : [...DEFAULT_HERMES_ENABLED_TOOLSETS],
    disabled_toolsets: uniqueStrings(payload.disabled_toolsets),
  };
}

export function resetHermesUnavailableStateForTests() {
  hermesUnavailableUntil = 0;
  hermesUnavailableReason = "";
}

export function buildHermesUnavailableResult(error, { prompt = "", result = null } = {}) {
  const rawError = limitHermesErrorText(error);
  const failure = classifyHermesFailure(rawError);
  const useZh = containsCjk(prompt);
  const reason = useZh ? failure.reasonZh : failure.reasonEn;
  const retryAfterMs = getOpenHermesCircuit()?.retryAfterMs || 0;
  const detail = rawError || (useZh ? "无底层错误信息" : "No lower-level error was reported");
  const safeResult = result && typeof result === "object" ? { ...result } : {};
  if (safeResult.error) safeResult.error = limitHermesErrorText(safeResult.error);
  if (safeResult.traceback) safeResult.traceback = limitHermesErrorText(safeResult.traceback);
  const text = useZh
    ? [
      `Hermes Agent 当前不可用：${reason}。`,
      "本次请求请不要继续调用 hermes_agent；请改用普通对话和本地工具继续处理，除非用户明确要求在修复后重试。",
      `底层错误：${detail}`,
    ].join("\n")
    : [
      `Hermes Agent is unavailable: ${reason}.`,
      "Continue this request without Hermes; do not call hermes_agent again unless the user explicitly asks to retry after the runtime is fixed.",
      `Details: ${detail}`,
    ].join("\n");

  return {
    content: [{ type: "text", text }],
    details: {
      ...safeResult,
      unavailable: true,
      category: failure.category,
      error: rawError,
      retry_after_ms: retryAfterMs,
    },
  };
}

async function executeHermesAgent(payload) {
  const openCircuit = getOpenHermesCircuit();
  if (openCircuit) {
    return {
      final_response: "",
      completed: false,
      error: openCircuit.reason,
      unavailable: true,
      circuit_open: true,
      retry_after_ms: openCircuit.retryAfterMs,
    };
  }

  const hermesRoot = resolveHermesRoot();
  if (!hermesRoot) {
    throwHermesFailure(
      "Hermes Agent runtime not found. Rebuild the bundled server so resources/server/hermes-agent-runtime is included, "
      + "or set HERMES_AGENT_ROOT to a directory containing run_agent.py.",
    );
  }

  const launchPayload = buildHermesLaunchPayload(payload);
  const payloadBase64 = Buffer.from(JSON.stringify(launchPayload), "utf-8").toString("base64");
  const scriptPath = ensureBridgeScript();
  const candidates = resolveHermesPythonCandidates(hermesRoot);
  if (candidates.length === 0) {
    throwHermesFailure(
      "Hermes Agent Python runtime not found. Rebuild the server package so "
      + "hermes-agent-runtime/python or hermes-agent-runtime/.venv is bundled.",
    );
  }
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const { stdout, stderr } = await execFileAsync(
        candidate.command,
        [...candidate.args, scriptPath, hermesRoot, payloadBase64],
        {
          cwd: hermesRoot,
          env: buildHermesEnv(launchPayload, hermesRoot),
          timeout: DEFAULT_TIMEOUT_MS,
          maxBuffer: 20 * 1024 * 1024,
          windowsHide: true,
        },
      );

      const parsed = parseHermesResult(stdout);
      if (parsed) return parsed;

      const tail = [stdout, stderr].filter(Boolean).join("\n").trim();
      throw new Error(tail || `Hermes Agent returned no structured result via ${candidate.command}`);
    } catch (err) {
      lastError = err;
    }
  }

  throwHermesFailure(lastError?.message || "Failed to execute Hermes Agent");
}

export function buildHermesEnv(payload, hermesRoot) {
  const env = {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const pathSegments = String(env[pathKey] || env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  const prependPath = (dirPath) => {
    if (!dirPath || !fs.existsSync(dirPath)) return;
    const resolved = path.resolve(dirPath);
    const lower = resolved.toLowerCase();
    if (!pathSegments.some((item) => path.resolve(item).toLowerCase() === lower)) {
      pathSegments.unshift(resolved);
    }
  };

  const portablePythonRoot = path.join(hermesRoot, "python");
  const portablePython = process.platform === "win32"
    ? path.join(portablePythonRoot, "python.exe")
    : path.join(portablePythonRoot, "bin", "python");
  if (fs.existsSync(portablePython)) {
    env.PYTHONHOME = portablePythonRoot;
    prependPath(portablePythonRoot);
    prependPath(path.join(portablePythonRoot, "DLLs"));
    prependPath(path.join(portablePythonRoot, "bin"));
  }

  prependPath(process.platform === "win32"
    ? path.join(hermesRoot, ".venv", "Scripts")
    : path.join(hermesRoot, ".venv", "bin"));

  if (process.resourcesPath) {
    prependPath(path.join(process.resourcesPath, "git", "cmd"));
    prependPath(path.join(process.resourcesPath, "git", "mingw64", "bin"));
    prependPath(path.join(process.resourcesPath, "git", "bin"));
    prependPath(path.join(process.resourcesPath, "git", "usr", "bin"));
  }
  prependPath(path.join(process.cwd(), "vendor", "git-portable", "cmd"));
  prependPath(path.join(process.cwd(), "vendor", "git-portable", "mingw64", "bin"));
  prependPath(path.join(process.cwd(), "vendor", "git-portable", "bin"));
  prependPath(path.join(process.cwd(), "vendor", "git-portable", "usr", "bin"));

  const sitePackages = getHermesSitePackages(hermesRoot);
  const pythonPathSegments = [
    hermesRoot,
    ...sitePackages,
    ...String(env.PYTHONPATH || "").split(path.delimiter).filter(Boolean),
  ];
  env.PYTHONPATH = [...new Set(pythonPathSegments)].join(path.delimiter);

  if (pathKey !== "PATH") delete env[pathKey];
  env.PATH = pathSegments.join(path.delimiter);

  const providerKey = normalizeHermesProvider(payload?.provider);
  const mapping = PROVIDER_ENV_MAP[providerKey];
  const apiKey = String(payload?.api_key || "").trim();
  const baseUrl = String(payload?.base_url || "").trim();

  if (mapping?.key && apiKey) {
    env[mapping.key] = apiKey;
  }
  if (mapping?.base && baseUrl) {
    env[mapping.base] = baseUrl;
  }

  if (baseUrl) {
    env.OPENAI_BASE_URL = env.OPENAI_BASE_URL || baseUrl;
  }
  if (apiKey) {
    env.OPENAI_API_KEY = env.OPENAI_API_KEY || apiKey;
  }

  const gsapHome = String(process.env.GSAP_HOME || "").trim();
  const explicitHermesHome = String(payload?.hermes_home || "").trim();
  const hermesHome = explicitHermesHome || (gsapHome ? path.join(gsapHome, DEFAULT_HERMES_HOME_SUBDIR) : "");
  if (hermesHome) {
    env.HERMES_HOME = hermesHome;
  }

  const bundledOptionalSkills = path.join(hermesRoot, "optional-skills");
  if (fs.existsSync(bundledOptionalSkills) && !env.HERMES_OPTIONAL_SKILLS) {
    env.HERMES_OPTIONAL_SKILLS = bundledOptionalSkills;
  }

  if (process.platform === "win32") {
    env.TERMINAL_ENV = "local";
    env.TERMINAL_CWD = resolveHermesWorkingDirectory(payload?.cwd);
    env.TERMINAL_LOCAL_PERSISTENT = env.TERMINAL_LOCAL_PERSISTENT || "true";
    env.TERMINAL_TIMEOUT = env.TERMINAL_TIMEOUT || "180";

    const gitBashPath = resolveHermesGitBashPath();
    if (gitBashPath) {
      env.HERMES_GIT_BASH_PATH = gitBashPath;
    }
  } else if (payload?.cwd) {
    env.TERMINAL_CWD = resolveHermesWorkingDirectory(payload.cwd);
  }

  return env;
}

function buildHermesSystemPrompt(systemPrompt) {
  const base = String(systemPrompt || "").trim();
  const platformNotes = [];
  if (process.platform === "win32") {
    platformNotes.push(
      "You are running inside G-SAP on native Windows.",
      "Treat local drives such as C:\\ and D:\\ as directly accessible unless a tool proves otherwise.",
      "When shell access is needed on Windows, prefer PowerShell and UTF-8-friendly commands.",
      "Do not ask whether the user is in WSL or a VM unless a tool call actually fails and you have concrete evidence.",
    );
  }
  const note = platformNotes.join(" ");
  if (!note) return base || null;
  return [base, note].filter(Boolean).join("\n\n");
}

export function createHermesAgentTool({ resolveDefaultModel, resolveCwd } = {}) {
  return {
    name: "hermes_agent",
    label: "Hermes Agent",
    description: "Only use this tool when the user explicitly asks for Hermes, invokes /hermes, or explicitly asks you to delegate work to an external agent. Do not use this tool by default. Do not use Hermes just because a task is complex. Hand off the requested task to the external Hermes Agent and return its final reply.",
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "Primary task to hand off to Hermes Agent. Prefer this field in new calls." })),
      prompt: Type.Optional(Type.String({ description: "Legacy alias of task. Task or question to send to Hermes Agent." })),
      instructions: Type.Optional(Type.String({ description: "Optional extra guidance for Hermes. Alias of system_prompt." })),
      system_prompt: Type.Optional(Type.String({ description: "Optional temporary system prompt for Hermes." })),
      model: Type.Optional(Type.String({ description: "Optional Hermes model override." })),
      base_url: Type.Optional(Type.String({ description: "Optional API base URL override for Hermes." })),
      api_key: Type.Optional(Type.String({ description: "Optional API key override for Hermes." })),
      provider: Type.Optional(Type.String({ description: "Optional provider override for Hermes." })),
      api_mode: Type.Optional(Type.String({ description: "Optional Hermes API mode override." })),
      cwd: Type.Optional(Type.String({ description: "Optional working directory for Hermes terminal and file tools." })),
      max_iterations: Type.Optional(Type.Number({ description: "Optional max iteration budget for Hermes.", default: 12 })),
    }),
    execute: async (_toolCallId, params) => {
      const prompt = String(params.task || params.prompt || "").trim();
      if (!prompt) {
        return {
          content: [{ type: "text", text: "Hermes Agent call failed: task or prompt is required." }],
          details: {},
        };
      }

      try {
        const defaultModel = resolveDefaultModel?.() || null;
        const hermesModel = normalizeHermesModel(params.model || defaultModel?.model || null);
        const provider = normalizeHermesProvider(
          params.provider
          || deriveHermesProvider(params.model)
          || deriveHermesProvider(defaultModel?.model, defaultModel?.provider)
          || null,
        );
        const apiMode = normalizeHermesApiMode(params.api_mode || defaultModel?.api || null);
        const systemPrompt = buildHermesSystemPrompt(params.instructions || params.system_prompt || null);
        const result = await executeHermesAgent({
          prompt,
          system_prompt: systemPrompt,
          model: hermesModel || null,
          base_url: params.base_url || defaultModel?.base_url || null,
          api_key: params.api_key || defaultModel?.api_key || null,
          provider: provider || null,
          api_mode: apiMode || null,
          cwd: params.cwd || resolveCwd?.() || null,
          max_iterations: params.max_iterations ?? 12,
        });

        const resultError = sanitizeHermesErrorText(result?.error || "");
        const resultFailed = result?.unavailable || (resultError && !String(result?.final_response || "").trim());
        if (resultFailed) {
          const failure = classifyHermesFailure(resultError);
          if (failure.tripCircuit) tripHermesCircuit(resultError);
          return buildHermesUnavailableResult(resultError, { prompt, result });
        }

        const finalResponse = String(result?.final_response || "").trim();
        if (!finalResponse) {
          return {
            content: [{ type: "text", text: "Hermes Agent ran, but returned no final response." }],
            details: result || {},
          };
        }

        return {
          content: [{ type: "text", text: finalResponse }],
          details: result || {},
        };
      } catch (err) {
        return buildHermesUnavailableResult(err, { prompt });
      }
    },
  };
}
