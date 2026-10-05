const WUKONG_MAX_TEXT_CHARS = 100_000;
const WUKONG_MAX_ID_CHARS = 160;

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function safeIdentifier(value: unknown, fallback: string): string {
  const raw = cleanString(value) || fallback;
  const normalized = raw.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  return (normalized || fallback).slice(0, WUKONG_MAX_ID_CHARS);
}

export function buildWukongSessionKey({
  agentId,
  userId,
  conversationId,
}: {
  agentId: unknown;
  userId: unknown;
  conversationId?: unknown;
}): string {
  const safeAgentId = safeIdentifier(agentId, "agent");
  const safeUserId = safeIdentifier(userId, "user");
  const safeConversationId = cleanString(conversationId)
    ? safeIdentifier(conversationId, safeUserId)
    : "";
  const scope = safeConversationId ? `conv_${safeConversationId}` : `dm_${safeUserId}`;
  return `wk_${scope}@${safeAgentId}`;
}

export function normalizeWukongTaskInput(body: Record<string, unknown> = {}) {
  const text = cleanString(body.text ?? body.prompt ?? body.message);
  const userId = cleanString(body.userId ?? body.userid ?? body.unionId ?? body.openId);
  const conversationId = cleanString(body.conversationId ?? body.conversation_id ?? body.chatId);
  const userName = cleanString(body.userName ?? body.senderName ?? body.name) || "Wukong User";
  const guest = body.guest === true;
  if (!text || !userId) {
    const err = new Error("text and userId are required") as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  return {
    text: text.slice(0, WUKONG_MAX_TEXT_CHARS),
    userId,
    conversationId,
    userName,
    guest,
  };
}

export function createWukongCompatibilityManifest() {
  return {
    platform: "wukong",
    displayName: "DingTalk Wukong",
    runtime: {
      nativeExecution: false,
      mode: "external_runtime_gateway",
      owner: "wukong",
    },
    directions: {
      outboundRuntime: true,
      inboundCompatibilityGateway: true,
    },
    integrationModes: [
      "mcp_service",
      "skill_gateway",
      "dingtalk_bridge_relay",
    ],
    hostRequirements: [
      "stable_user_identity",
      "async_task_result_callback",
      "https_or_mcp_tool_invocation",
    ],
    bridge: {
      nativeBridgePlatform: false,
      recommendedRelayPlatform: "dingtalk",
      sessionKeyPrefix: "wk_",
    },
    capabilities: {
      agents: { run: true, continueSession: true },
      workflows: { run: true },
      subagents: { dispatch: true },
      media: { generate: true, ocr: true },
      resources: { attach: true },
      usage: { report: true },
      diagnostics: { read: true },
      authorization: { licenseFeature: "bridge" },
    },
  };
}
