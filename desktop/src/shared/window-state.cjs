const fs = require("fs");

function sanitizeWindowState(state, displays, {
  defaultWidth = 960,
  defaultHeight = 820,
} = {}) {
  const primary = normalizeDisplay(displays?.[0]) || {
    x: 0,
    y: 0,
    width: defaultWidth,
    height: defaultHeight,
  };
  const width = sanitizeDimension(state?.width, defaultWidth);
  const height = sanitizeDimension(state?.height, defaultHeight);
  const candidate = {
    x: sanitizeCoordinate(state?.x),
    y: sanitizeCoordinate(state?.y),
    width,
    height,
    isMaximized: state?.isMaximized === true,
  };

  if (candidate.x != null && candidate.y != null && isVisibleOnAnyDisplay(candidate, displays)) {
    return candidate;
  }

  return {
    x: Math.round(primary.x + Math.max(0, primary.width - width) / 2),
    y: Math.round(primary.y + Math.max(0, primary.height - height) / 2),
    width,
    height,
    isMaximized: candidate.isMaximized,
  };
}

function sanitizeDimension(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(320, Math.round(numeric));
}

function sanitizeCoordinate(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function normalizeDisplay(display) {
  const area = display?.workArea;
  if (!area) return null;
  const x = Number(area.x);
  const y = Number(area.y);
  const width = Number(area.width);
  const height = Number(area.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function isVisibleOnAnyDisplay(bounds, displays) {
  const normalizedDisplays = Array.isArray(displays)
    ? displays.map(normalizeDisplay).filter(Boolean)
    : [];
  if (normalizedDisplays.length === 0) return true;
  return normalizedDisplays.some((display) => intersectionArea(bounds, display) >= 10_000);
}

function intersectionArea(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function loadWindowState(filePath, { readFileSync = fs.readFileSync } = {}) {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function captureWindowState(win) {
  if (!win || typeof win.isDestroyed === "function" && win.isDestroyed()) return null;
  const isMaximized = typeof win.isMaximized === "function" ? win.isMaximized() : false;
  const bounds = isMaximized && typeof win.getNormalBounds === "function"
    ? win.getNormalBounds()
    : win.getBounds?.();
  if (!bounds || typeof bounds !== "object") return null;
  return { ...bounds, isMaximized };
}

function createWindowStateSaver({
  filePath,
  getWindow,
  delayMs = 500,
  writeFile = fs.promises.writeFile,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = null,
} = {}) {
  if (!filePath) throw new Error("window state filePath is required");
  if (typeof getWindow !== "function") throw new Error("window state getWindow is required");

  let timer = null;
  let chain = Promise.resolve();

  const writeCurrentState = () => {
    const state = captureWindowState(getWindow());
    if (!state) return chain;
    chain = chain.then(() =>
      writeFile(filePath, JSON.stringify(state, null, 2) + "\n")
    ).catch((err) => {
      onError?.(err);
    });
    return chain;
  };

  return {
    schedule() {
      if (timer) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        writeCurrentState();
      }, delayMs);
    },
    flush() {
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      return writeCurrentState();
    },
    cancel() {
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
    },
    pending() {
      return chain;
    },
  };
}

module.exports = {
  captureWindowState,
  createWindowStateSaver,
  loadWindowState,
  sanitizeWindowState,
};
