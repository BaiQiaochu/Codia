// @ts-nocheck
/**
 * ExecutionRouter -- per-agent role routing
 *
 * Responsibilities:
 *   - Resolve an agent's role config (chat/utility/embed/etc.) into the full
 *     execution parameters required at runtime
 *   - Input: role name + agentConfig
 *   - Output: { modelId, providerId, api, apiKey, baseUrl }
 *   - Does not participate in model registry logic; this is the routing layer,
 *     not the management layer
 *
 * Role routing storage format (preferences.json / config.yaml):
 *   models.chat           -> "provider/model" or bare modelId (backward compatible)
 *   models.utility        -> same as above
 *   models.utility_large  -> same as above
 *   models.embed          -> same as above
 *   models.summarizer     -> same as above
 *   models.compiler       -> same as above
 */

import { t } from "../lib/i18n.ts";
import { allowsMissingApiKey } from "../shared/net-utils.ts";
import { normalizeProviderApiKey } from "../shared/provider-auth.ts";

function parseTraceRef(ref) {
  if (!ref) return null;
  if (typeof ref === "object") {
    if (!ref.id) return null;
    return { id: ref.id, provider: ref.provider || "" };
  }
  if (typeof ref !== "string") return null;
  const text = ref.trim();
  if (!text) return null;
  const slash = text.indexOf("/");
  if (slash > 0 && slash < text.length - 1) {
    return { provider: text.slice(0, slash), id: text.slice(slash + 1) };
  }
  return { id: text, provider: "" };
}

function formatTraceRef(ref) {
  const parsed = parseTraceRef(ref);
  if (!parsed?.id) return "";
  return parsed.provider ? `${parsed.provider}/${parsed.id}` : parsed.id;
}

function baseHostFromUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const text = raw.trim();
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`https://${text}`).hostname.toLowerCase();
    } catch {
      return text.toLowerCase().split(/[/?#]/)[0].replace(/:\d+$/, "");
    }
  }
}

function roleCapability(role) {
  if (role === "embed") return "embedding";
  if (role === "utility_large") return "utility_large";
  if (role === "utility") return "utility";
  if (role === "summarizer") return "summarizer";
  if (role === "compiler") return "compiler";
  return "chat";
}

function capabilityMatch(role, model) {
  const required = roleCapability(role);
  if (required !== "embedding") return { required, matched: true };
  const matched = model?.type === "embedding" || model?.embedding === true;
  return { required, matched, reason: matched ? "matched" : "missing_capability" };
}

function hasUtilityOverride(utilApiOverride) {
  return Boolean(utilApiOverride?.provider || utilApiOverride?.api_key || utilApiOverride?.base_url);
}

// Role name -> preferences field name (kept for SHARED_MODEL_KEYS compatibility)
const ROLE_TO_PREF_KEY = {
  utility: "utility_model",
  utility_large: "utility_large_model",
  summarizer: "summarizer_model",
  compiler: "compiler_model",
};

export class ExecutionRouter {
  /**
   * @param {(ref: string) => object|null} resolveModel - resolves a model from _availableModels
   * @param {import('./provider-registry.ts').ProviderRegistry} providerRegistry
   */
  constructor(resolveModel, providerRegistry) {
    this._resolveModel = resolveModel;
    this._providerRegistry = providerRegistry;
  }

  /**
   * Resolve a role into full execution parameters.
   *
   * @param {string} roleOrRef
   *   Built-in role name ("chat"/"utility"/"utility_large"/"embed"/"summarizer"/"compiler"),
   *   or a direct model reference ("provider/model" or bare modelId).
   * @param {object} agentConfig - agent config object from config.yaml
   * @param {object} [sharedModels] - globally shared role models from preferences
   * @param {object} [utilApiOverride] - utility API override from preferences
   * @returns {{ modelId: string, providerId: string, api: string, apiKey: string, baseUrl: string }}
   * @throws When the model or credentials cannot be resolved
   */
  resolve(roleOrRef, agentConfig, sharedModels, utilApiOverride) {
    const modelRef = this._resolveRef(roleOrRef, agentConfig, sharedModels);
    if (!modelRef) {
      throw new Error(t("error.noUtilityModel") + ` (role: ${roleOrRef})`);
    }

    const model = this._resolveModel(modelRef);
    if (!model) {
      throw new Error(t("error.modelNotFound", { id: modelRef }));
    }

    // utility API override only applies to utility/utility_large roles
    const isUtilityRole = roleOrRef === "utility" || roleOrRef === "utility_large";
    if (isUtilityRole && utilApiOverride?.api_key) {
      // Keep provider consistency with ModelManager.resolveUtilityConfig
      if (utilApiOverride.provider && utilApiOverride.provider !== model.provider) {
        throw new Error(t("error.utilityApiProviderMismatch", { model: modelRef }));
      }
      return {
        modelId: model.id,
        providerId: model.provider,
        api: model.api,
        apiKey: utilApiOverride.api_key,
        baseUrl: utilApiOverride.base_url || model.baseUrl,
      };
    }

    const cred = this._providerRegistry.getCredentials(model.provider);
    if (!cred) {
      throw new Error(t("error.providerMissingCreds", { provider: model.provider }));
    }
    if (!cred.api) {
      throw new Error(t("error.providerMissingApi", { provider: model.provider }));
    }
    const canUseWithoutKey = allowsMissingApiKey({
      baseUrl: cred.baseUrl,
      authType: cred.authType,
    });
    if (!cred.baseUrl || (!cred.apiKey && !canUseWithoutKey)) {
      throw new Error(t("error.providerMissingCreds", { provider: model.provider }));
    }

    return {
      modelId: model.id,
      providerId: model.provider,
      api: cred.api,
      apiKey: cred.apiKey || (canUseWithoutKey ? "local" : ""),
      baseUrl: cred.baseUrl,
    };
  }

  /**
   * Return a sanitized explanation of the same role resolution path used by
   * resolve(). This is diagnostics-only and intentionally omits API keys.
   */
  traceResolve(roleOrRef, agentConfig, sharedModels, utilApiOverride) {
    const resolvedRef = this._resolveRefWithSource(roleOrRef, agentConfig, sharedModels);
    const candidates = [];
    const trace = [];
    const refText = formatTraceRef(resolvedRef.ref);
    const baseCandidate = {
      role: roleOrRef,
      source: resolvedRef.source,
      ref: refText,
    };

    if (!resolvedRef.ref) {
      const candidate = {
        ...baseCandidate,
        status: "rejected",
        reason: "missing_model_ref",
      };
      candidates.push(candidate);
      trace.push(`role ${roleOrRef} has no configured model reference`);
      return {
        ok: false,
        role: roleOrRef,
        selected: null,
        candidates,
        trace,
        warnings: ["missing_model_ref"],
        error: t("error.noUtilityModel") + ` (role: ${roleOrRef})`,
      };
    }

    trace.push(`role ${roleOrRef} resolved from ${resolvedRef.source}`);
    const model = this._resolveModel(resolvedRef.ref);
    if (!model) {
      const candidate = {
        ...baseCandidate,
        status: "rejected",
        reason: "model_not_found",
      };
      candidates.push(candidate);
      trace.push(`route rejected ${refText}: model_not_found`);
      return {
        ok: false,
        role: roleOrRef,
        selected: null,
        candidates,
        trace,
        warnings: ["model_not_found"],
        error: t("error.modelNotFound", { id: resolvedRef.ref }),
      };
    }

    const capability = capabilityMatch(roleOrRef, model);
    const credentials = this._traceCredentials(model, roleOrRef, utilApiOverride);
    if (!credentials.ok) {
      const candidate = {
        ...baseCandidate,
        modelId: model.id,
        providerId: model.provider,
        capability,
        status: "rejected",
        reason: credentials.reason,
      };
      candidates.push(candidate);
      trace.push(`route rejected ${refText}: ${credentials.reason}`);
      return {
        ok: false,
        role: roleOrRef,
        selected: null,
        candidates,
        trace,
        warnings: [credentials.reason],
        error: credentials.error,
      };
    }

    const candidate = {
      ...baseCandidate,
      modelId: model.id,
      providerId: model.provider,
      capability,
      status: "selected",
      reason: capability.matched ? "selected" : "selected_with_capability_warning",
    };
    candidates.push(candidate);
    trace.push(`provider ${model.provider} credentials resolved without exposing secrets`);
    trace.push(`route selected ${model.provider}/${model.id}`);

    return {
      ok: true,
      role: roleOrRef,
      selected: {
        role: roleOrRef,
        source: resolvedRef.source,
        ref: refText,
        modelId: model.id,
        providerId: model.provider,
        api: credentials.api,
        baseHost: baseHostFromUrl(credentials.baseUrl),
        credentialSource: credentials.source,
        capability,
      },
      candidates,
      trace,
      warnings: capability.matched ? [] : ["missing_capability"],
    };
  }

  /**
   * Backward-compatible resolveUtilityConfig interface.
   * Used by several existing callers such as sub/channel-router, install-skill,
   * and llm-utils. Returns exactly the same shape as the old
   * ModelManager.resolveUtilityConfig().
   *
   * @param {object} agentConfig
    *
    *
   */
  resolveUtilityConfig(agentConfig, sharedModels, utilApiOverride) {
    const cfg = agentConfig || {};
    const chatModelRef = cfg.models?.chat || null;

    // Utility models explicitly configured by the user
    const userSetUtility = sharedModels?.utility || cfg.models?.utility || null;
    const userSetUtilityLarge = sharedModels?.utility_large || cfg.models?.utility_large || null;

    // Fall back to the chat model when utility roles are not configured
    const utilityModelRef = userSetUtility || chatModelRef;
    const largeModelRef = userSetUtilityLarge || chatModelRef;

    if (!utilityModelRef) throw new Error(t("error.noUtilityModel"));
    if (!largeModelRef) throw new Error(t("error.noUtilityLargeModel"));

    const utilModel = this._resolveModel(utilityModelRef);
    if (!utilModel) throw new Error(t("error.modelNotFound", { id: utilityModelRef }));

    const largeModel = this._resolveModel(largeModelRef);
    if (!largeModel) throw new Error(t("error.modelNotFound", { id: largeModelRef }));

    // utility credentials
    let apiKey;
    let baseUrl;
    let api;
    if (utilApiOverride?.provider || utilApiOverride?.api_key || utilApiOverride?.base_url) {
      // Keep provider consistency with ModelManager.resolveUtilityConfig
      if (utilApiOverride.provider && utilApiOverride.provider !== utilModel.provider) {
        throw new Error(t("error.utilityApiProviderMismatch", { model: utilityModelRef }));
      }
      // Utility API override: user explicitly configured a separate utility endpoint
      const provCred = this._providerRegistry.getCredentials(utilModel.provider);
      api = provCred?.api || utilModel.api;
      apiKey = normalizeProviderApiKey(utilApiOverride.api_key);
      baseUrl = utilApiOverride.base_url || "";
      if (!api) throw new Error(t("error.providerMissingApi", { provider: utilModel.provider }));
      const canUseWithoutKey = allowsMissingApiKey({
        baseUrl,
        authType: provCred?.authType,
      });
      if (!baseUrl || (!apiKey && !canUseWithoutKey)) {
        throw new Error(t("error.utilityApiMissingCreds", { provider: utilModel.provider }));
      }
      if (!apiKey && canUseWithoutKey) apiKey = "local";
    } else {
      const cred = this._providerRegistry.getCredentials(utilModel.provider);
      if (!cred?.api) throw new Error(t("error.providerMissingApi", { provider: utilModel.provider }));
      const canUseWithoutKey = allowsMissingApiKey({
        baseUrl: cred.baseUrl,
        authType: cred.authType,
      });
      if (!cred.baseUrl || (!cred.apiKey && !canUseWithoutKey)) {
        throw new Error(t("error.providerMissingCreds", { provider: utilModel.provider }));
      }
      apiKey = cred.apiKey || (canUseWithoutKey ? "local" : "");
      baseUrl = cred.baseUrl;
      api = cred.api;
    }

    // utility_large credentials; reuse when provider is the same
    let large_api_key = apiKey;
    let large_base_url = baseUrl;
    let large_api = api;
    if (largeModel.provider !== utilModel.provider) {
      const largeCred = this._providerRegistry.getCredentials(largeModel.provider);
      if (!largeCred?.api) throw new Error(t("error.providerMissingApi", { provider: largeModel.provider }));
      const canUseWithoutKey = allowsMissingApiKey({
        baseUrl: largeCred.baseUrl,
        authType: largeCred.authType,
      });
      if (!largeCred.baseUrl || (!largeCred.apiKey && !canUseWithoutKey)) {
        throw new Error(t("error.providerMissingCreds", { provider: largeModel.provider }));
      }
      large_api_key = largeCred.apiKey || (canUseWithoutKey ? "local" : "");
      large_base_url = largeCred.baseUrl;
      large_api = largeCred.api;
    }

    return {
      utility: utilModel,
      utility_large: largeModel,
      api_key: apiKey,
      base_url: baseUrl,
      api,
      large_api_key,
      large_base_url,
      large_api,
    };
  }

  /**
   * Diagnostics-only utility routing explanation. It mirrors the utility role
   * fallback shape without returning any secrets.
   */
  traceUtilityConfig(agentConfig, sharedModels, utilApiOverride) {
    const cfg = agentConfig || {};
    const candidates = [];
    const trace = [];
    const fallbackPath = [];
    const selected = {};
    const warnings = [];

    const utility = this._traceUtilitySlot("utility", cfg, sharedModels, utilApiOverride, candidates, trace, fallbackPath);
    const utilityLarge = this._traceUtilitySlot("utility_large", cfg, sharedModels, utilApiOverride, candidates, trace, fallbackPath);
    if (utility.ok) selected.utility = utility.selected;
    else warnings.push(utility.reason);
    if (utilityLarge.ok) selected.utility_large = utilityLarge.selected;
    else warnings.push(utilityLarge.reason);

    const ok = utility.ok && utilityLarge.ok;
    return {
      ok,
      role: "utility_config",
      selected: ok ? selected : Object.keys(selected).length > 0 ? selected : null,
      candidates,
      trace,
      fallbackPath,
      warnings: [...new Set(warnings.filter(Boolean))],
      ...(ok ? {} : { error: [utility.error, utilityLarge.error].filter(Boolean)[0] || "utility routing failed" }),
    };
  }

  /**
   * Resolve a role name or model reference into the actual model ref string.
   * @private
   */
  _resolveRef(roleOrRef, agentConfig, sharedModels) {
    const cfg = agentConfig || {};

    // Built-in role lookup order: sharedModels -> agentConfig.models
    switch (roleOrRef) {
      case "chat":
        return cfg.models?.chat || null;
      case "utility":
        return sharedModels?.utility || cfg.models?.utility || null;
      case "utility_large":
        return sharedModels?.utility_large || cfg.models?.utility_large || null;
      case "summarizer":
        return sharedModels?.summarizer || cfg.models?.summarizer || null;
      case "compiler":
        return sharedModels?.compiler || cfg.models?.compiler || null;
      case "embed":
        return cfg.embedding_api?.model || null;
      default:
        // Not a built-in role name; treat it as a direct model reference
        return roleOrRef;
    }
  }

  _resolveRefWithSource(roleOrRef, agentConfig, sharedModels) {
    const cfg = agentConfig || {};
    switch (roleOrRef) {
      case "chat":
        return { ref: cfg.models?.chat || null, source: "agent.models.chat" };
      case "utility":
        if (sharedModels?.utility) return { ref: sharedModels.utility, source: "sharedModels.utility" };
        return { ref: cfg.models?.utility || null, source: "agent.models.utility" };
      case "utility_large":
        if (sharedModels?.utility_large) return { ref: sharedModels.utility_large, source: "sharedModels.utility_large" };
        return { ref: cfg.models?.utility_large || null, source: "agent.models.utility_large" };
      case "summarizer":
        if (sharedModels?.summarizer) return { ref: sharedModels.summarizer, source: "sharedModels.summarizer" };
        return { ref: cfg.models?.summarizer || null, source: "agent.models.summarizer" };
      case "compiler":
        if (sharedModels?.compiler) return { ref: sharedModels.compiler, source: "sharedModels.compiler" };
        return { ref: cfg.models?.compiler || null, source: "agent.models.compiler" };
      case "embed":
        return { ref: cfg.embedding_api?.model || null, source: "agent.embedding_api.model" };
      default:
        return { ref: roleOrRef, source: "direct" };
    }
  }

  _traceCredentials(model, roleOrRef, utilApiOverride) {
    const isUtilityRole = roleOrRef === "utility" || roleOrRef === "utility_large";
    if (isUtilityRole && utilApiOverride?.api_key) {
      if (utilApiOverride.provider && utilApiOverride.provider !== model.provider) {
        return {
          ok: false,
          reason: "utility_api_provider_mismatch",
          error: t("error.utilityApiProviderMismatch", { model: `${model.provider}/${model.id}` }),
        };
      }
      return {
        ok: true,
        source: "utility_api_override",
        api: model.api,
        baseUrl: utilApiOverride.base_url || model.baseUrl || "",
        hasApiKey: true,
      };
    }

    const cred = this._providerRegistry.getCredentials(model.provider);
    if (!cred) {
      return {
        ok: false,
        reason: "provider_missing_credentials",
        error: t("error.providerMissingCreds", { provider: model.provider }),
      };
    }
    if (!cred.api) {
      return {
        ok: false,
        reason: "provider_missing_api",
        error: t("error.providerMissingApi", { provider: model.provider }),
      };
    }
    const canUseWithoutKey = allowsMissingApiKey({
      baseUrl: cred.baseUrl,
      authType: cred.authType,
    });
    if (!cred.baseUrl || (!cred.apiKey && !canUseWithoutKey)) {
      return {
        ok: false,
        reason: "provider_missing_credentials",
        error: t("error.providerMissingCreds", { provider: model.provider }),
      };
    }
    return {
      ok: true,
      source: "provider_registry",
      api: cred.api,
      baseUrl: cred.baseUrl,
      hasApiKey: Boolean(cred.apiKey),
      canUseWithoutKey,
    };
  }

  _traceUtilitySlot(slot, cfg, sharedModels, utilApiOverride, candidates, trace, fallbackPath) {
    const configured = sharedModels?.[slot] || cfg.models?.[slot] || null;
    const configuredSource = sharedModels?.[slot] ? `sharedModels.${slot}` : `agent.models.${slot}`;
    let ref = configured;
    let source = configuredSource;
    let fallbackFrom = null;

    if (!configured) {
      candidates.push({
        slot,
        source: configuredSource,
        ref: "",
        status: "rejected",
        reason: "not_configured",
      });
      ref = cfg.models?.chat || null;
      source = "agent.models.chat";
      fallbackFrom = "chat";
      fallbackPath.push(`${slot} -> chat`);
      trace.push(`${slot} not configured; falling back to chat`);
    }

    const refText = formatTraceRef(ref);
    if (!ref) {
      const error = slot === "utility_large" ? t("error.noUtilityLargeModel") : t("error.noUtilityModel");
      candidates.push({
        slot,
        source,
        ref: "",
        status: "rejected",
        reason: "missing_model_ref",
      });
      trace.push(`${slot} rejected: missing_model_ref`);
      return { ok: false, reason: "missing_model_ref", error };
    }

    const model = this._resolveModel(ref);
    if (!model) {
      candidates.push({
        slot,
        source,
        ref: refText,
        status: "rejected",
        reason: "model_not_found",
      });
      trace.push(`${slot} rejected ${refText}: model_not_found`);
      return { ok: false, reason: "model_not_found", error: t("error.modelNotFound", { id: ref }) };
    }

    const credentials = this._traceUtilityCredentials(model, slot, utilApiOverride);
    if (!credentials.ok) {
      candidates.push({
        slot,
        source,
        ref: refText,
        modelId: model.id,
        providerId: model.provider,
        status: "rejected",
        reason: credentials.reason,
      });
      trace.push(`${slot} rejected ${refText}: ${credentials.reason}`);
      return { ok: false, reason: credentials.reason, error: credentials.error };
    }

    candidates.push({
      slot,
      source,
      ref: refText,
      modelId: model.id,
      providerId: model.provider,
      status: "selected",
      reason: fallbackFrom ? "fallback_to_chat" : "selected",
      capability: capabilityMatch(slot, model),
    });
    trace.push(`${slot} selected ${model.provider}/${model.id}`);
    return {
      ok: true,
      selected: {
        slot,
        source,
        ref: refText,
        modelId: model.id,
        providerId: model.provider,
        api: credentials.api,
        baseHost: baseHostFromUrl(credentials.baseUrl),
        credentialSource: credentials.source,
        fallbackFrom,
        capability: capabilityMatch(slot, model),
      },
    };
  }

  _traceUtilityCredentials(model, slot, utilApiOverride) {
    if (slot === "utility" && hasUtilityOverride(utilApiOverride)) {
      if (utilApiOverride.provider && utilApiOverride.provider !== model.provider) {
        return {
          ok: false,
          reason: "utility_api_provider_mismatch",
          error: t("error.utilityApiProviderMismatch", { model: `${model.provider}/${model.id}` }),
        };
      }
      const provCred = this._providerRegistry.getCredentials(model.provider);
      const api = provCred?.api || model.api;
      const baseUrl = utilApiOverride.base_url || "";
      const apiKey = normalizeProviderApiKey(utilApiOverride.api_key);
      const canUseWithoutKey = allowsMissingApiKey({
        baseUrl,
        authType: provCred?.authType,
      });
      if (!api) {
        return {
          ok: false,
          reason: "provider_missing_api",
          error: t("error.providerMissingApi", { provider: model.provider }),
        };
      }
      if (!baseUrl || (!apiKey && !canUseWithoutKey)) {
        return {
          ok: false,
          reason: "utility_api_missing_credentials",
          error: t("error.utilityApiMissingCreds", { provider: model.provider }),
        };
      }
      return {
        ok: true,
        source: "utility_api_override",
        api,
        baseUrl,
        hasApiKey: Boolean(apiKey),
        canUseWithoutKey,
      };
    }
    return this._traceCredentials(model, slot, null);
  }
}

export { ROLE_TO_PREF_KEY };
