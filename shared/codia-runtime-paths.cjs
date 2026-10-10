const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_CODIA_HOME = path.join(os.homedir(), ".codia");
const DEFAULT_CODIA_DEV_HOME = path.join(os.homedir(), ".codia-dev");
const PI_SDK_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function expandHome(input, homeDir = os.homedir()) {
  if (!input) return input;
  if (input === "~") return homeDir;
  if (input.startsWith("~/") || input.startsWith("~" + path.sep)) {
    return path.join(homeDir, input.slice(2));
  }
  return input;
}

function resolveHomePath(value, homeDir = os.homedir()) {
  return path.resolve(expandHome(String(value || ""), homeDir));
}

function normalizeServerInfoScope(scope) {
  const text = String(scope || "").trim().toLowerCase();
  return /^[a-z0-9_-]+$/.test(text) ? text : "";
}

function serverInfoFileNameForScope(scope) {
  const normalized = normalizeServerInfoScope(scope);
  return normalized ? `server-info.${normalized}.json` : "server-info.json";
}

function resolveServerInfoPath(codiaHome, env = process.env, defaultScope = "") {
  if (!codiaHome || typeof codiaHome !== "string") {
    throw new Error("resolveServerInfoPath: codiaHome is required");
  }
  const configured = env?.CODIA_SERVER_INFO;
  if (configured) return resolveHomePath(configured);
  return path.join(codiaHome, serverInfoFileNameForScope(env?.CODIA_SERVER_SCOPE || defaultScope));
}

function resolveCodiaHome(inputOrEnv = process.env, homeDir = os.homedir()) {
  if (typeof inputOrEnv === "string") {
    return resolveHomePath(inputOrEnv, homeDir);
  }
  const env = inputOrEnv || {};
  const configured = env.CODIA_HOME;
  if (configured) return resolveHomePath(configured, homeDir);

  const codiaHome = path.join(homeDir, ".codia");
  if (fs.existsSync(codiaHome)) return codiaHome;
  return codiaHome;
}

function applyCodiaHomeEnv(home, env = process.env) {
  env.CODIA_HOME = home;
}

function resolveCodiaPiRoot(codiaHome) {
  if (!codiaHome || typeof codiaHome !== "string") {
    throw new Error("resolveCodiaPiRoot: codiaHome is required");
  }
  return path.join(codiaHome, ".pi");
}

function resolveCodiaPiAgentDir(codiaHome) {
  return path.join(resolveCodiaPiRoot(codiaHome), "agent");
}

function resolveCodiaPiProjectDir(codiaHome) {
  return path.join(resolveCodiaPiRoot(codiaHome), "project");
}

function withCodiaPiSdkEnv(env, codiaHome) {
  return {
    ...env,
    [PI_SDK_AGENT_DIR_ENV]: resolveCodiaPiAgentDir(codiaHome),
  };
}

function ensureCodiaPiSdkDirs(codiaHome) {
  fs.mkdirSync(resolveCodiaPiAgentDir(codiaHome), { recursive: true });
  fs.mkdirSync(resolveCodiaPiProjectDir(codiaHome), { recursive: true });
}

function configureProcessPiSdkEnv(codiaHome, env = process.env) {
  const agentDir = resolveCodiaPiAgentDir(codiaHome);
  env[PI_SDK_AGENT_DIR_ENV] = agentDir;
  return agentDir;
}

module.exports = {
  DEFAULT_CODIA_HOME,
  DEFAULT_CODIA_DEV_HOME,
  PI_SDK_AGENT_DIR_ENV,
  applyCodiaHomeEnv,
  configureProcessPiSdkEnv,
  ensureCodiaPiSdkDirs,
  normalizeServerInfoScope,
  resolveCodiaHome,
  resolveCodiaPiAgentDir,
  resolveCodiaPiProjectDir,
  resolveCodiaPiRoot,
  resolveServerInfoPath,
  serverInfoFileNameForScope,
  withCodiaPiSdkEnv,
};
