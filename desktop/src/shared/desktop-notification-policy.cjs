function normalizeDesktopNotificationOptions(rawOptions) {
  const source = rawOptions && typeof rawOptions === "object" && !Array.isArray(rawOptions) ? rawOptions : {};
  return {
    desktopFocusPolicy: source.desktopFocusPolicy === "when_unfocused"
      || source.desktopFocusPolicy === "when_session_unfocused"
      ? source.desktopFocusPolicy
      : "always",
    sessionPath: typeof source.sessionPath === "string" && source.sessionPath.trim()
      ? source.sessionPath.trim()
      : null,
  };
}

function shouldSuppressDesktopNotification(rawOptions, deps = {}) {
  const options = normalizeDesktopNotificationOptions(rawOptions);
  if (options.desktopFocusPolicy === "always") return false;
  const focusedWindow = deps.getFocusedWindow?.() || null;
  if (!focusedWindow || focusedWindow.isDestroyed?.() === true) return false;
  if (options.desktopFocusPolicy === "when_unfocused") return true;
  if (options.desktopFocusPolicy === "when_session_unfocused") {
    const focusedSessionPath = deps.getWindowSessionPath?.(focusedWindow) || null;
    return !!options.sessionPath && focusedSessionPath === options.sessionPath;
  }
  return false;
}

module.exports = {
  normalizeDesktopNotificationOptions,
  shouldSuppressDesktopNotification,
};
