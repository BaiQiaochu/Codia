// @ts-nocheck
/**
  *
  *
 * @typedef {Object} BrowserTransport
 * @property {(msg: object) => void} send
 * @property {(handler: (msg: object) => void) => void} onMessage
 * @property {boolean} connected
 */

/** 基于 Node IPC 的传输（fork 模式，现有行为） */
const _ipcHandlers = new Set();
let _ipcListenerAttached = false;

function _dispatchIpcMessage(msg) {
  for (const handler of _ipcHandlers) {
    try {
      handler(msg);
    } catch {}
  }
}

export class IpcTransport {
  constructor() {
    this._handler = null;
    if (!_ipcListenerAttached) {
      process.on("message", _dispatchIpcMessage);
      _ipcListenerAttached = true;
    }
  }

  get connected() {
    return typeof process.send === "function";
  }

  send(msg) {
    process.send(msg);
  }

  onMessage(handler) {
 //
    if (this._handler) {
      _ipcHandlers.delete(this._handler);
    }
    this._handler = typeof handler === "function" ? handler : null;
    if (this._handler) {
      _ipcHandlers.add(this._handler);
    }
  }

  dispose() {
    if (this._handler) {
      _ipcHandlers.delete(this._handler);
      this._handler = null;
    }
    if (_ipcListenerAttached && _ipcHandlers.size === 0) {
      process.off("message", _dispatchIpcMessage);
      _ipcListenerAttached = false;
    }
  }
}

/** */
export class WsTransport {
  constructor() {
    this._ws = null;
    this._handler = null;
    this._boundListener = null;
  }

  get connected() {
    return this._ws?.readyState === 1; // WebSocket.OPEN
  }

 /** */
  attach(ws) {
    // 先清理旧 listener
    if (this._ws && this._boundListener) {
      this._ws.off("message", this._boundListener);
    }
    this._ws = ws;
    if (this._handler && ws) {
      this._boundListener = (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        this._handler(msg);
      };
      ws.on("message", this._boundListener);
    }
  }

  detach() {
    if (this._ws && this._boundListener) {
      this._ws.off("message", this._boundListener);
    }
    this._ws = null;
    this._boundListener = null;
  }

  send(msg) {
    if (!this.connected) throw new Error("Browser WS transport not connected");
    this._ws.send(JSON.stringify(msg));
  }

  onMessage(handler) {
    this._handler = handler;
 // 如果 ws 已存在，立即绑定
    if (this._ws) {
      this.attach(this._ws);
    }
  }
}
