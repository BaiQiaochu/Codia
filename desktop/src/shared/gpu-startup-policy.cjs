const fs = require("fs");
const path = require("path");

const STATE_VERSION = 2;
const STATE_FILE = path.join("user", "gpu-startup.json");
const PREFERENCES_FILE = path.join("user", "preferences.json");
const GPU_MODE_HARDWARE = "hardware";
const GPU_MODE_GPU_SANDBOX_COMPAT = "gpu-sandbox-compat";
const GPU_MODE_SOFTWARE_SAFE = "software-safe";
const GPU_MODE_DEEP_COMPAT = "deep-compat";
const GPU_MODE_DIAGNOSTIC_FAILED = "diagnostic-failed";
const GPU_SANDBOX_COMPAT_DISABLE_FEATURES = ["GpuSandbox"];
const GPU_RECOVERY_STARTUP_PHASES = new Set([
  "electron-starting",
  "launching-splash",
  "splash-ready",
  "main-window-starting",
  "main-window-created",
  "onboarding-window-starting",
  "onboarding-window-created",
]);
const NON_GPU_STARTUP_PHASES = new Set([
  "server-starting",
  "server-ready",
]);
const LEGACY_AUTO_SAFE_MODE_REASONS = new Set([
  "previous-startup-incomplete",
]);
const GPU_FAILURE_REASONS = new Set([
  "abnormal-exit",
  "crashed",
  "integrity-failure",
  "launch-failed",
  "oom",
]);

function nowIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && now) return now;
  return new Date().toISOString();
}

function resolveHome(opts = {}) {
  return opts.codiaHome || opts.codiaHome || null;
}

function readJson(filePath, fallback = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function getGpuStartupStatePath(codiaHome) {
  return path.join(codiaHome, STATE_FILE);
}

function getPreferencesPath(codiaHome) {
  return path.join(codiaHome, PREFERENCES_FILE);
}

function readState(codiaHome) {
  return readJson(getGpuStartupStatePath(codiaHome), { version: STATE_VERSION });
}

function writeState(codiaHome, state) {
  writeJson(getGpuStartupStatePath(codiaHome), {
    ...state,
    version: STATE_VERSION,
  });
}

function readPreferences(codiaHome) {
  return readJson(getPreferencesPath(codiaHome), {});
}

function writePreferences(codiaHome, prefs) {
  writeJson(getPreferencesPath(codiaHome), prefs);
}

function boolFromSetting(value, defaultValue) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "off", "no", "disabled"].includes(normalized)) return false;
    if (["true", "1", "on", "yes", "enabled"].includes(normalized)) return true;
  }
  return defaultValue;
}

function hasArg(argv, name) {
  const prefix = `--${name}`;
  return (argv || []).some((arg) => arg === prefix || String(arg).startsWith(`${prefix}=`));
}

function isExplicitSafeMode(argv, env) {
  if (boolFromSetting(env?.CODIA_GPU_SAFE_MODE, false)) return true;
  if (boolFromSetting(env?.CODIA_DISABLE_HARDWARE_ACCELERATION, false)) return true;
  if (boolFromSetting(env?.CODIA_GPU_SAFE_MODE, false)) return true;
  if (boolFromSetting(env?.CODIA_DISABLE_HARDWARE_ACCELERATION, false)) return true;
  return hasArg(argv, "codia-gpu-safe-mode")
    || hasArg(argv, "codia-disable-hardware-acceleration")
    || hasArg(argv, "codia-gpu-safe-mode")
    || hasArg(argv, "codia-disable-hardware-acceleration");
}

function isExplicitGpuSandboxCompatibility(argv, env) {
  if (boolFromSetting(env?.CODIA_GPU_SANDBOX_COMPAT, false)) return true;
  return hasArg(argv, "codia-gpu-sandbox-compat")
    || hasArg(argv, "codia-gpu-sandbox-compat");
}

function isExplicitUnsafeNoSandbox(argv, env) {
  if (boolFromSetting(env?.CODIA_GPU_UNSAFE_NO_SANDBOX, false)) return true;
  return hasArg(argv, "codia-gpu-unsafe-no-sandbox")
    || hasArg(argv, "codia-gpu-unsafe-no-sandbox");
}

function policyForMode(mode, reason, extra = {}) {
  const normalizedMode = mode || GPU_MODE_HARDWARE;
  const shouldDisableHardwareAcceleration =
    normalizedMode === GPU_MODE_SOFTWARE_SAFE
    || normalizedMode === GPU_MODE_DEEP_COMPAT
    || normalizedMode === GPU_MODE_DIAGNOSTIC_FAILED;
  return {
    mode: normalizedMode,
    hardwareAccelerationEnabled: !shouldDisableHardwareAcceleration,
    shouldDisableHardwareAcceleration,
    shouldApplyGpuSandboxCompatSwitches: normalizedMode === GPU_MODE_GPU_SANDBOX_COMPAT,
    shouldApplyDeepCompatSwitches:
      normalizedMode === GPU_MODE_DEEP_COMPAT || normalizedMode === GPU_MODE_DIAGNOSTIC_FAILED,
    shouldApplyUnsafeNoSandboxSwitch: false,
    reason: reason || "default",
    ...extra,
  };
}

function summarizeGpuStartupPolicy(policy) {
  if (!policy || typeof policy !== "object") return null;
  return {
    mode: policy.mode || GPU_MODE_HARDWARE,
    reason: policy.reason || "unknown",
    hardwareAccelerationEnabled: policy.hardwareAccelerationEnabled !== false,
    shouldDisableHardwareAcceleration: policy.shouldDisableHardwareAcceleration === true,
    shouldApplyGpuSandboxCompatSwitches: policy.shouldApplyGpuSandboxCompatSwitches === true,
    shouldApplyDeepCompatSwitches: policy.shouldApplyDeepCompatSwitches === true,
    shouldApplyUnsafeNoSandboxSwitch: policy.shouldApplyUnsafeNoSandboxSwitch === true,
  };
}

function writeAutoGpuMode(codiaHome, mode, {
  reason,
  previousMode,
  previousStartup,
  now,
} = {}) {
  const timestamp = nowIso(now);
  const state = readState(codiaHome);
  writeState(codiaHome, {
    ...state,
    autoGpuMode: {
      mode,
      reason: reason || "unknown",
      previousMode: previousMode || null,
      previousStartup: previousStartup || null,
      updatedAt: timestamp,
    },
  });
}

function migrateLegacyAutoSafeModePreference(codiaHome, prefs, state, now) {
  if (prefs?.hardware_acceleration !== false) return null;
  const safeMode = state?.safeMode;
  if (!safeMode?.enabled) return null;
  if (!LEGACY_AUTO_SAFE_MODE_REASONS.has(safeMode.reason || "")) return null;

  const nextPrefs = { ...prefs };
  delete nextPrefs.hardware_acceleration;
  writePreferences(codiaHome, nextPrefs);
  writeAutoGpuMode(codiaHome, GPU_MODE_GPU_SANDBOX_COMPAT, {
    reason: "legacy-auto-safe-mode-migration",
    previousMode: GPU_MODE_SOFTWARE_SAFE,
    previousStartup: safeMode.previousStartup || null,
    now,
  });
  return policyForMode(GPU_MODE_GPU_SANDBOX_COMPAT, "legacy-auto-safe-mode-migration", {
    autoGpuMode: {
      mode: GPU_MODE_GPU_SANDBOX_COMPAT,
      reason: "legacy-auto-safe-mode-migration",
      previousMode: GPU_MODE_SOFTWARE_SAFE,
      previousStartup: safeMode.previousStartup || null,
      updatedAt: nowIso(now),
    },
  });
}

function resolveStoredAutoGpuMode(state) {
  const mode = state?.autoGpuMode?.mode;
  if (
    mode === GPU_MODE_GPU_SANDBOX_COMPAT
    || mode === GPU_MODE_SOFTWARE_SAFE
    || mode === GPU_MODE_DEEP_COMPAT
    || mode === GPU_MODE_DIAGNOSTIC_FAILED
  ) {
    return state.autoGpuMode;
  }
  if (state?.safeMode?.enabled) {
    return {
      mode: GPU_MODE_SOFTWARE_SAFE,
      reason: state.safeMode.reason || "legacy-safe-mode",
      previousMode: null,
      previousStartup: state.safeMode.previousStartup || null,
      updatedAt: state.safeMode.updatedAt || null,
    };
  }
  return null;
}

function currentPolicyMode(policy, prefs) {
  if (policy?.mode) return policy.mode;
  if (policy?.shouldApplyGpuSandboxCompatSwitches) return GPU_MODE_GPU_SANDBOX_COMPAT;
  if (policy?.shouldApplyDeepCompatSwitches) return GPU_MODE_DEEP_COMPAT;
  if (policy?.shouldDisableHardwareAcceleration) return GPU_MODE_SOFTWARE_SAFE;
  if (!boolFromSetting(prefs?.hardware_acceleration, true)) return GPU_MODE_SOFTWARE_SAFE;
  return GPU_MODE_HARDWARE;
}

function nextModeAfterGpuFailure(mode) {
  if (mode === GPU_MODE_DEEP_COMPAT || mode === GPU_MODE_DIAGNOSTIC_FAILED) {
    return GPU_MODE_DIAGNOSTIC_FAILED;
  }
  if (mode === GPU_MODE_GPU_SANDBOX_COMPAT) return GPU_MODE_SOFTWARE_SAFE;
  if (mode === GPU_MODE_SOFTWARE_SAFE) return GPU_MODE_DEEP_COMPAT;
  return GPU_MODE_GPU_SANDBOX_COMPAT;
}

function startupPolicyMode(startup, autoMode, fallbackMode = GPU_MODE_HARDWARE) {
  const mode = startup?.policy?.mode;
  if (
    mode === GPU_MODE_HARDWARE
    || mode === GPU_MODE_GPU_SANDBOX_COMPAT
    || mode === GPU_MODE_SOFTWARE_SAFE
    || mode === GPU_MODE_DEEP_COMPAT
    || mode === GPU_MODE_DIAGNOSTIC_FAILED
  ) {
    return mode;
  }
  if (autoMode?.mode) return autoMode.mode;
  return fallbackMode;
}

function normalizeGpuRecoveryState(value) {
  if (!value || typeof value !== "object" || typeof value.eligible !== "boolean") return null;
  return {
    eligible: value.eligible === true,
    phase: typeof value.phase === "string" ? value.phase : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

function buildGpuRecoveryState(phase, previousGpuRecovery, timestamp) {
  const previous = normalizeGpuRecoveryState(previousGpuRecovery);
  if (GPU_RECOVERY_STARTUP_PHASES.has(phase)) {
    return {
      eligible: true,
      phase,
      updatedAt: timestamp,
    };
  }
  if (NON_GPU_STARTUP_PHASES.has(phase)) {
    if (previous?.eligible && previous.phase && previous.phase !== "electron-starting") {
      return previous;
    }
    return {
      eligible: false,
      phase: null,
      updatedAt: timestamp,
    };
  }
  if (previous?.eligible) return previous;
  return null;
}

function classifyIncompleteStartup(state) {
  const startup = state?.startup;
  if (!startup || startup.status !== "pending") return "none";
  const recovery = normalizeGpuRecoveryState(startup.gpuRecovery);
  if (recovery?.eligible) return "gpu-recovery";
  if (recovery && recovery.eligible === false) return "non-gpu";
  const phase = startup.phase || "electron-starting";
  if (NON_GPU_STARTUP_PHASES.has(phase)) return "non-gpu";
  if (GPU_RECOVERY_STARTUP_PHASES.has(phase)) return "gpu-recovery";
  return "unknown";
}

function isGpuRecoveryIncompleteStartup(state) {
  return classifyIncompleteStartup(state) === "gpu-recovery";
}

function resolveGpuStartupPolicy({
  codiaHome,
  platform = process.platform,
  argv = process.argv,
  env = process.env,
  now,
} = {}) {
  const home = resolveHome({ codiaHome });
  if (!home) throw new Error("resolveGpuStartupPolicy requires codiaHome");

  const prefs = readPreferences(home);
  if (isExplicitSafeMode(argv, env)) {
    return policyForMode(GPU_MODE_SOFTWARE_SAFE, "explicit");
  }
  if (isExplicitUnsafeNoSandbox(argv, env)) {
    return policyForMode(GPU_MODE_GPU_SANDBOX_COMPAT, "explicit-unsafe-no-sandbox", {
      shouldApplyUnsafeNoSandboxSwitch: true,
    });
  }
  if (isExplicitGpuSandboxCompatibility(argv, env)) {
    return policyForMode(GPU_MODE_GPU_SANDBOX_COMPAT, "explicit");
  }

  const state = readState(home);
  const migratedLegacyPolicy = platform === "win32"
    ? migrateLegacyAutoSafeModePreference(home, prefs, state, now)
    : null;
  if (migratedLegacyPolicy) return migratedLegacyPolicy;

  const autoMode = platform === "win32" ? resolveStoredAutoGpuMode(state) : null;
  if (autoMode?.mode === GPU_MODE_DEEP_COMPAT || autoMode?.mode === GPU_MODE_DIAGNOSTIC_FAILED) {
    return policyForMode(autoMode.mode, autoMode.reason || "gpu-child-process-gone", {
      autoGpuMode: autoMode,
    });
  }

  const preferenceEnabled = boolFromSetting(prefs.hardware_acceleration, true);
  if (!preferenceEnabled) {
    return policyForMode(GPU_MODE_SOFTWARE_SAFE, "preference");
  }

  if (platform === "win32" && isGpuRecoveryIncompleteStartup(state)) {
    const fallbackMode = preferenceEnabled ? GPU_MODE_HARDWARE : GPU_MODE_SOFTWARE_SAFE;
    const previousMode = startupPolicyMode(state.startup, autoMode, fallbackMode);
    const nextMode = nextModeAfterGpuFailure(previousMode);
    writeAutoGpuMode(home, nextMode, {
      reason: "previous-startup-incomplete",
      previousMode,
      previousStartup: state.startup,
      now,
    });
    return policyForMode(nextMode, "previous-startup-incomplete");
  }

  if (autoMode?.mode === GPU_MODE_GPU_SANDBOX_COMPAT || autoMode?.mode === GPU_MODE_SOFTWARE_SAFE) {
    return policyForMode(autoMode.mode, autoMode.reason || "gpu-child-process-gone", {
      autoGpuMode: autoMode,
    });
  }

  return policyForMode(GPU_MODE_HARDWARE, "default");
}

function featureList(value) {
  return String(value || "")
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean);
}

function appendMergedFeatureSwitch(app, switchName, features) {
  const commandLine = app?.commandLine;
  if (!commandLine?.appendSwitch) return false;
  let existing = "";
  try {
    if (typeof commandLine.hasSwitch === "function" && commandLine.hasSwitch(switchName)) {
      existing = typeof commandLine.getSwitchValue === "function" ? commandLine.getSwitchValue(switchName) : "";
    }
  } catch {}
  const merged = [];
  const seen = new Set();
  for (const feature of [...featureList(existing), ...features]) {
    if (seen.has(feature)) continue;
    seen.add(feature);
    merged.push(feature);
  }
  commandLine.appendSwitch(switchName, merged.join(","));
  return true;
}

function applyGpuSandboxCompatibilitySwitches(app, policy) {
  const commandLine = app?.commandLine;
  if (!commandLine?.appendSwitch) return { applied: false, unsafeNoSandbox: false };
  commandLine.appendSwitch("disable-gpu-sandbox");
  appendMergedFeatureSwitch(app, "disable-features", GPU_SANDBOX_COMPAT_DISABLE_FEATURES);
  if (policy?.shouldApplyUnsafeNoSandboxSwitch) {
    commandLine.appendSwitch("no-sandbox");
    return { applied: true, unsafeNoSandbox: true };
  }
  return { applied: true, unsafeNoSandbox: false };
}

function applyGpuStartupPolicy(app, policy) {
  const gpuSandboxCompat = policy?.shouldApplyGpuSandboxCompatSwitches
    ? applyGpuSandboxCompatibilitySwitches(app, policy)
    : { applied: false, unsafeNoSandbox: false };
  if (policy?.shouldDisableHardwareAcceleration && typeof app?.disableHardwareAcceleration === "function") {
    app.disableHardwareAcceleration();
    if (policy?.shouldApplyDeepCompatSwitches && app?.commandLine?.appendSwitch) {
      app.commandLine.appendSwitch("disable-gpu");
      app.commandLine.appendSwitch("disable-gpu-compositing");
      app.commandLine.appendSwitch("disable-gpu-rasterization");
      return {
        applied: true,
        deepCompat: true,
        gpuSandboxCompat: gpuSandboxCompat.applied,
        unsafeNoSandbox: gpuSandboxCompat.unsafeNoSandbox,
      };
    }
    return {
      applied: true,
      deepCompat: false,
      gpuSandboxCompat: gpuSandboxCompat.applied,
      unsafeNoSandbox: gpuSandboxCompat.unsafeNoSandbox,
    };
  }
  return {
    applied: gpuSandboxCompat.applied,
    gpuSandboxCompat: gpuSandboxCompat.applied,
    unsafeNoSandbox: gpuSandboxCompat.unsafeNoSandbox,
  };
}

function markGpuStartupPending({
  codiaHome,
  platform = process.platform,
  phase = "electron-starting",
  startupId = `${Date.now()}-${process.pid}`,
  policy = null,
  now,
} = {}) {
  const home = resolveHome({ codiaHome });
  if (!home) throw new Error("markGpuStartupPending requires codiaHome");
  const timestamp = nowIso(now);
  const state = readState(home);
  const gpuRecovery = buildGpuRecoveryState(phase, null, timestamp);
  const next = {
    ...state,
    startup: {
      status: "pending",
      startupId,
      phase,
      platform,
      startedAt: timestamp,
      updatedAt: timestamp,
      ...(policy ? { policy: summarizeGpuStartupPolicy(policy) } : {}),
      ...(gpuRecovery ? { gpuRecovery } : {}),
    },
  };
  writeState(home, next);
  return next.startup;
}

function markGpuStartupPhase({
  codiaHome,
  platform = process.platform,
  phase,
  startupId,
  now,
} = {}) {
  const home = resolveHome({ codiaHome });
  if (!home || !phase) return null;
  const state = readState(home);
  if (!state.startup || state.startup.status !== "pending") return null;
  if (startupId && state.startup.startupId && state.startup.startupId !== startupId) return null;
  const timestamp = nowIso(now);
  const gpuRecovery = buildGpuRecoveryState(phase, state.startup.gpuRecovery, timestamp);
  state.startup = {
    ...state.startup,
    startupId: startupId || state.startup.startupId,
    platform,
    phase,
    updatedAt: timestamp,
  };
  if (gpuRecovery) {
    state.startup.gpuRecovery = gpuRecovery;
  } else {
    delete state.startup.gpuRecovery;
  }
  writeState(home, state);
  return state.startup;
}

function markGpuStartupReady({
  codiaHome,
  platform = process.platform,
  phase = "app-ready",
  startupId,
  now,
} = {}) {
  const home = resolveHome({ codiaHome });
  if (!home) throw new Error("markGpuStartupReady requires codiaHome");
  const state = readState(home);
  const timestamp = nowIso(now);
  state.startup = {
    ...(state.startup || {}),
    status: "ready",
    startupId: startupId || state.startup?.startupId,
    phase,
    platform,
    readyAt: timestamp,
    updatedAt: timestamp,
  };
  writeState(home, state);
  return state.startup;
}

function markGpuStartupFailed({
  codiaHome,
  platform = process.platform,
  reason,
  startupId,
  now,
} = {}) {
  const home = resolveHome({ codiaHome });
  if (!home) throw new Error("markGpuStartupFailed requires codiaHome");
  const state = readState(home);
  const timestamp = nowIso(now);
  state.startup = {
    ...(state.startup || {}),
    status: "failed",
    startupId: startupId || state.startup?.startupId,
    platform,
    reason: reason || "startup-failed",
    failedAt: timestamp,
    updatedAt: timestamp,
  };
  writeState(home, state);
  return state.startup;
}

function sanitizeGpuDetails(details = {}) {
  return {
    type: details.type || "Unknown",
    reason: details.reason || "unknown",
    exitCode: typeof details.exitCode === "number" ? details.exitCode : null,
    serviceName: details.serviceName || "",
    name: details.name || "",
  };
}

function isGpuChildProcessFailure(details = {}) {
  return details.type === "GPU" && GPU_FAILURE_REASONS.has(details.reason || "unknown");
}

function recordGpuChildProcessGone({
  codiaHome,
  platform = process.platform,
  policy = null,
  details,
  now,
} = {}) {
  const home = resolveHome({ codiaHome });
  if (!home || !isGpuChildProcessFailure(details)) return false;
  const timestamp = nowIso(now);
  const crash = {
    ...sanitizeGpuDetails(details),
    platform,
    at: timestamp,
  };
  const state = readState(home);
  const prefs = readPreferences(home);
  const previousMode = currentPolicyMode(policy, prefs);
  const nextMode = nextModeAfterGpuFailure(previousMode);
  writeState(home, {
    ...state,
    autoGpuMode: {
      mode: nextMode,
      reason: "gpu-child-process-gone",
      previousMode,
      updatedAt: timestamp,
    },
    lastGpuCrash: crash,
  });
  return true;
}

function recordGpuInfoUpdate({
  codiaHome,
  platform = process.platform,
  featureStatus,
  now,
} = {}) {
  const home = resolveHome({ codiaHome });
  if (!home || !featureStatus || typeof featureStatus !== "object") return false;
  const state = readState(home);
  writeState(home, {
    ...state,
    lastGpuFeatureStatus: {
      platform,
      at: nowIso(now),
      featureStatus,
    },
  });
  return true;
}

function buildGpuStartupDiagnostics({ codiaHome, policy, app } = {}) {
  const home = resolveHome({ codiaHome });
  const items = [
    "",
    "--- GPU Startup ---",
    `Hardware acceleration preference: ${readPreferences(home).hardware_acceleration ?? "default"}`,
    `Startup policy: ${policy?.reason || "unknown"}`,
    `Startup policy mode: ${policy?.mode || "unknown"}`,
    `GPU sandbox compatibility switches enabled: ${policy?.shouldApplyGpuSandboxCompatSwitches === true}`,
    `Deep compatibility switches enabled: ${policy?.shouldApplyDeepCompatSwitches === true}`,
    `Unsafe no-sandbox diagnostic enabled: ${policy?.shouldApplyUnsafeNoSandboxSwitch === true}`,
    `Hardware acceleration enabled by policy: ${policy?.hardwareAccelerationEnabled !== false}`,
  ];
  try {
    if (app && typeof app.isHardwareAccelerationEnabled === "function") {
      items.push(`Electron hardware acceleration enabled: ${app.isHardwareAccelerationEnabled()}`);
    }
  } catch {}
  try {
    if (app && typeof app.getGPUFeatureStatus === "function") {
      items.push(`GPU feature status: ${JSON.stringify(app.getGPUFeatureStatus())}`);
    }
  } catch {}
  const state = readState(home);
  if (state.startup) items.push(`GPU startup marker: ${JSON.stringify(state.startup)}`);
  if (state.autoGpuMode) items.push(`GPU auto mode: ${JSON.stringify(state.autoGpuMode)}`);
  if (state.safeMode) items.push(`GPU safe mode: ${JSON.stringify(state.safeMode)}`);
  if (state.lastGpuCrash) items.push(`Last GPU crash: ${JSON.stringify(state.lastGpuCrash)}`);
  if (state.lastGpuFeatureStatus) {
    items.push(`Last GPU feature status: ${JSON.stringify(state.lastGpuFeatureStatus)}`);
  }
  return items.join("\n");
}

module.exports = {
  applyGpuStartupPolicy,
  buildGpuStartupDiagnostics,
  getGpuStartupStatePath,
  getPreferencesPath,
  markGpuStartupFailed,
  markGpuStartupPending,
  markGpuStartupPhase,
  markGpuStartupReady,
  recordGpuChildProcessGone,
  recordGpuInfoUpdate,
  resolveGpuStartupPolicy,
};
