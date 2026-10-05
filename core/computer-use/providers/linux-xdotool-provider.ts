// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { COMPUTER_USE_ERRORS, computerUseError } from "../errors.ts";
import { createCommandRunner } from "./command-runner.ts";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const LINUX_XDOTOOL_ALLOWED_ACTIONS = [
  "click_element",
  "type_text",
  "press_key",
  "scroll",
  "perform_secondary_action",
  "stop",
];

const GRID_ROWS = [
  ["top", 0],
  ["middle", 1],
  ["bottom", 2],
];
const GRID_COLS = [
  ["left", 0],
  ["center", 1],
  ["right", 2],
];

function parseWindowId(value) {
  const raw = String(value || "").trim();
  const match = /^(?:window:)?(0x[0-9a-f]+|\d+)$/i.exec(raw);
  return match ? match[1] : null;
}

function parsePidAppId(appId) {
  const match = /^pid:(\d+)$/.exec(String(appId || ""));
  return match ? Number(match[1]) : null;
}

function normalizeTarget(target = {}) {
  const windowId = parseWindowId(target.windowId) || parseWindowId(target.appId);
  const processId = target.processId ?? target.pid ?? parsePidAppId(target.appId);
  return {
    appId: windowId ? `window:${windowId}` : (target.appId || (processId ? `pid:${processId}` : null)),
    appName: target.name || target.appName || null,
    processId: processId != null ? Number(processId) : null,
    windowId,
  };
}

function parseShellAssignments(stdout = "") {
  const out = {};
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    out[match[1]] = match[2];
  }
  return out;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseGeometry(stdout = "") {
  const data = parseShellAssignments(stdout);
  return {
    x: toNumber(data.X),
    y: toNumber(data.Y),
    width: toNumber(data.WIDTH),
    height: toNumber(data.HEIGHT),
    screen: toNumber(data.SCREEN),
  };
}

function parseDisplayGeometry(stdout = "") {
  const [width, height] = String(stdout || "").trim().split(/\s+/).map((v) => Number(v));
  return {
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
    scaleFactor: 1,
    x: 0,
    y: 0,
  };
}

function cleanTitle(value, fallback) {
  const title = String(value || "").replace(/[\r\n\t]+/g, " ").trim();
  return title || fallback;
}

function centerOf(bounds = {}) {
  return {
    x: Math.round(toNumber(bounds.x) + toNumber(bounds.width) / 2),
    y: Math.round(toNumber(bounds.y) + toNumber(bounds.height) / 2),
  };
}

function clampRepeat(amount) {
  const n = Math.max(1, Math.min(20, Math.round(Number(amount) || 3)));
  return String(n);
}

function scrollButton(direction) {
  switch (direction) {
    case "up": return "4";
    case "left": return "6";
    case "right": return "7";
    case "down":
    default: return "5";
  }
}

function buildSyntheticElements(windowId, title, bounds) {
  const windowBounds = {
    x: toNumber(bounds.x),
    y: toNumber(bounds.y),
    width: Math.max(1, toNumber(bounds.width, 1)),
    height: Math.max(1, toNumber(bounds.height, 1)),
  };
  const elements = [{
    elementId: `window:${windowId}`,
    role: "window",
    label: title,
    bounds: windowBounds,
    enabled: true,
  }];

  const cellWidth = windowBounds.width / 3;
  const cellHeight = windowBounds.height / 3;
  for (const [rowName, row] of GRID_ROWS) {
    for (const [colName, col] of GRID_COLS) {
      elements.push({
        elementId: `grid:${rowName}-${colName}`,
        role: "region",
        label: `${title} ${rowName} ${colName}`,
        bounds: {
          x: Math.round(windowBounds.x + col * cellWidth),
          y: Math.round(windowBounds.y + row * cellHeight),
          width: Math.max(1, Math.round(cellWidth)),
          height: Math.max(1, Math.round(cellHeight)),
        },
        enabled: true,
      });
    }
  }
  return elements;
}

function providerError(providerId, message, details = {}) {
  return computerUseError(COMPUTER_USE_ERRORS.PROVIDER_CRASHED, message, {
    providerId,
    ...details,
  });
}

async function commandAvailable(runner, name, { env, timeoutMs }) {
  try {
    const result = await runner.run("bash", [
      "-lc",
      "command -v \"$1\" >/dev/null 2>&1",
      "bash",
      name,
    ], { env, timeoutMs });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export function createLinuxXdotoolProvider({
  providerId = "linux:xdotool",
  platform = process.platform,
  env = process.env,
  runner = createCommandRunner(),
  timeoutMs = 30000,
  screenshotTimeoutMs = 15000,
} = {}) {
  async function run(command, args = [], options = {}) {
    const result = await runner.run(command, args, {
      env,
      timeoutMs: options.timeoutMs || timeoutMs,
    });
    const allowedExitCodes = options.allowedExitCodes || [0];
    if (!allowedExitCodes.includes(result.exitCode)) {
      throw providerError(
        providerId,
        result.stderr?.trim() || `${command} exited with code ${result.exitCode}`,
        { command, exitCode: result.exitCode },
      );
    }
    return result;
  }

  async function ensureLinux() {
    if (platform !== "linux") {
      throw computerUseError(COMPUTER_USE_ERRORS.PROVIDER_UNAVAILABLE, "Linux xdotool provider is available only on Linux.", {
        providerId,
        platform,
      });
    }
    if (!env.DISPLAY) {
      throw computerUseError(COMPUTER_USE_ERRORS.PROVIDER_UNAVAILABLE, "Linux xdotool provider requires an X11 DISPLAY.", {
        providerId,
        display: env.DISPLAY || null,
        waylandDisplay: env.WAYLAND_DISPLAY || null,
      });
    }
  }

  async function ensureWindowActive(windowId) {
    await run("xdotool", ["windowactivate", "--sync", String(windowId)]);
  }

  async function getWindowGeometry(windowId) {
    const result = await run("xdotool", ["getwindowgeometry", "--shell", String(windowId)]);
    return parseGeometry(result.stdout);
  }

  async function getWindowName(windowId) {
    const result = await run("xdotool", ["getwindowname", String(windowId)], { allowedExitCodes: [0, 1] });
    return cleanTitle(result.stdout, `Window ${windowId}`);
  }

  async function getWindowPid(windowId) {
    const result = await run("xdotool", ["getwindowpid", String(windowId)], { allowedExitCodes: [0, 1] });
    const pid = Number(String(result.stdout || "").trim());
    return Number.isFinite(pid) ? pid : null;
  }

  async function listWindows() {
    await ensureLinux();
    const result = await run("xdotool", ["search", "--onlyvisible", "--name", "."], { allowedExitCodes: [0, 1] });
    const seen = new Set();
    return String(result.stdout || "")
      .split(/\r?\n/)
      .map((line) => parseWindowId(line))
      .filter((windowId) => {
        if (!windowId || seen.has(windowId)) return false;
        seen.add(windowId);
        return true;
      });
  }

  async function listApps() {
    const apps = [];
    for (const windowId of await listWindows()) {
      try {
        const [title, pid, bounds] = await Promise.all([
          getWindowName(windowId),
          getWindowPid(windowId),
          getWindowGeometry(windowId),
        ]);
        apps.push({
          appId: `window:${windowId}`,
          name: title,
          pid,
          windows: [{
            windowId: String(windowId),
            title,
            bounds,
          }],
          providerData: {
            windowId: String(windowId),
            processId: pid,
          },
        });
      } catch {
        // A visible window can disappear between search and metadata reads.
      }
    }
    return apps;
  }

  async function resolveWindow(target = {}) {
    const nativeTarget = normalizeTarget(target);
    if (nativeTarget.windowId) return nativeTarget.windowId;

    const apps = await listApps();
    if (nativeTarget.processId != null) {
      const byPid = apps.find((app) => Number(app.pid) === nativeTarget.processId);
      if (byPid?.windows?.[0]?.windowId) return byPid.windows[0].windowId;
    }

    if (nativeTarget.appName) {
      const needle = nativeTarget.appName.toLowerCase();
      const byName = apps.find((app) => String(app.name || "").toLowerCase().includes(needle));
      if (byName?.windows?.[0]?.windowId) return byName.windows[0].windowId;
    }

    throw computerUseError(COMPUTER_USE_ERRORS.TARGET_NOT_FOUND, "Linux xdotool lease target requires a visible window id, pid, or app name.", {
      target,
    });
  }

  async function captureScreenshot() {
    const tmpFile = path.join(os.tmpdir(), `gsap-linux-computer-${process.pid}-${Date.now()}.png`);
    try {
      if (await commandAvailable(runner, "gnome-screenshot", { env, timeoutMs })) {
        await run("gnome-screenshot", ["-f", tmpFile], { timeoutMs: screenshotTimeoutMs });
      } else if (await commandAvailable(runner, "import", { env, timeoutMs })) {
        await run("import", ["-window", "root", tmpFile], { timeoutMs: screenshotTimeoutMs });
      } else {
        return ONE_PIXEL_PNG_BASE64;
      }
      return fs.readFileSync(tmpFile).toString("base64");
    } finally {
      try { fs.rmSync(tmpFile, { force: true }); } catch {}
    }
  }

  function pointForAction(action = {}) {
    if (action.snapshotElement?.bounds) return centerOf(action.snapshotElement.bounds);
    if (Number.isFinite(action.x) && Number.isFinite(action.y)) {
      return { x: Math.round(action.x), y: Math.round(action.y) };
    }
    throw computerUseError(COMPUTER_USE_ERRORS.TARGET_NOT_FOUND, "Linux xdotool action requires a snapshot element or point.", {
      action: action.type || null,
      elementId: action.elementId || null,
    });
  }

  async function clickAction(action, button = "1") {
    const point = pointForAction(action);
    await run("xdotool", ["mousemove", "--sync", String(point.x), String(point.y), "click", button]);
    return { ok: true, x: point.x, y: point.y, button };
  }

  return {
    providerId,
    capabilities: {
      platform: "linux",
      observationModes: ["vision-native"],
      screenshot: true,
      accessibilityTree: false,
      elementActions: true,
      elementDoubleClick: false,
      backgroundControl: "foreground",
      pointClick: "foreground",
      drag: "unsupported",
      textInput: "focused",
      keyboardInput: "focused",
      requiresForegroundForInput: true,
      isolated: false,
      nativeCursor: true,
    },

    async getStatus() {
      if (platform !== "linux") {
        return { providerId, available: false, reason: "unsupported-platform", platform };
      }
      const hasDisplay = Boolean(env.DISPLAY);
      const hasXdotool = await commandAvailable(runner, "xdotool", { env, timeoutMs });
      const hasGnomeScreenshot = await commandAvailable(runner, "gnome-screenshot", { env, timeoutMs });
      const hasImport = await commandAvailable(runner, "import", { env, timeoutMs });
      const available = hasDisplay && hasXdotool && (hasGnomeScreenshot || hasImport);
      const missing = [];
      if (!hasDisplay) missing.push("DISPLAY");
      if (!hasXdotool) missing.push("xdotool");
      if (!hasGnomeScreenshot && !hasImport) missing.push("gnome-screenshot or ImageMagick import");
      return {
        providerId,
        available,
        permissions: [],
        reason: available ? null : "missing-linux-desktop-dependencies",
        missing,
        display: env.DISPLAY || null,
        waylandDisplay: env.WAYLAND_DISPLAY || null,
        sessionType: env.XDG_SESSION_TYPE || null,
      };
    },

    async requestPermissions() {
      return this.getStatus();
    },

    async listApps() {
      return listApps();
    },

    async createLease(_ctx, target = {}) {
      await ensureLinux();
      const windowId = await resolveWindow(target);
      const [title, pid, bounds] = await Promise.all([
        getWindowName(windowId),
        getWindowPid(windowId),
        getWindowGeometry(windowId),
      ]);
      return {
        appId: `window:${windowId}`,
        windowId: String(windowId),
        allowedActions: LINUX_XDOTOOL_ALLOWED_ACTIONS,
        providerState: {
          appId: `window:${windowId}`,
          appName: title,
          processId: pid,
          windowId: String(windowId),
          bounds,
        },
      };
    },

    async getAppState(_ctx, lease) {
      await ensureLinux();
      const windowId = lease.providerState?.windowId || parseWindowId(lease.windowId);
      if (!windowId) {
        throw computerUseError(COMPUTER_USE_ERRORS.TARGET_NOT_FOUND, "Linux xdotool lease is missing window id.", {
          leaseId: lease.leaseId,
        });
      }
      const [title, bounds, display, screenshotData] = await Promise.all([
        getWindowName(windowId),
        getWindowGeometry(windowId),
        run("xdotool", ["getdisplaygeometry"]).then((result) => parseDisplayGeometry(result.stdout)),
        captureScreenshot(),
      ]);
      return {
        mode: "vision-native",
        appId: lease.appId || `window:${windowId}`,
        windowId: String(windowId),
        screenshot: { type: "image", mimeType: "image/png", data: screenshotData },
        display,
        focusedElementId: `window:${windowId}`,
        elements: buildSyntheticElements(windowId, title, bounds),
        providerState: {
          ...(lease.providerState || {}),
          appName: title,
          bounds,
        },
      };
    },

    async performAction(_ctx, lease, action = {}) {
      await ensureLinux();
      const windowId = lease.providerState?.windowId || parseWindowId(lease.windowId);
      if (!windowId) {
        throw computerUseError(COMPUTER_USE_ERRORS.TARGET_NOT_FOUND, "Linux xdotool lease is missing window id.", {
          leaseId: lease.leaseId,
        });
      }

      switch (action.type) {
        case "click_element":
          return clickAction(action, "1");
        case "perform_secondary_action":
          return clickAction(action, "3");
        case "type_text": {
          if (action.elementId) await clickAction(action, "1");
          await ensureWindowActive(windowId);
          await run("xdotool", ["type", "--clearmodifiers", "--delay", "5", "--", String(action.text || "")]);
          return { ok: true, action: action.type };
        }
        case "press_key":
          await ensureWindowActive(windowId);
          await run("xdotool", ["key", "--clearmodifiers", String(action.key || "")]);
          return { ok: true, action: action.type, key: action.key || "" };
        case "scroll": {
          if (action.elementId) {
            const point = pointForAction(action);
            await run("xdotool", ["mousemove", "--sync", String(point.x), String(point.y)]);
          }
          await run("xdotool", ["click", "--repeat", clampRepeat(action.amount), scrollButton(action.direction)]);
          return { ok: true, action: action.type, direction: action.direction || "down" };
        }
        default:
          throw computerUseError(COMPUTER_USE_ERRORS.CAPABILITY_UNSUPPORTED, `Unsupported Linux xdotool action: ${action.type}`, {
            action: action.type,
          });
      }
    },

    async releaseLease() {
      return { released: true };
    },

    async stop() {
      return { stopped: true };
    },
  };
}
