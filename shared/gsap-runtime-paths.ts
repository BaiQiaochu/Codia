import runtimePaths from "./gsap-runtime-paths.cjs";

export const {
  DEFAULT_GSAP_HOME,
  DEFAULT_GSAP_DEV_HOME,
  DEFAULT_LEGACY_GSAP_HOME,
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
} = runtimePaths;
