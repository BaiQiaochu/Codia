const fs = require("fs");
const os = require("os");
const path = require("path");

const LEGACY_HOME_BASENAME = `.${["h", "anako"].join("")}`;
const DEFAULT_GSAP_HOME = path.join(os.homedir(), ".gsap");
const DEFAULT_LEGACY_GSAP_HOME = path.join(os.homedir(), LEGACY_HOME_BASENAME);
const DEFAULT_GSAP_DEV_HOME = path.join(os.homedir(), ".gsap-dev");
const PI_SDK_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const LEGACY_HOME_ENV = "GSAP_USE_LEGACY_GSAP_HOME";

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

function resolveServerInfoPath(gsapHome, env = process.env, defaultScope = "") {
  if (!gsapHome || typeof gsapHome !== "string") {
    throw new Error("resolveServerInfoPath: gsapHome is required");
  }
  const configured = env?.GSAP_SERVER_INFO;
  if (configured) return resolveHomePath(configured);
  return path.join(gsapHome, serverInfoFileNameForScope(env?.GSAP_SERVER_SCOPE || defaultScope));
}

function resolveGsapHome(inputOrEnv = process.env, homeDir = os.homedir()) {
  if (typeof inputOrEnv === "string") {
    return resolveHomePath(inputOrEnv, homeDir);
  }
  const env = inputOrEnv || {};
  const configured = env.GSAP_HOME;
  if (configured) return resolveHomePath(configured, homeDir);

  const gsapHome = path.join(homeDir, ".gsap");
  if (fs.existsSync(gsapHome)) return gsapHome;
  if (env[LEGACY_HOME_ENV] === "1") {
    const legacyHome = path.join(homeDir, LEGACY_HOME_BASENAME);
    if (fs.existsSync(legacyHome)) return legacyHome;
  }
  return gsapHome;
}

function applyGsapHomeEnv(home, env = process.env) {
  env.GSAP_HOME = home;
}

function resolveGsapPiRoot(gsapHome) {
  if (!gsapHome || typeof gsapHome !== "string") {
    throw new Error("resolveGsapPiRoot: gsapHome is required");
  }
  return path.join(gsapHome, ".pi");
}

function resolveGsapPiAgentDir(gsapHome) {
  return path.join(resolveGsapPiRoot(gsapHome), "agent");
}

function resolveGsapPiProjectDir(gsapHome) {
  return path.join(resolveGsapPiRoot(gsapHome), "project");
}

function withGsapPiSdkEnv(env, gsapHome) {
  return {
    ...env,
    [PI_SDK_AGENT_DIR_ENV]: resolveGsapPiAgentDir(gsapHome),
  };
}

function ensureGsapPiSdkDirs(gsapHome) {
  fs.mkdirSync(resolveGsapPiAgentDir(gsapHome), { recursive: true });
  fs.mkdirSync(resolveGsapPiProjectDir(gsapHome), { recursive: true });
}

function configureProcessPiSdkEnv(gsapHome, env = process.env) {
  const agentDir = resolveGsapPiAgentDir(gsapHome);
  env[PI_SDK_AGENT_DIR_ENV] = agentDir;
  return agentDir;
}

module.exports = {
  DEFAULT_GSAP_HOME,
  DEFAULT_GSAP_DEV_HOME,
  DEFAULT_LEGACY_GSAP_HOME,
  LEGACY_HOME_ENV,
  PI_SDK_AGENT_DIR_ENV,
  applyGsapHomeEnv,
  configureProcessPiSdkEnv,
  ensureGsapPiSdkDirs,
  normalizeServerInfoScope,
  resolveGsapHome,
  resolveGsapPiAgentDir,
  resolveGsapPiProjectDir,
  resolveGsapPiRoot,
  resolveServerInfoPath,
  serverInfoFileNameForScope,
  withGsapPiSdkEnv,
};
