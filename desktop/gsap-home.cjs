const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_GSAP_HOME = path.join(os.homedir(), ".gsap");
const DEFAULT_LEGACY_HANAKO_HOME = path.join(os.homedir(), ".hanako");
const PI_SDK_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const LEGACY_HOME_ENV = "GSAP_USE_LEGACY_HANAKO_HOME";

function resolveHomePath(value) {
  return path.resolve(String(value || "").replace(/^~/, os.homedir()));
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
  const configured = env.GSAP_SERVER_INFO;
  if (configured) return resolveHomePath(configured);
  return path.join(gsapHome, serverInfoFileNameForScope(env.GSAP_SERVER_SCOPE || defaultScope));
}

function resolveGsapHome(env = process.env) {
  const configured = env.GSAP_HOME || env.HANA_HOME;
  if (configured) return resolveHomePath(configured);
  if (fs.existsSync(DEFAULT_GSAP_HOME)) return DEFAULT_GSAP_HOME;
  if (env[LEGACY_HOME_ENV] === "1" && fs.existsSync(DEFAULT_LEGACY_HANAKO_HOME)) return DEFAULT_LEGACY_HANAKO_HOME;
  return DEFAULT_GSAP_HOME;
}

function applyGsapHomeEnv(home, env = process.env) {
  env.GSAP_HOME = home;
  env.HANA_HOME = home;
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
  DEFAULT_LEGACY_HANAKO_HOME,
  LEGACY_HOME_ENV,
  PI_SDK_AGENT_DIR_ENV,
  configureProcessPiSdkEnv,
  ensureGsapPiSdkDirs,
  normalizeServerInfoScope,
  resolveGsapHome,
  resolveGsapPiAgentDir,
  resolveGsapPiProjectDir,
  resolveGsapPiRoot,
  resolveServerInfoPath,
  serverInfoFileNameForScope,
  applyGsapHomeEnv,
  withGsapPiSdkEnv,
};
