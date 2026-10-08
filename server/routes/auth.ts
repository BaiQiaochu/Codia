/**
 * OAuth 认证路由
 *
 * 支持两种 OAuth 流程：
 *   - 授权码流程 (Anthropic)：用户粘贴授权码
 *   - 设备码流程 (MiniMax)：服务端轮询，用户在浏览器授权
 *
 * 交互：
  *
 *   2. POST /auth/oauth/callback → 提交授权码（授权码流程）
 *   3. GET  /auth/oauth/poll/:id → 轮询登录状态（设备码流程）
 */
import crypto from "crypto";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";

/** 将 OAuth 底层错误转为用户可理解的诊断信息 */
function diagnoseOAuthError(err) {
  const msg = err.message || String(err);
  const cause = err.cause?.message || err.cause?.code || "";
  const full = cause ? `${msg} (${cause})` : msg;

  // fetch 网络层失败（DNS/连接/超时）→ 代理没覆盖 Node 进程
  if (/fetch failed/i.test(msg)) {
    const detail = cause ? `（${cause}）` : "";
    return `无法连接 OAuth 服务器${detail}。请确认代理开启了 TUN 模式，或设置 HTTPS_PROXY 环境变量`;
  }
  // 回调超时 → localhost 不通 / 端口问题
  if (/timed out/i.test(msg)) {
    return "OAuth 超时：未收到浏览器回调。请检查端口 1455 是否被防火墙拦截或已被占用，Windows 用户也请确认 localhost 未被解析到 IPv6";
  }
  return full;
}

export function createAuthRoute(engine) {
  const route = new Hono();

  /** 进行中的 OAuth 流程 */
  const pendingFlows = new Map();
  const pendingFlowByAuthKey = new Map();

  function deletePendingFlow(sessionId) {
    const flow = pendingFlows.get(sessionId);
    if (flow?.authKey && pendingFlowByAuthKey.get(flow.authKey) === sessionId) {
      pendingFlowByAuthKey.delete(flow.authKey);
    }
    pendingFlows.delete(sessionId);
  }

  function buildStartResponse(sessionId, url, authInstructions, usesCallbackServer) {
    const resp: Record<string, any> = { sessionId, url };
    if (authInstructions) resp.instructions = authInstructions;
    if (usesCallbackServer) resp.polling = true;
    return resp;
  }

  // 定时清理超时的 pending flow（10 分钟未完成视为超时）
  const _flowCleanupTimer = setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of pendingFlows) {
      if (v.createdAt < cutoff) deletePendingFlow(k);
    }
  }, 60_000);
  _flowCleanupTimer.unref();

  /**
   * 启动 OAuth 登录
   * body: { provider }
    *
   *   instructions 存在时为设备码流程（值为 user_code）
   */
  route.post("/auth/oauth/start", async (c) => {
    const body = await safeJson(c);
    const { provider } = body;
    if (!provider) {
      return c.json({ error: "provider is required" }, 400);
    }

    // ProviderRegistry 的 plugin ID 可能和 Pi SDK 的 provider ID 不同（如 "openai-codex-oauth" → "openai-codex"）
    const authKey = engine.providerRegistry?.getAuthJsonKey(provider) || provider;
    const existingSessionId = pendingFlowByAuthKey.get(authKey);
    const existingFlow = existingSessionId ? pendingFlows.get(existingSessionId) : null;
    if (existingFlow?.result) {
      deletePendingFlow(existingSessionId);
    } else if (existingFlow) {
      try {
        const url = await existingFlow.urlPromise;
        if (!existingFlow.response) {
          existingFlow.response = buildStartResponse(
            existingSessionId,
            url,
            existingFlow.authInstructions,
            existingFlow.usesCallbackServer,
          );
        }
        return c.json(existingFlow.response);
      } catch (err) {
        return c.json({ error: err.message }, 500);
      }
    }

    const sessionId = crypto.randomUUID();

    // onAuth 回调会把 URL 和 instructions 交给我们
    let resolveUrl, rejectUrl;
    const urlPromise = new Promise((resolve, reject) => {
      resolveUrl = resolve;
      rejectUrl = reject;
    });

    // onPrompt 回调等待用户粘贴授权码（仅授权码流程使用）
    let resolveCode, rejectCode;
    const codePromise = new Promise((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    void codePromise.catch(() => {});

    let authInstructions = null;
    let usesCallbackServer = false;

    const providerObj = engine.modelRuntime?.getProvider(authKey);
    if (!providerObj?.auth?.oauth) return c.json({ error: `OAuth is not available for ${provider}` }, 400);
    usesCallbackServer = authKey === "openai-codex";

    const flow: Record<string, any> = {
      authKey,
      resolveCode,
      rejectCode,
      loginPromise: null,
      abortController: new AbortController(),
      result: null,
      response: null,
      urlPromise,
      authInstructions,
      usesCallbackServer,
      createdAt: Date.now(),
    };
    pendingFlows.set(sessionId, flow);
    pendingFlowByAuthKey.set(authKey, sessionId);

    const interaction = {
      signal: flow.abortController.signal,
      prompt: async (prompt) => {
        if (prompt.type === "manual_code") return codePromise;
        if (prompt.type === "select") {
          const preferred = prompt.options.find((option) => /browser|default/i.test(`${option.id} ${option.label}`));
          return preferred?.id || prompt.options[0]?.id || "";
        }
        throw new Error("This OAuth provider requires an unsupported interactive prompt");
      },
      notify: (event) => {
        if (event.type === "auth_url") {
          authInstructions = usesCallbackServer ? null : (event.instructions || null);
          flow.authInstructions = authInstructions;
          resolveUrl(event.url);
        } else if (event.type === "device_code") {
          usesCallbackServer = true;
          flow.usesCallbackServer = true;
          authInstructions = event.userCode;
          flow.authInstructions = authInstructions;
          resolveUrl(event.verificationUri);
        }
      },
    };

    const loginPromise = engine.modelRuntime.login(authKey, "oauth", interaction).catch(err => {
      rejectUrl(err);
      throw err;
    });
    flow.loginPromise = loginPromise;

    // 追踪 loginPromise 的结果（供 poll 端点使用）
    loginPromise.then(() => {
      flow.result = { ok: true };
    }).catch(err => {
      const cause = err.cause?.message || err.cause?.code || "";
      console.error(`[auth] OAuth login failed (${provider}): ${err.message}${cause ? ` [${cause}]` : ""}`);
      flow.result = { ok: false, error: diagnoseOAuthError(err) };
    });

    try {
      const url = await urlPromise;

      // 5 分钟超时
      const timer = setTimeout(() => {
        const f = pendingFlows.get(sessionId);
        if (f) {
          f.rejectCode(new Error("OAuth flow timed out"));
          deletePendingFlow(sessionId);
        }
      }, 5 * 60 * 1000);
      timer.unref();

      const resp = buildStartResponse(sessionId, url, authInstructions, usesCallbackServer);
      flow.response = resp;
      return c.json(resp);
    } catch (err) {
      deletePendingFlow(sessionId);
      return c.json({ error: err.message }, 500);
    }
  });

  /**
   * 提交授权码（授权码流程）
   * body: { sessionId, code }
   */
  route.post("/auth/oauth/callback", async (c) => {
    const body = await safeJson(c);
    const { sessionId, code } = body;
    const flow = pendingFlows.get(sessionId);
    if (!flow) {
      return c.json({ error: "No pending login flow" }, 400);
    }

    flow.resolveCode(code);

    try {
      await flow.loginPromise;
      deletePendingFlow(sessionId);

      try {
        await engine.onProviderChanged();
      } catch (err) {
        console.error("[auth] post-login model sync failed:", err.message);
      }

      return c.json({ ok: true });
    } catch (err) {
      deletePendingFlow(sessionId);
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/auth/oauth/cancel", async (c) => {
    const body = await safeJson(c);
    const flow = pendingFlows.get(body.sessionId);
    if (!flow) return c.json({ error: "No pending login flow" }, 404);
    const error = new Error("OAuth login cancelled");
    flow.abortController?.abort(error);
    flow.rejectCode?.(error);
    deletePendingFlow(body.sessionId);
    return c.json({ ok: true });
  });

  /**
   * 轮询登录状态（设备码流程）
    *
   */
  route.get("/auth/oauth/poll/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const flow = pendingFlows.get(sessionId);
    if (!flow) {
      return c.json({ status: "error", error: "No pending login flow" }, 400);
    }

    if (!flow.result) {
      return c.json({ status: "pending" });
    }

    deletePendingFlow(sessionId);

    if (flow.result.ok) {
      try {
        await engine.onProviderChanged();
      } catch (err) {
        console.error("[auth] post-login model sync failed:", err.message);
      }
      return c.json({ status: "done" });
    }

    return c.json({ status: "error", error: flow.result.error });
  });

  /**
   * 查询 OAuth 状态
   * → { anthropic: { name, loggedIn }, minimax: { name, loggedIn }, ... }
   */
  route.get("/auth/oauth/status", async (c) => {
    const providers = (engine.modelRuntime?.getProviders?.() || []).filter((provider) => !!provider.auth?.oauth);
    const status = {};
    for (const p of providers) {
      const authStatus = engine.modelRuntime.getProviderAuthStatus(p.id);
      const modelCount = authStatus.configured ? engine.availableModels.filter(m => m.provider === p.id).length : 0;
      status[p.id] = {
        name: p.name,
        loggedIn: authStatus.configured && engine.modelRuntime.isUsingOAuth(p.id),
        modelCount,
      };
    }
    return c.json(status);
  });

  /**
   * 登出
   * body: { provider }
   */
  route.post("/auth/oauth/logout", async (c) => {
    const body = await safeJson(c);
    const { provider } = body;
    if (!provider) {
      return c.json({ error: "provider is required" }, 400);
    }
    const authKey = engine.providerRegistry?.getAuthJsonKey(provider) || provider;
    await engine.modelRuntime.logout(authKey);
    return c.json({ ok: true });
  });

  // ── OAuth 自定义模型 ──

  /** 获取某个 OAuth provider 的自定义模型列表 */
  route.get("/auth/oauth/:provider/custom-models", async (c) => {
    const provider = c.req.param("provider");
    const custom = engine.preferences.getOAuthCustomModels();
    return c.json({ models: custom[provider] || [] });
  });

  /** 添加自定义模型到 OAuth provider */
  route.post("/auth/oauth/:provider/custom-models", async (c) => {
    const provider = c.req.param("provider");
    const body = await safeJson(c);
    const { modelId } = body;
    if (!modelId || typeof modelId !== "string" || !modelId.trim()) {
      return c.json({ error: "modelId is required" }, 400);
    }
    const id = modelId.trim();
    const custom = engine.preferences.getOAuthCustomModels();
    const list = custom[provider] || [];
    if (list.includes(id)) return c.json({ ok: true, models: list });
    list.push(id);
    engine.preferences.setOAuthCustomModels(provider, list);
    await engine.refreshModels();
    return c.json({ ok: true, models: list });
  });

  /** 删除 OAuth provider 的某个自定义模型 */
  route.delete("/auth/oauth/:provider/custom-models/:modelId", async (c) => {
    const provider = c.req.param("provider");
    const modelId = c.req.param("modelId");
    const custom = engine.preferences.getOAuthCustomModels();
    const list = (custom[provider] || []).filter(id => id !== modelId);
    engine.preferences.setOAuthCustomModels(provider, list);
    await engine.refreshModels();
    return c.json({ ok: true, models: list });
  });

  return route;
}
