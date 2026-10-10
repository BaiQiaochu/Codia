// @ts-nocheck
import { buildApprovalReviewContext } from "./permission/approval-review-context.ts";
import { evaluateToolSafetyPolicy } from "./permission/safety-policy.ts";

const GIT_PUSH_RULES = {
  force: {
    id: "force-push-blocked",
    reason: "Force push is not eligible for automatic approval.",
  },
  tags: {
    id: "push-tags-blocked",
    reason: "Pushing tags is not eligible for automatic approval.",
  },
  push: {
    id: "privacy-push-required",
    reason: "Git remote push must go through /privacy-push and explicit final user confirmation.",
  },
};

const ALLOWED_ACTIONS = new Set(["allow", "deny_and_continue", "ask_user", "hard_deny"]);
const REVIEWER_ACTIONS = new Set([...ALLOWED_ACTIONS, "escalate"]);
const REVIEWER_SYSTEM_PROMPT = `You are Codia's automatic tool approval reviewer.
Decide whether the requested tool action may run under Auto mode without interrupting the user.
Return JSON only, with this shape:
{"action":"allow|deny_and_continue|ask_user|escalate","reason":"short concrete reason","risk":"low|medium|high|critical","saferAlternative":"optional safer next step","ruleIds":["optional-policy-id"]}

Rules:
- You replace only the human approval decision. You do not expand the sandbox, writable roots, network policy, app capability, or SafetyPolicy.
- Hard safety requests such as git push, force-push, tag push, credential exposure, destructive deletion outside the authorized workspace, or actions that bypass explicit user confirmation should already be blocked before review; if one reaches you, do not approve it.
- Allow only when the requested action is clearly within the user's visible intent and the supplied trustEnvironment.
- Use ask_user when intent, target, trustEnvironment, or blast radius is unclear. In Auto mode this means the action will not run; it is not a request to interrupt the user.
- Use deny_and_continue when the agent should choose a safer path without asking.
- If you are the small reviewer, allow only obvious low-risk in-scope actions; otherwise use escalate, ask_user, or deny_and_continue.
- If you are the large reviewer, make the final risk decision from the supplied request and trust context.`;

function commandFromRequest(request = {}) {
  const command = request.params?.command || request.params?.cmd || request.target?.label;
  return typeof command === "string" ? command : "";
}

function tokenizeCommand(command) {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) tokens.push(token);
      token = "";
      continue;
    }
    token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

function isGitExecutableToken(token) {
  const normalized = String(token || "").replace(/\\/g, "/");
  return normalized === "git" || normalized.endsWith("/git");
}

function gitGlobalOptionConsumesValue(token) {
  if (token.includes("=")) return false;
  return token === "-C"
    || token === "-c"
    || token === "--git-dir"
    || token === "--work-tree"
    || token === "--namespace"
    || token === "--exec-path"
    || token === "--config-env"
    || token === "--super-prefix";
}

function detectGitPush(command) {
  const tokens = tokenizeCommand(command);
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isGitExecutableToken(tokens[i])) continue;
    let j = i + 1;
    while (j < tokens.length) {
      const token = tokens[j];
      if (token === "push") {
        const args = tokens.slice(j + 1);
        return {
          hasForce: args.some((arg) => arg === "--force" || arg.startsWith("--force-with-lease")),
          hasTags: args.includes("--tags"),
        };
      }
      if (token === "--") break;
      if (token.startsWith("-")) {
        j += gitGlobalOptionConsumesValue(token) ? 2 : 1;
        continue;
      }
      break;
    }
  }
  return null;
}

function deterministicDecision(request = {}) {
  if (isDeferredMutationDraft(request)) {
    return {
      action: "allow",
      reviewer: "policy",
      reason: request.sideEffect?.summary || "Tool action only creates a draft; persistent writes require explicit confirmation.",
      risk: "low",
      ruleIds: [request.sideEffect?.ruleId || "automation-draft-no-write"],
    };
  }
  const safetyDecision = evaluateToolSafetyPolicy(request);
  if (safetyDecision) {
    return {
      ...safetyDecision,
      action: "hard_deny",
      reviewer: "policy",
    };
  }

  const command = commandFromRequest(request);
  if (command) {
    const gitPush = detectGitPush(command);
    const rule = gitPush?.hasForce
      ? GIT_PUSH_RULES.force
      : (gitPush?.hasTags ? GIT_PUSH_RULES.tags : (gitPush ? GIT_PUSH_RULES.push : null));
    if (rule) {
      return {
        action: "hard_deny",
        reviewer: "policy",
        reason: rule.reason,
        risk: "critical",
        ruleIds: [rule.id],
      };
    }
  }
  return null;
}

function isDeferredMutationDraft(request = {}) {
  const sideEffect = request.sideEffect;
  return sideEffect?.kind === "deferred_mutation_draft"
    && sideEffect?.commit === "requires_user_confirmation";
}

function normalizeRisk(value, fallback = "medium") {
  return value === "low" || value === "medium" || value === "high" || value === "critical"
    ? value
    : fallback;
}

function normalizeReviewerDecision(raw, reviewer) {
  if (!raw || typeof raw !== "object") return null;
  if (!REVIEWER_ACTIONS.has(raw.action)) return null;
  const risk = normalizeRisk(raw.risk, raw.action === "allow" ? "medium" : "high");
  if (raw.action === "escalate") {
    return {
      action: "escalate",
      reviewer,
      reason: typeof raw.reason === "string" && raw.reason ? raw.reason : "reviewer requested escalation",
      risk,
      ruleIds: Array.isArray(raw.ruleIds) ? raw.ruleIds : [],
    };
  }
  if (reviewer === "small_tool_model" && raw.action === "allow" && (risk === "high" || risk === "critical")) {
    return {
      action: "escalate",
      reviewer,
      reason: typeof raw.reason === "string" && raw.reason ? raw.reason : "small reviewer escalated high-risk approval",
      risk,
      ruleIds: Array.isArray(raw.ruleIds) ? raw.ruleIds : [],
    };
  }
  return {
    action: raw.action,
    reviewer,
    reason: typeof raw.reason === "string" && raw.reason ? raw.reason : `${reviewer} reviewer decision`,
    risk,
    saferAlternative: typeof raw.saferAlternative === "string" ? raw.saferAlternative : undefined,
    ruleIds: Array.isArray(raw.ruleIds) ? raw.ruleIds : [],
  };
}

function fallbackAskUser(reason = "auto approval reviewer unavailable") {
  return {
    action: "ask_user",
    reviewer: "policy",
    reason,
    risk: "medium",
    ruleIds: ["reviewer-unavailable"],
  };
}

function buildReviewerInput(request, context = {}) {
  const reviewContext = buildApprovalReviewContext({
    source: context.source || context,
    ctx: context,
    sessionPath: request.sessionPath || context.sessionPath || null,
    agentId: request.agentId || context.agentId || null,
    fallback: context,
  });
  return {
    request,
    userIntentSummary: reviewContext.userIntentSummary || "",
    explicitUserAuthorization: reviewContext.explicitUserAuthorization || "",
    sessionPermissionMode: "auto",
    trustEnvironment: {
      cwd: reviewContext.cwd || null,
      workspaceFolders: Array.isArray(reviewContext.workspaceFolders) ? reviewContext.workspaceFolders : [],
      authorizedFolders: Array.isArray(reviewContext.authorizedFolders) ? reviewContext.authorizedFolders : [],
      knownRemotes: Array.isArray(reviewContext.knownRemotes) ? reviewContext.knownRemotes : [],
      knownDomains: Array.isArray(reviewContext.knownDomains) ? reviewContext.knownDomains : [],
    },
    recentApprovalHistory: Array.isArray(reviewContext.recentApprovalHistory) ? reviewContext.recentApprovalHistory : [],
    visibleTranscript: Array.isArray(reviewContext.visibleTranscript) ? reviewContext.visibleTranscript : [],
    executionContext: reviewContext.executionContext || "",
  };
}

function extractJsonObject(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;
  try {
    return JSON.parse(candidate);
  } catch {}
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function compactReviewerInput(value, depth = 0) {
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value;
  if (!value || typeof value !== "object") return value;
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => compactReviewerInput(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    out[key] = compactReviewerInput(item, depth + 1);
  }
  return out;
}

function configForReviewerRole(config, role) {
  if (role === "utility_large") {
    return {
      model: config?.utility_large,
      api: config?.large_api,
      apiKey: config?.large_api_key,
      baseUrl: config?.large_base_url,
    };
  }
  return {
    model: config?.utility,
    api: config?.api,
    apiKey: config?.api_key,
    baseUrl: config?.base_url,
  };
}

export function createModelApprovalReviewer({
  role = "utility",
  resolveUtilityConfig,
  callText,
  timeoutMs = 15_000,
  maxTokens = 220,
} = {}) {
  return async (input) => {
    if (typeof resolveUtilityConfig !== "function") {
      throw new Error("approval reviewer requires resolveUtilityConfig");
    }
    if (typeof callText !== "function") {
      throw new Error("approval reviewer requires callText");
    }
    const request = input?.request || {};
    const utilityOptions = {
      ...(request.agentId ? { agentId: request.agentId } : {}),
      ...(request.sessionPath ? { sessionPath: request.sessionPath } : {}),
    };
    const config = resolveUtilityConfig(Object.keys(utilityOptions).length ? utilityOptions : undefined);
    const selected = configForReviewerRole(config, role);
    if (!selected.model || !selected.api || !selected.baseUrl) {
      throw new Error(`approval reviewer ${role} model config is incomplete`);
    }
    const text = await callText({
      api: selected.api,
      apiKey: selected.apiKey,
      baseUrl: selected.baseUrl,
      model: selected.model,
      headers: selected.model?.headers || {},
      systemPrompt: REVIEWER_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: JSON.stringify(compactReviewerInput(input)),
      }],
      temperature: 0,
      maxTokens,
      timeoutMs,
      usageContext: `approval_reviewer_${role}`,
    });
    return extractJsonObject(text);
  };
}

async function callReviewer(fn, input, reviewer) {
  if (typeof fn !== "function") return null;
  try {
    return normalizeReviewerDecision(await fn(input), reviewer);
  } catch (err) {
    return {
      action: "ask_user",
      reviewer,
      reason: `auto approval reviewer failed: ${err?.message || String(err)}`,
      risk: "medium",
      ruleIds: ["reviewer-error"],
    };
  }
}

function isLowRiskAllow(decision) {
  return decision?.action === "allow" && decision.risk === "low";
}

function isAllowedReviewerAction(decision) {
  return decision && ALLOWED_ACTIONS.has(decision.action);
}

export function createApprovalGateway({
  smallToolModelReviewer = null,
  largeToolModelReviewer = null,
} = {}) {
  return {
    async review(request, context = {}) {
      const policyDecision = deterministicDecision(request);
      if (policyDecision) return policyDecision;

      const reviewerInput = buildReviewerInput(request, context);
      const smallDecision = await callReviewer(
        smallToolModelReviewer,
        reviewerInput,
        "small_tool_model",
      );
      const hasLargeReviewer = typeof largeToolModelReviewer === "function";
      if (isAllowedReviewerAction(smallDecision) && (!hasLargeReviewer || isLowRiskAllow(smallDecision))) {
        return smallDecision;
      }

      const largeDecision = await callReviewer(
        largeToolModelReviewer,
        reviewerInput,
        "large_tool_model",
      );
      if (isAllowedReviewerAction(largeDecision)) return largeDecision;
      if (isAllowedReviewerAction(smallDecision)) return smallDecision;

      return fallbackAskUser(smallDecision?.reason || "auto approval reviewer unavailable");
    },
  };
}
