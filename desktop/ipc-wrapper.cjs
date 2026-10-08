function resolveElectronIpcMain() {
  const electron = require('electron');
  if (electron && typeof electron === 'object' && electron.ipcMain) return electron.ipcMain;
  throw new Error('Electron ipcMain is unavailable outside the Electron main process');
}

/**
 * Strict IPC handler wrapper.
 * Logs escaped errors, then rethrows so ipcRenderer.invoke callers keep normal
 * Electron rejection semantics.
 */
function wrapIpcHandler(channel, handler, targetIpcMain = resolveElectronIpcMain()) {
  targetIpcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (err) {
      const traceId = Math.random().toString(16).slice(2, 10);
      console.error(`[IPC][${channel}][${traceId}] ${err?.message || err}`);
      throw err;
    }
  });
}

function wrapIpcBestEffortHandler(channel, handler, targetIpcMain = resolveElectronIpcMain()) {
  targetIpcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (err) {
      const traceId = Math.random().toString(16).slice(2, 10);
      console.error(`[IPC][${channel}][${traceId}] ${err?.message || err}`);
      return undefined;
    }
  });
}

function wrapIpcOn(channel, handler, targetIpcMain = resolveElectronIpcMain()) {
  targetIpcMain.on(channel, (event, ...args) => {
    try {
      const result = handler(event, ...args);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          console.error(`[IPC][${channel}] async: ${err?.message || err}`);
        });
      }
    } catch (err) {
      console.error(`[IPC][${channel}] ${err?.message || err}`);
    }
  });
}

function createIpcWrappers(targetIpcMain) {
  if (!targetIpcMain || typeof targetIpcMain.handle !== 'function' || typeof targetIpcMain.on !== 'function') {
    throw new Error('createIpcWrappers requires an ipcMain-like object');
  }
  return {
    wrapIpcHandler: (channel, handler) => wrapIpcHandler(channel, handler, targetIpcMain),
    wrapIpcBestEffortHandler: (channel, handler) => wrapIpcBestEffortHandler(channel, handler, targetIpcMain),
    wrapIpcOn: (channel, handler) => wrapIpcOn(channel, handler, targetIpcMain),
  };
}

module.exports = {
  createIpcWrappers,
  wrapIpcHandler,
  wrapIpcBestEffortHandler,
  wrapIpcOn,
};
