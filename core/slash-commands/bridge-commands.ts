import { listRecentAgentSessions } from "./list-agent-sessions.ts";

export const bridgeCommands = [
  {
    name: "confirm",
    aliases: ["approve"],
    description: "Confirm a pending desktop confirmation by id",
    usage: "/confirm <confirmId>",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => resolvePendingConfirmation(ctx, "confirmed"),
  },
  {
    name: "reject",
    aliases: ["deny"],
    description: "Reject a pending desktop confirmation by id",
    usage: "/reject <confirmId>",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => resolvePendingConfirmation(ctx, "rejected"),
  },
  {
    name: "apply",
    description: "Apply the latest automation suggestion",
    usage: "/apply [suggestionId]",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => applyAutomationSuggestion(ctx),
  },
  {
    name: "stop",
    aliases: ["abort", "halt"],
    description: "Stop the current streaming reply",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => {
      const ref = _redirectRefIfAttached(ctx);
      const ok = await ctx.sessionOps.abort(ref);
      if (ok) return { silent: true };
      return { reply: "已停止（当前无活动回复）" };
    },
  },
  {
    name: "new",
    description: "Start a new conversation and archive current history",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => {
      if (_isAttached(ctx)) {
        return { reply: "接管桌面会话期间禁止使用 /new，请先 /exitrc 退出接管。" };
      }
      const res = await ctx.sessionOps.rotate(ctx.sessionRef);
      if (res.status === "not-found") return { reply: "未找到当前会话。" };
      if (res.status === "no-history") return { reply: "已开启新会话（之前无历史记录）。" };
      return { reply: "已开启新会话，旧会话已归档。" };
    },
  },
  {
    name: "reset",
    aliases: ["clear"],
    description: "Reset the current conversation and clear history",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => {
      if (_isAttached(ctx)) {
        return { reply: "接管桌面会话期间禁止使用 /reset，请先 /exitrc 退出接管。" };
      }
      const res = await ctx.sessionOps.delete(ctx.sessionRef);
      if (res.status === "not-found") return { reply: "未找到当前会话。" };
      return { reply: "已重置会话，历史已清除。" };
    },
  },
  {
    name: "rc",
    description: "Attach to a recent desktop session",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => {
      if (ctx.sessionRef?.kind !== "bridge") {
        return { reply: "/rc 只能在 bridge 会话中使用。" };
      }
      if (ctx.isGroup) {
        return { reply: "/rc 只能在 bridge 私聊中使用，群聊不能发起桌面会话接管。" };
      }
      const rcState = ctx.engine?.rcState;
      if (!rcState) return { error: "rc 状态存储未初始化" };

      if (rcState.isAttached(ctx.sessionRef.sessionKey)) {
        return { reply: "当前已处于接管状态，请先 /exitrc 再执行 /rc 切换。" };
      }

      const sessions = await listRecentAgentSessions(ctx.engine, ctx.sessionRef.agentId, { limit: 10 });
      const availableSessions = sessions.filter((session) => !rcState.isDesktopSessionAttached(session.path));
      if (availableSessions.length === 0) {
        return { reply: "当前 agent 没有可接管的桌面会话。" };
      }

      const lines = availableSessions.map((session, index) => {
        const title = session.title ? session.title : `未命名（${_formatShortDate(session.modified)}）`;
        return `${index + 1}. ${title}`;
      });
      const promptText = [
        "选择要接管的桌面会话（回复编号）：",
        ...lines,
        "",
        "5 分钟内不选择则自动取消。/exitrc 退出接管。",
      ].join("\n");

      rcState.setPending(ctx.sessionRef.sessionKey, {
        type: "rc-select",
        promptText,
        options: availableSessions.map((session) => ({ path: session.path, title: session.title })),
      });
      return { reply: promptText };
    },
  },
  {
    name: "exitrc",
    description: "Detach from a desktop session",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => {
      if (ctx.sessionRef?.kind !== "bridge") {
        return { reply: "/exitrc 只能在 bridge 会话中使用。" };
      }
      const rcState = ctx.engine?.rcState;
      if (!rcState) return { error: "rc 状态存储未初始化" };

      const priorAttachment = rcState.getAttachment(ctx.sessionRef.sessionKey);
      const wasAttached = !!priorAttachment;
      const wasPending = rcState.isPending(ctx.sessionRef.sessionKey);
      rcState.reset(ctx.sessionRef.sessionKey);
      if (!wasAttached && !wasPending) {
        return { reply: "当前未处于接管状态。" };
      }

      if (wasAttached && priorAttachment?.desktopSessionPath) {
        try {
          ctx.engine?.emitEvent?.({
            type: "bridge_rc_detached",
            sessionKey: ctx.sessionRef.sessionKey,
            sessionPath: priorAttachment.desktopSessionPath,
          }, priorAttachment.desktopSessionPath);
        } catch {}
      }
      return { reply: "已退出接管桌面会话。" };
    },
  },
  {
    name: "compact",
    description: "Compact the current conversation context",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => {
      const ref = _redirectRefIfAttached(ctx);
      try { await ctx.reply("（正在压缩上下文，请稍候...）"); } catch {}
      try {
        const result = await ctx.sessionOps.compact(ref);
        const before = result?.tokensBefore;
        const after = result?.tokensAfter;
        const msg = (typeof before === "number" && typeof after === "number")
          ? `（上下文已压缩：${before} -> ${after} tokens）`
          : "（上下文已压缩）";
        try { await ctx.reply(msg); } catch {}
      } catch (err) {
        try { await ctx.reply(`（压缩失败：${err?.message || String(err)}）`); } catch {}
      }
      return { silent: true };
    },
  },
  {
    name: "fresh-compact",
    aliases: ["freshcompact"],
    description: "Compact the current conversation with the latest prompt and memory state",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => {
      if (_isAttached(ctx)) {
        return { reply: "接管桌面会话期间暂不支持 /fresh-compact，请先 /exitrc 退出接管。" };
      }
      try { await ctx.reply("（正在 fresh-compact：刷新提示词与记忆状态后压缩上下文，请稍候...）"); } catch {}
      try {
        const result = await ctx.sessionOps.freshCompact(ctx.sessionRef);
        const before = result?.tokensBefore;
        const after = result?.tokensAfter;
        const reason = result?.reason ? `，原因：${result.reason}` : "";
        const msg = (typeof before === "number" && typeof after === "number")
          ? `（fresh-compact 已完成：${before} -> ${after} tokens${reason}）`
          : `（fresh-compact 已完成${reason}）`;
        try { await ctx.reply(msg); } catch {}
      } catch (err) {
        try { await ctx.reply(`（fresh-compact 失败：${err?.message || String(err)}）`); } catch {}
      }
      return { silent: true };
    },
  },
];

function resolveConfirmId(args) {
  const [confirmId] = String(args || "").trim().split(/\s+/).filter(Boolean);
  return confirmId || "";
}

async function resolvePendingConfirmation(ctx, action) {
  const confirmId = resolveConfirmId(ctx.args);
  if (!confirmId) {
    return { reply: action === "confirmed" ? "用法：/confirm <确认ID>" : "用法：/reject <确认ID>" };
  }
  const store = ctx.engine?.confirmStore || ctx.engine?._confirmStore || null;
  if (!store || typeof store.get !== "function" || typeof store.resolve !== "function") {
    return { error: "确认存储不可用" };
  }
  const pending = store.get(confirmId);
  if (!pending) {
    return { reply: "确认项不存在或已处理。" };
  }
  const ok = store.resolve(confirmId, action);
  if (!ok) {
    return { reply: "确认项不存在或已处理。" };
  }
  try {
    ctx.engine?.emitEvent?.({
      type: "confirmation_resolved",
      confirmId,
      action,
      value: undefined,
    }, null);
  } catch {}
  return { reply: action === "confirmed" ? "已确认。" : "已拒绝。" };
}

async function applyAutomationSuggestion(ctx) {
  const ref = resolveConfirmId(ctx.args) || null;
  const store = ctx.engine?.automationSuggestionStore || ctx.engine?.getAutomationSuggestionStore?.() || null;
  if (!store?.apply) return { error: "自动任务建议系统未初始化" };

  const bridgeSessionKey = ctx.sessionRef?.kind === "bridge"
    ? ctx.sessionRef.sessionKey
    : null;
  const sessionPath = ctx.sessionRef?.kind === "desktop"
    ? ctx.sessionRef.sessionPath
    : null;
  if (!bridgeSessionKey && !sessionPath) {
    return { reply: "/apply 只能在当前会话中创建自动任务建议" };
  }

  try {
    const result = await store.apply({
      bridgeSessionKey,
      sessionPath,
      ref,
    });
    if (!result?.ok) {
      return {
        reply: ref
          ? `没有找到建议 ${ref}，可能已经创建过了。`
          : "没有待创建的自动任务建议。",
      };
    }
    const label = automationSuggestionLabel(result.suggestion) || "自动任务";
    return { reply: `已创建自动任务：${label}` };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

function automationSuggestionLabel(suggestion) {
  const jobData = suggestion?.jobData || {};
  if (typeof jobData.label === "string" && jobData.label.trim()) return jobData.label.trim();
  if (typeof suggestion?.label === "string" && suggestion.label.trim()) return suggestion.label.trim();
  if (typeof suggestion?.name === "string" && suggestion.name.trim()) return suggestion.name.trim();
  return "";
}

function _isAttached(ctx) {
  const rcState = ctx.engine?.rcState;
  const sessionKey = ctx.sessionRef?.sessionKey;
  if (!rcState || !sessionKey) return false;
  return rcState.isAttached(sessionKey);
}

function _redirectRefIfAttached(ctx) {
  const rcState = ctx.engine?.rcState;
  const sessionKey = ctx.sessionRef?.sessionKey;
  if (!rcState || !sessionKey) return ctx.sessionRef;
  const attachment = rcState.getAttachment(sessionKey);
  if (!attachment) return ctx.sessionRef;
  return {
    kind: "desktop",
    agentId: ctx.sessionRef.agentId,
    sessionPath: attachment.desktopSessionPath,
  };
}

function _formatShortDate(modified) {
  if (modified == null) return "未知时间";
  const date = typeof modified === "number" || typeof modified === "string"
    ? new Date(modified)
    : (modified instanceof Date ? modified : new Date());
  if (Number.isNaN(date.getTime())) return "未知时间";
  const pad = (value) => String(value).padStart(2, "0");
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
