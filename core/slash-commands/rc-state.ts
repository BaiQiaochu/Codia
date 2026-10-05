// @ts-nocheck
/**
  *
  *
  *
 *
 * attachment 额外维护 desktopSessionPath -> bridge sessionKey 的反向索引，
  *
 * 两同 sessionKey 时刻只持有一个（选择进行中不可能同时已接管；接管中收到新 /rc 会先 reset 再列）- *
 * 持久化策略：内存 only，重启即清空。用户已明确"接管态不持久- *
  * */

const PENDING_DEFAULT_TTL_MS = 5 * 60 * 1000;  // 5 分钟

/**
 * @typedef {object} PendingSpec
 * @property {'rc-select'} type 当前-rc-select；预留扩展：'yes-no' / 'free-text'
  *
 * @property {number} expiresAt 绝对时间戳（Date.now() + ttl- */

/**
 * @typedef {object} Attachment
 * @property {string} desktopSessionPath 被接管的桌面 session 绝对路径
 * @property {number} attachedAt 毫秒时间戳，用于排障
 */

export class RcStateStore {
  /**
    *
   */
  constructor({ ttlMs = PENDING_DEFAULT_TTL_MS } = {}) {
    /** @type {Map<string, PendingSpec>} */
    this._pending = new Map();
    /** @type {Map<string, Attachment>} */
    this._attachment = new Map();
    /** @type {Map<string, string>} */
    this._attachedDesktopToBridge = new Map();
    this._ttlMs = ttlMs;
  }

  // ── pending-selection ──────────────────────────────────────

  /**
   * @param {string} sessionKey
   * @param {Omit<PendingSpec, 'expiresAt'>} spec
   */
  setPending(sessionKey, spec) {
    const expiresAt = Date.now() + this._ttlMs;
    this._pending.set(sessionKey, { ...spec, expiresAt });
  }

  /**
   * @param {string} sessionKey
   * @returns {PendingSpec | null}
   */
  getPending(sessionKey) {
    const p = this._pending.get(sessionKey);
    if (!p) return null;
    if (Date.now() >= p.expiresAt) {
 // 懒惰过期：一读到就清
      this._pending.delete(sessionKey);
      return null;
    }
    return p;
  }

  clearPending(sessionKey) {
    this._pending.delete(sessionKey);
  }

  /** @returns {boolean} */
  isPending(sessionKey) {
    return this.getPending(sessionKey) !== null;
  }

  // ── attachment ─────────────────────────────────────────────

  /**
   * @param {string} sessionKey
 * @param {string} desktopSessionPath 桌面 session -jsonl 绝对路径
   */
  attach(sessionKey, desktopSessionPath, meta = {}) {
    const current = this._attachment.get(sessionKey) ?? null;
    const holderSessionKey = this._attachedDesktopToBridge.get(desktopSessionPath) ?? null;
    if (holderSessionKey && holderSessionKey !== sessionKey) {
      throw new Error("目标会话已被另一个 bridge 会话接管，接管取消。请重新 /rc。");
    }

    if (current?.desktopSessionPath && current.desktopSessionPath !== desktopSessionPath) {
      this._attachedDesktopToBridge.delete(current.desktopSessionPath);
    }

    const next = {
      desktopSessionPath,
      attachedAt: Date.now(),
      platform: meta.platform || null,
      chatId: meta.chatId || null,
      agentId: meta.agentId || null,
      messageThreadId: meta.messageThreadId || null,
    };
    this._attachment.set(sessionKey, next);
    this._attachedDesktopToBridge.set(desktopSessionPath, sessionKey);
    return next;
  }

  /**
   * @param {string} sessionKey
   * @returns {Attachment | null}
   */
  getAttachment(sessionKey) {
    return this._attachment.get(sessionKey) ?? null;
  }

  /**
   * @param {string} desktopSessionPath
   * @returns {string | null}
   */
  getAttachedBridgeSessionKey(desktopSessionPath) {
    return this._attachedDesktopToBridge.get(desktopSessionPath) ?? null;
  }

  /**
   * @param {string} desktopSessionPath
   * @returns {boolean}
   */
  isDesktopSessionAttached(desktopSessionPath) {
    return this._attachedDesktopToBridge.has(desktopSessionPath);
  }

  detach(sessionKey) {
    const current = this._attachment.get(sessionKey) ?? null;
    if (current?.desktopSessionPath) {
      const holderSessionKey = this._attachedDesktopToBridge.get(current.desktopSessionPath) ?? null;
      if (holderSessionKey === sessionKey) {
        this._attachedDesktopToBridge.delete(current.desktopSessionPath);
      }
    }
    this._attachment.delete(sessionKey);
    return current;
  }

  /** @returns {boolean} */
  isAttached(sessionKey) {
    return this._attachment.has(sessionKey);
  }

  /**
  *
   * @param {string} desktopSessionPath
   * @returns {{ detachedAttachments: Array<Attachment & { sessionKey: string }>, clearedPendingSessionKeys: string[] }}
   */
  invalidateDesktopSession(desktopSessionPath) {
    const detachedAttachments = [];
    const holderSessionKey = this._attachedDesktopToBridge.get(desktopSessionPath) ?? null;
    if (holderSessionKey) {
      const detached = this.detach(holderSessionKey);
      if (detached) {
        detachedAttachments.push({
          sessionKey: holderSessionKey,
          ...detached,
        });
      }
    }

    const clearedPendingSessionKeys = [];
    const now = Date.now();
    for (const [sessionKey, pending] of Array.from(this._pending.entries())) {
      if (now >= pending.expiresAt) {
        this._pending.delete(sessionKey);
        continue;
      }
      if (pending.options?.some(option => option.path === desktopSessionPath)) {
        this._pending.delete(sessionKey);
        clearedPendingSessionKeys.push(sessionKey);
      }
    }

    return { detachedAttachments, clearedPendingSessionKeys };
  }

  /**
 * releaseDesktopSession -invalidateDesktopSession 的语义别名：
  *
   * @param {string} desktopSessionPath
   * @returns {{ detachedAttachments: Array<Attachment & { sessionKey: string }>, clearedPendingSessionKeys: string[] }}
   */
  releaseDesktopSession(desktopSessionPath) {
    return this.invalidateDesktopSession(desktopSessionPath);
  }

  // ── utility ────────────────────────────────────────────────

 /** */
  reset(sessionKey) {
    this._pending.delete(sessionKey);
    this.detach(sessionKey);
  }

  /**
  *
   */
  listAttachments() {
    return Array.from(this._attachment.entries()).map(([sessionKey, att]) => ({
      sessionKey,
      ...att,
    }));
  }
}
